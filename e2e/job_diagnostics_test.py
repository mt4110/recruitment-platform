"""Deterministic diagnostic minimization checks; no Docker or external services."""
import json,unittest
from pathlib import Path
from unittest.mock import patch
from job_diagnostics import collect
class FakePath:
 def __init__(self,value):self.value=value;self.parent=type('Parent',(),{'name':'document-'+'a'*16})()
 def is_symlink(self):return False
 def stat(self):return type('Stat',(),{'st_size':1000})()
 def read_text(self):return json.dumps(self.value)
class Diagnostics(unittest.TestCase):
 def value(self):return {'status':'refused','stopped':True,'claimed':{'document_id':'a'*36,'generation':'b'*36,'lease_token':'excluded'},'failures':[{'code':'SCANNER_UNAVAILABLE','phase':'av','raw_error':'excluded'}],'sandbox_failures':[],'phase_milliseconds':{'av':123,'secret':'excluded'},'containers':{'broker':{'memory_limit':536870912,'oom_killed':False,'mount_targets':['excluded']}},'headers':{'authorization':'excluded'},'input':'excluded'}
 def read(self,value):
  with patch.object(Path,'glob',return_value=[FakePath(value)]):return collect(Path('/unused'))
 def test_only_allowlisted_fields(self):
  result=self.read(self.value());self.assertNotIn('excluded',json.dumps(result));self.assertEqual(result['jobs'][0]['failures'],[{'code':'SCANNER_UNAVAILABLE','phase':'av'}])
 def test_arbitrary_failure_text_refused(self):
  value=self.value();value['failures'][0]['code']='untrusted-error-text'
  with self.assertRaises(ValueError):self.read(value)
 def test_claim_is_not_free_text(self):
  value=self.value();value['claimed']['document_id']='untrusted-original-name'
  with self.assertRaises(ValueError):self.read(value)
if __name__=='__main__':unittest.main()
