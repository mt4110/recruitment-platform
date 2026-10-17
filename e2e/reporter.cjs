const fs = require('node:fs');
const path = require('node:path');
module.exports = class SafeReporter {
  tests = [];
  constructor() {
    this.dir = process.env.RP_E2E_DIR;
    const accounts = JSON.parse(fs.readFileSync(path.join(this.dir,'demo-accounts.json'),'utf8'));
    const env = fs.readFileSync(path.join(this.dir,'local.env'),'utf8').split('\n').map(s=>s.slice(s.indexOf('=')+1));
    this.secrets = [...Object.values(accounts), ...env.filter(s=>s.length>=24)];
  }
  scrub(message) {
    message = message.replace(/Call log:[\s\S]*/g,'Call log: [withheld]');
    message = message.replace(/\b(?:cookie|set-cookie|authorization|x-csrf-token|x-upload-ticket|x-scan-key|x-viewer-key|x-document-key)[\"']?\s*:[^\r\n]*/gi,'[sensitive header redacted]');
    message = message.replace(/rp_(?:session|attempt)=[^;\s\"']+/g,'[session redacted]');
    for (const secret of this.secrets) message = message.split(secret).join('[redacted]');
    return message.replace(/https?:\/\/[^\s<>]+/g,'[url]').replace(/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g,'[jwt]').replace(/eyJ[\w-]+\.[\w-]{43}(?![\w-])/g,'[upload-ticket]');
  }
  onTestEnd(test,result) {
    const row = {name:test.title,status:result.status,duration_ms:result.duration,errors:result.errors.map(e=>this.scrub(e.message||'Test failed'))};
    this.tests.push(row);
    fs.writeFileSync(path.join(this.dir,'artifacts','progress.json'),JSON.stringify({scope:'R6 cross-cutting bounded load and existing browser regression',tests:this.tests},null,2)+'\n');
    process.stdout.write(`${row.status}: ${row.name}\n`);
  }
  onError(error) { process.stdout.write(`Runner error: ${this.scrub(error.message||'unknown')}\n`); }
  onEnd(result) {
    const summary = {scope:'R6 cross-cutting bounded load and existing browser regression',status:result.status,tests:this.tests,
      secrets_policy:'No trace, video, storageState, network dump or failure screenshot. Diagnostics redact credentials and URLs.'};
    fs.writeFileSync(path.join(this.dir,'artifacts','summary.json'),JSON.stringify(summary,null,2)+'\n');
  }
};
