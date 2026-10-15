CREATE TABLE organizations (
 id uuid PRIMARY KEY,
 kind text NOT NULL CHECK (kind IN ('agency','employer')),
 name varchar(200) NOT NULL CHECK (length(name)>0),
 active boolean NOT NULL DEFAULT true
);
CREATE TABLE users (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
 active boolean NOT NULL DEFAULT true,
 oidc_issuer text NOT NULL,
 oidc_subject text NOT NULL,
 display_name varchar(100) NOT NULL CHECK (length(display_name)>0),
 UNIQUE(oidc_issuer,oidc_subject)
);
CREATE FUNCTION preserve_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='users' THEN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.oidc_issuer IS DISTINCT FROM OLD.oidc_issuer OR NEW.oidc_subject IS DISTINCT FROM OLD.oidc_subject THEN
   RAISE EXCEPTION 'immutable user identity' USING ERRCODE='23514';
  END IF;
 ELSE
  IF NEW.kind IS DISTINCT FROM OLD.kind THEN RAISE EXCEPTION 'immutable organization kind' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER users_identity BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION preserve_identity();
CREATE TRIGGER organizations_kind BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION preserve_identity();
CREATE TABLE sessions (
 token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash)=32),
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE auth_attempts (
 state_hash bytea PRIMARY KEY CHECK (octet_length(state_hash)=32),
 browser_binding_hash bytea NOT NULL CHECK (octet_length(browser_binding_hash)=32),
 nonce text NOT NULL,
 encrypted_pkce_verifier bytea NOT NULL CHECK (octet_length(encrypted_pkce_verifier)>=28),
 expires_at timestamptz NOT NULL
);
CREATE INDEX auth_attempts_expiry ON auth_attempts(expires_at);
CREATE INDEX auth_attempts_binding ON auth_attempts(browser_binding_hash);
GRANT SELECT ON organizations,users TO app_auth;
GRANT SELECT,INSERT,DELETE ON sessions,auth_attempts TO app_auth;
-- Business privileges and FORCE RLS are added with the M2 business schema.
-- Neither runtime role owns tables, inherits the migration role, or bypasses RLS.
