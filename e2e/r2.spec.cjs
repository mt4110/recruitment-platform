const {test,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const {sql,signIn,identity,origin}=require('./helpers.cjs');
const dir=process.env.RP_E2E_DIR,root=path.resolve(__dirname,'..');
const pdf=fs.readFileSync(path.join(root,'apps/web/public/sample-resume.pdf'));
const xlsx=fs.readFileSync(path.join(__dirname,'fixtures/sheets-resume.xlsx'));
const eicar=Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
let context,page,me;
function compose(...args){return cp.execFileSync('python3',['scripts/local.py','compose',...args],{cwd:root,env:process.env,encoding:'utf8'});}
function control(code){return compose('exec','-T','updater','python3','-c',code);}
function ageWindow(){sql("UPDATE document_admissions SET created_at=now()-interval '2 minutes' WHERE created_at>now()-interval '1 minute';");}
function state(){return JSON.parse(compose('exec','-T','api','sh','-c','curl --fail --silent -H "X-Scan-Key: $SCAN_SHARED_KEY" http://scan:8080/internal/scan/state'));}
async function ready(){let stable=0;await expect.poll(()=>{try{if(state().update_ok)return ++stable;stable=0;return 0}catch{stable=0;return 0}},{timeout:100000,intervals:[500]}).toBe(3);}
async function api(method,url,data,key=crypto.randomUUID()){return context.request.fetch(origin+'/api/v1'+url,{method,headers:{Origin:origin,'X-CSRF-Token':me.csrf_token,'Idempotency-Key':key},...(data===undefined?{}:{data})});}
async function candidate(){const r=await api('POST','/candidates',{name:'R2架空候補者',summary:'実AV境界確認',fictional_confirmed:true});expect(r.status()).toBe(201);return(await r.json()).id;}
async function upload(c,buffer=pdf,name='架空.pdf'){return context.request.post(origin+`/api/v1/candidates/${c}/documents`,{headers:{Origin:origin,'X-CSRF-Token':me.csrf_token,'Idempotency-Key':crypto.randomUUID()},multipart:{fictional_confirmed:'true',document_kind:'resume',file:{name,mimeType:name.endsWith('.xlsx')?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'application/pdf',buffer}}});}
async function fault(change,work){
 control("from pathlib import Path; p=Path('/tmp/r2-published-backup.json'); p.write_bytes(Path('/signatures/published.json').read_bytes())");
 try{control("import sys;sys.path.insert(0,'/app');from common import *;m=read_manifest();"+change+";publish(m)");await work();}
 finally{control("import json;from pathlib import Path;from common import publish;publish(json.loads(Path('/tmp/r2-published-backup.json').read_text()))");await ready();}
}
test.beforeAll(async({browser})=>{context=await browser.newContext();page=await context.newPage();expect((await signIn(page)).status()).toBe(303);me=await identity(context);await ready();});
test.beforeEach(()=>ageWindow());
test.afterAll(async()=>{await context?.close();});
test('R2 actual ClamAV scans PDF and native Sheets XLSX; response is hash and generation bound',async()=>{
 const c=await candidate(),m=state();
 for(const [buffer,name] of [[pdf,'架空.pdf'],[xlsx,'架空.xlsx']]){
  const r=await upload(c,buffer,name);expect(r.status()).toBe(201);const d=await r.json();expect(d.available).toBe(true);
  expect(sql(`SELECT engine_version,signature_version,generation_id,sha256 FROM document_checks WHERE document_id='${d.id}';`)).toBe(`1.5.4|${m.databases.daily.version}|${m.generation_id}|${crypto.createHash('sha256').update(buffer).digest('hex')}`);
  expect((await api('GET',`/documents/${d.id}/content`)).status()).toBe(410);
 }
 fs.writeFileSync(path.join(dir,'artifacts/r2-av.json'),JSON.stringify({real_engine:'1.5.4',generation_id:m.generation_id,databases:m.databases,last_successful_check:m.last_successful_check,transport:'authenticated HTTP to private Unix INSTREAM'}));
});
test('R2 real EICAR is blocked before format inspection and cannot download or recheck',async()=>{
 const c=await candidate(),r=await upload(c,eicar);expect(r.status()).toBe(422);const v=await r.json();expect(v.error.code).toBe('MALWARE_DETECTED');const id=v.error.document_id;
 expect((await api('GET',`/documents/${id}/content`)).status()).toBe(410);expect((await api('POST',`/documents/${id}/recheck`)).status()).toBe(409);
 expect(sql(`SELECT verdict,engine_version FROM document_checks WHERE document_id='${id}';`)).toBe('blocked|1.5.4');expect(sql(`SELECT validated_at IS NULL FROM documents WHERE id='${id}';`)).toBe('t');
});
test('R2 stale definitions and failed update reject new clean, preserve pending, recover with retry',async()=>{
 const c=await candidate();
 for(const change of ["m['last_successful_check']-=86401","m['update_ok']=False"]){
 let id;
 await fault(change,async()=>{const r=await upload(c);expect(r.status()).toBe(503);const v=await r.json();expect(v.error.code).toBe('SCANNER_UNAVAILABLE');id=v.error.document_id;expect((await api('GET',`/documents/${id}/content`)).status()).toBe(410);expect(sql(`SELECT count(*) FROM document_checks WHERE document_id='${id}';`)).toBe('0');});
 const r=await api('POST',`/documents/${id}/retry`);expect(r.status()).toBe(200);expect((await r.json()).available).toBe(true);
 }
});
test('R2 published-loaded generation or hash mismatch refuses scans, then reloads verified generation',async()=>{
 const c=await candidate();
 for(const change of ["m['generation_id']=str(uuid.uuid4())","m['databases']['daily']['sha256']='0'*64"]){
 await fault(change,async()=>{const r=await upload(c);expect(r.status()).toBe(503);const id=(await r.json()).error.document_id;expect((await api('GET',`/documents/${id}/content`)).status()).toBe(410);expect(sql(`SELECT count(*) FROM document_checks WHERE document_id='${id}';`)).toBe('0');});
 }
});
test('R2 already clean remains available during scanner outage; original and shared permissions remain scoped',async()=>{
 const c=await candidate(),r=await upload(c),d=await r.json();expect(r.status()).toBe(201);
 compose('pause','scan');try{expect((await api('GET',`/documents/${d.id}/content`)).status()).toBe(410);const r=await upload(c);expect(r.status()).toBe(503);const id=(await r.json()).error.document_id;expect((await api('GET',`/documents/${id}/content`)).status()).toBe(410);}finally{compose('unpause','scan');await ready();}
});
test('R2 limits reject rate and storage admission with no new document or bytes reservation',async()=>{
 const c=await candidate(),o=me.organization.id,u=me.user.id;
 sql(`INSERT INTO document_admissions(id,org_id,user_id,reserved_bytes) SELECT gen_random_uuid(),'${o}','${u}',0 FROM generate_series(1,10);`);
 let r=await upload(c);expect(r.status()).toBe(429);expect(r.headers()['retry-after']).toBe('60');ageWindow();
 // Charge retained test reservations; never create a large real personal file.
 const ids=sql(`INSERT INTO document_admissions(id,org_id,user_id,reserved_bytes,created_at) SELECT gen_random_uuid(),'${o}','${u}',10551296,now()-interval '2 minutes' FROM generate_series(1,51) RETURNING id;`).split('\n').filter(v=>/^[0-9a-f-]{36}$/.test(v));
 try{r=await upload(c);expect(r.status()).toBe(413);expect((await r.json()).error.code).toBe('STORAGE_QUOTA_EXCEEDED');expect(sql(`SELECT count(*) FROM documents WHERE candidate_id='${c}';`)).toBe('0');}
 finally{sql(`UPDATE document_admissions SET reserved_bytes=0 WHERE id IN (${ids.map(v=>`'${v}'`).join(',')});`);}
});
test('R2 verified generation directory reload and same-generation check refresh use actual clamd',async()=>{
 const before=state();
 await fault("import shutil;generation=str(uuid.uuid4());target=ROOT/generation;shutil.copytree(ROOT/m['generation_id'],target);m['generation_id']=generation",async()=>{
  await ready();const current=state();expect(current.generation_id).not.toBe(before.generation_id);expect(current.databases).toEqual(before.databases);
  const c=await candidate(),r=await upload(c);expect(r.status()).toBe(201);const d=await r.json();expect(sql(`SELECT generation_id FROM document_checks WHERE document_id='${d.id}';`)).toBe(current.generation_id);
 });
 const restored=state();await fault("m['last_successful_check']+=1",async()=>{await ready();expect(state().generation_id).toBe(restored.generation_id);});
});
test('R2 stopped scan worker times out without a clean record and is replaced before retry',async()=>{
 const c=await candidate();
 const pid=compose('exec','-T','scan','python3','-c',"from pathlib import Path;print(next(p.name for p in Path('/proc').iterdir() if p.name.isdigit() and (p/'comm').read_text().strip()=='clamd'))").trim();
 compose('exec','-T','scan','python3','-c',`import os,signal;os.kill(${Number(pid)},signal.SIGSTOP)`);
 // A real hung process exercises INSTREAM socket timeout and forced worker recovery.
 const r=await upload(c);expect(r.status()).toBe(503);const id=(await r.json()).error.document_id;expect(sql(`SELECT count(*) FROM document_checks WHERE document_id='${id}';`)).toBe('0');expect((await api('GET',`/documents/${id}/content`)).status()).toBe(410);
 await ready();const next=compose('exec','-T','scan','python3','-c',"from pathlib import Path;print(next(p.name for p in Path('/proc').iterdir() if p.name.isdigit() and (p/'comm').read_text().strip()=='clamd'))").trim();expect(next).not.toBe(pid);
 const retry=await api('POST',`/documents/${id}/retry`);expect(retry.status()).toBe(200);expect((await retry.json()).available).toBe(true);
});
test('R2 internal service rejects unauthenticated, arbitrary-path and oversized requests; scanner cannot egress',async()=>{
 const result=JSON.parse(compose('exec','-T','scan','python3','-c',`
import json,os,socket,urllib.request,urllib.error,uuid,http.client
results=[]
for path,key,data in [('/internal/scan','invalid',b'x'),('/internal/scan/arbitrary',os.environ['SCAN_SHARED_KEY'],b'x')]:
 r=urllib.request.Request('http://127.0.0.1:8080'+path,data=data,headers={'X-Scan-Key':key,'X-Scan-Nonce':str(uuid.uuid4())})
 try:results.append(urllib.request.urlopen(r,timeout=3).status)
 except urllib.error.HTTPError as e:results.append(e.code)
c=http.client.HTTPConnection('127.0.0.1',8080,timeout=3);c.putrequest('POST','/internal/scan');c.putheader('X-Scan-Key',os.environ['SCAN_SHARED_KEY']);c.putheader('X-Scan-Nonce',str(uuid.uuid4()));c.putheader('Content-Length',str(10*1024*1024+1));c.endheaders();results.append(c.getresponse().status);c.close()
try:
 s=socket.create_connection(('1.1.1.1',443),timeout=1);s.close();results.append('egress')
except OSError:results.append('no_egress')
print(json.dumps(results))
`));expect(result).toEqual([403,404,413,'no_egress']);
});
test('R2 definition change after AV and before format completion cannot persist a clean result',async()=>{
 const c=await candidate();compose('pause','pdf-renderer');
 const pending=upload(c);let id;
 try{
  await expect.poll(()=>{id=sql(`SELECT id FROM documents WHERE candidate_id='${c}';`);return !!id;}).toBe(true);
  await new Promise(resolve=>setTimeout(resolve,1000));
  await fault("import shutil;generation=str(uuid.uuid4());shutil.copytree(ROOT/m['generation_id'],ROOT/generation);m['generation_id']=generation",async()=>{
   compose('unpause','pdf-renderer');const r=await pending;expect(r.status()).toBe(503);expect(sql(`SELECT count(*) FROM document_checks WHERE document_id='${id}';`)).toBe('0');expect((await api('GET',`/documents/${id}/content`)).status()).toBe(410);
  });
 }finally{cp.spawnSync('python3',['scripts/local.py','compose','unpause','pdf-renderer'],{cwd:root,env:process.env,stdio:'ignore'});}
 const retry=await api('POST',`/documents/${id}/retry`);expect(retry.status()).toBe(200);expect((await retry.json()).available).toBe(true);
});
test('R2 startup charges retained files outside the old ledger and preserves their bytes',async()=>{
 const before=Number(sql('SELECT orphan_bytes FROM document_storage_baseline;')),id=crypto.randomUUID();
 compose('exec','-T','api','sh','-c',`set -C; head -c 4096 /dev/zero > /data/resumes/${id}.part`);
 compose('restart','api');
 await expect.poll(async()=>{try{return(await api('GET','/me')).status()}catch{return 0}},{timeout:60000}).toBe(200);
 const charged=Number(sql('SELECT orphan_bytes FROM document_storage_baseline;'));expect(charged).toBeGreaterThanOrEqual(before+4096);
 expect(compose('exec','-T','api','stat','-c','%s',`/data/resumes/${id}.part`).trim()).toBe('4096');
});
