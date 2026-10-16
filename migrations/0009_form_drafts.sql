-- Personal draft ownership and terminal tombstones. No automatic deletion.
ALTER TABLE users ADD CONSTRAINT users_id_org_key UNIQUE(id,organization_id);
CREATE TABLE form_drafts(
 id uuid PRIMARY KEY,org_id uuid NOT NULL,user_id uuid NOT NULL,
 form_type text NOT NULL CHECK(form_type IN ('job_new','job_edit','candidate_new','candidate_edit','application_new','application_reason','application_submit','selection_note','document_upload','job_filters','candidate_filters','application_filters')),
 target_id uuid,context_id uuid REFERENCES jobs(id),schema_version integer NOT NULL CHECK(schema_version>0),base_resource_version integer,
 job_target uuid,candidate_target uuid,application_target uuid REFERENCES applications(id),
 revision bigint NOT NULL CHECK(revision>0),encrypted_payload bytea,nonce bytea,key_version integer NOT NULL DEFAULT 1 CHECK(key_version=1),plaintext_bytes integer NOT NULL CHECK(plaintext_bytes BETWEEN 0 AND 65536),
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','consumed','discarded')),
 updated_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',consumed_at timestamptz,
 UNIQUE(org_id,user_id,id), FOREIGN KEY(user_id,org_id) REFERENCES users(id,organization_id),
 FOREIGN KEY(job_target,org_id) REFERENCES jobs(id,employer_org_id),FOREIGN KEY(candidate_target,org_id) REFERENCES candidates(id,agency_org_id),
 CHECK((form_type='job_edit' AND job_target=target_id AND job_target IS NOT NULL) OR (form_type<>'job_edit' AND job_target IS NULL)),
 CHECK((form_type IN ('candidate_edit','document_upload') AND candidate_target=target_id AND candidate_target IS NOT NULL) OR (form_type NOT IN ('candidate_edit','document_upload') AND candidate_target IS NULL)),
 CHECK((form_type IN ('application_reason','application_submit','selection_note') AND application_target=target_id AND application_target IS NOT NULL) OR (form_type NOT IN ('application_reason','application_submit','selection_note') AND application_target IS NULL)),
 CHECK((form_type IN ('job_edit','candidate_edit','document_upload','application_reason','application_submit','selection_note'))=(target_id IS NOT NULL)),
 CHECK((form_type='application_new')=(context_id IS NOT NULL)),
 CHECK((state='active' AND encrypted_payload IS NOT NULL AND octet_length(nonce)=12 AND consumed_at IS NULL) OR (state<>'active' AND encrypted_payload IS NULL AND nonce IS NULL AND plaintext_bytes=0 AND consumed_at IS NOT NULL))
);
CREATE INDEX form_drafts_owner_recent ON form_drafts(org_id,user_id,updated_at DESC,id);
CREATE TABLE draft_mutations(
 org_id uuid NOT NULL,user_id uuid NOT NULL,mutation_id uuid NOT NULL,draft_id uuid NOT NULL,
 request_hash bytea NOT NULL,revision bigint NOT NULL,result_status integer NOT NULL,expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 PRIMARY KEY(org_id,user_id,mutation_id),FOREIGN KEY(org_id,user_id,draft_id) REFERENCES form_drafts(org_id,user_id,id)
);
CREATE TABLE draft_operations(
 org_id uuid NOT NULL,user_id uuid NOT NULL,operation_id uuid NOT NULL,draft_id uuid NOT NULL,revision bigint NOT NULL,
 method text NOT NULL,normalized_path text NOT NULL,request_hash bytea NOT NULL,result_resource_type text NOT NULL,result_resource_id uuid NOT NULL,result_status integer NOT NULL,
 committed_at timestamptz NOT NULL DEFAULT now(),result_expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
 PRIMARY KEY(org_id,user_id,operation_id),FOREIGN KEY(org_id,user_id,draft_id) REFERENCES form_drafts(org_id,user_id,id)
);
CREATE TABLE draft_keys(
 org_id uuid NOT NULL,user_id uuid NOT NULL,key_version integer NOT NULL CHECK(key_version>0),wrapped_key bytea NOT NULL,nonce bytea NOT NULL CHECK(octet_length(nonce)=12),
 created_at timestamptz NOT NULL DEFAULT now(),revoked_at timestamptz,PRIMARY KEY(org_id,user_id,key_version),FOREIGN KEY(user_id,org_id) REFERENCES users(id,organization_id)
);
CREATE TABLE draft_admissions(org_id uuid NOT NULL,user_id uuid NOT NULL,at timestamptz NOT NULL DEFAULT now(),is_new boolean NOT NULL,FOREIGN KEY(user_id,org_id) REFERENCES users(id,organization_id));
CREATE INDEX draft_admissions_owner_time ON draft_admissions(org_id,user_id,at DESC);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['form_drafts','draft_mutations','draft_operations','draft_keys','draft_admissions'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY personal_scope ON %I TO app_runtime USING(org_id=rp_org() AND user_id=rp_user()) WITH CHECK(org_id=rp_org() AND user_id=rp_user())',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO app_runtime',t);
 END LOOP;END $$;
GRANT UPDATE(encrypted_payload,nonce,plaintext_bytes,schema_version,base_resource_version,revision,updated_at,expires_at,state,consumed_at) ON form_drafts TO app_runtime;
CREATE FUNCTION preserve_draft() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.state<>'active' OR OLD.expires_at<=now() THEN RAISE EXCEPTION 'terminal draft' USING ERRCODE='23514'; END IF;
 IF NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'draft revision' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER preserve_draft_update BEFORE UPDATE ON form_drafts FOR EACH ROW EXECUTE FUNCTION preserve_draft();
GRANT UPDATE(draft_id,request_hash,revision,result_status,expires_at) ON draft_mutations TO app_runtime;
