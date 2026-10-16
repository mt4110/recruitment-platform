"""Live probes inside the fresh, not-yet-used S2 containers (test projects only)."""
import json,os,subprocess,sys
from pathlib import Path
local=Path(os.environ['RP_E2E_DIR']);marker=json.loads((local/'test-instance.json').read_text())
if not marker['test_only'] or marker['instance']!=os.environ['RP_INSTANCE']:raise SystemExit('Isolated test marker required.')
job=sys.argv[1]
probe=r'''
import json,socket,os,pathlib
allowed=[];denied=[]
for host,port in [('relay',8080),('api',8080),('api',8081),('db',5432),('scan',8080),('pdf-renderer',8080),('invoice-renderer',8080),('broker',8080),('1.1.1.1',443)]:
 try:
  c=socket.create_connection((host,port),timeout=.4);c.close();allowed.append(host+':'+str(port))
 except OSError:denied.append(host+':'+str(port))
missing=all(not pathlib.Path(p).exists() for p in ['/run/original-key','/run/broker-auth','/data/resumes','/var/run/docker.sock','/proc/1/root/run/original-key'])
root_readonly=False
try:pathlib.Path('/s2-write-probe').write_text('x')
except OSError:root_readonly=True
caps=next(l.split(':')[1].strip() for l in pathlib.Path('/proc/self/status').read_text().splitlines() if l.startswith('CapEff:'))
print(json.dumps({'allowed':allowed,'denied':denied,'secrets_absent':missing,'root_readonly':root_readonly,'uid':os.getuid(),'caps_zero':int(caps,16)==0,'pid1':pathlib.Path('/proc/1/cmdline').read_bytes().split(b'\0')[0].decode()}))
'''
r=json.loads(subprocess.check_output(['docker','exec',job+'-sandbox-1','python','-c',probe],text=True))
assert r['allowed']==['relay:8080'] and len(r['denied'])==8 and r['secrets_absent'] and r['root_readonly'] and r['uid']==1004 and r['caps_zero'],r
# Relay has no secret mounts; inspect actual kernel/user/container constraints.
info=json.loads(subprocess.check_output(['docker','inspect',job+'-relay-1'],text=True))[0]
assert not info['Mounts'] and info['Config']['User']=='1003:1003' and info['HostConfig']['ReadonlyRootfs']
(local/'artifacts'/'s2-isolation.json').write_text(json.dumps({'sandbox':r,'relay_secret_mounts':False,'relay_distinct_user':True},indent=2)+'\n')
