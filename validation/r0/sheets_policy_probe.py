"""R0 targeted Sheets metadata policy experiment. Not a full R1 XLSX validator."""
import argparse
import io
import json
from pathlib import Path
import zipfile
import xml.etree.ElementTree as ET

PART = 'xl/persons/person.xml'
NS = 'http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments'
REL = 'http://schemas.microsoft.com/office/2017/10/relationships/person'
CT = 'application/vnd.ms-excel.person+xml'
PACKAGE = 'http://schemas.openxmlformats.org/package/2006/relationships'
TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types'


def xml(data):
    data.decode('utf-8-sig', errors='strict')
    if len(data) > 16384 or b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
        raise ValueError('XML bounds/entities')
    return ET.fromstring(data)


def check(raw):
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        if len(z.namelist()) != len(set(z.namelist())):
            raise ValueError('duplicate part')
        persons = [n for n in z.namelist() if '/persons/' in n]
        if persons != [PART]:
            raise ValueError('unexpected persons parts')
        root = xml(z.read(PART))
        if root.tag != '{' + NS + '}personList' or root.attrib or list(root) or (root.text or '').strip():
            raise ValueError('only empty attribute-free personList supported')
        # No relationships owned by this metadata part, including externally acting ones.
        if any(n.startswith('xl/persons/_rels/') for n in z.namelist()):
            raise ValueError('persons relationships unsupported')
        matches = []
        for n in z.namelist():
            if not n.endswith('.rels'):
                continue
            for r in xml(z.read(n)):
                if r.attrib.get('Type') == REL:
                    matches.append((n, r))
        if len(matches) != 1:
            raise ValueError('single workbook person relationship required')
        source, relationship = matches[0]
        if (source != 'xl/_rels/workbook.xml.rels'
                or relationship.tag != '{' + PACKAGE + '}Relationship'
                or relationship.attrib.get('Target') != 'persons/person.xml'
                or relationship.attrib.get('TargetMode', 'Internal') != 'Internal'
                or set(relationship.attrib) - {'Id', 'Type', 'Target', 'TargetMode'}):
            raise ValueError('invalid person relationship')
        overrides = [e for e in xml(z.read('[Content_Types].xml'))
                     if e.attrib.get('PartName') == '/' + PART]
        if (len(overrides) != 1 or overrides[0].tag != '{' + TYPES + '}Override'
                or overrides[0].attrib != {'PartName': '/' + PART, 'ContentType': CT}):
            raise ValueError('invalid person content type')
        # Sheets emits an unused obfuscated-font Default. It does not authorize a font part.
        font_entries = [n for n in z.namelist() if n.lower().endswith('.odttf')]
        if font_entries:
            raise ValueError('embedded fonts unsupported')
    return True


def mutate(raw, part, transform):
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(raw)) as src, zipfile.ZipFile(out, 'w') as dst:
        for name in src.namelist():
            value = src.read(name)
            dst.writestr(name, transform(value) if name == part else value)
    return out.getvalue()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('output')
    args = ap.parse_args()
    result = {'scope': 'empty persons metadata only; not full OOXML/namespace/formula/AV qualification', 'fixtures': {}, 'negative_cases': {}}
    for p in sorted((Path(__file__).parent / 'fixtures').glob('*.xlsx')):
        result['fixtures'][p.name] = check(p.read_bytes())
    raw = (Path(__file__).parent / 'fixtures/sheets-resume.xlsx').read_bytes()
    cases = {
        'person_child': (PART, lambda _: f'<personList xmlns="{NS}"><person id="1" displayName="Fictional"/></personList>'.encode()),
        'foreign_child': (PART, lambda _: f'<personList xmlns="{NS}"><payload xmlns="urn:unknown"/></personList>'.encode()),
        'attribute': (PART, lambda _: f'<personList xmlns="{NS}" unknown="1"/>'.encode()),
        'text': (PART, lambda _: f'<personList xmlns="{NS}">payload</personList>'.encode()),
        'wrong_namespace': (PART, lambda _: b'<personList xmlns="urn:unknown"/>'),
        'doctype': (PART, lambda _: b'<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><x/>'),
        'utf16': (PART, lambda _: f'<personList xmlns="{NS}"/>'.encode('utf-16')),
        'oversize': (PART, lambda _: b' ' * 16385),
        'external_target': ('xl/_rels/workbook.xml.rels', lambda x: x.replace(b'Target="persons/person.xml"', b'Target="https://invalid.example/person.xml" TargetMode="External"')),
        'wrong_source_type': ('xl/_rels/workbook.xml.rels', lambda x: x.replace(REL.encode(), b'urn:unknown')),
        'duplicate_person_rel': ('xl/_rels/workbook.xml.rels', lambda x: x.replace(b'</Relationships>', f'<Relationship Id="rId99" Type="{REL}" Target="persons/person.xml"/></Relationships>'.encode())),
        'wrong_content_type': ('[Content_Types].xml', lambda x: x.replace(CT.encode(), b'application/octet-stream')),
    }
    for name, (part, change) in cases.items():
        try:
            check(mutate(raw, part, change))
        except (ValueError, ET.ParseError):
            result['negative_cases'][name] = 'refused'
        else:
            raise AssertionError('unsafe mutation accepted: ' + name)
    result['result'] = 'established_for_targeted_metadata_policy'
    Path(args.output).write_text(json.dumps(result, indent=2))
    print(json.dumps(result))


if __name__ == '__main__':
    main()
