"""Export bounded job metadata only; never copy logs, configuration or exception text."""
import json, math, os, re
from pathlib import Path
CODES={'KEY_UNAVAILABLE','AUTHORITY_UNAVAILABLE','SCANNER_UNAVAILABLE','SANDBOX_UNAVAILABLE','RESPONSE_LIMIT','JOB_TIMEOUT','METADATA_REJECTED','CRYPTO_REJECTED','AV_BLOCKED','FORMAT_REJECTED','NETWORK_TIMEOUT','NETWORK_ABORTED','UNCLASSIFIED'}
PHASES={'claim','decrypt','ciphertext_fetch','av','validation_and_conversion','artifact_fetch','authority_claim','authority_authorize','authority_ciphertext','authority_artifact','authority_commit','authority_reject','authority_retry'}
TIMINGS={'ciphertext_fetch','decrypt','av','validation_and_conversion','artifact_encryption_and_storage'}
def number(n,maximum):return type(n) in (int,float) and math.isfinite(n) and 0<=n<=maximum
def collect(folder):
 records=sorted((folder/'jobs').glob('document-*/result.json'))
 if len(records)>512:raise ValueError('DIAGNOSTIC_LIMIT')
 rows=[]
 for p in records:
  if p.is_symlink() or p.stat().st_size>1048576 or not re.fullmatch(r'document-[a-f0-9]{16}',p.parent.name):raise ValueError('DIAGNOSTIC_INPUT')
  raw=json.loads(p.read_text());row={'job':p.parent.name}
  if raw.get('status') not in ('passed','refused','failed','timeout') or type(raw.get('stopped')) is not bool:raise ValueError('DIAGNOSTIC_STATUS')
  row.update(status=raw['status'],stopped=raw['stopped'])
  claim=raw.get('claimed')
  if claim is not None:
   if not isinstance(claim,dict) or not all(isinstance(claim.get(k),str) and re.fullmatch(r'[a-f0-9-]{36}',claim[k]) for k in ('document_id','generation')):raise ValueError('DIAGNOSTIC_CLAIM')
   row['claimed']={k:claim[k] for k in ('document_id','generation')}
  row['failures']=[]
  for f in raw.get('failures',[]):
   if f.get('code') not in CODES or f.get('phase') not in PHASES:raise ValueError('DIAGNOSTIC_FAILURE')
   row['failures'].append({k:f[k] for k in ('code','phase')})
  row['sandbox_failures']=[]
  for f in raw.get('sandbox_failures',[]):
   if f.get('phase') not in ('validation','conversion') or f.get('code') not in ('CHILD_EXIT','CHILD_TIMEOUT','CHILD_FAILURE') or type(f.get('exit_code')) is not int or not -128<=f['exit_code']<=255:raise ValueError('DIAGNOSTIC_CHILD')
   row['sandbox_failures'].append({k:f[k] for k in ('phase','code','exit_code')})
  if len(row['failures'])>8 or len(row['sandbox_failures'])>8:raise ValueError('DIAGNOSTIC_LIMIT')
  row['phase_milliseconds']={k:v for k,v in raw.get('phase_milliseconds',{}).items() if k in TIMINGS and number(v,120000)}
  if number(raw.get('elapsed_seconds'),180):row['elapsed_seconds']=raw['elapsed_seconds']
  row['containers']={}
  for role in ('broker','relay','sandbox'):
   c=raw.get('containers',{}).get(role,{})
   row['containers'][role]={k:v for k,v in c.items() if k in ('memory_limit','memory_peak_bytes') and (v is None or type(v) is int and 0<=v<=2147483648) or k=='oom_killed' and type(v) is bool}
  rows.append(row)
 return {'scope':'Allowlisted job IDs, claimed document/generation, fixed fault codes, phase timings and memory only. No logs, paths, headers, credentials or input bytes.','jobs':rows}
if __name__=='__main__':
 folder=Path(os.environ['RP_E2E_DIR'])
 if not (folder/'test-instance.json').is_file():raise SystemExit('ISOLATED_TEST_REQUIRED')
 (folder/'artifacts/document-job-outcomes.json').write_text(json.dumps(collect(folder),indent=2)+'\n')
