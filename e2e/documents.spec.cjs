const {test,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const {sql,signIn,identity,origin,shot}=require('./helpers.cjs');
async function complete(id){const r=await api('a','POST',`/documents/${id}/retry`);expect(r.status()).toBe(200);return r.json();}
const A='00000000-0000-0000-0000-000000000001',B='00000000-0000-0000-0000-000000000002',X='00000000-0000-0000-0000-000000000011';
const user=o=>'10000000'+o.slice(8),dir=process.env.RP_E2E_DIR;
const fixture=n=>fs.readFileSync(path.join(dir,'pdf-fixtures',n));
const scope=o=>`BEGIN;SET LOCAL ROLE app_runtime;SELECT set_config('app.user_id','${user(o)}',true),set_config('app.org_id','${o}',true);`;
const actors={};let errors=[];
function compose(...args){const r=cp.spawnSync('python3',['scripts/local.py','compose',...args],{cwd:root,env:process.env,encoding:'utf8'});if(r.status!==0)throw Error('COMPOSE_CONTROL_FAILED:'+args[0]);return r.stdout;}

async function api(who,method,url,data){return actors[who].context.request.fetch(origin+'/api/v1'+url,{method,headers:{Origin:origin,'X-CSRF-Token':actors[who].me.csrf_token,'Idempotency-Key':crypto.randomUUID()},...(data===undefined?{}:{data})});}
async function candidate(){const r=await api('a','POST','/candidates',{name:'架空PDF候補者',summary:'架空の経歴・検証専用',fictional_confirmed:true});expect(r.status()).toBe(201);return (await r.json()).id;}
async function upload(id,name='static.pdf',key=crypto.randomUUID(),who='a',extra={}){sql("UPDATE document_admissions SET created_at=now()-interval '2 minutes' WHERE created_at>now()-interval '1 minute';");return actors[who].context.request.post(origin+`/api/v1/candidates/${id}/documents`,{headers:{Origin:origin,'X-CSRF-Token':actors[who].me.csrf_token,'Idempotency-Key':key,...extra},multipart:{fictional_confirmed:'true',document_kind:'other',file:{name,mimeType:'application/pdf',buffer:fixture(name)}}});}
async function expire(id){sql(`UPDATE idempotency_records SET lease_expires_at=now()-interval '1 second' WHERE resource_id='${id}' AND state='processing';`);}
async function ready(){await expect.poll(async()=>{try{return (await actors.a.context.request.get(origin+'/ready')).status();}catch{return 0;}},{timeout:60000}).toBe(200);}
async function pendingUpload(id,key){compose('pause','pdf-renderer');try{const r=await upload(id,'static.pdf',key);expect(r.status()).toBe(503);}finally{compose('unpause','pdf-renderer');}const d=sql(`SELECT id FROM documents WHERE candidate_id='${id}' ORDER BY created_at DESC LIMIT 1;`);sql(`UPDATE idempotency_records SET lease_expires_at=now()+interval '120 seconds' WHERE resource_id='${d}' AND state='processing';`);return d;}
test.beforeAll(async({browser})=>{for(const [who,name]of Object.entries({a:'agency-a',b:'agency-b',x:'employer-x'})){const context=await browser.newContext();const page=await context.newPage();page.on('pageerror',()=>errors.push('PAGE_ERROR'));page.on('console',m=>{if(['error','warning'].includes(m.type())&&!/^Failed to load resource: the server responded with a status of (400|401|403|404|409|413|422|429|503)\b/.test(m.text()))errors.push('CONSOLE_ERROR:'+new(require('./reporter.cjs'))().scrub(m.text()).slice(0,300));});expect((await signIn(page,name)).status()).toBe(303);actors[who]={context,page,me:await identity(context)};}});
test.afterAll(async()=>{for(const a of Object.values(actors))await a.context.close();expect(errors).toEqual([]);});

test('M3 static and tagged PDFs pass; all forbidden policy fixtures fail closed',async()=>{
 const id=await candidate(),manifest=JSON.parse(fixture('manifest.json'));
 for(const name of manifest.expected_accept){const r=await upload(id,name);expect(r.status(),name).toBe(201);const d=await r.json();expect(d.status).toBe('ready');expect(d.available).toBe(true);await complete(d.id);expect(JSON.stringify(d)).not.toMatch(/storage_key|staging_key|sha256/);const raw=await api('a','GET',`/documents/${d.id}/content`);expect(raw.status()).toBe(200);expect(await raw.body()).toEqual(fixture(name));expect(raw.headers()['content-disposition']).toContain('attachment');expect(raw.headers()['cache-control']).toContain('no-store');expect(raw.headers()['x-content-type-options']).toBe('nosniff');}
 for(const name of manifest.expected_reject){const key=crypto.randomUUID(),r=await upload(id,name,key);expect(r.status(),name).toBe(name==='too-large.pdf'?413:422);if(name!=='too-large.pdf'){const first=await r.json();expect(first.error.document_id).toMatch(/^[0-9a-f-]{36}$/);expect(sql(`SELECT count(*) FROM audit_events WHERE resource_id='${first.error.document_id}' AND request_id='${first.error.request_id}' AND result='failed';`)).toBe('1');const again=await upload(id,name,key);expect(again.status()).toBe(422);const replay=await again.json();expect(replay.error.code).toBe(first.error.code);expect(replay.error.document_id).toBe(first.error.document_id);}}
 const all=await (await api('a','GET','/candidates/'+id)).json();expect(all.documents.filter(d=>d.status==='rejected')).toHaveLength(manifest.expected_reject.length-1);
 for(const d of all.documents.filter(d=>d.status==='rejected'))expect((await api('a','GET',`/documents/${d.id}/content`)).status()).toBe(404);
});
test('M3 authentication CSRF input limits and original document RLS deny foreign access',async({request})=>{
 const id=await candidate(),r=await upload(id),d=await r.json();expect(r.status()).toBe(201);
 for(const suffix of ['', '/content']){expect((await request.get(origin+`/api/v1/documents/${d.id}${suffix}`)).status()).toBe(401);for(const who of ['b','x'])expect((await api(who,'GET',`/documents/${d.id}${suffix}`)).status()).toBe(404);}
 for(const who of ['b','x']){expect((await upload(id,'static.pdf',undefined,who)).status()).toBe(404);expect((await api(who,'POST',`/documents/${d.id}/retry`)).status()).toBe(404);}
 expect((await upload(id,'static.pdf',undefined,'a',{'X-CSRF-Token':'invalid'})).status()).toBe(403);
 expect((await upload(id,'static.pdf',undefined,'a',{Origin:'http://example.invalid'})).status()).toBe(403);
 expect((await upload(id,'static.pdf',undefined,'a',{'Idempotency-Key':'bad'})).status()).toBe(422);
 const headers={Origin:origin,'X-CSRF-Token':actors.a.me.csrf_token,'Idempotency-Key':crypto.randomUUID()};
 for(const multipart of [{file:{name:'r.pdf',mimeType:'application/pdf',buffer:fixture('static.pdf')}},{fictional_confirmed:'false',file:{name:'r.pdf',mimeType:'application/pdf',buffer:fixture('static.pdf')}},{fictional_confirmed:'true',file:{name:'r.pdf',mimeType:'text/plain',buffer:fixture('static.pdf')}}])expect((await actors.a.context.request.post(origin+`/api/v1/candidates/${id}/documents`,{headers,multipart})).status()).toBe(422);
 expect(sql("BEGIN;SET LOCAL ROLE app_runtime;SELECT count(*) FROM documents;ROLLBACK;").split('\n').filter(x=>/^\d+$/.test(x))).toEqual(['0']);
 for(const org of [B,X])expect(sql(scope(org)+`SELECT count(*) FROM documents WHERE id='${d.id}';ROLLBACK;`).split('\n').filter(x=>/^\d+$/.test(x))).toEqual(['0']);
 expect(sql("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE relname='documents';")).toBe('t');
 expect(sql("SELECT has_table_privilege('app_auth','documents','SELECT'),has_table_privilege('app_runtime','documents','DELETE'),has_column_privilege('app_runtime','documents','storage_key','UPDATE');")).toBe('f|f|f');
 expect(()=>sql(scope(A)+`UPDATE documents SET status='ready' WHERE id='${d.id}';ROLLBACK;`)).toThrow('DB_CONTROL_FAILED:23514');
});
test('M3 duplicate uploads share one reservation and replay after candidate archive',async()=>{
 const id=await candidate(),key=crypto.randomUUID();const results=await Promise.all([upload(id,'static.pdf',key),upload(id,'static.pdf',key)]);expect(results.map(r=>r.status()).every(s=>[201,202].includes(s))).toBe(true);const docs=await Promise.all(results.map(r=>r.json()));expect(docs[0].id).toBe(docs[1].id);expect(sql(`SELECT count(*) FROM documents WHERE candidate_id='${id}';`)).toBe('1');
 expect((await upload(id,'tagged.pdf',key)).status()).toBe(409);await complete(docs[0].id);expect((await api('a','POST',`/candidates/${id}/archive`,{version:1})).status()).toBe(200);
 expect((await upload(id,'static.pdf',key)).status()).toBe(201);expect((await upload(id)).status()).toBe(409);expect((await api('a','GET',`/documents/${docs[0].id}/content`)).status()).toBe(200);
});
test('M3 live lease is 202 and expired pending survives actual API restart',async()=>{
 const id=await candidate(),key=crypto.randomUUID(),document=await pendingUpload(id,key);
 expect((await api('a','POST',`/documents/${document}/retry`)).status()).toBe(202);expect((await upload(id,'static.pdf',key)).status()).toBe(202);
 compose('restart','api');await ready();await expire(document);
 const retries=await Promise.all([api('a','POST',`/documents/${document}/retry`),api('a','POST',`/documents/${document}/retry`)]);expect(retries.every(r=>[200,202,503].includes(r.status()))).toBe(true);expect(retries.some(r=>[200,202].includes(r.status()))).toBe(true);await complete(document);
 const d=await (await api('a','GET',`/documents/${document}`)).json();expect(d.status).toBe('ready');expect((await upload(id,'static.pdf',key)).status()).toBe(201);expect(sql(`SELECT count(*) FROM documents WHERE candidate_id='${id}';`)).toBe('1');
});
test('M3 recovery checks existing final bytes and refuses wrong hash without replacement',async()=>{
 const id=await candidate(),key=crypto.randomUUID(),document=await pendingUpload(id,key);
 const [staging,final]=sql(`SELECT staging_key||'|'||storage_key FROM documents WHERE id='${document}';`).split('|');
 // Only create a new link; no overwrite or deletion of saved bytes.
 compose('exec','-T','api','ln','/data/resumes/'+staging,'/data/resumes/'+final);
 sql(`UPDATE documents SET validation_policy='static-resume-v1',validated_at=now() WHERE id='${document}';`);await expire(document);
 expect((await api('a','POST',`/documents/${document}/retry`)).status()).toBe(200);await complete(document);
 const wrong=crypto.randomUUID(),wrongStage=crypto.randomUUID()+'.part',wrongFinal=wrong+'.pdf',wrongKey=crypto.randomUUID();
 const write=cp.spawnSync('python3',['scripts/local.py','compose','exec','-T','api','sh','-c',`set -C; cat > /data/resumes/${wrongStage}`],{cwd:root,env:process.env,input:fixture('static.pdf')});expect(write.status).toBe(0);
 sql(scope(A)+`INSERT INTO documents(id,agency_org_id,candidate_id,created_by,storage_key,staging_key,original_name,size_bytes,sha256,status) VALUES('${wrong}','${A}','${id}','${user(A)}','${wrongFinal}','${wrongStage}','架空.pdf',${fixture('static.pdf').length},'${'0'.repeat(64)}','pending'); INSERT INTO idempotency_records(org_id,user_id,http_method,normalized_path,key,request_hash,resource_id,state,lease_token,lease_expires_at) VALUES('${A}','${user(A)}','POST','/api/v1/candidates/${id}/documents','${wrongKey}',decode('${'0'.repeat(64)}','hex'),'${wrong}','processing','${crypto.randomUUID()}',now()-interval '1 second');COMMIT;`);
 const response=await api('a','POST',`/documents/${wrong}/retry`);expect(response.status()).toBe(503);expect((await response.json()).error.code).toBe('STORAGE_CONFLICT');expect(sql(`SELECT status FROM documents WHERE id='${wrong}';`)).toBe('pending');
});
test('M3 obsolete lease cannot finalize and archive wins candidate document lock order',async()=>{
 const id=await candidate(),key=crypto.randomUUID();compose('pause','pdf-renderer');const waiting=upload(id,'static.pdf',key);
 let document;try{await expect.poll(()=>{document=sql(`SELECT id FROM documents WHERE candidate_id='${id}';`);return !!document;}).toBe(true);
  const old=sql(`SELECT lease_token FROM idempotency_records WHERE resource_id='${document}';`);sql(`UPDATE idempotency_records SET lease_token='${crypto.randomUUID()}' WHERE resource_id='${document}';`);compose('unpause','pdf-renderer');expect((await waiting).status()).toBe(503);expect(sql(`SELECT status FROM documents WHERE id='${document}';`)).toBe('pending');expect(sql(`SELECT lease_token<>'${old}' FROM idempotency_records WHERE resource_id='${document}';`)).toBe('t');
 }finally{// Unpause is idempotently guarded by the finally path.
  cp.spawnSync('python3',['scripts/local.py','compose','unpause','pdf-renderer'],{cwd:root,env:process.env,stdio:'ignore'});await waiting.catch(()=>{});}
 await expire(document);expect((await api('a','POST',`/candidates/${id}/archive`,{version:1})).status()).toBe(200);const r=await api('a','POST',`/documents/${document}/retry`);expect(r.status()).toBe(409);expect((await r.json()).error.code).toBe('CANDIDATE_ARCHIVED');expect((await api('a','GET',`/documents/${document}/content`)).status()).toBe(404);expect((await upload(id,'static.pdf',key)).status()).toBe(409);
});
test('M3 browser upload download rejection and expired pending recovery work on desktop and mobile',async()=>{
 const id=await candidate(),page=actors.a.page;await page.goto(origin+'/candidates/'+id);await expect(page).toHaveTitle(/recruitment-platform/);
 await expect(page.getByLabel('PDF／XLSXファイル',{exact:true})).toBeEnabled();if(await page.getByLabel('暗号化受付を使う（検査・閲覧はS2以降）').isEnabled())await page.getByLabel('暗号化受付を使う（検査・閲覧はS2以降）').uncheck();await page.getByLabel('PDF／XLSXファイル',{exact:true}).setInputFiles({name:'架空レジュメ.pdf',mimeType:'application/pdf',buffer:fixture('static.pdf')});await page.getByLabel('書類の内容はすべて架空の情報です').check();await page.getByRole('button',{name:'書類を登録する',exact:true}).click();await expect(page.getByText('書類を登録しました。',{exact:true})).toBeVisible();expect(await page.getByRole('link',{name:'PDFをダウンロード'}).count()).toBe(1);const accepted=sql(`SELECT id FROM documents WHERE candidate_id='${id}';`);await complete(accepted);await page.reload();await expect(page.getByRole('link',{name:'PDFをダウンロード'})).toBeVisible();
 const downloadPromise=page.waitForEvent('download');await page.getByRole('link',{name:'PDFをダウンロード'}).click();const download=await downloadPromise;expect(download.suggestedFilename()).toBe('resume.pdf');await shot(page,'arm64-m3-document-desktop');
 await expect(page.getByLabel('PDF／XLSXファイル',{exact:true})).toBeEnabled();if(await page.getByLabel('暗号化受付を使う（検査・閲覧はS2以降）').isEnabled())await page.getByLabel('暗号化受付を使う（検査・閲覧はS2以降）').uncheck();await page.getByLabel('PDF／XLSXファイル',{exact:true}).setInputFiles({name:'broken.pdf',mimeType:'application/pdf',buffer:fixture('broken.pdf')});await page.getByLabel('書類の内容はすべて架空の情報です').check();await page.getByRole('button',{name:'書類を登録する',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'静的なPDFだけ登録できます'})).toBeVisible();
 const pending=await pendingUpload(id,crypto.randomUUID());await expire(pending);await page.reload();await expect(page.getByRole('button',{name:'処理を再試行する'})).toBeVisible();await page.getByRole('button',{name:'処理を再試行する'}).click();await expect(page.getByText('書類を登録しました。',{exact:true})).toBeVisible();await complete(pending);await page.reload();await expect(page.getByRole('link',{name:'PDFをダウンロード'})).toHaveCount(2);
 await page.setViewportSize({width:390,height:844});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(page.getByLabel('PDF／XLSXファイル',{exact:true})).toBeEnabled();await page.getByLabel('PDF／XLSXファイル',{exact:true}).focus();await expect(page.getByLabel('PDF／XLSXファイル',{exact:true})).toBeFocused();await shot(page,'arm64-m3-document-mobile');
 await actors.b.page.goto(origin+'/candidates/'+id);await expect(actors.b.page.locator('.workspace').getByRole('alert')).toContainText('閲覧できません');await page.setViewportSize({width:1280,height:900});
});

test('M3 kill during inspection preserves the same document and missing storage rejects safely',async()=>{
 const id=await candidate(),key=crypto.randomUUID();compose('pause','pdf-renderer');
 const interrupted=upload(id,'static.pdf',key).catch(()=>null);let document;
 try{await expect.poll(()=>{document=sql(`SELECT id FROM documents WHERE candidate_id='${id}';`);return !!document;}).toBe(true);compose('kill','-s','SIGKILL','api');await interrupted;}
 finally{cp.spawnSync('python3',['scripts/local.py','compose','unpause','pdf-renderer'],{cwd:root,env:process.env,stdio:'ignore'});compose('up','-d','--no-deps','api');await ready();}
 await expire(document);const r=await api('a','POST',`/documents/${document}/retry`);expect(r.status()).toBe(200);expect((await r.json()).id).toBe(document);await complete(document);expect((await upload(id,'static.pdf',key)).status()).toBe(201);
 const missing=crypto.randomUUID();sql(scope(A)+`INSERT INTO documents(id,agency_org_id,candidate_id,created_by,storage_key,staging_key,original_name,size_bytes,sha256,status) VALUES('${missing}','${A}','${id}','${user(A)}','${missing}.pdf','${crypto.randomUUID()}.part','架空.pdf',10,'${'0'.repeat(64)}','pending');INSERT INTO idempotency_records(org_id,user_id,http_method,normalized_path,key,request_hash,resource_id,state,lease_token,lease_expires_at) VALUES('${A}','${user(A)}','POST','/api/v1/candidates/${id}/documents','${crypto.randomUUID()}',decode('${'0'.repeat(64)}','hex'),'${missing}','processing','${crypto.randomUUID()}',now()-interval '1 second');COMMIT;`);
 const absent=await api('a','POST',`/documents/${missing}/retry`);expect(absent.status()).toBe(422);expect((await absent.json()).error.code).toBe('UPLOAD_INTERRUPTED');expect((await api('a','POST',`/documents/${missing}/retry`)).status()).toBe(409);expect((await api('a','GET',`/documents/${missing}/content`)).status()).toBe(404);
});

test('M3 actual PDF service isolation internal authentication and concurrency bounds',async()=>{
 const code=`import os,json,socket,http.client,time,subprocess,sys,pikepdf,importlib.metadata as m
raw=bytes.fromhex('${fixture('static.pdf').toString('hex')}')
headers={'X-PDF-Key':os.environ['PDF_SHARED_KEY'],'Content-Type':'application/pdf','Content-Length':str(len(raw))}
a=http.client.HTTPConnection('127.0.0.1',8080,timeout=8);a.request('POST','/internal/pdf/check',raw,{'Content-Type':'application/pdf'});unauth=a.getresponse();unauth.read()
b=http.client.HTTPConnection('127.0.0.1',8080,timeout=8);b.putrequest('POST','/internal/pdf/check')
for k,v in headers.items():b.putheader(k,v)
b.endheaders();b.send(raw[:1]);time.sleep(0.2)
c=http.client.HTTPConnection('127.0.0.1',8080,timeout=8);c.request('POST','/internal/pdf/check',raw,headers);busy=c.getresponse();busy.read();b.send(raw[1:]);valid=b.getresponse();result=json.loads(valid.read())
worker=subprocess.Popen([sys.executable,'/app/validator.py'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env={'PATH':'/usr/local/bin:/usr/bin','PYTHONDONTWRITEBYTECODE':'1'})
for _ in range(100):
    limits=open('/proc/'+str(worker.pid)+'/limits').read()
    if '268435456' in limits and any(line.startswith('Max cpu time') and line.split()[3:5]==['5','5'] for line in limits.splitlines()):break
    time.sleep(0.01)
worker_env=open('/proc/'+str(worker.pid)+'/environ','rb').read()
worker_result=json.loads(worker.communicate(raw,timeout=5)[0])
status=open('/proc/1/status').read()
try:socket.create_connection(('1.1.1.1',443),timeout=0.5);egress=True
except OSError:egress=False
checks={'worker_memory_limit':any(line.startswith('Max address space') and line.split()[3:5]==['268435456','268435456'] for line in limits.splitlines()),'worker_cpu_limit':any(line.startswith('Max cpu time') and line.split()[3:5]==['5','5'] for line in limits.splitlines()),'worker_sanitized_environment':b'PDF_SHARED_KEY=' not in worker_env,'worker_accepted':worker_result['accepted'],'non_root':os.getuid()!=0,'no_capabilities':'CapEff:\\t0000000000000000' in status,'seccomp':'Seccomp:\\t2' in status,'read_only_root':not os.access('/app',os.W_OK),'no_storage_mount':not os.path.exists('/data/resumes'),'no_db_environment':not any('DB_PASSWORD' in k for k in os.environ),'no_egress':not egress,'internal_auth_required':unauth.status==403,'concurrency_one':busy.status==503,'valid_worker_response':valid.status==200 and result['ok']}
print(json.dumps({'checks':checks,'versions':{n:m.version(n) for n in ['pikepdf','pillow','lxml','packaging']},'libqpdf':pikepdf.__libqpdf_version__}))`;
 const evidence=JSON.parse(compose('exec','-T','pdf-renderer','python','-c',code));expect(Object.values(evidence.checks).every(Boolean)).toBe(true);fs.writeFileSync(path.join(dir,'artifacts','pdf-isolation.json'),JSON.stringify(evidence,null,2));
});
