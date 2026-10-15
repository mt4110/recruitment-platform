#!/usr/bin/env python3
"""Run M1/M2/M3 browser E2E in a new local Compose project; retain all evidence/data."""
import argparse, hashlib, json, os, re, secrets, socket, subprocess, time, io, tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--app-port', type=int, default=3001)
parser.add_argument('--idp-port', type=int, default=18082)
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
summary = {'scope': 'M1 + M2 + M3; stop before M4', 'instance': instance, 'app_port': args.app_port, 'idp_port': args.idp_port, 'phase': 'setup', 'status': 'failed'}
def source_hashes():
    tracked = ['scripts/local.py','scripts/e2e.py','infra/local/compose.yaml','infra/local/nginx.conf','infra/local/db-init.sh',
               'services/api/Dockerfile','services/api/Cargo.toml','services/api/Cargo.lock','apps/web/Dockerfile','apps/web/package.json','apps/web/package-lock.json','apps/web/tsconfig.json','apps/web/next-env.d.ts','apps/web/.dockerignore','services/api/.dockerignore']
    tracked += [str(p.relative_to(ROOT)) for p in (ROOT/'e2e').iterdir() if p.is_file()]
    for folder in ['migrations','fixtures','services/api/src','apps/web/app','apps/web/public','services/pdf-renderer']:
        tracked += [str(p.relative_to(ROOT)) for p in (ROOT/folder).rglob('*') if p.is_file()]
    return {name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in sorted(set(tracked))}
summary['source_sha256'] = source_hashes()
start = time.monotonic()
code = 1
try:
    with (local/'operations.log').open('w') as log:
        subprocess.run(['python3', 'scripts/local.py', 'setup'], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
        summary['phase'] = 'build/start'
        subprocess.run(['python3', 'scripts/local.py', 'up'], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
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
    summary['phase'] = 'browser'
    # Only this newly created project may be controlled by test DB helpers.
    (local/'test-instance.json').write_text(json.dumps({'instance': instance, 'test_only': True}))
    result = subprocess.run(['npm','test','--prefix','e2e'], cwd=ROOT, env=env)
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
    summary['log_scan'] = {}
    for service in ('gateway','web','api','db','idp','idp-db','pdf-renderer'):
        raw = subprocess.check_output(['docker','logs',f'recruitment-{instance}-{service}-1'],env=env,stderr=subprocess.STDOUT)
        found = any(v.encode() in raw for v in values) or bool(re.search(rb'(?:[?&]code=|access_token=|id_token=|rp_session=|rp_attempt=|eyJ[A-Za-z0-9_-]+\.eyJ)',raw))
        summary['log_scan'][service] = {'secret_pattern_found':found}
        if found: code = 1; summary['status'] = 'failed'

except subprocess.CalledProcessError:
    print('E2E setup/build failed; inspect the private operations.log. No existing demo services were changed.')
finally:
    # Stop only this run's services, even after failure. Never delete containers,
    # volumes, configurations, previous test output, or the interactive demo.
    with (local/'operations.log').open('a') as log:
        stopped = subprocess.run(['python3','scripts/local.py','stop'], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
    summary['services_stopped'] = stopped.returncode == 0
    if stopped.returncode != 0: code = 1; summary['status'] = 'failed'
    summary['elapsed_seconds'] = round(time.monotonic() - start, 3)
    (artifacts/'run.json').write_text(json.dumps(summary, indent=2)+'\n')
    print(f"M1/M2/M3 E2E: {summary['status']}; evidence: .local/{instance}/artifacts")
raise SystemExit(code)
