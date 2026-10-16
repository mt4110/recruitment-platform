-- S3 derivatives are separate immutable ciphertexts; old bytes/snapshots are retained.
ALTER TABLE encrypted_document_jobs ADD COLUMN view_ready boolean NOT NULL DEFAULT false;
ALTER TABLE document_artifacts DROP CONSTRAINT document_artifacts_reserved_bytes_check;
ALTER TABLE document_artifacts ALTER COLUMN reserved_bytes SET DEFAULT 1048576;
ALTER TABLE document_artifacts ADD CONSTRAINT document_artifacts_reserved_bytes_check CHECK(reserved_bytes BETWEEN 0 AND 73400320);
CREATE TABLE document_derivatives (
 id uuid PRIMARY KEY, document_id uuid NOT NULL REFERENCES encrypted_document_jobs(document_id),
 generation uuid NOT NULL, org_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('page','text','table')),
 page integer, stored boolean NOT NULL DEFAULT false, envelope jsonb NOT NULL, ciphertext_hash text NOT NULL CHECK(ciphertext_hash ~ '^[a-f0-9]{64}$'),
 ciphertext_size bigint NOT NULL CHECK(ciphertext_size BETWEEN 17 AND 8388624),
 CHECK((kind='page' AND page BETWEEN 1 AND 20) OR (kind IN ('text','table') AND page IS NULL)),
 UNIQUE(document_id,generation,kind,page)
);
CREATE UNIQUE INDEX derivative_nonpage ON document_derivatives(document_id,generation,kind) WHERE page IS NULL;
ALTER TABLE document_derivatives ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_derivatives FORCE ROW LEVEL SECURITY;
CREATE POLICY derivative_admin ON document_derivatives TO app_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON document_derivatives FROM PUBLIC,app_auth,app_runtime;
CREATE POLICY s3_checks_control ON document_checks TO app_migrator USING(true) WITH CHECK(true);
ALTER TABLE documents DROP CONSTRAINT original_metadata_known;
ALTER TABLE documents ADD CONSTRAINT original_metadata_known CHECK(
 (encrypted_transport AND ((status IN ('pending','rejected') AND original_name IS NULL AND sha256 IS NULL AND validated_at IS NULL)
 OR (status='ready' AND original_name IS NOT NULL AND sha256 IS NOT NULL AND validated_at IS NOT NULL)))
 OR (NOT encrypted_transport AND original_name IS NOT NULL AND sha256 IS NOT NULL));
CREATE OR REPLACE FUNCTION preserve_document() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'pending' OR NEW.created_by<>rp_user() OR NEW.legacy_document THEN RAISE EXCEPTION 'invalid document' USING ERRCODE='23514'; END IF;
 ELSE
  IF OLD.status<>'pending' OR (NEW.id,NEW.agency_org_id,NEW.candidate_id,NEW.created_by,NEW.storage_key,NEW.staging_key,NEW.size_bytes,NEW.created_at,NEW.file_format,NEW.media_type,NEW.document_kind,NEW.legacy_document) IS DISTINCT FROM (OLD.id,OLD.agency_org_id,OLD.candidate_id,OLD.created_by,OLD.storage_key,OLD.staging_key,OLD.size_bytes,OLD.created_at,OLD.file_format,OLD.media_type,OLD.document_kind,OLD.legacy_document) THEN RAISE EXCEPTION 'immutable document' USING ERRCODE='23514'; END IF;
  IF (NEW.original_name,NEW.sha256) IS DISTINCT FROM (OLD.original_name,OLD.sha256) AND NOT (current_user='app_migrator' AND OLD.encrypted_transport AND OLD.status='pending' AND NEW.status='ready' AND EXISTS(SELECT 1 FROM encrypted_document_jobs WHERE document_id=NEW.id AND view_ready AND original_hash=NEW.sha256 AND verified_name=NEW.original_name)) THEN RAISE EXCEPTION 'immutable document metadata' USING ERRCODE='23514';END IF;
  IF NEW.status='ready' AND NOT document_usable(NEW.id,NEW.sha256,NEW.file_format) THEN RAISE EXCEPTION 'missing full document check' USING ERRCODE='23514'; END IF;
 END IF; RETURN NEW;
END $$;
CREATE FUNCTION document_worker_s3_base(op text,d uuid,t uuid,p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j public.encrypted_document_jobs; original_attempt public.upload_attempts; upload_session_record public.upload_sessions; artifact uuid; result jsonb;
BEGIN
 IF op='claim' THEN
  PERFORM pg_advisory_xact_lock(72176312);
  IF EXISTS(SELECT 1 FROM public.encrypted_document_jobs WHERE state='processing' AND lease_expires_at>now()) THEN RETURN NULL;END IF;
  SELECT * INTO j FROM public.encrypted_document_jobs WHERE attempts<5 AND ((state IN ('pending','retryable') OR (state='checked' AND NOT view_ready)) OR (state='processing' AND lease_expires_at<=now())) AND EXISTS(SELECT 1 FROM public.upload_sessions s JOIN public.candidates c ON c.id=s.candidate_id JOIN public.users u ON u.id=s.user_id JOIN public.organizations o ON o.id=s.org_id WHERE s.document_id=encrypted_document_jobs.document_id AND s.state='attached' AND c.archived_at IS NULL AND u.active AND o.active) ORDER BY created_at,document_id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL;END IF;
  IF j.attempts>=5 THEN RETURN jsonb_build_object('paused',true);END IF;
  PERFORM pg_advisory_xact_lock(72176309);
  IF (SELECT coalesce(sum(physical_bytes),0) FROM public.upload_attempts)+(SELECT coalesce(sum(reserved_bytes),0) FROM public.document_admissions)+(SELECT coalesce(orphan_bytes,0) FROM public.document_storage_baseline)+(SELECT coalesce(sum(reserved_bytes),0) FROM public.document_artifacts)+1048576>1073741824 THEN RETURN jsonb_build_object('paused',true);END IF;
  UPDATE public.encrypted_document_jobs SET state='processing',view_ready=false,lease_token=gen_random_uuid(),generation=gen_random_uuid(),lease_expires_at=now()+interval '120 seconds',artifact_key_version=(SELECT version FROM public.document_key_versions WHERE purpose='artifact' AND enabled AND accept_upload),attempts=attempts+1,error_code=NULL,updated_at=now() WHERE document_id=j.document_id RETURNING * INTO j;
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
REVOKE ALL ON FUNCTION document_worker_s3_base(text,uuid,uuid,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION document_worker(op text,d uuid,t uuid,p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j public.encrypted_document_jobs; r jsonb; v jsonb; n bigint;
BEGIN
 IF op IN ('reserve_artifact','artifact') THEN
  SELECT * INTO j FROM public.encrypted_document_jobs WHERE document_id=d FOR UPDATE;
  PERFORM 1 FROM public.document_key_versions ORDER BY purpose,version FOR SHARE;
  IF NOT public.document_worker_valid(d,t) OR p->>'generation' IS DISTINCT FROM j.generation::text OR p->'artifact_envelope'->>'key_version' IS DISTINCT FROM j.artifact_key_version OR p->>'artifact_id'=j.artifact_id::text THEN RETURN NULL;END IF;
  IF op='artifact' THEN
   UPDATE public.document_derivatives SET stored=true WHERE id=(p->>'artifact_id')::uuid AND document_id=d AND generation=j.generation AND envelope=p->'artifact_envelope' AND ciphertext_hash=p->>'artifact_hash' AND ciphertext_size=(p->>'artifact_size')::bigint;
   IF NOT FOUND THEN RETURN NULL;END IF;RETURN '{}'::jsonb;
  END IF;
  PERFORM pg_advisory_xact_lock(72176309);
  IF (SELECT coalesce(sum(physical_bytes),0) FROM public.upload_attempts)+(SELECT coalesce(sum(reserved_bytes),0) FROM public.document_admissions)+(SELECT coalesce(orphan_bytes,0) FROM public.document_storage_baseline)+(SELECT coalesce(sum(reserved_bytes),0) FROM public.document_artifacts)+(p->>'artifact_size')::bigint>1073741824 THEN RETURN NULL;END IF;
  IF (SELECT count(*) FROM public.document_derivatives WHERE document_id=d AND generation=j.generation)>=21 OR (SELECT coalesce(sum(ciphertext_size),0) FROM public.document_derivatives WHERE document_id=d AND generation=j.generation)+(p->>'artifact_size')::bigint>68157776 THEN RETURN NULL;END IF;
  INSERT INTO public.document_derivatives(id,document_id,generation,org_id,kind,page,envelope,ciphertext_hash,ciphertext_size)
   VALUES((p->>'artifact_id')::uuid,d,j.generation,j.org_id,p->'artifact_envelope'->>'kind',(p->'artifact_envelope'->>'page')::integer,p->'artifact_envelope',p->>'artifact_hash',(p->>'artifact_size')::bigint);
  UPDATE public.document_artifacts SET reserved_bytes=reserved_bytes+(p->>'artifact_size')::bigint WHERE id=j.artifact_id;
  RETURN '{}'::jsonb;
 END IF;
 r:=public.document_worker_s3_base(op,d,t,p);
 IF r IS NULL OR op<>'commit' THEN RETURN r;END IF;
 SELECT * INTO j FROM public.encrypted_document_jobs WHERE document_id=d;
 v:=p->'view';
 IF v->>'format' NOT IN ('pdf','xlsx') OR jsonb_typeof(v->'artifacts') IS DISTINCT FROM 'array' OR jsonb_array_length(v->'artifacts') NOT BETWEEN 1 AND 21 THEN RAISE EXCEPTION 'invalid view manifest';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v->'artifacts') a WHERE NOT EXISTS(SELECT 1 FROM public.document_derivatives x WHERE x.id=(a->>'id')::uuid AND x.document_id=d AND x.generation=j.generation AND x.stored AND x.kind=a->>'kind' AND x.page IS NOT DISTINCT FROM (a->>'page')::integer AND x.ciphertext_hash=a->>'ciphertext_hash' AND x.envelope->>'plaintext_hash'=a->>'plaintext_hash')) THEN RAISE EXCEPTION 'view artifact mismatch';END IF;
 IF (SELECT count(*) FROM public.document_derivatives WHERE document_id=d AND generation=j.generation)<>jsonb_array_length(v->'artifacts') THEN RAISE EXCEPTION 'view count mismatch';END IF;
 IF v->>'format'='pdf' THEN
  n:=(v->>'pages')::integer;
  IF n NOT BETWEEN 1 AND 20 OR (SELECT count(*) FROM public.document_derivatives WHERE document_id=d AND generation=j.generation AND kind='page')<>n OR (SELECT count(*) FROM public.document_derivatives WHERE document_id=d AND generation=j.generation AND kind='text')<>1 OR EXISTS(SELECT 1 FROM generate_series(1,n) q WHERE NOT EXISTS(SELECT 1 FROM public.document_derivatives WHERE document_id=d AND generation=j.generation AND kind='page' AND page=q)) THEN RAISE EXCEPTION 'page manifest invalid';END IF;
 ELSE
  IF jsonb_array_length(v->'artifacts')<>1 OR NOT EXISTS(SELECT 1 FROM public.document_derivatives WHERE document_id=d AND generation=j.generation AND kind='table') THEN RAISE EXCEPTION 'table manifest invalid';END IF;
 END IF;
 UPDATE public.encrypted_document_jobs SET view_ready=true WHERE document_id=d;
 INSERT INTO public.document_checks(id,document_id,org_id,sha256,policy,verdict,engine_version,signature_version,signature_manifest,generation_id,actor_user_id)
 VALUES(gen_random_uuid(),d,j.org_id,j.original_hash,CASE v->>'format' WHEN 'pdf' THEN 'static-resume-v2' ELSE 'xlsx-resume-v1' END,'clean',p->'checks'->'scan'->>'engine_version',p->'checks'->'scan'->'databases'->'daily'->>'version',jsonb_build_object('databases',p->'checks'->'scan'->'databases','last_successful_check',p->'checks'->'scan'->'last_successful_check'),(p->'checks'->'scan'->>'generation_id')::uuid,j.user_id);
 UPDATE public.documents SET original_name=j.verified_name,sha256=j.original_hash,status='ready',validation_policy=CASE v->>'format' WHEN 'pdf' THEN 'static-resume-v2' ELSE 'xlsx-resume-v1' END,validated_at=now(),updated_at=now() WHERE id=d;
 UPDATE public.document_artifacts SET reserved_bytes=ciphertext_size+(SELECT coalesce(sum(ciphertext_size),0) FROM public.document_derivatives WHERE document_id=d AND generation=j.generation) WHERE id=j.artifact_id;
 UPDATE public.idempotency_records SET state='completed',result_status=201,expires_at=now()+interval '7 days' WHERE resource_id=d AND state='processing';
 RETURN r;
END $$;
REVOKE ALL ON FUNCTION document_worker(text,uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION document_worker(text,uuid,uuid,jsonb) TO app_auth;
-- Employer entry starts at its immutable application_documents selection.
CREATE POLICY s3_view_apps ON applications FOR SELECT TO app_migrator USING(true);
CREATE POLICY s3_view_selection ON application_documents FOR SELECT TO app_migrator USING(true);
CREATE FUNCTION safe_document_view(d uuid,a uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j public.encrypted_document_jobs; result jsonb;
BEGIN
 IF public.rp_user() IS NULL OR public.rp_org() IS NULL THEN RETURN NULL;END IF;
 IF a IS NULL THEN
  IF public.rp_kind()<>'agency' OR NOT EXISTS(SELECT 1 FROM public.documents doc JOIN public.candidates c ON c.id=doc.candidate_id WHERE doc.id=d AND doc.agency_org_id=public.rp_org() AND c.archived_at IS NULL) THEN RETURN NULL;END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM public.application_documents ad JOIN public.applications ap ON ap.id=ad.application_id WHERE ad.application_id=a AND ad.document_id=d AND ((public.rp_kind()='agency' AND ap.agency_org_id=public.rp_org()) OR (public.rp_kind()='employer' AND ap.employer_org_id=public.rp_org() AND ap.share_revoked_at IS NULL))) THEN RETURN NULL;END IF;
 END IF;
 SELECT * INTO j FROM public.encrypted_document_jobs WHERE document_id=d AND view_ready AND state='checked';
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.document_encryption e JOIN public.upload_attempts u ON u.id=e.attempt_id JOIN public.document_key_versions k ON k.purpose='original' AND k.version=u.wrap_version AND k.enabled WHERE e.document_id=d) OR NOT EXISTS(SELECT 1 FROM public.document_key_versions WHERE purpose='artifact' AND version=j.artifact_key_version AND enabled) OR EXISTS(SELECT 1 FROM public.document_checks WHERE document_id=d AND verdict='blocked') THEN RETURN NULL;END IF;
 SELECT jsonb_build_object('document_id',d,'org_id',j.org_id,'generation',j.generation,'original_hash',j.original_hash,'scan',j.check_result->'scan','public_spki',(SELECT public_spki FROM public.document_key_versions WHERE purpose='artifact' AND version=j.artifact_key_version),'artifacts',
 (SELECT jsonb_agg(x) FROM (SELECT id,envelope,ciphertext_hash AS hash,ciphertext_size AS size FROM public.document_artifacts WHERE id=j.artifact_id AND state='stored' UNION ALL SELECT id,envelope,ciphertext_hash,ciphertext_size FROM public.document_derivatives WHERE document_id=d AND generation=j.generation) x)) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION safe_document_view(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION safe_document_view(uuid,uuid) TO app_runtime;

CREATE FUNCTION safe_view_keys(d uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.encrypted_document_jobs j JOIN public.document_encryption e ON e.document_id=j.document_id JOIN public.upload_attempts a ON a.id=e.attempt_id JOIN public.document_key_versions k ON k.purpose='original' AND k.version=a.wrap_version AND k.enabled JOIN public.document_key_versions ak ON ak.purpose='artifact' AND ak.version=j.artifact_key_version AND ak.enabled WHERE j.document_id=d AND j.view_ready AND j.state='checked')
$$;
REVOKE ALL ON FUNCTION safe_view_keys(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION safe_view_keys(uuid) TO app_runtime;
CREATE FUNCTION document_transport_available(d uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.documents WHERE id=d AND (NOT encrypted_transport OR public.safe_view_keys(d)))
$$;
REVOKE ALL ON FUNCTION document_transport_available(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION document_transport_available(uuid) TO app_runtime;
ALTER FUNCTION document_usable(uuid,text,text) RENAME TO document_checks_usable;
CREATE FUNCTION document_usable(d uuid,h text,f text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT public.document_checks_usable(d,h,f) AND public.document_transport_available(d)
$$;
REVOKE ALL ON FUNCTION document_usable(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION document_usable(uuid,text,text) TO app_runtime;
