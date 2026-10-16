-- S1 transport only. Original metadata is unknown until isolated S2 decryption.
ALTER TABLE documents ADD COLUMN encrypted_transport boolean NOT NULL DEFAULT false;
ALTER TABLE documents ALTER COLUMN original_name DROP NOT NULL;
ALTER TABLE documents ALTER COLUMN sha256 DROP NOT NULL;
ALTER TABLE documents ADD CONSTRAINT original_metadata_known CHECK (
 (encrypted_transport AND status='pending' AND original_name IS NULL AND sha256 IS NULL AND validated_at IS NULL)
 OR (NOT encrypted_transport AND original_name IS NOT NULL AND sha256 IS NOT NULL));
CREATE TABLE upload_sessions (
 id uuid PRIMARY KEY, document_id uuid UNIQUE NOT NULL, org_id uuid NOT NULL REFERENCES organizations(id), user_id uuid NOT NULL REFERENCES users(id),
 candidate_id uuid NOT NULL, operation_key uuid NOT NULL, request_hash bytea NOT NULL,
 document_kind text NOT NULL CHECK(document_kind IN ('resume','career_history','other')),
 file_format text NOT NULL CHECK(file_format IN ('pdf','xlsx')), plain_length bigint NOT NULL CHECK(plain_length BETWEEN 1 AND 10485760),
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','received','attached','rejected')),
 reserved_at timestamptz NOT NULL DEFAULT now(), canonical_attempt uuid, UNIQUE(org_id,user_id,candidate_id,operation_key),
 FOREIGN KEY(candidate_id,org_id) REFERENCES candidates(id,agency_org_id)
);
CREATE INDEX upload_org_unresolved ON upload_sessions(org_id,state,reserved_at);
CREATE TABLE upload_attempts (
 id uuid PRIMARY KEY, upload_id uuid NOT NULL REFERENCES upload_sessions(id), org_id uuid NOT NULL, user_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','authorized','receiving','reconciling','stored','attached','closed')),
 wrap_version text NOT NULL, aad text NOT NULL, staging_key uuid UNIQUE NOT NULL,
 ciphertext_hash text, ciphertext_size bigint CHECK(ciphertext_size BETWEEN 21 AND 10489876), envelope jsonb, envelope_hash text,
 first_authorized_at timestamptz, lease_token uuid, receive_deadline timestamptz, stored_at timestamptz,
 physical_bytes bigint NOT NULL DEFAULT 0 CHECK(physical_bytes>=0), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX upload_attempt_session ON upload_attempts(upload_id,created_at,id);
CREATE TABLE document_encryption (
 document_id uuid PRIMARY KEY REFERENCES documents(id), attempt_id uuid UNIQUE NOT NULL REFERENCES upload_attempts(id),
 org_id uuid NOT NULL, user_id uuid NOT NULL, schema_version integer NOT NULL CHECK(schema_version=1)
);
CREATE TABLE encrypted_document_jobs (
 document_id uuid PRIMARY KEY REFERENCES document_encryption(document_id), org_id uuid NOT NULL,user_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state='pending'),created_at timestamptz NOT NULL DEFAULT now()
);
-- Scope includes the original user, not just the organization.
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['upload_sessions','upload_attempts','document_encryption','encrypted_document_jobs'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY upload_owner ON %I TO app_runtime USING (rp_kind()=''agency'' AND org_id=rp_org() AND user_id=rp_user()) WITH CHECK (rp_kind()=''agency'' AND org_id=rp_org() AND user_id=rp_user())',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO app_runtime',t);
 END LOOP; END $$;
-- Quota decisions are globally serialized. All attempts, including orphans, remain charged.
CREATE FUNCTION encrypted_upload_capacity(n bigint) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF public.rp_org() IS NULL OR public.rp_user() IS NULL OR n<0 OR n>10551296 THEN RAISE EXCEPTION 'invalid admission'; END IF;
 PERFORM pg_advisory_xact_lock(72176309);
 RETURN (SELECT coalesce(sum(reserved_bytes),0) FROM public.document_admissions)
  +(SELECT coalesce(orphan_bytes,0) FROM public.document_storage_baseline)
  +(SELECT coalesce(sum(physical_bytes),0) FROM public.upload_attempts)+n<=1073741824;
END $$;
REVOKE ALL ON FUNCTION encrypted_upload_capacity(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION encrypted_upload_capacity(bigint) TO app_runtime;
CREATE POLICY encrypted_capacity ON upload_attempts FOR SELECT TO app_migrator USING(true);
-- Result retention is exclusively idempotency_records; 202 is not terminal success.
CREATE OR REPLACE FUNCTION preserve_upload_outcome() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.http_method='POST' AND OLD.normalized_path ~ '^/api/v1/candidates/[0-9a-f-]{36}/documents$' AND OLD.state IN ('completed','failed','expired') THEN
  IF TG_OP='DELETE' OR NEW.state<>'expired' OR (NEW.org_id,NEW.user_id,NEW.http_method,NEW.normalized_path,NEW.key,NEW.request_hash,NEW.resource_id,NEW.expires_at) IS DISTINCT FROM (OLD.org_id,OLD.user_id,OLD.http_method,OLD.normalized_path,OLD.key,OLD.request_hash,OLD.resource_id,OLD.expires_at) THEN RAISE EXCEPTION 'immutable upload outcome' USING ERRCODE='23514'; END IF;
 END IF; RETURN NEW;
END $$;
CREATE POLICY encrypted_org_quota ON upload_sessions FOR SELECT TO app_migrator USING(true);
CREATE FUNCTION encrypted_upload_org_capacity(n bigint) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF public.rp_kind()<>'agency' OR n<1 OR n>10485760 THEN RAISE EXCEPTION 'invalid admission'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('s1-org:'||public.rp_org()::text,72176310));
 RETURN (SELECT count(*)<10 AND coalesce(sum(plain_length),0)+n<=104857600 FROM public.upload_sessions WHERE org_id=public.rp_org() AND state IN ('reserved','received','attached'));
END $$;
REVOKE ALL ON FUNCTION encrypted_upload_org_capacity(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION encrypted_upload_org_capacity(bigint) TO app_runtime;
REVOKE UPDATE ON upload_sessions,upload_attempts,document_encryption,encrypted_document_jobs FROM app_runtime;
GRANT UPDATE(state,canonical_attempt) ON upload_sessions TO app_runtime;
GRANT UPDATE(state,ciphertext_hash,ciphertext_size,envelope,envelope_hash,first_authorized_at,lease_token,receive_deadline,stored_at,physical_bytes) ON upload_attempts TO app_runtime;
CREATE FUNCTION preserve_upload_attempt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.state<>'prepared' AND (NEW.ciphertext_hash,NEW.ciphertext_size,NEW.envelope,NEW.envelope_hash,NEW.first_authorized_at,NEW.physical_bytes) IS DISTINCT FROM (OLD.ciphertext_hash,OLD.ciphertext_size,OLD.envelope,OLD.envelope_hash,OLD.first_authorized_at,OLD.physical_bytes) THEN RAISE EXCEPTION 'immutable ciphertext';END IF;
 IF OLD.state IN ('stored','attached') AND NEW.state NOT IN ('stored','attached') THEN RAISE EXCEPTION 'stored attempt';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER upload_attempt_immutable BEFORE UPDATE ON upload_attempts FOR EACH ROW EXECUTE FUNCTION preserve_upload_attempt();
REVOKE ALL ON FUNCTION preserve_upload_attempt() FROM PUBLIC;

CREATE OR REPLACE FUNCTION document_admit(receipt uuid) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE u uuid:=public.rp_user(); o uuid:=public.rp_org();
BEGIN
 IF u IS NULL OR o IS NULL THEN RAISE EXCEPTION 'identity required';END IF;
 PERFORM pg_advisory_xact_lock(72176309);
 IF (SELECT count(*) FROM public.document_admissions WHERE user_id=u AND created_at>now()-interval '1 minute')>=10 OR
 (SELECT count(*) FROM public.document_admissions WHERE org_id=o AND created_at>now()-interval '1 minute')>=30 THEN RETURN 'rate';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.document_storage_baseline) THEN RETURN 'unreconciled';END IF;
 IF (SELECT coalesce(sum(reserved_bytes),0) FROM public.document_admissions WHERE org_id=o)+(SELECT orphan_bytes FROM public.document_storage_baseline)+10551296>536870912 OR
 (SELECT coalesce(sum(reserved_bytes),0) FROM public.document_admissions)+(SELECT orphan_bytes FROM public.document_storage_baseline)+(SELECT coalesce(sum(physical_bytes),0) FROM public.upload_attempts)+10551296>1073741824 THEN RETURN 'quota';END IF;
 INSERT INTO public.document_admissions(id,org_id,user_id,reserved_bytes) VALUES(receipt,o,u,10551296);
 RETURN 'ok';
END $$;
