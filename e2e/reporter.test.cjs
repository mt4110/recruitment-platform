const {test}=require('node:test');
const assert=require('node:assert/strict');
const Reporter=require('./reporter.cjs');
const scrub=s=>Reporter.prototype.scrub.call({secrets:['SYNTHETIC_PASSWORD_ONLY']},s);
test('request-context disposal keeps failure but withholds the entire call log',()=>{
 const result=scrub('Test timeout of 120000ms exceeded.\nCall log:\n - X-CSRF-Token: SYNTHETIC_CSRF_ONLY\n - cookie: rp_session=SYNTHETIC_SESSION_ONLY\n - authorization: Bearer SYNTHETIC_BEARER_ONLY');
 assert.match(result,/Test timeout of 120000ms exceeded/);
 assert.equal(result.includes('SYNTHETIC_'),false);
 assert.equal(result.includes('rp_session='),false);
});
test('sensitive header fragments and standalone session values are redacted',()=>{
 for(const header of ['Cookie','Set-Cookie','Authorization','X-CSRF-Token','X-Upload-Ticket','X-Scan-Key','X-Viewer-Key','X-Document-Key']){
  assert.equal(scrub(header+': SYNTHETIC_HEADER_ONLY').includes('SYNTHETIC_HEADER_ONLY'),false);
 }
 assert.equal(scrub('unexpected rp_session=SYNTHETIC_SESSION_ONLY; suffix').includes('SYNTHETIC_SESSION_ONLY'),false);
 assert.equal(scrub('SYNTHETIC_PASSWORD_ONLY').includes('SYNTHETIC_PASSWORD_ONLY'),false);
 assert.match(scrub('Expected: 200\nReceived: 503'),/Received: 503/);
});
