from pathlib import Path
import os
import json,secrets,subprocess,time,socket,io,tarfile

ROOT=Path(__file__).parent
DOCKER=['docker']+(['--context',os.environ['M0_DOCKER_CONTEXT']] if os.environ.get('M0_DOCKER_CONTEXT') else [])
def run(*a):
    return subprocess.check_output([*DOCKER,*a],text=True).strip()
def private(name,data):
    p=ROOT/name;p.write_text(data);p.chmod(0o600);return str(p)
dbpw=secrets.token_urlsafe(30);adminpw=secrets.token_urlsafe(30)
users={u:secrets.token_urlsafe(18) for u in ('agency-a','agency-b','employer-x','employer-y','unregistered')}
private('secrets.json',json.dumps({'db_password':dbpw,'users':users}))
private('pg.env',f'POSTGRES_PASSWORD={dbpw}\nPOSTGRES_DB=m0\n')
private('idp.env',f'KC_BOOTSTRAP_ADMIN_USERNAME=m0admin\nKC_BOOTSTRAP_ADMIN_PASSWORD={adminpw}\n')
realm={'realm':'m0','enabled':True,'sslRequired':'none','registrationAllowed':False,'accessTokenLifespan':30,
 'clients':[{'clientId':'m0-probe','enabled':True,'publicClient':True,'standardFlowEnabled':True,'directAccessGrantsEnabled':False,
 'redirectUris':['http://localhost:18081/callback'],'webOrigins':['http://localhost:18081'],
 'attributes':{'pkce.code.challenge.method':'S256'}}],
 'users':[{'username':u,'enabled':True,'emailVerified':True,'email':u+'@example.com','firstName':'Fictional','lastName':u,
 'credentials':[{'type':'password','value':pw,'temporary':False}]} for u,pw in users.items()]}
private('m0-realm.json',json.dumps(realm))
for port in (15432,18080,18081):
    with socket.socket() as s:
        s.bind(('127.0.0.1',port))
run('network','create',os.environ.get('M0_PREFIX','rp-m0')+'-network')
run('run','-d','--name',os.environ.get('M0_PREFIX','rp-m0')+'-db','--network',os.environ.get('M0_PREFIX','rp-m0')+'-network','--memory','512m','--cpus','1',
    '-p','127.0.0.1:15432:5432','--env-file',str(ROOT/'pg.env'),'postgres:17-bookworm')
run('create','--name',os.environ.get('M0_PREFIX','rp-m0')+'-idp','--network',os.environ.get('M0_PREFIX','rp-m0')+'-network','--network-alias','idp.m0.localhost',
    '--memory','1g','--cpus','2','-p','127.0.0.1:18080:18080','--env-file',str(ROOT/'idp.env'),
    'quay.io/keycloak/keycloak:26.8.1','start-dev','--http-port=18080',
    '--hostname=http://idp.m0.localhost:18080','--import-realm')
archive=io.BytesIO()
with tarfile.open(fileobj=archive,mode='w') as tar:
    directory=tarfile.TarInfo('import');directory.type=tarfile.DIRTYPE;directory.mode=0o755;directory.uid=1000;tar.addfile(directory)
    data=json.dumps(realm).encode();member=tarfile.TarInfo('import/m0-realm.json');member.mode=0o600;member.uid=1000;member.size=len(data);tar.addfile(member,io.BytesIO(data))
subprocess.run([*DOCKER,'cp','-a','-',os.environ.get('M0_PREFIX','rp-m0')+'-idp:/opt/keycloak/data/'],input=archive.getvalue(),check=True)
run('start',os.environ.get('M0_PREFIX','rp-m0')+'-idp')
print(json.dumps({'started':[os.environ.get('M0_PREFIX','rp-m0')+'-db',os.environ.get('M0_PREFIX','rp-m0')+'-idp'],'ports':'loopback only','realm_users':len(users)}))
