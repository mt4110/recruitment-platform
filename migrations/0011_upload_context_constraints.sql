-- Keep scoped rows consistent even when referenced IDs exist in another context.
ALTER TABLE upload_sessions ADD CONSTRAINT upload_session_context UNIQUE(id,org_id,user_id);
ALTER TABLE upload_sessions ADD CONSTRAINT upload_session_user_org FOREIGN KEY(user_id,org_id) REFERENCES users(id,organization_id);
ALTER TABLE upload_attempts ADD CONSTRAINT upload_attempt_context UNIQUE(id,org_id,user_id);
ALTER TABLE upload_attempts ADD CONSTRAINT upload_attempt_session_context UNIQUE(id,upload_id,org_id,user_id);
ALTER TABLE upload_attempts ADD CONSTRAINT upload_attempt_owned_session FOREIGN KEY(upload_id,org_id,user_id) REFERENCES upload_sessions(id,org_id,user_id);
ALTER TABLE upload_sessions ADD CONSTRAINT upload_canonical_owned_attempt FOREIGN KEY(canonical_attempt,id,org_id,user_id) REFERENCES upload_attempts(id,upload_id,org_id,user_id);
ALTER TABLE documents ADD CONSTRAINT document_creator_context UNIQUE(id,agency_org_id,created_by);
ALTER TABLE document_encryption ADD CONSTRAINT encryption_owned_original FOREIGN KEY(document_id,org_id,user_id) REFERENCES documents(id,agency_org_id,created_by);
ALTER TABLE document_encryption ADD CONSTRAINT encryption_owned_attempt FOREIGN KEY(attempt_id,org_id,user_id) REFERENCES upload_attempts(id,org_id,user_id);
ALTER TABLE document_encryption ADD CONSTRAINT encryption_context UNIQUE(document_id,org_id,user_id);
ALTER TABLE encrypted_document_jobs ADD CONSTRAINT encrypted_job_owned_document FOREIGN KEY(document_id,org_id,user_id) REFERENCES document_encryption(document_id,org_id,user_id);
