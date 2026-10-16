const {test,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {sql,signIn,identity,origin,shot}=require('./helpers.cjs');
const pdf=fs.readFileSync(path.resolve(__dirname,'../apps/web/public/sample-resume.pdf'));
const xlsx=fs.readFileSync(path.join(__dirname,'fixtures/sheets-career-history.xlsx'));
const MIME='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',actors={},issues=[];let expectedNetwork=false;
const A='00000000-0000-0000-0000-000000000001',B='00000000-0000-0000-0000-000000000002',X='00000000-0000-0000-0000-000000000011',Y='00000000-0000-0000-0000-000000000012';
function scope(org){return `BEGIN;SET LOCAL ROLE app_runtime;SELECT set_config('app.user_id','10000000${org.slice(8)}',true),set_config('app.org_id','${org}',true);`;}
async function call(who,method,url,data){return actors[who].context.request.fetch(origin+'/api/v1'+url,{method,headers:{Origin:origin,'X-CSRF-Token':actors[who].me.csrf_token,'Idempotency-Key':crypto.randomUUID()},...(data===undefined?{}:{data})});}
function freshAdmission(){sql("UPDATE document_admissions SET created_at=now()-interval '2 minutes' WHERE created_at>now()-interval '1 minute';");}
async function candidate(){const r=await call('a','POST','/candidates',{name:'R3架空候補者',summary:'版選択・受付復帰の架空検証',fictional_confirmed:true});expect(r.status()).toBe(201);return r.json();}
const file=(name='架空版.pdf',format='pdf')=>({name,mimeType:format==='pdf'?'application/pdf':MIME,buffer:format==='pdf'?pdf:xlsx});
async function upload(c,kind='resume',format='pdf'){const r=await actors.a.context.request.post(origin+`/api/v1/candidates/${c.id}/documents`,{headers:{Origin:origin,'X-CSRF-Token':actors.a.me.csrf_token,'Idempotency-Key':crypto.randomUUID()},multipart:{fictional_confirmed:'true',document_kind:kind,file:file(format==='pdf'?'架空版.pdf':'架空版.xlsx',format)}});expect(r.status()).toBe(201);return r.json();}
async function select(p,files,kind='resume'){await p.getByLabel('書類の種類',{exact:true}).selectOption(kind);await p.getByLabel('PDF／XLSXファイル',{exact:true}).setInputFiles(files);await expect(p.getByLabel('書類の内容はすべて架空の情報です')).toBeEnabled();await p.getByLabel('書類の内容はすべて架空の情報です').check();}
function receipt(c,operations,who='a'){const me=actors[who].me;return origin+'/candidates/'+c.id+'#receipts='+encodeURIComponent(JSON.stringify({v:1,user:me.user.id,org:me.organization.id,candidate:c.id,operations}));}
test.beforeAll(async({browser})=>{for(const [who,name]of Object.entries({a:'agency-a',b:'agency-b',x:'employer-x',y:'employer-y'})){const context=await browser.newContext(),page=await context.newPage();page.on('pageerror',()=>issues.push('PAGE_ERROR'));page.on('console',m=>{if(['error','warning'].includes(m.type())&&!(expectedNetwork&&/net::ERR_FAILED/.test(m.text()))&&!/^Failed to load resource: the server responded with a status of (400|401|403|404|409|413|422|429|503)\b/.test(m.text()))issues.push('UNEXPECTED_CONSOLE');});expect((await signIn(page,name)).status()).toBe(303);actors[who]={context,page,me:await identity(context)};}});
test.afterAll(async()=>{for(const a of Object.values(actors))await a.context.close();expect(issues).toEqual([]);});

test('R3 immutable kind ordinals survive concurrent creation and deny cross-tenant reads or writes',async()=>{
 freshAdmission();const c=await candidate(),first=await upload(c),next=await Promise.all([upload(c),upload(c)]),career=await upload(c,'career_history','xlsx');
 expect(first.document_version).toBe(1);expect(next.map(d=>d.document_version).sort()).toEqual([2,3]);expect(career.document_version).toBe(1);
 expect(new Set([first,...next,career].map(d=>d.id)).size).toBe(4);
 expect((await(await call('a','GET','/documents/'+first.id)).json()).document_version).toBe(1);
 for(const org of [B,X,Y])expect(sql(scope(org)+`SELECT count(*) FROM document_versions WHERE candidate_id='${c.id}';ROLLBACK;`).split('\n').filter(v=>/^\d+$/.test(v))).toEqual(['0']);
 expect(sql("SELECT has_table_privilege('app_runtime','document_versions','INSERT'),has_table_privilege('app_runtime','document_versions','UPDATE'),has_table_privilege('app_runtime','document_versions','DELETE'),has_table_privilege('app_auth','document_versions','SELECT');")).toBe('f|f|f|f');
 expect(()=>sql(scope(A)+`UPDATE document_versions SET version=99 WHERE document_id='${first.id}';ROLLBACK;`)).toThrow('DB_CONTROL_FAILED:42501');
});
test('R3 multiple PDF XLSX register sequentially with kinds versions and mobile keyboard access',async()=>{
 freshAdmission();const c=await candidate(),p=actors.a.page;await p.goto(origin+'/candidates/'+c.id);let current=0,max=0,count=0;
 const pattern=`**/api/v1/candidates/${c.id}/documents`;
 await p.route(pattern,async route=>{current++;count++;max=Math.max(max,current);try{const r=await route.fetch();await route.fulfill({response:r});}finally{current--;}});
 try{await select(p,[file('架空一.pdf'),file('架空二.xlsx','xlsx')]);await p.getByRole('button',{name:'書類を登録する',exact:true}).click();await expect(p.getByRole('region',{name:'書類の受付状況'}).getByText('履歴書 · 登録完了',{exact:true})).toHaveCount(2);expect(count).toBe(2);expect(max).toBe(1);
 await expect(p.getByRole('region',{name:'履歴書の版一覧'})).toContainText('第2版 · XLSX');await shot(p,'r3-multiple-desktop');
 await p.setViewportSize({width:390,height:844});await expect.poll(()=>p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await p.getByLabel('書類の種類',{exact:true}).focus();await expect(p.getByLabel('書類の種類',{exact:true})).toBeFocused();await shot(p,'r3-multiple-mobile');await p.setViewportSize({width:1280,height:900});
 }finally{await p.unroute(pattern);}
});
test('R3 eleven files are rejected before POST and one rejected file does not prevent the next valid file',async()=>{
 freshAdmission();const c=await candidate(),p=actors.a.page;await p.goto(origin+'/candidates/'+c.id);let posts=0;const count=r=>{if(r.method()==='POST'&&r.url()===origin+`/api/v1/candidates/${c.id}/documents`)posts++;};p.on('request',count);
 try{await p.getByLabel('PDF／XLSXファイル',{exact:true}).setInputFiles(Array.from({length:11},(_,i)=>file(`架空${i}.pdf`)));await expect(p.getByRole('status')).toContainText('10件まで');expect(posts).toBe(0);
 await select(p,[{...file('不正な架空.pdf'),buffer:Buffer.from('invalid-pdf')},file('正常な架空.pdf')]);await p.getByRole('button',{name:'書類を登録する',exact:true}).click();const q=p.getByRole('region',{name:'書類の受付状況'});await expect(q).toContainText('登録拒否');await expect(q).toContainText('登録完了');expect(posts).toBe(2);
 }finally{p.off('request',count);}
});
test('R3 browser submits only explicitly selected version; later originals never change shared snapshot',async()=>{
 freshAdmission();const c=await candidate(),old=await upload(c),chosen=await upload(c),other=await upload(c,'career_history','xlsx');
 let r=await call('a','POST','/applications',{candidate_id:c.id,job_id:'30000000-0000-0000-0000-000000000001',reason:'R3架空の版選択'});expect(r.status()).toBe(201);const a=await r.json(),p=actors.a.page;
 await p.goto(origin+'/applications/'+a.id);const option=p.getByRole('checkbox',{name:'架空版.pdf · 履歴書 第2版 · PDF',exact:true});await expect(option).not.toBeChecked();await expect(p.getByRole('checkbox',{name:'架空版.pdf · 履歴書 第1版 · PDF',exact:true})).not.toBeChecked();await option.check();await p.getByRole('checkbox',{name:'氏名・経歴・書類はすべて架空の情報です',exact:true}).check();await p.getByRole('checkbox',{name:/選択した架空情報を企業に共有/}).check();await p.getByRole('button',{name:'推薦を提出する',exact:true}).click();await expect(p.getByRole('status')).toContainText('変更を保存しました');
 let saved=await(await call('a','GET','/applications/'+a.id)).json();expect(saved.documents.map(d=>d.id)).toEqual([chosen.id]);expect(saved.documents[0].document_version).toBe(2);const snapshot=JSON.stringify(saved.documents);
 await upload(c);saved=await(await call('x','GET','/applications/'+a.id)).json();expect(JSON.stringify(saved.documents)).toBe(snapshot);
 for(const d of [old,other])expect((await call('x','GET',`/applications/${a.id}/documents/${d.id}/content`)).status()).toBe(404);
 expect((await call('x','GET',`/applications/${a.id}/documents/${chosen.id}/content`)).status()).toBe(200);
 for(const org of [X,B,Y])expect(sql(scope(org)+`SELECT count(*) FROM document_versions WHERE candidate_id='${c.id}';ROLLBACK;`).split('\n').filter(v=>/^\d+$/.test(v))).toEqual([org===X?'1':'0']);
});
test('R3 lost response recovers the accepted ID without uploading again',async()=>{
 freshAdmission();const c=await candidate(),p=actors.a.page;await p.goto(origin+'/candidates/'+c.id);let count=0,accepted;
 const pattern=`**/api/v1/candidates/${c.id}/documents`;expectedNetwork=true;
 await p.route(pattern,async route=>{count++;const r=await route.fetch();expect(r.status()).toBe(201);accepted=(await r.json()).id;await route.abort('failed');});
 try{await select(p,[file('応答中断の架空.pdf')]);await p.getByRole('button',{name:'書類を登録する',exact:true}).click();await expect(p.getByRole('region',{name:'書類の受付状況'})).toContainText('再試行待ち');await p.getByRole('button',{name:'受付結果を確認する',exact:true}).click();await expect(p.getByRole('region',{name:'書類の受付状況'})).toContainText('受付済みID：'+accepted);await expect(p.getByRole('region',{name:'書類の受付状況'})).toContainText('登録完了');expect(count).toBe(1);expect(sql(`SELECT count(*) FROM documents WHERE candidate_id='${c.id}';`)).toBe('1');
 }finally{await p.unroute(pattern);expectedNetwork=false;}
});
test('R3 new browser context restores only opaque receipts after authentication and never resends a file',async({browser})=>{
 freshAdmission();const c=await candidate(),p=actors.a.page;await p.goto(origin+'/candidates/'+c.id);await select(p,[file('再起動の架空.pdf')]);await p.getByRole('button',{name:'書類を登録する',exact:true}).click();await expect(p.getByRole('region',{name:'書類の受付状況'})).toContainText('登録完了');await p.getByText('再起動後の受付結果を確認する',{exact:true}).click();const link=await p.getByRole('link',{name:'受付結果の復帰リンク'}).getAttribute('href');expect(decodeURIComponent(link)).not.toMatch(/再起動の架空|sha256|csrf|password|buffer/);
 const d=JSON.parse(sql(`SELECT json_build_object('id',id) FROM documents WHERE candidate_id='${c.id}';`));const context=await browser.newContext();
 try{const page=await context.newPage();await signIn(page);let posts=0;page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/documents'))posts++;});await page.goto(link);await expect(page.getByRole('status')).toContainText('復帰リンクの受付結果を確認');await expect(page.getByLabel('PDF／XLSXファイル',{exact:true})).toHaveValue('');await page.getByRole('button',{name:'受付結果をまとめて確認する'}).click();await expect(page.getByRole('region',{name:'書類の受付状況'})).toContainText('受付済みID：'+d.id);expect(posts).toBe(0);
 expect(await page.evaluate(async()=>({local:Object.keys(localStorage),session:Object.keys(sessionStorage),dbs:(await indexedDB.databases()).map(d=>d.name)}))).toEqual({local:[],session:[],dbs:[]});await shot(page,'r3-restart-receipt');
 }finally{await context.close();}
 await actors.b.page.goto(link);await expect(actors.b.page.locator('.workspace').getByRole('alert')).toContainText('閲覧できません');
});
test('R3 missing or expired restart receipts cannot auto-resend; another identity cannot adopt a receipt',async()=>{
 const c=await candidate(),p=actors.a.page,key=crypto.randomUUID();let posts=0;const count=r=>{if(r.method()==='POST'&&r.url().includes('/documents'))posts++;};p.on('request',count);
 try{await p.goto(receipt(c,[{key,kind:'resume'}]));await p.getByRole('button',{name:'受付結果をまとめて確認する'}).click();await expect(p.getByRole('region',{name:'書類の受付状況'})).toContainText('未実行とは限りません');await expect(p.getByRole('button',{name:'受付結果を確認して再試行する'})).toHaveCount(0);
 const legacy=JSON.parse(fs.readFileSync(path.join(process.env.RP_E2E_DIR,'artifacts/legacy-migration.json')));await p.goto(receipt({id:legacy.candidate_id},[{key:'70000000-0000-0000-0000-00000000f002',kind:'other'}]));await p.getByRole('button',{name:'受付結果をまとめて確認する'}).click();await expect(p.getByRole('region',{name:'書類の受付状況'})).toContainText('結果照合期限切れ');await expect(p.getByRole('button',{name:'受付結果を確認して再試行する'})).toHaveCount(0);expect(posts).toBe(0);
 await p.goto(receipt(c,[{key,kind:'resume'}],'b'));await expect(p.getByRole('status')).toContainText('本人・所属が一致しません');await expect(p.getByRole('region',{name:'書類の受付状況'})).toHaveCount(0);
 }finally{p.off('request',count);}
});
test('R3 pre-reservation network interruption reconciles before an explicit same-key retry',async()=>{
 freshAdmission();const c=await candidate(),p=actors.a.page;await p.goto(origin+'/candidates/'+c.id);const keys=[],order=[],pattern=`**/api/v1/candidates/${c.id}/documents`;expectedNetwork=true;
 await p.route(pattern,async route=>{keys.push(route.request().headers()['idempotency-key']);order.push('POST');if(keys.length===1)await route.abort('failed');else await route.continue();});
 const observe=r=>{if(r.url().includes(`/candidates/${c.id}/document-upload-outcome`))order.push('GET');};p.on('request',observe);
 try{await select(p,[file('未予約の架空.pdf')]);await p.getByRole('button',{name:'書類を登録する',exact:true}).click();await expect(p.getByRole('region',{name:'書類の受付状況'})).toContainText('再試行待ち');await p.getByRole('button',{name:'受付結果を確認して再試行する',exact:true}).click();await expect(p.getByRole('region',{name:'書類の受付状況'})).toContainText('登録完了');expect(keys.length).toBe(2);expect(keys[0]).toBe(keys[1]);expect(order).toEqual(['POST','GET','POST']);expect(sql(`SELECT count(*) FROM documents WHERE candidate_id='${c.id}';`)).toBe('1');
 }finally{await p.unroute(pattern);p.off('request',observe);expectedNetwork=false;}
});
test('R3 submission preflight resets confirmations when candidate version changed',async()=>{
 freshAdmission();const c=await candidate();await upload(c);const r=await call('a','POST','/applications',{candidate_id:c.id,job_id:'30000000-0000-0000-0000-000000000001',reason:'R3架空の提出直前確認'});expect(r.status()).toBe(201);const a=await r.json(),p=actors.a.page;
 await p.goto(origin+'/applications/'+a.id);await p.getByRole('checkbox',{name:'架空版.pdf · 履歴書 第1版 · PDF',exact:true}).check();const f=p.getByRole('checkbox',{name:'氏名・経歴・書類はすべて架空の情報です',exact:true}),consent=p.getByRole('checkbox',{name:/選択した架空情報を企業に共有/});await f.check();await consent.check();expect((await call('a','PATCH','/candidates/'+c.id,{version:c.version,name:c.name,summary:'R3変更後の架空経歴'})).status()).toBe(200);
 await p.getByRole('button',{name:'推薦を提出する',exact:true}).click();await expect(p.getByRole('status')).toContainText('共有する版を見直して');await expect(f).not.toBeChecked();await expect(consent).not.toBeChecked();expect((await(await call('a','GET','/applications/'+a.id)).json()).status).toBe('draft');expect(sql(`SELECT count(*) FROM application_documents WHERE application_id='${a.id}';`)).toBe('0');
});
