#!/usr/bin/env python3
"""Loopback-only development lifecycle. No reset/delete command."""
import hashlib,json,os,secrets,shutil,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
LOCAL=ROOT/'.local';ENV=LOCAL/'local.env'
os.umask(0o077)
def run(args,**kw):return subprocess.run(args,check=True,**kw)
def compose(*args,**kw):
    executable=['docker','compose'] if subprocess.run(['docker','compose','version'],capture_output=True).returncode==0 else ['docker-compose']
    return run([*executable,'--project-directory',str(ROOT),'--env-file',str(ENV),'-f',str(ROOT/'infra/local/compose.yaml'),*args],**kw)
def setup():
    LOCAL.mkdir(mode=0o700,exist_ok=True)
    if ENV.exists():
        if not (LOCAL/'realm.json').is_file() or not (LOCAL/'demo-accounts.json').is_file():raise SystemExit('Incomplete local config; retain files and inspect before continuing.')
        print('Existing local configuration retained.');return
    names=[('agency-a','001'),('agency-b','002'),('employer-x','011'),('employer-y','012'),('unregistered','099')]
    accounts={name:secrets.token_urlsafe(24) for name,_ in names}
    realm={'realm':'recruitment','enabled':True,'sslRequired':'none','registrationAllowed':False,'resetPasswordAllowed':False,
      'clients':[{'clientId':'recruitment-local','publicClient':True,'standardFlowEnabled':True,'directAccessGrantsEnabled':False,'redirectUris':['http://localhost:3000/auth/callback'],'webOrigins':['http://localhost:3000'],'attributes':{'pkce.code.challenge.method':'S256'}}],
      'users':[{'id':'20000000-0000-0000-0000-000000000'+suffix,'username':name,'enabled':True,'emailVerified':True,'firstName':'架空','lastName':name,'email':name+'@example.invalid','credentials':[{'type':'password','value':accounts[name],'temporary':False}]} for name,suffix in names]}
    # Directory is private (0700); only this individual file is mounted read-only.
    (LOCAL/'realm.json').write_text(json.dumps(realm,ensure_ascii=False));(LOCAL/'realm.json').chmod(0o644)
    (LOCAL/'demo-accounts.json').write_text(json.dumps(accounts,indent=2)+'\n')
    values={name:secrets.token_urlsafe(32) for name in ('POSTGRES_PASSWORD','AUTH_DB_PASSWORD','MIGRATION_DB_PASSWORD','RUNTIME_DB_PASSWORD','IDP_DB_PASSWORD','IDP_ADMIN_PASSWORD','ATTEMPT_KEY','CSRF_KEY')}
    ENV.write_text(''.join(k+'='+v+'\n' for k,v in values.items()))
    print('Created private .local/local.env and .local/demo-accounts.json. No credential values are printed.')
def migrate():
    prefix="\\set ON_ERROR_STOP on\nSET ROLE app_migrator;\n"
    # Serialize migration runners, record hashes, and fail on changed applied SQL.
    body=prefix+"BEGIN;\nSELECT pg_advisory_xact_lock(72176301);\nCREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, sha256 text NOT NULL);\n"
    for p in sorted((ROOT/'migrations').glob('*.sql')):
        digest=hashlib.sha256(p.read_bytes()).hexdigest();v=p.stem
        body+=f"DO $$ BEGIN IF EXISTS(SELECT 1 FROM schema_migrations WHERE version='{v}' AND sha256<>'{digest}') THEN RAISE EXCEPTION 'migration checksum changed'; END IF; END $$;\n"
        body+=f"SELECT NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='{v}') AS apply_migration \\gset\n\\if :apply_migration\n"+p.read_text()+f"\nINSERT INTO schema_migrations VALUES('{v}','{digest}');\n\\endif\n"
    body+='COMMIT;\n'+(ROOT/'fixtures/0001_auth.sql').read_text()
    compose('exec','-T','db','psql','-U','postgres','-d','recruitment',input=body,text=True,stdout=subprocess.DEVNULL)
    print('Migrations and fictional fixtures applied; existing records retained.')
if len(sys.argv)<2:raise SystemExit('Usage: python3 scripts/local.py setup|up|stop|status|migrate|compose <args>')
command=sys.argv[1]
if command=='setup':setup()
elif command=='up':
    if not ENV.exists():raise SystemExit('Run setup first.')
    compose('up','-d','--wait','--wait-timeout','180','db','idp-db','idp','pdf-renderer');migrate();compose('up','-d','--build','--wait','--wait-timeout','180')
elif command=='migrate':migrate()
elif command=='stop':compose('stop')
elif command=='status':compose('ps')
elif command=='compose':compose(*sys.argv[2:])
else:raise SystemExit('Unknown command; no delete/reset operation is provided.')
