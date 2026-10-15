-- CHECK treats NULL as success: require these validation/version markers explicitly.
ALTER TABLE applications ADD CONSTRAINT submitted_job_version_required CHECK(status='draft' OR job_version_snapshot IS NOT NULL);
ALTER TABLE documents ADD CONSTRAINT ready_validation_required CHECK(status<>'ready' OR (validation_policy IS NOT NULL AND validation_policy='static-resume-v1' AND validated_at IS NOT NULL));
