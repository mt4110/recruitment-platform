"""One disposable sandbox job; stdout contains bounded evidence, never raw data."""
import sys,os,json,re,subprocess,resource,time,hashlib,socket,urllib.request,math,struct
from pathlib import Path
ROOT=Path('/tmp/job');ROOT.mkdir(exist_ok=True)
def sha(b):return hashlib.sha256(b).hexdigest()
def validate(path,kind):
    r=subprocess.run(['python','/app/'+('validator.py' if kind=='pdf' else 'xlsx_validator.py')],input=path.read_bytes(),capture_output=True,timeout=10)
    if r.returncode:raise ValueError('VALIDATOR_PROCESS')
    return json.loads(r.stdout)
def limited():
    resource.setrlimit(resource.RLIMIT_CPU,(30,30))
def pdf_view(path):
    check=validate(path,'pdf')
    if not check['accepted']:return {'accepted':False,'reason':'FORMAT_'+check['reason']}
    # Preflight page geometry before rasterization, within this untrusted sandbox.
    import pikepdf
    with pikepdf.Pdf.open(path) as doc:
        pixels=0
        for page in doc.pages:
            box=page.obj.get('/CropBox',page.obj.MediaBox);unit=float(page.obj.get('/UserUnit',1))
            width=math.ceil(abs(float(box[2])-float(box[0]))*unit*150/72);height=math.ceil(abs(float(box[3])-float(box[1]))*unit*150/72)
            if width>4096 or height>4096 or width*height>8000000:raise ValueError('PIXELS_LIMIT')
            pixels+=width*height
        if pixels>80000000:raise ValueError('PIXELS_LIMIT')
        pages=len(doc.pages)
    prefix=ROOT/path.stem
    r=subprocess.run(['pdftoppm','-r','150','-png',str(path),str(prefix)],capture_output=True,timeout=60,preexec_fn=limited)
    if r.returncode:raise ValueError('RENDER_PROCESS')
    outputs=sorted(ROOT.glob(path.stem+'-*.png'));total=0;images=[]
    for f in outputs:
        data=f.read_bytes();total+=len(data)
        if len(data)>8*1024*1024 or total>64*1024*1024:raise ValueError('OUTPUT_LIMIT')
        if data[:8]!=b'\x89PNG\r\n\x1a\n':raise ValueError('IMAGE_TYPE')
        w,h=struct.unpack('>II',data[16:24]);images.append({'name':f.name,'sha256':sha(data),'bytes':len(data),'width':w,'height':h})
    if len(images)!=pages:raise ValueError('PAGE_COUNT')
    t=subprocess.run(['pdftotext','-layout',str(path),'-'],capture_output=True,timeout=10)
    if t.returncode:raise ValueError('TEXT_PROCESS')
    if len(t.stdout)>1048576:raise ValueError('TEXT_LIMIT')
    return {'accepted':True,'pages':pages,'images':images,'text_bytes':len(t.stdout),'text_sha256':sha(t.stdout),'japanese_present':'請求書' in t.stdout.decode('utf-8'),'text_unavailable':not t.stdout.strip(),'page_order_verified':re.findall(rb'PAGE\s+([0-9]{2})',t.stdout)==[str(i).zfill(2).encode() for i in range(1,21)]}
def xlsx_view(path):
    check=validate(path,'xlsx')
    if not check['accepted']:return {'accepted':False,'reason':'FORMAT_'+check['reason']}
    from view_xlsx import normalize
    value=normalize(path.read_bytes())
    if len(json.dumps(value,ensure_ascii=False).encode())>1048576:raise ValueError('OUTPUT_LIMIT')
    return {'accepted':True,**value}
def isolation(config):
    checks={}
    for name,host,port,allowed in config:
        try:
            with socket.create_connection((host,port),timeout=1):connected=True
        except OSError:connected=False
        checks[name]=connected==allowed
    request=urllib.request.Request('http://relay:8080/job',data=b'isolated-synthetic-job',method='POST')
    with urllib.request.urlopen(request,timeout=2) as r:checks['relay_actual_bytes']=json.load(r)['bytes']==22
    for name,path in [('original_key','/broker-secret/v1.pem'),('artifact_key','/viewer-secret/v1.pem'),('docker_socket','/var/run/docker.sock'),('host_proc','/host/proc/1/environ')]:
        checks[name+'_inaccessible']=not os.access(path,os.R_OK)
    checks['nonroot']=os.getuid()==2103
    status=Path('/proc/self/status').read_text()
    checks['no_new_privs']='NoNewPrivs:\t1' in status;checks['no_capabilities']='CapEff:\t0000000000000000' in status;checks['seccomp']='Seccomp:\t2' in status
    checks['no_secrets_in_environment']=not any('PRIVATE KEY' in v for v in os.environ.values())
    checks['fresh_job_tmpfs']=not (ROOT/'previous-job-marker').exists();(ROOT/'previous-job-marker').write_text('synthetic')
    return {'checks':checks,'uid':os.getuid(),'pid_namespace':os.readlink('/proc/self/ns/pid'),'mount_namespace':os.readlink('/proc/self/ns/mnt'),'fds':[{'fd':p.name,'target':os.readlink(p)} for p in Path('/proc/self/fd').iterdir() if p.exists()]}
def resources():
    checks={};meta={}
    for file in ('memory.max','pids.max','cpu.max','memory.peak','cpu.stat'):
        p=Path('/sys/fs/cgroup')/file
        if p.exists():meta[file]=p.read_text().strip()
    checks['memory_1GiB']=meta.get('memory.max')=='1073741824';checks['pids_64']=meta.get('pids.max')=='64';checks['cpus_2']=meta.get('cpu.max','').startswith('200000 ')
    try:
        Path('/s0/forbidden-write').write_text('synthetic');checks['readonly_root']=False
    except OSError:checks['readonly_root']=True
    # Lower child limits exercise the same OS enforcement without consuming the full project budget.
    def memlimit():resource.setrlimit(resource.RLIMIT_AS,(64*1024*1024,)*2)
    r=subprocess.run(['python','-c','a=bytearray(128*1024*1024)'],preexec_fn=memlimit,capture_output=True,timeout=5)
    checks['address_limit_enforced']=r.returncode!=0 and b'MemoryError' in r.stderr
    def cpulimit():resource.setrlimit(resource.RLIMIT_CPU,(1,1))
    start=time.monotonic();r=subprocess.run(['python','-c','while True: pass'],preexec_fn=cpulimit,capture_output=True,timeout=5)
    checks['cpu_limit_enforced']=r.returncode<0
    try:subprocess.run(['python','-c','import time;time.sleep(10)'],timeout=.2,capture_output=True);checks['wall_limit_enforced']=False
    except subprocess.TimeoutExpired:checks['wall_limit_enforced']=True
    scratch=ROOT/'scratch-probe'
    try:
        with scratch.open('wb') as f:
            for _ in range(300):f.write(bytes(1024*1024))
        checks['tmpfs_enospc']=False
    except OSError as e:checks['tmpfs_enospc']=e.errno==28
    return {'checks':checks,'cgroup':meta,'limit_probe_seconds':time.monotonic()-start}
mode=sys.argv[1];started=time.monotonic()
try:
    if mode=='isolation':result=isolation(json.loads(sys.argv[2]))
    elif mode=='resources':result=resources()
    else:
        path=Path('/fixtures')/sys.argv[2]
        try:result=pdf_view(path) if mode=='pdf' else xlsx_view(path)
        except (ValueError,subprocess.TimeoutExpired) as exc:result={'accepted':False,'reason':str(exc) if isinstance(exc,ValueError) else 'TIME_LIMIT'}
    result['seconds']=time.monotonic()-started;result['rss_kib']=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    result['child_rss_kib']=resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    peak=Path('/sys/fs/cgroup/memory.peak');result['cgroup_peak_bytes']=int(peak.read_text()) if peak.exists() else None
    print(json.dumps(result,ensure_ascii=False))
except Exception as exc:
    print(json.dumps({'harness_error':type(exc).__name__}));sys.exit(1)
