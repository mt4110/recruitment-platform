const {test,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),c=require('node:crypto');
const {sql,signIn,identity,origin,shot}=require('./helpers.cjs');
const dir=process.env.RP_E2E_DIR,root=path.resolve(__dirname,'..'),actors={};
const sample=fs.readFileSync(path.join(root,'apps/web/public/sample-resume.pdf'));
function host(script,args=[]){return cp.spawnSync('python3',[script,...args],{cwd:root,env:process.env,encoding:'utf8',timeout:150000});}
const control=(...args)=>{const r=host('scripts/local.py',['compose',...args]);expect(r.status).toBe(0);return r.stdout;};
const call=(url,method='GET',data,who='a',extra={})=>actors[who].context.request.fetch(origin+'/api/v1'+url,{method,headers:{Origin:origin,'X-CSRF-Token':actors[who].me.csrf_token,...extra},...(data===undefined?{}:{data})});
async function upload(bytes=sample,format='pdf',mutate){
 let r=await call('/candidates','POST',{name:'S2架空候補者',summary:'隔離検査の架空試料',fictional_confirmed:true},'a',{'Idempotency-Key':c.randomUUID()});expect(r.status()).toBe(201);const candidate=(await r.json()).id,key=c.randomUUID();
 r=await call(`/candidates/${candidate}/document-uploads`,'POST',{document_kind:'resume',file_format:format,plain_length:bytes.length,fictional_confirmed:true},'a',{'Idempotency-Key':key});expect(r.status()).toBe(201);const job=await r.json();
 const dek=c.randomBytes(32),nonce=c.randomBytes(12),meta=Buffer.from(JSON.stringify({original_name:'S2架空書類.'+format})),length=Buffer.alloc(4);length.writeUInt32BE(meta.length);
 const cipher=c.createCipheriv('aes-256-gcm',dek,nonce);cipher.setAAD(Buffer.from(job.aad));const raw=Buffer.concat([cipher.update(Buffer.concat([length,meta,bytes])),cipher.final(),cipher.getAuthTag()]);if(mutate)mutate(raw);
 const envelope={schema:1,key_version:job.wrap_key_version,wrapped_dek:c.publicEncrypt({key:c.createPublicKey({key:Buffer.from(job.wrap_public_spki,'base64'),format:'der',type:'spki'}),oaepHash:'sha256'},dek).toString('base64url'),nonce:nonce.toString('base64url'),aad:job.aad};
 r=await call(`/document-uploads/${job.upload_id}/authorize`,'POST',{attempt_id:job.attempt_id,ciphertext_hash:c.createHash('sha256').update(raw).digest('hex'),ciphertext_size:raw.length,envelope});expect(r.status()).toBe(200);const ticket=(await r.json()).ticket;
 expect((await call(`/document-uploads/${job.upload_id}/bytes`,'PUT',raw,'a',{'Content-Type':'application/octet-stream','X-Upload-Ticket':ticket})).status()).toBe(202);
 expect((await call(`/document-uploads/${job.upload_id}/complete`,'POST')).status()).toBe(202);return {...job,candidate,key};
}
function launch(probe=false){const r=host('scripts/document_job.py',['--no-build',...(probe?['--probe']:[])]);const lines=r.stdout.trim().split('\n');let result;try{result=JSON.parse(lines.at(-1));}catch{throw Error('JOB_LAUNCH_FAILED');}return {...result,exit:r.status};}
function state(j){return sql(`SELECT state||'|'||coalesce(error_code,'') FROM encrypted_document_jobs WHERE document_id='${j.document_id}';`);}
function claim(j){return JSON.parse(sql(`SELECT document_worker('claim',NULL,NULL,'{}');`));}
function op(j,token,op,body={}){return sql(`SELECT coalesce(document_worker('${op}','${j.document_id}','${token}','${JSON.stringify(body).replaceAll("'","''")}')::text,'DENIED');`);}
function retire(){sql("UPDATE encrypted_document_jobs SET state='rejected',lease_expires_at=now() WHERE state<>'checked';UPDATE upload_sessions SET state='rejected';UPDATE idempotency_records SET state='failed',result_status=409,error_code='S2_TEST_RETIRED',expires_at=now()+interval '7 days' WHERE resource_id IN (SELECT document_id FROM upload_sessions) AND state='processing';");}
async function avReady(){await expect.poll(()=>host('scripts/local.py',['compose','exec','-T','api','sh','-c','curl --fail --silent -H "X-Scan-Key: $SCAN_SHARED_KEY" http://scan:8080/internal/scan/state >/dev/null']).status,{timeout:90000,intervals:[1000]}).toBe(0);}
function key(action,purpose='original'){expect(host('scripts/document_key.py',[purpose,action]).status).toBe(0);}
async function unavailable(j){expect((await call('/documents/'+j.document_id+'/content')).status()).toBe(410);expect((await (await call('/documents/'+j.document_id)).json()).available).toBe(state(j)==='checked|');expect((await call(`/document-uploads/${j.upload_id}`,'GET',undefined,'b')).status()).toBe(404);}
test.beforeAll(async({browser})=>{for(const [who,name] of [['a','agency-a'],['b','agency-b']]){const context=await browser.newContext(),page=await context.newPage();expect((await signIn(page,name)).status()).toBe(303);actors[who]={context,page,me:await identity(context)};}});
test.beforeEach(()=>{retire();key('enable');key('enable','artifact');});
test.afterAll(async()=>{key('enable');key('enable','artifact');expect(host('scripts/document_key.py',['original','activate']).status).toBe(0);expect(host('scripts/document_key.py',['artifact','activate']).status).toBe(0);for(const a of Object.values(actors))await a.context.close();});
test('S2 real broker AV format sandbox, live isolation probes and encrypted manifest',async()=>{
 const j=await upload();const run=launch(true);expect(run.events).toEqual(['checked']);expect(run.stopped).toBe(true);expect(run.exit).toBe(0);expect(state(j)).toBe('checked|');await unavailable(j);
 const row=JSON.parse(sql(`SELECT json_build_object('id',id,'envelope',envelope,'hash',ciphertext_hash)::text FROM document_artifacts WHERE document_id='${j.document_id}' AND state='stored';`));
 const encrypted=cp.execFileSync('docker',['exec',`recruitment-${process.env.RP_INSTANCE}-api-1`,'cat','/data/resumes/encrypted/artifacts/'+row.id+'.cipher'],{env:process.env});
 expect(encrypted.includes(Buffer.from('S2架空'))).toBe(false);
 const e=row.envelope,privateKey=fs.readFileSync(path.join(dir,'artifact-private.pem')),dek=c.privateDecrypt({key:privateKey,oaepHash:'sha256'},Buffer.from(e.wrapped_dek,'base64url'));
 const d=c.createDecipheriv('aes-256-gcm',dek,Buffer.from(e.nonce,'base64url'));d.setAAD(Buffer.from(e.aad));d.setAuthTag(encrypted.subarray(-16));const manifest=JSON.parse(Buffer.concat([d.update(encrypted.subarray(0,-16)),d.final()]));expect(manifest.document_id).toBe(j.document_id);expect(manifest.phase).toBe('ready');expect(manifest.original_hash).toBe(c.createHash('sha256').update(sample).digest('hex'));
 expect(()=>c.privateDecrypt({key:fs.readFileSync(path.join(dir,'upload-private.pem')),oaepHash:'sha256'},Buffer.from(e.wrapped_dek,'base64url'))).toThrow();
 const d2=c.createDecipheriv('aes-256-gcm',dek,Buffer.from(e.nonce,'base64url'));d2.setAAD(Buffer.from(e.aad.replace('manifest','text')));d2.setAuthTag(encrypted.subarray(-16));d2.update(encrypted.subarray(0,-16));expect(()=>d2.final()).toThrow();
 const record=JSON.parse(fs.readFileSync(run.record));expect(new Set(Object.values(record.containers).map(v=>v.user)).size).toBe(3);expect(record.containers.sandbox.mount_targets).toEqual([]);expect(record.containers.relay.mount_targets).toEqual([]);
});
test('S2 native Sheets XLSX follows real AV and one job per fresh sandbox',async()=>{
 for(const name of ['sheets-resume.xlsx','sheets-career-history.xlsx']){const j=await upload(fs.readFileSync(path.join(__dirname,'fixtures',name)),'xlsx');expect(launch().events).toEqual(['checked']);expect(state(j)).toBe('checked|');await unavailable(j);retire();}
});
test('S2 corrupted GCM tag never reaches AV or parser; terminal outcome is retained',async()=>{
 const j=await upload(sample,'pdf',r=>r[r.length-1]^=1);expect(launch().events).toEqual(['rejected']);expect(state(j)).toBe('rejected|CRYPTO_REJECTED');await unavailable(j);const result=await call(`/candidates/${j.candidate}/document-upload-outcome?key=${j.key}`);expect((await result.json()).state).toBe('failed');
 expect(sql(`SELECT count(*) FROM document_artifacts WHERE document_id='${j.document_id}' AND state='stored';`)).toBe('0');
});
test('S2 scanner outage refuses, retains accepted ID and recovers in a new generation',async()=>{
 const j=await upload();control('stop','scan');try{expect(launch().events).toEqual(['retryable']);expect(state(j)).toBe('retryable|WORKER_UNAVAILABLE');await unavailable(j);}finally{control('up','-d','--no-build','--wait','--wait-timeout','60','scan');await avReady();}
 expect(launch().events).toEqual(['checked']);expect(state(j)).toBe('checked|');expect(sql(`SELECT count(*) FROM document_artifacts WHERE document_id='${j.document_id}';`)).toBe('2');
});
test('S2 original/artifact revocation persists across restart, blocks leased decrypt and commit',async()=>{
 const j=await upload(),lease=claim(j);expect(lease.document_id).toBe(j.document_id);expect(op(j,lease.lease_token,'authorize')).not.toBe('DENIED');
 for(const purpose of ['original','artifact']){key('revoke',purpose);expect(op(j,lease.lease_token,'authorize')).toBe('DENIED');expect(op(j,lease.lease_token,'commit',{})).toBe('DENIED');control('restart','api');expect(sql(`SELECT enabled FROM document_key_versions WHERE purpose='${purpose}';`)).toBe('f');key('enable',purpose);}
 sql(`UPDATE encrypted_document_jobs SET lease_expires_at=now()-interval '1 second' WHERE document_id='${j.document_id}';`);expect(launch().events).toEqual(['checked']);expect(state(j)).toBe('checked|');await unavailable(j);
});
test('S2 ownership archive and stale lease fencing deny decryption; expired worker recovers',async()=>{
 const j=await upload(),old=claim(j);expect(op(j,c.randomUUID(),'authorize')).toBe('DENIED');
 const user=sql(`SELECT user_id FROM encrypted_document_jobs WHERE document_id='${j.document_id}';`);
 sql(`UPDATE users SET active=false WHERE id='${user}';`);try{expect(op(j,old.lease_token,'authorize')).toBe('DENIED');}finally{sql(`UPDATE users SET active=true WHERE id='${user}';`);}
 sql(`UPDATE organizations SET active=false WHERE id='${old.org_id}';`);try{expect(op(j,old.lease_token,'authorize')).toBe('DENIED');}finally{sql(`UPDATE organizations SET active=true WHERE id='${old.org_id}';`);}
 sql(`UPDATE encrypted_document_jobs SET lease_expires_at=now()-interval '1 second' WHERE document_id='${j.document_id}';`);const current=claim(j);expect(current.generation).not.toBe(old.generation);expect(current.artifact_id).not.toBe(old.artifact_id);expect(op(j,old.lease_token,'authorize')).toBe('DENIED');expect(op(j,old.lease_token,'commit',{})).toBe('DENIED');
 sql(`UPDATE candidates SET archived_at=now(),version=version+1 WHERE id='${j.candidate}';`);expect(op(j,current.lease_token,'authorize')).toBe('DENIED');await unavailable(j);
});
test('S2 worker role cannot issue arbitrary DB queries; public gateway does not expose control',async()=>{
 const j=await upload();expect(()=>sql('SET ROLE app_runtime;SELECT document_worker(\'claim\',NULL,NULL,\'{}\');')).toThrow(/42501/);expect(()=>sql('SET ROLE app_auth;SELECT * FROM encrypted_document_jobs;')).toThrow(/42501/);
 expect((await actors.a.context.request.post(origin+'/claim',{data:{}})).status()).toBe(404);
 const denied=control('exec','-T','api','curl','--silent','--output','/dev/null','--write-out','%{http_code}','--request','POST','http://api-control:8081/claim');expect(denied.trim()).toBe('409');await unavailable(j);
});

test('S2 rotation retains old original and artifact keys and restores encrypted manifests',async()=>{
 const old=await upload();
 for(const purpose of ['original','artifact'])expect(host('scripts/document_key.py',[purpose,'rotate','--version',purpose+'-v2']).status).toBe(0);
 try{
  expect(launch().events).toEqual(['checked']);expect(state(old)).toBe('checked|');
  const current=await upload();expect(current.wrap_key_version).toBe('original-v2');expect(launch().events).toEqual(['checked']);
  const rows=JSON.parse(sql(`SELECT json_agg(json_build_object('id',id,'envelope',envelope)) FROM document_artifacts WHERE document_id IN ('${old.document_id}','${current.document_id}') AND state='stored';`));
  for(const row of rows){const e=row.envelope;expect(e.key_version).toBe('artifact-v2');const backup=fs.readFileSync(path.join(dir,'keyring/artifact-v2.pem'));const raw=cp.execFileSync('docker',['exec',`recruitment-${process.env.RP_INSTANCE}-api-1`,'cat','/data/resumes/encrypted/artifacts/'+row.id+'.cipher'],{env:process.env});const dek=c.privateDecrypt({key:c.createPrivateKey(backup),oaepHash:'sha256'},Buffer.from(e.wrapped_dek,'base64url'));const d=c.createDecipheriv('aes-256-gcm',dek,Buffer.from(e.nonce,'base64url'));d.setAAD(Buffer.from(e.aad));d.setAuthTag(raw.subarray(-16));expect(JSON.parse(Buffer.concat([d.update(raw.subarray(0,-16)),d.final()])).phase).toBe('ready');}
  expect(fs.existsSync(path.join(dir,'upload-private.pem'))).toBe(true);expect(fs.existsSync(path.join(dir,'artifact-private.pem'))).toBe(true);
 }finally{for(const purpose of ['original','artifact'])expect(host('scripts/document_key.py',[purpose,'activate']).status).toBe(0);}
});
test('S2 real malware and invalid format are terminal without making documents usable',async()=>{
 const eicar=Buffer.from('X5O!P%@AP[4'+String.fromCharCode(92)+'PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
 for(const [bytes,code] of [[eicar,'AV_BLOCKED'],[Buffer.from('fictional invalid PDF'),'FORMAT_REJECTED']]){const j=await upload(bytes);expect(launch().events).toEqual(['rejected']);expect(state(j)).toBe('rejected|'+code);await unavailable(j);retire();}
});
test('S2 browser encrypted intake becomes view-ready after checking and page reload',async()=>{
 const j=await upload();expect(launch().events).toEqual(['checked']);const p=actors.a.page,errors=[];p.on('pageerror',()=>errors.push('PAGE_ERROR'));
 await p.goto(origin+'/candidates/'+j.candidate);await expect(p.getByRole('heading',{name:'S2架空候補者',exact:true})).toBeVisible();expect(await p.title()).toBeTruthy();expect(await p.locator('nextjs-portal').count()).toBe(0);await p.reload();await expect(p.getByText('S2架空書類.pdf',{exact:true}).first()).toBeVisible();expect(errors).toEqual([]);await shot(p,'s2-checked-pending');await unavailable(j);
});

test('S2 missing original key permission refuses and restored old material resumes same document',async()=>{
 const j=await upload(),file=path.join(dir,'upload-private.pem'),before=fs.readFileSync(file),mode=fs.statSync(file).mode&0o777;
 fs.chmodSync(file,0);try{expect(launch().events).toEqual(['retryable']);expect(state(j)).toBe('retryable|WORKER_UNAVAILABLE');await unavailable(j);}finally{fs.chmodSync(file,mode);}
 expect(fs.readFileSync(file).equals(before)).toBe(true);expect(launch().events).toEqual(['checked']);expect(state(j)).toBe('checked|');
});
test('S2 actual broker process loss is fenced and resumes after lease expiry without another upload',async()=>{
 const j=await upload(),before=new Set(fs.readdirSync(path.join(dir,'jobs')));control('pause','scan');
 let child,finished;
 try{
  child=cp.spawn('python3',['scripts/document_job.py','--no-build'],{cwd:root,env:process.env,stdio:['ignore','pipe','pipe']});let out='';child.stdout.on('data',b=>out+=b);child.stderr.resume();finished=new Promise(resolve=>child.on('close',code=>resolve({code,out})));
  await expect.poll(()=>state(j).split('|')[0],{timeout:25000}).toBe('processing');
  const name=fs.readdirSync(path.join(dir,'jobs')).find(v=>!before.has(v));expect(name).toBeTruthy();
  const probeCode="const net=require('node:net'),fs=require('node:fs');(async()=>{const yes=[],no=[];for(const [h,p] of [['api-control',8081],['api-control',8080],['api-public',8080],['db',5432],['invoice-renderer',8080],['1.1.1.1',443],['relay',8080],['scan',8080]]){const ok=await new Promise(r=>{const s=net.connect({host:h,port:p});s.setTimeout(300);s.on('connect',()=>{s.destroy();r(true)});s.on('timeout',()=>{s.destroy();r(false)});s.on('error',()=>r(false));});(ok?yes:no).push(h+':'+p);}console.log(JSON.stringify({yes,no,artifact_private_absent:!fs.existsSync('/run/artifact-private.pem'),docker_absent:!fs.existsSync('/var/run/docker.sock')}));})();";
  const proof=JSON.parse(cp.execFileSync('docker',['exec',name+'-broker-1','node','-e',probeCode],{env:process.env,encoding:'utf8',timeout:10000}));expect(proof.yes).toEqual(['api-control:8081','relay:8080','scan:8080']);expect(proof.no).toHaveLength(5);expect(proof.artifact_private_absent&&proof.docker_absent).toBe(true);fs.writeFileSync(path.join(dir,'artifacts/s2-broker-isolation.json'),JSON.stringify(proof,null,2)+'\n');
  cp.execFileSync('docker',['kill',name+'-broker-1'],{env:process.env,stdio:'pipe'});const result=await finished;expect(result.code).toBe(1);expect(state(j).split('|')[0]).toBe('processing');await unavailable(j);
 }finally{control('unpause','scan');if(finished)await finished;}
 sql(`UPDATE encrypted_document_jobs SET lease_expires_at=now()-interval '1 second' WHERE document_id='${j.document_id}';`);await avReady();expect(launch().events).toEqual(['checked']);expect(sql(`SELECT count(*) FROM documents WHERE id='${j.document_id}';`)).toBe('1');expect(sql(`SELECT count(DISTINCT generation) FROM document_artifacts WHERE document_id='${j.document_id}';`)).toBe('2');
});

test('S2 invoice and original inspection routes reject the opposite service purpose',async()=>{
 const probe="import os,json,urllib.request,urllib.error\nresult=[]\nfor path in ['/internal/pdf/render-invoice','/internal/document/check']:\n try:result.append(urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8080'+path,data=b'x',headers={'X-PDF-Key':os.environ['PDF_SHARED_KEY'],'Content-Type':'application/pdf'})).status)\n except urllib.error.HTTPError as e:result.append(e.code)\nprint(json.dumps(result))";
 const legacy=JSON.parse(control('exec','-T','pdf-renderer','python','-c',probe)),invoice=JSON.parse(control('exec','-T','invoice-renderer','python','-c',probe));expect(legacy[0]).toBe(404);expect(invoice[1]).toBe(404);
});

test('S2 idle worker has no job, performs no decryption and stops cleanly',async()=>{const run=launch();expect(run.events).toEqual(['no_job']);expect(run.exit).toBe(0);expect(run.stopped).toBe(true);});
