"""Synthetic byte-level protocol fixtures, not user-facing workbook authoring.

OOXML mutation is necessary for invalid refs/types and deliberately stale/missing
formula caches: re-saving/recalculating through an office authoring tool changes
the exact inputs under test. Existing real Sheets exports stay unchanged.
"""
from pathlib import Path
import copy,io,json,random,zipfile,hashlib,xml.etree.ElementTree as E
import pikepdf as p
root=Path('/tmp/s3-fixtures');root.mkdir(mode=0o700);(root/'sheets-resume.xlsx').write_bytes(bytes.fromhex(__import__('sys').argv[1]))
# Fixed synthetic CID-font PDF: no browser font object explosion and no office/runtime dependency.
with p.Pdf.new() as d:
    page=d.add_blank_page(page_size=(595,842))
    descriptor=p.Dictionary(Type=p.Name('/FontDescriptor'),FontName=p.Name('/HeiseiKakuGo-W5'),Flags=4,FontBBox=p.Array([-1000,-1000,2000,2000]),ItalicAngle=0,Ascent=880,Descent=-120,CapHeight=700,StemV=80)
    cid=p.Dictionary(Type=p.Name('/Font'),Subtype=p.Name('/CIDFontType0'),BaseFont=p.Name('/HeiseiKakuGo-W5'),CIDSystemInfo=p.Dictionary(Registry=p.String('Adobe'),Ordering=p.String('Japan1'),Supplement=6),FontDescriptor=descriptor)
    cmap=d.make_stream(b'/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /SyntheticUnicode def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfrange <0000> <FFFF> <0000> endbfrange endcmap CMapName currentdict /CMap defineresource pop end end')
    font=p.Dictionary(Type=p.Name('/Font'),Subtype=p.Name('/Type0'),BaseFont=p.Name('/HeiseiKakuGo-W5'),Encoding=p.Name('/UniJIS-UCS2-H'),DescendantFonts=p.Array([cid]),ToUnicode=cmap)
    page.obj.Resources=p.Dictionary(Font=p.Dictionary(F0=font))
    words='架空職務経歴書・請求書 日本語の表示確認（実在情報なし）'
    page.obj.Contents=d.make_stream(('BT /F0 16 Tf 45 780 Td <'+words.encode('utf-16-be').hex()+'> Tj ET').encode())
    d.save(root/'japanese.pdf')
pdf=root/'japanese.pdf';base=pdf.read_bytes()
def save(name,mutate):
    with p.Pdf.open(io.BytesIO(base)) as d:mutate(d);d.save(root/name)
def tagged(d):
    tree=d.make_indirect(p.Dictionary(Type=p.Name('/StructTreeRoot')))
    elem=d.make_indirect(p.Dictionary(Type=p.Name('/StructElem'),S=p.Name('/P'),P=tree,Pg=d.pages[0].obj,K=0,A=p.Dictionary(O=p.Name('/Layout'))))
    tree.K=p.Array([elem]);d.Root.StructTreeRoot=tree
save('tagged.pdf',tagged)
def twenty(d):
    contents=d.pages[0].obj.Contents.read_bytes();resources=d.pages[0].obj.Resources
    for _ in range(19):
        page=d.add_blank_page(page_size=(595,842));page.obj.Resources=resources
    for i,page in enumerate(d.pages,1):
        text=('PAGE '+str(i).zfill(2)).encode('utf-16-be').hex()
        page.obj.Contents=d.make_stream(contents+(' BT /F0 10 Tf 45 740 Td <'+text+'> Tj ET').encode())
save('twenty.pdf',twenty)
save('twenty-one.pdf',lambda d:[d.pages.append(d.pages[0]) for _ in range(20)])
save('huge.pdf',lambda d:setattr(d.pages[0].obj,'MediaBox',p.Array([0,0,10000,10000])))
save('javascript.pdf',lambda d:setattr(d.Root,'OpenAction',p.Dictionary(S=p.Name('/JavaScript'),JS=p.String('void(0)'))))
with p.Pdf.new() as d:
    page=d.add_blank_page(page_size=(595,842));image=d.make_stream(bytes([255,255,255,30,40,50]*100))
    image.Type=p.Name('/XObject');image.Subtype=p.Name('/Image');image.Width=20;image.Height=10;image.ColorSpace=p.Name('/DeviceRGB');image.BitsPerComponent=8
    page.obj.Resources=p.Dictionary(XObject=p.Dictionary(Im=image));page.obj.Contents=d.make_stream(b'q 200 0 0 100 40 600 cm /Im Do Q');d.save(root/'image-only.pdf')
with p.Pdf.new() as d:
    page=d.add_blank_page(page_size=(1056,672));im=d.make_stream(random.Random(0).randbytes(2200*1400*3))
    im.Type=p.Name('/XObject');im.Subtype=p.Name('/Image');im.Width=2200;im.Height=1400;im.ColorSpace=p.Name('/DeviceRGB');im.BitsPerComponent=8
    page.obj.Resources=p.Dictionary(XObject=p.Dictionary(Im=im));page.obj.Contents=d.make_stream(b'q 1056 0 0 672 0 0 cm /Im Do Q');d.save(root/'image-noise.pdf')
for legacy in Path('/legacy-fixtures').glob('*.xlsx'):(root/('legacy-'+legacy.name)).write_bytes(legacy.read_bytes())
(root/'broken.pdf').write_bytes(b'%PDF-1.7\nTRUNCATED')
S='http://schemas.openxmlformats.org/spreadsheetml/2006/main';q=lambda x:'{'+S+'}'+x
original=zipfile.ZipFile(root/'sheets-resume.xlsx');parts={n:original.read(n) for n in original.namelist()}
def workbook(name,cells,*,date1904=False,merge=None,hidden=False):
    values=copy.copy(parts);sheet=E.fromstring(values['xl/worksheets/sheet1.xml']);old=sheet.find(q('sheetData'));position=list(sheet).index(old);sheet.remove(old)
    data=E.Element(q('sheetData'));sheet.insert(position,data)
    for i,cell in enumerate(cells,1):
        row=E.SubElement(data,q('row'),r=str(i));row.set('hidden','1' if hidden and i==2 else '0')
        if cell is None:continue
        attrs={'r':'A'+str(i)};attrs.update(cell.get('attrs',{}));c=E.SubElement(row,q('c'),attrs)
        if 'formula' in cell:E.SubElement(c,q('f')).text=cell['formula']
        if 'inline' in cell:E.SubElement(E.SubElement(c,q('is')),q('t')).text=cell['inline']
        if 'v' in cell:E.SubElement(c,q('v')).text=cell['v']
    for el in list(sheet):
        if el.tag==q('mergeCells'):sheet.remove(el)
    if merge:
        m=E.SubElement(sheet,q('mergeCells'))
        for ref in merge:E.SubElement(m,q('mergeCell'),ref=ref)
    values['xl/worksheets/sheet1.xml']=E.tostring(sheet,encoding='utf-8')
    styles=E.fromstring(values['xl/styles.xml']);xfs=styles.find(q('cellXfs'));idx=len(xfs)
    E.SubElement(xfs,q('xf'),numFmtId='14',fontId='0',fillId='0',borderId='0',applyNumberFormat='1');xfs.set('count',str(len(xfs)))
    values['xl/styles.xml']=E.tostring(styles,encoding='utf-8')
    # A sentinel style index is resolved without invoking an office recalculation engine.
    values['xl/worksheets/sheet1.xml']=values['xl/worksheets/sheet1.xml'].replace(b's="DATE"',f's="{idx}"'.encode())
    wb=E.fromstring(values['xl/workbook.xml']);prop=wb.find(q('workbookPr'))
    if prop is None:prop=E.SubElement(wb,q('workbookPr'))
    prop.set('date1904','1' if date1904 else '0')
    if hidden:wb.find(q('sheets'))[0].set('state','hidden')
    values['xl/workbook.xml']=E.tostring(wb,encoding='utf-8')
    with zipfile.ZipFile(root/name,'w',zipfile.ZIP_DEFLATED) as z:
        for n,v in values.items():z.writestr(n,v)
def val(v,**attrs):return {'v':str(v),'attrs':attrs}
cases={
 'types.xlsx':{'cells':[{'inline':'合成セル <script>noop</script>','attrs':{'t':'inlineStr'}},val('12345678901234567890.123'),val(1,t='b'),val(0,t='b'),None,{'v':'3','formula':'SUM(1,2)'},{'formula':'SUM(1,2)'},val('#DIV/0!',t='e'),val(0,t='s')]},
 'dates1900.xlsx':{'cells':[val(n,s='DATE') for n in [0,59,60,61,1.5]]},
 'dates1904.xlsx':{'cells':[val(0,s='DATE'),val(1,s='DATE')],'date1904':True},
 'merged.xlsx':{'cells':[val(10),None],'merge':['A1:B1']},
 'crossed.xlsx':{'cells':[val(10)],'merge':['A1:B2','B2:C3']},
 'hidden.xlsx':{'cells':[val(10),val(20)],'hidden':True},
 'unknown.xlsx':{'cells':[val('2026-10-16',t='d')]},
 'bad-reference.xlsx':{'cells':[val(9999999,t='s')]},
 'bad-bool.xlsx':{'cells':[val(2,t='b')]},
 'too-long-cell.xlsx':{'cells':[{'inline':'a'*32769,'attrs':{'t':'inlineStr'}}]},
 'too-many-cells.xlsx':{'cells':[val(i) for i in range(20001)]},
 'too-much-text.xlsx':{'cells':[{'inline':str(i)+'x'*31990,'attrs':{'t':'inlineStr'}} for i in range(34)]},
}
for name,cfg in cases.items():workbook(name,**cfg)
expected={
 'types.xlsx':{'A2':'12345678901234567890.123','A3':'はい','A4':'いいえ','A6':'3','A7':'保存値なし','A8':'#DIV/0!'},
 'dates1900.xlsx':{'A1':'0','A2':'1900-02-28','A3':'60','A4':'1900-03-01','A5':'1.5'},
 'dates1904.xlsx':{'A1':'1904-01-01','A2':'1904-01-02'},
 'merged.xlsx':{'A1':'10'},'hidden.xlsx':{'A1':'10','A2':'20'},
 'legacy-sheets-resume.xlsx':'FORMAT_UNSUPPORTED_STRUCTURE','legacy-sheets-career-history.xlsx':'FORMAT_UNSUPPORTED_STRUCTURE','crossed.xlsx':'MERGE','unknown.xlsx':'CELL_TYPE','bad-reference.xlsx':'REFERENCE','bad-bool.xlsx':'BOOLEAN',
 'too-long-cell.xlsx':'CELL_LIMIT','too-many-cells.xlsx':'CELLS_LIMIT','too-much-text.xlsx':'TEXT_LIMIT',
}
manifest={'source':'R1-qualified fictional Sheets-derived exports with corrected synthetic PNG from e2e/fixtures; unchanged R0 bad-PNG files retained as negative cases; controlled OOXML mutations. No real Excel compatibility claim','xlsx_expected':expected,'files':{}}
for f in sorted(root.iterdir()):
    if f.suffix in ('.pdf','.xlsx'):manifest['files'][f.name]={'sha256':hashlib.sha256(f.read_bytes()).hexdigest(),'bytes':f.stat().st_size}
(root/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
