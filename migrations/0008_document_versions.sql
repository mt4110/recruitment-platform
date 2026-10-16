-- Immutable per-candidate/kind ordinals without updating existing originals or snapshots.
CREATE TABLE document_versions(
 document_id uuid PRIMARY KEY, org_id uuid NOT NULL, candidate_id uuid NOT NULL,
 document_kind text NOT NULL CHECK(document_kind IN ('resume','career_history','other')),
 version integer NOT NULL CHECK(version>0),
 UNIQUE(candidate_id,document_kind,version),
 FOREIGN KEY(document_id,org_id) REFERENCES documents(id,agency_org_id),
 FOREIGN KEY(candidate_id,org_id) REFERENCES candidates(id,agency_org_id)
);
ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY; ALTER TABLE document_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY versions_internal ON document_versions TO app_migrator USING(true) WITH CHECK(true);
CREATE POLICY versions_read ON document_versions FOR SELECT TO app_runtime USING(
 (rp_kind()='agency' AND org_id=rp_org()) OR
 (rp_kind()='employer' AND EXISTS(SELECT 1 FROM application_documents ad WHERE ad.document_id=document_versions.document_id AND ad.agency_org_id=document_versions.org_id))
);
GRANT SELECT ON document_versions TO app_runtime;
CREATE POLICY versions_migrate_originals ON documents FOR SELECT TO app_migrator USING(true);
INSERT INTO document_versions SELECT id,agency_org_id,candidate_id,document_kind,
 row_number() OVER(PARTITION BY candidate_id,document_kind ORDER BY created_at,id)::integer FROM documents;
DROP POLICY versions_migrate_originals ON documents;
CREATE FUNCTION assign_document_version() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('document-version:'||NEW.candidate_id::text||':'||NEW.document_kind,72176311));
 INSERT INTO public.document_versions(document_id,org_id,candidate_id,document_kind,version)
 SELECT NEW.id,NEW.agency_org_id,NEW.candidate_id,NEW.document_kind,coalesce(max(version),0)+1
 FROM public.document_versions WHERE candidate_id=NEW.candidate_id AND document_kind=NEW.document_kind;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION assign_document_version() FROM PUBLIC;
CREATE TRIGGER document_version_created AFTER INSERT ON documents FOR EACH ROW EXECUTE FUNCTION assign_document_version();
