// Test-only DB fixture. Never runs AV and never adds a product bypass.
const crypto=require('node:crypto');
const {sql}=require('./helpers.cjs');
function seedSyntheticAv(id,verdict='clean'){
 if(!/^[0-9a-f-]{36}$/.test(id)||!['clean','blocked'].includes(verdict))throw Error('BAD_TEST_FIXTURE');
 sql(`INSERT INTO document_checks(id,document_id,org_id,sha256,policy,verdict,engine_version,signature_version,signature_manifest,generation_id,actor_user_id) SELECT '${crypto.randomUUID()}',id,agency_org_id,sha256,CASE file_format WHEN 'pdf' THEN 'static-resume-v2' ELSE 'xlsx-resume-v1' END,'${verdict}','TEST_ONLY_SYNTHETIC_NO_AV','TEST_ONLY','{"test_only":"not_real_AV"}'::jsonb,'${crypto.randomUUID()}',created_by FROM documents WHERE id='${id}';`);
}
module.exports={seedSyntheticAv};
