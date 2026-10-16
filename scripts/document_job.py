#!/usr/bin/env python3
"""Trusted host launcher: exactly one fresh broker/relay/sandbox job, no deletion.
The application containers never receive Docker/host management privileges.
"""
import argparse,fcntl,ipaddress,json,os,re,secrets,subprocess,time,hmac,hashlib,base64
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--no-build',action='store_true');p.add_argument('--probe',action='store_true');args=p.parse_args()
instance=os.environ.get('RP_INSTANCE','default')
if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}',instance):raise SystemExit('Invalid instance.')
local=ROOT/'.local' if instance=='default' else ROOT/'.local'/instance
if not (local/'worker-keys-initialized').is_file():raise SystemExit('Run local.py setup first; missing keys must be restored.')
if os.getuid()==0:raise SystemExit('Use a nonroot local operator account.')
if not all((local/name).is_file() for name in ['upload-private.pem','broker-auth','scan-auth']):raise SystemExit('Worker secret missing; restore original files. No replacement generated.')
os.umask(0o077)
lock=(local/'document-job.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
values=dict(line.split('=',1) for line in (local/'local.env').read_text().splitlines() if '=' in line)
project=values['COMPOSE_PROJECT_NAME'];job='document-'+secrets.token_hex(8)
folder=local/'jobs'/job;folder.mkdir(parents=True,mode=0o700)
base=['python3','scripts/local.py','compose']
with (folder/'operations.log').open('w') as log:
 if not args.no_build:subprocess.run([*base,'build','document-broker','document-sandbox'],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,check=True)
 ids=subprocess.check_output(['docker','network','ls','-q'],text=True).split()
 nets=json.loads(subprocess.check_output(['docker','network','inspect',*ids],text=True))
 occupied=[ipaddress.ip_network(c['Subnet']) for n in nets for c in (n.get('IPAM',{}).get('Config') or []) if c.get('Subnet') and ':' not in c['Subnet']]
 subnets=[]
 for n in ipaddress.ip_network('10.252.0.0/16').subnets(new_prefix=27):
  if not any(n.overlaps(x) for x in occupied):subnets.append(str(n))
  if len(subnets)==2:break
 if len(subnets)!=2:raise SystemExit('No isolated subnet; no resources removed.')
 common={'read_only':True,'cap_drop':['ALL'],'security_opt':['no-new-privileges:true'],'pids_limit':64,'init':True,'restart':'no','tmpfs':['/tmp:size=16m,mode=1777'],'cpus':1,'mem_limit':'512m'}
 node=project+'-document-broker';sandbox=project+'-document-sandbox'
 spec={'services':{
  'broker':{**common,'image':node,'user':f'{os.getuid()}:{os.getgid()}','networks':['control','scan','broker-relay'],'volumes':[f'{local}/broker-auth:/run/broker-auth:ro',f'{local}/scan-auth:/run/scan-auth:ro',f'{local}/upload-private.pem:/run/keys/original-v1.pem:ro',*([f'{p}:/run/keys/{p.name}:ro' for p in (local/'keyring').glob('original-v[0-9]*.pem') if '.public.' not in p.name])],'depends_on':{'relay':{'condition':'service_healthy'},'sandbox':{'condition':'service_healthy'}}},
  'relay':{**common,'image':node,'user':'1003:1003','command':['node','relay.cjs'],'networks':['broker-relay','sandbox-relay'],'healthcheck':{'test':['CMD','node','-e',"fetch('http://127.0.0.1:8080/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],'interval':'1s','timeout':'2s','retries':10}},
  'sandbox':{**common,'image':sandbox,'user':'1004:1004','command':['python','sandbox.py'],'networks':['sandbox-relay'],'mem_limit':'256m','tmpfs':['/tmp:size=64m,mode=1777'],'security_opt':['no-new-privileges:true','seccomp='+str(ROOT/'infra/local/pdf-seccomp.json')],'healthcheck':{'test':['CMD','python','-c',"import urllib.request;urllib.request.urlopen('http://127.0.0.1:8080/live',timeout=1)"],'interval':'1s','timeout':'2s','retries':10}}
 },'networks':{'control':{'external':True,'name':project+'_document-control'},'scan':{'external':True,'name':project+'_scan'},'broker-relay':{'internal':True,'ipam':{'config':[{'subnet':subnets[0]}]}},'sandbox-relay':{'internal':True,'ipam':{'config':[{'subnet':subnets[1]}]}}}}
 config=folder/'compose.json';config.write_text(json.dumps(spec,indent=2)+'\n')
 executable=['docker','compose'] if subprocess.run(['docker','compose','version'],capture_output=True).returncode==0 else ['docker-compose']
 compose=[*executable,'-p',job,'-f',str(config)]
 start=time.monotonic();outcome={'job':job,'status':'failed','stopped':False}
 try:
  subprocess.run([*compose,'up','-d','--wait','--wait-timeout','30','sandbox','relay'],stdout=log,stderr=subprocess.STDOUT,check=True,timeout=40)
  if args.probe:subprocess.run(['python3','e2e/s2_isolation.py',job],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=15)
  subprocess.run([*compose,'up','-d','--no-deps','broker'],stdout=log,stderr=subprocess.STDOUT,check=True,timeout=20)
  while time.monotonic()-start<120:
   state=json.loads(subprocess.check_output(['docker','inspect','--format','{{json .State}}',job+'-broker-1'],text=True))
   if not state['Running']:
    outcome['status']='passed' if state['ExitCode']==0 else 'refused';break
   time.sleep(.5)
  else:outcome['status']='timeout'
  raw=subprocess.check_output(['docker','logs',job+'-broker-1'],stderr=subprocess.STDOUT)
  events=[]
  for line in raw.splitlines():
   try:v=json.loads(line)
   except ValueError:continue
   if set(v)=={'event'} and v['event'] in ('checked','rejected','retryable','no_job'):events.append(v['event'])
  outcome['events']=events
  outcome['log_secret_pattern_found']=False
  secret_values=[(local/'scan-auth').read_bytes(),(local/'broker-auth').read_bytes(),base64.urlsafe_b64encode(hmac.new((local/'broker-auth').read_bytes(),b'document-worker-v1',hashlib.sha256).digest()).rstrip(b'=')]
  for role in ('broker','relay','sandbox'):
   logs=subprocess.check_output(['docker','logs',job+'-'+role+'-1'],stderr=subprocess.STDOUT)
   if any(v in logs for v in secret_values) or re.search(rb'-----BEGIN .*PRIVATE KEY-----|rp_session=|rp_attempt=|S2[\x80-\xff]',logs):outcome['log_secret_pattern_found']=True
  if outcome['log_secret_pattern_found']:outcome['status']='failed'
  outcome['containers']={}
  for role in ('broker','relay','sandbox'):
   item=json.loads(subprocess.check_output(['docker','inspect',job+'-'+role+'-1'],text=True))[0]
   outcome['containers'][role]={'user':item['Config']['User'],'read_only':item['HostConfig']['ReadonlyRootfs'],'cap_drop':item['HostConfig']['CapDrop'],'memory_limit':item['HostConfig']['Memory'],'pids_limit':item['HostConfig']['PidsLimit'],'networks':sorted(item['NetworkSettings']['Networks']),'mount_targets':[m['Destination'] for m in item['Mounts']]}
 finally:
  r=subprocess.run([*compose,'stop','--timeout','3'],stdout=log,stderr=subprocess.STDOUT,timeout=25)
  outcome['stopped']=r.returncode==0;outcome['elapsed_seconds']=round(time.monotonic()-start,3)
  (folder/'result.json').write_text(json.dumps(outcome,indent=2)+'\n')
 print(json.dumps({'status':outcome['status'],'events':outcome.get('events',[]),'stopped':outcome['stopped'],'record':str(folder/'result.json')}))
 raise SystemExit(0 if outcome['status']=='passed' and outcome['stopped'] else 1)
