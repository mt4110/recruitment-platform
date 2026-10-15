from pathlib import Path
import os
import psycopg,json,time,hashlib,threading,uuid

ROOT=Path(__file__).parent
pw=json.loads((ROOT/'secrets.json').read_text())['db_password']
dsn=dict(host='127.0.0.1',port=15432,dbname='m0',password=pw)
def connect(user='m0_runtime'):return psycopg.connect(user=user,**dsn)
checks=[]
def check(name,ok,**detail):
    checks.append(dict(name=name,pass_=bool(ok),**detail))
    if not ok:raise AssertionError(name)
def uid(i):return f'00000000-0000-0000-0000-{i:012d}'
A,B,X,Y=map(uid,(1,2,11,12));JOB=uid(21)
start=time.monotonic()
with connect('postgres') as c:
    c.execute('CREATE ROLE m0_owner NOLOGIN NOSUPERUSER NOBYPASSRLS')
    c.execute(psycopg.sql.SQL('CREATE ROLE m0_runtime LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD {}').format(psycopg.sql.Literal(pw)))
    c.execute('CREATE SCHEMA m0 AUTHORIZATION m0_owner')
    c.execute('SET ROLE m0_owner')
    c.execute('''
    CREATE TABLE m0.organizations(id uuid PRIMARY KEY,kind text NOT NULL,active boolean NOT NULL);
    CREATE TABLE m0.jobs(id uuid PRIMARY KEY,employer_org_id uuid NOT NULL,published boolean NOT NULL);
    CREATE TABLE m0.documents(id uuid PRIMARY KEY,agency_org_id uuid NOT NULL,storage_key text NOT NULL);
    CREATE TABLE m0.applications(id uuid PRIMARY KEY,agency_org_id uuid NOT NULL,employer_org_id uuid NOT NULL,status text NOT NULL,share_revoked_at timestamptz);
    CREATE TABLE m0.application_documents(id uuid PRIMARY KEY,application_id uuid REFERENCES m0.applications,storage_key_snapshot text NOT NULL);
    CREATE TABLE m0.acceptance_probe(id uuid PRIMARY KEY,agency_org_id uuid NOT NULL,job_id uuid NOT NULL);
    GRANT USAGE ON SCHEMA m0 TO m0_runtime;
    GRANT SELECT ON ALL TABLES IN SCHEMA m0 TO m0_runtime;
    GRANT UPDATE(published) ON m0.jobs TO m0_runtime;
    GRANT INSERT ON m0.acceptance_probe TO m0_runtime;
    ALTER TABLE m0.organizations ENABLE ROW LEVEL SECURITY;ALTER TABLE m0.organizations FORCE ROW LEVEL SECURITY;
    CREATE POLICY own_org ON m0.organizations FOR SELECT USING(id=nullif(current_setting('app.org_id',true),'')::uuid AND active);
    ALTER TABLE m0.jobs ENABLE ROW LEVEL SECURITY;ALTER TABLE m0.jobs FORCE ROW LEVEL SECURITY;
    CREATE POLICY job_read ON m0.jobs FOR SELECT USING(EXISTS(SELECT FROM m0.organizations o WHERE (o.kind='employer' AND o.id=employer_org_id) OR (o.kind='agency' AND published)));
    CREATE POLICY job_update ON m0.jobs FOR UPDATE USING(EXISTS(SELECT FROM m0.organizations o WHERE o.kind='employer' AND o.id=employer_org_id)) WITH CHECK(EXISTS(SELECT FROM m0.organizations o WHERE o.kind='employer' AND o.id=employer_org_id));
    ALTER TABLE m0.documents ENABLE ROW LEVEL SECURITY;ALTER TABLE m0.documents FORCE ROW LEVEL SECURITY;
    CREATE POLICY original_read ON m0.documents FOR SELECT USING(EXISTS(SELECT FROM m0.organizations o WHERE o.kind='agency' AND o.id=agency_org_id));
    ALTER TABLE m0.applications ENABLE ROW LEVEL SECURITY;ALTER TABLE m0.applications FORCE ROW LEVEL SECURITY;
    CREATE POLICY application_read ON m0.applications FOR SELECT USING(EXISTS(SELECT FROM m0.organizations o WHERE (o.kind='agency' AND o.id=agency_org_id) OR (o.kind='employer' AND o.id=employer_org_id AND status<>'draft')));
    ALTER TABLE m0.application_documents ENABLE ROW LEVEL SECURITY;ALTER TABLE m0.application_documents FORCE ROW LEVEL SECURITY;
    CREATE POLICY shared_read ON m0.application_documents FOR SELECT USING(EXISTS(SELECT FROM m0.applications a JOIN m0.organizations o ON true WHERE a.id=application_id AND ((o.kind='agency' AND o.id=a.agency_org_id) OR (o.kind='employer' AND o.id=a.employer_org_id AND a.status IN ('submitted','screening','rejected','hired') AND a.share_revoked_at IS NULL))));
    ALTER TABLE m0.acceptance_probe ENABLE ROW LEVEL SECURITY;ALTER TABLE m0.acceptance_probe FORCE ROW LEVEL SECURITY;
    CREATE POLICY acceptance_read ON m0.acceptance_probe FOR SELECT USING(agency_org_id=nullif(current_setting('app.org_id',true),'')::uuid);
    CREATE POLICY acceptance_insert ON m0.acceptance_probe FOR INSERT WITH CHECK(EXISTS(SELECT FROM m0.organizations o WHERE o.kind='agency' AND o.id=agency_org_id));
    ''')
    c.execute('RESET ROLE')
    for org,kind in ((A,'agency'),(B,'agency'),(X,'employer'),(Y,'employer')):c.execute('INSERT INTO m0.organizations VALUES(%s,%s,true)',(org,kind))
    c.execute('INSERT INTO m0.jobs VALUES(%s,%s,true)',(JOB,X))
    for i,org in ((31,A),(32,B)):c.execute('INSERT INTO m0.documents VALUES(%s,%s,%s)',(uid(i),org,'m0-resume-'+str(i)+'.pdf'))
    for i,status in enumerate(('draft','submitted','screening','rejected','hired','withdrawn'),41):
        c.execute('INSERT INTO m0.applications VALUES(%s,%s,%s,%s,CASE WHEN %s THEN now() ELSE NULL END)',(uid(i),A,X,status,status=='withdrawn'))
        if status!='draft':c.execute('INSERT INTO m0.application_documents VALUES(%s,%s,%s)',(uid(i+100),uid(i),'m0-resume-31.pdf'))
    c.execute('INSERT INTO m0.applications VALUES(%s,%s,%s,%s,NULL)',(uid(51),B,Y,'submitted'))
    c.execute('INSERT INTO m0.application_documents VALUES(%s,%s,%s)',(uid(151),uid(51),'m0-resume-32.pdf'))

def ctx(c,org):c.execute("SELECT set_config('app.org_id',%s,true)",(org,))
with connect() as c:
    role=c.execute("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user").fetchone()
    check('runtime_not_superuser_or_bypass',role==(False,False))
    meta=c.execute("SELECT bool_and(relrowsecurity AND relforcerowsecurity AND pg_get_userbyid(relowner)<>current_user) FROM pg_class WHERE relnamespace='m0'::regnamespace AND relkind='r'").fetchone()[0]
    check('non_owner_and_force_rls_all_probe_tables',meta)
    check('no_context_no_rows',c.execute('SELECT count(*) FROM m0.application_documents').fetchone()[0]==0)
    c.commit()
    for org,orig,shared,apps in ((A,1,5,6),(B,1,1,1),(X,0,4,5),(Y,0,1,1)):
        ctx(c,org)
        counts=tuple(c.execute('SELECT count(*) FROM m0.'+t).fetchone()[0] for t in ('documents','application_documents','applications'))
        check('tenant_matrix_'+org[-2:],counts==(orig,shared,apps),actual=list(counts))
        if org==X:
            refs=c.execute('SELECT storage_key_snapshot FROM m0.application_documents').fetchall()
            check('employer_shared_refs_without_original_join',len(refs)==4 and all(r[0]=='m0-resume-31.pdf' for r in refs))
        c.commit()
        check('context_cleared_on_connection_reuse_'+org[-2:],c.execute('SELECT count(*) FROM m0.documents').fetchone()[0]==0)
        c.commit()
    ctx(c,A)
    r=c.execute('UPDATE m0.jobs SET published=false WHERE id=%s',(JOB,))
    check('agency_job_update_denied_by_rls',r.rowcount==0)
    c.rollback()
with connect('postgres') as c:c.execute('UPDATE m0.applications SET share_revoked_at=now() WHERE id=%s',(uid(42),))
with connect() as c:
    ctx(c,X);check('revoke_removes_shared_row',c.execute('SELECT count(*) FROM m0.application_documents WHERE application_id=%s',(uid(42),)).fetchone()[0]==0)
    check('metadata_retained_after_revoke',c.execute('SELECT count(*) FROM m0.applications WHERE id=%s',(uid(42),)).fetchone()[0]==1)
    c.commit();ctx(c,A);check('agency_retains_shared_reference',c.execute('SELECT count(*) FROM m0.application_documents WHERE application_id=%s',(uid(42),)).fetchone()[0]==1)

lock=int.from_bytes(hashlib.sha256(('job:'+JOB).encode()).digest()[:8],'big',signed=True)
def lock_job(c):c.execute('SELECT pg_advisory_xact_lock(%s)',(lock,))
def close(c):c.execute('UPDATE m0.jobs SET published=false WHERE id=%s',(JOB,))
def submit(c):
    is_open=c.execute('SELECT published FROM m0.jobs WHERE id=%s',(JOB,)).fetchone()
    if is_open:
        c.execute('INSERT INTO m0.acceptance_probe VALUES(%s,%s,%s)',(uuid.uuid4(),A,JOB));return 'accepted'
    return 'JOB_NOT_OPEN'
for first in ('close','submit'):
    with connect('postgres') as c:c.execute('UPDATE m0.jobs SET published=true WHERE id=%s',(JOB,))
    with connect() as c1:
        ctx(c1,X if first=='close' else A);lock_job(c1)
        r1=close(c1) if first=='close' else submit(c1)
        result={};started=threading.Event()
        def second():
            try:
                with connect() as c2:
                    ctx(c2,A if first=='close' else X);started.set();t=time.monotonic();lock_job(c2)
                    result['wait_seconds']=time.monotonic()-t
                    result['outcome']=submit(c2) if first=='close' else close(c2)
            except Exception as e:result['error']=type(e).__name__
        th=threading.Thread(target=second);th.start();started.wait(5);time.sleep(.2)
        check(first+'_second_transaction_waits',th.is_alive())
        c1.commit();th.join(5)
        check(first+'_first_order',not th.is_alive() and 'error' not in result and ((result.get('outcome')=='JOB_NOT_OPEN') if first=='close' else r1=='accepted'),wait_seconds=round(result.get('wait_seconds',0),3))
with connect() as c1,connect() as c2:
    ctx(c1,X);ctx(c2,A);lock_job(c1);c2.execute("SET LOCAL lock_timeout='3s'")
    t=time.monotonic()
    try:lock_job(c2);check('advisory_timeout',False)
    except psycopg.errors.LockNotAvailable:check('advisory_timeout',True,seconds=round(time.monotonic()-t,3));c2.rollback()
with connect('postgres') as c:version=c.execute('SELECT version()').fetchone()[0]
result={'scope':'minimal M0 SQL harness; not production migrations or API','postgres':version,'checks':checks,'elapsed_seconds':round(time.monotonic()-start,3),'all_passed':all(x['pass_'] for x in checks)}
(ROOT/'rls-result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
