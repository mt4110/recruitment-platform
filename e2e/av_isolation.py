"""Inspect isolated R2 service configuration. Never collect environment/credentials."""
import json, os, subprocess
from pathlib import Path
instance=os.environ['RP_INSTANCE']
assert instance.startswith('e2e-')
report={}
for service in ('scan','updater'):
    d=json.loads(subprocess.check_output(['docker','inspect','recruitment-'+instance+'-'+service+'-1']))[0]
    h=d['HostConfig'];n=list(d['NetworkSettings']['Networks'])
    assert d['Config']['User']=='1000:1000' and h['ReadonlyRootfs'] and h['CapDrop']==['ALL'] and 'no-new-privileges:true' in h['SecurityOpt']
    assert not h['PortBindings'] and len(n)==1
    network=json.loads(subprocess.check_output(['docker','network','inspect',n[0]]))[0]
    assert network['Internal']==(service=='scan')
    assert all(m['Destination']=='/signatures' for m in d['Mounts'])
    assert all(m['RW']==(service=='updater') for m in d['Mounts'])
    assert h['Memory']==(2 if service=='scan' else 4)*1024**3 and h['PidsLimit']==32
    # Presence names only, never values.
    names=[v.split('=',1)[0] for v in d['Config']['Env']]
    assert not any('PASSWORD' in v or v in {'AUTH_DB','RUNTIME_DB'} for v in names)
    packages=subprocess.check_output(['docker','exec',d['Id'],'sh','-c',"python3 --version; dpkg-query -W -f='${Package} ${Version}\\n' python3 python3-minimal libpython3.13-stdlib"],text=True)
    report[service]={'nonroot':True,'read_only_root':True,'cap_drop':h['CapDrop'],'memory':h['Memory'],'pids':h['PidsLimit'],'network_internal':network['Internal'],'one_network':True,'ports_published':False,'signature_volume_readonly':service=='scan','database_credentials':False,'packages':packages.splitlines()}
Path(os.environ['RP_E2E_DIR'],'artifacts','r2-isolation.json').write_text(json.dumps(report,indent=2)+'\n')
