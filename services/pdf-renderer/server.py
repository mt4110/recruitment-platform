"""Authenticated internal byte-only PDF inspection; one isolated worker at a time."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib, hmac, json, os, subprocess, sys, threading

KEY = os.environ['PDF_SHARED_KEY']
SLOT = threading.BoundedSemaphore(1)
LIMIT = 10 * 1024 * 1024
class Handler(BaseHTTPRequestHandler):
    def reply(self,status,body):
        raw=json.dumps(body).encode()
        self.send_response(status);self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(raw)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(raw)
    def do_GET(self):
        self.reply(200 if self.path=='/live' else 404,{})
    def do_POST(self):
        self.connection.settimeout(6)
        if self.path not in ('/internal/pdf/check','/internal/document/check'):return self.reply(404,{})
        if not hmac.compare_digest(self.headers.get('X-PDF-Key','').encode('utf-8'),KEY.encode('utf-8')):return self.reply(403,{})
        try:length=int(self.headers.get('Content-Length','0'))
        except ValueError:return self.reply(400,{})
        if not 1<=length<=LIMIT:return self.reply(413,{})
        media=self.headers.get('Content-Type')
        if media not in ('application/pdf','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') or (self.path=='/internal/pdf/check' and media!='application/pdf'):return self.reply(415,{})
        policy='static-resume-v1' if media=='application/pdf' else 'xlsx-resume-v1'
        worker_path='/app/validator.py' if media=='application/pdf' else '/app/xlsx_validator.py'
        if not SLOT.acquire(blocking=False):return self.reply(503,{})
        try:
            raw=self.rfile.read(length)
            if len(raw)!=length:return self.reply(400,{})
            worker=subprocess.run([sys.executable,worker_path],input=raw,capture_output=True,timeout=5,env={'PATH':'/usr/local/bin:/usr/bin','PYTHONDONTWRITEBYTECODE':'1'})
            if worker.returncode:return self.reply(503,{})
            result=json.loads(worker.stdout)
            if result.get('reason')=='PARSER_VERSION':return self.reply(503,{})
            self.reply(200,{'ok':result['accepted'],'policy':policy,'sha256':hashlib.sha256(raw).hexdigest(),'rejection_code':None if result['accepted'] else result['reason']})
        except (OSError,ValueError,subprocess.TimeoutExpired):self.reply(503,{})
        finally:SLOT.release()
    def log_message(self,*args):pass
ThreadingHTTPServer(('0.0.0.0',8080),Handler).serve_forever()
