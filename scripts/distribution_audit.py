#!/usr/bin/env python3
"""Inspect the exact Git source archive and allowlisted E2E evidence, never publish secrets.

This checks source distribution only, not approval to redistribute custom images.
Reports contain counts/hashes/error codes, never matched contents.
"""
import argparse, hashlib, io, json, re, subprocess, tarfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def main():
    p=argparse.ArgumentParser();p.add_argument('--run',type=Path,required=True);a=p.parse_args()
    run=json.loads(a.run.read_text());assert run['services_stopped'] and not run['source_dirty'] and run['source_unchanged_during_run']
    for name,digest in run['source_sha256'].items():
        assert hashlib.sha256((ROOT/name).read_bytes()).hexdigest()==digest,'SOURCE_MISMATCH'
        assert hashlib.sha256(subprocess.check_output(['git','show',run['source_commit']+':'+name],cwd=ROOT)).hexdigest()==digest,'COMMIT_MISMATCH'
    fixture=a.run.parent.parent
    values=[]
    accounts=fixture/'demo-accounts.json'
    if accounts.exists():values += [v.encode() for v in json.loads(accounts.read_text()).values()]
    env=fixture/'local.env'
    if env.exists():values += [line.partition('=')[2].encode() for line in env.read_text().splitlines() if '=' in line and len(line.partition('=')[2])>=24 and not (line.partition('=')[0]=='COMPOSE_PROJECT_NAME' and line.partition('=')[2]=='recruitment-'+run['instance'])]
    for name in ('broker-auth','scan-auth','viewer-auth','upload-private.pem','artifact-private.pem'):
        if (fixture/name).exists():values.append((fixture/name).read_bytes())
    pattern=rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{30,}|rp_session=|rp_attempt=|eyJ[A-Za-z0-9_-]+\.eyJ|[?&](?:access_token|id_token|code)='
    # Source contains scanner patterns and synthetic negative fixtures. Detect actual
    # token forms, not a security tool's literal pattern or the cookie name in code.
    source_pattern=rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}'
    archive=subprocess.check_output(['git','archive','--format=tar',run['source_commit']],cwd=ROOT)
    errors=[];files={};total=0
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        for member in tar:
            if member.isdir():continue
            name=Path(member.name);parts=name.parts
            if not member.isfile() or name.is_absolute() or '..' in parts or any(s in parts for s in ('.local','.git','node_modules','target','playwright-output')) or name.suffix in ('.pem','.key','.env'):
                errors.append('SOURCE_PATH_OR_TYPE');continue
            raw=tar.extractfile(member).read();total+=len(raw);files[str(name)]=hashlib.sha256(raw).hexdigest()
            if any(v and v in raw for v in values) or re.search(source_pattern,raw):errors.append('SOURCE_SECRET_MATCH')
    artifacts={}
    for f in sorted(a.run.parent.glob('*')):
        if not f.is_file() or f.name=='distribution.json':continue
        if f.suffix not in ('.json','.png'):errors.append('ARTIFACT_NOT_ALLOWLISTED');continue
        raw=f.read_bytes();artifacts[f.name]=hashlib.sha256(raw).hexdigest()
        if any(v and v in raw for v in values) or f.suffix=='.json' and re.search(pattern,raw):errors.append('ARTIFACT_SECRET_MATCH')
    report={'status':'failed' if errors else 'passed','source_commit':run['source_commit'],'source_archive_sha256':hashlib.sha256(archive).hexdigest(),'source_files':len(files),'source_bytes':total,'source_sha256':files,'artifact_sha256':artifacts,'known_fixture_secret_values_checked':len(values),'errors':sorted(set(errors)),'scope':'Git source tar and top-level JSON/PNG artifacts; known fixture secret bytes and token patterns. Not image redistribution approval, all-history scan, OCR, or vulnerability audit.'}
    (a.run.parent/'distribution.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({k:report[k] for k in ('status','source_commit','source_files','source_bytes','errors')}))
    return 1 if errors else 0
if __name__=='__main__':raise SystemExit(main())
