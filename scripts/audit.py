#!/usr/bin/env python3
"""Inventory/scan exact isolated E2E images without publishing images or secrets.

Requires Trivy 0.76.0, cargo-audit 0.22.1 and installed npm locks. Raw scanner
reports stay in ignored .local; compact artifacts retain every finding, not
just fixable findings. Nonzero means audit findings or tool failure, not an
invitation to ignore a scanner. External publication remains a separate gate.
"""
import argparse, collections, datetime, hashlib, json, os, subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--run',type=Path,required=True);p.add_argument('--trivy',required=True);a=p.parse_args()
run=json.loads(a.run.read_text());assert run['services_stopped'] and run['test_selection']=='full'
out=a.run.parent/'audit';out.mkdir(exist_ok=True)
raw=ROOT/'.local'/('audit-'+run['instance']);raw.mkdir(exist_ok=True)
def invoke(args,path):
    with path.open('w') as f:r=subprocess.run(args,cwd=ROOT,stdout=f,check=False)
    if r.returncode not in (0,1):raise RuntimeError(f'Audit tool failed ({r.returncode}): {args[0]}')
    return json.loads(path.read_text())
version=subprocess.check_output([a.trivy,'--version'],text=True).splitlines()[0];assert version=='Version: 0.76.0',version
summary={'checked_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source_commit':run['source_commit'],'trivy':version,'images':{},'locks':{},'scope':'Known vulnerability and license inventory; not release approval','unknown_or_missing_license_packages':0}
services=['gateway','web','api','db','idp','idp-db','pdf-renderer','scan','updater']
seen={}
for service in services:
    container=f"recruitment-{run['instance']}-{service}-1"
    image=subprocess.check_output(['docker','inspect','--format','{{.Image}}',container],text=True).strip()
    if image in seen:
        summary['images'][service]={'image_id':image,'same_as':seen[image]};continue
    seen[image]=service
    subprocess.run([a.trivy,'image','--disable-telemetry','--scanners','vuln,license','--list-all-pkgs','--format','json','--output',str(raw/(service+'.json')),'--timeout','15m',image],check=True)
    r=json.loads((raw/(service+'.json')).read_text());findings=[];packages=[]
    for result in r.get('Results',[]):
        for v in result.get('Vulnerabilities',[]):
            findings.append({k:v.get(k) for k in ('VulnerabilityID','PkgName','PkgPath','InstalledVersion','FixedVersion','Severity','Status','PrimaryURL')})
        for package in result.get('Packages',[]):
            item={k:package.get(k) for k in ('Name','Version','Licenses','FilePath')};packages.append(item)
            if not item['Licenses'] or any(x in ('UNKNOWN','NOASSERTION') for x in item['Licenses']):summary['unknown_or_missing_license_packages']+=1
    evidence={'image_id':image,'os':r.get('Metadata',{}).get('OS'),'packages':packages,'findings':findings,'raw_sha256':hashlib.sha256((raw/(service+'.json')).read_bytes()).hexdigest()}
    (out/(service+'.json')).write_text(json.dumps(evidence,indent=2)+'\n')
    summary['images'][service]={'image_id':image,'packages':len(packages),'findings':dict(collections.Counter(v['Severity'] for v in findings)),'fixable_high_critical':sum(v['Severity'] in ('HIGH','CRITICAL') and bool(v['FixedVersion']) for v in findings)}
for name,folder in [('web','apps/web'),('e2e','e2e'),('pdf','services/pdf-renderer')]:
    r=invoke(['npm','audit','--prefix',folder,'--package-lock-only','--json'],raw/(name+'-npm.json'))
    if 'error' in r:raise RuntimeError('npm audit failed')
    summary['locks'][name]=r['metadata']['vulnerabilities']
    (out/(name+'-npm.json')).write_text(json.dumps(r,indent=2)+'\n')
r=invoke(['cargo','audit','--json','--file','services/api/Cargo.lock'],raw/'cargo.json')
if not r.get('database') or 'vulnerabilities' not in r:raise RuntimeError('RustSec unavailable')
(out/'cargo.json').write_text(json.dumps(r,indent=2)+'\n');summary['locks']['rustsec']={'count':r['vulnerabilities']['count'],'database':r['database']}
meta=json.loads(subprocess.check_output(['cargo','metadata','--locked','--format-version','1','--manifest-path','services/api/Cargo.toml'],text=True))
(out/'cargo-licenses.json').write_text(json.dumps([{'name':x['name'],'version':x['version'],'license':x['license'],'source':x['source']} for x in meta['packages']],indent=2)+'\n')
subprocess.run([a.trivy,'fs','--disable-telemetry','--scanners','secret','--skip-dirs','.local','--skip-dirs','node_modules','--skip-dirs','target','--skip-dirs','.git','--format','json','--output',str(raw/'secrets.json'),'.'],check=True)
secrets=json.loads((raw/'secrets.json').read_text())
summary['secret_findings']=sum(len(x.get('Secrets',[])) for x in secrets.get('Results',[]))
# Never copy secret matches into public artifacts.
summary['scanner_databases']=json.loads(subprocess.check_output([a.trivy,'version','--format','json'],text=True))
for key in ('VulnerabilityDB','JavaDB'):
    db=summary['scanner_databases'].get(key)
    if not db or datetime.datetime.fromisoformat(db['NextUpdate'].replace('Z','+00:00'))<=datetime.datetime.now(datetime.timezone.utc):
        raise RuntimeError('Missing or expired vulnerability database')
# Counts include unfixed and vendor-will-not-fix findings. No automatic exceptions.
summary['status']='findings' if summary['secret_findings'] or any(x.get('findings') for x in summary['images'].values()) or r['vulnerabilities']['found'] or any(x.get('total',0) for k,x in summary['locks'].items() if k!='rustsec') else 'passed'
(out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary,indent=2));raise SystemExit(1 if summary['status']=='findings' else 0)
