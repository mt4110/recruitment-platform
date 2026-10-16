const {test,expect,request}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process'),http=require('node:http');
const {sql,signIn,identity,origin,shot}=require('./helpers.cjs');
const actors={},errors=[];let expectedNetwork=false;const dir=process.env.RP_E2E_DIR;
const A='00000000-0000-0000-0000-000000000001',B='00000000-0000-0000-0000-000000000002';
const sample=fs.readFileSync(path.resolve(__dirname,'../apps/web/public/sample-resume.pdf'));
const headers=who=>({Origin:origin,'X-CSRF-Token':actors[who].me.csrf_token});
const call=(url,method='GET',data,who='a',extra={})=>actors[who].context.request.fetch(origin+'/api/v1'+url,{method,headers:{...headers(who),...extra},...(data===undefined?{}:{data})});
async function candidate(){const r=await call('/candidates','POST',{name:'S1架空候補者',summary:'暗号化受付の架空検証',fictional_confirmed:true},'a',{'Idempotency-Key':crypto.randomUUID()});expect(r.status()).toBe(201);return (await r.json()).id;}
async function reserve(c,key=crypto.randomUUID(),size=sample.length,format='pdf'){const r=await call(`/candidates/${c}/document-uploads`,'POST',{document_kind:'resume',file_format:format,plain_length:size,fictional_confirmed:true},'a',{'Idempotency-Key':key});expect(r.status()).toBe(201);return {r:await r.json(),key,c};}
async function encrypted(res,bytes=sample){
 const r=res.r,key=crypto.randomBytes(32),nonce=crypto.randomBytes(12),meta=Buffer.from(JSON.stringify({original_name:'架空S1.pdf'})),length=Buffer.alloc(4);length.writeUInt32BE(meta.length);
 const cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from(r.aad));const body=Buffer.concat([cipher.update(Buffer.concat([length,meta,bytes])),cipher.final(),cipher.getAuthTag()]);
 const wrapped=crypto.publicEncrypt({key:crypto.createPublicKey({key:Buffer.from(r.wrap_public_spki,'base64'),format:'der',type:'spki'}),oaepHash:'sha256',padding:crypto.constants.RSA_PKCS1_OAEP_PADDING},key);
 const payload={attempt_id:r.attempt_id,ciphertext_hash:crypto.createHash('sha256').update(body).digest('hex'),ciphertext_size:body.length,envelope:{schema:1,key_version:r.wrap_key_version,wrapped_dek:wrapped.toString('base64url'),nonce:nonce.toString('base64url'),aad:r.aad}};
 return {...res,body,payload};
}
async function authorize(e){const r=await call(`/document-uploads/${e.r.upload_id}/authorize`,'POST',e.payload);expect(r.status()).toBe(200);return {...e,authorization:await r.json()};}
const put=(e,body=e.body,extra={})=>call(`/document-uploads/${e.r.upload_id}/bytes`,'PUT',body,'a',{'Content-Type':'application/octet-stream','X-Upload-Ticket':e.authorization.ticket,...extra});
const status=async e=>{const r=await call(`/document-uploads/${e.r.upload_id}`);expect(r.status()).toBe(200);return r.json();};
const complete=e=>call(`/document-uploads/${e.r.upload_id}/complete`,'POST');
function signTestTicket(ticket,change){const config=Object.fromEntries(fs.readFileSync(path.join(dir,'local.env'),'utf8').split('\n').filter(v=>v.includes('=')).map(v=>v.split(/=(.*)/s).slice(0,2)));const body=JSON.parse(Buffer.from(ticket.split('.')[0],'base64url'));change(body);const payload=Buffer.from(JSON.stringify(body)).toString('base64url');return payload+'.'+crypto.createHmac('sha256',Buffer.from(config.UPLOAD_TICKET_KEY,'base64url')).update(payload).digest('base64url');}
function retire(){sql("UPDATE upload_sessions SET state='rejected' WHERE state<>'rejected'; UPDATE idempotency_records SET state='failed',result_status=409,error_code='S1_TEST_RETIRED',expires_at=now()+interval '7 days' WHERE resource_id IN (SELECT document_id FROM upload_sessions) AND state='processing';");}
function restart(){const p=cp.spawnSync('python3',['scripts/local.py','compose','restart','api'],{env:process.env,cwd:path.resolve(__dirname,'..'),stdio:'pipe'});expect(p.status).toBe(0);}
async function ready(){await expect.poll(async()=>{try{return (await actors.a.context.request.get(origin+'/ready')).status()}catch{return 0}},{timeout:60000}).toBe(200);}
function disk(name){return cp.execFileSync('docker',['exec',`recruitment-${process.env.RP_INSTANCE}-api-1`,'cat',name],{env:process.env});}
test.beforeAll(async({browser})=>{for(const [who,name] of [['a','agency-a'],['b','agency-b']]){const context=await browser.newContext(),page=await context.newPage();page.on('console',m=>{if(['error','warning'].includes(m.type())&&!/^Failed to load resource: the server responded with a status of (400|401|403|404|409|413|422|429|503)\b/.test(m.text())&&!(expectedNetwork&&/net::ERR_FAILED/.test(m.text())))errors.push('UNEXPECTED_CONSOLE');});page.on('pageerror',()=>errors.push('PAGE_ERROR'));expect((await signIn(page,name)).status()).toBe(303);actors[who]={context,page,me:await identity(context)};}});
test.beforeEach(()=>retire());
test.afterAll(async()=>{for(const a of Object.values(actors))await a.context.close();expect(errors).toEqual([]);});
test('S1 reservation replay, fixed scope, no auth/CSRF and metadata bounds',async()=>{
 const c=await candidate(),e=await reserve(c);const again=await reserve(c,e.key);expect(again.r.document_id).toBe(e.r.document_id);expect(again.r.attempt_id).toBe(e.r.attempt_id);
 const mismatch=await call(`/candidates/${c}/document-uploads`,'POST',{document_kind:'career_history',file_format:'pdf',plain_length:sample.length,fictional_confirmed:true},'a',{'Idempotency-Key':e.key});expect(mismatch.status()).toBe(409);
 for(const suffix of ['', '/attempts','/authorize','/complete']){const response=await call('/document-uploads/'+e.r.upload_id+suffix,suffix?'POST':'GET',suffix==='/authorize'?{...((await encrypted(e)).payload)}:undefined,'b');expect(response.status()).toBe(404);}
 const noCsrf=await actors.a.context.request.post(origin+`/api/v1/document-uploads/${e.r.upload_id}/attempts`,{headers:{Origin:origin}});expect(noCsrf.status()).toBe(403);
 expect((await call(`/candidates/${c}/document-uploads`,'POST',{document_kind:'resume',file_format:'pdf',plain_length:10485761,fictional_confirmed:true},'a',{'Idempotency-Key':crypto.randomUUID()})).status()).toBe(422);
 expect(sql(`BEGIN;SET LOCAL ROLE app_runtime;SELECT set_config('app.user_id','10000000-0000-0000-0000-000000000002',true),set_config('app.org_id','${A}',true);SELECT count(*) FROM upload_sessions;ROLLBACK;`).split('\n').filter(v=>/^\d+$/.test(v))).toEqual(['0']);
});
test('S1 authorized immutable envelope, tampered expired wrong-purpose tickets and current login',async()=>{
 const e=await authorize(await encrypted(await reserve(await candidate())));
 expect((await call(`/document-uploads/${e.r.upload_id}/authorize`,'POST',{...e.payload,ciphertext_hash:'a'.repeat(64)})).status()).toBe(409);
 for(const ticket of [e.authorization.ticket+'x',signTestTicket(e.authorization.ticket,t=>t.expires=0),signTestTicket(e.authorization.ticket,t=>t.method='GET'),signTestTicket(e.authorization.ticket,t=>t.purpose='view')])expect((await put(e,e.body,{'X-Upload-Ticket':ticket})).status()).toBe(409);
 expect((await call(`/document-uploads/${e.r.upload_id}/bytes`,'PUT',e.body,'b',{'Content-Type':'application/octet-stream','X-Upload-Ticket':e.authorization.ticket})).status()).toBe(404);
 const anonymous=await request.newContext();try{expect((await anonymous.put(origin+e.authorization.upload_url,{data:e.body,headers:{Origin:origin,'Content-Type':'application/octet-stream','X-Upload-Ticket':e.authorization.ticket}})).status()).toBe(401);}finally{await anonymous.dispose();}
});
test('S1 two PUTs and complete attach only once; uninspected ciphertext stays unavailable',async()=>{
 const e=await authorize(await encrypted(await reserve(await candidate())));const responses=await Promise.all([put(e),put(e)]);expect(responses.map(v=>v.status())).toEqual([202,202]);expect((await status(e)).attempt_state).toBe('stored');
 const completed=await Promise.all([complete(e),complete(e)]);expect(completed.map(v=>v.status())).toEqual([202,202]);expect((await completed[0].json()).document_id).toBe(e.r.document_id);
 expect(sql(`SELECT (SELECT count(*) FROM encrypted_document_jobs WHERE document_id='${e.r.document_id}'),(SELECT count(*) FROM documents WHERE id='${e.r.document_id}');`)).toBe('1|1');
 const d=await call('/documents/'+e.r.document_id);expect((await d.json()).available).toBe(false);expect((await call('/documents/'+e.r.document_id+'/content')).status()).toBe(410);expect((await call('/documents/'+e.r.document_id+'/retry','POST')).status()).toBe(503);
 const stage=sql(`SELECT staging_key FROM upload_attempts WHERE id='${e.r.attempt_id}';`);const ciphertext=disk('/data/resumes/encrypted/'+stage+'.cipher');expect(ciphertext.equals(e.body)).toBe(true);expect(ciphertext.includes(sample)).toBe(false);expect(sql(`SELECT original_name IS NULL AND sha256 IS NULL FROM documents WHERE id='${e.r.document_id}';`)).toBe('t');
 const appResult=await call('/applications','POST',{candidate_id:e.c,job_id:'30000000-0000-0000-0000-000000000001',reason:'S1架空の未検査書類'},'a',{'Idempotency-Key':crypto.randomUUID()});expect(appResult.status()).toBe(201);const application=await appResult.json(),c=await(await call('/candidates/'+e.c)).json(),j=await(await call('/jobs/30000000-0000-0000-0000-000000000001')).json();
 const refused=await call(`/applications/${application.id}/submit`,'POST',{version:application.version,candidate_version:c.version,job_version:j.version,document_ids:[e.r.document_id],fictional_confirmed:true,consent_confirmed:true},'a',{'Idempotency-Key':crypto.randomUUID()});expect(refused.status()).toBe(422);
 const o=await call(`/candidates/${e.c}/document-upload-outcome?key=${e.key}`);expect((await o.json()).state).toBe('processing');
});
test('S1 checksum failure closes old attempt, preserves orphan and creates fresh AAD',async()=>{
 const e=await authorize(await encrypted(await reserve(await candidate())));const changed=Buffer.from(e.body);changed[0]^=1;expect((await put(e,changed)).status()).toBe(409);expect((await status(e)).attempt_state).toBe('closed');
 const next=await call(`/document-uploads/${e.r.upload_id}/attempts`,'POST');expect(next.status()).toBe(201);const r=await next.json();expect(r.attempt_id).not.toBe(e.r.attempt_id);expect(r.aad).not.toBe(e.r.aad);expect(r.document_id).toBe(e.r.document_id);
 expect((await put(e)).status()).toBe(409);const done=await authorize(await encrypted({...e,r}));expect((await put(done)).status()).toBe(202);expect((await complete(done)).status()).toBe(202);
});
test('S1 interrupted stream reconciles after process restart without overwriting bytes',async()=>{
 const e=await authorize(await encrypted(await reserve(await candidate())));const cookie=(await actors.a.context.cookies()).map(c=>`${c.name}=${c.value}`).join('; ');
 await new Promise(resolve=>{const req=http.request(origin+e.authorization.upload_url,{method:'PUT',headers:{...headers('a'),Cookie:cookie,'Content-Type':'application/octet-stream','Content-Length':e.body.length,'X-Upload-Ticket':e.authorization.ticket}});req.on('error',()=>resolve());req.write(e.body.subarray(0,20));setTimeout(()=>req.destroy(),400);});
 restart();await ready();expect((await status(e)).attempt_state).toBe('closed');expect((await complete(e)).status()).toBe(409);expect((await call(`/document-uploads/${e.r.upload_id}/attempts`,'POST')).status()).toBe(201);
});
test('S1 durable manifest restores a lost stored commit; lost complete response keeps same ID',async()=>{
 const e=await authorize(await encrypted(await reserve(await candidate())));expect((await put(e)).status()).toBe(202);
 // Synthetic crash window uses the real authorized envelope and ciphertext. No safety trigger is disabled.
 // A second attempt fixture gets a valid manifest whose receipt was not committed.
 const prepared=await authorize(await encrypted(await reserve(await candidate())));
 const stage=sql(`SELECT staging_key FROM upload_attempts WHERE id='${prepared.r.attempt_id}';`),token=crypto.randomUUID();
 sql(`UPDATE upload_attempts SET state='receiving',lease_token='${token}',receive_deadline=now()+interval '5 minutes' WHERE id='${prepared.r.attempt_id}';`);
 const manifest={attempt:prepared.r.attempt_id,token,hash:prepared.payload.ciphertext_hash,size:prepared.body.length,envelope_hash:sql(`SELECT envelope_hash FROM upload_attempts WHERE id='${prepared.r.attempt_id}';`),finished:new Date().toISOString()};
 const fixture=JSON.stringify({stage,body:prepared.body.toString('base64'),manifest});
 // Node on the host writes via docker cp is avoided; use Python in the qualified renderer to build an archive.
 const archive=cp.execFileSync('python3',['-c',"import io,tarfile,json,base64,sys;v=json.loads(sys.stdin.read());t=tarfile.open(fileobj=sys.stdout.buffer,mode='w|');[(lambda d,n:(lambda m:(setattr(m,'size',len(d)),setattr(m,'uid',1001),setattr(m,'gid',1001),t.addfile(m,io.BytesIO(d))))(tarfile.TarInfo(n)))(d,n) for d,n in [(base64.b64decode(v['body']),v['stage']+'.cipher'),(json.dumps(v['manifest']).encode(),v['stage']+'.manifest')]];t.close()"],{input:fixture});
 cp.execFileSync('docker',['cp','-',`recruitment-${process.env.RP_INSTANCE}-api-1:/data/resumes/encrypted/`],{env:process.env,input:archive});
 restart();await ready();expect((await status(prepared)).attempt_state).toBe('stored');expect((await complete(prepared)).status()).toBe(202);expect((await complete(prepared)).status()).toBe(202);expect((await status(prepared)).document_id).toBe(prepared.r.document_id);
 expect((await call(`/document-uploads/${prepared.r.upload_id}/attempts`,'POST')).status()).toBe(409);
});
test('S1 concurrent organization quota allows ten reservations only, and storage refuses admission',async()=>{
 const c=await candidate();const responses=await Promise.all(Array.from({length:11},()=>call(`/candidates/${c}/document-uploads`,'POST',{document_kind:'resume',file_format:'pdf',plain_length:10485760,fictional_confirmed:true},'a',{'Idempotency-Key':crypto.randomUUID()})));expect(responses.filter(r=>r.status()===201)).toHaveLength(10);expect(responses.filter(r=>r.status()===429)).toHaveLength(1);
 retire();const e=await encrypted(await reserve(c));const before=sql('SELECT orphan_bytes FROM document_storage_baseline;');sql('UPDATE document_storage_baseline SET orphan_bytes=1073741824;');try{expect((await call(`/document-uploads/${e.r.upload_id}/authorize`,'POST',e.payload)).status()).toBe(503);}finally{sql(`UPDATE document_storage_baseline SET orphan_bytes=${before};`);}
});
test('S1 original reservation and authorization deadlines plus seven-day replay tombstone',async()=>{
 const e=await authorize(await encrypted(await reserve(await candidate())));
 const claims=JSON.parse(Buffer.from(e.authorization.ticket.split('.')[0],'base64url'));
 expect(claims.expires).toBeLessThanOrEqual(Math.floor(Date.now()/1000)+300);
 sql(`UPDATE upload_sessions SET reserved_at=now()-interval '25 hours' WHERE id='${e.r.upload_id}';`);expect((await status(e)).state).toBe('rejected');
 expect(sql(`SELECT state,expires_at>now()+interval '6 days' FROM idempotency_records WHERE resource_id='${e.r.document_id}';`)).toBe('failed|t');
 const expired=await reserve(await candidate());
 sql(`UPDATE idempotency_records SET state='failed',result_status=409,error_code='UPLOAD_EXPIRED',expires_at=now()-interval '1 second' WHERE resource_id='${expired.r.document_id}';`);
 for(const route of ['', '/authorize','/complete'])expect((await call(`/document-uploads/${expired.r.upload_id}`+route,route?'POST':'GET',route==='/authorize'?e.payload:undefined)).status()).toBe(409);
 expect((await call(`/candidates/${expired.c}/document-upload-outcome?key=${expired.key}`)).status()).toBe(409);
});
test('S1 actual browser PDF XLSX encryption, draft restart and no plaintext network body',async()=>{
 const p=actors.a.page,c=await candidate();await p.goto(origin+'/candidates/'+c);await expect(p.getByLabel('暗号化受付を使う（検査・閲覧用変換を行います）')).toBeChecked();await expect(p.getByLabel('PDF／XLSXファイル',{exact:true})).toBeEnabled();
 const puts=[];p.on('request',r=>{if(r.method()==='PUT'&&/\/document-uploads\/.+\/bytes$/.test(r.url()))puts.push(r.postDataBuffer());});
 await p.getByLabel('PDF／XLSXファイル',{exact:true}).setInputFiles([{name:'架空S1.pdf',mimeType:'application/pdf',buffer:sample},{name:'架空S1.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:fs.readFileSync(path.join(__dirname,'fixtures/sheets-resume.xlsx'))}]);await p.getByLabel('書類の内容はすべて架空の情報です').check();await p.getByRole('button',{name:'書類を登録する',exact:true}).click();
 await expect(p.getByRole('region',{name:'書類の受付状況'})).toContainText('暗号化して受付済みです');await expect.poll(()=>puts.length).toBe(2);expect(puts.every(b=>!b.includes(Buffer.from('架空S1'))&&!b.includes(sample))).toBe(true);
 const rows=JSON.parse(sql(`SELECT json_agg(json_build_object('stage',a.staging_key,'aad',a.aad,'envelope',a.envelope,'format',s.file_format)) FROM upload_attempts a JOIN upload_sessions s ON s.id=a.upload_id WHERE s.candidate_id='${c}' AND a.state='attached';`));
 const privateKey=fs.readFileSync(path.join(dir,'upload-private.pem'));
 for(const row of rows){const env=row.envelope,bytes=disk('/data/resumes/encrypted/'+row.stage+'.cipher');const dek=crypto.privateDecrypt({key:privateKey,oaepHash:'sha256',padding:crypto.constants.RSA_PKCS1_OAEP_PADDING},Buffer.from(env.wrapped_dek,'base64url'));const decipher=crypto.createDecipheriv('aes-256-gcm',dek,Buffer.from(env.nonce,'base64url'));decipher.setAAD(Buffer.from(row.aad));decipher.setAuthTag(bytes.subarray(-16));const plain=Buffer.concat([decipher.update(bytes.subarray(0,-16)),decipher.final()]);const n=plain.readUInt32BE();expect(n).toBeLessThanOrEqual(4096);expect(JSON.parse(plain.subarray(4,4+n)).original_name).toBe('架空S1.'+row.format);expect(plain.subarray(4+n).equals(row.format==='pdf'?sample:fs.readFileSync(path.join(__dirname,'fixtures/sheets-resume.xlsx')))).toBe(true);}
 const mounts=JSON.parse(cp.execFileSync('docker',['inspect','--format','{{json .Mounts}}',`recruitment-${process.env.RP_INSTANCE}-api-1`],{env:process.env}));expect(mounts.some(m=>m.Destination.includes('private'))).toBe(false);
 await expect(p.getByRole('complementary',{name:'個人下書き'})).toContainText('下書きをサーバーへ保存しました');await shot(p,'s1-encrypted-desktop');await p.reload();await expect(p.getByRole('region',{name:'書類の受付状況'})).toContainText('暗号化して受付済みです');expect(puts).toHaveLength(2);expect(await p.title()).toBeTruthy();expect(await p.locator('nextjs-portal').count()).toBe(0);
});

test('S1 full 10MiB ciphertext admission and route-only maximum size refusal',async()=>{
 const bytes=Buffer.alloc(10485760,0x61),e=await authorize(await encrypted(await reserve(await candidate(),crypto.randomUUID(),bytes.length),bytes));
 expect((await put(e)).status()).toBe(202);expect((await complete(e)).status()).toBe(202);
 expect((await put(e,Buffer.alloc(10489877))).status()).toBe(413);
 const response=await call('/candidates','POST',{name:'a'.repeat(70000),summary:'架空',fictional_confirmed:true},'a',{'Idempotency-Key':crypto.randomUUID()});expect(response.status()).toBe(413);
});
test('S1 lost browser PUT response resumes by receipt after reload, without another PUT',async()=>{
 const p=actors.a.page,c=await candidate();await p.goto(origin+'/candidates/'+c);await expect(p.getByLabel('PDF／XLSXファイル',{exact:true})).toBeEnabled();let puts=0;
 expectedNetwork=true;const pattern='**/api/v1/document-uploads/*/bytes';
 await p.route(pattern,async route=>{puts++;const r=await route.fetch();expect(r.status()).toBe(202);await route.abort('failed');});
 try{await p.getByLabel('PDF／XLSXファイル',{exact:true}).setInputFiles({name:'架空の応答喪失.pdf',mimeType:'application/pdf',buffer:sample});await p.getByLabel('書類の内容はすべて架空の情報です').check();await p.getByRole('button',{name:'書類を登録する',exact:true}).click();await expect(p.getByRole('region',{name:'書類の受付状況'})).toContainText('再試行待ち');await p.reload();await expect(p.getByRole('region',{name:'書類の受付状況'})).toContainText('暗号化して受付済みです');expect(puts).toBe(1);expect(sql(`SELECT count(*) FROM encrypted_document_jobs j JOIN upload_sessions s ON s.document_id=j.document_id WHERE s.candidate_id='${c}';`)).toBe('1');}finally{await p.unroute(pattern);expectedNetwork=false;}
});

test('S1 retained ciphertext gets a fresh attempt after authorization window expires',async()=>{
 const p=actors.a.page,c=await candidate();await p.goto(origin+'/candidates/'+c);await expect(p.getByLabel('PDF／XLSXファイル',{exact:true})).toBeEnabled();let authorized=false,posts=0;
 const auth='**/api/v1/document-uploads/*/authorize',status='**/api/v1/document-uploads/*';
 await p.route(auth,async route=>{posts++;const r=await route.fetch();if(!authorized){authorized=true;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'架空の応答中断'}})});}else await route.fulfill({response:r});});
 await p.route(status,async route=>{if(route.request().method()!=='GET'){await route.fallback();return;}const r=await route.fetch(),value=await r.json();if(value.attempt_state==='authorized')value.attempt_expires_at='2000-01-01T00:00:00Z';await route.fulfill({response:r,json:value});});
 try{await p.getByLabel('PDF／XLSXファイル',{exact:true}).setInputFiles({name:'架空の認可期限.pdf',mimeType:'application/pdf',buffer:sample});await p.getByLabel('書類の内容はすべて架空の情報です').check();await p.getByRole('button',{name:'書類を登録する',exact:true}).click();await expect(p.getByRole('region',{name:'書類の受付状況'})).toContainText('再試行待ち');await p.getByRole('button',{name:'受付結果を確認して再試行する',exact:true}).click();await expect(p.getByRole('region',{name:'書類の受付状況'})).toContainText('暗号化して受付済みです');expect(posts).toBe(2);expect(sql(`SELECT count(*) FROM upload_attempts a JOIN upload_sessions s ON s.id=a.upload_id WHERE s.candidate_id='${c}';`)).toBe('2');}finally{await p.unroute(auth);await p.unroute(status);}
});
test('S1 composite foreign keys reject cross-context reference injection',async()=>{
 const e=await reserve(await candidate());
 const actor='10000000-0000-0000-0000-000000000002';
 const begin=`BEGIN;SET LOCAL ROLE app_runtime;SELECT set_config('app.user_id','${actor}',true),set_config('app.org_id','${B}',true);`;
 expect(()=>sql(begin+`INSERT INTO upload_attempts(id,upload_id,org_id,user_id,wrap_version,aad,staging_key) VALUES('${crypto.randomUUID()}','${e.r.upload_id}','${B}','${actor}','original-v1','invalid-cross-context','${crypto.randomUUID()}');ROLLBACK;`)).toThrow('DB_CONTROL_FAILED:23503');
 const a=await authorize(await encrypted(e));expect((await put(a)).status()).toBe(202);expect((await complete(a)).status()).toBe(202);
 expect(()=>sql(begin+`UPDATE encrypted_document_jobs SET org_id='${B}' WHERE document_id='${e.r.document_id}';ROLLBACK;`)).toThrow('DB_CONTROL_FAILED:42501');
 expect(sql("SELECT count(*) FROM pg_constraint WHERE conname IN ('upload_attempt_owned_session','upload_canonical_owned_attempt','encryption_owned_original','encryption_owned_attempt','encrypted_job_owned_document');")).toBe('5');
});
