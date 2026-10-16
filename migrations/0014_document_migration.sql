-- S4 adds an immutable mapping. Original rows, original files and selected snapshots stay intact.
CREATE TABLE document_migrations (
 document_id uuid PRIMARY KEY, org_id uuid NOT NULL, user_id uuid NOT NULL,
 migration_id uuid NOT NULL UNIQUE, staging_key uuid NOT NULL UNIQUE,
 source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
 wrap_version text NOT NULL, envelope jsonb NOT NULL, ciphertext_hash text NOT NULL CHECK(ciphertext_hash ~ '^[a-f0-9]{64}$'),
 ciphertext_size bigint NOT NULL CHECK(ciphertext_size BETWEEN 21 AND 10489876),
 state text NOT NULL CHECK(state IN ('reserved','stored','ready','rejected')),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(document_id,org_id,user_id) REFERENCES documents(id,agency_org_id,created_by),
 FOREIGN KEY(migration_id) REFERENCES document_admissions(id)
);
ALTER TABLE document_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_migrations FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_admin ON document_migrations TO app_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON document_migrations FROM PUBLIC,app_auth,app_runtime;
-- Keep the same composite ownership FK for both browser uploads and operator migration.
ALTER TABLE encrypted_document_jobs DROP CONSTRAINT encrypted_document_jobs_document_id_fkey;
ALTER TABLE encrypted_document_jobs DROP CONSTRAINT encrypted_job_owned_document;
ALTER TABLE encrypted_document_jobs ADD CONSTRAINT encrypted_job_owned_document FOREIGN KEY(document_id,org_id,user_id) REFERENCES documents(id,agency_org_id,created_by);
ALTER TABLE document_artifacts DROP CONSTRAINT document_artifacts_document_id_org_id_user_id_fkey;
ALTER TABLE document_artifacts ADD CONSTRAINT artifact_owned_document FOREIGN KEY(document_id,org_id,user_id) REFERENCES documents(id,agency_org_id,created_by);
CREATE TABLE document_cutover(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), legacy_open boolean NOT NULL DEFAULT true);
INSERT INTO document_cutover VALUES(true,true);
REVOKE ALL ON document_cutover FROM PUBLIC,app_runtime,app_auth;
CREATE FUNCTION legacy_upload_open() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT legacy_open FROM public.document_cutover WHERE singleton $$;
REVOKE ALL ON FUNCTION legacy_upload_open() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION legacy_upload_open() TO app_runtime,app_auth;
-- Input context is private to the control plane, never granted to tenants.
CREATE FUNCTION document_worker_source(d uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('source','upload','upload_id',s.id,'attempt_id',a.id,'plain_length',s.plain_length,'file_format',s.file_format,'ciphertext_hash',a.ciphertext_hash,'ciphertext_size',a.ciphertext_size,'envelope',a.envelope,'staging_key',a.staging_key,'original_public_spki',k.public_spki)
 FROM public.document_encryption e JOIN public.upload_attempts a ON a.id=e.attempt_id JOIN public.upload_sessions s ON s.id=a.upload_id AND s.canonical_attempt=a.id JOIN public.document_key_versions k ON k.purpose='original' AND k.version=a.wrap_version AND k.enabled
 WHERE e.document_id=d AND s.state='attached' AND a.state='attached'
 UNION ALL
 SELECT jsonb_build_object('source','migration','migration_id',m.migration_id,'plain_length',doc.size_bytes,'file_format',doc.file_format,'ciphertext_hash',m.ciphertext_hash,'ciphertext_size',m.ciphertext_size,'envelope',m.envelope,'staging_key',m.staging_key,'original_public_spki',k.public_spki)
 FROM public.document_migrations m JOIN public.documents doc ON doc.id=m.document_id AND NOT doc.encrypted_transport AND doc.status='ready' AND doc.sha256=m.source_hash JOIN public.document_key_versions k ON k.purpose='original' AND k.version=m.wrap_version AND k.enabled
 WHERE m.document_id=d AND m.state IN ('stored','ready')
$$;
REVOKE ALL ON FUNCTION document_worker_source(uuid) FROM PUBLIC;
CREATE OR REPLACE FUNCTION document_worker_valid(d uuid,t uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.encrypted_document_jobs j
 JOIN public.documents doc ON doc.id=j.document_id JOIN public.candidates c ON c.id=doc.candidate_id AND c.agency_org_id=j.org_id
 JOIN public.users u ON u.id=j.user_id AND u.organization_id=j.org_id JOIN public.organizations o ON o.id=j.org_id
 JOIN public.document_encryption e ON e.document_id=j.document_id JOIN public.upload_attempts a ON a.id=e.attempt_id
 JOIN public.upload_sessions s ON s.id=a.upload_id AND s.canonical_attempt=a.id
 JOIN public.idempotency_records r ON r.resource_id=doc.id AND r.org_id=j.org_id AND r.user_id=j.user_id AND r.state='processing'
 JOIN public.document_key_versions k ON k.purpose='original' AND k.version=a.wrap_version AND k.enabled
 JOIN public.document_key_versions ak ON ak.purpose='artifact' AND ak.version=j.artifact_key_version AND ak.enabled
 WHERE j.document_id=d AND j.lease_token=t AND j.state='processing' AND j.lease_expires_at>now()
 AND doc.status='pending' AND doc.encrypted_transport AND u.active AND o.active AND o.kind='agency' AND c.archived_at IS NULL AND s.document_id=doc.id AND s.candidate_id=doc.candidate_id AND s.state='attached' AND a.state='attached') OR EXISTS(SELECT 1 FROM public.encrypted_document_jobs j JOIN public.document_migrations m ON m.document_id=j.document_id JOIN public.documents doc ON doc.id=j.document_id JOIN public.candidates c ON c.id=doc.candidate_id AND c.agency_org_id=j.org_id JOIN public.users u ON u.id=j.user_id AND u.organization_id=j.org_id JOIN public.organizations o ON o.id=j.org_id JOIN public.document_key_versions ak ON ak.purpose='artifact' AND ak.version=j.artifact_key_version AND ak.enabled WHERE j.document_id=d AND j.lease_token=t AND j.state='processing' AND j.lease_expires_at>now() AND m.state='stored' AND doc.status='ready' AND NOT doc.encrypted_transport AND doc.sha256=m.source_hash AND public.document_worker_source(d) IS NOT NULL AND u.active AND o.active AND o.kind='agency' AND c.archived_at IS NULL)
$$;
REVOKE ALL ON FUNCTION document_worker_valid(uuid,uuid) FROM PUBLIC;
CREATE OR REPLACE FUNCTION document_worker_s3_base(op text,d uuid,t uuid,p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j public.encrypted_document_jobs; original_attempt public.upload_attempts; upload_session_record public.upload_sessions; artifact uuid; result jsonb;
BEGIN
 IF op='claim' THEN
  PERFORM pg_advisory_xact_lock(72176312);
  IF EXISTS(SELECT 1 FROM public.encrypted_document_jobs WHERE state='processing' AND lease_expires_at>now()) THEN RETURN NULL;END IF;
  SELECT * INTO j FROM public.encrypted_document_jobs WHERE attempts<5 AND ((state IN ('pending','retryable') OR (state='checked' AND NOT view_ready)) OR (state='processing' AND lease_expires_at<=now())) AND public.document_worker_source(document_id) IS NOT NULL AND EXISTS(SELECT 1 FROM public.documents doc JOIN public.candidates c ON c.id=doc.candidate_id JOIN public.users u ON u.id=doc.created_by JOIN public.organizations o ON o.id=doc.agency_org_id WHERE doc.id=encrypted_document_jobs.document_id AND u.active AND o.active AND c.archived_at IS NULL) ORDER BY created_at,document_id LIMIT 1 FOR UPDATE SKIP LOCKED;
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
  RETURN public.document_worker_source(j.document_id)||jsonb_build_object('document_id',j.document_id,'org_id',j.org_id,'lease_token',j.lease_token,'generation',j.generation,'artifact_id',artifact,'artifact_version',j.artifact_key_version,'artifact_public_spki',(SELECT public_spki FROM public.document_key_versions WHERE purpose='artifact' AND version=j.artifact_key_version));
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
  RETURN jsonb_build_object('artifact_version',j.artifact_key_version,'artifact_id',j.artifact_id,'generation',j.generation,'org_id',j.org_id,'staging_key',(public.document_worker_source(d)->>'staging_key')::uuid);
 ELSIF op='reject' THEN
  IF p->>'code' NOT IN ('CRYPTO_REJECTED','METADATA_REJECTED','AV_BLOCKED','FORMAT_REJECTED') THEN RETURN NULL;END IF;
  UPDATE public.encrypted_document_jobs SET state='rejected',error_code=p->>'code',lease_expires_at=now(),updated_at=now() WHERE document_id=d;
  UPDATE public.document_migrations SET state='rejected' WHERE document_id=d;
  UPDATE public.documents SET status='rejected',rejection_code=p->>'code',updated_at=now() WHERE id=d AND status='pending';
  UPDATE public.upload_sessions SET state='rejected' WHERE document_id=d;
  UPDATE public.idempotency_records SET state='failed',result_status=422,error_code=p->>'code',expires_at=now()+interval '7 days' WHERE resource_id=d AND state='processing';
  INSERT INTO public.document_worker_events(document_id,generation,event) VALUES(d,j.generation,'rejected');RETURN '{}'::jsonb;
 ELSIF op='commit' THEN
  IF EXISTS(SELECT 1 FROM public.document_migrations WHERE document_id=d AND source_hash IS DISTINCT FROM p->>'sha256') THEN RETURN NULL;END IF;
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
 UPDATE public.documents SET original_name=j.verified_name,sha256=j.original_hash,status='ready',validation_policy=CASE v->>'format' WHEN 'pdf' THEN 'static-resume-v2' ELSE 'xlsx-resume-v1' END,validated_at=now(),updated_at=now() WHERE id=d AND NOT EXISTS(SELECT 1 FROM public.document_migrations WHERE document_id=d);
 UPDATE public.document_migrations SET state='ready' WHERE document_id=d;
 UPDATE public.document_artifacts SET reserved_bytes=ciphertext_size+(SELECT coalesce(sum(ciphertext_size),0) FROM public.document_derivatives WHERE document_id=d AND generation=j.generation) WHERE id=j.artifact_id;
 UPDATE public.idempotency_records SET state='completed',result_status=201,expires_at=now()+interval '7 days' WHERE resource_id=d AND state='processing' AND NOT EXISTS(SELECT 1 FROM public.document_migrations WHERE document_id=d);
 RETURN r;
END $$;
REVOKE ALL ON FUNCTION document_worker(text,uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION document_worker(text,uuid,uuid,jsonb) TO app_auth;
CREATE OR REPLACE FUNCTION safe_document_view(d uuid,a uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
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
 IF a IS NOT NULL AND EXISTS(SELECT 1 FROM public.application_documents ad WHERE ad.application_id=a AND ad.document_id=d AND ad.sha256_snapshot IS DISTINCT FROM j.original_hash) THEN RETURN NULL;END IF;
 IF NOT public.safe_view_keys(d) OR EXISTS(SELECT 1 FROM public.document_checks WHERE document_id=d AND verdict='blocked') THEN RETURN NULL;END IF;
 SELECT jsonb_build_object('document_id',d,'org_id',j.org_id,'generation',j.generation,'original_hash',j.original_hash,'scan',j.check_result->'scan','public_spki',(SELECT public_spki FROM public.document_key_versions WHERE purpose='artifact' AND version=j.artifact_key_version),'artifacts',
 (SELECT jsonb_agg(x) FROM (SELECT id,envelope,ciphertext_hash AS hash,ciphertext_size AS size FROM public.document_artifacts WHERE id=j.artifact_id AND state='stored' UNION ALL SELECT id,envelope,ciphertext_hash,ciphertext_size FROM public.document_derivatives WHERE document_id=d AND generation=j.generation) x)) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION safe_document_view(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION safe_document_view(uuid,uuid) TO app_runtime;

CREATE OR REPLACE FUNCTION safe_view_keys(d uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.encrypted_document_jobs j JOIN public.document_key_versions ak ON ak.purpose='artifact' AND ak.version=j.artifact_key_version AND ak.enabled WHERE j.document_id=d AND j.view_ready AND j.state='checked' AND public.document_worker_source(d) IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.document_migrations m WHERE m.document_id=d AND m.state<>'ready'))
$$;
REVOKE ALL ON FUNCTION safe_view_keys(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION safe_view_keys(uuid) TO app_runtime;

CREATE OR REPLACE FUNCTION document_transport_available(d uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.documents WHERE id=d AND ((NOT encrypted_transport AND public.legacy_upload_open() AND NOT EXISTS(SELECT 1 FROM public.document_migrations m WHERE m.document_id=d)) OR public.safe_view_keys(d)))
$$;

CREATE FUNCTION enforce_encrypted_cutover() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF NOT NEW.encrypted_transport AND NOT public.legacy_upload_open() THEN RAISE EXCEPTION 'legacy intake closed' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION enforce_encrypted_cutover() FROM PUBLIC;
CREATE TRIGGER document_cutover_insert BEFORE INSERT ON documents FOR EACH ROW EXECUTE FUNCTION enforce_encrypted_cutover();
