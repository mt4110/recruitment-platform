"""Reproducible S0 harness. Retains stopped containers/volumes; never prunes."""
from pathlib import Path
import argparse,datetime,hashlib,http.server,ipaddress,json,os,platform,shutil,socket,subprocess,tarfile,threading,time,urllib.request,uuid
ROOT=Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser();p.add_argument('--base-image',required=True);p.add_argument('--out',required=True);args=p.parse_args()
out=Path(args.out).resolve();out.mkdir(parents=True,exist_ok=False);private=out/'private';private.mkdir(mode=0o700)
prefix='recruitment-s0-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:5]
image=prefix+':probe';containers=[];networks=[];records=[];failures=[];bridges=[];started=time.monotonic()
def call(a,**kw):return subprocess.run(a,check=True,**kw)
def docker(*a):return subprocess.check_output(['docker',*a],text=True).strip()
def save(name,value):(out/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
def health():
    try:
        with urllib.request.urlopen('http://localhost:3000/',timeout=5) as r:return r.status
    except Exception:return None
def check(name,ok):
    records.append({'name':name,'pass':bool(ok)})
    if not ok:failures.append(name)
def freeport():
    with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
def setup_network(suffix):
    ids=docker('network','ls','-q').splitlines()
    used=[ipaddress.ip_network(c['Subnet']) for net in json.loads(docker('network','inspect',*ids)) for c in (net['IPAM'].get('Config') or []) if c.get('Subnet') and ':' not in c['Subnet']]
    subnet=next(n for n in ipaddress.ip_network('10.240.0.0/16').subnets(new_prefix=28) if not any(n.overlaps(u) for u in used))
    n=prefix+'-'+suffix;docker('network','create','--internal','--subnet',str(subnet),n);networks.append(n);return n
def launch(role,network,*,port=None,extra=None,command=None,cpus='0.25',memory='128m',pids='32'):
    name=prefix+'-'+role;uid={'broker':2101,'viewer':2102,'api-sentinel':2104,'db-sentinel':2105,'peer-sentinel':2106}.get(role,2103)
    a=['run','-d','--name',name,'--network',network,'--network-alias',role,'--user',f'{uid}:{uid}','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory',memory,'--memory-swap',memory,'--cpus',cpus,'--pids-limit',pids,'--tmpfs',f'/tmp:size={"256m" if role.startswith("job") else "16m"},uid={uid},gid={uid},mode=0700']
    if port:a+=['-p',f'127.0.0.1:{port}:8080']
    if role in ('broker','viewer'):a+=['-v',f'{prefix}-{role}-keys:/{role}-secret']
    a+=extra or [];a+=[image];a+=command or ['node','/s0/role.cjs'];docker(*a);containers.append(name);return name
def sandbox(mode,filename=None,config=None,copy_image=False):
    role='job'+str(len(containers));cmd=['python','/s0/probe.py',mode]+([filename] if filename else [])+([json.dumps(config)] if config is not None else [])
    name=launch(role,front,command=['python','-c','import time; time.sleep(600)'],cpus='2',memory='1g',pids='64')
    proc=subprocess.run(['docker','exec',name,*cmd],capture_output=True,text=True,timeout=120);code=proc.returncode;raw=proc.stdout
    if code:raise RuntimeError('sandbox '+mode+' failed: '+raw[:100])
    value=json.loads(raw);(private/(role+'.json')).write_text(json.dumps(value,ensure_ascii=False))
    if copy_image:
        dest=private/role;dest.mkdir()
        archive=subprocess.check_output(['docker','exec',name,'tar','-C','/tmp/job','-cf','-','.'])
        import io
        with tarfile.open(fileobj=io.BytesIO(archive)) as tf:
            for entry in tf:
                if entry.isfile() and entry.name.endswith('.png'):
                    if entry.size>8*1024*1024 or '/' in entry.name.removeprefix('./'):raise RuntimeError('unsafe evidence archive')
                    (dest/Path(entry.name).name).write_bytes(tf.extractfile(entry).read())
    docker('stop','-t','1',name)
    return value
source_files={str(f.relative_to(ROOT)):hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted((ROOT/'validation/s0').glob('*')) if f.is_file()}
baseline=health();save('before.json',{'demo_http_status':baseline})
try:
    # Curated tar context: never send .local, env, cookies or test private keys.
    paths=list((ROOT/'validation/s0').glob('*'))+list((ROOT/'validation/r0/fixtures').glob('*.xlsx'))+list((ROOT/'e2e/fixtures').glob('sheets-*.xlsx'))+[ROOT/'docs/demo/2026-10-16-m5/m5-invoice.pdf']
    context=private/'build-context';context.mkdir()
    for f in paths:
        if f.is_file():
            target=context/f.relative_to(ROOT);target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(f,target)
    with (private/'build.log').open('wb') as log:call(['docker','build','--rm=false','-f',str(context/'validation/s0/Dockerfile'),'--build-arg','BASE='+args.base_image,'-t',image,str(context)],stdout=log,stderr=subprocess.STDOUT)
    back=setup_network('back');front=setup_network('front');view=setup_network('view')
    broker=launch('broker',back,extra=['-e','S0_ROLE=broker'],cpus='1',memory='512m',pids='64')
    viewer=launch('viewer',view,extra=['-e','S0_ROLE=viewer'])
    def host_bridge(container):
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*a):pass
            def forward(self):
                count=int(self.headers.get('Content-Length','0'))
                if count>15*1024*1024:self.send_error(413);return
                body=self.rfile.read(count).decode() if count else ''
                packet=json.dumps({'path':self.path,'method':self.command,'body':body}).encode()
                r=subprocess.run(['docker','exec','-i',container,'node','/s0/client.cjs'],input=packet,capture_output=True,timeout=30)
                if r.returncode:self.send_error(503);return
                v=json.loads(r.stdout);self.send_response(v['status']);self.send_header('Content-Type',v['contentType']);self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(v['body'].encode())
            do_GET=forward
            do_POST=forward
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start();bridges.append(server)
        return 'http://127.0.0.1:'+str(server.server_port)
    broker_url=host_bridge(broker);viewer_url=host_bridge(viewer)
    relay=launch('relay',back,extra=['-e','S0_ROLE=relay']);docker('network','connect','--alias','relay',front,relay)
    for url in [broker_url,viewer_url]:
        for _ in range(100):
            try:
                with urllib.request.urlopen(url+'/health',timeout=2) as r:
                    if r.status==200:break
            except Exception:time.sleep(.1)
        else:raise RuntimeError('fixture role startup timeout')
    api_target=launch('api-sentinel',back,extra=['-e','S0_ROLE=relay'],cpus='.125',memory='32m')
    db_target=launch('db-sentinel',back,extra=['-e','S0_ROLE=relay'],cpus='.125',memory='32m')
    peer_target=launch('peer-sentinel',view,extra=['-e','S0_ROLE=relay'],cpus='.125',memory='32m')
    def ip(name,net):return json.loads(docker('inspect',name))[0]['NetworkSettings']['Networks'][net]['IPAddress']
    config=[['relay_reachable',ip(relay,front),8080,True],['broker_blocked',ip(broker,back),8080,False],['viewer_blocked',ip(viewer,view),8080,False],['external_blocked','1.1.1.1',443,False]]
    config.extend([[n+'_blocked',ip(c,net),8080,False] for n,c,net in [('api',api_target,back),('db',db_target,back),('other_job',peer_target,view)]])
    for i in range(2):
        value=sandbox('isolation',config=config);save('isolation-'+str(i)+'.json',value)
        check('isolation_'+str(i),all(value['checks'].values()))
    call(['node',str(ROOT/'validation/s0/browser.cjs'),broker_url,viewer_url,str(out)],cwd=ROOT)
    crypto=json.loads((out/'crypto.json').read_text());check('crypto',all(c['pass'] for c in crypto['checks']))
    # Copy the expectation manifest, fixed before any candidate conversion runs.
    call(['docker','cp',broker+':/fixtures/manifest.json',str(private/'manifest.json')],stdout=subprocess.DEVNULL)
    manifest=json.loads((private/'manifest.json').read_text());save('fixture-manifest.json',manifest)
    cases=[];views={}
    for filename,accepted in [('japanese.pdf',True),('tagged.pdf',True),('twenty.pdf',True),('image-only.pdf',True),('huge.pdf',False),('javascript.pdf',False),('broken.pdf',False),('twenty-one.pdf',False),('m5-invoice.pdf',False),('image-noise.pdf',False)]:
        r=sandbox('pdf',filename,copy_image=accepted)
        ok=r.get('accepted') is accepted
        if accepted:ok=ok and r['pages']==(20 if filename=='twenty.pdf' else 1)
        if filename=='image-only.pdf':ok=ok and r.get('text_unavailable')
        if filename=='twenty.pdf':ok=ok and r.get('page_order_verified')
        if filename=='image-noise.pdf':ok=ok and r.get('reason')=='OUTPUT_LIMIT'
        if filename in ('japanese.pdf','tagged.pdf','twenty.pdf'):ok=ok and r.get('japanese_present')
        check(filename,ok);cases.append({'fixture':filename,'expected_accepted':accepted,**r})
    for filename in ['sheets-resume.xlsx','sheets-career-history.xlsx',*manifest['xlsx_expected']]:
        r=sandbox('xlsx',filename);expected=manifest['xlsx_expected'].get(filename,{})
        ok=r.get('accepted') if isinstance(expected,dict) else not r.get('accepted') and r.get('reason')==expected
        if isinstance(expected,dict) and r.get('accepted'):
            values={c['cell']:c['value'] for c in r['sheets'][0]['cells']}
            ok=ok and all(values.get(k)==v for k,v in expected.items())
            if filename=='types.xlsx':ok=ok and any('再計算していない保存値' in c['warnings'] for c in r['sheets'][0]['cells'])
            if filename=='hidden.xlsx':ok=ok and r['sheets'][0]['hidden'] and r['sheets'][0]['cells'][1]['hidden']
        if r.get('accepted'):views[filename]=r
        check(filename,ok)
        # Raw normalized contents remain private; public evidence is hash/metadata only.
        cases.append({'fixture':filename,'accepted':r.get('accepted'),'reason':r.get('reason'),'seconds':r.get('seconds'),'cells':r.get('cells'),'normalized_sha256':hashlib.sha256(json.dumps(r,ensure_ascii=False).encode()).hexdigest(),'expectation_match':bool(ok)})
    save('cases.json',cases)
    (private/'views.json').write_text(json.dumps(views,ensure_ascii=False))
    call(['node',str(ROOT/'validation/s0/view.cjs'),str(private/'views.json'),str(out)],cwd=ROOT)
    resources=sandbox('resources');save('resources.json',resources);check('resources',all(resources['checks'].values()))
    samples=[]
    for i in range(4):
        r=sandbox('pdf','japanese.pdf');samples.append({'sample':i,'cold_process':True,'seconds':r['seconds'],'rss_kib':r['rss_kib']});check('sequential_sample_'+str(i),r['accepted'])
    save('timing.json',{'scope':'new sandbox process each sample; image cache warm after first; not production latency or p95','samples':samples})
except Exception as e:
    failures.append(type(e).__name__+': '+str(e)[:160]);save('harness-error.json',{'error':failures[-1]})
finally:
    inspect=[]
    for name in containers:
        value=json.loads(docker('inspect',name))[0]
        inspect.append({'name':name,'image':value['Image'],'uid':value['Config']['User'],'host_config':{k:value['HostConfig'].get(k) for k in ('ReadonlyRootfs','CapDrop','SecurityOpt','Memory','MemorySwap','NanoCpus','PidsLimit','Tmpfs','PidMode','Privileged')},'mounts':[{'type':m['Type'],'destination':m['Destination'],'rw':m['RW']} for m in value['Mounts']],'networks':list(value['NetworkSettings']['Networks']),'state':{k:value['State'].get(k) for k in ('ExitCode','OOMKilled')}})
    for name in containers:
        if json.loads(docker('inspect',name))[0]['State']['Running']:docker('stop','-t','3',name)
    for server in bridges:server.shutdown();server.server_close()
    check('demo_preserved',health()==baseline)
    save('isolation-config.json',inspect)
    version=docker('run','--name',prefix+'-versions','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','128m','--cpus','.25','--pids-limit','32',image,'python','-c',"import platform,pikepdf;print(platform.machine(),pikepdf.__version__)") if 'back' in globals() else 'image build incomplete'
    save('summary.json',{'scope':'S0 only; no product API/migration/R5/S1/publication','prefix':prefix,'source_files':source_files,'source_unchanged':all((ROOT/f).is_file() and hashlib.sha256((ROOT/f).read_bytes()).hexdigest()==h for f,h in source_files.items()),'source_commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'host':platform.platform(),'qualified_platform':version,'base_image':args.base_image,'image_id':docker('image','inspect','--format','{{.Id}}',image) if 'back' in globals() else None,'seconds':time.monotonic()-started,'checks':records,'failures':failures,'all_passed':not failures,'containers_stopped':all(not json.loads(docker('inspect',n))[0]['State']['Running'] for n in containers),'preserved_volumes':True})
print(json.dumps({'out':str(out),'checks':len(records),'failures':failures},ensure_ascii=False));raise SystemExit(1 if failures else 0)
