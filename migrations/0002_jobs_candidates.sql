-- Context is transaction-local. No context, inactive or mismatched identity: deny.
CREATE FUNCTION rp_user() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id',true),'')::uuid $$;
CREATE FUNCTION rp_org() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.org_id',true),'')::uuid $$;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_users ON users FOR SELECT TO app_auth USING (true);
CREATE POLICY auth_orgs ON organizations FOR SELECT TO app_auth USING (true);
CREATE POLICY own_user ON users FOR SELECT TO app_runtime USING (id=(SELECT rp_user()) AND organization_id=(SELECT rp_org()) AND active);
CREATE POLICY own_org ON organizations FOR SELECT TO app_runtime USING (id=(SELECT rp_org()) AND active);
GRANT SELECT(id,organization_id,active,display_name) ON users TO app_runtime;
GRANT SELECT(id,kind,name,active) ON organizations TO app_runtime;
CREATE FUNCTION rp_kind() RETURNS text LANGUAGE sql STABLE AS $$
 SELECT o.kind FROM organizations o WHERE o.id=rp_org() AND o.active AND EXISTS(SELECT 1 FROM users u WHERE u.id=rp_user() AND u.organization_id=o.id AND u.active)
$$;
CREATE TABLE jobs (
 id uuid PRIMARY KEY, employer_org_id uuid NOT NULL REFERENCES organizations(id), employer_name varchar(200) NOT NULL,
 title varchar(200) NOT NULL CHECK(length(btrim(title))>0), description text NOT NULL CHECK(length(description) BETWEEN 1 AND 10000),
 location varchar(200) NOT NULL CHECK(length(btrim(location))>0), employment_type text NOT NULL CHECK(employment_type IN ('full_time','contract','part_time')),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','closed')), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,employer_org_id)
);
CREATE INDEX jobs_public_order ON jobs(status,created_at DESC,id DESC);
CREATE INDEX jobs_owner_order ON jobs(employer_org_id,created_at DESC,id DESC);
CREATE TABLE candidates (
 id uuid PRIMARY KEY, agency_org_id uuid NOT NULL REFERENCES organizations(id), name varchar(100) NOT NULL CHECK(length(btrim(name))>0),
 summary text NOT NULL CHECK(length(summary) BETWEEN 1 AND 10000), archived_at timestamptz, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,agency_org_id)
);
CREATE INDEX candidates_owner_order ON candidates(agency_org_id,created_at DESC,id DESC);
CREATE TABLE job_favorites (
 agency_org_id uuid NOT NULL REFERENCES organizations(id), job_id uuid NOT NULL REFERENCES jobs(id), created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(agency_org_id,job_id)
);
CREATE INDEX job_favorites_job ON job_favorites(job_id);
CREATE INDEX job_favorites_creator ON job_favorites(created_by);
CREATE TABLE idempotency_records (
 org_id uuid NOT NULL REFERENCES organizations(id), user_id uuid NOT NULL REFERENCES users(id), http_method text NOT NULL,
 normalized_path text NOT NULL, key uuid NOT NULL, request_hash bytea NOT NULL CHECK(octet_length(request_hash)=32), resource_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('processing','completed','failed')), result_status integer, error_code text, lease_token uuid, lease_expires_at timestamptz, expires_at timestamptz,
 PRIMARY KEY(org_id,user_id,http_method,normalized_path,key), CHECK((state='processing' AND expires_at IS NULL) OR (state IN ('completed','failed') AND expires_at IS NOT NULL))
);
CREATE INDEX idempotency_resource ON idempotency_records(org_id,user_id,resource_id);
CREATE INDEX idempotency_user ON idempotency_records(user_id);
CREATE TABLE audit_events (
 id uuid PRIMARY KEY, actor_user_id uuid NOT NULL REFERENCES users(id), actor_org_id uuid NOT NULL REFERENCES organizations(id), action text NOT NULL,
 resource_type text NOT NULL, resource_id uuid NOT NULL, result text NOT NULL, request_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_actor_org ON audit_events(actor_org_id,created_at);
CREATE INDEX audit_actor_user ON audit_events(actor_user_id);
CREATE FUNCTION preserve_business() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='jobs' THEN
  IF TG_OP='INSERT' THEN
   IF NEW.status<>'draft' OR NEW.version<>1 OR NOT EXISTS(SELECT 1 FROM organizations WHERE id=NEW.employer_org_id AND kind='employer' AND name=NEW.employer_name) THEN RAISE EXCEPTION 'invalid job owner' USING ERRCODE='23514'; END IF;
  ELSE
   IF NEW.id<>OLD.id OR NEW.employer_org_id<>OLD.employer_org_id OR NEW.employer_name<>OLD.employer_name OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1 OR OLD.status='closed' OR NOT(NEW.status=OLD.status OR (OLD.status='draft' AND NEW.status='published') OR (OLD.status='published' AND NEW.status='closed')) THEN RAISE EXCEPTION 'invalid job change' USING ERRCODE='23514'; END IF;
  END IF;
 ELSE
  IF TG_OP='INSERT' THEN
   IF NEW.archived_at IS NOT NULL OR NEW.version<>1 OR NOT EXISTS(SELECT 1 FROM organizations WHERE id=NEW.agency_org_id AND kind='agency') THEN RAISE EXCEPTION 'invalid candidate owner' USING ERRCODE='23514'; END IF;
  ELSE
   IF NEW.id<>OLD.id OR NEW.agency_org_id<>OLD.agency_org_id OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1 OR OLD.archived_at IS NOT NULL THEN RAISE EXCEPTION 'invalid candidate change' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER jobs_changes BEFORE INSERT OR UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION preserve_business();
CREATE TRIGGER candidates_changes BEFORE INSERT OR UPDATE ON candidates FOR EACH ROW EXECUTE FUNCTION preserve_business();
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY; ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE candidates ENABLE ROW LEVEL SECURITY; ALTER TABLE candidates FORCE ROW LEVEL SECURITY;
ALTER TABLE job_favorites ENABLE ROW LEVEL SECURITY; ALTER TABLE job_favorites FORCE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY; ALTER TABLE idempotency_records FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY; ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY jobs_read ON jobs FOR SELECT TO app_runtime USING ((SELECT rp_kind())='employer' AND employer_org_id=(SELECT rp_org()) OR (SELECT rp_kind())='agency' AND status='published');
CREATE POLICY jobs_create ON jobs FOR INSERT TO app_runtime WITH CHECK ((SELECT rp_kind())='employer' AND employer_org_id=(SELECT rp_org()));
CREATE POLICY jobs_update ON jobs FOR UPDATE TO app_runtime USING ((SELECT rp_kind())='employer' AND employer_org_id=(SELECT rp_org())) WITH CHECK ((SELECT rp_kind())='employer' AND employer_org_id=(SELECT rp_org()));
CREATE POLICY candidates_own ON candidates TO app_runtime USING ((SELECT rp_kind())='agency' AND agency_org_id=(SELECT rp_org())) WITH CHECK ((SELECT rp_kind())='agency' AND agency_org_id=(SELECT rp_org()));
CREATE POLICY favorites_read ON job_favorites FOR SELECT TO app_runtime USING ((SELECT rp_kind())='agency' AND agency_org_id=(SELECT rp_org()));
CREATE POLICY favorites_create ON job_favorites FOR INSERT TO app_runtime WITH CHECK ((SELECT rp_kind())='agency' AND agency_org_id=(SELECT rp_org()) AND created_by=(SELECT rp_user()) AND EXISTS(SELECT 1 FROM jobs WHERE id=job_id AND status='published'));
CREATE POLICY favorites_remove ON job_favorites FOR DELETE TO app_runtime USING ((SELECT rp_kind())='agency' AND agency_org_id=(SELECT rp_org()));
CREATE POLICY idem_own ON idempotency_records TO app_runtime USING ((SELECT rp_kind()) IS NOT NULL AND org_id=(SELECT rp_org()) AND user_id=(SELECT rp_user())) WITH CHECK ((SELECT rp_kind()) IS NOT NULL AND org_id=(SELECT rp_org()) AND user_id=(SELECT rp_user()));
CREATE POLICY audit_insert ON audit_events FOR INSERT TO app_runtime WITH CHECK ((SELECT rp_kind()) IS NOT NULL AND actor_org_id=(SELECT rp_org()) AND actor_user_id=(SELECT rp_user()));
GRANT SELECT,INSERT ON jobs,candidates TO app_runtime;
GRANT UPDATE(title,description,location,employment_type,status,version,updated_at) ON jobs TO app_runtime;
GRANT UPDATE(name,summary,archived_at,version,updated_at) ON candidates TO app_runtime;
GRANT SELECT,INSERT,DELETE ON job_favorites TO app_runtime;
GRANT SELECT,INSERT ON idempotency_records TO app_runtime;
GRANT UPDATE(request_hash,resource_id,state,result_status,error_code,lease_token,lease_expires_at,expires_at) ON idempotency_records TO app_runtime;
GRANT INSERT ON audit_events TO app_runtime;
REVOKE ALL ON FUNCTION rp_user(),rp_org(),rp_kind(),preserve_business() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rp_user(),rp_org(),rp_kind() TO app_runtime;
-- Offline migration/fixture role is never used by the request process.
CREATE POLICY seed_org ON organizations TO app_migrator USING(true) WITH CHECK(true);
CREATE POLICY seed_user ON users TO app_migrator USING(true) WITH CHECK(true);
CREATE POLICY seed_jobs ON jobs TO app_migrator USING(true) WITH CHECK(true);
CREATE POLICY seed_candidates ON candidates TO app_migrator USING(true) WITH CHECK(true);
