#!/usr/bin/env python3
"""Inventory and add encrypted copies; immutable original IDs and share selections remain."""
import argparse,base64,json,os,re,uuid
from document_operator import ROOT,instance,values,run,compose,sql,quote,digest,lock,READ,WRITE
p=argparse.ArgumentParser();p.add_argument('action',choices=['inventory','apply','cutover']);p.add_argument('--document',action='append',default=[]);p.add_argument('--backup');p.add_argument('--quarantine-unmigrated',action='store_true');args=p.parse_args()
os.umask(0o077);name,local=instance();held=lock(local)
ids=[str(uuid.UUID(x)) for x in args.document]
where=' AND d.id IN ('+','.join(quote(x) for x in ids)+')' if ids else ''
rows=json.loads(sql("SELECT coalesce(json_agg(x),'[]') FROM (SELECT d.*,m.state AS migration_state,m.migration_id,m.staging_key AS migration_stage,m.envelope,m.ciphertext_hash,m.ciphertext_size,m.wrap_version,u.active AND o.active AND c.archived_at IS NULL AND u.organization_id=d.agency_org_id AND c.agency_org_id=d.agency_org_id AS owner_active FROM documents d JOIN users u ON u.id=d.created_by JOIN organizations o ON o.id=d.agency_org_id JOIN candidates c ON c.id=d.candidate_id LEFT JOIN document_migrations m ON m.document_id=d.id WHERE NOT d.encrypted_transport"+where+" ORDER BY d.id) x;"))
if ids and set(ids)!={r['id'] for r in rows}:raise SystemExit('Unknown or nonlegacy document; no changes.')
if args.action=='inventory':
 print(json.dumps({'legacy':len(rows),'ready':sum(r['status']=='ready' and r['owner_active'] for r in rows),'migrated':sum(r['migration_state']=='ready' for r in rows),'unavailable':sum(r['status']!='ready' or not r['owner_active'] for r in rows)}));raise SystemExit(0)
if args.action=='cutover':
 # API admission is stopped/drained before checking the terminal inventory.
 compose('stop','gateway','web','api')
 try:
  incomplete=" OR EXISTS(SELECT 1 FROM documents d WHERE NOT d.encrypted_transport AND status='ready' AND NOT safe_view_keys(d.id))" if not args.quarantine_unmigrated else ''
  sql("BEGIN;SET ROLE app_migrator;SELECT pg_advisory_xact_lock(72176312);DO $$ BEGIN IF EXISTS(SELECT 1 FROM encrypted_document_jobs WHERE state='processing' AND lease_expires_at>now()) OR EXISTS(SELECT 1 FROM idempotency_records WHERE state='processing' AND lease_expires_at>now() AND normalized_path LIKE '%/documents%')"+incomplete+" THEN RAISE EXCEPTION 'inventory incomplete';END IF;END $$;UPDATE document_cutover SET legacy_open=false;COMMIT;")
 finally:compose('up','-d','--no-build','--wait','--wait-timeout','120','gateway','web','api')
 print(json.dumps({'cutover':'encrypted_only','originals_retained':True}));raise SystemExit(0)
if not args.backup:raise SystemExit('A verified encrypted backup is required before migration.')
# Authenticate the manifest and verify all entries before admitting any source.
from document_snapshot import inspect_backup
manifest=inspect_backup(args.backup)
if manifest['source_instance']!=name:raise SystemExit('Backup belongs to a different instance.')
backed={x['document_id']:x for x in manifest['inventory']}
project=values(local)['COMPOSE_PROJECT_NAME'];completed=0
for d in rows:
 if d['status']!='ready' or not d['owner_active']:raise SystemExit('Inventory contains unavailable documents; repair or scope explicit --document IDs.')
 if d['migration_state']=='ready':completed+=1;continue
 mismatch=sql("SELECT count(*) FROM application_documents WHERE document_id="+quote(d['id'])+" AND (storage_key_snapshot,sha256_snapshot,size_bytes_snapshot,original_name_snapshot,file_format_snapshot,document_kind_snapshot) IS DISTINCT FROM ("+','.join([quote(d['storage_key']),quote(d['sha256']),str(d['size_bytes']),quote(d['original_name']),quote(d['file_format']),quote(d['document_kind'])])+");")
 if mismatch!='0':raise SystemExit('Existing shared snapshot differs from original; no migration or replacement.')
 b=backed.get(d['id'])
 if not b or not b.get('source_verified') or b['sha256']!=d['sha256'] or b['size_bytes']!=d['size_bytes'] or b['storage_key']!=d['storage_key']:raise SystemExit('Source is not in the verified backup; take a new backup.')
 if not re.fullmatch(r'[a-f0-9-]{36}\.(pdf|xlsx)',d['storage_key']):raise SystemExit('Unexpected legacy storage key.')
 raw=compose('exec','-T','api','cat','/data/resumes/'+d['storage_key'])
 if len(raw)!=d['size_bytes'] or digest(raw)!=d['sha256']:raise SystemExit('Original missing or changed; no fallback.')
 if d['migration_state'] is None:
  k=json.loads(sql("SELECT row_to_json(k) FROM document_key_versions k WHERE purpose='original' AND enabled AND accept_upload;"));mid=str(uuid.uuid4());stage=str(uuid.uuid4())
  payload={**d,'version':k['version'],'public_spki':k['public_spki'],'migration_id':mid,'bytes':base64.b64encode(raw).decode()}
  enc=json.loads(run(['node','scripts/document_crypto.cjs','migration'],input=json.dumps(payload).encode()));cipher=base64.b64decode(enc.pop('bytes'))
  # Private ciphertext recovery material is persisted before volume write. No plaintext temp.
  folder=local/'migration-staging';folder.mkdir(mode=0o700,exist_ok=True)
  from document_operator import write_new
  write_new(folder/(stage+'.cipher'),cipher)
  sql("BEGIN;SET ROLE app_migrator;SELECT pg_advisory_xact_lock(72176309);DO $$ BEGIN IF (SELECT coalesce(sum(reserved_bytes),0) FROM document_admissions WHERE org_id="+quote(d['agency_org_id'])+")+(SELECT orphan_bytes FROM document_storage_baseline)+"+str(len(cipher))+">536870912 OR (SELECT coalesce(sum(reserved_bytes),0) FROM document_admissions)+(SELECT coalesce(sum(physical_bytes),0) FROM upload_attempts)+(SELECT orphan_bytes FROM document_storage_baseline)+(SELECT coalesce(sum(reserved_bytes),0) FROM document_artifacts)+"+str(len(cipher))+">1073741824 THEN RAISE EXCEPTION 'quota';END IF;END $$;INSERT INTO document_admissions(id,org_id,user_id,reserved_bytes) VALUES("+','.join([quote(mid),quote(d['agency_org_id']),quote(d['created_by']),str(len(cipher))])+");INSERT INTO document_migrations(document_id,org_id,user_id,migration_id,staging_key,source_hash,wrap_version,envelope,ciphertext_hash,ciphertext_size,state) VALUES("+','.join([quote(d['id']),quote(d['agency_org_id']),quote(d['created_by']),quote(mid),quote(stage),quote(d['sha256']),quote(k['version']),quote(json.dumps(enc['envelope']))+'::jsonb',quote(enc['ciphertext_hash']),str(len(cipher)),"'reserved'"])+");COMMIT;")
 else:
  if d['migration_state']=='rejected':raise SystemExit('Rejected migration requires operator investigation, not automatic retry.')
  stage=d['migration_stage'];cipher=(local/'migration-staging'/(stage+'.cipher')).read_bytes() if d['migration_state']=='reserved' else compose('exec','-T','api','cat','/data/resumes/encrypted/'+stage+'.cipher')
  if digest(cipher)!=d['ciphertext_hash'] or len(cipher)!=d['ciphertext_size']:raise SystemExit('Migration staging mismatch.')
 compose('exec','-T','api','sh','-c','mkdir -p /data/resumes/encrypted')
 # Node is not installed in API: write through the existing trusted host/volume helper.
 from document_operator import volume_helper
 helper=volume_helper(project,'migration',[(project+'_resumes','/resumes')],True)
 try:run(['docker','exec','-i',helper,'node','-e',WRITE,'/resumes/encrypted/'+stage+'.cipher'],input=cipher)
 finally:run(['docker','stop','--time','1',helper])
 sql("BEGIN;SET ROLE app_migrator;UPDATE document_migrations SET state='stored' WHERE document_id="+quote(d['id'])+" AND state='reserved';INSERT INTO encrypted_document_jobs(document_id,org_id,user_id) VALUES("+','.join(map(quote,[d['id'],d['agency_org_id'],d['created_by']]))+") ON CONFLICT DO NOTHING;COMMIT;")
 completed+=1
print(json.dumps({'queued_or_ready':completed,'originals_retained':True,'run_worker_next':True}))
