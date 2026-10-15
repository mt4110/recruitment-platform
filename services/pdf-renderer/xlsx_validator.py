"""xlsx-resume-v1: bounded, inert OOXML inspection. Never calculates or renders."""
import hashlib
import io
import json
import posixpath
import re
import resource
import stat
import sys
import zipfile
import unicodedata
from xml.parsers import expat
import xml.etree.ElementTree as ET

S='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
R='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
P='http://schemas.openxmlformats.org/package/2006/relationships'
C='http://schemas.openxmlformats.org/package/2006/content-types'
A='http://schemas.openxmlformats.org/drawingml/2006/main'
X='http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
PERSON='http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments'
PERSON_REL='http://schemas.microsoft.com/office/2017/10/relationships/person'
PERSON_TYPE='application/vnd.ms-excel.person+xml'
TYPES={
 'workbook':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
 'sheet':'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
 'styles':'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml',
 'strings':'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml',
 'theme':'application/vnd.openxmlformats-officedocument.theme+xml',
 'drawing':'application/vnd.openxmlformats-officedocument.drawing+xml',
 'calc':'application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml',
 'core':'application/vnd.openxmlformats-package.core-properties+xml',
 'app':'application/vnd.openxmlformats-officedocument.extended-properties+xml',
 'persons':PERSON_TYPE,'rels':'application/vnd.openxmlformats-package.relationships+xml',
 'png':'image/png','jpeg':'image/jpeg',
}
PATTERNS=[('workbook',r'xl/workbook\.xml'),('sheet',r'xl/worksheets/sheet[1-9][0-9]*\.xml'),
 ('styles',r'xl/styles\.xml'),('strings',r'xl/sharedStrings\.xml'),('theme',r'xl/theme/theme[1-9][0-9]*\.xml'),
 ('drawing',r'xl/drawings/drawing[1-9][0-9]*\.xml'),('calc',r'xl/calcChain\.xml'),
 ('persons',r'xl/persons/person\.xml'),('core',r'docProps/core\.xml'),('app',r'docProps/app\.xml'),
 ('png',r'xl/media/[^/]+\.png'),('jpeg',r'xl/media/[^/]+\.(?:jpg|jpeg)')]
TAGS={
 S:set('workbook workbookPr bookViews workbookView sheets sheet calcPr definedNames definedName worksheet sheetPr pageSetUpPr outlinePr sheetViews sheetView pane selection sheetFormatPr cols col sheetData row c f v is t r rPr rFont charset family b i strike outline shadow condense extend color sz u vertAlign scheme mergeCells mergeCell pageMargins pageSetup printOptions rowBreaks colBreaks brk dimension sheetProtection autoFilter filterColumn filters filter sortState sortCondition ignoredErrors ignoredError drawing styleSheet numFmts numFmt fonts font name fills fill patternFill gradientFill stop fgColor bgColor borders border left right top bottom diagonal vertical horizontal start end cellStyleXfs cellXfs xf alignment protection cellStyles cellStyle dxfs dxf tableStyles sst si phoneticPr rPh calcChain'.split()),
 X:set('wsDr oneCellAnchor twoCellAnchor absoluteAnchor from to col colOff row rowOff ext pos pic nvPicPr cNvPr cNvPicPr blipFill spPr clientData'.split()),
 A:set('avLst blip srcRect stretch fillRect xfrm off ext prstGeom picLocks noFill solidFill schemeClr srgbClr sysClr theme themeElements clrScheme dk1 dk2 lt1 lt2 accent1 accent2 accent3 accent4 accent5 accent6 hlink folHlink fontScheme majorFont minorFont latin ea cs font fmtScheme fillStyleLst gradFill gsLst gs lin path fillToRect lnStyleLst ln prstDash miter effectStyleLst effectStyle effectLst outerShdw bgFillStyleLst tint shade alpha lumMod lumOff satMod satOff hueMod hueOff'.split()),
 P:{'Relationships','Relationship'},C:{'Types','Default','Override'},PERSON:{'personList'},
 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties':{'coreProperties','category','contentStatus','created','keywords','lastModifiedBy','lastPrinted','modified','revision','version'},
 'http://purl.org/dc/elements/1.1/':{'creator','description','identifier','language','subject','title'},
 'http://purl.org/dc/terms/':{'created','modified'},
 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties':set('Properties Application AppVersion Company Manager Pages Words Characters CharactersWithSpaces Lines Paragraphs TotalTime Template DocSecurity ScaleCrop HeadingPairs TitlesOfParts LinksUpToDate SharedDoc HyperlinksChanged'.split()),
 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes':set('vector variant lpstr lpwstr i4 bool'.split()),
}
# Sheets emits these namespace identifiers without elements/attributes using them.
# A declaration is inert; this set never authorizes its structures or relationships.
UNUSED_NS={
 'http://schemas.microsoft.com/office/drawing/2010/slicer',
 'http://schemas.microsoft.com/office/drawing/2012/slicer',
 'http://schemas.microsoft.com/office/drawing/2014/chartex',
 'http://schemas.microsoft.com/office/drawing/2015/9/8/chartex',
 'http://schemas.openxmlformats.org/drawingml/2006/chart',
 'http://schemas.openxmlformats.org/drawingml/2006/diagram',
 'http://schemas.openxmlformats.org/markup-compatibility/2006',
 'http://schemas.microsoft.com/office/excel/2006/main',
 'http://schemas.microsoft.com/office/mac/excel/2008/main',
 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac',
 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main',
 'http://schemas.microsoft.com/office/spreadsheetml/2010/11/main',
 'urn:schemas-microsoft-com:mac:vml',
}
ATTR_NS={R,'http://www.w3.org/XML/1998/namespace','http://www.w3.org/2001/XMLSchema-instance'}
class Refused(Exception):pass
def refuse(code='UNSUPPORTED_STRUCTURE'):raise Refused(code)
def q(ns,name):return '{'+ns+'}'+name

def xml(data,budget):
    try:text=data.decode('utf-8-sig')
    except UnicodeError:refuse()
    if '\x00' in text:refuse()
    if re.search(r'<\?xml\s+[^?]*encoding\s*=\s*[\'"](?!UTF-8[\'"]|utf-8[\'"])',text):refuse()
    p=expat.ParserCreate(namespace_separator='}')
    depth=0
    def fail(*_):refuse()
    def start(name,attrs):
        nonlocal depth
        depth+=1;budget[0]+=1
        if depth>64 or budget[0]>200000:refuse('STRUCTURE_LIMIT')
        ns,sep,tag=name.rpartition('}')
        if not sep or tag not in TAGS.get(ns,set()):refuse()
        for key in attrs:
            if '}' in key and key.rsplit('}',1)[0] not in ATTR_NS:refuse()
    def end(_):
        nonlocal depth
        depth-=1
    p.StartElementHandler=start;p.EndElementHandler=end
    def namespace(_prefix,uri):
        if uri and uri not in set(TAGS)|ATTR_NS|UNUSED_NS:refuse()
    p.StartNamespaceDeclHandler=namespace
    p.ProcessingInstructionHandler=fail
    p.StartDoctypeDeclHandler=fail;p.EntityDeclHandler=fail;p.ExternalEntityRefHandler=fail
    p.SetParamEntityParsing(expat.XML_PARAM_ENTITY_PARSING_NEVER)
    p.Parse(data,True)
    return ET.fromstring(data)

CELL=r'\$?[A-Za-z]{1,3}\$?[1-9][0-9]{0,6}'
TOKEN=re.compile(r'''\s*(?:(?P<string>"(?:[^"]|"")*")|(?P<sheet>'(?:[^']|'')*')|(?P<number>(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)|(?P<row>\$[1-9][0-9]*)|(?P<word>\$?[A-Za-z_][A-Za-z0-9_.$]*)|(?P<op><>|<=|>=|[+*/(),:!<>=-]))''')
FUNCTIONS={'SUM':(1,255),'MIN':(1,255),'MAX':(1,255),'AVERAGE':(1,255),'IF':(2,3),'AND':(1,255),'OR':(1,255),'ROUND':(2,2),'DATE':(3,3),'YEAR':(1,1),'MONTH':(1,1),'DAY':(1,1),'DATEDIF':(3,3),'TODAY':(0,0),'TEXT':(2,2)}
class Formula:
    def __init__(self,text,sheets):
        if not text or len(text)>4096:refuse('UNSUPPORTED_FORMULA')
        self.tokens=[];self.i=0;self.sheets={s.casefold() for s in sheets};pos=0
        while pos<len(text):
            if not text[pos:].strip():break
            m=TOKEN.match(text,pos)
            if not m:refuse('UNSUPPORTED_FORMULA')
            self.tokens.append((m.lastgroup,m.group(m.lastgroup)));pos=m.end()
            if len(self.tokens)>2048:refuse('STRUCTURE_LIMIT')
    def peek(self):return self.tokens[self.i][1] if self.i<len(self.tokens) else None
    def pop(self):
        if self.i>=len(self.tokens):refuse('UNSUPPORTED_FORMULA')
        x=self.tokens[self.i];self.i+=1;return x
    def eat(self,value):
        if self.peek()!=value:refuse('UNSUPPORTED_FORMULA')
        self.pop()
    def ref(self,titles=False):
        kind,value=self.pop()
        if self.peek()=='!':
            sheet=value[1:-1].replace("''", "'") if kind=='sheet' else value
            if kind not in {'sheet','word'} or sheet.casefold() not in self.sheets:refuse('UNSUPPORTED_FORMULA')
            self.pop();kind,value=self.pop()
        if titles and ((kind in {'row','number'} and re.fullmatch(r'\$?[1-9][0-9]*',value)) or (kind=='word' and re.fullmatch(r'\$?[A-Za-z]{1,3}',value))):
            row=kind in {'row','number'}
            first=value.replace('$','');self.eat(':');last_kind,last=self.pop();last=last.replace('$','')
            if row:
                if not last.isdigit() or not 1<=int(first)<=int(last)<=1048576:refuse('UNSUPPORTED_FORMULA')
            else:
                if not re.fullmatch(r'[A-Za-z]{1,3}',last):refuse('UNSUPPORTED_FORMULA')
                cols=[]
                for letters in (first,last):
                    col=0
                    for letter in letters.upper():col=col*26+ord(letter)-64
                    cols.append(col)
                if not 1<=cols[0]<=cols[1]<=16384:refuse('UNSUPPORTED_FORMULA')
            return
        if kind!='word' or not re.fullmatch(CELL,value):refuse('UNSUPPORTED_FORMULA')
        letters=re.sub('[^A-Za-z]','',value).upper();col=0
        for c in letters:col=col*26+ord(c)-64
        if col>16384 or int(re.sub('[^0-9]','',value))>1048576:refuse('UNSUPPORTED_FORMULA')
        if self.peek()==':':
            self.pop();kind,value=self.pop()
            if kind!='word' or not re.fullmatch(CELL,value):refuse('UNSUPPORTED_FORMULA')
            letters=re.sub('[^A-Za-z]','',value).upper();col=0
            for c in letters:col=col*26+ord(c)-64
            if col>16384 or int(re.sub('[^0-9]','',value))>1048576:refuse('UNSUPPORTED_FORMULA')
    def expression(self,min_prec=0,depth=0):
        if depth>64:refuse('STRUCTURE_LIMIT')
        kind,value=self.tokens[self.i] if self.i<len(self.tokens) else ('','')
        if value in ('+','-'):
            self.pop();self.expression(4,depth+1)
        elif value=='(':
            self.pop();self.expression(0,depth+1);self.eat(')')
        elif kind in {'number','string'}:
            self.pop()
        elif kind=='word' and self.i+1<len(self.tokens) and self.tokens[self.i+1][1]=='(':
            name=self.pop()[1].upper()
            if name not in FUNCTIONS:refuse('UNSUPPORTED_FORMULA')
            self.eat('(');n=0
            if self.peek()!=')':
                while True:
                    self.expression(0,depth+1);n+=1
                    if self.peek()!=',':break
                    self.pop()
            self.eat(')');lo,hi=FUNCTIONS[name]
            if not lo<=n<=hi:refuse('UNSUPPORTED_FORMULA')
        elif kind=='word' and value.upper() in {'TRUE','FALSE'} and (self.i+1==len(self.tokens) or self.tokens[self.i+1][1]!='!'):self.pop()
        else:self.ref()
        prec={'=':1,'<>':1,'<':1,'>':1,'<=':1,'>=':1,'+':2,'-':2,'*':3,'/':3}
        while self.peek() in prec and prec[self.peek()]>=min_prec:
            op=self.pop()[1];self.expression(prec[op]+1,depth+1)
    def check(self,names=False,titles=False):
        if names:
            self.ref(titles)
            while self.peek()==',':self.pop();self.ref(titles)
        else:self.expression()
        if self.i!=len(self.tokens):refuse('UNSUPPORTED_FORMULA')

def inspect(raw):
    try:
        if not 0<len(raw)<=10*1024*1024:refuse('SIZE')
        if tuple(map(int,expat.EXPAT_VERSION.split('_')[-1].split('.'))) < (2,7,2):refuse('PARSER_VERSION')
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            entries=z.infolist();names=[e.filename for e in entries]
            if len(entries)>1000 or len(names)!=len(set(names)):refuse('STRUCTURE_LIMIT')
            parts={};roots={};kinds={};normalized=set();budget=[0];total=0
            for e in entries:
                name=e.filename
                if (name!=e.orig_filename or not name or name.startswith('/') or '\\' in name or '%' in name or ':' in name or '\x00' in name or any(p in {'.','..',''} for p in name.split('/')) or e.is_dir() or e.flag_bits&1 or stat.S_ISLNK(e.external_attr>>16)):refuse()
                norm=unicodedata.normalize('NFC',posixpath.normpath(name)).casefold()
                if norm in normalized:refuse()
                normalized.add(norm)
                if e.file_size>16*1024*1024:refuse('STRUCTURE_LIMIT')
                kind='types' if name=='[Content_Types].xml' else 'rels' if name=='_rels/.rels' or re.fullmatch(r'(?:xl|docProps)(?:/[^/]+)*/_rels/[^/]+\.rels',name) else next((k for k,p in PATTERNS if re.fullmatch(p,name)),None)
                if not kind:refuse()
                with z.open(e) as f:data=f.read(16*1024*1024+1)
                total+=len(data)
                if len(data)!=e.file_size or total>64*1024*1024 or total>len(raw)*100:refuse('STRUCTURE_LIMIT')
                parts[name]=data;kinds[name]=kind
                if kind not in {'png','jpeg'}:roots[name]=xml(data,budget)
            if not {'[Content_Types].xml','_rels/.rels','xl/workbook.xml','xl/_rels/workbook.xml.rels'}<=parts.keys():refuse()
            types=roots['[Content_Types].xml'];defaults={};overrides={}
            if types.tag!=q(C,'Types'):refuse()
            for el in types:
                if el.tag==q(C,'Default') and set(el.attrib)=={'Extension','ContentType'}:
                    ext=el.get('Extension');ct=el.get('ContentType')
                    if ext in defaults or (ext,ct) not in {('xml','application/xml'),('rels',TYPES['rels']),('png','image/png'),('jpg','image/jpeg'),('jpeg','image/jpeg'),('odttf','application/vnd.openxmlformats-officedocument.obfuscatedFont')}:refuse()
                    defaults[ext]=ct
                elif el.tag==q(C,'Override') and set(el.attrib)=={'PartName','ContentType'}:
                    name=el.get('PartName')
                    if not name.startswith('/') or name[1:] not in parts or name in overrides:refuse()
                    overrides[name]=el.get('ContentType')
                else:refuse()
            for name,kind in kinds.items():
                if kind=='types':continue
                if overrides.get('/'+name,defaults.get(name.rsplit('.',1)[-1]))!=TYPES[kind]:refuse()
            relations={};referenced={'[Content_Types].xml','_rels/.rels'};person_refs=0
            allowed={R+'/officeDocument':('root','workbook'),R+'/worksheet':('workbook','sheet'),R+'/styles':('workbook','styles'),R+'/sharedStrings':('workbook','strings'),R+'/theme':('workbook','theme'),R+'/calcChain':('workbook','calc'),R+'/drawing':('sheet','drawing'),R+'/image':('drawing',('png','jpeg')),PERSON_REL:('workbook','persons'),'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties':('root','core'),R+'/extended-properties':('root','app')}
            for name,root in roots.items():
                if kinds[name]!='rels':continue
                if name=='_rels/.rels':source='';source_kind='root'
                else:
                    directory,filename=name.rsplit('/_rels/',1);source=directory+'/'+filename[:-5]
                    if source not in kinds:refuse()
                    source_kind=kinds[source]
                if root.tag!=q(P,'Relationships'):refuse()
                rels={};relations[source]=rels;referenced.add(name)
                for el in root:
                    if el.tag!=q(P,'Relationship') or set(el.attrib)-{'Id','Type','Target','TargetMode'} or not {'Id','Type','Target'}<=el.attrib.keys():refuse()
                    rid=el.get('Id');target=el.get('Target');typ=el.get('Type')
                    if not rid or rid in rels or el.get('TargetMode','Internal')!='Internal' or not target or any(c in target for c in ['\\','%',':','#','?','\x00']) or target.startswith('/'):refuse()
                    dest=posixpath.normpath(posixpath.join(posixpath.dirname(source),target))
                    if dest.startswith('../') or dest not in kinds or typ not in allowed:refuse()
                    expected_source,expected_dest=allowed[typ]
                    if source_kind!=expected_source or kinds[dest] not in ((expected_dest,) if isinstance(expected_dest,str) else expected_dest):refuse()
                    if typ==PERSON_REL:
                        person_refs+=1
                        if dest!='xl/persons/person.xml' or target!='persons/person.xml':refuse()
                    rels[rid]=(typ,dest);referenced.add(dest)
            if [v for v in relations.get('',{}).values() if v[0]==R+'/officeDocument']!=[(R+'/officeDocument','xl/workbook.xml')]:refuse()
            if set(parts)-referenced:refuse()
            expected_roots={'sheet':q(S,'worksheet'),'styles':q(S,'styleSheet'),'strings':q(S,'sst'),'theme':q(A,'theme'),'drawing':q(X,'wsDr'),'calc':q(S,'calcChain'),'persons':q(PERSON,'personList')}
            for name,root in roots.items():
                if kinds[name] in expected_roots and root.tag!=expected_roots[kinds[name]]:refuse()
            workbook=roots['xl/workbook.xml']
            if workbook.tag!=q(S,'workbook'):refuse()
            sheets=workbook.findall('./'+q(S,'sheets')+'/'+q(S,'sheet'))
            sheet_names=[s.get('name','') for s in sheets]
            if not 1<=len(sheets)<=20 or any(not s for s in sheet_names) or len({s.casefold() for s in sheet_names})!=len(sheets):refuse()
            if any(len(name)>31 or name.startswith("'") or name.endswith("'") or re.search(r'[\[\]:*?/\\\x00-\x1f]',name) for name in sheet_names):refuse()
            for sheet in sheets:
                rel=relations.get('xl/workbook.xml',{}).get(sheet.get(q(R,'id')))
                if not rel or rel[0]!=R+'/worksheet':refuse()
            for name,root in roots.items():
                kind=kinds[name]
                if kind=='persons':
                    if len(parts[name])>16384 or root.tag!=q(PERSON,'personList') or root.attrib or list(root) or (root.text or '').strip() or person_refs!=1:refuse()
                for el in root.iter():
                    for attr,value in el.attrib.items():
                        if attr in {q(R,'id'),q(R,'embed')} and value not in relations.get(name,{}):refuse()
                    if el.tag==q(S,'f'):
                        if el.attrib:refuse('UNSUPPORTED_FORMULA')
                        Formula(el.text,sheet_names).check()
                    if el.tag==q(S,'definedName'):
                        if el.get('name') not in {'_xlnm.Print_Area','_xlnm.Print_Titles'}:refuse('UNSUPPORTED_FORMULA')
                        Formula(el.text,sheet_names).check(names=True,titles=el.get('name')=='_xlnm.Print_Titles')
            images=[n for n,k in kinds.items() if k in {'png','jpeg'}]
            if len(images)>10:refuse('STRUCTURE_LIMIT')
            from PIL import Image
            for name in images:
                if len(parts[name])>4*1024*1024:refuse('STRUCTURE_LIMIT')
                with Image.open(io.BytesIO(parts[name])) as image:
                    if image.format != ('PNG' if kinds[name]=='png' else 'JPEG'):refuse()
                    image.verify()
        return {'accepted':True,'policy':'xlsx-resume-v1','sha256':hashlib.sha256(raw).hexdigest()}
    except Refused as exc:return {'accepted':False,'reason':str(exc)}
    except (ValueError,KeyError,TypeError,ET.ParseError,expat.ExpatError,zipfile.BadZipFile,NotImplementedError,OSError,RecursionError,SyntaxError):return {'accepted':False,'reason':'UNSUPPORTED_STRUCTURE'}

if __name__=='__main__':
    resource.setrlimit(resource.RLIMIT_AS,(256*1024*1024,)*2)
    resource.setrlimit(resource.RLIMIT_CPU,(5,5))
    print(json.dumps(inspect(sys.stdin.buffer.read(10*1024*1024+1))))
