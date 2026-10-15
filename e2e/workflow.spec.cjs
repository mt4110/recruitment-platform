const {test,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const {sql,signIn,identity,origin,shot}=require('./helpers.cjs');
const root=path.resolve(__dirname,'..'),A='00000000-0000-0000-0000-000000000001',B='00000000-0000-0000-0000-000000000002',X='00000000-0000-0000-0000-000000000011',Y='00000000-0000-0000-0000-000000000012',uid=o=>'10000000'+o.slice(8);
const sample=fs.readFileSync(path.join(root,'apps/web/public/sample-resume.pdf')),actors={},issues=[];let expectedNetwork=false;
async function call(actor,method,url,data,key=crypto.randomUUID(),extra={}){return actors[actor].context.request.fetch(origin+'/api/v1'+url,{method,headers:{Origin:origin,'X-CSRF-Token':actors[actor].me.csrf_token,...(method==='POST'?{'Idempotency-Key':key}:{}),...extra},...(data===undefined?{}:{data})});}
async function ok(actor,method,url,data,status=200,key){const r=await call(actor,method,url,data,key);expect(r.status(),`${method} workflow contract`).toBe(status);return r.json();}
async function upload(candidate,name='架空共有レジュメ.pdf'){sql("UPDATE document_admissions SET created_at=now()-interval '2 minutes' WHERE created_at>now()-interval '1 minute';");const r=await actors.a.context.request.post(origin+`/api/v1/candidates/${candidate}/documents`,{headers:{Origin:origin,'X-CSRF-Token':actors.a.me.csrf_token,'Idempotency-Key':crypto.randomUUID()},multipart:{fictional_confirmed:'true',document_kind:'other',file:{name,mimeType:'application/pdf',buffer:sample}}});expect(r.status()).toBe(201);const d=await r.json();expect(d.available).toBe(true);return d;}
async function setup(){let j=await ok('x','POST','/jobs',{title:'M4架空求人',description:'提出時点の架空求人本文',location:'東京都',employment_type:'full_time'},201);j=await ok('x','POST',`/jobs/${j.id}/status`,{version:j.version,status:'published'});const c=await ok('a','POST','/candidates',{name:'候補者スナップ専用',summary:'PERSONAL-SNAPSHOT-SYNTHETIC',fictional_confirmed:true},201),d=await upload(c.id),a=await ok('a','POST','/applications',{candidate_id:c.id,job_id:j.id,reason:'PRIVATE-RECOMMENDATION-SYNTHETIC'},201);return{j,c,d,a};}
const submission=f=>({version:f.a.version,candidate_version:f.c.version,job_version:f.j.version,document_ids:[f.d.id],fictional_confirmed:true,consent_confirmed:true});
async function submit(f,key){f.a=await ok('a','POST',`/applications/${f.a.id}/submit`,submission(f),200,key);return f;}
async function transition(f,to,key){f.a=await ok(to==='withdrawn'?'a':'x','POST',`/applications/${f.a.id}/transition`,{version:f.a.version,to_status:to,...(['rejected','withdrawn'].includes(to)?{reason:'PRIVATE-EVENT-SYNTHETIC'}:{})},200,key);return f;}
async function shared(f,actor='x',expected=200){const r=await call(actor,'GET',`/applications/${f.a.id}/documents/${f.d.id}/content`);expect(r.status()).toBe(expected);if(expected===200){expect(await r.body()).toEqual(sample);expect(r.headers()['cache-control']).toContain('no-store');expect(r.headers()['x-content-type-options']).toBe('nosniff');}return r;}
function scope(org){return `BEGIN;SET LOCAL ROLE app_runtime;SELECT set_config('app.user_id','${uid(org)}',true),set_config('app.org_id','${org}',true);`;}
function counts(id){return sql(`SELECT (SELECT count(*) FROM selection_events WHERE application_id='${id}')||'|'||(SELECT count(*) FROM notification_previews WHERE application_id='${id}')||'|'||(SELECT count(*) FROM audit_events WHERE resource_id='${id}')||'|'||(SELECT count(*) FROM placements WHERE application_id='${id}');`);}
function held(statement){const p=cp.spawn('python3',['scripts/local.py','compose','exec','-T','db','psql','-U','postgres','-d','recruitment','-v','ON_ERROR_STOP=1','-At'],{cwd:root,env:process.env,stdio:['pipe','ignore','ignore']});p.stdin.end(statement);return p;}
test.beforeAll(async({browser})=>{for(const [actor,name]of Object.entries({a:'agency-a',b:'agency-b',x:'employer-x',y:'employer-y'})){const context=await browser.newContext(),page=await context.newPage();page.on('pageerror',()=>issues.push('PAGE_ERROR'));page.on('console',m=>{if(['error','warning'].includes(m.type())&&!(expectedNetwork&&/net::ERR_FAILED/.test(m.text()))&&!/^Failed to load resource: the server responded with a status of (400|401|403|404|409|413|422|429|503)\b/.test(m.text()))issues.push('UNEXPECTED_CONSOLE');});expect((await signIn(page,name)).status()).toBe(303);actors[actor]={context,page,me:await identity(context)};}});
test.afterAll(async()=>{for(const actor of Object.values(actors))await actor.context.close();expect(issues).toEqual([]);});

test('M4 draft hidden from employers; submit atomically freezes candidate job and selected PDF',async()=>{
 const f=await setup();expect((await call('x','GET','/applications/'+f.a.id)).status()).toBe(404);await shared(f,'x',404);
 const second=await upload(f.c.id,'選択しない架空PDF.pdf');await submit(f);expect(f.a.candidate_snapshot.name).toBe(f.c.name);expect(f.a.candidate_snapshot.summary).toBe(f.c.summary);expect(f.a.documents.map(d=>d.id)).toEqual([f.d.id]);expect(f.a.job_snapshot.title).toBe(f.j.title);await shared(f);
 expect((await call('x','GET',`/applications/${f.a.id}/documents/${second.id}/content`)).status()).toBe(404);expect((await call('x','GET','/documents/'+f.d.id+'/content')).status()).toBe(404);
 await ok('a','PATCH','/candidates/'+f.c.id,{version:f.c.version,name:'編集後の架空氏名',summary:'編集後の架空経歴'});const j=await ok('x','PATCH','/jobs/'+f.j.id,{version:f.j.version,title:'編集後の架空求人',description:'編集後の架空求人本文'});await ok('x','POST',`/jobs/${f.j.id}/status`,{version:j.version,status:'closed'});
 expect((await call('a','GET','/jobs/'+f.j.id)).status()).toBe(404);
 for(const actor of ['a','x']){const a=await ok(actor,'GET','/applications/'+f.a.id);expect(a.candidate_snapshot.name).toBe(f.c.name);expect(a.job_snapshot.title).toBe(f.j.title);expect(a.job_snapshot.description).toBe(f.j.description);expect(JSON.stringify(a)).not.toMatch(/storage_key|staging_key|sha256_snapshot/);}
 expect(counts(f.a.id)).toBe('1|1|2|0');
});
test('M4 direct IDs and runtime RLS isolate all six new tables without privileged shared reads',async()=>{
 const f=await submit(await setup());
 for(const actor of ['b','y']){expect((await call(actor,'GET','/applications/'+f.a.id)).status()).toBe(404);await shared(f,actor,404);expect((await call(actor,'POST',`/applications/${f.a.id}/transition`,{version:f.a.version,to_status:'screening'})).status()).toBe(404);}
 for(const actor of ['b','y']){const list=await ok(actor,'GET','/applications');expect(list.items.some(a=>a.id===f.a.id)).toBe(false);}
 expect(sql("BEGIN;SET LOCAL ROLE app_runtime;SELECT count(*) FROM applications;SELECT count(*) FROM application_snapshots;SELECT count(*) FROM application_documents;SELECT count(*) FROM selection_events;SELECT count(*) FROM placements;SELECT count(*) FROM notification_previews;ROLLBACK;").split('\n').filter(x=>/^\d+$/.test(x))).toEqual(['0','0','0','0','0','0']);
 expect(sql("SELECT count(*) FROM pg_class WHERE relname IN ('applications','application_snapshots','application_documents','selection_events','placements','notification_previews') AND relrowsecurity AND relforcerowsecurity;")).toBe('6');
 expect(sql("SELECT has_table_privilege('app_auth','applications','SELECT'),has_table_privilege('app_runtime','application_snapshots','UPDATE'),has_table_privilege('app_runtime','application_documents','DELETE'),has_column_privilege('app_runtime','applications','agency_org_id','UPDATE');")).toBe('f|f|f|f');
 for(const org of [B,Y])expect(sql(scope(org)+`SELECT count(*) FROM application_snapshots WHERE application_id='${f.a.id}';SELECT count(*) FROM application_documents WHERE application_id='${f.a.id}';ROLLBACK;`).split('\n').filter(x=>/^\d+$/.test(x))).toEqual(['0','0']);
 expect(()=>sql(scope(A)+`UPDATE applications SET reason='tamper',version=version+1 WHERE id='${f.a.id}';ROLLBACK;`)).toThrow('DB_CONTROL_FAILED:23514');
 expect(()=>sql(scope(A)+`UPDATE application_documents SET original_name_snapshot='tamper' WHERE application_id='${f.a.id}';ROLLBACK;`)).toThrow('DB_CONTROL_FAILED:42501');expect(sql("SELECT count(*) FROM pg_constraint WHERE conname IN ('submitted_job_version_required','ready_validation_required');")).toBe('2');const pending=crypto.randomUUID();expect(()=>sql(scope(A)+`INSERT INTO documents(id,agency_org_id,candidate_id,created_by,storage_key,original_name,size_bytes,sha256,status,validated_at) VALUES('${pending}','${A}','${f.c.id}','${uid(A)}','${pending}.pdf','架空.pdf',1,'${'0'.repeat(64)}','pending',now());UPDATE documents SET status='ready' WHERE id='${pending}';ROLLBACK;`)).toThrow('DB_CONTROL_FAILED:23514');
 // One connection, new transaction: no tenant context remains.
 expect(sql('SET ROLE app_runtime;'+scope(A)+`SELECT count(*) FROM applications WHERE id='${f.a.id}';COMMIT;BEGIN;SELECT count(*) FROM applications;ROLLBACK;`).split('\n').filter(x=>/^\d+$/.test(x))).toEqual(['1','0']);
});
test('M4 input CSRF role and failed submissions leave no snapshots events or idempotency residue',async({request})=>{
 const f=await setup();expect((await request.get(origin+'/api/v1/applications')).status()).toBe(401);
 for(const [change,code]of [[{consent_confirmed:false},422],[{fictional_confirmed:false},422],[{document_ids:[]},422],[{document_ids:[f.d.id,f.d.id]},422],[{candidate_version:0},422],[{agency_org_id:B},422],[{job_version:f.j.version+1},409]]){const key=crypto.randomUUID(),r=await call('a','POST',`/applications/${f.a.id}/submit`,{...submission(f),...change},key);expect(r.status()).toBe(code);expect(sql(`SELECT count(*) FROM idempotency_records WHERE key='${key}';`)).toBe('0');}
 const other=await setup();expect((await call('a','POST',`/applications/${f.a.id}/submit`,{...submission(f),document_ids:[f.d.id,other.d.id]})).status()).toBe(422);
 expect(sql(`SELECT (SELECT count(*) FROM application_snapshots WHERE application_id='${f.a.id}')||'|'||(SELECT count(*) FROM application_documents WHERE application_id='${f.a.id}')||'|'||(SELECT count(*) FROM selection_events WHERE application_id='${f.a.id}');`)).toBe('0|0|0');expect((await ok('a','GET','/applications/'+f.a.id)).version).toBe(1);
 expect((await call('a','POST',`/applications/${f.a.id}/submit`,submission(f),undefined,{'X-CSRF-Token':'invalid'})).status()).toBe(403);expect((await call('a','POST',`/applications/${f.a.id}/submit`,submission(f),undefined,{Origin:'http://example.invalid'})).status()).toBe(403);
 expect((await call('x','POST','/applications',{candidate_id:f.c.id,job_id:f.j.id,reason:'架空'})).status()).toBe(403);
 expect((await call('a','POST',`/applications/${f.a.id}/revoke-sharing`,{version:1,reason:'架空'})).status()).toBe(409);
 expect((await call('a','POST','/applications',{candidate_id:'bad',job_id:f.j.id,reason:'架空'})).status()).toBe(422);
 expect((await call('a','POST','/applications',{candidate_id:f.c.id,job_id:f.j.id,reason:'あ'.repeat(2001)})).status()).toBe(422);
});
test('M4 same-key submit and transitions replay once even after sharing is revoked',async()=>{
 const f=await setup(),body=submission(f),key=crypto.randomUUID(),responses=await Promise.all([call('a','POST',`/applications/${f.a.id}/submit`,body,key),call('a','POST',`/applications/${f.a.id}/submit`,body,key)]);expect(responses.every(r=>r.status()===200)).toBe(true);f.a=await responses[0].json();expect(counts(f.a.id)).toBe('1|1|2|0');
 expect((await call('a','POST',`/applications/${f.a.id}/submit`,{...body,job_version:999},key)).status()).toBe(409);
 const selectKey=crypto.randomUUID(),transitionBody={version:f.a.version,to_status:'screening'};f.a=await ok('x','POST',`/applications/${f.a.id}/transition`,transitionBody,200,selectKey);
 f.a=await ok('a','POST',`/applications/${f.a.id}/revoke-sharing`,{version:f.a.version,reason:'PRIVATE-REVOKE-SYNTHETIC'});const before=counts(f.a.id);
 const replay=await ok('x','POST',`/applications/${f.a.id}/transition`,transitionBody,200,selectKey);expect(replay.status).toBe('withdrawn');expect(replay.reason).toBeUndefined();expect(replay.candidate_snapshot).toBeUndefined();expect(counts(f.a.id)).toBe(before);
 const again=await ok('a','POST',`/applications/${f.a.id}/revoke-sharing`,{version:f.a.version,reason:'重複操作'});expect(again.version).toBe(f.a.version);expect(counts(f.a.id)).toBe(before);
 expect((await call('a','POST',`/applications/${f.a.id}/revoke-sharing`,{version:1,reason:'古い版'})).status()).toBe(409);
});
test('M4 E_SHARED permits submitted screening rejected and hired; terminal revoke preserves placement',async()=>{
 for(const target of ['rejected','hired']){
  const f=await submit(await setup());await shared(f);if(target==='hired'){await transition(f,'screening');await shared(f);}await transition(f,target);await shared(f);
  const placed=f.a.placement?.id,beforeVersion=f.a.version;f.a=await ok('a','POST',`/applications/${f.a.id}/revoke-sharing`,{version:f.a.version,reason:'PRIVATE-REVOKE-SYNTHETIC'});expect(f.a.status).toBe(target);expect(f.a.version).toBe(beforeVersion+1);await shared(f,'x',404);await shared(f,'a');
  const hidden=await ok('x','GET','/applications/'+f.a.id);for(const k of ['candidate_id','candidate_snapshot','reason','documents','placement'])expect(hidden[k]).toBeUndefined();expect(JSON.stringify(hidden)).not.toMatch(/PERSONAL-SNAPSHOT|PRIVATE-|架空共有レジュメ/);expect(hidden.job_snapshot.title).toBe(f.j.title);expect(hidden.events.length).toBeGreaterThan(1);
  expect(sql(scope(X)+`SELECT count(*) FROM application_snapshots WHERE application_id='${f.a.id}';SELECT count(*) FROM application_documents WHERE application_id='${f.a.id}';SELECT count(*) FROM placements WHERE application_id='${f.a.id}';ROLLBACK;`).split('\n').filter(x=>/^\d+$/.test(x))).toEqual(['0','0','0']);
  const denied=await call('x','POST',`/applications/${f.a.id}/transition`,{version:f.a.version,to_status:'screening'});expect(denied.status()).toBe(403);expect((await denied.json()).error.code).toBe('SHARING_REVOKED');
  if(placed){expect(f.a.placement.id).toBe(placed);expect(sql(`SELECT count(*) FROM placements WHERE application_id='${f.a.id}';`)).toBe('1');expect((await call('a','POST','/applications',{candidate_id:f.c.id,job_id:f.j.id,reason:'再推薦'})).status()).toBe(409);}
  else expect((await call('a','POST','/applications',{candidate_id:f.c.id,job_id:f.j.id,reason:'再推薦'})).status()).toBe(201);
 }
});
test('M4 status table rejects invalid transitions and duplicate active recommendations',async()=>{
 const f=await setup();expect((await call('a','POST','/applications',{candidate_id:f.c.id,job_id:f.j.id,reason:'重複'})).status()).toBe(409);await submit(f);
 for(const [who,to]of [['x','hired'],['a','screening'],['a','rejected']])expect((await call(who,'POST',`/applications/${f.a.id}/transition`,{version:f.a.version,to_status:to,reason:'架空'})).status()).toBe(409);
 expect((await call('x','POST',`/applications/${f.a.id}/transition`,{version:f.a.version,to_status:'rejected'})).status()).toBe(422);
 await transition(f,'withdrawn');expect(f.a.share_revoked_at).toBeTruthy();await shared(f,'x',404);
 expect((await call('a','POST',`/applications/${f.a.id}/transition`,{version:f.a.version,to_status:'withdrawn',reason:'架空'})).status()).toBe(409);
 expect((await call('a','POST','/applications',{candidate_id:f.c.id,job_id:f.j.id,reason:'辞退後の再推薦'})).status()).toBe(201);
});
test('M4 concurrent versions serialize selection against revoke without restoring shared content',async()=>{
 const f=await submit(await setup());const results=await Promise.all([call('x','POST',`/applications/${f.a.id}/transition`,{version:f.a.version,to_status:'screening'}),call('a','POST',`/applications/${f.a.id}/revoke-sharing`,{version:f.a.version,reason:'架空同時撤回'})]);expect(results.filter(r=>r.status()===200)).toHaveLength(1);expect(results.every(r=>[200,403,409].includes(r.status()))).toBe(true);
 let a=await ok('a','GET','/applications/'+f.a.id);if(a.sharing_active)a=await ok('a','POST',`/applications/${a.id}/revoke-sharing`,{version:a.version,reason:'最終撤回'});expect(a.status).toBe('withdrawn');await shared(f,'x',404);
 expect((await ok('x','GET','/applications/'+a.id)).candidate_snapshot).toBeUndefined();
});
test('M4 job lock orders close before submit and rejects stale candidate or archived submissions',async()=>{
 const f=await setup();
 // Hold the exact job advisory lock and close under it; submission waits and
 // must observe the close after the owner transaction commits.
 // Hash is calculated in JS, matching the documented length-delimited contract.
 const chunks=[];for(const s of ['job',f.j.id]){const len=Buffer.alloc(8);len.writeBigUInt64BE(BigInt(Buffer.byteLength(s)));chunks.push(len,Buffer.from(s));}const lock=crypto.createHash('sha256').update(Buffer.concat(chunks)).digest().readBigInt64BE(0).toString();
 const p=held(`BEGIN;SELECT pg_advisory_xact_lock(${lock});UPDATE jobs SET status='closed',version=version+1 WHERE id='${f.j.id}';SELECT pg_sleep(1);COMMIT;`);
 await expect.poll(()=>sql(`SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND granted AND pid<>pg_backend_pid();`)).not.toBe('0');const failed=await call('a','POST',`/applications/${f.a.id}/submit`,submission(f));expect(failed.status()).toBe(409);expect((await failed.json()).error.code).toBe('JOB_NOT_OPEN');await new Promise(r=>p.exitCode!==null?r():p.once('exit',r));
 expect((await ok('a','GET','/applications/'+f.a.id)).status).toBe('draft');
 const g=await setup();await ok('a','PATCH','/candidates/'+g.c.id,{version:g.c.version,name:'更新済み架空候補者'});const stale=await call('a','POST',`/applications/${g.a.id}/submit`,submission(g));expect(stale.status()).toBe(409);await ok('a','POST','/candidates/'+g.c.id+'/archive',{version:2});expect((await call('a','POST',`/applications/${g.a.id}/submit`,{...submission(g),candidate_version:3})).status()).toBe(409);
});
test('M4 list pagination filters and active share revocation never expose candidate metadata',async()=>{
 const f=await submit(await setup());const first=await ok('a','GET','/applications?limit=1');expect(first.items).toHaveLength(1);if(first.next_cursor){const next=await ok('a','GET','/applications?limit=1&cursor='+encodeURIComponent(first.next_cursor));expect(next.items[0].id).not.toBe(first.items[0].id);expect((await call('a','GET','/applications?limit=2&cursor='+encodeURIComponent(first.next_cursor))).status()).toBe(422);}
 expect((await call('a','GET','/applications?status=unknown')).status()).toBe(422);expect((await call('a','GET','/applications?limit=101')).status()).toBe(422);expect((await call('a','GET','/applications?org_id='+B)).status()).toBe(422);
 await ok('a','POST',`/applications/${f.a.id}/revoke-sharing`,{version:f.a.version,reason:'架空共有撤回'});const rows=await ok('x','GET','/applications?status=withdrawn');const item=rows.items.find(a=>a.id===f.a.id);expect(item).toBeTruthy();expect(item.candidate_name).toBeUndefined();
});
test('M4 browser creates and submits a preview; employer selects then loses shared UI and direct PDF access',async()=>{
 const f=await setup(); // Use its job/candidate/doc; the first draft remains private.
 await ok('a','POST',`/applications/${f.a.id}/submit`,submission(f));await ok('x','POST',`/applications/${f.a.id}/transition`,{version:2,to_status:'rejected',reason:'架空不採用'});
 const page=actors.a.page;await page.goto(origin+'/jobs/'+f.j.id);await page.getByRole('link',{name:'この求人に推薦する'}).click();await expect(page).toHaveURL(new RegExp('/applications/new\\?job_id='+f.j.id));await page.getByLabel('候補者',{exact:true}).selectOption(f.c.id);await page.getByLabel('推薦理由',{exact:true}).fill('画面からの架空推薦理由');await page.getByRole('button',{name:'下書きを保存する'}).click();await expect(page).toHaveURL(/\/applications\/[0-9a-f-]{36}$/);
 await expect(page.getByRole('heading',{name:'企業に共有する内容'})).toBeVisible();await page.getByLabel('架空共有レジュメ.pdf',{exact:true}).check();await page.getByLabel('氏名・経歴・PDFはすべて架空の情報です').check();await page.getByLabel('選択した架空情報を企業に共有する操作を確認しました（demo-share-v1）').check();await page.getByRole('button',{name:'推薦を提出する',exact:true}).click();await expect(page.locator('.metadata')).toContainText('提出済み');const id=new URL(page.url()).pathname.split('/').pop();
 const employer=actors.x.page;await employer.goto(origin+'/applications/'+id);await expect(employer.getByRole('region',{name:'共有された候補者'})).toContainText('PERSONAL-SNAPSHOT-SYNTHETIC');await employer.getByRole('button',{name:'選考を開始する'}).click();await expect(employer.locator('.metadata')).toContainText('選考中');await shot(employer,'m4-employer-screening');
 await page.getByRole('button',{name:'最新情報を読み直す',exact:true}).last().click();await expect(page.locator('.metadata')).toContainText('選考中');await page.getByLabel('操作の理由').fill('架空共有取消理由');page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'共有を取り消す'}).click();await expect(page.locator('.metadata')).toContainText('辞退');
 await expect(employer.getByRole('region',{name:'共有された候補者'})).toHaveCount(0);await expect(employer.getByRole('link',{name:'架空共有レジュメ.pdfをダウンロード'})).toHaveCount(0);await expect(employer.getByRole('button',{name:'選考を開始する'})).toHaveCount(0);expect((await call('x','GET',`/applications/${id}/documents/${f.d.id}/content`)).status()).toBe(404);
 await employer.setViewportSize({width:390,height:844});await expect.poll(()=>employer.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await employer.getByRole('link',{name:'推薦一覧へ戻る'}).focus();await expect(employer.getByRole('link',{name:'推薦一覧へ戻る'})).toBeFocused();await shot(employer,'m4-employer-revoked-mobile');await employer.setViewportSize({width:1280,height:900});
 await actors.b.page.goto(origin+'/applications/'+id);await expect(actors.b.page.locator('.applications').getByRole('alert')).toContainText('閲覧できません');
});
test('M4 browser lost draft response retries the original key once and retains conflict input',async()=>{
 const f=await setup();await submit(f);await transition(f,'rejected');const page=actors.a.page;
 await page.goto(origin+'/applications/new?job_id='+f.j.id);await page.getByLabel('候補者',{exact:true}).selectOption(f.c.id);await page.getByLabel('推薦理由',{exact:true}).fill('応答喪失の架空下書き');let savedKey=null;expectedNetwork=true;
 await page.route('**/api/v1/applications',async route=>{if(route.request().method()!=='POST')return route.continue();savedKey=route.request().headers()['idempotency-key'];await route.fetch();await route.abort('failed');});await page.getByRole('button',{name:'下書きを保存する'}).click();await expect(page.locator('.applications').getByRole('alert')).toContainText('接続が途切れました');await page.unroute('**/api/v1/applications');
 const sent=page.waitForRequest(r=>r.method()==='POST'&&new URL(r.url()).pathname==='/api/v1/applications');await page.getByRole('button',{name:'下書きを保存する'}).click();expect((await sent).headers()['idempotency-key']).toBe(savedKey);await expect(page).toHaveURL(/\/applications\/[0-9a-f-]{36}$/);expectedNetwork=false;
 const id=new URL(page.url()).pathname.split('/').pop();expect(sql(`SELECT count(*) FROM applications WHERE candidate_id='${f.c.id}' AND status='draft';`)).toBe('1');await page.getByLabel('推薦理由',{exact:true}).fill('保持すべき未保存の架空入力');await ok('a','PATCH','/applications/'+id,{version:1,reason:'別操作の架空更新'});await page.getByRole('button',{name:'理由を保存する'}).click();await expect(page.locator('.applications').getByRole('alert')).toContainText(/更新|変更/);await expect(page.getByLabel('推薦理由',{exact:true})).toHaveValue('保持すべき未保存の架空入力');sql(`UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id='${uid(A)}';`);await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(page.getByLabel('推薦理由',{exact:true})).toBeDisabled();await expect(page.getByLabel('推薦理由',{exact:true})).toHaveValue('保持すべき未保存の架空入力');await expect(page.locator('.applications').getByRole('alert')).toContainText('再ログイン');
});
