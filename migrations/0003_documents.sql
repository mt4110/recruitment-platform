CREATE TABLE documents (
 id uuid PRIMARY KEY, agency_org_id uuid NOT NULL REFERENCES organizations(id), candidate_id uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id), storage_key text UNIQUE NOT NULL, staging_key text,
 original_name varchar(255) NOT NULL CHECK(length(original_name)>0), size_bytes bigint NOT NULL CHECK(size_bytes BETWEEN 1 AND 10485760),
 sha256 char(64) NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'), status text NOT NULL CHECK(status IN ('pending','ready','rejected')),
 rejection_code text, validation_policy text, validated_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(candidate_id,agency_org_id) REFERENCES candidates(id,agency_org_id),
 CHECK(status<>'ready' OR (validation_policy='static-resume-v1' AND validated_at IS NOT NULL AND rejection_code IS NULL)),
 CHECK(status<>'rejected' OR rejection_code IS NOT NULL)
);
CREATE INDEX documents_owner_status ON documents(agency_org_id,status,updated_at,id);
CREATE INDEX documents_candidate ON documents(candidate_id,agency_org_id);
CREATE INDEX documents_creator ON documents(created_by);
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
CREATE POLICY documents_owner ON documents TO app_runtime USING((SELECT rp_kind())='agency' AND agency_org_id=(SELECT rp_org())) WITH CHECK((SELECT rp_kind())='agency' AND agency_org_id=(SELECT rp_org()));
CREATE FUNCTION preserve_document() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'pending' OR NEW.created_by<>rp_user() THEN RAISE EXCEPTION 'invalid document' USING ERRCODE='23514'; END IF;
 ELSE
  IF OLD.status<>'pending' OR NEW.id<>OLD.id OR NEW.agency_org_id<>OLD.agency_org_id OR NEW.candidate_id<>OLD.candidate_id OR NEW.created_by<>OLD.created_by OR NEW.storage_key<>OLD.storage_key OR NEW.staging_key IS DISTINCT FROM OLD.staging_key OR NEW.original_name<>OLD.original_name OR NEW.size_bytes<>OLD.size_bytes OR NEW.sha256<>OLD.sha256 OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'immutable document' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER documents_changes BEFORE INSERT OR UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION preserve_document();
GRANT SELECT,INSERT ON documents TO app_runtime;
GRANT UPDATE(status,rejection_code,validation_policy,validated_at,updated_at) ON documents TO app_runtime;
REVOKE ALL ON FUNCTION preserve_document() FROM PUBLIC;
