"""Runs in the real isolated inspector container. Synthetic mutations only."""
import io,json,subprocess,sys,zipfile,stat
from pathlib import Path
base=bytes.fromhex(sys.argv[1]);career=bytes.fromhex(sys.argv[2]);old=bytes.fromhex(sys.argv[3])
def rewrite(raw,part,change):
 out=io.BytesIO()
 with zipfile.ZipFile(io.BytesIO(raw)) as src,zipfile.ZipFile(out,'w',compression=zipfile.ZIP_STORED) as dst:
  for n in src.namelist():dst.writestr(n,change(src.read(n)) if n==part else src.read(n))
 return out.getvalue()
def add(raw,name,data,mode=None):
 out=io.BytesIO(raw)
 with zipfile.ZipFile(out,'a') as z:
  info=zipfile.ZipInfo(name)
  if mode:info.external_attr=mode<<16
  z.writestr(info,data)
 return out.getvalue()
def form(text):return rewrite(base,'xl/worksheets/sheet1.xml',lambda d:d.replace(b'YEAR(DATE(2026,10,15))-YEAR(B5)',text.encode()))
cases={'native_resume':(base,True),'native_career':(career,True),'old_bad_png':(old,False),'broken_zip':(b'PK-broken',False),'pdf_disguised':(b'%PDF-1.7\n',False),'size':(b'0'*(10*1024*1024+1),False)}
for text in ['SUM(A1:A3)+ROUND(1.25,1)','IF(A1>=2,DATE(2026,10,15),TODAY())',"'補足'!A1",'TEXT(B5,"yyyy-mm-dd")','DATEDIF(B5,DATE(2026,10,15),"Y")']:
 cases['formula_good_'+text]=(form(text),True)
for text in ['WEBSERVICE("https://invalid.example")','HYPERLINK("https://invalid.example","x")','RTD("x",,"y")','cmd|\' /C calc\'!A0','[other.xlsx]Sheet1!A1','UNKNOWN(A1)','INDIRECT("A1")','A1+','SUM(A1))','A0','XFE1','$A$1048577','DATE(1,2)','TODAY(1)',"'NotPresent'!A1",'((((A1)', '"unterminated']:
 cases['formula_bad_'+text]=(form(text),False)
cases.update({
 'person_data':(rewrite(base,'xl/persons/person.xml',lambda _:b'<personList xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"><person/></personList>'),False),
 'person_attribute':(rewrite(base,'xl/persons/person.xml',lambda _:b'<personList xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments" unknown="1"/>'),False),
 'unknown_namespace':(rewrite(base,'xl/workbook.xml',lambda d:d.replace(b'http://schemas.openxmlformats.org/spreadsheetml/2006/main',b'urn:unknown')),False),
 'doctype':(rewrite(base,'xl/persons/person.xml',lambda _:b'<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><x/>'),False),
 'processing_instruction':(rewrite(base,'xl/persons/person.xml',lambda d:d.replace(b'?>',b'?><?xml-stylesheet href="https://invalid.example/evil.xsl"?>',1)),False),
 'utf16':(rewrite(base,'xl/workbook.xml',lambda d:d.decode().encode('utf-16')),False),
 'external_relationship':(rewrite(base,'xl/_rels/workbook.xml.rels',lambda d:d.replace(b'Target="persons/person.xml"',b'Target="https://invalid.example/x" TargetMode="External"')),False),
 'missing_target':(rewrite(base,'xl/_rels/workbook.xml.rels',lambda d:d.replace(b'Target="persons/person.xml"',b'Target="persons/missing.xml"')),False),
 'wrong_content_type':(rewrite(base,'[Content_Types].xml',lambda d:d.replace(b'application/vnd.ms-excel.person+xml',b'application/octet-stream')),False),
 'shared_formula':(rewrite(base,'xl/worksheets/sheet1.xml',lambda d:d.replace(b'<f>',b'<f t="shared" si="0">')),False),
 'unknown_name':(rewrite(base,'xl/workbook.xml',lambda d:d.replace(b'_xlnm.Print_Area',b'ArbitraryName')),False),
 'duplicate_part':(add(base,'xl/workbook.xml',b'<x/>'),False),
 'case_collision':(add(base,'xl/WORKBOOK.xml',b'<x/>'),False),
 'traversal':(add(base,'../escape.xml',b'<x/>'),False),
 'backslash':(add(base,'xl\\evil.xml',b'<x/>'),False),
 'macro':(add(base,'xl/vbaProject.bin',b'not real macro'),False),
 'ole':(add(base,'xl/embeddings/oleObject1.bin',b'fictional'),False),
 'comment':(add(base,'xl/threadedComments/threadedComment1.xml',b'<x/>'),False),
 'font_part':(add(base,'xl/fonts/font1.odttf',b'fictional'),False),
 'symlink':(add(base,'xl/media/link.png',b'anything',stat.S_IFLNK|0o777),False),
 'nested_zip':(add(base,'xl/media/archive.zip',b'PK'),False),
 'too_many_entries':(base,False),
})
# The fixture has empty definedNames; add a custom name instead of a no-op mutation.
cases['unknown_name']=(rewrite(base,'xl/workbook.xml',lambda d:d.replace(b'</workbook>',b'<definedNames><definedName name="Unknown">A1</definedName></definedNames></workbook>')),False)
x=io.BytesIO(base)
with zipfile.ZipFile(x,'a') as z:
 for i in range(1001):z.writestr('xl/extra'+str(i)+'.xml',b'<x/>')
cases['too_many_entries']=(x.getvalue(),False)
for name,ref,accepted in [('print_area',"'履歴書'!$A$1:$F$18",True),('print_rows',"'履歴書'!$1:$3",True),('print_cols',"'履歴書'!$A:$B",True),('print_unsafe',"WEBSERVICE(\"https://invalid.example\")",False)]:
 text=f'<definedNames><definedName name="{"_xlnm.Print_Area" if name=="print_area" else "_xlnm.Print_Titles"}">{ref}</definedName></definedNames>'
 cases[name]=(rewrite(base,'xl/workbook.xml',lambda d,t=text:d.replace(b'</workbook>',t.encode()+b'</workbook>')),accepted)
def deflated(part,value):
 out=io.BytesIO()
 with zipfile.ZipFile(io.BytesIO(base)) as src,zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED) as dst:
  for n in src.namelist():dst.writestr(n,value if n==part else src.read(n))
 return out.getvalue()
sheet_ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
cases['entry_size_limit']=(deflated('xl/sharedStrings.xml',b'A'*(16*1024*1024+1)),False)
cases['expansion_ratio_limit']=(deflated('xl/sharedStrings.xml',b'A'*(2*1024*1024)),False)
cases['xml_depth_limit']=(rewrite(base,'xl/worksheets/sheet1.xml',lambda _:f'<worksheet xmlns="{sheet_ns}">'.encode()+b'<r>'*65+b'</r>'*65+b'</worksheet>'),False)
cases['xml_element_limit']=(rewrite(base,'xl/worksheets/sheet1.xml',lambda _:f'<worksheet xmlns="{sheet_ns}">'.encode()+b'<r/>'*200001+b'</worksheet>'),False)
cases['unused_namespace_structure']=(rewrite(base,'xl/workbook.xml',lambda d:d.replace(b'</workbook>',b'<vm:shape xmlns:vm="urn:schemas-microsoft-com:mac:vml"/></workbook>')),False)
cases['unknown_unused_namespace']=(rewrite(base,'xl/workbook.xml',lambda d:d.replace(b'<workbook ',b'<workbook xmlns:evil="urn:unknown" ',1)),False)
cases['formula_length_limit']=(form('1+'*2100+'1'),False)
cases['formula_token_limit']=(form('1+'*1100+'1'),False)
cases['formula_depth_limit']=(form('('*66+'A1'+')'*66),False)
results={}
for name,(raw,accepted) in cases.items():
 p=subprocess.run([sys.executable,'/app/xlsx_validator.py'],input=raw,capture_output=True,timeout=6,env={'PATH':'/usr/local/bin:/usr/bin','PYTHONDONTWRITEBYTECODE':'1'})
 assert p.returncode==0,(name,'worker error',p.stderr[:200])
 r=json.loads(p.stdout);assert r['accepted']==accepted,(name,r)
 results[name]={'accepted':r['accepted'],'reason':r.get('reason')}
print(json.dumps({'scope':'real bounded XLSX worker; native fixtures and synthetic adversarial cases','count':len(results),'results':results}))
