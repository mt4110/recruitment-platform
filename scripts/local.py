#!/usr/bin/env python3
"""Loopback-only development lifecycle. No reset/delete command."""
import hashlib,json,os,re,secrets,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
INSTANCE=os.environ.get('RP_INSTANCE','default')
if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}',INSTANCE):raise SystemExit('Invalid local instance name.')
LOCAL=ROOT/'.local' if INSTANCE=='default' else ROOT/'.local'/INSTANCE
ENV=LOCAL/'local.env'
def settings():
    values={}
    if ENV.exists():
        values=dict(line.split('=',1) for line in ENV.read_text().splitlines() if '=' in line)
    return values
def ports():
    values=settings()
    pair=[int(values.get(k,os.environ.get('RP_'+k,v))) for k,v in [('APP_PORT','3000'),('IDP_PORT','18080')]]
    if any(p<1024 or p>65535 for p in pair) or pair[0]==pair[1]:raise SystemExit('Use two distinct loopback ports, 1024..65535.')
    return pair
os.umask(0o077)
def run(args,**kw):return subprocess.run(args,check=True,**kw)
def compose(*args,**kw):
    executable=['docker','compose'] if subprocess.run(['docker','compose','version'],capture_output=True).returncode==0 else ['docker-compose']
    overrides=['-f',str(LOCAL/'e2e-networks.json')] if INSTANCE.startswith('e2e-') and (LOCAL/'e2e-networks.json').is_file() else []
    return run([*executable,'--project-directory',str(ROOT),'--env-file',str(ENV),'-f',str(ROOT/'infra/local/compose.yaml'),*overrides,*args],**kw)
def setup():
    LOCAL.mkdir(mode=0o700,parents=True,exist_ok=True)
    if ENV.exists():
        values=settings()
        for name in ('PDF_SHARED_KEY','SCAN_SHARED_KEY'):
            if name not in values:
                with ENV.open('a') as f:f.write(name+'='+secrets.token_urlsafe(32)+'\n')
        if 'DRAFT_MASTER_KEY' not in values:
            # Upgrade only a known pre-draft DB. Never replace a lost encryption key.
            checked=subprocess.run(['docker','exec',values['COMPOSE_PROJECT_NAME']+'-db-1','psql','-U','postgres','-d','recruitment','-Atc',"SELECT to_regclass('form_drafts') IS NULL AND to_regclass('draft_keys') IS NULL"],capture_output=True,text=True)
            if checked.returncode!=0:raise SystemExit('Start the known existing DB before upgrading setup. No draft key generated.')
            if checked.stdout.strip()!='t':raise SystemExit('Draft key missing for an existing draft database; restore the original private configuration. No replacement key generated.')
            with ENV.open('a') as f:f.write('DRAFT_MASTER_KEY='+secrets.token_urlsafe(32)+'\n')
        if not (LOCAL/'realm.json').is_file() or not (LOCAL/'demo-accounts.json').is_file():raise SystemExit('Incomplete local config; retain files and inspect before continuing.')
        print('Existing local configuration retained.');return
    app_port,idp_port=ports()
    names=[('agency-a','001'),('agency-b','002'),('employer-x','011'),('employer-y','012'),('unregistered','099')]
    accounts={name:secrets.token_urlsafe(24) for name,_ in names}
    realm={'realm':'recruitment','enabled':True,'sslRequired':'none','registrationAllowed':False,'resetPasswordAllowed':False,
      'clients':[{'clientId':'recruitment-local','publicClient':True,'standardFlowEnabled':True,'directAccessGrantsEnabled':False,'redirectUris':[f'http://localhost:{app_port}/auth/callback'],'webOrigins':[f'http://localhost:{app_port}'],'attributes':{'pkce.code.challenge.method':'S256'}}],
      'users':[{'id':'20000000-0000-0000-0000-000000000'+suffix,'username':name,'enabled':True,'emailVerified':True,'firstName':'架空','lastName':name,'email':name+'@example.invalid','credentials':[{'type':'password','value':accounts[name],'temporary':False}]} for name,suffix in names]}
    # Directory is private (0700); only this individual file is mounted read-only.
    (LOCAL/'realm.json').write_text(json.dumps(realm,ensure_ascii=False));(LOCAL/'realm.json').chmod(0o644)
    (LOCAL/'demo-accounts.json').write_text(json.dumps(accounts,indent=2)+'\n')
    values={name:secrets.token_urlsafe(32) for name in ('POSTGRES_PASSWORD','AUTH_DB_PASSWORD','MIGRATION_DB_PASSWORD','RUNTIME_DB_PASSWORD','IDP_DB_PASSWORD','IDP_ADMIN_PASSWORD','ATTEMPT_KEY','CSRF_KEY','PDF_SHARED_KEY','SCAN_SHARED_KEY','DRAFT_MASTER_KEY')}
    values.update(APP_PORT=str(app_port),IDP_PORT=str(idp_port),COMPOSE_PROJECT_NAME='recruitment-local' if INSTANCE=='default' else 'recruitment-'+INSTANCE,LOCAL_CONFIG_DIR=str(LOCAL))
    ENV.write_text(''.join(k+'='+v+'\n' for k,v in values.items()))
    print('Created private .local/local.env and .local/demo-accounts.json. No credential values are printed.')
def migrate():
    _,idp_port=ports()
    prefix=f"\\set ON_ERROR_STOP on\n\\set oidc_issuer 'http://idp.recruitment.localhost:{idp_port}/realms/recruitment'\nSET ROLE app_migrator;\n"
    # Serialize migration runners, record hashes, and fail on changed applied SQL.
    body=prefix+"BEGIN;\nSELECT pg_advisory_xact_lock(72176301);\nCREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, sha256 text NOT NULL);\n"
    cutoff=os.environ.get('RP_TEST_MIGRATIONS_THROUGH')
    if cutoff and (not INSTANCE.startswith('e2e-') or cutoff!='0005_snapshot_validation'):raise SystemExit('Migration staging is limited to isolated E2E instances.')
    for p in sorted((ROOT/'migrations').glob('*.sql')):
        if cutoff and p.stem>cutoff:continue
        digest=hashlib.sha256(p.read_bytes()).hexdigest();v=p.stem
        body+=f"DO $$ BEGIN IF EXISTS(SELECT 1 FROM schema_migrations WHERE version='{v}' AND sha256<>'{digest}') THEN RAISE EXCEPTION 'migration checksum changed'; END IF; END $$;\n"
        body+=f"SELECT NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='{v}') AS apply_migration \\gset\n\\if :apply_migration\n"+p.read_text()+f"\nINSERT INTO schema_migrations VALUES('{v}','{digest}');\n\\endif\n"
    body+='COMMIT;\n'
    for fixture in sorted((ROOT/'fixtures').glob('*.sql')): body+=fixture.read_text()+'\n'
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
