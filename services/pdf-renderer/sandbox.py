"""Fresh container per job; no credentials/mounts. Parser child is OS bounded."""
from http.server import BaseHTTPRequestHandler,HTTPServer
import hashlib,json,subprocess,sys,re
from pathlib import Path
outputs={}
used=False
class Handler(BaseHTTPRequestHandler):
 def reply(self,status,body):
  data=json.dumps(body).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
 def do_GET(self):
  if self.path=='/live':return self.reply(200,{})
  name=self.path.removeprefix('/artifact/')
  if not self.path.startswith('/artifact/') or name not in outputs:return self.reply(404,{})
  data=(Path('/tmp/view-job')/name).read_bytes()
  if len(data)!=outputs[name]['size'] or hashlib.sha256(data).hexdigest()!=outputs[name]['sha256']:return self.reply(503,{})
  self.send_response(200);self.send_header('Content-Length',str(len(data)));self.send_header('Content-Type','application/octet-stream');self.end_headers();self.wfile.write(data)
 def do_POST(self):
  global used
  self.connection.settimeout(5)
  try:
   n=int(self.headers.get('Content-Length','0'));media=self.headers.get('Content-Type')
   if used or self.path!='/check' or not 1<=n<=10485760 or media not in ('application/pdf','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'):return self.reply(403,{})
   used=True;raw=self.rfile.read(n)
   if len(raw)!=n:return self.reply(400,{})
   path='/app/validator.py' if media=='application/pdf' else '/app/xlsx_validator.py'
   worker=subprocess.run([sys.executable,path],input=raw,capture_output=True,timeout=6,env={'PATH':'/usr/local/bin:/usr/bin','PYTHONDONTWRITEBYTECODE':'1'},close_fds=True)
   if worker.returncode:return self.reply(503,{})
   result=json.loads(worker.stdout)
   if result.get('reason')=='PARSER_VERSION':return self.reply(503,{})
   code=None if result['accepted'] else 'FORMAT_'+result['reason']
   view=None
   if result['accepted']:
    conversion=subprocess.run([sys.executable,'/app/convert.py','pdf' if media=='application/pdf' else 'xlsx'],input=raw,capture_output=True,timeout=60,env={'PATH':'/usr/local/bin:/usr/bin','PYTHONDONTWRITEBYTECODE':'1'},close_fds=True)
    if conversion.returncode:return self.reply(200,{'ok':False,'policy':'static-resume-v1' if media=='application/pdf' else 'xlsx-resume-v1','sha256':hashlib.sha256(raw).hexdigest(),'rejection_code':'FORMAT_CONVERSION_REJECTED','view':None})
    view=json.loads(conversion.stdout)
    for item in view['artifacts']:outputs[item['name']]=item
   self.reply(200,{'view':view,'ok':result['accepted'],'policy':'static-resume-v1' if media=='application/pdf' else 'xlsx-resume-v1','sha256':hashlib.sha256(raw).hexdigest(),'rejection_code':code})
  except (OSError,ValueError,subprocess.TimeoutExpired):self.reply(503,{})
 def log_message(self,*args):pass
HTTPServer(('0.0.0.0',8080),Handler).serve_forever()
