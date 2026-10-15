"""M0-only native-platform verification, no product services or migrations."""
from pathlib import Path
import os,sys,json,subprocess,time,platform,hashlib,unicodedata
from pypdf import PdfReader

ROOT=Path(__file__).parent;os.chdir(ROOT)
PREFIX=os.environ.setdefault('M0_PREFIX','rpm0-'+str(int(time.time())))
D=['docker']+(['--context',os.environ['M0_DOCKER_CONTEXT']] if os.environ.get('M0_DOCKER_CONTEXT') else [])
out=ROOT/'collected';out.mkdir(exist_ok=True)
def cmd(args,**kw):return subprocess.run(args,check=True,text=True,**kw)
def docker(*args):return subprocess.check_output([*D,*args],text=True).strip()
def build(file,tag):
    with open(ROOT/(file+'.log'),'w') as f:cmd([*D,'build','-f',file,'-t',tag,'.'],stdout=f,stderr=subprocess.STDOUT)
def script(name):cmd([sys.executable,str(ROOT/name)])
start=time.time();result={'host_os':platform.system(),'host_arch':platform.machine(),'started_at_epoch':start,'scope':'M0 only'}
try:
    script('make_fixtures.py');script('setup.py')
    for _ in range(60):
        ready=subprocess.run([*D,'exec',PREFIX+'-db','pg_isready','-U','postgres','-d','m0'],capture_output=True)
        if ready.returncode==0:break
        time.sleep(.5)
    else:raise RuntimeError('Postgres startup timeout')
    script('rls_probe.py');script('prepare_auth.py')
    build('Dockerfile.auth','recruitment-m0-auth:20261015');build('Dockerfile.auth-final','recruitment-m0-auth-run:20261015')
    docker('run','-d','--name',PREFIX+'-auth','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--tmpfs','/tmp:size=16m',
           '--network',PREFIX+'-network','--memory','256m','--cpus','1','-p','127.0.0.1:18081:18081','recruitment-m0-auth-run:20261015')
    import httpx
    for _ in range(40):
        try:
            if httpx.get('http://localhost:18081/results',trust_env=False).status_code==200:break
        except httpx.HTTPError:pass
        time.sleep(.5)
    else:raise RuntimeError('OIDC probe startup timeout')
    cmd(['node','auth_browser.cjs'])
    auth=json.loads((ROOT/'auth-result.json').read_text())
    assert auth['harness_sha256']==hashlib.sha256((ROOT/'auth_browser.cjs').read_bytes()).hexdigest()
    build('Dockerfile.pdf-deps','recruitment-m0-pdf-deps:20261015');build('Dockerfile.pdf-final','recruitment-m0-pdf-run:20261015')
    docker('run','-d','--name',PREFIX+'-pdf','--read-only','--cap-drop=ALL','--cap-add=SYS_CHROOT','--security-opt=no-new-privileges',
           '--security-opt','seccomp='+str(ROOT/'seccomp_profile.json'),'--network','none','--memory','1536m','--cpus','2',
           '--tmpfs','/tmp:rw,size=256m,mode=1777','--shm-size=256m','recruitment-m0-pdf-run:20261015')
    for _ in range(90):
        probe=subprocess.run([*D,'exec',PREFIX+'-pdf','test','-f','/out/pdf-generation-result.json'],capture_output=True)
        if probe.returncode==0:break
        time.sleep(1)
    else:
        print(docker('logs','--tail','12',PREFIX+'-pdf'));raise RuntimeError('PDF probe did not finish')
    docker('cp',PREFIX+'-pdf:/out/.',str(out))
    for name in ('auth-result.json','rls-result.json'):(out/name).write_text((ROOT/name).read_text())
    result['pdf_artifacts']=[]
    for p in sorted(out.glob('*.pdf')):
        reader=PdfReader(p);text=unicodedata.normalize('NFKC',''.join(page.extract_text() for page in reader.pages))
        assert len(reader.pages)==1 and '請求書' in text and '実際の請求には使用できません' in text and '500,000' in text
        result['pdf_artifacts'].append({'file':p.name,'pages':len(reader.pages),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
    assert len(result['pdf_artifacts'])==3
    result['components']={name:json.loads((out/file).read_text())['all_passed'] for name,file in (
      ('authentication','auth-result.json'),('rls','rls-result.json'),('pdf_validation','pdf-validation-result.json'),('pdf_generation','pdf-generation-result.json'))}
    result['all_passed']=all(result['components'].values());assert result['all_passed']
    result['server']=docker('version','--format','{{.Server.Version}} {{.Server.Arch}}')
    print(json.dumps(result))
finally:
    result['elapsed_seconds']=round(time.time()-start,3)
    (out/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
    # Stop this run's services only. Retain all files, containers and volumes.
    existing=set(docker('ps','-a','--format','{{.Names}}').splitlines())
    names=[PREFIX+'-'+suffix for suffix in ('auth','pdf','idp','db') if PREFIX+'-'+suffix in existing]
    if names:subprocess.run([*D,'stop',*names],check=False,capture_output=True)
