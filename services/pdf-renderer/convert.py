"""One bounded untrusted conversion; called only in the disposable keyless sandbox."""
import hashlib,json,math,os,resource,struct,subprocess,sys
from pathlib import Path

def digest(b):return hashlib.sha256(b).hexdigest()
def cpu():resource.setrlimit(resource.RLIMIT_CPU,(30,30))
def run(args,timeout=60):
 r=subprocess.run(args,capture_output=True,timeout=timeout,close_fds=True,preexec_fn=cpu,env={'PATH':'/usr/local/bin:/usr/bin','HOME':'/tmp','PYTHONDONTWRITEBYTECODE':'1'})
 if r.returncode:raise ValueError('CONVERSION_FAILED')
 return r.stdout

def convert(raw,kind):
 root=Path('/tmp/view-job');root.mkdir(mode=0o700)
 source=root/('source.'+kind);source.write_bytes(raw)
 artifacts=[]
 def add(name,data,kind,page=None):
  if len(data)>(8388608 if kind=='page' else 1048576):raise ValueError('OUTPUT_LIMIT')
  (root/name).write_bytes(data);artifacts.append({'name':name,'kind':kind,'page':page,'size':len(data),'sha256':digest(data)})
 if kind=='xlsx':
  from view_xlsx import normalize
  table=normalize(raw);data=json.dumps(table,ensure_ascii=False,separators=(',',':')).encode()
  add('table.json',data,'table');pages=0
 else:
  import pikepdf
  with pikepdf.Pdf.open(source) as pdf:
   pixels=0;pages=len(pdf.pages)
   if not 1<=pages<=20:raise ValueError('PAGE_LIMIT')
   for page in pdf.pages:
    box=page.obj.get('/CropBox',page.obj.MediaBox);unit=float(page.obj.get('/UserUnit',1))
    w=math.ceil(abs(float(box[2])-float(box[0]))*unit*150/72);h=math.ceil(abs(float(box[3])-float(box[1]))*unit*150/72)
    if not 1<=w<=4096 or not 1<=h<=4096 or w*h>8000000:raise ValueError('PIXELS_LIMIT')
    pixels+=w*h
   if pixels>80000000:raise ValueError('PIXELS_LIMIT')
  # Render one page at a time; never trust lexical filename ordering.
  total=0
  for page in range(1,pages+1):
   name='page-'+str(page);run(['pdftoppm','-cropbox','-f',str(page),'-l',str(page),'-singlefile','-r','150','-png',str(source),str(root/name)])
   data=(root/(name+'.png')).read_bytes()
   if data[:8]!=b'\x89PNG\r\n\x1a\n':raise ValueError('IMAGE_TYPE')
   w,h=struct.unpack('>II',data[16:24])
   if w>4096 or h>4096 or w*h>8000000:raise ValueError('PIXELS_LIMIT')
   total+=len(data)
   if total>67108864:raise ValueError('OUTPUT_LIMIT')
   add(name+'.png',data,'page',page)
  text=run(['pdftotext','-layout',str(source),'-'],10).decode('utf-8',errors='strict')
  add('text.json',json.dumps({'text':text,'unavailable':not text.strip()},ensure_ascii=False,separators=(',',':')).encode(),'text')
 return {'format':kind,'pages':pages,'artifacts':artifacts}
if __name__=='__main__':
 resource.setrlimit(resource.RLIMIT_CPU,(30,30))
 try:print(json.dumps(convert(sys.stdin.buffer.read(10485761),sys.argv[1])))
 except (ValueError,OSError,subprocess.TimeoutExpired):print(json.dumps({'error':'CONVERSION_REJECTED'}));sys.exit(1)
