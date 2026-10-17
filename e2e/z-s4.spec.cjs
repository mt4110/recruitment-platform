const {test,expect}=require('@playwright/test');
test.describe.configure({mode:'serial'});
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),c=require('node:crypto');
const {sql,signIn,identity,origin,shot}=require('./helpers.cjs');
const root=path.resolve(__dirname,'..'),dir=process.env.RP_E2E_DIR,source=process.env.RP_INSTANCE,actors={},issues=[];
const legacy=JSON.parse(fs.readFileSync(path.join(dir,'artifacts/legacy-migration.json'))),D=legacy.document_id,A=legacy.application_id;
let before,xlsx,preBackup,postBackup,target;
function host(script,args=[],timeout=360000){return cp.spawnSync('python3',[script,...args],{cwd:root,env:process.env,encoding:'utf8',timeout,maxBuffer:1024*1024});}
function okay(script,args=[]){const r=host(script,args);expect(r.status,r.stdout).toBe(0);return JSON.parse(r.stdout.trim().split('\n').at(-1));}
const call=(who,url,method='GET',data)=>actors[who].context.request.fetch(origin+'/api/v1'+url,{method,headers:{Origin:origin,'X-CSRF-Token':actors[who].me.csrf_token,'Idempotency-Key':c.randomUUID()},...(data===undefined?{}:{data})});
const state=()=>JSON.parse(sql(`SELECT json_build_object('document',to_jsonb(d),'version',(SELECT to_jsonb(v) FROM document_versions v WHERE v.document_id=d.id),'selection',(SELECT jsonb_agg(ad ORDER BY ad.application_id) FROM application_documents ad WHERE ad.document_id=d.id),'snapshot',(SELECT to_jsonb(s) FROM application_snapshots s WHERE s.application_id='${A}'),'receipt',(SELECT jsonb_agg(i ORDER BY i.key) FROM idempotency_records i WHERE i.resource_id=d.id)) FROM documents d WHERE d.id='${D}';`));
async function scanReady(){await expect.poll(()=>host('scripts/local.py',['compose','exec','-T','api','sh','-c','curl --fail --silent --max-time 3 -H "X-Scan-Key: $SCAN_SHARED_KEY" http://scan:8080/internal/scan/state >/dev/null'],15000).status,{timeout:90000,intervals:[1000]}).toBe(0);}
async function assertViews(){
 for(const who of ['a','x']){const u=`/applications/${A}/documents/${D}/view`;expect((await call(who,u)).status()).toBe(200);expect((await call(who,u+'/pages/1')).status()).toBe(200);}
 for(const who of ['b','y'])for(const suffix of ['', '/pages/1'])expect((await call(who,`/applications/${A}/documents/${D}/view`+suffix)).status()).toBe(404);
 expect((await call('x','/documents/'+D+'/view')).status()).toBe(404);
 expect((await call('a','/documents/'+xlsx.id+'/view')).status()).toBe(200);
 expect((await call('x',`/applications/${A}/documents/${xlsx.id}/view`)).status()).toBe(404);
 for(const who of ['a','b','x','y'])expect((await call(who,'/documents/'+D+'/content')).status()).toBe(410);
}
test.beforeAll(async({browser})=>{for(const [who,name] of [['a','agency-a'],['b','agency-b'],['x','employer-x'],['y','employer-y']]){const context=await browser.newContext(),page=await context.newPage();page.on('pageerror',()=>issues.push('PAGE_ERROR'));page.on('console',m=>{if(['error','warning'].includes(m.type())&&!/^Failed to load resource: the server responded with a status of (400|401|403|404|409|413|422|429|503)\b/.test(m.text()))issues.push('CONSOLE_ERROR');});expect((await signIn(page,name)).status()).toBe(303);actors[who]={context,page,me:await identity(context)};}});
test.afterAll(async()=>{for(const a of Object.values(actors))await a.context.close();if(target){process.env.RP_INSTANCE=target;try{const r=host('scripts/local.py',['stop']);expect(r.status).toBe(0);}finally{process.env.RP_INSTANCE=source;}}process.env.RP_INSTANCE=source;expect(issues).toEqual([]);});
test('S4 inventory preserves old PDF/shared selection and rejects unprepared views',async()=>{
 before=state();expect((await call('a','/documents/'+D+'/view')).status()).toBe(404);expect((await call('x',`/applications/${A}/documents/${D}/view`)).status()).toBe(404);
 const cand=await call('a','/candidates','POST',{name:'S4架空候補者',summary:'既存XLSXの暗号化移行',fictional_confirmed:true});expect(cand.status()).toBe(201);const id=(await cand.json()).id;
 const row=sql("SELECT count(*) FROM document_admissions WHERE user_id='10000000-0000-0000-0000-000000000001' AND created_at>now()-interval '1 minute';");if(Number(row)>=8)await new Promise(r=>setTimeout(r,61000));
 const r=await actors.a.context.request.post(origin+`/api/v1/candidates/${id}/documents`,{headers:{Origin:origin,'X-CSRF-Token':actors.a.me.csrf_token,'Idempotency-Key':c.randomUUID()},multipart:{fictional_confirmed:'true',document_kind:'career_history',file:{name:'S4架空職務経歴書.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:fs.readFileSync(path.join(__dirname,'fixtures/sheets-career-history.xlsx'))}}});expect(r.status()).toBe(201);xlsx=await r.json();expect(xlsx.available).toBe(true);
 const r1=okay('scripts/document_migrate.py',['inventory']);expect(r1.legacy).toBeGreaterThanOrEqual(2);
 expect(sql("SELECT has_table_privilege('app_runtime','document_migrations','SELECT') OR has_function_privilege('app_runtime','document_worker_source(uuid)','EXECUTE');")).toBe('f');
});
test('S4 backup crypto preserves large pipe output and rejects tag or context tampering',async()=>{
 const key=path.join(dir,'s4-crypto-test.key');fs.writeFileSync(key,c.randomBytes(32),{flag:'wx',mode:0o600});const raw=c.randomBytes(1024*1024),aad='S4-test-context';
 const cmd=(mode,data,context=aad)=>cp.spawnSync('node',['scripts/document_crypto.cjs',mode,key,context],{cwd:root,input:data,maxBuffer:2*1024*1024});
 const enc=cmd('seal',raw);expect(enc.status).toBe(0);const dec=cmd('open',enc.stdout);expect(dec.status).toBe(0);expect(dec.stdout.equals(raw)).toBe(true);expect(cmd('seal',raw).stdout.equals(enc.stdout)).toBe(false);
 const corrupt=Buffer.from(enc.stdout);corrupt[corrupt.length-1]^=1;for(const [data,ctx] of [[corrupt,aad],[enc.stdout,'wrong-context']]){const r=cmd('open',data,ctx);expect(r.status).toBe(1);expect(r.stdout.length).toBe(0);}
});
test('S4 cold backup authenticates DB original files old keys and AV definitions',async()=>{
 test.setTimeout(360000);preBackup=okay('scripts/document_snapshot.py',['backup']).backup;
 expect(okay('scripts/document_snapshot.py',['verify','--backup',preBackup]).status).toBe('verified');await scanReady();expect(state()).toEqual(before);
 const files=fs.readdirSync(preBackup);expect(files).toContain('manifest.enc');expect(files).toContain('COMPLETE');expect(files.every(f=>f==='COMPLETE'||/^\d{6}\.enc$/.test(f)||f==='manifest.enc')).toBe(true);expect(fs.existsSync(path.join(preBackup,'backup.key'))).toBe(false);
});
test('S4 mapping adds ciphertext without changing original selection',async()=>{
 const args=['apply','--backup',preBackup,'--document',D,'--document',xlsx.id];expect(okay('scripts/document_migrate.py',args).queued_or_ready).toBe(2);
 expect(state()).toEqual(before);expect((await call('a','/documents/'+D+'/view')).status()).toBe(404);
});
test('S4 missing old original key refuses worker and preserves shared denial',async()=>{
 const k=path.join(dir,'upload-private.pem'),mode=fs.statSync(k).mode&0o777;fs.chmodSync(k,0);
 try{expect(host('scripts/document_job.py',['--no-build']).status).toBe(1);expect((await call('x',`/applications/${A}/documents/${D}/view`)).status()).toBe(404);}finally{fs.chmodSync(k,mode);}
});
test('S4 queued migrations resume separately and preserve selected version',async()=>{
 for(let i=0;i<2;i++)expect(okay('scripts/document_job.py',['--no-build']).events).toEqual(['checked']);
 expect(state()).toEqual(before);await assertViews();
});
test('S4 repeated apply remains idempotent after completed migration',async()=>{
 const args=['apply','--backup',preBackup,'--document',D,'--document',xlsx.id];
 expect(okay('scripts/document_migrate.py',args).queued_or_ready).toBe(2);expect(sql(`SELECT count(*) FROM document_migrations WHERE document_id IN ('${D}','${xlsx.id}') AND state='ready';`)).toBe('2');expect(state()).toEqual(before);await assertViews();
});
test('S4 migrated selected version renders with no raw fallback or framework errors',async()=>{
 const p=actors.x.page;await p.goto(origin+'/applications/'+A);expect(new URL(p.url()).pathname).toBe('/applications/'+A);expect(await p.title()).toBeTruthy();await expect(p.getByRole('button',{name:'安全な表示を開く'})).toHaveCount(1);await p.getByRole('button',{name:'安全な表示を開く'}).click();await expect(p.locator('.safe-view img')).toBeVisible();await expect(p.getByRole('heading',{name:'代替テキスト（抽出順）'})).toBeVisible();expect(await p.locator('nextjs-portal').count()).toBe(0);await shot(p,'s4-migrated-selected-version');await p.getByRole('button',{name:'閲覧を閉じる'}).click();await expect(p.locator('.safe-view img')).toHaveCount(0);await p.goto('about:blank');
});
test('S4 current key policy denies migrated views and shares without rewriting snapshots',async()=>{
 for(const purpose of ['original','artifact']){
  expect(host('scripts/document_key.py',[purpose,'revoke']).status).toBe(0);
  try{for(const who of ['a','x'])for(const suffix of ['', '/pages/1'])expect((await call(who,`/applications/${A}/documents/${D}/view`+suffix)).status()).toBe(404);}
  finally{expect(host('scripts/document_key.py',[purpose,'enable']).status).toBe(0);}
 }
 expect(state()).toEqual(before);await assertViews();
});
test('S4 cutover drains old admission and explicitly quarantines unmigrated records',async()=>{
 test.setTimeout(240000);const r=okay('scripts/document_migrate.py',['cutover','--quarantine-unmigrated']);expect(r.cutover).toBe('encrypted_only');await scanReady();
 const r1=await call('a',`/candidates/${legacy.candidate_id}/documents`,'POST',{});expect(r1.status()).toBe(410);expect((await r1.body()).length).toBe(0);expect((await call('a',`/documents/${D}/recheck`,'POST',{})).status()).toBe(410);
 const fresh=await call('a',`/candidates/${legacy.candidate_id}/document-uploads`,'POST',{document_kind:'resume',file_format:'pdf',plain_length:744,fictional_confirmed:true});expect(fresh.status()).toBe(201);
 expect(sql('SELECT legacy_open FROM document_cutover;')).toBe('f');expect(state()).toEqual(before);await assertViews();
});
test('S4 tampered backup refuses authentication before creating a restore target',async()=>{
 const bid=path.basename(preBackup),home=path.join(dir,'tampered'),dest=path.join(home,'backups',bid),keys=path.join(home,'backup-keys');fs.mkdirSync(dest,{recursive:true,mode:0o700});fs.mkdirSync(keys,{recursive:true,mode:0o700});
 for(const f of fs.readdirSync(preBackup))fs.copyFileSync(path.join(preBackup,f),path.join(dest,f),fs.constants.COPYFILE_EXCL);
 fs.copyFileSync(path.join(dir,'backup-keys',bid+'.key'),path.join(keys,bid+'.key'),fs.constants.COPYFILE_EXCL);
 const f=path.join(dest,'000000.enc'),b=fs.readFileSync(f);b[b.length-1]^=1;fs.writeFileSync(f,b);expect(host('scripts/document_snapshot.py',['verify','--backup',dest]).status).toBe(1);
 const bad=source+'-bad';expect(host('scripts/document_snapshot.py',['restore','--backup',dest,'--target',bad]).status).toBe(1);expect(fs.existsSync(path.join(root,'.local',bad))).toBe(false);
});
test('S4 post-cutover snapshot authenticates current policy and old keys',async()=>{
 test.setTimeout(360000);
 for(const purpose of ['original','artifact'])expect(host('scripts/document_key.py',[purpose,'rotate','--version',purpose+'-v8']).status).toBe(0);
 expect(host('scripts/document_key.py',['original','revoke','--version','original-v8']).status).toBe(0);
 await assertViews();postBackup=okay('scripts/document_snapshot.py',['backup']).backup;
});
test('S4 old keys DB encrypted blobs and selected snapshots restore to a new isolated instance',async()=>{
 test.setTimeout(480000);
 const gatewayImage=cp.execFileSync('docker',['inspect','--format','{{.Image}}',`recruitment-${source}-gateway-1`],{env:process.env,encoding:'utf8'}).trim();
 target=source+'-restore';const restored=host('scripts/document_snapshot.py',['restore','--backup',postBackup,'--target',target],420000);expect(restored.status,restored.stdout).toBe(0);
 process.env.RP_INSTANCE=target;await scanReady();expect(state()).toEqual(before);await assertViews();expect(sql(`SELECT wrap_version FROM document_migrations WHERE document_id='${D}';`)).toBe('original-v1');
 expect(cp.execFileSync('docker',['inspect','--format','{{.Image}}',`recruitment-${target}-gateway-1`],{env:process.env,encoding:'utf8'}).trim()).toBe(gatewayImage);
 expect(sql('SELECT legacy_open FROM document_cutover;')).toBe('f');expect(sql("SELECT enabled FROM document_key_versions WHERE purpose='original' AND version='original-v8';")).toBe('f');const restoredDir=path.join(root,'.local',target),oldKey=path.join(restoredDir,'artifact-private.pem'),mode=fs.statSync(oldKey).mode&0o777;expect(fs.existsSync(path.join(restoredDir,'keyring/original-v8.pem'))).toBe(true);
 fs.chmodSync(oldKey,0);try{expect((await call('x',`/applications/${A}/documents/${D}/view`)).status()).toBe(404);}finally{fs.chmodSync(oldKey,mode);}
 await assertViews();
 const cipherStage=sql(`SELECT staging_key FROM document_migrations WHERE document_id='${D}';`);const raw=cp.execFileSync('python3',['scripts/local.py','compose','exec','-T','api','cat','/data/resumes/encrypted/'+cipherStage+'.cipher'],{cwd:root,env:process.env});
 const ctx=JSON.parse(sql(`SELECT document_worker_source('${D}')||jsonb_build_object('document_id','${D}','org_id',org_id) FROM document_migrations WHERE document_id='${D}';`));
 const proof=cp.execFileSync('node',['-e',"const fs=require('fs'),{unwrap,sha}=require('./services/document-worker/crypto.cjs');const j=JSON.parse(process.argv[1]);const b=unwrap(j,fs.readFileSync(0),fs.readFileSync(process.argv[2]));process.stdout.write(sha(b.bytes));",JSON.stringify(ctx),path.join(restoredDir,'upload-private.pem')],{cwd:root,input:raw,encoding:'utf8'});expect(proof).toBe(before.document.sha256);
 const freshContext=await actors.a.context.browser().newContext();try{const page=await freshContext.newPage();expect((await signIn(page,'agency-a')).status()).toBe(303);expect((await identity(freshContext)).user.id).toBe(actors.a.me.user.id);}finally{await freshContext.close();}
 const current=await call('a','/me');expect(current.status()).toBe(200);expect((await current.json()).user.id).toBe(actors.a.me.user.id);
 // Sharing revocation on the restored database is enforced without changing selection.
 const app=await(await call('a','/applications/'+A)).json();const r=await call('a',`/applications/${A}/revoke-sharing`,'POST',{version:app.version,reason:'S4架空の復旧後確認'});expect(r.status()).toBe(200);
 for(const suffix of ['', '/pages/1']){expect((await call('x',`/applications/${A}/documents/${D}/view`+suffix)).status()).toBe(404);expect((await call('a',`/applications/${A}/documents/${D}/view`+suffix)).status()).toBe(200);}
 const inspection=JSON.parse(cp.execFileSync('docker',['inspect',`recruitment-${source}-api-1`],{env:process.env}));expect(inspection[0].State.Running).toBe(false);
 const out={same_document_and_selection:true,old_keys_restored:true,gateway_image_preserved:true,source_retained_stopped:true,target,backup_authenticated:true,access_denials:true,raw_routes_closed:true};fs.writeFileSync(path.join(dir,'artifacts/s4-recovery.json'),JSON.stringify(out,null,2)+'\n');
 const secrets=Object.values(JSON.parse(fs.readFileSync(path.join(dir,'demo-accounts.json'))));secrets.push(...fs.readFileSync(path.join(dir,'local.env'),'utf8').split('\n').filter(l=>l.includes('=')).map(l=>l.slice(l.indexOf('=')+1)).filter(v=>v.length>=24));
 out.restored_log_secret_pattern_found=false;const services=['gateway','web','api','db','idp','idp-db','pdf-renderer','invoice-renderer','artifact-viewer','scan','updater'];
 for(const svc of services){const logs=cp.execFileSync('docker',['logs',`recruitment-${target}-${svc}-1`],{env:process.env,stdio:['ignore','pipe','pipe']}).toString();if(secrets.some(v=>logs.includes(v))||/-----BEGIN .*PRIVATE KEY-----|rp_session=|rp_attempt=|(?:[?&](?:code|access_token|id_token)=)/.test(logs))out.restored_log_secret_pattern_found=true;}expect(out.restored_log_secret_pattern_found).toBe(false);
 // The main harness still inspects the source scanner/runtime at completion.
 expect(host('scripts/local.py',['stop']).status).toBe(0);out.restored_services_stopped=services.every(svc=>JSON.parse(cp.execFileSync('docker',['inspect','--format','{{json .State}}',`recruitment-${target}-${svc}-1`],{env:process.env})).Running===false);expect(out.restored_services_stopped).toBe(true);fs.writeFileSync(path.join(dir,'artifacts/s4-recovery.json'),JSON.stringify(out,null,2)+'\n');process.env.RP_INSTANCE=source;
 expect(host('scripts/local.py',['compose','up','-d','--no-build','--wait','--wait-timeout','180']).status).toBe(0);await scanReady();
});
