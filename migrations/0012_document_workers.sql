-- S2 can reject encrypted originals without publishing plaintext metadata.
ALTER TABLE documents DROP CONSTRAINT original_metadata_known;
ALTER TABLE documents ADD CONSTRAINT original_metadata_known CHECK(
 (encrypted_transport AND status IN ('pending','rejected') AND original_name IS NULL AND sha256 IS NULL AND validated_at IS NULL)
 OR (NOT encrypted_transport AND original_name IS NOT NULL AND sha256 IS NOT NULL));
-- S2: bounded control functions only; workers receive no database credentials.
CREATE TABLE document_key_versions (
 purpose text NOT NULL CHECK(purpose IN ('original','artifact')),
 version text NOT NULL CHECK(version ~ '^(original|artifact)-v[1-9][0-9]{0,3}$'),
 public_spki text NOT NULL CHECK(length(public_spki) BETWEEN 500 AND 2000),
 enabled boolean NOT NULL DEFAULT true, accept_upload boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(purpose,version), CHECK(version LIKE purpose||'-v%')
);
CREATE UNIQUE INDEX document_active_wrap ON document_key_versions(purpose) WHERE accept_upload;
REVOKE ALL ON document_key_versions FROM PUBLIC,app_runtime,app_auth;
ALTER TABLE document_key_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_key_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY key_admin ON document_key_versions TO app_migrator USING(true) WITH CHECK(true);
ALTER TABLE encrypted_document_jobs DROP CONSTRAINT encrypted_document_jobs_state_check;
ALTER TABLE encrypted_document_jobs ADD CONSTRAINT encrypted_document_jobs_state_check CHECK(state IN ('pending','processing','retryable','checked','rejected')),
 ADD COLUMN lease_token uuid, ADD COLUMN lease_expires_at timestamptz,
 ADD COLUMN generation uuid, ADD COLUMN artifact_key_version text, ADD COLUMN attempts integer NOT NULL DEFAULT 0,
 ADD COLUMN error_code text, ADD COLUMN verified_name text, ADD COLUMN original_hash text,
 ADD COLUMN check_result jsonb, ADD COLUMN artifact_id uuid, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX document_job_pending ON encrypted_document_jobs(state,lease_expires_at,created_at);
CREATE TABLE document_artifacts (
 id uuid PRIMARY KEY, document_id uuid NOT NULL REFERENCES encrypted_document_jobs(document_id),
 generation uuid NOT NULL UNIQUE, org_id uuid NOT NULL, user_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('reserved','stored')), reserved_bytes bigint NOT NULL DEFAULT 1048576 CHECK(reserved_bytes=1048576),
 envelope jsonb, ciphertext_hash text, ciphertext_size bigint CHECK(ciphertext_size BETWEEN 17 AND 262160),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(document_id,org_id,user_id) REFERENCES document_encryption(document_id,org_id,user_id)
);
ALTER TABLE document_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY artifact_owner ON document_artifacts FOR SELECT TO app_runtime USING(rp_kind()='agency' AND org_id=rp_org() AND user_id=rp_user());
GRANT SELECT ON document_artifacts TO app_runtime;
CREATE TABLE document_worker_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,document_id uuid NOT NULL, generation uuid,
 event text NOT NULL CHECK(event IN ('claimed','authorized','checked','retryable','rejected','denied')),
 created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON document_worker_events FROM PUBLIC,app_runtime,app_auth;
-- FORCE RLS applies to the function owner too. Access exists only through the
-- audited functions below; app_auth has no table privileges for worker data.
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['users','organizations','candidates','documents','upload_sessions','upload_attempts','document_encryption','encrypted_document_jobs','document_artifacts','idempotency_records'] LOOP
 EXECUTE format('CREATE POLICY document_worker_control ON %I TO app_migrator USING(true) WITH CHECK(true)',t);
END LOOP; END $$;
CREATE FUNCTION document_worker_valid(d uuid,t uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.encrypted_document_jobs j
 JOIN public.documents doc ON doc.id=j.document_id JOIN public.candidates c ON c.id=doc.candidate_id AND c.agency_org_id=j.org_id
 JOIN public.users u ON u.id=j.user_id AND u.organization_id=j.org_id JOIN public.organizations o ON o.id=j.org_id
 JOIN public.document_encryption e ON e.document_id=j.document_id JOIN public.upload_attempts a ON a.id=e.attempt_id
 JOIN public.upload_sessions s ON s.id=a.upload_id AND s.canonical_attempt=a.id
 JOIN public.idempotency_records r ON r.resource_id=doc.id AND r.org_id=j.org_id AND r.user_id=j.user_id AND r.state='processing'
 JOIN public.document_key_versions k ON k.purpose='original' AND k.version=a.wrap_version AND k.enabled
 JOIN public.document_key_versions ak ON ak.purpose='artifact' AND ak.version=j.artifact_key_version AND ak.enabled
 WHERE j.document_id=d AND j.lease_token=t AND j.state='processing' AND j.lease_expires_at>now()
 AND doc.status='pending' AND doc.encrypted_transport AND u.active AND o.active AND o.kind='agency' AND c.archived_at IS NULL AND s.document_id=doc.id AND s.candidate_id=doc.candidate_id AND s.state='attached' AND a.state='attached')
$$;
REVOKE ALL ON FUNCTION document_worker_valid(uuid,uuid) FROM PUBLIC;
CREATE FUNCTION document_worker(op text,d uuid,t uuid,p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j public.encrypted_document_jobs; original_attempt public.upload_attempts; upload_session_record public.upload_sessions; artifact uuid; result jsonb;
BEGIN
 IF op='claim' THEN
  PERFORM pg_advisory_xact_lock(72176312);
  IF EXISTS(SELECT 1 FROM public.encrypted_document_jobs WHERE state='processing' AND lease_expires_at>now()) THEN RETURN NULL;END IF;
  SELECT * INTO j FROM public.encrypted_document_jobs WHERE attempts<5 AND (state IN ('pending','retryable') OR (state='processing' AND lease_expires_at<=now())) AND EXISTS(SELECT 1 FROM public.upload_sessions s JOIN public.candidates c ON c.id=s.candidate_id JOIN public.users u ON u.id=s.user_id JOIN public.organizations o ON o.id=s.org_id WHERE s.document_id=encrypted_document_jobs.document_id AND s.state='attached' AND c.archived_at IS NULL AND u.active AND o.active) ORDER BY created_at,document_id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL;END IF;
  IF j.attempts>=5 THEN RETURN jsonb_build_object('paused',true);END IF;
  PERFORM pg_advisory_xact_lock(72176309);
  IF (SELECT coalesce(sum(physical_bytes),0) FROM public.upload_attempts)+(SELECT coalesce(sum(reserved_bytes),0) FROM public.document_admissions)+(SELECT coalesce(orphan_bytes,0) FROM public.document_storage_baseline)+(SELECT coalesce(sum(reserved_bytes),0) FROM public.document_artifacts)+1048576>1073741824 THEN RETURN jsonb_build_object('paused',true);END IF;
  UPDATE public.encrypted_document_jobs SET state='processing',lease_token=gen_random_uuid(),generation=gen_random_uuid(),lease_expires_at=now()+interval '120 seconds',artifact_key_version=(SELECT version FROM public.document_key_versions WHERE purpose='artifact' AND enabled AND accept_upload),attempts=attempts+1,error_code=NULL,updated_at=now() WHERE document_id=j.document_id RETURNING * INTO j;
  IF NOT public.document_worker_valid(j.document_id,j.lease_token) THEN
   UPDATE public.encrypted_document_jobs SET state='retryable',error_code='AUTHORITY_UNAVAILABLE',lease_expires_at=now() WHERE document_id=j.document_id;
   INSERT INTO public.document_worker_events(document_id,generation,event) VALUES(j.document_id,j.generation,'denied');
   RETURN jsonb_build_object('paused',true);
  END IF;
  artifact:=gen_random_uuid();
  INSERT INTO public.document_artifacts(id,document_id,generation,org_id,user_id,state) VALUES(artifact,j.document_id,j.generation,j.org_id,j.user_id,'reserved');
  UPDATE public.encrypted_document_jobs SET artifact_id=artifact WHERE document_id=j.document_id;
  INSERT INTO public.document_worker_events(document_id,generation,event) VALUES(j.document_id,j.generation,'claimed');
  SELECT * INTO original_attempt FROM public.upload_attempts WHERE id=(SELECT attempt_id FROM public.document_encryption WHERE document_id=j.document_id);
  SELECT * INTO upload_session_record FROM public.upload_sessions WHERE id=original_attempt.upload_id;
  RETURN jsonb_build_object('upload_id',upload_session_record.id,'document_id',j.document_id,'org_id',j.org_id,'attempt_id',original_attempt.id,'lease_token',j.lease_token,'generation',j.generation,'artifact_id',artifact,'plain_length',upload_session_record.plain_length,'file_format',upload_session_record.file_format,'ciphertext_hash',original_attempt.ciphertext_hash,'ciphertext_size',original_attempt.ciphertext_size,'original_public_spki',(SELECT public_spki FROM public.document_key_versions WHERE purpose='original' AND version=original_attempt.wrap_version),'envelope',original_attempt.envelope,'artifact_version',j.artifact_key_version,'artifact_public_spki',(SELECT public_spki FROM public.document_key_versions WHERE purpose='artifact' AND version=j.artifact_key_version));
 END IF;
 SELECT * INTO j FROM public.encrypted_document_jobs WHERE document_id=d FOR UPDATE;
 IF NOT FOUND OR j.lease_token IS DISTINCT FROM t OR j.state<>'processing' OR j.lease_expires_at<=now() THEN RETURN NULL;END IF;
 IF op='retry' THEN
  UPDATE public.encrypted_document_jobs SET state='retryable',error_code='WORKER_UNAVAILABLE',lease_expires_at=now(),updated_at=now() WHERE document_id=d;
  INSERT INTO public.document_worker_events(document_id,generation,event) VALUES(d,j.generation,'retryable');RETURN '{}'::jsonb;
 END IF;
 -- Serialize current ownership and key revocation against all final decisions.
 PERFORM 1 FROM public.users WHERE id=j.user_id FOR SHARE;
 PERFORM 1 FROM public.organizations WHERE id=j.org_id FOR SHARE;
 PERFORM 1 FROM public.candidates WHERE id=(SELECT candidate_id FROM public.documents WHERE id=d) FOR SHARE;
 PERFORM 1 FROM public.document_key_versions ORDER BY purpose,version FOR SHARE;
 IF NOT public.document_worker_valid(d,t) THEN RETURN NULL;END IF;
 IF op='authorize' THEN
  INSERT INTO public.document_worker_events(document_id,generation,event) VALUES(d,j.generation,'authorized');
  RETURN jsonb_build_object('artifact_version',j.artifact_key_version,'artifact_id',j.artifact_id,'generation',j.generation,'org_id',j.org_id,'staging_key',(SELECT a.staging_key FROM public.upload_attempts a JOIN public.document_encryption e ON e.attempt_id=a.id WHERE e.document_id=d));
 ELSIF op='reject' THEN
  IF p->>'code' NOT IN ('CRYPTO_REJECTED','METADATA_REJECTED','AV_BLOCKED','FORMAT_REJECTED') THEN RETURN NULL;END IF;
  UPDATE public.encrypted_document_jobs SET state='rejected',error_code=p->>'code',lease_expires_at=now(),updated_at=now() WHERE document_id=d;
  UPDATE public.documents SET status='rejected',rejection_code=p->>'code',updated_at=now() WHERE id=d AND status='pending';
  UPDATE public.upload_sessions SET state='rejected' WHERE document_id=d;
  UPDATE public.idempotency_records SET state='failed',result_status=422,error_code=p->>'code',expires_at=now()+interval '7 days' WHERE resource_id=d AND state='processing';
  INSERT INTO public.document_worker_events(document_id,generation,event) VALUES(d,j.generation,'rejected');RETURN '{}'::jsonb;
 ELSIF op='commit' THEN
  IF coalesce(p->>'sha256','') !~ '^[0-9a-f]{64}$' OR coalesce(length(p->>'original_name'),0) NOT BETWEEN 1 AND 255 OR p->>'artifact_id' IS DISTINCT FROM j.artifact_id::text OR p->>'generation' IS DISTINCT FROM j.generation::text THEN RETURN NULL;END IF;
  UPDATE public.document_artifacts SET state='stored',envelope=p->'artifact_envelope',ciphertext_hash=p->>'artifact_hash',ciphertext_size=(p->>'artifact_size')::bigint WHERE id=j.artifact_id AND state='reserved';
  IF NOT FOUND THEN RETURN NULL;END IF;
  UPDATE public.encrypted_document_jobs SET state='checked',verified_name=p->>'original_name',original_hash=p->>'sha256',check_result=p->'checks',lease_expires_at=now(),updated_at=now() WHERE document_id=d;
  INSERT INTO public.document_worker_events(document_id,generation,event) VALUES(d,j.generation,'checked');RETURN '{}'::jsonb;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION document_worker(text,uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION document_worker(text,uuid,uuid,jsonb) TO app_auth;
-- Account retained artifacts in both upload admissions; never reclaim on timeout.
CREATE OR REPLACE FUNCTION encrypted_upload_capacity(n bigint) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF public.rp_org() IS NULL OR public.rp_user() IS NULL OR n<0 OR n>10551296 THEN RAISE EXCEPTION 'invalid admission';END IF;
 PERFORM pg_advisory_xact_lock(72176309);
 RETURN (SELECT coalesce(sum(reserved_bytes),0) FROM public.document_admissions)+(SELECT coalesce(orphan_bytes,0) FROM public.document_storage_baseline)+(SELECT coalesce(sum(physical_bytes),0) FROM public.upload_attempts)+(SELECT coalesce(sum(reserved_bytes),0) FROM public.document_artifacts)+n<=1073741824;
END $$;

CREATE OR REPLACE FUNCTION document_admit(receipt uuid) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE u uuid:=public.rp_user(); o uuid:=public.rp_org();
BEGIN
 IF u IS NULL OR o IS NULL THEN RAISE EXCEPTION 'identity required';END IF;
 PERFORM pg_advisory_xact_lock(72176309);
 IF (SELECT count(*) FROM public.document_admissions WHERE user_id=u AND created_at>now()-interval '1 minute')>=10 OR
 (SELECT count(*) FROM public.document_admissions WHERE org_id=o AND created_at>now()-interval '1 minute')>=30 THEN RETURN 'rate';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.document_storage_baseline) THEN RETURN 'unreconciled';END IF;
 IF (SELECT coalesce(sum(reserved_bytes),0) FROM public.document_admissions WHERE org_id=o)+(SELECT orphan_bytes FROM public.document_storage_baseline)+10551296>536870912 OR
 (SELECT coalesce(sum(reserved_bytes),0) FROM public.document_admissions)+(SELECT orphan_bytes FROM public.document_storage_baseline)+(SELECT coalesce(sum(physical_bytes),0) FROM public.upload_attempts)+(SELECT coalesce(sum(reserved_bytes),0) FROM public.document_artifacts)+10551296>1073741824 THEN RETURN 'quota';END IF;
 INSERT INTO public.document_admissions(id,org_id,user_id,reserved_bytes) VALUES(receipt,o,u,10551296);
 RETURN 'ok';
END $$;
CREATE FUNCTION upload_wrap_enabled(v text) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT EXISTS(SELECT 1 FROM public.document_key_versions WHERE purpose='original' AND version=v AND enabled) $$;
REVOKE ALL ON FUNCTION upload_wrap_enabled(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION upload_wrap_enabled(text) TO app_runtime;

CREATE FUNCTION upload_wrap_current() RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT version FROM public.document_key_versions WHERE purpose='original' AND enabled AND accept_upload $$;
CREATE FUNCTION upload_wrap_public(v text) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT public_spki FROM public.document_key_versions WHERE purpose='original' AND version=v $$;
REVOKE ALL ON FUNCTION upload_wrap_current(),upload_wrap_public(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION upload_wrap_current(),upload_wrap_public(text) TO app_runtime;

CREATE TABLE document_key_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,purpose text NOT NULL,version text NOT NULL,action text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
REVOKE ALL ON document_key_events FROM PUBLIC,app_auth,app_runtime;
