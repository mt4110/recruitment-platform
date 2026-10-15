"""Seed a fictional 0005 PDF/share before actual 0006 migration, then verify preservation."""
import hashlib,json,os,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];local=Path(os.environ['RP_E2E_DIR'])
if not os.environ.get('RP_INSTANCE','').startswith('e2e-'):raise SystemExit('TEST_INSTANCE_REQUIRED')
A='00000000-0000-0000-0000-000000000001';U='10000000-0000-0000-0000-000000000001';X='00000000-0000-0000-0000-000000000011'
D='50000000-0000-0000-0000-00000000f001';APP='60000000-0000-0000-0000-00000000f001';KEY='70000000-0000-0000-0000-00000000f001';C='40000000-0000-0000-0000-000000000001';J='30000000-0000-0000-0000-000000000001'
def compose(*args,**kwargs):return subprocess.run([sys.executable,'scripts/local.py','compose',*args],cwd=ROOT,capture_output=True,check=True,**kwargs)
def sql(s):return compose('exec','-T','db','psql','-U','postgres','-d','recruitment','-v','ON_ERROR_STOP=1','-At',input=s,text=True).stdout.strip()
def snapshot():
 return json.loads(sql(f"SELECT json_build_object('document',to_jsonb(d),'shared',to_jsonb(ad),'outcome_expiry',extract(epoch from i.expires_at)) FROM documents d JOIN application_documents ad ON ad.document_id=d.id JOIN idempotency_records i ON i.resource_id=d.id WHERE d.id='{D}' AND i.key='{KEY}';"))
if sys.argv[1]=='before':
 raw=(ROOT/'apps/web/public/sample-resume.pdf').read_bytes();sha=hashlib.sha256(raw).hexdigest()
 compose('exec','-T','api','sh','-c',f'set -C; cat > /data/resumes/{D}.pdf',input=raw)
 sql(f"""BEGIN;SELECT set_config('app.user_id','{U}',true),set_config('app.org_id','{A}',true);
 INSERT INTO documents(id,agency_org_id,candidate_id,created_by,storage_key,original_name,size_bytes,sha256,status) VALUES('{D}','{A}','{C}','{U}','{D}.pdf','架空の移行前PDF.pdf',{len(raw)},'{sha}','pending');
 UPDATE documents SET status='ready',validation_policy='static-resume-v1',validated_at=now() WHERE id='{D}';
 INSERT INTO idempotency_records(org_id,user_id,http_method,normalized_path,key,request_hash,resource_id,state,result_status,expires_at) VALUES('{A}','{U}','POST','/api/v1/candidates/{C}/documents','{KEY}',decode('{'0'*64}','hex'),'{D}','completed',201,now()-interval '3 days');
 INSERT INTO idempotency_records(org_id,user_id,http_method,normalized_path,key,request_hash,resource_id,state,result_status,error_code,expires_at) VALUES('{A}','{U}','POST','/api/v1/candidates/{C}/documents','70000000-0000-0000-0000-00000000f002',decode('{'0'*64}','hex'),'{D}','failed',422,'PDF_REJECTED',now()-interval '8 days');
 INSERT INTO applications(id,agency_org_id,employer_org_id,candidate_id,job_id,reason) VALUES('{APP}','{A}','{X}','{C}','{J}','架空の移行検証');
 INSERT INTO application_documents(application_id,document_id,agency_org_id,storage_key_snapshot,original_name_snapshot,size_bytes_snapshot,sha256_snapshot) SELECT '{APP}',id,agency_org_id,storage_key,original_name,size_bytes,sha256 FROM documents WHERE id='{D}';
 INSERT INTO application_snapshots(application_id,name,summary,consent_recorded_at,consent_recorded_by,consent_text_version) SELECT '{APP}',name,summary,now(),'{U}','demo-share-v1' FROM candidates WHERE id='{C}';
 UPDATE applications SET status='submitted',version=2,submitted_at=now(),job_title_snapshot='架空の移行前求人',job_description_snapshot='架空の移行前本文',job_location_snapshot='架空',job_employment_type_snapshot='full_time',job_version_snapshot=2,agency_name_snapshot='架空紹介会社A',employer_name_snapshot='架空求人企業X' WHERE id='{APP}'; COMMIT;""")
 (local/'legacy-before.json').write_text(json.dumps(snapshot()))
else:
 before=json.loads((local/'legacy-before.json').read_text());after=snapshot()
 d={k:v for k,v in after['document'].items() if k not in ['file_format','media_type','document_kind','legacy_document']}
 shared={k:v for k,v in after['shared'].items() if k not in ['file_format_snapshot','media_type_snapshot','document_kind_snapshot']}
 checks={'document_unchanged':d==before['document'],'snapshot_unchanged':shared==before['shared'],'defaults_pdf_other':after['document']['file_format']=='pdf' and after['document']['document_kind']=='other' and after['document']['legacy_document'],'original_terminal_expiry_plus_6_days':abs(after['outcome_expiry']-before['outcome_expiry']-6*86400)<0.01,'no_clean_evidence':sql(f"SELECT count(*) FROM document_checks WHERE document_id='{D}';")=='0'}
 assert all(checks.values()),checks
 raw=compose('exec','-T','api','cat',f'/data/resumes/{D}.pdf').stdout
 assert hashlib.sha256(raw).hexdigest()==before['document']['sha256']
 checks['bytes_unchanged']=True
 (local/'artifacts/legacy-migration.json').write_text(json.dumps({'checks':checks,'document_id':D,'application_id':APP,'operation_key':KEY,'candidate_id':C},indent=2))
 print('Actual 0005 -> 0006 migration: preservation checks passed')
