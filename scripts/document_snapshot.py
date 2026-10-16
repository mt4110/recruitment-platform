#!/usr/bin/env python3
"""Bounded encrypted cold snapshots for this local prototype; restore only to a new instance.
No overwrite, cleanup, key replacement, live cloud backup or arbitrary archive extraction.
"""
import argparse,json,os,re,secrets,uuid
from pathlib import Path,PurePosixPath
from document_operator import ROOT,instance,values,run,compose,sql,quote,digest,lock,write_new,crypto,volume_helper,LIST,READ,WRITE
IMAGES=['db','idp-db','api','web','pdf-renderer','invoice-renderer','artifact-viewer','scan','updater','document-broker','document-sandbox']
MAX_TOTAL=1610612736
CONFIG={'local.env','realm.json','demo-accounts.json','upload-private.pem','upload-public.pem','broker-auth','broker-api-auth','scan-auth','artifact-private.pem','artifact-public.pem','viewer-auth','viewer-api-auth','worker-keys-initialized','viewer-keys-initialized'}
def valid_config(p):return p in CONFIG or bool(re.fullmatch(r'(?:keyring/(?:original|artifact)-v[1-9][0-9]{0,3}(?:\.public)?\.pem|viewer-keys/artifact-v[1-9][0-9]{0,3}\.pem)',p))
def valid_volume(role,p):
 if role=='resumes':return bool(re.fullmatch(r'(?:[a-f0-9-]{36}\.(?:pdf|xlsx|part|json)|encrypted/receiver\.lock|encrypted/[a-f0-9-]{36}\.(?:cipher|manifest|manifest-tmp)|encrypted/artifacts/[a-f0-9-]{36}\.cipher)',p))
 return role=='signatures' and bool(re.fullmatch(r'[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*',p)) and '..' not in PurePosixPath(p).parts

def load_backup(folder,require_complete=True):
 folder=Path(folder).resolve()
 # Backup key is separate from the transportable ciphertext directory.
 if not re.fullmatch(r'[a-f0-9-]{36}',folder.name) or (require_complete and not (folder/'COMPLETE').is_file()):raise ValueError('Complete snapshot required')
 key=folder.parent.parent/'backup-keys'/(folder.name+'.key')
 if key.stat().st_mode&0o077:raise ValueError('Backup key must be owner-only')
 def open_entry(name):
  if name!='manifest' and not re.fullmatch(r'[0-9]{6}',name):raise ValueError('Invalid entry')
  p=folder/(name+'.enc')
  if p.is_symlink() or p.stat().st_size>536870912:raise ValueError('Entry limit')
  return crypto('open',key,json.dumps(['rp-backup-v1',folder.name,name],separators=(',',':')),p.read_bytes())
 m=json.loads(open_entry('manifest'))
 if m.get('schema')!=1 or m.get('backup_id')!=folder.name or len(m['entries'])>20000:raise ValueError('Invalid manifest')
 seen=set();total=0
 for e in m['entries']:
  pair=(e['role'],e['path'])
  if pair in seen:raise ValueError('Duplicate entry')
  seen.add(pair)
  if e['role']=='config':okay=valid_config(e['path'])
  elif e['role']=='database':okay=e['path'] in ('recruitment','keycloak')
  else:okay=valid_volume(*pair)
  if not okay or e['size']<0 or e['size']>536870884:raise ValueError('Unexpected entry')
  total+=e['size']
  if total>MAX_TOTAL:raise ValueError('Snapshot limit')
 if not {('database','recruitment'),('database','keycloak')}<=seen or not {('config',p) for p in CONFIG}<=seen:raise ValueError('Incomplete snapshot')
 return m,open_entry

def inspect_backup(folder,require_complete=True):
 m,read=load_backup(folder,require_complete)
 for e in m['entries']:
  b=read(e['entry'])
  if len(b)!=e['size'] or digest(b)!=e['sha256']:raise ValueError('Snapshot hash mismatch')
 return m

def backup():
 name,local=instance();held=lock(local);project=values(local)['COMPOSE_PROJECT_NAME'];bid=str(uuid.uuid4());folder=local/'backups'/bid;folder.mkdir(parents=True,mode=0o700)
 key=local/'backup-keys'/(bid+'.key');write_new(key,secrets.token_bytes(32));entries=[];total=0;helper=None
 # Stop writers and parsers. Database servers remain running only for consistent logical dumps.
 stopped=['gateway','web','api','idp','pdf-renderer','invoice-renderer','artifact-viewer','scan','updater']
 compose('stop',*stopped)
 try:
  if sql("SELECT (SELECT count(*) FROM encrypted_document_jobs WHERE state='processing' AND lease_expires_at>now())+(SELECT count(*) FROM document_migrations WHERE state='reserved');")!='0':raise ValueError('Drain the current document lease first')
  inventory=json.loads(sql("SELECT coalesce(json_agg(x),'[]') FROM (SELECT id AS document_id,storage_key,sha256,size_bytes FROM documents WHERE NOT encrypted_transport ORDER BY id) x;"))
  def add(role,path,b,mode=0o600):
   nonlocal total
   total+=len(b)
   if total>MAX_TOTAL or len(b)>536870884:raise ValueError('Snapshot limit exceeded')
   entry=f'{len(entries):06d}';write_new(folder/(entry+'.enc'),crypto('seal',key,json.dumps(['rp-backup-v1',bid,entry],separators=(',',':')),b))
   entries.append({'entry':entry,'role':role,'path':path,'size':len(b),'sha256':digest(b),'mode':mode})
  add('database','recruitment',compose('exec','-T','db','pg_dump','-U','postgres','-d','recruitment','--format=plain'))
  add('database','keycloak',compose('exec','-T','idp-db','pg_dump','-U','keycloak','-d','keycloak','--format=plain'))
  files=[local/p for p in sorted(CONFIG)]
  for sub in ['keyring','viewer-keys']:
   if (local/sub).is_dir():files.extend(sorted((local/sub).iterdir()))
  for p in files:
   rel=p.relative_to(local).as_posix()
   if not valid_config(rel) or p.is_symlink() or not p.is_file() or p.stat().st_size>1048576:raise ValueError('Invalid private configuration')
   add('config',rel,p.read_bytes(),p.stat().st_mode&0o777)
  for role in ['resumes','signatures']:
   helper=volume_helper(project,'backup',[(project+'_'+role,'/'+role)],uid=1000 if role=='signatures' else 1001)
   listed=json.loads(run(['docker','exec',helper,'node','-e',LIST,'/'+role]))
   for f in listed:
    if not valid_volume(role,f['path']) or f['size']>536870884:raise ValueError('Unexpected volume file; inventory before backup')
    add(role,f['path'],run(['docker','exec',helper,'node','-e',READ,'/'+role+'/'+f['path']]))
   run(['docker','stop','--time','1',helper]);helper=None
  blobs={e['path']:e for e in entries if e['role']=='resumes'}
  for item in inventory:
   entry=blobs.get(item['storage_key']);item['source_verified']=bool(entry and entry['sha256']==item['sha256'] and entry['size']==item['size_bytes'])
  manifest={'schema':1,'backup_id':bid,'source_instance':name,'source_project':project,'source_commit':run(['git','rev-parse','HEAD']).decode().strip(),'inventory':inventory,'entries':entries,'image_ids':{svc:run(['docker','image','inspect',project+'-'+svc,'--format','{{.Id}}']).decode().strip() for svc in IMAGES}}
  write_new(folder/'manifest.enc',crypto('seal',key,json.dumps(['rp-backup-v1',bid,'manifest'],separators=(',',':')),json.dumps(manifest).encode()))
  inspect_backup(folder,False)
  write_new(folder/'COMPLETE',b'rp-backup-v1\n')
 finally:
  if helper:run(['docker','stop','--time','1',helper])
  compose('up','-d','--no-build','--wait','--wait-timeout','180',*stopped)
 print(json.dumps({'status':'verified','backup':str(folder),'entries':len(entries),'plaintext_bytes':total,'keys_stored_separately':True}))

def restore(folder,target):
 # All bytes authenticated before any new configuration, SQL or blob is used.
 m=inspect_backup(folder);m,read=load_backup(folder)
 source,source_local=instance();held=lock(source_local)
 if m['source_instance']!=source:raise ValueError('Select the snapshot source instance')
 if not re.fullmatch(r'e2e-[a-z0-9-]{1,60}',target) or target==source:raise ValueError('A fresh isolated e2e- target is required')
 local=ROOT/'.local'/target
 if local.exists():raise ValueError('Restore target already exists; no overwrite or deletion')
 project='recruitment-'+target
 if run(['docker','ps','-aq','--filter','label=com.docker.compose.project='+project]).strip():raise ValueError('Target containers already exist')
 for kind,prefix in [('volume',project+'_'),('network',project+'_'),('image',project+'-')]:
  listing=run(['docker',kind,'ls','--format','{{.Repository}}' if kind=='image' else '{{.Name}}']).decode().splitlines()
  if any(n.startswith(prefix) for n in listing):raise ValueError('Target resources already exist')
 for image in m['image_ids'].values():
  if not re.fullmatch(r'sha256:[a-f0-9]{64}',image):raise ValueError('Invalid image identity')
  run(['docker','image','inspect',image,'--format','{{.Id}}'])
 # Same loopback ports and issuer, with the source stopped; avoid changing identity bindings.
 compose('stop')
 local.mkdir(mode=0o700);byrole={}
 for e in m['entries']:byrole.setdefault(e['role'],[]).append(e)
 for e in byrole['config']:
  raw=read(e['entry'])
  if e['path']=='local.env':
   v=dict(line.split('=',1) for line in raw.decode().splitlines() if '=' in line);v.update(COMPOSE_PROJECT_NAME='recruitment-'+target,LOCAL_CONFIG_DIR=str(local),LOCAL_UID=str(os.getuid()),LOCAL_GID=str(os.getgid()));raw=''.join(k+'='+v+'\n' for k,v in v.items()).encode()
  write_new(local/e['path'],raw,e['mode'])
 write_new(local/'test-instance.json',json.dumps({'instance':target,'test_only':True}).encode())
 # Reuse the exact approved source images, never pull different versions during restore.
 project=m['source_project'];newproject='recruitment-'+target
 for svc in IMAGES:
  image=m['image_ids'][svc]
  if not re.fullmatch(r'sha256:[a-f0-9]{64}',image):raise ValueError('Invalid runtime image identity')
  run(['docker','tag',image,newproject+'-'+svc])
 # Allocate fresh networks without pruning retained environments.
 import ipaddress
 ids=run(['docker','network','ls','-q']).decode().split();nets=json.loads(run(['docker','network','inspect',*ids]));occupied=[ipaddress.ip_network(c['Subnet']) for n in nets for c in (n.get('IPAM',{}).get('Config') or []) if c.get('Subnet') and ':' not in c['Subnet']]
 subnets=[str(n) for n in ipaddress.ip_network('10.253.0.0/16').subnets(new_prefix=27) if not any(n.overlaps(o) for o in occupied)][:5]
 if len(subnets)!=5:raise ValueError('No unused test networks')
 write_new(local/'e2e-networks.json',json.dumps({'networks':{k:{'internal':k in ('pdf','scan','document-control'),'ipam':{'config':[{'subnet':n}]}} for k,n in zip(['default','pdf','scan','av-egress','document-control'],subnets)}}).encode())
 old=os.environ.get('RP_INSTANCE');os.environ['RP_INSTANCE']=target
 try:
  compose('up','-d','--no-build','--wait','--wait-timeout','120','db','idp-db')
  for e in byrole['database']:
   svc,user=('db','postgres') if e['path']=='recruitment' else ('idp-db','keycloak')
   compose('exec','-T',svc,'psql','-U',user,'-d',e['path'],'-v','ON_ERROR_STOP=1',input=read(e['entry']))
  # Create containers to initialize new volume ownership from the approved images.
  compose('create','--no-build','api','scan','updater')
  for role in ['resumes','signatures']:
   helper=volume_helper(newproject,'restore',[(newproject+'_'+role,'/'+role)],True,uid=1000 if role=='signatures' else 1001)
   try:
    for e in byrole.get(role,[]):run(['docker','exec','-i',helper,'node','-e',WRITE,'/'+role+'/'+e['path']],input=read(e['entry']))
   finally:run(['docker','stop','--time','1',helper])
  compose('up','-d','--no-build','--wait','--wait-timeout','180')
 except Exception:
  # Retain every partial restore for inspection, stop only this new target.
  compose('stop');raise
 finally:
  if old is None:os.environ.pop('RP_INSTANCE',None)
  else:os.environ['RP_INSTANCE']=old
 print(json.dumps({'status':'restored','target':target,'source_retained_stopped':True,'entries':len(m['entries'])}))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('action',choices=['backup','verify','restore']);p.add_argument('--backup');p.add_argument('--target');a=p.parse_args();os.umask(0o077)
 try:
  if a.action=='backup':backup()
  elif a.action=='verify':print(json.dumps({'status':'verified','entries':len(inspect_backup(a.backup)['entries'])}))
  else:restore(a.backup,a.target)
 except Exception as exc:
  # Raw SQL/configuration and crypto failures never enter published logs.
  print(json.dumps({'status':'refused','reason':type(exc).__name__,'retained':True}));raise SystemExit(1)
