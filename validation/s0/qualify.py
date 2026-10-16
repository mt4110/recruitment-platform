"""Audit exact S0 image; keep every finding and distinguish candidate paths."""
import argparse,datetime,json,os,subprocess
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--run',required=True);p.add_argument('--trivy',required=True);a=p.parse_args()
out=Path(a.run);run=json.loads((out/'summary.json').read_text());image=run['image_id'];raw=out/'private/image-audit.json'
env=os.environ.copy()
if not env.get('DOCKER_HOST'):
    env['DOCKER_HOST']=subprocess.check_output(['docker','context','inspect','--format','{{.Endpoints.docker.Host}}'],text=True).strip()
subprocess.run([a.trivy,'image','--disable-telemetry','--scanners','vuln,license','--list-all-pkgs','--format','json','--output',str(raw),'--timeout','10m',image],env=env,check=True)
data=json.loads(raw.read_text());findings=[];selected=[]
for section in data.get('Results',[]):
    findings.extend({k:v.get(k) for k in ('PkgName','VulnerabilityID','Severity','FixedVersion','InstalledVersion','PrimaryURL')} for v in section.get('Vulnerabilities',[]))
    for item in section.get('Packages',[]):
        if any(t in item['Name'].lower() for t in ('poppler','pikepdf','pillow','packaging','expat','libqpdf','libpng','libjpeg','libtiff','openjp','freetype','fontconfig','liblcms','libnss','libnspr','libc6','libstdc++','libssl','node')):
            selected.append({k:item.get(k) for k in ('Name','Version','Licenses')})
native=['poppler','pikepdf','pillow','expat','libqpdf','libpng','libjpeg','libtiff','openjp','freetype','fontconfig','liblcms','libnss','libnspr','libc6','libstdc++','libssl','node']
reachable_high=[f for f in findings if f['Severity'] in ('HIGH','CRITICAL') and any(t in f['PkgName'].lower() for t in native)]
# Candidate path classification is explicit, not a full-image audit waiver.
db=json.loads(subprocess.check_output([a.trivy,'version','--format','json'],text=True));meta=db.get('VulnerabilityDB')
fresh=bool(meta) and datetime.datetime.fromisoformat(meta['NextUpdate'].replace('Z','+00:00'))>datetime.datetime.now(datetime.timezone.utc)
version=subprocess.check_output(['docker','run','--name',run['prefix']+'-dependency-path','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','128m','--cpus','.25','--pids-limit','32',image,'sh','-c','pdftoppm -v 2>&1; ldd /usr/bin/pdftoppm; ldd /usr/bin/pdftotext; node --version; python -c "import pikepdf,PIL,pyexpat;print(pikepdf.__version__,PIL.__version__,pyexpat.EXPAT_VERSION)"'],text=True)
(out/'dependency-path.txt').write_text(version)
result={'image_id':image,'scope':'S0 Poppler/pikepdf/Node candidate path only; not image release qualification','vulnerability_db_fresh':fresh,'scanner_database':meta,'all_findings':findings,'candidate_packages':selected,'candidate_high_critical':reachable_high,'unresolved_image_findings_remain':bool(findings),'license_notes':{'poppler':'GPL-2.0/GPL-3.0 components; subprocess prototype only, no published image. Distribution/source obligations remain M7.','pikepdf':'MPL-2.0','pillow':'HPND','node':'MIT plus bundled notices','chromium':'Chrome for Testing binary terms remain separate from Playwright Apache-2.0'},'classification_limit':'Name-based candidate set cross-checked with dependency-path.txt; not exhaustive exploitability proof. npm/python tooling and GStreamer findings remain in all_findings; not invoked by this PDF candidate.'}
result['candidate_gate_passed']=fresh and not reachable_high
(out/'qualification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'candidate_gate_passed':result['candidate_gate_passed'],'all_image_findings':len(findings),'candidate_high_critical':len(reachable_high)}));raise SystemExit(0 if result['candidate_gate_passed'] else 1)
