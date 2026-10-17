"""Synthetic export regression fixtures are retained in ignored .local; no deletion."""
import json,unittest,uuid
from pathlib import Path
from export_evidence import export
class EvidenceExportTests(unittest.TestCase):
    def setUp(self):
        self.base=Path('.local')/('export-regression-'+str(uuid.uuid4()))
        self.fixture=self.base/'root/e2e-synthetic';self.artifacts=self.fixture/'artifacts'
        self.artifacts.mkdir(parents=True)
        for name in ('demo-accounts.json','local.env','upload-private.pem','artifact-private.pem','broker-auth','scan-auth','viewer-auth'):
            content=json.dumps({'actor':'SYNTHETIC_FIXTURE_ACCOUNT_ONLY'}) if name=='demo-accounts.json' else ('FIXTURE=SYNTHETIC_FIXTURE_VALUE_ONLY_1234' if name=='local.env' else 'SYNTHETIC_FILE_'+name)
            (self.fixture/name).write_text(content)
        (self.artifacts/'run.json').write_text('{"status":"failed"}')
    def check(self):return export(self.base/'root',self.base/'export')
    def test_safe_metadata_is_copied(self):
        r=self.check();self.assertEqual(r['status'],'passed');self.assertEqual(r['copied_files'],1)
    def test_nested_headers_and_quoted_strings_are_withheld(self):
        examples=[{'nested':{'headers':{'Cookie':'SYNTHETIC_SESSION_ONLY'}}}, {'error':'"X-CSRF-Token": "SYNTHETIC_UNKNOWN_ONLY"'}, {'error':"'X-Viewer-Key': 'SYNTHETIC_UNKNOWN_ONLY'"}]
        for i,value in enumerate(examples):(self.artifacts/(str(i)+'.json')).write_text(json.dumps(value))
        r=self.check();self.assertEqual(r['withheld_files'],3);self.assertEqual(r['copied_files'],1)
        self.assertTrue((self.artifacts/'0.json').exists());self.assertFalse((self.base/'export/e2e-synthetic/0.json').exists())
    def test_missing_fixture_withholds_unscanned_run(self):
        # Use a fresh incomplete fixture, preserving every earlier file.
        root=self.base/'missing';(root/'e2e-incomplete/artifacts').mkdir(parents=True)
        (root/'e2e-incomplete/artifacts/run.json').write_text('{"status":"failed"}')
        r=export(root,self.base/'incomplete-export');self.assertEqual(r['status'],'failed');self.assertEqual(r['copied_files'],0)
        self.assertFalse(r['fixture_coverage'][0]['required_fixture_complete'])
    def test_absent_run_cannot_pass(self):
        root=self.base/'empty';root.mkdir();r=export(root,self.base/'empty-export');self.assertEqual(r['status'],'failed')
    def test_only_verified_project_identity_is_public_metadata(self):
        (self.artifacts/'run.json').write_text(json.dumps({'instance':'e2e-synthetic','project':'recruitment-e2e-synthetic'}))
        with (self.fixture/'local.env').open('a') as f:f.write('\nCOMPOSE_PROJECT_NAME=recruitment-e2e-synthetic\n')
        self.assertEqual(self.check()['status'],'passed')
        # An unrelated secret placed in that variable must still be withheld.
        root=self.base/'mismatch';fixture=root/'e2e-synthetic';(fixture/'artifacts').mkdir(parents=True)
        for name in ('demo-accounts.json','local.env','upload-private.pem','artifact-private.pem','broker-auth','scan-auth','viewer-auth'):
            (fixture/name).write_bytes((self.fixture/name).read_bytes())
        (fixture/'local.env').write_text('COMPOSE_PROJECT_NAME=SYNTHETIC_PROJECT_SECRET_ONLY_12345')
        (fixture/'artifacts/run.json').write_text(json.dumps({'instance':'e2e-synthetic','secret':'SYNTHETIC_PROJECT_SECRET_ONLY_12345'}))
        self.assertEqual(export(root,self.base/'mismatch-export')['withheld_files'],1)
if __name__=='__main__':unittest.main()
