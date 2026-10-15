-- Additive R1 migration. Existing bytes, statuses and submitted references stay intact.
ALTER TABLE documents ADD COLUMN file_format text NOT NULL DEFAULT 'pdf' CHECK(file_format IN ('pdf','xlsx')),
 ADD COLUMN media_type text NOT NULL DEFAULT 'application/pdf',
 ADD COLUMN document_kind text NOT NULL DEFAULT 'other' CHECK(document_kind IN ('resume','career_history','other')),
 ADD COLUMN legacy_document boolean NOT NULL DEFAULT true;
ALTER TABLE documents ALTER COLUMN legacy_document SET DEFAULT false;
ALTER TABLE documents ADD CONSTRAINT document_media_matches CHECK((file_format='pdf' AND media_type='application/pdf') OR (file_format='xlsx' AND media_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
ALTER TABLE documents DROP CONSTRAINT documents_check;
ALTER TABLE documents DROP CONSTRAINT ready_validation_required;
ALTER TABLE documents ADD CONSTRAINT ready_validation_required CHECK(status<>'ready' OR (validation_policy IS NOT NULL AND validated_at IS NOT NULL AND rejection_code IS NULL AND ((legacy_document AND file_format='pdf' AND validation_policy='static-resume-v1') OR (file_format='pdf' AND validation_policy='static-resume-v2') OR (file_format='xlsx' AND validation_policy='xlsx-resume-v1'))));
ALTER TABLE application_documents ADD COLUMN file_format_snapshot text NOT NULL DEFAULT 'pdf' CHECK(file_format_snapshot IN ('pdf','xlsx')),
 ADD COLUMN media_type_snapshot text NOT NULL DEFAULT 'application/pdf',
 ADD COLUMN document_kind_snapshot text NOT NULL DEFAULT 'other' CHECK(document_kind_snapshot IN ('resume','career_history','other'));
ALTER TABLE application_documents ADD CONSTRAINT shared_media_matches CHECK((file_format_snapshot='pdf' AND media_type_snapshot='application/pdf') OR (file_format_snapshot='xlsx' AND media_type_snapshot='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));

CREATE TABLE document_checks (
 id uuid PRIMARY KEY, document_id uuid NOT NULL, org_id uuid NOT NULL,
 sha256 char(64) NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 policy text NOT NULL CHECK(policy IN ('static-resume-v2','xlsx-resume-v1')),
 verdict text NOT NULL CHECK(verdict IN ('clean','blocked')),
 engine_version text NOT NULL CHECK(length(engine_version) BETWEEN 1 AND 100),
 signature_version text NOT NULL CHECK(length(signature_version) BETWEEN 1 AND 100),
 signature_manifest jsonb NOT NULL CHECK(jsonb_typeof(signature_manifest)='object' AND signature_manifest<>'{}'::jsonb),
 generation_id uuid NOT NULL, scanned_at timestamptz NOT NULL DEFAULT now(),
 actor_user_id uuid NOT NULL REFERENCES users(id),
 FOREIGN KEY(document_id,org_id) REFERENCES documents(id,agency_org_id)
);
CREATE INDEX document_checks_lookup ON document_checks(document_id,sha256,policy,verdict);
ALTER TABLE document_checks ENABLE ROW LEVEL SECURITY; ALTER TABLE document_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY checks_read ON document_checks FOR SELECT TO app_runtime USING(
 (rp_kind()='agency' AND org_id=rp_org()) OR
 (rp_kind()='employer' AND EXISTS(SELECT 1 FROM application_documents ad WHERE ad.document_id=document_checks.document_id AND ad.agency_org_id=document_checks.org_id))
);
-- R1 cannot create AV clean or blocked evidence. R2 must add its authenticated writer.
GRANT SELECT ON document_checks TO app_runtime;
CREATE FUNCTION document_usable(d uuid,h text,f text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM document_checks c WHERE c.document_id=d AND c.sha256=h AND c.verdict='clean' AND c.policy=CASE f WHEN 'pdf' THEN 'static-resume-v2' WHEN 'xlsx' THEN 'xlsx-resume-v1' END)
 AND NOT EXISTS(SELECT 1 FROM document_checks c WHERE c.document_id=d AND c.verdict='blocked')
$$;
REVOKE ALL ON FUNCTION document_usable(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION document_usable(uuid,text,text) TO app_runtime;

CREATE OR REPLACE FUNCTION preserve_document() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'pending' OR NEW.created_by<>rp_user() OR NEW.legacy_document THEN RAISE EXCEPTION 'invalid document' USING ERRCODE='23514'; END IF;
 ELSE
  IF OLD.status<>'pending' OR (NEW.id,NEW.agency_org_id,NEW.candidate_id,NEW.created_by,NEW.storage_key,NEW.staging_key,NEW.original_name,NEW.size_bytes,NEW.sha256,NEW.created_at,NEW.file_format,NEW.media_type,NEW.document_kind,NEW.legacy_document) IS DISTINCT FROM (OLD.id,OLD.agency_org_id,OLD.candidate_id,OLD.created_by,OLD.storage_key,OLD.staging_key,OLD.original_name,OLD.size_bytes,OLD.sha256,OLD.created_at,OLD.file_format,OLD.media_type,OLD.document_kind,OLD.legacy_document) THEN RAISE EXCEPTION 'immutable document' USING ERRCODE='23514'; END IF;
  IF NEW.status='ready' AND NOT document_usable(NEW.id,NEW.sha256,NEW.file_format) THEN RAISE EXCEPTION 'missing full document check' USING ERRCODE='23514'; END IF;
 END IF; RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION verify_shared_document() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM documents d JOIN applications a ON a.id=NEW.application_id WHERE d.id=NEW.document_id AND d.agency_org_id=NEW.agency_org_id AND d.candidate_id=a.candidate_id AND d.status='ready' AND document_usable(d.id,d.sha256,d.file_format) AND (d.storage_key,d.original_name,d.size_bytes,d.sha256,d.file_format,d.media_type,d.document_kind)=(NEW.storage_key_snapshot,NEW.original_name_snapshot,NEW.size_bytes_snapshot,NEW.sha256_snapshot,NEW.file_format_snapshot,NEW.media_type_snapshot,NEW.document_kind_snapshot)) THEN RAISE EXCEPTION 'invalid shared document' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;

-- Upload results: preserve the original terminal timestamp, not migration time.
ALTER TABLE idempotency_records DROP CONSTRAINT idempotency_records_state_check;
ALTER TABLE idempotency_records DROP CONSTRAINT idempotency_records_check;
ALTER TABLE idempotency_records ADD CONSTRAINT idempotency_records_state_check CHECK(state IN ('processing','completed','failed','expired')),
 ADD CONSTRAINT idempotency_records_check CHECK((state='processing' AND expires_at IS NULL) OR (state IN ('completed','failed','expired') AND expires_at IS NOT NULL)),
 ADD CONSTRAINT expired_upload_only CHECK(state<>'expired' OR (http_method='POST' AND normalized_path ~ '^/api/v1/candidates/[0-9a-f-]{36}/documents$'));
-- FORCE RLS also applies to the table owner. This policy exists only inside the
-- atomic migration transaction and is removed before commit.
CREATE POLICY migration_upload_outcomes ON idempotency_records TO app_migrator USING (true) WITH CHECK (true);
UPDATE idempotency_records SET expires_at=expires_at+interval '6 days' WHERE http_method='POST' AND normalized_path ~ '^/api/v1/candidates/[0-9a-f-]{36}/documents$' AND state IN ('completed','failed');
DROP POLICY migration_upload_outcomes ON idempotency_records;
CREATE FUNCTION preserve_upload_outcome() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.http_method='POST' AND OLD.normalized_path ~ '^/api/v1/candidates/[0-9a-f-]{36}/documents$' AND OLD.state IN ('completed','failed','expired') THEN
  IF TG_OP='DELETE' OR NEW.state<>'expired' OR (NEW.org_id,NEW.user_id,NEW.http_method,NEW.normalized_path,NEW.key,NEW.request_hash,NEW.resource_id,NEW.expires_at) IS DISTINCT FROM (OLD.org_id,OLD.user_id,OLD.http_method,OLD.normalized_path,OLD.key,OLD.request_hash,OLD.resource_id,OLD.expires_at) THEN RAISE EXCEPTION 'immutable upload outcome' USING ERRCODE='23514'; END IF;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER upload_outcome_immutable BEFORE UPDATE OR DELETE ON idempotency_records FOR EACH ROW EXECUTE FUNCTION preserve_upload_outcome();
REVOKE ALL ON FUNCTION preserve_upload_outcome() FROM PUBLIC;
