"""Authenticated bounded byte-only HTTP -> private clamd Unix socket.
The exclusive lock drains scans before reload. Failures terminate the worker.
"""
import hashlib, hmac, json, os, socket, struct, subprocess, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from common import ROOT, database_manifest, fresh, identity, read_manifest
KEY=os.environ['SCAN_SHARED_KEY']
if len(KEY)<32:raise ValueError('invalid service configuration')
MAX=10*1024*1024
LOCK=threading.Lock()
loaded=None
worker=None
sock=None
engine=None

def stop():
    global loaded,worker
    loaded=None
    if worker and worker.poll() is None:
        worker.terminate()
        try:worker.wait(timeout=2)
        except subprocess.TimeoutExpired:worker.kill();worker.wait(timeout=2)
    worker=None

def command(payload,timeout=20):
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
        deadline=time.monotonic()+timeout
        s.settimeout(timeout);s.connect(sock);s.settimeout(max(.001,deadline-time.monotonic()));s.sendall(payload)
        answer=b''
        while b'\0' not in answer:
            remaining=deadline-time.monotonic()
            if remaining<=0:raise TimeoutError('scan deadline')
            s.settimeout(remaining);part=s.recv(4096)
            if not part or len(answer)>8192:raise ValueError('protocol')
            answer+=part
        return answer.rstrip(b'\0')

def ensure():
    global loaded,worker,sock,engine
    m=read_manifest()
    if not fresh(m):raise ValueError('stale')
    if loaded and identity(m)==identity(loaded) and worker.poll() is None:
        if command(b'zPING\0',2)!=b'PONG':raise ValueError('worker')
        return m
    stop()
    directory=ROOT/m['generation_id']
    if database_manifest(directory)!=m['databases']:raise ValueError('hash mismatch')
    sock='/tmp/'+str(uuid.uuid4())+'.sock'
    conf=Path('/tmp/'+str(uuid.uuid4())+'.conf')
    conf.write_text(f'DatabaseDirectory {directory}\nForeground yes\nLocalSocket {sock}\nTemporaryDirectory /tmp\nMaxThreads 1\nMaxQueue 2\nMaxScanTime 20000\nMaxScanSize 64M\nMaxFileSize 16M\nMaxRecursion 8\nMaxFiles 1000\nStreamMaxLength 10M\nAlertExceedsMax yes\nConcurrentDatabaseReload no\nSelfCheck 0\n')
    worker=subprocess.Popen(['clamd','--config-file='+str(conf)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    deadline=time.monotonic()+90
    while time.monotonic()<deadline:
        if worker.poll() is not None:raise ValueError('load failure')
        try:
            version=command(b'zVERSION\0',2).decode()
            if not version.startswith('ClamAV 1.5.4/') or f'/{m["databases"]["daily"]["version"]}/' not in version:raise ValueError('version mismatch')
            if database_manifest(directory)!=m['databases']:raise ValueError('load hash mismatch')
            if identity(read_manifest())!=identity(m):raise ValueError('generation changed')
            engine='1.5.4';loaded=m
            return m
        except (OSError,ValueError):time.sleep(.3)
    raise ValueError('load timeout')

def watch():
    while True:
        if LOCK.acquire(blocking=False):
            try:ensure()
            except Exception:stop()
            finally:LOCK.release()
        time.sleep(2)

class Handler(BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'
    def setup(self):super().setup();self.connection.settimeout(22)
    def log_message(self,*args):pass
    def respond(self,status,value):
        body=json.dumps(value).encode()
        try:
            self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.send_header('Connection','close');self.end_headers();self.wfile.write(body)
        except OSError:pass  # A disconnected HTTP caller does not invalidate the engine.
        finally:self.close_connection=True
    def auth(self):return hmac.compare_digest(self.headers.get('X-Scan-Key',''),KEY)
    def do_GET(self):
        if self.path=='/live':return self.respond(200,{'live':True})
        if not self.auth():return self.respond(403,{})
        if self.path!='/internal/scan/state':return self.respond(404,{})
        if not LOCK.acquire(blocking=False):return self.respond(503,{})
        try:
            m=read_manifest()
            if not loaded or not worker or worker.poll() is not None or not fresh(m) or identity(m)!=identity(loaded):raise ValueError('not ready')
            self.respond(200,dict(m,engine_version=engine))
        except Exception:self.respond(503,{})
        finally:LOCK.release()
    def do_POST(self):
        if not self.auth():return self.respond(403,{})
        if self.path!='/internal/scan':return self.respond(404,{})
        try:
            nonce=str(uuid.UUID(self.headers['X-Scan-Nonce']))
            length=int(self.headers['Content-Length'])
            if self.headers.get('Transfer-Encoding') or not 0<length<=MAX: return self.respond(413,{})
        except (ValueError,KeyError,TypeError):return self.respond(400,{})
        if not LOCK.acquire(blocking=False):return self.respond(503,{})
        try:
            m=read_manifest()
            if not loaded or not worker or worker.poll() is not None or not fresh(m) or identity(m)!=identity(loaded):raise ValueError('not ready')
            data=self.rfile.read(length)
            if len(data)!=length:raise ValueError('incomplete')
            started=time.monotonic()
            # Real INSTREAM framing, never paths, CLI stdin truncation or scan caches.
            response=command(b'zINSTREAM\0'+struct.pack('!I',len(data))+data+struct.pack('!I',0),20)
            if time.monotonic()-started>20:raise ValueError('timeout')
            if response==b'stream: OK':verdict='clean'
            elif response.startswith(b'stream: ') and response.endswith(b' FOUND'):verdict='blocked'
            elif b'size limit exceeded' in response:verdict='blocked'
            else:raise ValueError('scan error')
            current=read_manifest()
            if identity(current)!=identity(m) or not fresh(current):raise ValueError('generation changed')
            self.respond(200,dict(current,nonce=nonce,sha256=hashlib.sha256(data).hexdigest(),verdict=verdict,engine_version=engine))
        except Exception:
            stop();self.respond(503,{})
        finally:LOCK.release()

if __name__=='__main__':
    threading.Thread(target=watch,daemon=True).start()
    # Bound simultaneous HTTP handlers as well as byte buffers. No unbounded thread queue.
    class Server(ThreadingHTTPServer):
        daemon_threads=True
        slots=threading.BoundedSemaphore(4)
        def process_request(self,request,address):
            if not self.slots.acquire(blocking=False):request.close();return
            try:super().process_request(request,address)
            except Exception:self.slots.release();raise
        def process_request_thread(self,request,address):
            try:super().process_request_thread(request,address)
            finally:self.slots.release()
    Server(('0.0.0.0',8080),Handler).serve_forever()
