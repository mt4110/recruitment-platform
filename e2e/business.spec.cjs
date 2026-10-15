const {test,expect}=require('@playwright/test');
const crypto=require('node:crypto');
const {sql,signIn,identity,origin,shot}=require('./helpers.cjs');
const A='00000000-0000-0000-0000-000000000001',B='00000000-0000-0000-0000-000000000002',X='00000000-0000-0000-0000-000000000011',Y='00000000-0000-0000-0000-000000000012';
const uid=org=>'10000000'+org.slice(8);
const job=(n)=>'30000000-0000-0000-0000-'+String(n).padStart(12,'0');
const candidate=(n)=>'40000000-0000-0000-0000-'+String(n).padStart(12,'0');
let actors={};const problems=[];let allowNetworkFailure=false;
async function call(actor,method,path,data,key=crypto.randomUUID(),extra={}){
 return actors[actor].context.request.fetch(origin+'/api/v1'+path,{method,headers:{Origin:origin,'X-CSRF-Token':actors[actor].me.csrf_token,...(method==='POST'?{'Idempotency-Key':key}:{}),...extra},...(data===undefined?{}:{data})});
}
async function ok(actor,method,path,data,status=200,key){const r=await call(actor,method,path,data,key);expect(r.status(),`${method} business contract`).toBe(status);return status===204?null:r.json();}
function scope(org){return `BEGIN; SET LOCAL ROLE app_runtime; SELECT set_config('app.user_id','${uid(org)}',true),set_config('app.org_id','${org}',true);`;}
function scalar(org,statement){return sql(scope(org)+statement+';ROLLBACK;').split('\n').filter(v=>!['BEGIN','SET','ROLLBACK',uid(org)+'|'+org].includes(v)).join('\n');}
test.beforeAll(async({browser})=>{
 for(const [key,name] of Object.entries({a:'agency-a',b:'agency-b',x:'employer-x',y:'employer-y'})){
  const context=await browser.newContext();const page=await context.newPage();page.on('pageerror',()=>problems.push('UNCAUGHT_PAGE_ERROR'));page.on('console',m=>{if(['error','warning'].includes(m.type())&&!(allowNetworkFailure&&/net::ERR_FAILED/.test(m.text()))&&!/^Failed to load resource: the server responded with a status of (400|401|403|404|409|413|422|429|503)\b/.test(m.text()))problems.push('UNEXPECTED_BROWSER_CONSOLE');});expect((await signIn(page,name)).status()).toBe(303);actors[key]={context,page,me:await identity(context)};
 }
});
test.afterAll(async()=>{for(const a of Object.values(actors))await a.context.close();expect(problems).toEqual([]);});

test('M2 RLS fails closed without context and filters actual runtime queries',async()=>{
 expect(sql("BEGIN;SET LOCAL ROLE app_runtime;SELECT count(*) FROM jobs;SELECT count(*) FROM candidates;SELECT count(*) FROM job_favorites;ROLLBACK;").split('\n').filter(v=>/^\d+$/.test(v))).toEqual(['0','0','0']);
 expect(scalar(A,'SELECT count(*) FROM jobs')).toBe('4');expect(scalar(A,'SELECT count(*) FROM candidates')).toBe('3');
 expect(scalar(X,'SELECT count(*) FROM jobs')).toBe('4');expect(scalar(X,'SELECT count(*) FROM candidates')).toBe('0');
 expect(scalar(B,`SELECT count(*) FROM candidates WHERE id='${candidate(1)}'`)).toBe('0');
 expect(scalar(Y,`SELECT count(*) FROM jobs WHERE id='${job(1)}'`)).toBe('0');
 expect(sql("SELECT count(*) FROM pg_class WHERE relname IN ('jobs','candidates','job_favorites','idempotency_records','audit_events') AND relrowsecurity AND relforcerowsecurity;")).toBe('5');
 expect(sql("SELECT NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole FROM pg_roles WHERE rolname='app_runtime';")).toBe('t');
 expect(sql("SELECT has_table_privilege('app_auth','jobs','SELECT'),has_table_privilege('app_runtime','sessions','SELECT'),has_table_privilege('app_runtime','jobs','DELETE'),has_table_privilege('app_runtime','audit_events','SELECT');")).toBe('f|f|f|f');
 expect(()=>sql(scope(A)+`UPDATE jobs SET title='forbidden',version=version+1 WHERE id='${job(1)}';ROLLBACK;`)).not.toThrow();
 expect(sql(`SELECT title<>'forbidden' FROM jobs WHERE id='${job(1)}';`)).toBe('t');
 expect(()=>sql(scope(X)+`UPDATE jobs SET employer_org_id='${Y}' WHERE id='${job(1)}';ROLLBACK;`)).toThrow('DB_CONTROL_FAILED:42501');
 expect(()=>sql(scope(A)+`INSERT INTO candidates(id,agency_org_id,name,summary) VALUES('${crypto.randomUUID()}','${B}','架空','架空');ROLLBACK;`)).toThrow('DB_CONTROL_FAILED:23514');
 // Same connection after commit: transaction-local context cannot leak to the next request.
 expect(sql("SET ROLE app_runtime;"+scope(A)+"SELECT count(*) FROM candidates;COMMIT;BEGIN;SELECT count(*) FROM candidates;ROLLBACK;").split('\n').filter(v=>/^\d+$/.test(v))).toEqual(['3','0']);
});

test('M2 direct IDs, role changes and missing sessions cannot disclose other organizations',async({request})=>{
 for(const path of ['/jobs','/candidates','/jobs/'+job(1),'/candidates/'+candidate(1)])expect((await request.get(origin+'/api/v1'+path)).status()).toBe(401);
 for(const [actor,path] of [['a','/jobs/'+job(3)],['a','/jobs/'+job(4)],['x','/jobs/'+job(5)],['y','/jobs/'+job(1)],['a','/candidates/'+candidate(4)],['b','/candidates/'+candidate(1)]]){
  const r=await call(actor,'GET',path);expect(r.status()).toBe(404);const e=await r.json();expect(e.error.message).toBe('見つからない、または閲覧できません。');expect(JSON.stringify(e)).not.toContain('summary');
 }
 for(const [method,path,data] of [['GET','/candidates'],['GET','/candidates/'+candidate(1)],['POST','/candidates',{name:'架空',summary:'架空',fictional_confirmed:true}],['PATCH','/candidates/'+candidate(1),{version:1,name:'盗用'}]])expect((await call('x',method,path,data)).status()).toBe(403);
 expect((await call('a','POST','/jobs',{title:'架空',description:'架空',location:'架空',employment_type:'full_time'})).status()).toBe(403);
 for(const [actor,method,path,data] of [['y','PATCH','/jobs/'+job(1),{version:2,title:'盗用'}],['y','POST','/jobs/'+job(1)+'/status',{version:2,status:'closed'}],['b','PATCH','/candidates/'+candidate(1),{version:1,name:'盗用'}],['b','POST','/candidates/'+candidate(1)+'/archive',{version:1}]])expect((await call(actor,method,path,data)).status()).toBe(404);
 expect((await ok('a','GET','/jobs')).items.every(v=>v.status==='published')).toBe(true);
 expect((await ok('x','GET','/jobs')).items.every(v=>v.employer_org_id===X)).toBe(true);
});

test('M2 input bounds, CSRF, UUID, unknown fields and mutation key are enforced',async()=>{
 const valid={title:'架空',description:'架空',location:'架空',employment_type:'full_time'};
 for(const data of [{...valid,employer_org_id:Y},{...valid,employer_name:'偽称'},{...valid,title:' '},{...valid,title:'あ'.repeat(201)},{...valid,description:'あ'.repeat(10001)},{...valid,employment_type:'unknown'}]){
  const r=await call('x','POST','/jobs',data);expect(r.status()).toBe(422);expect((await r.json()).error.field_errors).toBeTruthy();
 }
 for(const data of [{name:'架空',summary:'経歴',fictional_confirmed:false},{name:'架空',summary:'経歴'},{name:'架空',summary:'経歴',fictional_confirmed:true,agency_org_id:B},{name:'あ'.repeat(101),summary:'経歴',fictional_confirmed:true}])expect((await call('a','POST','/candidates',data)).status()).toBe(422);
 for(const path of ['/jobs/not-a-uuid','/jobs?limit=101','/jobs?limit=0','/jobs?q='+encodeURIComponent('あ'.repeat(101)),'/jobs?cursor=bad','/jobs?archived=true','/candidates?employment_type=full_time'])expect((await call('a','GET',path)).status()).toBe(422);
 expect((await call('x','POST','/jobs',valid,'')).status()).toBe(422);
 for(const extra of [{'X-CSRF-Token':'bad'},{Origin:'http://example.invalid'}])expect((await call('x','POST','/jobs',valid,undefined,extra)).status()).toBe(403);
 const malformed=await actors.x.context.request.post(origin+'/api/v1/jobs',{headers:{Origin:origin,'X-CSRF-Token':actors.x.me.csrf_token,'Idempotency-Key':crypto.randomUUID(),'Content-Type':'application/json'},data:Buffer.from('{')});expect(malformed.status()).toBe(400);
 const big=await call('x','POST','/jobs',{...valid,description:'あ'.repeat(24000)});expect(big.status()).toBe(413);
});

test('M2 job lifecycle, canonical idempotency, concurrent versions and cursor filtering',async()=>{
 const key=crypto.randomUUID(),payload={title:'架空 E2E 100%_求人',description:'架空業務',location:'架空東京',employment_type:'part_time'};
 const responses=await Promise.all([call('x','POST','/jobs',payload,key),call('x','POST','/jobs',{employment_type:'part_time',location:'架空東京',description:'架空業務',title:payload.title},key)]);
 expect(responses.map(r=>r.status())).toEqual([201,201]);let [j,replay]=await Promise.all(responses.map(r=>r.json()));expect(j.id).toBe(replay.id);expect(j.status).toBe('draft');expect(j.employer_name).toBe('架空求人企業X');
 expect((await call('x','POST','/jobs',{...payload,title:'different'},key)).status()).toBe(409);
 expect((await call('a','GET','/jobs/'+j.id)).status()).toBe(404);
 const updates=await Promise.all([call('x','PATCH','/jobs/'+j.id,{version:1,title:payload.title}),call('x','PATCH','/jobs/'+j.id,{version:1,description:'更新された架空業務'})]);expect(updates.map(r=>r.status()).sort()).toEqual([200,409]);j=await ok('x','GET','/jobs/'+j.id);
 const publishKey=crypto.randomUUID(),publish={version:j.version,status:'published'};j=await ok('x','POST','/jobs/'+j.id+'/status',publish,200,publishKey);expect(j.status).toBe('published');expect((await ok('x','POST','/jobs/'+j.id+'/status',publish,200,publishKey)).version).toBe(j.version);
 expect((await ok('a','GET','/jobs/'+j.id)).id).toBe(j.id);
 const literal=await ok('a','GET','/jobs?q='+encodeURIComponent('100%_'));expect(literal.items.map(v=>v.id)).toEqual([j.id]);
 expect((await ok('a','GET','/jobs?location='+encodeURIComponent('架空東京')+'&employment_type=part_time')).items.some(v=>v.id===j.id)).toBe(true);
 const seen=new Set();let cursor='';do {const page=await ok('a','GET','/jobs?limit=2'+(cursor?'&cursor='+encodeURIComponent(cursor):''));for(const v of page.items){expect(seen.has(v.id)).toBe(false);seen.add(v.id);}cursor=page.next_cursor||'';}while(cursor);expect(seen.size).toBeGreaterThanOrEqual(5);
 const first=await ok('a','GET','/jobs?limit=1');expect((await call('a','GET','/jobs?limit=1&q=other&cursor='+encodeURIComponent(first.next_cursor))).status()).toBe(422);
 await ok('a','PUT','/jobs/'+j.id+'/favorite',undefined,204);await ok('a','PUT','/jobs/'+j.id+'/favorite',undefined,204);
 expect((await ok('a','GET','/jobs?favorited=true')).items.some(v=>v.id===j.id)).toBe(true);expect((await ok('b','GET','/jobs?favorited=true')).items.some(v=>v.id===j.id)).toBe(false);
 expect((await call('y','PUT','/jobs/'+j.id+'/favorite')).status()).toBe(403);
 j=await ok('x','POST','/jobs/'+j.id+'/status',{version:j.version,status:'closed'});expect((await call('a','GET','/jobs/'+j.id)).status()).toBe(404);expect((await ok('a','GET','/jobs?favorited=true')).items.some(v=>v.id===j.id)).toBe(false);
 await ok('a','DELETE','/jobs/'+j.id+'/favorite',undefined,204);expect(scalar(A,`SELECT count(*) FROM job_favorites WHERE job_id='${j.id}'`)).toBe('0');
 expect((await call('x','PATCH','/jobs/'+j.id,{version:j.version,title:'復帰'})).status()).toBe(409);
 expect((await call('x','POST','/jobs/'+j.id+'/status',{version:j.version,status:'published'})).status()).toBe(409);
 expect(sql(`SELECT count(*) FROM jobs WHERE id='${j.id}';SELECT count(*) FROM audit_events WHERE resource_id='${j.id}' AND action='create';`)).toBe('1\n1');
});

test('M2 candidate update/archive is immutable, scoped and replay-safe',async()=>{
 const key=crypto.randomUUID(),data={name:'架空 E2E 候補者',summary:'すべて架空の経歴',fictional_confirmed:true};
 let c=await ok('a','POST','/candidates',data,201,key);expect((await ok('a','POST','/candidates',data,201,key)).id).toBe(c.id);
 expect((await call('b','GET','/candidates/'+c.id)).status()).toBe(404);
 c=await ok('a','PATCH','/candidates/'+c.id,{version:1,name:'架空 改訂氏名',summary:'架空 更新経歴'});expect(c.version).toBe(2);
 expect((await call('a','PATCH','/candidates/'+c.id,{version:1,name:'stale'})).status()).toBe(409);
 const archiveKey=crypto.randomUUID();const archiveBody={version:2};c=await ok('a','POST','/candidates/'+c.id+'/archive',archiveBody,200,archiveKey);expect(c.archived_at).toBeTruthy();expect(c.version).toBe(3);
 expect((await ok('a','POST','/candidates/'+c.id+'/archive',archiveBody,200,archiveKey)).version).toBe(3);
 expect((await ok('a','POST','/candidates',data,201,key)).archived_at).toBeTruthy();
 expect((await call('a','PATCH','/candidates/'+c.id,{version:3,name:'復元不可'})).status()).toBe(409);
 expect((await ok('a','GET','/candidates?archived=true')).items.some(v=>v.id===c.id)).toBe(true);expect((await ok('a','GET','/candidates')).items.some(v=>v.id===c.id)).toBe(false);
 expect(sql(`SELECT count(*) FROM audit_events WHERE resource_id='${c.id}' AND action='archive';`)).toBe('1');
 expect((await ok('a','GET','/candidates/'+c.id)).documents).toEqual([]);
});

test('M2 browser job registration, publication, search/save and forbidden detail',async()=>{
 const page=actors.x.page;await page.goto(origin+'/jobs');await page.getByRole('link',{name:'求人を登録する',exact:true}).click();
 await page.getByRole('textbox',{name:/求人名/}).fill('架空 ブラウザ求人');await page.getByRole('textbox',{name:/仕事内容/}).fill('ブラウザから登録した架空の仕事内容です。');await page.getByRole('textbox',{name:/勤務地/}).fill('架空 横浜');
 await page.getByRole('button',{name:'下書き保存',exact:true}).click();await expect(page.getByText('下書き',{exact:true})).toBeVisible();const id=page.url().split('/').pop();
 await page.getByRole('button',{name:'公開する',exact:true}).click();await expect(page.getByText('公開中',{exact:true})).toBeVisible();
 const a=actors.a.page;await a.goto(origin+'/jobs');await a.getByRole('textbox',{name:'検索',exact:true}).fill('架空 ブラウザ求人');await a.getByRole('button',{name:'検索する',exact:true}).click();await a.getByRole('link',{name:/架空 ブラウザ求人/}).click();
 await a.getByRole('button',{name:'求人を保存する',exact:true}).click();await expect(a.getByRole('button',{name:'保存を解除する',exact:true})).toBeVisible();
 await a.reload();await expect(a.getByRole('button',{name:'保存を解除する',exact:true})).toBeVisible();
 await expect(a).toHaveTitle('recruitment-platform');expect(await a.locator('nextjs-portal').count()).toBe(0);await shot(a,'m2-job-detail');
 const y=actors.y.page;await y.goto(origin+'/jobs/'+id);await expect(y.locator('.workspace').getByRole('alert')).toContainText('見つからない、または閲覧できません。');await expect(y.getByText('ブラウザから登録した架空の仕事内容です。',{exact:true})).toHaveCount(0);
 page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'募集を終了する',exact:true}).click();await expect(page.getByText('募集終了',{exact:true})).toBeVisible();await a.reload();await expect(a.locator('.workspace').getByRole('alert')).toContainText('見つからない、または閲覧できません。');
});

test('M2 browser candidate form, conflict preserves input, archive and mobile keyboard',async()=>{
 const page=actors.a.page;await page.goto(origin+'/candidates');await page.getByRole('link',{name:'候補者を登録する',exact:true}).click();
 await page.getByRole('textbox',{name:/架空氏名/}).fill('架空 ブラウザ候補者');await page.getByRole('textbox',{name:/経歴の概要/}).fill('架空のブラウザ経歴');await page.getByRole('checkbox',{name:'氏名・経歴はすべて架空のデータです'}).check();
 await page.getByRole('button',{name:'保存する',exact:true}).click();await expect(page.getByRole('heading',{name:'架空 ブラウザ候補者',exact:true})).toBeVisible();const id=page.url().split('/').pop();
 await page.getByRole('link',{name:'編集する',exact:true}).click();const input=page.getByRole('textbox',{name:/架空氏名/});await input.fill('架空 入力を保持');
 await ok('a','PATCH','/candidates/'+id,{version:1,name:'架空 別の更新'});await page.getByRole('button',{name:'保存する',exact:true}).click();await expect(page.locator('.workspace').getByRole('alert')).toContainText('入力は自動で上書きしません');await expect(input).toHaveValue('架空 入力を保持');
 await page.getByRole('button',{name:'最新情報を読み直す',exact:true}).click();await expect(input).toHaveValue('架空 別の更新');await input.fill('架空 入力を保持');await page.getByRole('button',{name:'保存する',exact:true}).click();await expect(page.getByRole('heading',{name:'架空 入力を保持',exact:true})).toBeVisible();
 const b=actors.b.page;await b.goto(origin+'/candidates/'+id);await expect(b.locator('.workspace').getByRole('alert')).toContainText('見つからない、または閲覧できません。');await expect(b.getByText('架空のブラウザ経歴',{exact:true})).toHaveCount(0);
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await shot(page,'m2-mobile-candidate');
 page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'アーカイブする',exact:true}).focus();await page.keyboard.press('Enter');await expect(page.getByText('アーカイブ済み',{exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'編集する',exact:true})).toHaveCount(0);
 expect(await page.evaluate(()=>localStorage.length+sessionStorage.length)).toBe(0);
 await actors.x.page.goto(origin+'/candidates/'+id);await expect(actors.x.page.locator('.workspace').getByRole('alert')).toContainText('この利用区分では候補者を閲覧できません。');
});

test('M2 job advisory lock times out safely and leaves the version unchanged',async()=>{
 const cp=require('node:child_process'),path=require('node:path');
 const h=crypto.createHash('sha256');for(const value of ['job',job(1)]){const bytes=Buffer.from(value),length=Buffer.alloc(8);length.writeBigUInt64BE(BigInt(bytes.length));h.update(length);h.update(bytes);}const key=h.digest().readBigInt64BE(0).toString();
 const child=cp.spawn('python3',['scripts/local.py','compose','exec','-T','db','psql','-U','postgres','-d','recruitment','-v','ON_ERROR_STOP=1','-At'],{cwd:path.resolve(__dirname,'..'),env:process.env,stdio:['pipe','pipe','pipe']});
 let stderr='';child.stderr.on('data',v=>stderr+=v);const exited=new Promise(resolve=>child.on('exit',resolve));
 const ready=new Promise((resolve,reject)=>{let output='';child.stdout.on('data',v=>{output+=v;if(output.includes('LOCKED'))resolve();});child.on('error',()=>reject(Error('LOCK_CONTROL_FAILED')));child.on('exit',()=>reject(Error('LOCK_CONTROL_EXITED')));});
 child.stdin.end(`BEGIN;SET LOCAL ROLE app_runtime;SELECT pg_advisory_xact_lock(${key});SELECT 'LOCKED';SELECT pg_sleep(5);ROLLBACK;`);
 await ready;const before=await ok('x','GET','/jobs/'+job(1));const r=await call('x','PATCH','/jobs/'+job(1),{version:before.version,title:'blocked'});expect(r.status()).toBe(503);expect((await r.json()).error.code).toBe('RETRYABLE_BUSY');expect(await exited).toBe(0);expect(stderr.includes('ERROR')).toBe(false);
 expect((await ok('x','GET','/jobs/'+job(1))).version).toBe(before.version);
});

test('M2 browser retries a lost creation response with the same key and no duplicate',async()=>{
 const page=actors.a.page;await page.goto(origin+'/candidates/new');await page.getByRole('textbox',{name:/架空氏名/}).fill('架空 応答喪失');await page.getByRole('textbox',{name:/経歴の概要/}).fill('架空の再試行');await page.getByRole('checkbox',{name:'氏名・経歴はすべて架空のデータです'}).check();
 let firstKey,createdId;allowNetworkFailure=true;
 try {
  await page.route('**/api/v1/candidates',async route=>{if(route.request().method()!=='POST')return route.continue();firstKey=route.request().headers()['idempotency-key'];const response=await route.fetch();expect(response.status()).toBe(201);createdId=(await response.json()).id;await route.abort();},{times:1});
  await page.getByRole('button',{name:'保存する',exact:true}).click();await expect(page.locator('.workspace').getByRole('alert')).toContainText('接続が途切れました');
  const resend=page.waitForRequest(r=>r.method()==='POST'&&r.url()===origin+'/api/v1/candidates');await page.getByRole('button',{name:'保存する',exact:true}).click();expect((await resend).headers()['idempotency-key']).toBe(firstKey);
  await expect(page.getByRole('heading',{name:'架空 応答喪失',exact:true})).toBeVisible();expect(page.url().endsWith('/'+createdId)).toBe(true);expect(sql(`SELECT count(*) FROM candidates WHERE id='${createdId}';SELECT count(*) FROM audit_events WHERE resource_id='${createdId}' AND action='create';`)).toBe('1\n1');
 } finally {await page.unrouteAll({behavior:'wait'});allowNetworkFailure=false;}
});

test('M2 expired browser session retains only the unsaved form and refuses writes',async()=>{
 const page=actors.a.page;await page.goto(origin+'/candidates/new');await page.getByRole('textbox',{name:/架空氏名/}).fill('架空 期限切れ入力');
 const cookie=(await actors.a.context.cookies(origin)).find(v=>v.name==='rp_session');const hash=crypto.createHash('sha256').update(cookie.value).digest('hex');sql(`UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=decode('${hash}','hex');`);
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(page.getByRole('link',{name:'ログインする',exact:true})).toBeVisible();await expect(page.getByRole('textbox',{name:/架空氏名/})).toHaveValue('架空 期限切れ入力');await expect(page.getByRole('button',{name:'保存する',exact:true})).toBeDisabled();await expect(page.getByText('架空紹介会社A',{exact:true})).toHaveCount(0);
 await expect(page.locator('.workspace').getByRole('alert')).toContainText('再ログイン後は再入力が必要');expect((await call('a','POST','/candidates',{name:'架空',summary:'架空',fictional_confirmed:true})).status()).toBe(401);
});
