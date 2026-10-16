"""Bounded saved-value display; never evaluates a formula or emits raw HTML."""
import io,zipfile,json,datetime,decimal,re,xml.etree.ElementTree as E
S='http://schemas.openxmlformats.org/spreadsheetml/2006/main';R='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
q=lambda x:'{'+S+'}'+x
class Refused(ValueError):pass
def fail(x):raise Refused(x)
def coord(s):
    m=re.fullmatch(r'([A-Z]{1,3})([1-9][0-9]{0,6})',s or '')
    if not m:fail('REFERENCE')
    col=0
    for c in m[1]:col=26*col+ord(c)-64
    row=int(m[2])
    if col>16384 or row>1048576:fail('REFERENCE')
    return col,row
def normalize(raw):
    # The caller must run the existing bounded XLSX validator first.
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        wb=E.fromstring(z.read('xl/workbook.xml'));props=wb.find(q('workbookPr'));date1904=props is not None and props.get('date1904','0') in ('1','true')
        rel=E.fromstring(z.read('xl/_rels/workbook.xml.rels'));targets={x.get('Id'):x.get('Target') for x in rel}
        ss=[]
        if 'xl/sharedStrings.xml' in z.namelist():ss=[''.join(t.text or '' for t in list(x.findall(q('t')))+list(x.findall(q('r')+'/'+q('t')))) for x in E.fromstring(z.read('xl/sharedStrings.xml'))]
        styles=E.fromstring(z.read('xl/styles.xml'));xfs=styles.find(q('cellXfs'));formats=[int(x.get('numFmtId','0')) for x in xfs] if xfs is not None else []
        total=cells_count=0;result=[]
        for info in wb.find(q('sheets')):
            target=targets.get(info.get('{'+R+'}id'))
            if not target:fail('REFERENCE')
            path=('xl/'+target) if not target.startswith('/') else target[1:]
            if '..' in path.split('/'):fail('REFERENCE')
            sheet=E.fromstring(z.read(path));cells=[];seen=set();rects=[]
            for merge in sheet.findall('./'+q('mergeCells')+'/'+q('mergeCell')):
                parts=merge.get('ref','').split(':')
                if len(parts)!=2:fail('MERGE')
                a,b=map(coord,parts);x1,y1=a;x2,y2=b
                if x2<x1 or y2<y1:fail('MERGE')
                if any(x1<=d[2] and x2>=d[0] and y1<=d[3] and y2>=d[1] for d in rects):fail('MERGE')
                rects.append((x1,y1,x2,y2))
                if len(rects)>20000:fail('CELLS_LIMIT')
            hidden_cols=[]
            for col in sheet.findall('./'+q('cols')+'/'+q('col')):
                a,b=int(col.get('min','0')),int(col.get('max','0'))
                if not 1<=a<=b<=16384:fail('REFERENCE')
                if col.get('hidden') in ('1','true'):hidden_cols.append((a,b))
            for row in sheet.findall('./'+q('sheetData')+'/'+q('row')):
                for cell in row.findall(q('c')):
                    cells_count+=1
                    if cells_count>20000:fail('CELLS_LIMIT')
                    address=cell.get('r');column,cell_row=coord(address)
                    if str(cell_row)!=row.get('r'):fail('REFERENCE')
                    if address in seen:fail('REFERENCE')
                    seen.add(address);typ=cell.get('t','n');v=cell.find(q('v'));value=v.text if v is not None and v.text is not None else '';warnings=[]
                    style=int(cell.get('s','0'))
                    if style<0 or (style>=len(formats) if formats else style!=0):fail('REFERENCE')
                    formula=cell.find(q('f')) is not None
                    if formula and (v is None or v.text is None):typ='str';value='保存値なし'
                    if typ=='s':
                        if not value.isdecimal() or int(value)>=len(ss):fail('REFERENCE')
                        value=ss[int(value)]
                    elif typ=='inlineStr':value=''.join(t.text or '' for t in cell.findall('.//'+q('t')))
                    elif typ=='b':
                        if value not in ('0','1'):fail('BOOLEAN')
                        value='はい' if value=='1' else 'いいえ'
                    elif typ=='n':
                        if value:
                            if len(value)>32768 or not re.fullmatch(r'[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[Ee][+-]?[0-9]+)?',value):fail('NUMBER')
                            number=decimal.Decimal(value)
                            if not number.is_finite():fail('NUMBER')
                            style=int(cell.get('s','0'))
                            if style<0 or (formats and style>=len(formats)):fail('REFERENCE')
                            fmt=formats[style] if formats else 0
                            if 14<=fmt<=17:
                                if number<0 or number>2958465 or number!=number.to_integral_value():warnings.append('未変換')
                                elif not date1904 and number==60:warnings.append('Excel互換の仮想日付')
                                elif not date1904 and number==0:warnings.append('未変換')
                                else:
                                    origin=datetime.date(1904,1,1) if date1904 else datetime.date(1899,12,31) if number<60 else datetime.date(1899,12,30)
                                    try:value=(origin+datetime.timedelta(days=int(number))).isoformat()
                                    except (OverflowError,ValueError):warnings.append('未変換')
                            elif fmt!=0:warnings.append('書式未再現')
                    elif typ in ('str','e'):
                        if typ=='e':warnings.append('保存エラー値')
                    else:fail('CELL_TYPE')
                    if formula:
                        warnings.append('再計算していない保存値')
                        if v is None or v.text is None:value='保存値なし'
                    size=len(value.encode('utf-8'))
                    if size>32768:fail('CELL_LIMIT')
                    total+=size
                    if total>1048576:fail('TEXT_LIMIT')
                    cells.append({'cell':address,'value':value,'warnings':warnings,'merge_origin':next((str(x1)+','+str(y1) for x1,y1,x2,y2 in rects if x1<=column<=x2 and y1<=coord(address)[1]<=y2 and (column,coord(address)[1])!=(x1,y1)),None),'hidden':row.get('hidden') in ('1','true') or any(a<=column<=b for a,b in hidden_cols)})
            result.append({'name':info.get('name'),'hidden':info.get('state','visible')!='visible','cells':cells,'merges':rects})
        return {'sheets':result,'image_parts':sum(n.startswith('xl/media/') for n in z.namelist()),'layout':'limited table; images/styles omitted','text_bytes':total,'cells':cells_count}
