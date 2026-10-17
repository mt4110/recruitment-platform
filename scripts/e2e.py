#!/usr/bin/env python3
"""Run M1 through M6 / R1 through R6 browser E2E in a new local Compose project; retain all evidence/data."""
import argparse, hashlib, json, os, re, secrets, socket, subprocess, time, io, tarfile, ipaddress
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--app-port', type=int, default=3001)
parser.add_argument('--idp-port', type=int, default=18082)
parser.add_argument('--test-file',nargs='+',choices=['business.spec.cjs','workflow.spec.cjs','documents.spec.cjs','r1.spec.cjs','r2.spec.cjs','r3.spec.cjs','r4.spec.cjs','m5.spec.cjs','s1.spec.cjs','s2.spec.cjs','s3.spec.cjs','z-s4.spec.cjs','s5.spec.ts','r5.spec.ts','r6.spec.ts'],help='Selected regression files; full suite is the default. Record the actual scope with completion evidence.')
args = parser.parse_args()
if args.app_port == args.idp_port or any(p < 1024 or p > 65535 for p in (args.app_port, args.idp_port)):
    parser.error('Use two distinct ports, 1024..65535.')
for port in (args.app_port, args.idp_port):
    with socket.socket() as probe:
        try: probe.bind(('127.0.0.1', port))
        except OSError: raise SystemExit(f'Port {port} is occupied; existing services are left unchanged.')
instance = 'e2e-' + time.strftime('%Y%m%d-%H%M%S', time.gmtime()) + '-' + secrets.token_hex(3)
local = ROOT / '.local' / instance
local.mkdir(mode=0o700, parents=True)
os.umask(0o077)
artifacts = local / 'artifacts'; artifacts.mkdir()
env = dict(os.environ, RP_INSTANCE=instance, RP_APP_PORT=str(args.app_port), RP_IDP_PORT=str(args.idp_port), RP_E2E_DIR=str(local))
summary = {'scope': 'R6 cross-cutting validation, bounded load and distribution audit; stop before M7/publication', 'instance': instance, 'app_port': args.app_port, 'idp_port': args.idp_port, 'phase': 'setup', 'status': 'failed', 'test_selection':args.test_file or 'full'}
def source_hashes():
    tracked = ['scripts/local.py','scripts/document_job.py','scripts/document_key.py','scripts/document_migrate.py','scripts/document_snapshot.py','scripts/document_operator.py','scripts/document_crypto.cjs','scripts/e2e.py','scripts/check.py','scripts/audit.py','scripts/distribution_audit.py','infra/local/pdf-seccomp.json','infra/local/compose.yaml','infra/local/nginx.conf','infra/local/db-init.sh',
               'services/api/Dockerfile','services/api/Cargo.toml','services/api/Cargo.lock','apps/web/Dockerfile','apps/web/package.json','apps/web/package-lock.json','apps/web/tsconfig.json','apps/web/next-env.d.ts','apps/web/.dockerignore','services/api/.dockerignore']
    tracked += [str(p.relative_to(ROOT)) for p in (ROOT/'e2e').iterdir() if p.is_file() and '__pycache__' not in p.parts]
    for folder in ['migrations','fixtures','services/api/src','apps/web/app','apps/web/public','services/pdf-renderer','services/av','services/document-worker','services/postgres','e2e/fixtures','validation/r0/fixtures']:
        tracked += [str(p.relative_to(ROOT)) for p in (ROOT/folder).rglob('*') if p.is_file() and '__pycache__' not in p.parts]
    return {name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in sorted(set(tracked))}
# Allocate only new test networks; retained previous environments are never pruned.
network_ids=subprocess.check_output(['docker','network','ls','-q'],env=env,text=True).split()
networks=json.loads(subprocess.check_output(['docker','network','inspect',*network_ids],env=env,text=True))
occupied=[ipaddress.ip_network(c['Subnet']) for n in networks for c in (n.get('IPAM',{}).get('Config') or []) if ':' not in c.get('Subnet','') and c.get('Subnet')]
subnets=[]
for candidate in ipaddress.ip_network('10.253.0.0/16').subnets(new_prefix=27):
    if not any(candidate.overlaps(n) for n in occupied):subnets.append(str(candidate))
    if len(subnets)==5:break
if len(subnets)!=5:raise SystemExit('No free isolated test subnet; retained resources left unchanged.')
(local/'e2e-networks.json').write_text(json.dumps({'networks':{'default':{'ipam':{'config':[{'subnet':subnets[0]}]}},'pdf':{'internal':True,'ipam':{'config':[{'subnet':subnets[1]}]}},'scan':{'internal':True,'ipam':{'config':[{'subnet':subnets[2]}]}},'document-control':{'internal':True,'ipam':{'config':[{'subnet':subnets[4]}]}},'av-egress':{'ipam':{'config':[{'subnet':subnets[3]}]}}}}))
summary['test_subnets']=subnets
summary['source_sha256'] = source_hashes()
start = time.monotonic()
code = 1
try:
    with (local/'operations.log').open('w') as log:
        subprocess.run(['python3', 'scripts/local.py', 'setup'], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
        summary['phase'] = 'build/start'
        subprocess.run(['python3', 'scripts/local.py', 'up'], cwd=ROOT, env=dict(env,RP_TEST_MIGRATIONS_THROUGH='0005_snapshot_validation'), stdout=log, stderr=subprocess.STDOUT, check=True)
        subprocess.run(['python3','e2e/legacy_migration.py','before'],cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
        subprocess.run(['python3','scripts/local.py','migrate'],cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
        subprocess.run(['python3','e2e/legacy_migration.py','after'],cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
        subprocess.run(['python3','scripts/local.py','compose','restart','api'],cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
        subprocess.run(['python3','scripts/local.py','compose','up','-d','--no-build','--wait','--wait-timeout','60','api'],cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
    # Actual updater/network/signature verification and clamd load must finish before tests.
    deadline=time.monotonic()+300
    while True:
        probe=subprocess.run(['python3','scripts/local.py','compose','exec','-T','api','sh','-c','curl --fail --silent -H "X-Scan-Key: $SCAN_SHARED_KEY" http://scan:8080/internal/scan/state >/dev/null'],cwd=ROOT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        if probe.returncode==0:break
        if time.monotonic()>deadline:raise RuntimeError('Real AV did not become ready; inspect retained updater/scan services.')
        time.sleep(2)
    subprocess.run(['python3','e2e/av_isolation.py'],cwd=ROOT,env=env,check=True)
    bounded=subprocess.run(['python3','scripts/local.py','compose','exec','-T','pdf-renderer','python','-c',(ROOT/'e2e/check_xlsx.py').read_text(),*( (ROOT/f).read_bytes().hex() for f in ['e2e/fixtures/sheets-resume.xlsx','e2e/fixtures/sheets-career-history.xlsx','validation/r0/fixtures/sheets-resume.xlsx'])],cwd=ROOT,env=env,capture_output=True,text=True,check=True)
    (artifacts/'xlsx-policy.json').write_text(bounded.stdout)
    fixture_hex=(ROOT/'apps/web/public/sample-resume.pdf').read_bytes().hex()
    subprocess.run(['python3','scripts/local.py','compose','exec','-T','pdf-renderer','python','-c',(ROOT/'e2e/make_pdf_fixtures.py').read_text(),fixture_hex],cwd=ROOT,env=env,text=True,check=True,stdout=subprocess.DEVNULL)
    fixture_archive=subprocess.check_output(['python3','scripts/local.py','compose','exec','-T','pdf-renderer','python','-c',"import tarfile,sys; t=tarfile.open(fileobj=sys.stdout.buffer,mode='w|gz'); t.add('/tmp/m3-fixtures',arcname='fixtures'); t.close()"],cwd=ROOT,env=env)
    (local/'pdf-fixtures').mkdir()
    with tarfile.open(fileobj=io.BytesIO(fixture_archive),mode='r:gz') as archive:
        for entry in archive:
            if entry.isdir():continue
            name=Path(entry.name).name
            if not entry.isfile() or not re.fullmatch(r'(?:[a-z-]+\.pdf|manifest\.json)',name) or entry.size>12*1024*1024:raise RuntimeError('Invalid fixture archive')
            with (local/'pdf-fixtures'/name).open('xb') as output:output.write(archive.extractfile(entry).read())
    if not args.test_file or any(f in args.test_file for f in ['s2.spec.cjs','s3.spec.cjs','z-s4.spec.cjs','s5.spec.ts']):
        with (local/'operations.log').open('a') as log:subprocess.run(['python3','scripts/local.py','compose','build','document-broker','document-sandbox'],cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
    if not args.test_file or 's3.spec.cjs' in args.test_file:
        subprocess.run(['python3','scripts/local.py','compose','exec','-T','pdf-renderer','python','-c',(ROOT/'e2e/make_safe_view_fixtures.py').read_text(),(ROOT/'e2e/fixtures/sheets-resume.xlsx').read_bytes().hex()],cwd=ROOT,env=env,text=True,check=True,stdout=subprocess.DEVNULL)
        raw=subprocess.check_output(['python3','scripts/local.py','compose','exec','-T','pdf-renderer','python','-c',"import tarfile,sys; t=tarfile.open(fileobj=sys.stdout.buffer,mode='w|gz'); t.add('/tmp/s3-fixtures',arcname='fixtures'); t.close()"],cwd=ROOT,env=env)
        (local/'view-fixtures').mkdir()
        with tarfile.open(fileobj=io.BytesIO(raw),mode='r:gz') as archive:
            for entry in archive:
                if entry.isdir():continue
                name=Path(entry.name).name
                if not entry.isfile() or not re.fullmatch(r'[a-z0-9-]+\.(pdf|xlsx|json)',name) or entry.size>12*1024*1024:raise RuntimeError('Invalid safe view fixture')
                with (local/'view-fixtures'/name).open('xb') as out:out.write(archive.extractfile(entry).read())
    summary['phase'] = 'browser'
    # Only this newly created project may be controlled by test DB helpers.
    (local/'test-instance.json').write_text(json.dumps({'instance': instance, 'test_only': True}))
    result = subprocess.run(['npm','test','--prefix','e2e',*(['--',*args.test_file] if args.test_file else [])], cwd=ROOT, env=env)
    code = result.returncode
    summary['status'] = 'passed' if code == 0 else 'failed'
    summary['phase'] = 'complete'
    summary['source_commit'] = subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
    summary['source_dirty'] = bool(subprocess.check_output(['git','status','--porcelain'],cwd=ROOT,text=True).strip())
    final_hashes = source_hashes()
    summary['source_unchanged_during_run'] = final_hashes == summary['source_sha256']
    if not summary['source_unchanged_during_run']: code = 1; summary['status'] = 'failed'
    summary['docker'] = subprocess.check_output(['docker','info','--format','{{.ServerVersion}} / {{.Architecture}}'],env=env,text=True).strip()
    values = list(json.loads((local/'demo-accounts.json').read_text()).values())
    values += [s.split('=',1)[1] for s in (local/'local.env').read_text().splitlines() if '=' in s and len(s.split('=',1)[1])>=30]
    summary['av_runtime']={}
    for service in ('scan','updater','pdf-renderer'):
        name=f'recruitment-{instance}-{service}-1'
        state=json.loads(subprocess.check_output(['docker','inspect','--format','{{json .State}}',name],env=env,text=True))
        peak=int(subprocess.check_output(['docker','exec',name,'cat','/sys/fs/cgroup/memory.peak'],env=env,text=True))
        summary['av_runtime'][service]={'running':state['Running'],'oom_killed':state['OOMKilled'],'memory_peak_bytes':peak}
        if not state['Running'] or state['OOMKilled']:code=1;summary['status']='failed'
    summary['resource_runtime']={}
    for service in ('gateway','web','api','db','idp','idp-db','pdf-renderer','invoice-renderer','artifact-viewer','scan','updater'):
        name=f'recruitment-{instance}-{service}-1'
        meta=json.loads(subprocess.check_output(['docker','inspect',name],env=env,text=True))[0]
        observed={k:int(subprocess.check_output(['docker','exec',name,'cat','/sys/fs/cgroup/'+k],env=env,text=True)) for k in ('memory.peak','memory.max','pids.max')}
        cpu=subprocess.check_output(['docker','exec',name,'cat','/sys/fs/cgroup/cpu.max'],env=env,text=True).strip()
        summary['resource_runtime'][service]={'image_id':meta['Image'],'running':meta['State']['Running'],'oom_killed':meta['State']['OOMKilled'],'memory_peak_bytes':observed['memory.peak'],'memory_limit_bytes':observed['memory.max'],'pids_limit':observed['pids.max'],'cpu_max':cpu}
        if not meta['State']['Running'] or meta['State']['OOMKilled'] or observed['memory.max']<=0 or observed['pids.max']<=0:code=1;summary['status']='failed'
    summary['worker_images']={}
    if not args.test_file or any(f in args.test_file for f in ['s2.spec.cjs','s3.spec.cjs','z-s4.spec.cjs','s5.spec.ts']):
        for role in ('document-broker','document-relay','document-sandbox'):
            tag=f'recruitment-{instance}-'+('document-broker' if role=='document-relay' else role)
            image=json.loads(subprocess.check_output(['docker','image','inspect',tag],env=env,text=True))[0]
            summary['worker_images'][role]={'image_id':image['Id'],'architecture':image['Architecture'],'tag':tag}
    summary['log_scan'] = {}
    for service in ('gateway','web','api','db','idp','idp-db','pdf-renderer','invoice-renderer','artifact-viewer','scan','updater'):
        raw = subprocess.check_output(['docker','logs',f'recruitment-{instance}-{service}-1'],env=env,stderr=subprocess.STDOUT)
        found = any(v.encode() in raw for v in values) or bool(re.search(rb'(?:[?&]code=|access_token=|id_token=|rp_session=|rp_attempt=|eyJ[A-Za-z0-9_-]+\.eyJ)',raw))
        summary['log_scan'][service] = {'secret_pattern_found':found}
        if found: code = 1; summary['status'] = 'failed'

except Exception as exc:
    summary['failure_type']=type(exc).__name__
    code = 1
    summary['status'] = 'failed'
    print('E2E setup or verification failed; inspect the retained evidence/private operations.log. No existing demo services were changed.')
finally:
    # Persist only fixed, structured startup phases. No raw errors, headers, env or tokens.
    startup=subprocess.run(['docker','logs',f'recruitment-{instance}-api-1'],env=env,capture_output=True)
    phases=[]
    for line in startup.stdout.splitlines()+startup.stderr.splitlines():
        try:fields=json.loads(line).get('fields',{})
        except (ValueError,AttributeError):continue
        if fields.get('event') in ('startup_phase','startup_io_failed','startup_failed'):
            phases.append({k:fields[k] for k in ('event','phase','io_kind') if k in fields})
    (artifacts/'startup.json').write_text(json.dumps({'api':phases},indent=2)+'\n')
    # Stop only this run's services, even after failure. Never delete containers,
    # volumes, configurations, previous test output, or the interactive demo.
    with (local/'operations.log').open('a') as log:
        stopped = subprocess.run(['python3','scripts/local.py','stop'], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
    summary['services_stopped'] = stopped.returncode == 0
    if stopped.returncode != 0: code = 1; summary['status'] = 'failed'
    summary['elapsed_seconds'] = round(time.monotonic() - start, 3)
    (artifacts/'run.json').write_text(json.dumps(summary, indent=2)+'\n')
    print(f"Browser regression E2E: {summary['status']}; evidence: .local/{instance}/artifacts")
raise SystemExit(code)
