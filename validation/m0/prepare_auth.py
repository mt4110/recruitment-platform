from pathlib import Path
import os
import httpx,json,time
root=Path(__file__).parent
secrets=json.loads((root/'secrets.json').read_text())
env=dict(line.split('=',1) for line in (root/'idp.env').read_text().splitlines())
base='http://127.0.0.1:18080';issuer='http://idp.m0.localhost:18080/realms/m0'
client=httpx.Client(timeout=10,trust_env=False)
for _ in range(60):
    try:
        d=client.get(base+'/realms/m0/.well-known/openid-configuration')
        if d.status_code==200:break
    except httpx.HTTPError:pass
    time.sleep(.5)
else:raise RuntimeError('Keycloak startup timeout')
assert d.json()['issuer']==issuer
t=client.post(base+'/realms/master/protocol/openid-connect/token',data={'grant_type':'password','client_id':'admin-cli',
 'username':env['KC_BOOTSTRAP_ADMIN_USERNAME'],'password':env['KC_BOOTSTRAP_ADMIN_PASSWORD']});t.raise_for_status()
r=client.get(base+'/admin/realms/m0/users',headers={'Authorization':'Bearer '+t.json()['access_token']});r.raise_for_status()
members={}
orgs={'agency-a':'A','agency-b':'B','employer-x':'X','employer-y':'Y'}
for u in r.json():
    if u['username'] in orgs:members[issuer+'|'+u['id']]={'username':u['username'],'organization':orgs[u['username']],'active':True,'org_active':True}
assert len(members)==4
(root/'auth-config.json').write_text(json.dumps({'issuer':issuer,'members':members}))
print(json.dumps({'host_discovery_issuer':d.json()['issuer'],'mapped_subjects':len(members),'registration_source':'trusted admin query, not email or login hint'}))
