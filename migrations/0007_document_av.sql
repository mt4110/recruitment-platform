-- R2 authenticated API writer. No employer/original privilege expansion.
GRANT INSERT ON document_checks TO app_runtime;
CREATE POLICY checks_write ON document_checks FOR INSERT TO app_runtime WITH CHECK(
 rp_kind()='agency' AND org_id=rp_org() AND actor_user_id=rp_user() AND
 EXISTS(SELECT 1 FROM documents d WHERE d.id=document_id AND d.agency_org_id=org_id AND d.created_by=rp_user() AND d.sha256=document_checks.sha256)
);
CREATE TABLE document_rechecks (
 document_id uuid PRIMARY KEY, org_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES users(id),
 operation_key uuid NOT NULL, lease_token uuid NOT NULL, lease_expires_at timestamptz NOT NULL,
 state text NOT NULL CHECK(state IN ('processing','completed','blocked')),
 FOREIGN KEY(document_id,org_id) REFERENCES documents(id,agency_org_id)
);
ALTER TABLE document_rechecks ENABLE ROW LEVEL SECURITY; ALTER TABLE document_rechecks FORCE ROW LEVEL SECURITY;
CREATE POLICY recheck_owner ON document_rechecks TO app_runtime USING(rp_kind()='agency' AND org_id=rp_org() AND user_id=rp_user()) WITH CHECK(rp_kind()='agency' AND org_id=rp_org() AND user_id=rp_user() AND EXISTS(SELECT 1 FROM documents d WHERE d.id=document_id AND d.created_by=rp_user()));
GRANT SELECT,INSERT,UPDATE ON document_rechecks TO app_runtime;

-- Private admission ledger: callers can reserve/settle only their own receipts.
-- Incomplete/crashed receipts stay fully charged; no unsafe timed reclamation.
CREATE TABLE document_admissions (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id),user_id uuid NOT NULL REFERENCES users(id),
 reserved_bytes bigint NOT NULL CHECK(reserved_bytes BETWEEN 0 AND 10551296),created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON document_admissions FROM PUBLIC,app_runtime,app_auth;
CREATE INDEX admission_rate ON document_admissions(created_at,user_id,org_id);
CREATE POLICY admission_migrate_documents ON documents FOR SELECT TO app_migrator USING(true);
INSERT INTO document_admissions(id,org_id,user_id,reserved_bytes,created_at) SELECT id,agency_org_id,created_by,size_bytes,created_at FROM documents;
DROP POLICY admission_migrate_documents ON documents;
CREATE FUNCTION document_admit(receipt uuid) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE u uuid:=public.rp_user(); o uuid:=public.rp_org();
BEGIN
 IF u IS NULL OR o IS NULL THEN RAISE EXCEPTION 'identity required';END IF;
 PERFORM pg_advisory_xact_lock(72176309);
 IF (SELECT count(*) FROM public.document_admissions WHERE user_id=u AND created_at>now()-interval '1 minute')>=10 OR
 (SELECT count(*) FROM public.document_admissions WHERE org_id=o AND created_at>now()-interval '1 minute')>=30 THEN RETURN 'rate';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.document_storage_baseline) THEN RETURN 'unreconciled';END IF;
 IF (SELECT coalesce(sum(reserved_bytes),0) FROM public.document_admissions WHERE org_id=o)+(SELECT orphan_bytes FROM public.document_storage_baseline)+10551296>536870912 OR
 (SELECT coalesce(sum(reserved_bytes),0) FROM public.document_admissions)+(SELECT orphan_bytes FROM public.document_storage_baseline)+10551296>1073741824 THEN RETURN 'quota';END IF;
 INSERT INTO public.document_admissions(id,org_id,user_id,reserved_bytes) VALUES(receipt,o,u,10551296);
 RETURN 'ok';
END $$;
CREATE FUNCTION document_settle(receipt uuid,actual bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF actual<0 OR actual>10551296 THEN RAISE EXCEPTION 'invalid reservation';END IF;
 UPDATE public.document_admissions SET reserved_bytes=actual WHERE id=receipt AND user_id=public.rp_user() AND org_id=public.rp_org() AND actual<=reserved_bytes;
 IF NOT FOUND THEN RAISE EXCEPTION 'receipt missing';END IF;
END $$;
REVOKE ALL ON FUNCTION document_admit(uuid),document_settle(uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION document_admit(uuid),document_settle(uuid,bigint) TO app_runtime;
CREATE FUNCTION document_retry_admit() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE u uuid:=public.rp_user();o uuid:=public.rp_org();
BEGIN
 IF u IS NULL OR o IS NULL THEN RAISE EXCEPTION 'identity required';END IF;
 PERFORM pg_advisory_xact_lock(72176309);
 IF (SELECT count(*) FROM public.document_admissions WHERE user_id=u AND created_at>now()-interval '1 minute')>=10 OR (SELECT count(*) FROM public.document_admissions WHERE org_id=o AND created_at>now()-interval '1 minute')>=30 THEN RETURN false;END IF;
 INSERT INTO public.document_admissions(id,user_id,org_id,reserved_bytes) VALUES(gen_random_uuid(),u,o,0);RETURN true;
END $$;
REVOKE ALL ON FUNCTION document_retry_admit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION document_retry_admit() TO app_runtime;

-- Charge pre-ledger retained files too. Unknown ownership is conservatively
-- charged to every org; no guessed owner, timed release or automatic deletion.
CREATE TABLE document_storage_baseline(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),orphan_bytes bigint NOT NULL CHECK(orphan_bytes>=0));
REVOKE ALL ON document_storage_baseline FROM PUBLIC,app_runtime,app_auth;
CREATE FUNCTION document_storage_reconcile(files jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE total bigint;
BEGIN
 IF jsonb_typeof(files)<>'array' OR jsonb_array_length(files)>100000 THEN RAISE EXCEPTION 'storage inventory invalid';END IF;
 SELECT coalesce(sum((f->>'size')::bigint),0) INTO total FROM jsonb_array_elements(files) f
 WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(f->'ids') i JOIN public.document_admissions a ON a.id=i::uuid);
 IF total<0 THEN RAISE EXCEPTION 'storage inventory invalid';END IF;
 INSERT INTO public.document_storage_baseline(singleton,orphan_bytes) VALUES(true,total) ON CONFLICT(singleton) DO UPDATE SET orphan_bytes=greatest(document_storage_baseline.orphan_bytes,EXCLUDED.orphan_bytes);
END $$;
REVOKE ALL ON FUNCTION document_storage_reconcile(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION document_storage_reconcile(jsonb) TO app_runtime;
