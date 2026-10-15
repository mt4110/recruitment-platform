"""Bounded fixture inventory, NOT the R1 XLSX acceptance validator."""
import argparse,hashlib,json,pathlib,re,zipfile,xml.etree.ElementTree as ET

def inspect(p):
    raw=p.read_bytes()
    if len(raw)>10*1024*1024:raise ValueError('file too large')
    with zipfile.ZipFile(p) as z:
        parts=z.namelist();entries=z.infolist()
        if len(parts)>1000 or sum(e.file_size for e in entries)>64*1024*1024:raise ValueError('ZIP bounds')
        if len(parts)!=len(set(parts)):raise ValueError('duplicate entries')
        namespaces=set();formulas=[];relationships=[];person_data=False;merged=0;images=0;sheet_names=[];birth_type=None
        for e in entries:
            if e.file_size>16*1024*1024 or e.filename.startswith('/') or '..' in pathlib.PurePosixPath(e.filename).parts:raise ValueError('entry bounds/path')
            if e.filename.endswith(('.xml','.rels')):
                data=z.read(e)
                if b'<!DOCTYPE' in data.upper():raise ValueError('DOCTYPE')
                root=ET.fromstring(data)
                if '/persons/' in e.filename:person_data=any(x.tag.rsplit('}',1)[-1]=='person' for x in root.iter())
                for el in root.iter():
                    tag=el.tag.rsplit('}',1)[-1]
                    if el.tag.startswith('{'):namespaces.add(el.tag[1:].split('}')[0])
                    if tag=='f':formulas.append(el.text)
                    if tag=='mergeCell':merged+=1
                    if tag=='sheet':sheet_names.append(el.attrib.get('name'))
                    if tag=='c' and el.attrib.get('r')=='B5':birth_type=el.attrib.get('t','numeric')
                    if tag=='Relationship':relationships.append({'type':el.attrib.get('Type'),'mode':el.attrib.get('TargetMode','Internal')})
            if '/media/' in e.filename:images+=1
        unsupported=[n for n in parts if '/persons/' in n]
        return {'file':p.name,'sha256':hashlib.sha256(raw).hexdigest(),'size_bytes':len(raw),'uncompressed_bytes':sum(e.file_size for e in entries),'parts':parts,'namespaces':sorted(namespaces),'relationship_types':relationships,'sheet_names':sheet_names,'formulas':formulas,'merged_ranges':merged,'image_parts':images,'B5_type':birth_type,'person_entries_present':person_data,'v04_unlisted_parts':unsupported,'v04_current_allowlist_compatibility':'not_established' if unsupported else 'requires_full_R1_validation','scope':'inventory only; no formula grammar/full OOXML or malware qualification'}

def main():
    a=argparse.ArgumentParser();a.add_argument('directory');a.add_argument('output');args=a.parse_args()
    result=[inspect(p) for p in sorted(pathlib.Path(args.directory).glob('*.xlsx'))]
    pathlib.Path(args.output).write_text(json.dumps(result,ensure_ascii=False,indent=2))
    print(json.dumps([{'file':r['file'],'sha256':r['sha256'],'unlisted':r['v04_unlisted_parts'],'person_data':r['person_entries_present']} for r in result]))
if __name__=='__main__':main()
