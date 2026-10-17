#!/usr/bin/env python3
"""Fail closed when selecting JSON/PNG for CI upload; retain unsafe originals privately."""
import argparse,hashlib,json,re
from pathlib import Path
def export(root,out,selected=None):
    out.mkdir(parents=True,exist_ok=False)
    copied={};withheld=0;run_count=0;coverage=[]
    headers={'cookie','set-cookie','authorization','x-csrf-token','x-upload-ticket','x-scan-key','x-viewer-key','x-document-key'}
    def strings(value):
        if isinstance(value,str):return [value]
        if isinstance(value,dict):return [s for v in value.values() for s in strings(v)]
        if isinstance(value,list):return [s for v in value for s in strings(v)]
        return []
    def sensitive_keys(value):
        if isinstance(value,dict):return any(str(k).lower() in headers or sensitive_keys(v) for k,v in value.items())
        if isinstance(value,list):return any(sensitive_keys(v) for v in value)
        return False
    for run in ([selected] if selected else sorted(root.glob('e2e-*/artifacts/run.json'))):
        run_count+=1
        metadata=json.loads(run.read_text())
        fixture=run.parent.parent
        values=[]
        required=['demo-accounts.json','local.env','upload-private.pem','artifact-private.pem','broker-auth','scan-auth','viewer-auth']
        complete=all((fixture/name).is_file() and not (fixture/name).is_symlink() for name in required)
        coverage.append({'instance':fixture.name,'required_fixture_complete':complete})
        if not complete:
            withheld+=1
            # Do not upload unscanned diagnostics after incomplete setup.
            continue
        accounts=fixture/'demo-accounts.json'
        if accounts.exists():values += [v.encode() for v in json.loads(accounts.read_text()).values()]
        env=fixture/'local.env'
        if env.exists():values += [x.partition('=')[2].encode() for x in env.read_text().splitlines() if '=' in x and len(x.partition('=')[2])>=24 and not (x.partition('=')[0]=='COMPOSE_PROJECT_NAME' and x.partition('=')[2]=='recruitment-'+metadata.get('instance','') and re.fullmatch(r'e2e-[a-z0-9-]+',metadata.get('instance','')))]
        for name in ('upload-private.pem','artifact-private.pem','broker-auth','scan-auth','viewer-auth'):
            if (fixture/name).exists():values.append((fixture/name).read_bytes())
        files=list(run.parent.glob('*.json'))+list(run.parent.glob('*.png'))+list((run.parent/'audit').glob('*.json'))
        for p in sorted(files):
            if p.is_symlink():withheld+=1;continue
            raw=p.read_bytes();inspected=raw
            if p.suffix=='.json':
                try:
                    parsed=json.loads(raw)
                    if sensitive_keys(parsed):withheld+=1;continue
                    inspected=json.dumps(parsed,ensure_ascii=False).encode()+b'\n'+b'\n'.join(s.encode() for s in strings(parsed))
                except (ValueError,UnicodeError):withheld+=1;continue
            forbidden=rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|rp_session=|rp_attempt=|eyJ[A-Za-z0-9_-]+\.eyJ|[?&](?:access_token|id_token|code)=|(?<![A-Za-z0-9_-])(?:cookie|set-cookie|authorization|x-csrf-token|x-upload-ticket|x-scan-key|x-viewer-key|x-document-key)[\"\']?\s*:\s*(?!\[redacted\])'
            if any(v and (v in raw or v in inspected) for v in values) or p.suffix=='.json' and re.search(forbidden,inspected,re.I):
                withheld+=1;continue
            rel=Path(fixture.name)/p.relative_to(run.parent);dest=out/rel;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(raw);copied[str(rel)]=hashlib.sha256(raw).hexdigest()
    result={'status':'failed' if withheld or not run_count else 'passed','fixture_coverage':coverage,'copied_files':len(copied),'withheld_files':withheld,'sha256':copied,'scope':'Allowlisted JSON/PNG, known fixture secret bytes and authentication patterns; unsafe originals remain private. No OCR or image redistribution approval.'}
    (out/'export-status.json').write_text(json.dumps(result,indent=2)+'\n')
    return result
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=Path('.local'));p.add_argument('--out',type=Path,required=True);p.add_argument('--run',type=Path);a=p.parse_args()
    r=export(a.root,a.out,a.run);print(json.dumps({k:r[k] for k in ('status','copied_files','withheld_files')}));raise SystemExit(1 if r['status']=='failed' else 0)
