const {test,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const {sql,signIn,identity,origin,shot}=require('./helpers.cjs');
const {seedSyntheticAv}=require('./synthetic_av.cjs');
const root=path.resolve(__dirname,'..'),dir=process.env.RP_E2E_DIR,actors={},issues=[];
const A='00000000-0000-0000-0000-000000000001',B='00000000-0000-0000-0000-000000000002',X='00000000-0000-0000-0000-000000000011',Y='00000000-0000-0000-0000-000000000012',uid=o=>'10000000'+o.slice(8);
const pdf=fs.readFileSync(path.join(root,'apps/web/public/sample-resume.pdf')),xlsx=fs.readFileSync(path.join(__dirname,'fixtures/sheets-career-history.xlsx'));
const MIME='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
function scope(o){return `BEGIN;SET LOCAL ROLE app_runtime;SELECT set_config('app.user_id','${uid(o)}',true),set_config('app.org_id','${o}',true);`;}
async function call(who,method,url,data,key=crypto.randomUUID(),extra={}){return actors[who].context.request.fetch(origin+'/api/v1'+url,{method,headers:{Origin:origin,'X-CSRF-Token':actors[who].me.csrf_token,'Idempotency-Key':key,...extra},...(data===undefined?{}:{data})});}
async function candidate(){const r=await call('a','POST','/candidates',{name:'R1架空候補者',summary:'PDF/XLSX受付・配信拒否の架空検証',fictional_confirmed:true});expect(r.status()).toBe(201);return (await r.json()).id;}
async function upload(id,{key=crypto.randomUUID(),who='a',format='xlsx',kind='career_history',name,raw,mime,extra={}}={}){sql("UPDATE document_admissions SET created_at=now()-interval '2 minutes' WHERE created_at>now()-interval '1 minute';");return actors[who].context.request.post(origin+`/api/v1/candidates/${id}/documents`,{headers:{Origin:origin,'X-CSRF-Token':actors[who].me.csrf_token,'Idempotency-Key':key,...extra},multipart:{fictional_confirmed:'true',document_kind:kind,file:{name:name||(format==='pdf'?'架空.pdf':'架空.xlsx'),mimeType:mime||(format==='pdf'?'application/pdf':MIME),buffer:raw||(format==='pdf'?pdf:xlsx)}}});}
async function registered(id,options){const r=await upload(id,options);expect(r.status()).toBe(201);const d=await r.json();expect(d.status).toBe('ready');expect(d.format_checked).toBe(true);expect(d.available).toBe(true);return d;}
async function syntheticReady(id){expect((await call('a','GET',`/documents/${id}`)).status()).toBe(200);}
function compose(...args){cp.execFileSync('python3',['scripts/local.py','compose',...args],{cwd:root,env:process.env,stdio:'pipe'});}
async function scanReady(){let stable=0;await expect.poll(()=>{try{compose('exec','-T','api','sh','-c','curl --fail --silent --max-time 3 -H "X-Scan-Key: $SCAN_SHARED_KEY" http://scan:8080/internal/scan/state >/dev/null');return ++stable;}catch{stable=0;return 0;}},{timeout:100000,intervals:[500]}).toBe(3);}
async function draft(candidate){const r=await call('a','POST','/applications',{candidate_id:candidate,job_id:'30000000-0000-0000-0000-000000000001',reason:'R1架空推薦'});expect(r.status()).toBe(201);return r.json();}
async function submit(a,c,documents){return call('a','POST',`/applications/${a.id}/submit`,{version:a.version,candidate_version:1,job_version:2,document_ids:documents,fictional_confirmed:true,consent_confirmed:true});}
test.beforeAll(async({browser})=>{for(const [who,name]of Object.entries({a:'agency-a',b:'agency-b',x:'employer-x',y:'employer-y'})){const context=await browser.newContext(),page=await context.newPage();page.on('pageerror',()=>issues.push('PAGE_ERROR'));page.on('console',m=>{if(['error','warning'].includes(m.type())&&!/^Failed to load resource: the server responded with a status of (400|401|403|404|409|413|422|429|503)\b/.test(m.text()))issues.push('CONSOLE_ERROR');});expect((await signIn(page,name)).status()).toBe(303);actors[who]={context,page,me:await identity(context)};}});
test.afterAll(async()=>{for(const a of Object.values(actors))await a.context.close();expect(issues).toEqual([]);});

test('R2 AV outage leaves both formats unavailable and unsubmitable, with no clean evidence',async()=>{
 const c=await candidate(),a=await draft(c);
 compose('pause','scan');
 try{for(const format of ['pdf','xlsx']){
 const r=await upload(c,{format});expect(r.status()).toBe(503);const failure=await r.json();expect(failure.error.code).toBe('SCANNER_UNAVAILABLE');const d=await(await call('a','GET',`/documents/${failure.error.document_id}`)).json();expect(d.status).toBe('pending');expect(d.available).toBe(false);
 expect((await call('a','GET',`/documents/${d.id}/content`)).status()).toBe(404);expect((await submit(a,c,[d.id])).status()).toBe(422);
 for(const who of ['b','x','y']){expect((await call(who,'GET',`/documents/${d.id}`)).status()).toBe(404);expect((await call(who,'POST',`/documents/${d.id}/retry`)).status()).toBe(404);expect((await upload(c,{who})).status()).toBe(404);}
 expect(JSON.stringify(d)).not.toMatch(/sha256|storage_key|signature|engine_version/);
 }}finally{compose('unpause','scan');await scanReady();}
 expect(sql(`SELECT count(*) FROM document_checks c JOIN documents d ON d.id=c.document_id WHERE d.candidate_id='${c}';`)).toBe('0');
});
test('R1 extension MIME content kinds and CSRF fail closed, correct octet stream is inspected',async()=>{
 const c=await candidate();
 for(const opt of [{name:'fake.xlsx',raw:pdf},{name:'fake.pdf',raw:xlsx,mime:'application/pdf'},{name:'macro.xlsm'},{mime:'text/plain'},{kind:'unknown'},{name:'empty.xlsx',raw:Buffer.alloc(0)},{extra:{'X-CSRF-Token':'bad'}}]){const r=await upload(c,opt);expect(r.status()).toBe(opt.extra?403:422);}
 const d=await registered(c,{mime:'application/octet-stream'});expect(d.media_type).toBe(MIME);
});
test('R1 upload outcomes preserve processing, seven-day failures, mismatch and terminal expiry tombstones',async()=>{
 const c=await candidate(),key=crypto.randomUUID(),d=await registered(c,{key});
 const replay=await upload(c,{key});expect(replay.status()).toBe(201);expect((await replay.json()).id).toBe(d.id);expect((await upload(c,{key,kind:'resume'})).status()).toBe(409);
 let r=await call('a','GET',`/candidates/${c}/document-upload-outcome?key=${key}`);expect((await r.json()).state).toBe('completed');expect((await call('b','GET',`/candidates/${c}/document-upload-outcome?key=${key}`)).status()).toBe(404);
 const failedKey=crypto.randomUUID(),bad=await upload(c,{key:failedKey,raw:Buffer.from('broken')});expect(bad.status()).toBe(422);const failure=await bad.json();r=await call('a','GET',`/candidates/${c}/document-upload-outcome?key=${failedKey}`);const outcome=await r.json();expect(outcome.state).toBe('failed');expect(outcome.document_id).toBe(failure.error.document_id);const expires=Date.parse(outcome.result_expires_at);expect(expires-Date.now()).toBeGreaterThan(6.99*86400000);expect((await upload(c,{key:failedKey,raw:Buffer.from('broken')})).status()).toBe(422);expect((await (await call('a','GET',`/candidates/${c}/document-upload-outcome?key=${failedKey}`)).json()).result_expires_at).toBe(outcome.result_expires_at);
 const legacy=JSON.parse(fs.readFileSync(path.join(dir,'artifacts/legacy-migration.json'))),expired='70000000-0000-0000-0000-00000000f002';
 for(const method of ['GET','POST']){r=method==='GET'?await call('a','GET',`/candidates/${legacy.candidate_id}/document-upload-outcome?key=${expired}`):await actors.a.context.request.post(origin+`/api/v1/candidates/${legacy.candidate_id}/documents`,{headers:{Origin:origin,'X-CSRF-Token':actors.a.me.csrf_token,'Idempotency-Key':expired},data:'no multipart body should be read'});expect(r.status()).toBe(409);expect((await r.json()).error.code).toBe('OPERATION_RESULT_EXPIRED');}
 expect(sql(`SELECT state FROM idempotency_records WHERE key='${expired}';`)).toBe('expired');expect(()=>sql(scope(A)+`UPDATE idempotency_records SET state='processing',expires_at=NULL WHERE key='${expired}';ROLLBACK;`)).toThrow('DB_CONTROL_FAILED:23514');
});
test('R1 migrated ready PDF and existing active shared snapshot refuse delivery without AV evidence',async()=>{
 const l=JSON.parse(fs.readFileSync(path.join(dir,'artifacts/legacy-migration.json')));const r=await call('a','GET',`/documents/${l.document_id}`),d=await r.json();expect(d.status).toBe('ready');expect(d.file_format).toBe('pdf');expect(d.document_kind).toBe('other');expect(d.available).toBe(false);
 expect((await call('a','GET',`/documents/${l.document_id}/content`)).status()).toBe(404);
 for(const who of ['a','x','b','y'])expect((await call(who,'GET',`/applications/${l.application_id}/documents/${l.document_id}/content`)).status()).toBe(404);
 const original=sql(`SELECT md5(row_to_json(d)::text) FROM documents d WHERE id='${l.document_id}';`),snapshot=sql(`SELECT md5(row_to_json(d)::text) FROM application_documents d WHERE document_id='${l.document_id}';`);
 const recheckKey=crypto.randomUUID();compose('pause','scan');try{expect((await call('a','POST',`/documents/${l.document_id}/recheck`,undefined,recheckKey)).status()).toBe(503);expect((await call('x','GET',`/applications/${l.application_id}/documents/${l.document_id}/content`)).status()).toBe(404);expect(sql(`SELECT count(*) FROM document_checks WHERE document_id='${l.document_id}';`)).toBe('0');}finally{compose('unpause','scan');await scanReady();}
 expect((await call('a','POST',`/documents/${l.document_id}/recheck`,undefined,recheckKey)).status()).toBe(200);expect((await call('b','POST',`/documents/${l.document_id}/recheck`)).status()).toBe(404);expect((await call('x','POST',`/documents/${l.document_id}/recheck`)).status()).toBe(404);
 expect(sql(`SELECT count(*) FROM document_checks WHERE document_id='${l.document_id}';`)).toBe('1');
 expect(sql(`SELECT md5(row_to_json(d)::text) FROM documents d WHERE id='${l.document_id}';`)).toBe(original);expect(sql(`SELECT md5(row_to_json(d)::text) FROM application_documents d WHERE document_id='${l.document_id}';`)).toBe(snapshot);expect((await call('a','GET',`/documents/${l.document_id}/content`)).status()).toBe(200);expect((await call('x','GET',`/applications/${l.application_id}/documents/${l.document_id}/content`)).status()).toBe(200);for(const who of ['b','y'])expect((await call(who,'GET',`/applications/${l.application_id}/documents/${l.document_id}/content`)).status()).toBe(404);
});
test('R2 real AV clean with synthetic blocked fixture proves snapshot format, RLS, block precedence and share revocation',async()=>{
 const c=await candidate(),d=await registered(c),a=await draft(c);await syntheticReady(d.id);
 let r=await call('a','GET',`/documents/${d.id}/content`);expect(r.status()).toBe(200);expect(await r.body()).toEqual(xlsx);expect(r.headers()['content-type']).toBe(MIME);expect(r.headers()['content-disposition']).toContain('resume.xlsx');expect(r.headers()['x-content-type-options']).toBe('nosniff');expect(r.headers()['cache-control']).toContain('no-store');
 r=await submit(a,c,[d.id]);expect(r.status()).toBe(200);const submitted=await r.json();expect(submitted.documents[0].file_format).toBe('xlsx');expect(submitted.documents[0].document_kind).toBe('career_history');
 const url=`/applications/${a.id}/documents/${d.id}/content`;r=await call('x','GET',url);expect(r.status()).toBe(200);expect(await r.body()).toEqual(xlsx);expect(r.headers()['content-type']).toBe(MIME);expect(r.headers()['content-disposition']).toContain('resume.xlsx');for(const who of ['b','y'])expect((await call(who,'GET',url)).status()).toBe(404);
 expect(sql(scope(X)+`SELECT count(*) FROM document_checks WHERE document_id='${d.id}';ROLLBACK;`).split('\n').filter(x=>/^\d+$/.test(x))).toEqual(['1']);
 expect(sql("SELECT has_table_privilege('app_runtime','document_checks','INSERT'),has_table_privilege('app_runtime','document_checks','UPDATE'),has_table_privilege('app_runtime','document_checks','DELETE'),has_table_privilege('app_auth','document_checks','SELECT');")).toBe('t|f|f|f');
 seedSyntheticAv(d.id,'blocked');expect((await call('a','GET',`/documents/${d.id}/content`)).status()).toBe(404);expect((await call('x','GET',url)).status()).toBe(404);expect((await call('a','POST',`/documents/${d.id}/recheck`)).status()).toBe(409);
 r=await call('a','POST',`/applications/${a.id}/revoke-sharing`,{version:2,reason:'R1架空取消'});expect(r.status()).toBe(200);expect(sql(scope(X)+`SELECT count(*) FROM document_checks WHERE document_id='${d.id}';ROLLBACK;`).split('\n').filter(x=>/^\d+$/.test(x))).toEqual(['0']);
});
test('R2 browser XLSX upload displays actual AV completion and download on desktop and mobile',async()=>{
 const c=await candidate(),p=actors.a.page;await p.goto(origin+'/candidates/'+c);await expect(p).toHaveTitle(/recruitment-platform/);await expect(p.getByRole('heading',{name:'履歴書・職務経歴書'})).toBeVisible();
 await p.getByLabel('書類の種類',{exact:true}).selectOption('career_history');await p.getByLabel('PDF／XLSXファイル',{exact:true}).setInputFiles({name:'架空の職務経歴書.xlsx',mimeType:MIME,buffer:xlsx});await p.getByLabel('書類の内容はすべて架空の情報です').check();await p.getByRole('button',{name:'書類を登録する',exact:true}).click();await expect(p.getByRole('status').filter({hasText:'書類を登録しました。'})).toBeVisible();await expect(p.getByText('架空の職務経歴書.xlsx',{exact:true})).toBeVisible();await expect(p.getByRole('link',{name:'XLSXをダウンロード'})).toHaveCount(1);await expect(p.getByRole('button',{name:'処理を再試行する'})).toHaveCount(0);await expect(p.getByText(/架空のPDF／XLSXの登録・安全性検査に対応/)).toBeVisible();await shot(p,'r1-xlsx-desktop');
 await p.setViewportSize({width:390,height:844});await p.reload();await expect(p.getByRole('region',{name:'職務経歴書の版一覧'}).getByText('登録完了',{exact:true})).toBeVisible();await expect.poll(()=>p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await p.getByLabel('書類の種類',{exact:true}).focus();await expect(p.getByLabel('書類の種類',{exact:true})).toBeFocused();await shot(p,'r1-xlsx-mobile');
 await actors.b.page.goto(origin+'/candidates/'+c);await expect(actors.b.page.locator('.workspace').getByRole('alert')).toContainText('閲覧できません');
});
