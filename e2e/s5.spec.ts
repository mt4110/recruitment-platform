import { test, expect, type Page, type BrowserContext, type APIResponse } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

type Identity = { csrf_token: string; user: { id: string }; organization: { id: string } };
type Actor = { context: BrowserContext; page: Page; me: Identity };
type Entity = { id: string; version: number };
type Receipt = { upload_id: string; attempt_id: string; document_id: string; state: string };
type Worker = { status: string; events: string[]; stopped: boolean; record: string };
type Row = { case: string; format: string; bytes: number; browser_cache: string; outcome: string; timings_ms: Record<string,number>; worker_ms: Record<string,number>; memory_limits_bytes: Record<string,number>; worker_oom: boolean };
const { sql, signIn, identity, origin } = require('./helpers.cjs') as {
  sql: (s: string) => string; signIn: (p: Page,n?: string) => Promise<APIResponse>;
  identity: (c: BrowserContext) => Promise<Identity>; origin: string;
};
const root=path.resolve(__dirname,'..'),dir=process.env.RP_E2E_DIR!,actors:Record<string,Actor>={};
const pdf=fs.readFileSync(path.join(root,'apps/web/public/sample-resume.pdf'));
const xlsx=fs.readFileSync(path.join(__dirname,'fixtures/sheets-resume.xlsx'));
const rows:Row[]=[],issues:string[]=[];
let shared: { application:Entity; candidate:Entity; job:Entity; ids:string[] };
const host=(script:string,args:string[]=[])=>cp.spawnSync('python3',[script,...args],{cwd:root,env:process.env,encoding:'utf8',timeout:180000});
function compose(...args:string[]):string { const r=host('scripts/local.py',['compose',...args]);expect(r.status,'isolated service operation').toBe(0);return r.stdout; }
async function call(who:string,url:string,method='GET',data?:unknown,key=crypto.randomUUID()):Promise<APIResponse>{
 return actors[who].context.request.fetch(origin+'/api/v1'+url,{method,headers:{Origin:origin,'X-CSRF-Token':actors[who].me.csrf_token,'Idempotency-Key':key},...(data===undefined?{}:{data})});
}
async function entity(who:string,url:string,method='GET',data?:unknown,status=200):Promise<Entity>{
 const r=await call(who,url,method,data);expect(r.status(),url).toBe(status);const v=await r.json();expect(v.id).toMatch(/^[a-f0-9-]{36}$/);expect(Number.isInteger(v.version)).toBe(true);return {id:v.id,version:v.version};
}
async function candidate(label='S5架空候補者'):Promise<Entity>{return entity('a','/candidates','POST',{name:label,summary:'架空の経歴のみ',fictional_confirmed:true},201);}
async function room():Promise<void>{const [n,seconds]=sql(`SELECT count(*)||'|'||coalesce(ceil(max(61-extract(epoch FROM now()-created_at))),0)::integer FROM document_admissions WHERE user_id='${actors.a.me.user.id}' AND created_at>now()-interval '1 minute';`).split('|').map(Number);if(n>=7)await new Promise(r=>setTimeout(r,seconds*1000));}
function worker(accepted=true):Record<string,number>{
 const r=host('scripts/document_job.py',['--no-build']);expect(r.status,r.stdout).toBe(accepted?0:1);const v:Worker=JSON.parse(r.stdout.trim().split('\n').at(-1)!);expect(v.events).toEqual([accepted?'checked':'rejected']);expect(v.stopped).toBe(true);
 const record=JSON.parse(fs.readFileSync(v.record,'utf8'));expect(record.log_secret_pattern_found).toBe(false);expect(Object.values(record.containers).every((v:unknown)=>!(v as {oom_killed:boolean}).oom_killed)).toBe(true);return record.phase_milliseconds;
}
async function fresh(p:Page):Promise<void>{const panel=p.getByRole('complementary',{name:'個人下書き'}).first();await expect(panel).toBeVisible();await expect(panel).not.toContainText('下書きを確認中');const b=p.getByRole('button',{name:'新しい下書きを開始する',exact:true});if(await b.isVisible())await b.click();}
async function attach(p:Page,c:Entity,files:{name:string;mimeType:string;buffer:Buffer}[]):Promise<string[]>{
 const prior=sql(`SELECT document_id FROM upload_sessions WHERE candidate_id='${c.id}' AND state='attached';`).split('\n').filter(Boolean);await room();await p.goto(origin+'/candidates/'+c.id);await expect(p.getByLabel('PDF／XLSXファイル',{exact:true})).toBeEnabled();await expect(p.getByLabel('暗号化受付を使う（検査・閲覧用変換を行います）')).toBeChecked();
 await p.getByLabel('書類の種類',{exact:true}).selectOption('resume');await p.getByLabel('PDF／XLSXファイル',{exact:true}).setInputFiles(files);await p.getByLabel('書類の内容はすべて架空の情報です').check();await p.getByRole('button',{name:'書類を登録する',exact:true}).click();
 await expect.poll(()=>Number(sql(`SELECT count(*) FROM upload_sessions WHERE candidate_id='${c.id}' AND state='attached';`)),{timeout:30000}).toBe(prior.length+files.length);
 return sql(`SELECT document_id FROM upload_sessions WHERE candidate_id='${c.id}' AND state='attached' ORDER BY created_at,id;`).split('\n').filter(id=>!prior.includes(id));
}
async function screen(p:Page,name:string):Promise<void>{expect(new URL(p.url()).origin).toBe(origin);expect(await p.title()).toBeTruthy();await expect(p.locator('main')).not.toBeEmpty();await expect(p.locator('nextjs-portal')).toHaveCount(0);await p.screenshot({path:path.join(dir,'artifacts',name+'.png'),fullPage:false});}
function counts(c:string):string{return sql(`SELECT (SELECT count(*) FROM upload_sessions WHERE candidate_id='${c}')||'|'||(SELECT count(*) FROM upload_attempts a JOIN upload_sessions s ON a.upload_id=s.id WHERE s.candidate_id='${c}')||'|'||(SELECT count(*) FROM encrypted_document_jobs j JOIN documents d ON d.id=j.document_id WHERE d.candidate_id='${c}');`);}
async function scannerReady():Promise<void>{await expect.poll(()=>{try{return JSON.parse(compose('exec','-T','api','sh','-c','curl --fail --silent -H "X-Scan-Key: $SCAN_SHARED_KEY" http://scan:8080/internal/scan/state')).update_ok===true;}catch{return false;}},{timeout:100000}).toBe(true);}
async function avFault(change:string,work:()=>Promise<void>):Promise<void>{
 const control=(code:string)=>compose('exec','-T','updater','python3','-c',code);
 control("from pathlib import Path;p=Path('/tmp/s5-published-backup.json');p.write_bytes(Path('/signatures/published.json').read_bytes())");
 try{control("import uuid;from common import *;m=read_manifest();"+change+";publish(m)");await work();}
 finally{control("import json;from pathlib import Path;from common import publish;publish(json.loads(Path('/tmp/s5-published-backup.json').read_text()))");await scannerReady();}
}

test.describe.configure({mode:'serial'});
test.beforeAll(async({browser})=>{
 for(const [who,name] of [['a','agency-a'],['b','agency-b'],['x','employer-x'],['y','employer-y']]){
  const context=await browser.newContext(),page=await context.newPage();page.on('pageerror',()=>issues.push('PAGE_ERROR'));
  page.on('console',m=>{if(['error','warning'].includes(m.type())&&!/^Failed to load resource: the server responded with a status of (400|401|403|404|409|413|422|429|503)\b/.test(m.text())&&!/net::ERR_FAILED/.test(m.text()))issues.push('CONSOLE_ERROR');});
  expect((await signIn(page,name)).status()).toBe(303);actors[who]={context,page,me:await identity(context)};
 }
});
test.afterAll(async()=>{for(const a of Object.values(actors))await a.context.close();expect(issues).toEqual([]);});

test('S5 encrypted PDF and XLSX browser journey reaches immutable sharing and invoice HTML',async()=>{
 test.setTimeout(300000);const p=actors.a.page,x=actors.x.page;
 await x.goto(origin+'/jobs/new');await fresh(x);await x.getByLabel('求人名').fill('S5架空エンジニア');await x.getByLabel('仕事内容').fill('架空の業務開発');await x.getByLabel('勤務地').fill('架空東京');await x.getByRole('button',{name:'下書き保存',exact:true}).click();await expect(x.getByRole('button',{name:'公開する',exact:true})).toBeVisible();const jobId=new URL(x.url()).pathname.split('/').pop()!;await x.getByRole('button',{name:'公開する',exact:true}).click();await expect(x.getByText('公開中',{exact:true})).toBeVisible();
 await p.goto(origin+'/candidates/new');await fresh(p);await p.getByLabel('架空氏名').fill('S5一巡の架空候補者');await p.getByLabel('経歴の概要').fill('架空Web開発5年');await p.getByLabel('氏名・経歴はすべて架空のデータです').check();await p.getByRole('button',{name:'保存する',exact:true}).click();await expect(p.getByRole('heading',{name:'S5一巡の架空候補者',exact:true})).toBeVisible();const c=await entity('a','/candidates/'+new URL(p.url()).pathname.split('/').pop());
 const puts:Buffer[]=[];const observe=(r:import('@playwright/test').Request)=>{if(r.method()==='PUT'&&/\/document-uploads\/.+\/bytes$/.test(r.url()))puts.push(r.postDataBuffer()!);};p.on('request',observe);
 const ids=await attach(p,c,[{name:'S5架空履歴.pdf',mimeType:'application/pdf',buffer:pdf},{name:'S5架空経歴.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:xlsx}]);p.off('request',observe);expect(puts).toHaveLength(2);expect(puts.every(b=>!b.includes(pdf)&&!b.includes(xlsx)&&!b.includes(Buffer.from('S5架空')))).toBe(true);
 worker();worker();await p.reload();await expect(p.getByRole('region',{name:'履歴書の版一覧'})).toContainText('登録完了');
 await p.goto(origin+'/jobs/'+jobId);await p.getByRole('link',{name:'この求人に推薦する'}).click();await fresh(p);await p.getByLabel('候補者',{exact:true}).selectOption(c.id);await p.getByLabel('推薦理由',{exact:true}).fill('架空の推薦理由');await p.getByRole('button',{name:'下書きを保存する',exact:true}).click();await expect(p).toHaveURL(/\/applications\/[0-9a-f-]{36}$/);const appId=new URL(p.url()).pathname.split('/').pop()!;
 for(const name of ['S5架空履歴.pdf','S5架空経歴.xlsx'])await p.getByRole('checkbox',{name:new RegExp(name.replaceAll('.','\\.'))}).check();
 await p.getByLabel('氏名・経歴・書類はすべて架空の情報です').check();await p.getByLabel('選択した架空情報を企業に共有する操作を確認しました（demo-share-v1）').check();await p.getByRole('button',{name:'推薦を提出する',exact:true}).click();await expect(p.locator('.metadata')).toContainText('提出済み');
 shared={application:await entity('a','/applications/'+appId),candidate:c,job:await entity('x','/jobs/'+jobId),ids};
 const extra=await attach(p,c,[{name:'S5未選択の追加版.pdf',mimeType:'application/pdf',buffer:pdf}]);worker();
 expect((await call('x',`/applications/${appId}/documents/${extra[0]}/view`)).status()).toBe(404);
 const snap=sql(`SELECT to_jsonb(s)::text FROM application_snapshots s WHERE application_id='${appId}';`);
 await x.goto(origin+'/applications/'+appId);await x.getByRole('button',{name:'安全な表示を開く'}).first().click();await expect(x.locator('.safe-view')).not.toBeEmpty();await screen(x,'s5-shared-desktop');await x.getByRole('button',{name:'閲覧を閉じる'}).click();
 await x.getByRole('button',{name:'選考を開始する'}).click();await expect(x.locator('.metadata')).toContainText('選考中');await x.getByRole('button',{name:'採用を決定する'}).click();await expect(x.locator('.metadata')).toContainText('採用決定');shared.application=await entity('x','/applications/'+appId);
 await x.getByRole('link',{name:'請求書プレビューを開く'}).click();await expect(x.getByText('請求HTMLプレビューです。',{exact:false})).toBeVisible();await expect(x.locator('object,iframe,embed')).toHaveCount(0);await screen(x,'s5-invoice-desktop');
 const invoice=await call('x',`/applications/${appId}/invoice-view`);expect(invoice.status()).toBe(200);expect((await invoice.json()).amount_yen).toBe(500000);
 expect(sql(`SELECT to_jsonb(s)::text FROM application_snapshots s WHERE application_id='${appId}';`)).toBe(snap);
 for(const who of ['b','y'])for(const suffix of ['invoice-view',`documents/${ids[0]}/view`])expect((await call(who,`/applications/${appId}/`+suffix)).status()).toBe(404);
 const raw=await call('x',`/applications/${appId}/invoice-preview.pdf`);expect(raw.status()).toBe(410);expect((await raw.body()).length).toBe(0);
 await p.goto(origin+'/notifications');await expect(p.getByText('未送信のデモです。実際のメールは送信しません。',{exact:true})).toBeVisible();await expect(p.locator('.records')).toContainText('対象の推薦を見る');
});

test('S5 stale definitions load mismatch and update failure reject encrypted shared pages and submit',async()=>{
 test.setTimeout(240000);const doc=shared.ids[0];const before=counts(shared.candidate.id);
 for(const change of ["m['last_successful_check']-=86401","m['update_ok']=False","m['generation_id']=str(uuid.uuid4())"]){
  await avFault(change,async()=>{
   for(const who of ['a','x'])for(const suffix of ['', '/pages/1'])expect((await call(who,`/applications/${shared.application.id}/documents/${doc}/view`+suffix)).status()).toBe(503);
   expect((await call('a','/documents/'+doc+'/view')).status()).toBe(503);
   let j=await entity('x','/jobs','POST',{title:'S5障害時の架空求人',description:'架空',location:'架空',employment_type:'full_time'},201);j=await entity('x','/jobs/'+j.id+'/status','POST',{version:j.version,status:'published'});
   const a=await entity('a','/applications','POST',{candidate_id:shared.candidate.id,job_id:j.id,reason:'障害時の架空検証'},201);
   const r=await call('a',`/applications/${a.id}/submit`,'POST',{version:a.version,candidate_version:shared.candidate.version,job_version:j.version,document_ids:[doc],fictional_confirmed:true,consent_confirmed:true});expect(r.status()).toBe(503);
  });
  expect((await call('x',`/applications/${shared.application.id}/documents/${doc}/view`)).status()).toBe(200);
 }
 expect(counts(shared.candidate.id)).toBe(before);
});

test('S5 cross-document derivative substitution is refused without raw fallback',async()=>{
 const doc=shared.ids[0],other=shared.ids[1];
 const saved=JSON.parse(sql(`SELECT json_build_object('id',id,'envelope',envelope) FROM document_derivatives WHERE document_id='${doc}' AND kind='text';`));
 sql(`UPDATE document_derivatives SET envelope=(SELECT envelope FROM document_derivatives WHERE document_id='${other}' AND kind='table') WHERE id='${saved.id}';`);
 try{for(const who of ['a','x'])expect((await call(who,`/applications/${shared.application.id}/documents/${doc}/view`)).status()).toBe(404);const raw=await call('a','/documents/'+doc+'/content');expect(raw.status()).toBe(410);expect((await raw.body()).length).toBe(0);}
 finally{sql(`UPDATE document_derivatives SET envelope='${JSON.stringify(saved.envelope).replaceAll("'","''")}'::jsonb WHERE id='${saved.id}';`);}
 expect((await call('a','/documents/'+doc+'/view')).status()).toBe(200);
});

async function restartActor(browser:import('@playwright/test').Browser,url:string):Promise<Page>{
 await actors.a.context.close();const context=await browser.newContext(),p=await context.newPage();expect((await signIn(p,'agency-a')).status()).toBe(303);actors.a={context,page:p,me:await identity(context)};await p.goto(url);await expect(p.getByRole('region',{name:'書類の受付状況'})).toBeVisible();return p;
}
async function recoveryUrl(p:Page):Promise<string>{await expect(p.getByRole('complementary',{name:'個人下書き'})).toContainText('下書きをサーバーへ保存しました');await p.getByText('再起動後の受付結果を確認する',{exact:true}).click();return origin+(await p.getByRole('link',{name:'受付結果の復帰リンク'}).getAttribute('href'));}

test('S5 browser context loss after stored response restores same receipt without a second PUT',async({browser})=>{
 test.setTimeout(240000);const c=await candidate('S5受領復帰の架空候補者'),p=actors.a.page;await room();await p.goto(origin+'/candidates/'+c.id);await expect(p.getByLabel('PDF／XLSXファイル',{exact:true})).toBeEnabled();let puts=0;
 await p.route('**/api/v1/document-uploads/*/bytes',async route=>{puts++;const r=await route.fetch();expect(r.status()).toBe(202);await route.abort('failed');});
 await p.getByLabel('書類の種類',{exact:true}).selectOption('resume');await p.getByLabel('PDF／XLSXファイル',{exact:true}).setInputFiles({name:'S5受領復帰.pdf',mimeType:'application/pdf',buffer:pdf});await p.getByLabel('書類の内容はすべて架空の情報です').check();await p.getByRole('button',{name:'書類を登録する',exact:true}).click();await expect(p.getByRole('region',{name:'書類の受付状況'})).toContainText('再試行待ち');const url=await recoveryUrl(p);
 const before=sql(`SELECT document_id FROM upload_sessions WHERE candidate_id='${c.id}';`);expect(puts).toBe(1);
 const restored=await restartActor(browser,url);await expect(restored.getByRole('region',{name:'書類の受付状況'})).toContainText('暗号化して受付済みです');expect(counts(c.id)).toBe('1|1|1');worker();await restored.reload();await expect(restored.getByRole('region',{name:'履歴書の版一覧'})).toContainText('登録完了');expect(sql(`SELECT document_id FROM upload_sessions WHERE candidate_id='${c.id}';`)).toBe(before);
});

test('S5 browser loss before PUT requires file reselection and new attempt with the same document',async({browser})=>{
 test.setTimeout(240000);const c=await candidate('S5未受信復帰の架空候補者'),p=actors.a.page;await room();await p.goto(origin+'/candidates/'+c.id);await expect(p.getByLabel('PDF／XLSXファイル',{exact:true})).toBeEnabled();
 await p.route('**/api/v1/document-uploads/*/authorize',async route=>{const r=await route.fetch();expect(r.status()).toBe(200);await route.abort('failed');});
 await p.getByLabel('書類の種類',{exact:true}).selectOption('resume');await p.getByLabel('PDF／XLSXファイル',{exact:true}).setInputFiles({name:'S5未受信.pdf',mimeType:'application/pdf',buffer:pdf});await p.getByLabel('書類の内容はすべて架空の情報です').check();await p.getByRole('button',{name:'書類を登録する',exact:true}).click();await expect(p.getByRole('region',{name:'書類の受付状況'})).toContainText('再試行待ち');const url=await recoveryUrl(p);
 const before=sql(`SELECT document_id FROM upload_sessions WHERE candidate_id='${c.id}';`),aad=sql(`SELECT a.aad FROM upload_attempts a JOIN upload_sessions s ON s.id=a.upload_id WHERE s.candidate_id='${c.id}';`);
 const restored=await restartActor(browser,url);await expect(restored.getByRole('region',{name:'書類の受付状況'})).toContainText('元のファイルを再選択');expect(counts(c.id)).toBe('1|1|0');await expect(restored.getByLabel('PDF／XLSXファイル',{exact:true})).toBeEnabled();
 await restored.getByLabel('PDF／XLSXファイル',{exact:true}).setInputFiles({name:'S5未受信.pdf',mimeType:'application/pdf',buffer:pdf});await restored.getByLabel('書類の内容はすべて架空の情報です').check();await restored.getByRole('button',{name:'受付結果を確認して再試行する',exact:true}).click();await expect(restored.getByRole('region',{name:'書類の受付状況'})).toContainText('暗号化して受付済みです');expect(counts(c.id)).toBe('1|2|1');expect(sql(`SELECT document_id FROM upload_sessions WHERE candidate_id='${c.id}';`)).toBe(before);expect(sql(`SELECT count(*) FROM upload_attempts a JOIN upload_sessions s ON s.id=a.upload_id WHERE s.candidate_id='${c.id}' AND a.aad='${aad}';`)).toBe('1');worker();
});

test('S5 terminal receipt expiry does not reauthorize resend complete or recreate jobs',async()=>{
 const doc=shared.ids[0],c=shared.candidate.id;
 const r:Receipt=JSON.parse(sql(`SELECT json_build_object('upload_id',id,'attempt_id',canonical_attempt,'document_id',document_id,'state',state) FROM upload_sessions WHERE document_id='${doc}';`));
 const authorization=JSON.parse(sql(`SELECT json_build_object('attempt_id',id,'ciphertext_hash',ciphertext_hash,'ciphertext_size',ciphertext_size,'envelope',envelope) FROM upload_attempts WHERE id='${r.attempt_id}';`));
 const operationKey=sql(`SELECT key FROM idempotency_records WHERE resource_id='${doc}';`);
 const before=counts(c);sql(`UPDATE idempotency_records SET expires_at=now()-interval '1 second' WHERE resource_id='${doc}';`);
 for(const route of ['', '/authorize','/attempts','/complete'])expect((await call('a','/document-uploads/'+r.upload_id+route,route?'POST':'GET',route==='/authorize'?authorization:undefined)).status()).toBe(409);
 const fragment={v:1,user:actors.a.me.user.id,org:actors.a.me.organization.id,candidate:c,operations:[{key:operationKey,kind:'resume'}]};
 const p=actors.a.page;await p.goto(origin+'/candidates/'+c+'#receipts='+encodeURIComponent(JSON.stringify(fragment)));await p.getByRole('button',{name:'受付結果をまとめて確認する'}).click();await expect(p.getByRole('region',{name:'書類の受付状況'})).toContainText('結果照合期限切れ');
 expect(counts(c)).toBe(before);expect(sql(`SELECT state FROM idempotency_records WHERE resource_id='${doc}';`)).toBe('expired');expect((await call('a','/documents/'+doc+'/view')).status()).toBe(200);
});

test('S5 small batch and 10MiB browser uploads record bounded phase latency without a fabricated SLA',async({browser})=>{
 test.setTimeout(420000);
 await actors.a.context.close();const context=await browser.newContext();const p=await context.newPage();expect((await signIn(p,'agency-a')).status()).toBe(303);actors.a={context,page:p,me:await identity(context)};
 await context.addInitScript({content:`window.__s5={crypto_ms:0,crypto_calls:0,max_frame_gap_ms:0};
 const stats=window.__s5;for(const name of ['encrypt','wrapKey','digest']){const native=crypto.subtle[name];Object.defineProperty(crypto.subtle,name,{value:async function(...args){const t=performance.now();try{return await Reflect.apply(native,crypto.subtle,args);}finally{stats.crypto_ms+=performance.now()-t;stats.crypto_calls++;}}});}
 let previous;function frame(t){if(previous!==undefined)stats.max_frame_gap_ms=Math.max(stats.max_frame_gap_ms,t-previous);previous=t;requestAnimationFrame(frame);}requestAnimationFrame(frame);`});
 const eof=pdf.lastIndexOf('%%EOF');expect(eof).toBeGreaterThan(0);
 const big=Buffer.concat([pdf.subarray(0,eof),Buffer.alloc(10485760-eof-6,32),Buffer.from('%%EOF\n')]);expect(big.length).toBe(10485760);
 const cases=[{name:'small-pdf-cold-js',files:[{name:'S5計測.pdf',mimeType:'application/pdf',buffer:pdf}]},
  ...[1,2,3].map(i=>({name:'small-pdf-warm-'+i,files:[{name:'S5計測.pdf',mimeType:'application/pdf',buffer:pdf}]})),
  {name:'batch-pdf-xlsx',files:[{name:'S5計測.pdf',mimeType:'application/pdf',buffer:pdf},{name:'S5計測.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:xlsx}]},
  {name:'max-10MiB',files:[{name:'S5上限計測.pdf',mimeType:'application/pdf',buffer:big}]}];
 for(const trial of cases){
  const c=await candidate('S5計測専用の架空候補者');const started=performance.now(),requestStarts=new Map<import('@playwright/test').Request,number>(),durations:Record<string,number>={};
  const begin=(r:import('@playwright/test').Request)=>{if(r.url().includes('/api/v1/')&&['POST','PUT'].includes(r.method()))requestStarts.set(r,performance.now());};
  const finish=(r:import('@playwright/test').Request)=>{const t=requestStarts.get(r);if(t===undefined)return;let phase='';const u=new URL(r.url()).pathname;if(u.endsWith('/bytes'))phase='transfer';else if(u.endsWith('/authorize'))phase='authorization';else if(u.endsWith('/complete'))phase='complete';else if(u.endsWith('/document-uploads'))phase='reservation';if(phase)durations[phase]=(durations[phase]||0)+performance.now()-t;};
  p.on('request',begin);p.on('requestfinished',finish);const ids=await attach(p,c,trial.files);await expect(p.getByRole('region',{name:'書類の受付状況'})).toContainText('暗号化して受付済みです');p.off('request',begin);p.off('requestfinished',finish);durations.admission_wall=performance.now()-started;
  const stats:Record<string,number>=await p.evaluate('window.__s5');expect(stats.crypto_calls).toBeGreaterThan(0);durations.webcrypto=stats.crypto_ms;durations.max_animation_frame_gap=stats.max_frame_gap_ms;
  for(const [index,id] of ids.entries()){
   const jobStarted=performance.now(),stage=worker();const jobWall=performance.now()-jobStarted;
   const queue=Number(sql(`SELECT extract(epoch FROM min(e.created_at)-j.created_at)*1000 FROM encrypted_document_jobs j JOIN document_worker_events e ON e.document_id=j.document_id AND e.event='claimed' WHERE j.document_id='${id}' GROUP BY j.created_at;`));
   const t=performance.now(),r=await call('a','/documents/'+id+'/view');expect(r.status()).toBe(200);const v=await r.json();expect(v.format).toBe(trial.files[index].name.endsWith('.xlsx')?'xlsx':'pdf');
   if(v.format==='pdf'){const image=await call('a','/documents/'+id+'/view/pages/1');expect(image.status()).toBe(200);expect(image.headers()['content-type']).toBe('image/png');}
   rows.push({case:trial.name,format:v.format,bytes:trial.files[index].buffer.length,browser_cache:trial.name.includes('cold')?'fresh context / first upload module':'same context / prior upload module',outcome:'ready',timings_ms:{...durations,queue_until_claim:queue,job_startup_processing_stop:jobWall,first_manifest_and_page:performance.now()-t},worker_ms:stage,memory_limits_bytes:{broker:536870912,relay:536870912,sandbox:1073741824},worker_oom:false});
  }
 }
 // Same-size policy rejection is measured separately from successful documents.
 const c=await candidate('S5拒否計測の架空候補者');const id=(await attach(p,c,[{name:'S5不正形式.pdf',mimeType:'application/pdf',buffer:Buffer.alloc(pdf.length,0x61)}]))[0],t=performance.now(),stage=worker(false);
 expect((await call('a','/documents/'+id+'/view')).status()).toBe(404);rows.push({case:'invalid-format-small',format:'pdf',bytes:pdf.length,browser_cache:'same context',outcome:'rejected',timings_ms:{job_startup_processing_stop:performance.now()-t},worker_ms:stage,memory_limits_bytes:{broker:536870912,relay:536870912,sandbox:1073741824},worker_oom:false});
 const metric='admission_wall',success=rows.filter(r=>r.outcome==='ready'&&r.case.startsWith('small-pdf')).map(r=>r.timings_ms[metric]).sort((a,b)=>a-b);
 const percentile=(p:number)=>success[Math.max(0,Math.ceil(p*success.length)-1)];
 fs.writeFileSync(path.join(dir,'artifacts/s5-performance.json'),JSON.stringify({units:'milliseconds unless named bytes',rows,small_pdf_admission:{n:success.length,p50:percentile(.5),p95:percentile(.95),method:'nearest rank; descriptive small sample only'},scope:'Real browser WebCrypto and local authenticated HTTP admission, real AV and fresh isolated parser per job. Every job is a fresh sandbox; browser cold/warm labels only. No TLS/WAN/production load or commercial latency SLA. AV and validation+conversion measured at broker; full host job wall includes startup and stop. Request durations include network and response transfer. Memory fields are configured limits and observed OOM absence, not peak usage.'},null,2)+'\n');
});
