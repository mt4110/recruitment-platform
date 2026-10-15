-- Child policies only reference applications; parent policies never reference children.
ALTER TABLE documents ADD CONSTRAINT documents_owner_key UNIQUE(id,agency_org_id);
CREATE TABLE applications (
 id uuid PRIMARY KEY, agency_org_id uuid NOT NULL REFERENCES organizations(id), employer_org_id uuid NOT NULL REFERENCES organizations(id),
 candidate_id uuid NOT NULL, job_id uuid NOT NULL, status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','screening','rejected','hired','withdrawn')),
 reason varchar(2000) NOT NULL CHECK(length(btrim(reason))>0), version integer NOT NULL DEFAULT 1 CHECK(version>0), submitted_at timestamptz, share_revoked_at timestamptz,
 job_title_snapshot varchar(200),job_description_snapshot text CHECK(length(job_description_snapshot) BETWEEN 1 AND 10000),job_location_snapshot varchar(200),job_employment_type_snapshot text CHECK(job_employment_type_snapshot IN ('full_time','contract','part_time')),job_version_snapshot integer,
 agency_name_snapshot varchar(200),employer_name_snapshot varchar(200), created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,agency_org_id),FOREIGN KEY(candidate_id,agency_org_id) REFERENCES candidates(id,agency_org_id),FOREIGN KEY(job_id,employer_org_id) REFERENCES jobs(id,employer_org_id),
 CHECK((status='draft' AND submitted_at IS NULL AND share_revoked_at IS NULL AND job_title_snapshot IS NULL AND job_description_snapshot IS NULL AND job_location_snapshot IS NULL AND job_employment_type_snapshot IS NULL AND job_version_snapshot IS NULL AND agency_name_snapshot IS NULL AND employer_name_snapshot IS NULL) OR
 (status<>'draft' AND submitted_at IS NOT NULL AND job_title_snapshot IS NOT NULL AND job_description_snapshot IS NOT NULL AND job_location_snapshot IS NOT NULL AND job_employment_type_snapshot IS NOT NULL AND job_version_snapshot>0 AND agency_name_snapshot IS NOT NULL AND employer_name_snapshot IS NOT NULL)),
 CHECK((status='withdrawn' AND share_revoked_at IS NOT NULL) OR (status IN ('draft','submitted','screening') AND share_revoked_at IS NULL) OR status IN ('rejected','hired'))
);
CREATE UNIQUE INDEX applications_one_active ON applications(agency_org_id,candidate_id,job_id) WHERE status IN ('draft','submitted','screening','hired');
CREATE INDEX applications_agency_order ON applications(agency_org_id,status,updated_at DESC,id DESC);
CREATE INDEX applications_employer_order ON applications(employer_org_id,status,updated_at DESC,id DESC);
CREATE INDEX applications_candidate ON applications(candidate_id,agency_org_id);
CREATE INDEX applications_job ON applications(job_id,employer_org_id);
CREATE TABLE application_snapshots (
 application_id uuid PRIMARY KEY REFERENCES applications(id),name varchar(100) NOT NULL,summary text NOT NULL CHECK(length(summary) BETWEEN 1 AND 10000),
 consent_recorded_at timestamptz NOT NULL,consent_recorded_by uuid NOT NULL REFERENCES users(id),consent_text_version text NOT NULL CHECK(consent_text_version='demo-share-v1')
);
CREATE INDEX snapshot_consent_actor ON application_snapshots(consent_recorded_by);
CREATE TABLE application_documents (
 application_id uuid NOT NULL,document_id uuid NOT NULL,agency_org_id uuid NOT NULL,storage_key_snapshot text NOT NULL,original_name_snapshot varchar(255) NOT NULL,
 size_bytes_snapshot bigint NOT NULL CHECK(size_bytes_snapshot BETWEEN 1 AND 10485760),sha256_snapshot char(64) NOT NULL CHECK(sha256_snapshot ~ '^[0-9a-f]{64}$'),
 PRIMARY KEY(application_id,document_id),FOREIGN KEY(application_id,agency_org_id) REFERENCES applications(id,agency_org_id),FOREIGN KEY(document_id,agency_org_id) REFERENCES documents(id,agency_org_id)
);
CREATE INDEX application_documents_source ON application_documents(document_id,agency_org_id);
CREATE TABLE selection_events (
 id uuid PRIMARY KEY,application_id uuid NOT NULL REFERENCES applications(id),event_type text NOT NULL CHECK(event_type IN ('transition','sharing_revoked')),
 from_status text NOT NULL CHECK(from_status IN ('draft','submitted','screening','rejected','hired')),to_status text NOT NULL CHECK(to_status IN ('submitted','screening','rejected','hired','withdrawn')),application_version integer NOT NULL CHECK(application_version>1),actor_user_id uuid NOT NULL REFERENCES users(id),actor_org_id uuid NOT NULL REFERENCES organizations(id),reason varchar(500),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(application_id,application_version)
);
CREATE INDEX selection_order ON selection_events(application_id,created_at,id);
CREATE INDEX selection_actor_user ON selection_events(actor_user_id);
CREATE INDEX selection_actor_org ON selection_events(actor_org_id);
CREATE TABLE placements (
 id uuid PRIMARY KEY,application_id uuid NOT NULL UNIQUE REFERENCES applications(id),decided_at timestamptz NOT NULL DEFAULT now(),demo_fee_yen bigint NOT NULL CHECK(demo_fee_yen=500000)
);
-- M4 stores atomic, unsent event notices. M5 owns their UI/API and invoice rendering.
CREATE TABLE notification_previews (
 id uuid PRIMARY KEY,application_id uuid NOT NULL REFERENCES applications(id),recipient_org_id uuid NOT NULL REFERENCES organizations(id),event_id uuid NOT NULL REFERENCES selection_events(id),
 subject varchar(200) NOT NULL,body text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(event_id,recipient_org_id)
);
CREATE INDEX notification_recipient ON notification_previews(recipient_org_id,created_at,id);
CREATE INDEX notification_application ON notification_previews(application_id);
CREATE INDEX notification_event ON notification_previews(event_id);
ALTER TABLE applications ENABLE ROW LEVEL SECURITY; ALTER TABLE applications FORCE ROW LEVEL SECURITY;
ALTER TABLE application_snapshots ENABLE ROW LEVEL SECURITY; ALTER TABLE application_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE application_documents ENABLE ROW LEVEL SECURITY; ALTER TABLE application_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE selection_events ENABLE ROW LEVEL SECURITY; ALTER TABLE selection_events FORCE ROW LEVEL SECURITY;
ALTER TABLE placements ENABLE ROW LEVEL SECURITY; ALTER TABLE placements FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_previews ENABLE ROW LEVEL SECURITY; ALTER TABLE notification_previews FORCE ROW LEVEL SECURITY;
CREATE POLICY application_read ON applications FOR SELECT TO app_runtime USING (((SELECT rp_kind())='agency' AND agency_org_id=(SELECT rp_org())) OR ((SELECT rp_kind())='employer' AND employer_org_id=(SELECT rp_org()) AND status<>'draft'));
CREATE POLICY application_create ON applications FOR INSERT TO app_runtime WITH CHECK ((SELECT rp_kind())='agency' AND agency_org_id=(SELECT rp_org()) AND status='draft');
CREATE POLICY application_update ON applications FOR UPDATE TO app_runtime USING (((SELECT rp_kind())='agency' AND agency_org_id=(SELECT rp_org())) OR ((SELECT rp_kind())='employer' AND employer_org_id=(SELECT rp_org()) AND status IN ('submitted','screening','rejected','hired') AND share_revoked_at IS NULL)) WITH CHECK (((SELECT rp_kind())='agency' AND agency_org_id=(SELECT rp_org())) OR ((SELECT rp_kind())='employer' AND employer_org_id=(SELECT rp_org()) AND status IN ('submitted','screening','rejected','hired') AND share_revoked_at IS NULL));
CREATE POLICY snapshot_read ON application_snapshots FOR SELECT TO app_runtime USING (EXISTS(SELECT 1 FROM applications a WHERE a.id=application_id AND ((a.agency_org_id=rp_org() AND rp_kind()='agency') OR (a.employer_org_id=rp_org() AND rp_kind()='employer' AND a.status IN ('submitted','screening','rejected','hired') AND a.share_revoked_at IS NULL))));
CREATE POLICY snapshot_create ON application_snapshots FOR INSERT TO app_runtime WITH CHECK (consent_recorded_by=rp_user() AND EXISTS(SELECT 1 FROM applications a WHERE a.id=application_id AND a.agency_org_id=rp_org() AND rp_kind()='agency' AND a.status='draft'));
CREATE POLICY shared_document_read ON application_documents FOR SELECT TO app_runtime USING(EXISTS(SELECT 1 FROM applications a WHERE a.id=application_id AND ((a.agency_org_id=rp_org() AND rp_kind()='agency') OR (a.employer_org_id=rp_org() AND rp_kind()='employer' AND a.status IN ('submitted','screening','rejected','hired') AND a.share_revoked_at IS NULL))));
CREATE POLICY shared_document_create ON application_documents FOR INSERT TO app_runtime WITH CHECK(EXISTS(SELECT 1 FROM applications a WHERE a.id=application_id AND a.agency_org_id=rp_org() AND rp_kind()='agency' AND a.status='draft'));
CREATE POLICY event_read ON selection_events FOR SELECT TO app_runtime USING(EXISTS(SELECT 1 FROM applications a WHERE a.id=application_id));
CREATE POLICY event_create ON selection_events FOR INSERT TO app_runtime WITH CHECK(actor_user_id=rp_user() AND actor_org_id=rp_org() AND EXISTS(SELECT 1 FROM applications a WHERE a.id=application_id AND a.status=to_status AND (a.agency_org_id=rp_org() AND rp_kind()='agency' OR a.employer_org_id=rp_org() AND rp_kind()='employer' AND a.share_revoked_at IS NULL)));
CREATE POLICY placement_read ON placements FOR SELECT TO app_runtime USING(EXISTS(SELECT 1 FROM applications a WHERE a.id=application_id AND (a.agency_org_id=rp_org() AND rp_kind()='agency' OR a.employer_org_id=rp_org() AND rp_kind()='employer' AND a.status='hired' AND a.share_revoked_at IS NULL)));
CREATE POLICY placement_create ON placements FOR INSERT TO app_runtime WITH CHECK(EXISTS(SELECT 1 FROM applications a WHERE a.id=application_id AND a.employer_org_id=rp_org() AND rp_kind()='employer' AND a.status='hired' AND a.share_revoked_at IS NULL));
CREATE POLICY notification_read ON notification_previews FOR SELECT TO app_runtime USING(recipient_org_id=rp_org() AND rp_kind() IS NOT NULL);
CREATE POLICY notification_create ON notification_previews FOR INSERT TO app_runtime WITH CHECK(EXISTS(SELECT 1 FROM applications a WHERE a.id=application_id AND a.status<>'draft' AND recipient_org_id IN (a.agency_org_id,a.employer_org_id)) AND EXISTS(SELECT 1 FROM selection_events e WHERE e.id=event_id AND e.application_id=notification_previews.application_id AND e.actor_user_id=rp_user()));
CREATE FUNCTION preserve_application() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'draft' OR NEW.version<>1 OR rp_kind()<>'agency' OR NEW.agency_org_id<>rp_org() THEN RAISE EXCEPTION 'invalid application' USING ERRCODE='23514'; END IF;
 ELSE
  IF (NEW.id,NEW.agency_org_id,NEW.employer_org_id,NEW.candidate_id,NEW.job_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.agency_org_id,OLD.employer_org_id,OLD.candidate_id,OLD.job_id,OLD.created_at) OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'immutable application relation' USING ERRCODE='23514'; END IF;
  IF OLD.status<>'draft' AND ((NEW.reason,NEW.submitted_at,NEW.job_title_snapshot,NEW.job_description_snapshot,NEW.job_location_snapshot,NEW.job_employment_type_snapshot,NEW.job_version_snapshot,NEW.agency_name_snapshot,NEW.employer_name_snapshot) IS DISTINCT FROM (OLD.reason,OLD.submitted_at,OLD.job_title_snapshot,OLD.job_description_snapshot,OLD.job_location_snapshot,OLD.job_employment_type_snapshot,OLD.job_version_snapshot,OLD.agency_name_snapshot,OLD.employer_name_snapshot)) THEN RAISE EXCEPTION 'immutable submitted content' USING ERRCODE='23514'; END IF;
  IF OLD.status='draft' AND NEW.status='submitted' AND (NOT EXISTS(SELECT 1 FROM application_snapshots WHERE application_id=NEW.id) OR NOT EXISTS(SELECT 1 FROM application_documents WHERE application_id=NEW.id)) THEN RAISE EXCEPTION 'missing submission snapshot' USING ERRCODE='23514'; END IF;
  IF OLD.share_revoked_at IS NOT NULL THEN RAISE EXCEPTION 'sharing already revoked' USING ERRCODE='23514'; END IF;
  IF rp_kind()='agency' AND NEW.agency_org_id=rp_org() THEN
   IF NOT ((OLD.status='draft' AND NEW.status IN ('draft','submitted')) OR (OLD.status IN ('submitted','screening') AND NEW.status='withdrawn' AND NEW.share_revoked_at IS NOT NULL) OR (OLD.status IN ('rejected','hired') AND NEW.status=OLD.status AND NEW.share_revoked_at IS NOT NULL)) THEN RAISE EXCEPTION 'invalid agency transition' USING ERRCODE='23514'; END IF;
  ELSIF rp_kind()='employer' AND NEW.employer_org_id=rp_org() THEN
   IF NEW.share_revoked_at IS DISTINCT FROM OLD.share_revoked_at OR NOT ((OLD.status='submitted' AND NEW.status IN ('screening','rejected')) OR (OLD.status='screening' AND NEW.status IN ('hired','rejected'))) THEN RAISE EXCEPTION 'invalid employer transition' USING ERRCODE='23514'; END IF;
  ELSE RAISE EXCEPTION 'invalid actor' USING ERRCODE='23514'; END IF;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER application_changes BEFORE INSERT OR UPDATE ON applications FOR EACH ROW EXECUTE FUNCTION preserve_application();
CREATE FUNCTION verify_shared_document() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM documents d JOIN applications a ON a.id=NEW.application_id WHERE d.id=NEW.document_id AND d.agency_org_id=NEW.agency_org_id AND d.candidate_id=a.candidate_id AND d.status='ready' AND d.storage_key=NEW.storage_key_snapshot AND d.original_name=NEW.original_name_snapshot AND d.size_bytes=NEW.size_bytes_snapshot AND d.sha256=NEW.sha256_snapshot) THEN RAISE EXCEPTION 'invalid shared document' USING ERRCODE='23514'; END IF;RETURN NEW;
END $$;
CREATE TRIGGER shared_document_check BEFORE INSERT ON application_documents FOR EACH ROW EXECUTE FUNCTION verify_shared_document();
GRANT SELECT,INSERT ON applications,application_snapshots,application_documents,selection_events,placements,notification_previews TO app_runtime;
GRANT UPDATE(reason,status,version,submitted_at,share_revoked_at,job_title_snapshot,job_description_snapshot,job_location_snapshot,job_employment_type_snapshot,job_version_snapshot,agency_name_snapshot,employer_name_snapshot,updated_at) ON applications TO app_runtime;
REVOKE ALL ON FUNCTION preserve_application(),verify_shared_document() FROM PUBLIC;

CREATE FUNCTION verify_application_child() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE a applications%ROWTYPE; BEGIN
 SELECT * INTO a FROM applications WHERE id=NEW.application_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'missing application' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='application_snapshots' THEN
  IF NOT EXISTS(SELECT 1 FROM candidates c WHERE c.id=a.candidate_id AND c.name=NEW.name AND c.summary=NEW.summary AND c.archived_at IS NULL) THEN RAISE EXCEPTION 'invalid snapshot content' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.application_version<>a.version OR NEW.to_status<>a.status OR NOT (
   (NEW.event_type='sharing_revoked' AND rp_kind()='agency' AND NEW.from_status=NEW.to_status AND NEW.to_status IN ('rejected','hired') AND a.share_revoked_at IS NOT NULL) OR
   (NEW.event_type='transition' AND ((rp_kind()='agency' AND ((NEW.from_status='draft' AND NEW.to_status='submitted') OR (NEW.from_status IN ('submitted','screening') AND NEW.to_status='withdrawn'))) OR (rp_kind()='employer' AND ((NEW.from_status='submitted' AND NEW.to_status IN ('screening','rejected')) OR (NEW.from_status='screening' AND NEW.to_status IN ('rejected','hired'))))))
  ) THEN RAISE EXCEPTION 'invalid selection event' USING ERRCODE='23514'; END IF;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER application_snapshot_check BEFORE INSERT ON application_snapshots FOR EACH ROW EXECUTE FUNCTION verify_application_child();
CREATE TRIGGER selection_event_check BEFORE INSERT ON selection_events FOR EACH ROW EXECUTE FUNCTION verify_application_child();
REVOKE ALL ON FUNCTION verify_application_child() FROM PUBLIC;
