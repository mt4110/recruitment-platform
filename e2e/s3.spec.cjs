const {test,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),c=require('node:crypto');
const {sql,signIn,identity,origin,shot}=require('./helpers.cjs');
const root=path.resolve(__dirname,'..'),actors={},sample=fs.readFileSync(path.join(root,'apps/web/public/sample-resume.pdf'));
function host(script,args=[]){return cp.spawnSync('python3',[script,...args],{cwd:root,env:process.env,encoding:'utf8',timeout:150000});}
const call=(url,method='GET',data,who='a',extra={})=>actors[who].context.request.fetch(origin+'/api/v1'+url,{method,headers:{Origin:origin,'X-CSRF-Token':actors[who].me.csrf_token,...extra},...(data===undefined?{}:{data})});
// State probes intentionally refuse while the scanner lock is occupied. Verify
// that refusal, retry only these idempotent positive reads, and still require 200.
const readRecovery={};
async function readyView(url,who='a'){
 let r;
 for(let attempt=0;attempt<10;attempt++){
  r=await call(url,'GET',undefined,who);
  if(r.status()!==503)return r;
  const e=await r.json();expect(e.error?.code).toBe('SCANNER_UNAVAILABLE');
  expect(Object.keys(e)).toEqual(['error']);expect(e).not.toHaveProperty('content');expect(e).not.toHaveProperty('pages');
  const name=test.info().title;readRecovery[name]=(readRecovery[name]||0)+1;
  if(attempt<9)await new Promise(resolve=>setTimeout(resolve,200));
 }
 return r;
}
async function upload(bytes=sample,format='pdf',existing=null,accepted=true){
 const row=sql(`SELECT count(*)||'|'||coalesce(ceil(max(61-extract(epoch FROM now()-created_at))),0)::integer FROM document_admissions WHERE user_id='${actors.a.me.user.id}' AND created_at>now()-interval '1 minute';`).split('|').map(Number);if(row[0]>=8)await new Promise(resolve=>setTimeout(resolve,row[1]*1000));
 let r=existing?null:await call('/candidates','POST',{name:'S3架空候補者',summary:'安全な表示の架空試料',fictional_confirmed:true},'a',{'Idempotency-Key':c.randomUUID()});if(r)expect(r.status()).toBe(201);const candidate=existing||await r.json();
 r=await call(`/candidates/${candidate.id}/document-uploads`,'POST',{document_kind:'resume',file_format:format,plain_length:bytes.length,fictional_confirmed:true},'a',{'Idempotency-Key':c.randomUUID()});expect(r.status()).toBe(201);const job=await r.json();
 const dek=c.randomBytes(32),nonce=c.randomBytes(12),meta=Buffer.from(JSON.stringify({original_name:'S3架空書類.'+format})),length=Buffer.alloc(4);length.writeUInt32BE(meta.length);
 const cipher=c.createCipheriv('aes-256-gcm',dek,nonce);cipher.setAAD(Buffer.from(job.aad));const raw=Buffer.concat([cipher.update(Buffer.concat([length,meta,bytes])),cipher.final(),cipher.getAuthTag()]);
 const envelope={schema:1,key_version:job.wrap_key_version,wrapped_dek:c.publicEncrypt({key:c.createPublicKey({key:Buffer.from(job.wrap_public_spki,'base64'),format:'der',type:'spki'}),oaepHash:'sha256'},dek).toString('base64url'),nonce:nonce.toString('base64url'),aad:job.aad};
 r=await call(`/document-uploads/${job.upload_id}/authorize`,'POST',{attempt_id:job.attempt_id,ciphertext_hash:c.createHash('sha256').update(raw).digest('hex'),ciphertext_size:raw.length,envelope});expect(r.status()).toBe(200);const ticket=(await r.json()).ticket;
 expect((await call(`/document-uploads/${job.upload_id}/bytes`,'PUT',raw,'a',{'Content-Type':'application/octet-stream','X-Upload-Ticket':ticket})).status()).toBe(202);expect((await call(`/document-uploads/${job.upload_id}/complete`,'POST')).status()).toBe(202);
 const run=host('scripts/document_job.py',['--no-build']);expect(run.status,run.stdout).toBe(accepted?0:1);
 expect(JSON.parse(run.stdout.trim().split('\n').at(-1)).events).toEqual([accepted?'checked':'rejected']);
 let available=false;
 for(let attempt=0;attempt<10;attempt++){
  const d=await call('/documents/'+job.document_id);expect(d.status()).toBe(200);const metadata=await d.json();available=metadata.available;
  if(!accepted||available)break;
  expect(metadata.status).toBe('ready');const name=test.info().title+'.metadata';readRecovery[name]=(readRecovery[name]||0)+1;
  if(attempt<9)await new Promise(resolve=>setTimeout(resolve,200));
 }
 expect(available).toBe(accepted);
 return {...job,candidate};
}
test.beforeAll(async({browser})=>{for(const [who,name] of [['a','agency-a'],['b','agency-b'],['x','employer-x'],['y','employer-y']]){const context=await browser.newContext(),page=await context.newPage();expect((await signIn(page,name)).status()).toBe(303);actors[who]={context,page,me:await identity(context)};}});
test.afterAll(async()=>{fs.writeFileSync(path.join(process.env.RP_E2E_DIR,'artifacts/s3-read-recovery.json'),JSON.stringify({transient_refusals:readRecovery,max_attempts:10,delay_ms:200,required_final_status:200,allowed_transient_code:'SCANNER_UNAVAILABLE'},null,2)+'\n');for(const a of Object.values(actors))await a.context.close();});
test('S3 encrypted PDF becomes PNG and alternate text; browser never receives the original',async()=>{
 const j=await upload(),url='/documents/'+j.document_id+'/view';let r=await readyView(url);expect(r.status()).toBe(200);const v=await r.json();expect(v.format).toBe('pdf');expect(v.pages).toBe(1);expect(v.content.text).toBeTruthy();
 r=await readyView(url+'/pages/1');expect(r.status()).toBe(200);expect(r.headers()['content-type']).toBe('image/png');expect((await r.body()).subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');expect(r.headers()['cache-control']).toContain('no-store');
 for(const who of ['b','x','y'])for(const suffix of ['', '/pages/1'])expect((await call(url+suffix,'GET',undefined,who)).status()).toBe(404);
 for(const suffix of ['/pages/0','/pages/21','?url=https://example.invalid'])expect((await call(url+suffix)).status()).toBe(422);
 const raw=await call('/documents/'+j.document_id+'/content');expect(raw.status()).toBe(410);expect((await raw.body()).length).toBe(0);
 const p=actors.a.page,issues=[];p.on('pageerror',()=>issues.push('PAGE_ERROR'));await p.goto(origin+'/candidates/'+j.candidate.id);await expect(p.getByRole('heading',{name:'S3架空候補者',exact:true})).toBeVisible();await p.getByRole('button',{name:'安全な表示を開く'}).click();await expect(p.getByRole('heading',{name:'代替テキスト（抽出順）'})).toBeVisible();await expect(p.locator('.safe-view img')).toBeVisible();expect(await p.title()).toBeTruthy();expect((await p.request.get(origin+'/candidates/'+j.candidate.id)).headers()['content-security-policy']).toContain("object-src 'none'");expect(await p.locator('nextjs-portal').count()).toBe(0);expect(issues).toEqual([]);await viewShot(p,'s3-pdf-desktop');
});
test('S3 Sheets actual output renders saved values without formulas or active links',async()=>{
 for(const name of ['sheets-resume.xlsx','sheets-career-history.xlsx']){const j=await upload(fs.readFileSync(path.join(__dirname,'fixtures',name)),'xlsx');const r=await readyView('/documents/'+j.document_id+'/view');expect(r.status()).toBe(200);const v=await r.json();expect(v.format).toBe('xlsx');expect(v.content.sheets.length).toBeGreaterThan(0);expect(v.content.cells).toBeGreaterThan(0);const p=actors.a.page;await p.goto(origin+'/candidates/'+j.candidate.id);await p.getByRole('button',{name:'安全な表示を開く'}).click();await expect(p.getByText('限定表表示です。',{exact:false})).toBeVisible();await expect(p.locator('.safe-view table').first()).toBeVisible();expect(await p.locator('.safe-view a').count()).toBe(0);await viewShot(p,'s3-'+name.replace('.xlsx',''));}
});
async function json(url,method,data,who='a',status=200){const r=await call(url,method,data,who,{'Idempotency-Key':c.randomUUID()});expect(r.status(),url).toBe(status);return r.json();}
let shared;
test('S3 immutable selected version, current participant access and shared page authorization',async()=>{
 const j=await upload();let job=await json('/jobs','POST',{title:'S3架空求人',description:'安全な共有表示の確認',location:'架空東京',employment_type:'full_time'},'x',201);job=await json('/jobs/'+job.id+'/status','POST',{version:job.version,status:'published'},'x');
 let a=await json('/applications','POST',{candidate_id:j.candidate.id,job_id:job.id,reason:'S3架空の推薦'},'a',201);a=await json('/applications/'+a.id+'/submit','POST',{version:a.version,candidate_version:j.candidate.version,job_version:job.version,document_ids:[j.document_id],fictional_confirmed:true,consent_confirmed:true});
 const extra=await upload(sample,'pdf',j.candidate),url=`/applications/${a.id}/documents/${j.document_id}/view`;shared={...j,a,url};
 for(const who of ['a','x'])for(const suffix of ['', '/pages/1'])expect((await readyView(url+suffix,who)).status()).toBe(200);
 for(const who of ['b','y'])for(const suffix of ['', '/pages/1'])expect((await call(url+suffix,'GET',undefined,who)).status()).toBe(404);
 for(const who of ['a','x'])expect((await call(`/applications/${a.id}/documents/${extra.document_id}/view`,'GET',undefined,who)).status()).toBe(404);
 expect((await call('/documents/'+j.document_id+'/view','GET',undefined,'x')).status()).toBe(404);
 expect((await (await call('/applications/'+a.id,'GET',undefined,'x')).json()).documents.map(d=>d.id)).toEqual([j.document_id]);
});
test('S3 original and artifact revocation reject manifest/image and clear an open browser view',async()=>{
 for(const purpose of ['original','artifact']){
  const p=actors.x.page;await p.goto(origin+'/applications/'+shared.a.id);await p.getByRole('button',{name:'安全な表示を開く'}).click();await expect(p.locator('.safe-view img')).toBeVisible();
  expect(host('scripts/document_key.py',[purpose,'revoke']).status).toBe(0);
  try{for(const who of ['a','x'])for(const suffix of ['', '/pages/1'])expect((await call(shared.url+suffix,'GET',undefined,who)).status()).toBe(404);await p.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(p.locator('.safe-view img')).toHaveCount(0);await expect(p.locator('.safe-view pre')).toHaveCount(0);}
  finally{expect(host('scripts/document_key.py',[purpose,'enable']).status).toBe(0);}
  expect((await readyView(shared.url,'x')).status()).toBe(200);
 }
});
test('S3 missing artifact secret, invalid AAD and viewer outage fail closed without original fallback',async()=>{
 const j=await upload(),url='/documents/'+j.document_id+'/view';
 const secret=path.join(process.env.RP_E2E_DIR,'artifact-private.pem'),mode=fs.statSync(secret).mode&0o777;
 fs.chmodSync(secret,0);try{expect((await call(url)).status()).toBe(404);}finally{fs.chmodSync(secret,mode);}
 const before=JSON.parse(sql(`SELECT json_build_object('id',id,'envelope',envelope) FROM document_derivatives WHERE document_id='${j.document_id}' AND kind='text';`));
 sql(`UPDATE document_derivatives SET envelope=jsonb_set(envelope,'{aad}','"wrong-context"') WHERE id='${before.id}';`);
 try{expect((await call(url)).status()).toBe(404);}finally{sql(`UPDATE document_derivatives SET envelope='${JSON.stringify(before.envelope).replaceAll("'","''")}'::jsonb WHERE id='${before.id}';`);}
 expect(host('scripts/local.py',['compose','stop','artifact-viewer']).status).toBe(0);
 try{expect((await call(url)).status()).toBe(404);expect((await call('/documents/'+j.document_id+'/content')).status()).toBe(410);}finally{expect(host('scripts/local.py',['compose','up','-d','--no-build','--wait','artifact-viewer']).status).toBe(0);}
 expect((await readyView(url)).status()).toBe(200);
});
test('S3 current AV outage denies every new view and page request',async()=>{
 expect(host('scripts/local.py',['compose','stop','scan']).status).toBe(0);
 try{for(const suffix of ['', '/pages/1'])expect((await call(shared.url+suffix,'GET',undefined,'x')).status()).toBe(503);}
 finally{expect(host('scripts/local.py',['compose','up','-d','--no-build','--wait','scan']).status).toBe(0);await expect.poll(()=>host('scripts/local.py',['compose','exec','-T','api','sh','-c','curl --fail --silent -H "X-Scan-Key: $SCAN_SHARED_KEY" http://scan:8080/internal/scan/state >/dev/null']).status,{timeout:90000}).toBe(0);}
 expect((await readyView(shared.url,'x')).status()).toBe(200);
});
test('S3 artifact key rotation retains old viewing and grants only artifact key material to viewer',async()=>{
 expect(host('scripts/document_key.py',['artifact','rotate','--version','artifact-v3']).status).toBe(0);
 try{const j=await upload();expect((await readyView('/documents/'+j.document_id+'/view')).status()).toBe(200);expect((await readyView(shared.url,'x')).status()).toBe(200);const inspect=JSON.parse(cp.execFileSync('docker',['inspect',`recruitment-${process.env.RP_INSTANCE}-artifact-viewer-1`],{env:process.env}))[0];const paths=inspect.Mounts.map(m=>m.Destination);expect(paths.sort()).toEqual(['/run/artifact-private.pem','/run/viewer-auth','/run/viewer-keys']);expect(inspect.NetworkSettings.Networks).toHaveProperty(`recruitment-${process.env.RP_INSTANCE}_pdf`);expect(Object.keys(inspect.NetworkSettings.Networks)).toHaveLength(1);expect(inspect.HostConfig.ReadonlyRootfs).toBe(true);expect(inspect.HostConfig.CapDrop).toEqual(['ALL']);}
 finally{expect(host('scripts/document_key.py',['artifact','activate']).status).toBe(0);}
});
test('S3 share revoke removes open pages/text and denies subsequent image and manifest requests',async()=>{
 const p=actors.x.page;await p.goto(origin+'/applications/'+shared.a.id);await p.getByRole('button',{name:'安全な表示を開く'}).click();await expect(p.locator('.safe-view img')).toBeVisible();
 shared.a=await json('/applications/'+shared.a.id+'/revoke-sharing','POST',{version:shared.a.version,reason:'S3架空の共有取消'});
 for(const suffix of ['', '/pages/1']){expect((await call(shared.url+suffix,'GET',undefined,'x')).status()).toBe(404);expect((await readyView(shared.url+suffix)).status()).toBe(200);}
 await p.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(p.locator('.safe-view img')).toHaveCount(0);await expect(p.locator('.safe-view pre')).toHaveCount(0);await shot(p,'s3-revoked-share');
});
test('S3 old original and invoice PDF endpoints return empty 410 to every actor and anonymous user',async({request})=>{
 const paths=[`/documents/${shared.document_id}/content`,`/applications/${shared.a.id}/documents/${shared.document_id}/content`,`/applications/${shared.a.id}/invoice-preview.pdf`];
 for(const url of paths){for(const who of ['a','b','x','y']){const r=await call(url,'GET',undefined,who);expect(r.status()).toBe(410);expect((await r.body()).length).toBe(0);}const r=await request.get(origin+'/api/v1'+url);expect(r.status()).toBe(410);expect((await r.body()).length).toBe(0);}
});

async function viewShot(p,name){await p.locator('.safe-view').scrollIntoViewIfNeeded();await p.screenshot({path:path.join(process.env.RP_E2E_DIR,'artifacts',name+'.png'),fullPage:false});}
const vf=name=>fs.readFileSync(path.join(process.env.RP_E2E_DIR,'view-fixtures',name));
test('S3 fixed XLSX type date merge hidden and stale-cache expectations from S0 remain true',async()=>{
 const expected=JSON.parse(vf('manifest.json')).xlsx_expected;
 for(const name of ['types.xlsx','dates1900.xlsx','dates1904.xlsx','merged.xlsx','hidden.xlsx']){
  const j=await upload(vf(name),'xlsx'),r=await readyView('/documents/'+j.document_id+'/view');expect(r.status()).toBe(200);const value=(await r.json()).content;
  const cells=new Map(value.sheets[0].cells.map(x=>[x.cell,x]));for(const [cell,want] of Object.entries(expected[name]))expect(cells.get(cell).value).toBe(want);
  if(name==='types.xlsx'){expect(cells.get('A6').warnings).toContain('再計算していない保存値');expect(cells.get('A8').warnings).toContain('保存エラー値');const p=actors.a.page;await p.goto(origin+'/candidates/'+j.candidate.id);await p.getByRole('button',{name:'安全な表示を開く'}).click();await expect(p.locator('.safe-view table').first()).toContainText('<script>noop</script>');expect(await p.locator('.safe-view script,.safe-view a').count()).toBe(0);await p.setViewportSize({width:390,height:844});await expect.poll(()=>p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await viewShot(p,'s3-xlsx-types-mobile');await p.setViewportSize({width:1280,height:900});}
  if(name==='hidden.xlsx'){expect(value.sheets[0].hidden).toBe(true);const p=actors.a.page;await p.goto(origin+'/candidates/'+j.candidate.id);await p.getByRole('button',{name:'安全な表示を開く'}).click();await expect(p.getByText('（非表示シート）',{exact:false})).toBeVisible();const hiddenSheet=p.locator('.safe-view section section').first();await expect(hiddenSheet.locator('table')).toHaveCount(0);await p.getByLabel('非表示のシート・行・列を明示的に開く').check();await expect(hiddenSheet.locator('table')).toContainText('20');await viewShot(p,'s3-xlsx-hidden');}
 }
});
test('S3 unrepresentable XLSX refs types merges and quotas never become ready or truncated views',async()=>{
 for(const name of ['crossed.xlsx','unknown.xlsx','bad-reference.xlsx','bad-bool.xlsx','too-long-cell.xlsx','too-many-cells.xlsx','too-much-text.xlsx']){
  const j=await upload(vf(name),'xlsx',null,false);expect((await call('/documents/'+j.document_id+'/view')).status()).toBe(404);expect(sql(`SELECT status FROM documents WHERE id='${j.document_id}';`)).toBe('rejected');
 }
});
test('S3 Japanese twenty-page order and image-only text alternative, geometry never silently downscaled',async()=>{
 const j=await upload(vf('twenty.pdf')),v=await (await call('/documents/'+j.document_id+'/view')).json();expect(v.pages).toBe(20);expect(v.content.text).toContain('請求書');expect([...v.content.text.matchAll(/PAGE\s+([0-9]{2})/g)].map(m=>m[1])).toEqual(Array.from({length:20},(_,i)=>String(i+1).padStart(2,'0')));
 for(const n of [1,2,10,20]){const r=await readyView('/documents/'+j.document_id+'/view/pages/'+n);expect(r.status()).toBe(200);const b=await r.body();expect(b.readUInt32BE(16)).toBeLessThanOrEqual(4096);expect(b.readUInt32BE(20)).toBeLessThanOrEqual(4096);}
 const only=await upload(vf('image-only.pdf')),alt=await(await call('/documents/'+only.document_id+'/view')).json();expect(alt.content.unavailable).toBe(true);
 await upload(vf('huge.pdf'),'pdf',null,false);
});
test('S3 session expiry removes already open text and image',async()=>{
 const j=await upload(),p=actors.a.page;await p.goto(origin+'/candidates/'+j.candidate.id);await p.getByRole('button',{name:'安全な表示を開く'}).click();await expect(p.locator('.safe-view img')).toBeVisible();sql(`UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id='${actors.a.me.user.id}';`);await p.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(p.locator('.safe-view img,.safe-view pre')).toHaveCount(0);expect((await call('/documents/'+j.document_id+'/view')).status()).toBe(401);expect((await call('/documents/'+j.document_id+'/view/pages/1')).status()).toBe(401);
});
