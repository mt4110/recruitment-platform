import {test, expect, BrowserContext, Page, Locator} from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const {sql, signIn, identity, origin, assertPrivateStorage} = require('./helpers.cjs');
const dir=process.env.RP_E2E_DIR!;
type Actor={context:BrowserContext;page:Page;me:{user:{id:string};csrf_token:string}};
const actors:Record<string,Actor>={};
const evidence:{forms:string[];load:unknown[];ime?:unknown}={forms:[],load:[]};
const issues:string[]=[];
let candidate:{id:string;version:number},job:{id:string;version:number},application:{id:string},shared:{id:string},documentId:string;
async function call(who:string,method:string,url:string,data?:unknown){
 return actors[who].context.request.fetch(origin+'/api/v1'+url,{method,timeout:15000,headers:{Origin:origin,'X-CSRF-Token':actors[who].me.csrf_token,'Idempotency-Key':crypto.randomUUID()},...(data===undefined?{}:{data})});
}
async function ok(who:string,method:string,url:string,data:unknown,status=200){const r=await call(who,method,url,data);expect(r.status()).toBe(status);return r.json();}
function boundary(){sql("UPDATE form_drafts SET expires_at=now()-interval '1 second',revision=revision+1 WHERE state='active' AND expires_at>now();UPDATE draft_admissions SET at=now()-interval '2 hours';");}
test.beforeAll(async({browser})=>{
 boundary();
 for(const [who,name] of Object.entries({a:'agency-a',b:'agency-b',x:'employer-x',y:'employer-y'})){
  const context=await browser.newContext(),page=await context.newPage();
  page.on('pageerror',()=>issues.push('PAGE_ERROR'));
  expect((await signIn(page,name)).status()).toBe(303);
  actors[who]={context,page,me:await identity(context)};
 }
 job=await ok('x','POST','/jobs',{title:'R6架空求人',description:'R6架空の横断検証',location:'東京都',employment_type:'full_time'},201);
 job=await ok('x','POST',`/jobs/${job.id}/status`,{version:job.version,status:'published'});
 candidate=await ok('a','POST','/candidates',{name:'R6架空候補者',summary:'架空の検証用経歴',fictional_confirmed:true},201);
 const r=await actors.a.context.request.post(origin+`/api/v1/candidates/${candidate.id}/documents`,{headers:{Origin:origin,'X-CSRF-Token':actors.a.me.csrf_token,'Idempotency-Key':crypto.randomUUID()},multipart:{fictional_confirmed:'true',document_kind:'resume',file:{name:'R6架空履歴書.pdf',mimeType:'application/pdf',buffer:fs.readFileSync(path.resolve(__dirname,'../apps/web/public/sample-resume.pdf'))}}});
 expect(r.status()).toBe(201);const d=await r.json();expect(d.available).toBe(true);documentId=d.id;
 application=await ok('a','POST','/applications',{candidate_id:candidate.id,job_id:job.id,reason:'R6架空推薦の元本文'},201);
 const c2=await ok('a','POST','/candidates',{name:'R6架空共有候補者',summary:'架空の選考用経歴',fictional_confirmed:true},201);
 // A second application may use no foreign candidate's document; create its own.
 const r2=await actors.a.context.request.post(origin+`/api/v1/candidates/${c2.id}/documents`,{headers:{Origin:origin,'X-CSRF-Token':actors.a.me.csrf_token,'Idempotency-Key':crypto.randomUUID()},multipart:{fictional_confirmed:'true',document_kind:'resume',file:{name:'R6架空共有書類.pdf',mimeType:'application/pdf',buffer:fs.readFileSync(path.resolve(__dirname,'../apps/web/public/sample-resume.pdf'))}}});
 expect(r2.status()).toBe(201);const d2=await r2.json();expect(d2.available).toBe(true);
 shared=await ok('a','POST','/applications',{candidate_id:c2.id,job_id:job.id,reason:'R6架空の共有案件'},201);
 shared=await ok('a','POST',`/applications/${shared.id}/submit`,{version:1,candidate_version:c2.version,job_version:job.version,document_ids:[d2.id],fictional_confirmed:true,consent_confirmed:true});
 for(const a of Object.values(actors))await a.page.goto('about:blank');
});
test.afterAll(async()=>{
 for(const a of Object.values(actors))await a.context.close();
 fs.writeFileSync(path.join(dir,'artifacts/r6-cross-cutting.json'),JSON.stringify({...evidence,browser:'Chromium',visibility:'synthetic hidden/visible events, not OS app interruption',issues},null,2)+'\n');
 expect(issues).toEqual([]);
});
type FormCase={kind:string;who:string;url:()=>string;field:(p:Page)=>Locator;value:string;select?:boolean;checkbox?:boolean;index?:number};
const cases:FormCase[]=[
 {kind:'job_new',who:'x',url:()=>'/jobs/new',field:p=>p.getByLabel('求人名'),value:'R6新規求人の未確定入力'},
 {kind:'job_edit',who:'x',url:()=>`/jobs/${job.id}/edit`,field:p=>p.getByLabel('仕事内容'),value:'R6編集途中の架空求人'},
 {kind:'candidate_new',who:'a',url:()=>'/candidates/new',field:p=>p.getByLabel('架空氏名'),value:'R6新規の架空氏名'},
 {kind:'candidate_edit',who:'a',url:()=>`/candidates/${candidate.id}/edit`,field:p=>p.getByLabel('経歴の概要'),value:'R6編集途中の架空経歴'},
 {kind:'application_new',who:'a',url:()=>`/applications/new?job_id=${job.id}`,field:p=>p.getByLabel('推薦理由',{exact:true}),value:'R6未確定の架空推薦'},
 {kind:'application_reason',who:'a',url:()=>`/applications/${application.id}`,field:p=>p.getByLabel('推薦理由',{exact:true}),value:'R6推薦理由の途中入力'},
 {kind:'application_submit',who:'a',url:()=>`/applications/${application.id}`,field:p=>p.getByLabel(/R6架空履歴書.pdf/),value:'selected',checkbox:true,index:1},
 {kind:'selection_note',who:'x',url:()=>`/applications/${shared.id}`,field:p=>p.getByLabel('操作の理由'),value:'R6未確定の架空選考理由'},
 {kind:'document_upload',who:'a',url:()=>`/candidates/${candidate.id}`,field:p=>p.getByLabel('書類の種類',{exact:true}),value:'career_history',select:true},
 {kind:'job_filters',who:'a',url:()=>'/jobs',field:p=>p.getByRole('textbox',{name:'検索',exact:true}),value:'R6架空の求人検索'},
 {kind:'candidate_filters',who:'a',url:()=>'/candidates',field:p=>p.getByRole('textbox',{name:'検索',exact:true}),value:'R6架空の候補者検索'},
 {kind:'application_filters',who:'a',url:()=>'/applications',field:p=>p.getByLabel('推薦の状態'),value:'screening',select:true},
];
for(const c of cases)test(`R6 ${c.kind}: input navigation reload visibility and reauthentication restore without business commit`,async()=>{
 const actor=actors[c.who],p=actor.page,url=c.url();
 const counts=sql('SELECT (SELECT count(*) FROM jobs),(SELECT count(*) FROM candidates),(SELECT count(*) FROM applications),(SELECT count(*) FROM documents),(SELECT count(*) FROM selection_events),(SELECT count(*) FROM notification_previews);');
 await p.goto(origin+url);
 const panel=p.getByRole('complementary',{name:'個人下書き'}).nth(c.index||0);
 await expect(panel).toContainText(/サーバーへ保存しました|下書きを復元しました/);
 const input=c.field(p);await expect(input).toBeEnabled();
 const saved=p.waitForResponse(r=>r.request().method()==='PUT'&&r.url().includes('/api/v1/drafts/')&&r.request().postDataJSON()?.form_type===c.kind&&(c.kind!=='candidate_new'||r.request().postDataJSON()?.payload?.name===c.value)&&r.ok());
 if(c.kind==='candidate_new'){
  const errors:string[]=[],warnings:string[]=[];
  const listener=(m:import('@playwright/test').ConsoleMessage)=>{if(m.type()==='error')errors.push('CONSOLE_ERROR');if(m.type()==='warning')warnings.push('CONSOLE_WARNING');};p.on('console',listener);
  await input.focus();const cdp=await actor.context.newCDPSession(p);
  const intermediate=p.waitForResponse(r=>r.request().method()==='PUT'&&r.url().includes('/api/v1/drafts/')&&r.request().postDataJSON()?.payload?.name==='かくうへんかんちゅう'&&r.ok());
  await cdp.send('Input.imeSetComposition',{text:'かくうへんかんちゅう',selectionStart:10,selectionEnd:10});await expect(input).toHaveValue('かくうへんかんちゅう');await intermediate;
  await cdp.send('Input.insertText',{text:c.value});await expect(input).toHaveValue(c.value);await saved;
  p.off('console',listener);await cdp.detach();expect(errors).toEqual([]);expect(warnings).toEqual([]);
  evidence.ime={method:'Chromium CDP composition, not OS IME',intermediate_saved:true,final_saved:true,console_errors:errors.length,console_warnings:warnings.length};
 }else if(c.checkbox)await input.check();else if(c.select)await input.selectOption(c.value);else await input.fill(c.value);
 await input.blur();const response=await saved;const id=(await response.json()).id;
 const check=async()=>{
  const field=c.field(p);if(c.checkbox)await expect(field).toBeChecked();else await expect(field).toHaveValue(c.value);
  await expect(p.locator('main')).not.toBeEmpty();await expect(p.locator('nextjs-portal')).toHaveCount(0);
  for(const confirmation of ['氏名・経歴はすべて架空のデータです','氏名・経歴・書類はすべて架空の情報です','選択した架空情報を企業に共有する操作を確認しました（demo-share-v1）','書類の内容はすべて架空の情報です']){
   const box=p.getByLabel(confirmation,{exact:true});if(await box.count())await expect(box).not.toBeChecked();
  }
 };
 await p.goto(origin+'/');await p.goto(origin+url);await check();await p.reload();await check();
 await p.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.dispatchEvent(new Event('visibilitychange'));});
 await expect(c.field(p)).toBeEnabled();await check();
 const session=(await actor.context.cookies(origin)).find(x=>x.name==='rp_session')!;
 sql(`UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=decode('${crypto.createHash('sha256').update(session.value).digest('hex')}','hex');`);
 expect((await signIn(p,c.who==='x'?'employer-x':'agency-a')).status()).toBe(303);actor.me=await identity(actor.context);
 await p.goto(origin+url);await check();await assertPrivateStorage(p);
 expect((await call(c.who,'GET','/drafts/'+id)).status()).toBe(200);
 expect(sql('SELECT (SELECT count(*) FROM jobs),(SELECT count(*) FROM candidates),(SELECT count(*) FROM applications),(SELECT count(*) FROM documents),(SELECT count(*) FROM selection_events),(SELECT count(*) FROM notification_previews);')).toBe(counts);
 if(c.kind==='candidate_edit'){await input.scrollIntoViewIfNeeded();await p.screenshot({path:path.join(dir,'artifacts/r6-restored-desktop.png')});}
 if(c.kind==='application_filters'){await p.setViewportSize({width:390,height:844});await input.scrollIntoViewIfNeeded();await expect.poll(()=>p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await p.screenshot({path:path.join(dir,'artifacts/r6-restored-mobile.png')});}
 evidence.forms.push(c.kind);await p.goto('about:blank');
});
test('R6 bounded concurrent load preserves ownership revisions rate admission and resource limits',async()=>{
 for(const a of Object.values(actors))await a.page.goto('about:blank');
 const before=sql('SELECT count(*) FROM candidates;');
 const measure=async(label:string,tasks:(()=>Promise<number>)[])=>{
  const start=performance.now();const durations:number[]=[];
  const codes=await Promise.all(tasks.map(async f=>{const s=performance.now(),code=await f();durations.push(performance.now()-s);return code;}));
  durations.sort((a,b)=>a-b);evidence.load.push({label,requests:codes.length,concurrency:tasks.length,elapsed_ms:Math.round(performance.now()-start),p50_ms:Math.round(durations[Math.ceil(durations.length*.5)-1]),p95_ms:Math.round(durations[Math.ceil(durations.length*.95)-1]),statuses:codes});return codes;
 };
 // Independent isolated fixture boundary, not a production rate-limit override.
 sql("UPDATE draft_admissions SET at=now()-interval '2 hours' WHERE user_id='"+actors.b.me.user.id+"';");
 const body=(revision=0)=>({revision,form_type:'candidate_new',target_id:null,context_id:null,schema_version:1,base_resource_version:null,payload:{name:'R6架空負荷入力'},mutation_id:crypto.randomUUID()});
 const id=crypto.randomUUID();expect((await call('b','PUT','/drafts/'+id,body())).status()).toBe(201);
 const codes=await measure('same_revision_8',Array.from({length:8},()=>async()=> (await call('b','PUT','/drafts/'+id,body(1))).status()));
 expect(codes.filter(x=>x===200)).toHaveLength(1);expect(codes.filter(x=>x===409)).toHaveLength(7);
 const reads=await measure('four_actors_read_32',Object.keys(actors).flatMap(who=>Array.from({length:8},()=>async()=> (await call(who,'GET','/drafts/'+id)).status())));
 expect(reads.slice(8,16)).toEqual(Array(8).fill(200));expect(reads.filter(x=>x===404)).toHaveLength(24);
 const admissions=await measure('remaining_new_admissions_29',Array.from({length:29},()=>async()=> (await call('b','PUT','/drafts/'+crypto.randomUUID(),body())).status()));expect(admissions).toEqual(Array(29).fill(201));
 const denied=await call('b','PUT','/drafts/'+crypto.randomUUID(),body());expect(denied.status()).toBe(429);expect(denied.headers()['retry-after']).toBe('3600');
 expect(sql(`SELECT count(*) FROM draft_admissions WHERE user_id='${actors.b.me.user.id}' AND is_new AND at>now()-interval '1 hour';`)).toBe('30');
 expect(sql('SELECT count(*) FROM candidates;')).toBe(before);
 expect((await call('b','GET','/drafts/'+id)).status()).toBe(200);
});
