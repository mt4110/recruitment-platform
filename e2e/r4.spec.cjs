const {test,expect}=require('@playwright/test');
const {sql,signIn,identity,origin,shot}=require('./helpers.cjs');
const crypto=require('node:crypto'),actors={},issues=[];
async function call(who,method,url,data,key=crypto.randomUUID()){return actors[who].context.request.fetch(origin+'/api/v1'+url,{method,headers:{Origin:origin,'X-CSRF-Token':actors[who].me.csrf_token,'Idempotency-Key':key},...(data===undefined?{}:{data})});}
function admission(){sql("UPDATE draft_admissions SET at=now()-interval '2 hours';");}
function body(form_type,payload={},extra={}){return {revision:0,form_type,target_id:null,context_id:null,schema_version:1,base_resource_version:null,payload,mutation_id:crypto.randomUUID(),...extra};}
async function save(who,b,id=crypto.randomUUID(),status=201){admission();const r=await call(who,'PUT','/drafts/'+id,b);expect(r.status()).toBe(status);return {id,data:await r.json(),body:b};}
async function makeCandidate(){const r=await call('a','POST','/candidates',{name:'R4架空候補者',summary:'暗号化下書きの架空検証',fictional_confirmed:true});expect(r.status()).toBe(201);return r.json();}
function scope(me){return `BEGIN;SET LOCAL ROLE app_runtime;SELECT set_config('app.user_id','${me.user.id}',true),set_config('app.org_id','${me.organization.id}',true);`;}
test.beforeAll(async({browser})=>{sql("INSERT INTO users(id,organization_id,oidc_issuer,oidc_subject,display_name) SELECT '10000000-0000-0000-0000-000000000099',organization_id,oidc_issuer,'20000000-0000-0000-0000-000000000099','R4架空の同一組織の別本人' FROM users WHERE id='10000000-0000-0000-0000-000000000001';");for(const [who,name]of Object.entries({a:'agency-a',b:'agency-b',x:'employer-x',y:'employer-y',c:'unregistered'})){const context=await browser.newContext(),page=await context.newPage();page.on('pageerror',()=>issues.push('PAGE_ERROR'));expect((await signIn(page,name)).status()).toBe(303);actors[who]={context,page,me:await identity(context)};}});
test.afterAll(async()=>{sql("UPDATE users SET active=false WHERE id='10000000-0000-0000-0000-000000000099';");for(const a of Object.values(actors))await a.context.close();expect(issues).toEqual([]);});
test('R4 personal RLS encrypted storage strict schemas and no-store headers',async()=>{
 const d=await save('a',body('candidate_new',{name:'R4-PRIVATE-SYNTHETIC',summary:'未入力も保存可能'}));
 let r=await call('a','GET','/drafts/'+d.id);expect(r.status()).toBe(200);expect((await r.json()).payload.name).toBe('R4-PRIVATE-SYNTHETIC');expect(r.headers()['cache-control']).toContain('no-store');
 expect(sql(`SELECT position(convert_to('R4-PRIVATE-SYNTHETIC','UTF8') in encrypted_payload)=0,octet_length(nonce)=12 FROM form_drafts WHERE id='${d.id}';`)).toBe('t|t');
 for(const who of ['b','x','y','c']){expect((await call(who,'GET','/drafts/'+d.id)).status()).toBe(404);expect(sql(scope(actors[who].me)+`SELECT count(*) FROM form_drafts WHERE id='${d.id}';ROLLBACK;`).split('\n').filter(x=>/^\d+$/.test(x))).toEqual(['0']);}
 for(const payload of [{name:'架空',csrf_token:'forbidden'},{name:2},{summary:'x'.repeat(10001)},{name:'<script>'},{fictional_confirmed:true},{bytes:'file'}])expect((await call('a','PUT','/drafts/'+crypto.randomUUID(),body('candidate_new',payload))).status()).toBe(422);
 expect((await call('x','PUT','/drafts/'+crypto.randomUUID(),body('candidate_new',{}))).status()).toBe(404);
 expect(sql("SELECT count(*) FROM pg_class WHERE relname IN ('form_drafts','draft_operations','draft_keys','draft_mutations','draft_admissions') AND relrowsecurity AND relforcerowsecurity;")).toBe('5');
});
test('R4 same-user other-organization context and another user in same organization cannot read drafts',async()=>{
 const d=await save('a',body('candidate_new',{name:'架空本人専用'})),me=actors.a.me;
 const other='10000000-0000-0000-0000-000000000002';
 expect(sql(`BEGIN;SET LOCAL ROLE app_runtime;SELECT set_config('app.user_id','${other}',true),set_config('app.org_id','${me.organization.id}',true);SELECT count(*) FROM form_drafts WHERE id='${d.id}';ROLLBACK;`).split('\n').filter(x=>/^\d+$/.test(x))).toEqual(['0']);
 expect(sql(`BEGIN;SET LOCAL ROLE app_runtime;SELECT set_config('app.user_id','${me.user.id}',true),set_config('app.org_id','${actors.b.me.organization.id}',true);SELECT count(*) FROM form_drafts WHERE id='${d.id}';ROLLBACK;`).split('\n').filter(x=>/^\d+$/.test(x))).toEqual(['0']);
});
test('R4 mutation replay conflict expiry discard and ciphertext tamper never resurrect a draft',async()=>{
 const b=body('candidate_new',{name:'架空競合'}),d=await save('a',b);let r=await call('a','PUT','/drafts/'+d.id,b);expect(r.status()).toBe(201);expect((await r.json()).revision).toBe(1);
 expect((await call('a','PUT','/drafts/'+d.id,{...b,payload:{name:'別内容'}})).status()).toBe(409);
 const changes=await Promise.all([call('a','PUT','/drafts/'+d.id,{...b,revision:1,mutation_id:crypto.randomUUID(),payload:{name:'架空一'}}),call('a','PUT','/drafts/'+d.id,{...b,revision:1,mutation_id:crypto.randomUUID(),payload:{name:'架空二'}})]);expect(changes.map(r=>r.status()).sort()).toEqual([200,409]);
 expect((await call('a','POST','/drafts/'+d.id+'/discard',{revision:2})).status()).toBe(204);expect((await call('a','PUT','/drafts/'+d.id,{...b,revision:2,mutation_id:crypto.randomUUID()})).status()).toBe(409);expect((await call('a','GET','/drafts/'+d.id)).status()).toBe(409);
 const expired=await save('a',body('candidate_new',{}));sql(`UPDATE form_drafts SET expires_at=now()-interval '1 second',revision=revision+1 WHERE id='${expired.id}';`);expect((await call('a','GET','/drafts/'+expired.id)).status()).toBe(409);expect((await call('a','PUT','/drafts/'+expired.id,{...expired.body,revision:2,mutation_id:crypto.randomUUID()})).status()).toBe(409);
 const tamper=await save('a',body('candidate_new',{name:'架空改ざん'}));sql(`UPDATE form_drafts SET encrypted_payload=set_byte(encrypted_payload,0,get_byte(encrypted_payload,0)#1),revision=revision+1 WHERE id='${tamper.id}';`);expect((await call('a','GET','/drafts/'+tamper.id)).status()).toBe(503);const encrypted=sql(`SELECT encode(encrypted_payload,'hex') FROM form_drafts WHERE id='${tamper.id}';`);expect((await call('a','PUT','/drafts/'+tamper.id,{...tamper.body,revision:2,mutation_id:crypto.randomUUID(),payload:{name:'上書きしない'}})).status()).toBe(503);expect(sql(`SELECT encode(encrypted_payload,'hex') FROM form_drafts WHERE id='${tamper.id}';`)===encrypted).toBe(true);
});
test('R4 business commit consumes atomically and replays after 24h without a second candidate',async()=>{
 const payload={name:'R4確定専用架空',summary:'復活禁止'},d=await save('a',body('candidate_new',payload)),key=crypto.randomUUID(),request={...payload,fictional_confirmed:true,draft_id:d.id,draft_revision:1,operation_id:key};
 let r=await call('a','POST','/candidates',request,key);expect(r.status()).toBe(201);const c=await r.json();expect(sql(`SELECT state,encrypted_payload IS NULL FROM form_drafts WHERE id='${d.id}';`)).toBe('consumed|t');
 expect((await call('a','PUT','/drafts/'+d.id,{...d.body,revision:1,mutation_id:crypto.randomUUID()})).status()).toBe(409);
 sql(`UPDATE idempotency_records SET expires_at=now()-interval '1 hour' WHERE key='${key}';`);expect((await call('a','POST','/candidates',{...payload,fictional_confirmed:true},key)).status()).toBe(409);r=await call('a','POST','/candidates',request,key);expect(r.status()).toBe(201);expect((await r.json()).id).toBe(c.id);
 r=await call('a','GET',`/drafts/${d.id}/outcome?operation_id=${key}`);expect((await r.json()).resource_id).toBe(c.id);expect((await call('b','GET',`/drafts/${d.id}/outcome?operation_id=${key}`)).status()).toBe(404);
 sql(`UPDATE draft_operations SET result_expires_at=now()-interval '1 second' WHERE operation_id='${key}';`);expect((await call('a','POST','/candidates',{...payload,fictional_confirmed:true},key)).status()).toBe(409);expect((await call('a','POST','/candidates',request,key)).status()).toBe(409);expect((await call('a','GET',`/drafts/${d.id}/outcome?operation_id=${key}`)).status()).toBe(409);expect(sql("SELECT count(*) FROM candidates WHERE name='R4確定専用架空';")).toBe('1');
});
test('R4 wrong form revision or payload rolls business back without consuming the draft',async()=>{
 const c=await makeCandidate(),d=await save('a',body('candidate_edit',{name:'R4変更後架空',summary:c.summary},{target_id:c.id,base_resource_version:c.version}));
 for(const extra of [{draft_revision:99},{name:'対応しない値'}]){const key=crypto.randomUUID();expect((await call('a','PATCH','/candidates/'+c.id,{version:c.version,name:'R4変更後架空',summary:c.summary,draft_id:d.id,draft_revision:1,operation_id:key,...extra},key)).status()).toBe(409);}
 expect((await(await call('a','GET','/candidates/'+c.id)).json()).version).toBe(1);expect(sql(`SELECT state FROM form_drafts WHERE id='${d.id}';`)).toBe('active');
});
test('R4 server drafts restore browser form and confirmation stays unchecked',async()=>{
 admission();const p=actors.a.page;let savedId;const observed=async r=>{if(r.request().method()==='PUT'&&r.url().includes('/api/v1/drafts/')&&r.ok()){const b=r.request().postDataJSON();if(b?.payload?.name==='R4ブラウザ架空'&&b?.payload?.summary==='電話中断後に復帰する架空入力')savedId=(await r.json()).id;}};p.on('response',observed);await p.goto(origin+'/candidates/new');const fresh=p.getByRole('button',{name:'新しい下書きを開始する'});await expect(p.getByRole('complementary',{name:'個人下書き'})).toBeVisible();await expect(p.getByRole('complementary',{name:'個人下書き'})).not.toContainText('下書きを確認中');if(await fresh.isVisible())await fresh.click();await p.getByLabel('架空氏名').fill('R4ブラウザ架空');await p.getByLabel('経歴の概要').fill('電話中断後に復帰する架空入力');const panel=p.getByRole('complementary',{name:'個人下書き'});await expect.poll(()=>!!savedId).toBe(true);await expect(panel).toContainText('下書きをサーバーへ保存しました');p.off('response',observed);await p.reload();await expect(panel).toBeVisible();await expect(panel).not.toContainText('下書きを確認中');const choice=p.getByRole('button',{name:new RegExp(savedId.slice(0,8))});if(await choice.isVisible())await choice.click();await expect(p.getByLabel('架空氏名')).toHaveValue('R4ブラウザ架空');await expect(p.getByLabel('氏名・経歴はすべて架空のデータです')).not.toBeChecked();await shot(p,'r4-restored-desktop');await p.setViewportSize({width:390,height:844});await expect.poll(()=>p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await shot(p,'r4-restored-mobile');await p.setViewportSize({width:1280,height:900});
});
test('R4 all current form schemas validate resource context and sharing revocation blocks employer draft restoration',async()=>{
 const c=await makeCandidate();let r=await call('x','POST','/jobs',{title:'R4架空求人',description:'架空本文',location:'東京都',employment_type:'full_time'});expect(r.status()).toBe(201);const job=await r.json();
 for(const [who,kind,payload,extra]of [
 ['x','job_new',{},{}],['x','job_edit',{title:''},{target_id:job.id,base_resource_version:job.version}],['a','candidate_edit',{summary:''},{target_id:c.id,base_resource_version:c.version}],['a','application_new',{candidate_id:c.id,reason:''},{context_id:'30000000-0000-0000-0000-000000000001'}],['a','document_upload',{operations:[]},{target_id:c.id}],['a','job_filters',{q:'架空',favorited:true},{}],['a','candidate_filters',{q:'架空',archived:false},{}],['x','application_filters',{status:'screening'},{}]]){
 const d=await save(who,body(kind,payload,extra));expect((await call(who,'GET','/drafts/'+d.id)).status()).toBe(200);
 }
 r=await call('a','POST','/applications',{candidate_id:c.id,job_id:'30000000-0000-0000-0000-000000000001',reason:'R4架空推薦'});expect(r.status()).toBe(201);const app=await r.json();
 const reason=await save('a',body('application_reason',{reason:'途中'},{target_id:app.id,base_resource_version:1}));await save('a',body('application_submit',{document_ids:[],candidate_version:1,job_version:2},{target_id:app.id,base_resource_version:1}));
 const fs=require('node:fs'),path=require('node:path');sql("UPDATE document_admissions SET created_at=now()-interval '2 minutes';");r=await actors.a.context.request.post(origin+`/api/v1/candidates/${c.id}/documents`,{headers:{Origin:origin,'X-CSRF-Token':actors.a.me.csrf_token,'Idempotency-Key':crypto.randomUUID()},multipart:{fictional_confirmed:'true',document_kind:'other',file:{name:'R4架空.pdf',mimeType:'application/pdf',buffer:fs.readFileSync(path.resolve(__dirname,'../apps/web/public/sample-resume.pdf'))}}});expect(r.status()).toBe(201);const doc=await r.json();
 r=await call('a','POST',`/applications/${app.id}/submit`,{version:1,candidate_version:1,job_version:2,document_ids:[doc.id],fictional_confirmed:true,consent_confirmed:true});expect(r.status()).toBe(200);
 expect((await call('a','GET','/drafts/'+reason.id)).status()).toBe(409);
 const note=await save('x',body('selection_note',{action:'transition',to_status:'rejected',reason:'架空理由'},{target_id:app.id,base_resource_version:2}));
 r=await call('a','POST',`/applications/${app.id}/revoke-sharing`,{version:2,reason:'架空取消'});expect(r.status()).toBe(200);expect((await call('x','GET','/drafts/'+note.id)).status()).toBe(404);
});
test('R4 key wrapping is owner bound, concurrent stable, no-store and revoked versions refuse restoration',async()=>{
 const rr=await Promise.all([call('a','POST','/drafts/key',{}),call('a','POST','/drafts/key',{})]);expect(rr.every(r=>r.status()===200)).toBe(true);const keys=await Promise.all(rr.map(r=>r.json()));expect(keys[0].key===keys[1].key).toBe(true);expect(Buffer.from(keys[0].key,'base64url').length).toBe(32);expect(rr[0].headers()['cache-control']).toContain('no-store');
 const other=await(await call('b','POST','/drafts/key',{})).json();expect(keys[0].key===other.key).toBe(false);
 const wrapped=Buffer.from(sql(scope(actors.a.me)+"SELECT encode(wrapped_key,'hex') FROM draft_keys WHERE key_version=1;ROLLBACK;").split('\n').find(x=>/^[a-f0-9]{96}$/.test(x)),'hex');expect(wrapped.includes(Buffer.from(keys[0].key,'base64url'))).toBe(false);
 sql(`UPDATE draft_keys SET revoked_at=now() WHERE user_id='${actors.a.me.user.id}' AND key_version=1;`);const r=await call('a','POST','/drafts/key',{key_version:1});expect(r.status()).toBe(409);expect((await r.json()).error.code).toBe('DRAFT_KEY_REVOKED');
 expect((await call('a','POST','/drafts/key',{key_version:999})).status()).toBe(404);
});
test('R4 draft rate, quota and larger request limits stop writes without replacing input',async()=>{
 // Separate real OIDC user in the same organization; the helper never lowers product limits.
 const who='c';admission();const ids=[];
 for(let i=0;i<30;i++){const id=crypto.randomUUID(),r=await call(who,'PUT','/drafts/'+id,body('candidate_new',{name:'架空quota'+i}));expect(r.status()).toBe(201);ids.push(id);}
 let r=await call(who,'PUT','/drafts/'+crypto.randomUUID(),body('candidate_new',{}));expect(r.status()).toBe(429);expect(r.headers()['retry-after']).toBe('3600');
 admission();for(let i=30;i<50;i++)await save(who,body('candidate_new',{name:'架空quota'+i}));
 r=await call(who,'PUT','/drafts/'+crypto.randomUUID(),body('candidate_new',{}));expect(r.status()).toBe(409);expect((await r.json()).error.code).toBe('DRAFT_QUOTA_EXCEEDED');
 // Existing draft updates remain allowed at the count quota.
 admission();let revision=1;for(let i=0;i<120;i++){r=await call(who,'PUT','/drafts/'+ids[0],body('candidate_new',{name:'架空更新'+i},{revision:revision++}));expect(r.status()).toBe(200);}
 r=await call(who,'PUT','/drafts/'+ids[0],body('candidate_new',{name:'上書きされない架空値'},{revision}));expect(r.status()).toBe(429);expect((await(await call(who,'GET','/drafts/'+ids[0])).json()).payload.name).toBe('架空更新119');
});
test('R4 two browser tabs preserve conflicting input and apply only after explicit comparison',async()=>{
 admission();const c=await makeCandidate(),p=actors.a.page,q=await actors.a.context.newPage();
 try{await p.goto(origin+`/candidates/${c.id}/edit`);await p.getByLabel('架空氏名').fill('R4最初の架空入力');const panel=p.getByRole('complementary',{name:'個人下書き'});await expect(panel).toContainText('下書きをサーバーへ保存しました');await q.goto(origin+`/candidates/${c.id}/edit`);await expect(q.getByLabel('架空氏名')).toHaveValue('R4最初の架空入力');
 await p.getByLabel('架空氏名').fill('R4先行タブの架空入力');await expect(panel).toContainText('下書きをサーバーへ保存しました');await q.getByLabel('架空氏名').fill('R4後続タブの架空入力');const other=q.getByRole('complementary',{name:'個人下書き'});await expect(other).toContainText('別の画面で下書きが更新');await expect(q.getByLabel('架空氏名')).toHaveValue('R4後続タブの架空入力');await q.getByRole('button',{name:'最新の下書きと比較する'}).click();await expect(other).toContainText('R4先行タブの架空入力');await expect(other).toContainText('R4後続タブの架空入力');await q.getByRole('button',{name:'自分の入力を確認して適用'}).click();await expect(other).toContainText('下書きをサーバーへ保存しました');await q.reload();await expect(q.getByLabel('架空氏名')).toHaveValue('R4後続タブの架空入力');await shot(q,'r4-conflict-resolved');
 }finally{await q.close();}
});
test('R4 authenticated draft routes enforce CSRF origin schema and request-size limits',async({request})=>{
 expect((await request.get(origin+'/api/v1/drafts')).status()).toBe(401);const id=crypto.randomUUID(),url=origin+'/api/v1/drafts/'+id;
 for(const extra of [{'X-CSRF-Token':'bad'},{Origin:'https://example.invalid'}]){const r=await actors.a.context.request.put(url,{headers:{Origin:origin,'X-CSRF-Token':actors.a.me.csrf_token,...extra},data:body('candidate_new',{})});expect(r.status()).toBe(403);}
 expect((await call('a','PUT','/drafts/'+id,body('candidate_new',{},{schema_version:2}))).status()).toBe(409);
 const r=await actors.a.context.request.put(url,{headers:{Origin:origin,'X-CSRF-Token':actors.a.me.csrf_token,'Content-Type':'application/json'},data:JSON.stringify(body('candidate_new',{name:'x'.repeat(100000)}))});expect(r.status()).toBe(413);expect(sql(`SELECT count(*) FROM form_drafts WHERE id='${id}';`)).toBe('0');
});
test('R4 upload metadata restores separately from candidate edits and reselected original uses its saved key',async()=>{
 admission();sql("UPDATE document_admissions SET created_at=now()-interval '2 minutes';");const c=await makeCandidate(),p=actors.a.page,fs=require('node:fs'),path=require('node:path'),file={name:'R4未送信架空.pdf',mimeType:'application/pdf',buffer:fs.readFileSync(path.resolve(__dirname,'../apps/web/public/sample-resume.pdf'))};
 let saved,key;const observed=async r=>{if(r.request().method()==='PUT'&&r.url().includes('/drafts/')&&r.ok()){const b=r.request().postDataJSON();if(b.form_type==='document_upload'&&b.payload.operations[0]?.name===file.name){saved=(await r.json()).id;key=b.payload.operations[0].key;}}};p.on('response',observed);
 await p.goto(origin+'/candidates/'+c.id);await p.getByLabel('書類の種類',{exact:true}).selectOption('resume');await p.getByLabel('PDF／XLSXファイル',{exact:true}).setInputFiles(file);await expect.poll(()=>!!saved).toBe(true);p.off('response',observed);
 const edit=await save('a',body('candidate_edit',{name:c.name,summary:'R4編集後の架空経歴'},{target_id:c.id,base_resource_version:c.version})),op=crypto.randomUUID();expect((await call('a','PATCH','/candidates/'+c.id,{version:c.version,name:c.name,summary:'R4編集後の架空経歴',draft_id:edit.id,draft_revision:1,operation_id:op},op)).status()).toBe(200);expect((await call('a','GET','/drafts/'+saved)).status()).toBe(200);
 await p.reload();await expect(p.getByRole('region',{name:'書類の受付状況'})).toContainText('未実行とは限りません');await p.getByRole('button',{name:'受付結果をまとめて確認する'}).click();await expect(p.getByRole('region',{name:'書類の受付状況'})).toContainText('未実行とは限りません');await expect(p.getByLabel('PDF／XLSXファイル',{exact:true})).toHaveValue('');
 await p.getByLabel('書類の種類',{exact:true}).selectOption('resume');await p.getByLabel('PDF／XLSXファイル',{exact:true}).setInputFiles(file);await p.getByLabel('書類の内容はすべて架空の情報です').check();const sent=p.waitForRequest(r=>r.method()==='POST'&&r.url().endsWith(`/candidates/${c.id}/documents`));await p.getByRole('button',{name:'書類を登録する',exact:true}).click();expect((await sent).headers()['idempotency-key']).toBe(key);await expect(p.getByRole('region',{name:'書類の受付状況'})).toContainText('登録完了');expect(sql(`SELECT count(*) FROM documents WHERE candidate_id='${c.id}';`)).toBe('1');
});
