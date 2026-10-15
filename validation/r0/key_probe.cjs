// Isolated browser/crypto feasibility probe. No product auth/API/RLS implementation.
const {chromium}=require('../../e2e/node_modules/@playwright/test');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const out=path.resolve(process.argv[2]);fs.mkdirSync(out,{recursive:true});
const keys={1:crypto.randomBytes(32).toString('base64'),2:crypto.randomBytes(32).toString('base64')};
const cookie=crypto.randomBytes(32).toString('hex');let revoked=false;
const server=http.createServer((req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(req.url==='/')return res.end('<!doctype html><title>R0 isolated draft probe</title><p>Fictional test data only</p>');
  if(req.url==='/login'){res.setHeader('Set-Cookie',`r0_session=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=600`);return res.end('ok');}
  if(!req.headers.cookie?.includes(`r0_session=${cookie}`)){res.statusCode=401;return res.end('{}');}
  if(req.url==='/logout'){res.setHeader('Set-Cookie','r0_session=; HttpOnly; Path=/; Max-Age=0');return res.end('ok');}
  if(req.url==='/revoke'){revoked=true;return res.end('ok');}
  const m=req.url.match(/^\/keys\/(\d+)$/);res.setHeader('Content-Type','application/json');
  if(m&&keys[m[1]]){res.statusCode=revoked&&m[1]==='1'?409:200;return res.end(res.statusCode===200?JSON.stringify({version:Number(m[1]),key:keys[m[1]]}):'{}');}
  res.statusCode=404;res.end('{}');
});
async function main(){
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const profile=path.join(out,'browser-profile');let context;
 try{
  context=await chromium.launchPersistentContext(profile,{headless:true});let page=await context.newPage();await page.goto(origin);await page.evaluate(()=>fetch('/login'));
  const first=await page.evaluate(async()=>{
    const open=()=>new Promise((resolve,reject)=>{const q=indexedDB.open('r0-drafts',1);q.onupgradeneeded=()=>q.result.createObjectStore('drafts');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
    const value={user:'fictional-user-a',org:'fictional-org-a',draft:'draft-1',schema:1,version:1,sequence:1};
    const metadata=new TextEncoder().encode(JSON.stringify(value));
    const material=await(await fetch('/keys/1')).json();const raw=Uint8Array.from(atob(material.key),c=>c.charCodeAt(0));
    const key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt']);const iv=crypto.getRandomValues(new Uint8Array(12));
    const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:metadata},key,new TextEncoder().encode('架空候補者の未同期入力'));
    const db=await open();await new Promise((resolve,reject)=>{const tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').put({value,iv,ciphertext},'draft-1');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
    return {saved:true,bytes:ciphertext.byteLength,extractable:key.extractable};
  });assert.equal(first.extractable,false);await context.close();context=null;
  context=await chromium.launchPersistentContext(profile,{headless:true});page=await context.newPage();await page.goto(origin);await page.evaluate(()=>fetch('/logout'));
  assert.equal(await page.evaluate(async()=>(await fetch('/keys/1')).status),401);await page.evaluate(()=>fetch('/login'));
  const restored=await page.evaluate(async()=>{
    const q=indexedDB.open('r0-drafts',1);const db=await new Promise((r,j)=>{q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});
    const entry=await new Promise((r,j)=>{const tx=db.transaction('drafts');const req=tx.objectStore('drafts').get('draft-1');req.onsuccess=()=>r(req.result);req.onerror=()=>j(req.error);});
    const k1=await(await fetch('/keys/'+entry.value.version)).json(),k2=await(await fetch('/keys/2')).json();
    const key=await crypto.subtle.importKey('raw',Uint8Array.from(atob(k1.key),c=>c.charCodeAt(0)),'AES-GCM',false,['decrypt']);
    const aad=new TextEncoder().encode(JSON.stringify(entry.value));const text=new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:entry.iv,additionalData:aad},key,entry.ciphertext));
    let badAad=false,tamper=false;try{await crypto.subtle.decrypt({name:'AES-GCM',iv:entry.iv,additionalData:new TextEncoder().encode('other-user')},key,entry.ciphertext);}catch{badAad=true;}
    const bad=new Uint8Array(entry.ciphertext.slice(0));bad[0]^=1;try{await crypto.subtle.decrypt({name:'AES-GCM',iv:entry.iv,additionalData:aad},key,bad);}catch{tamper=true;}
    const fresh=await crypto.subtle.importKey('raw',Uint8Array.from(atob(k2.key),c=>c.charCodeAt(0)),'AES-GCM',false,['encrypt','decrypt']);const iv=crypto.getRandomValues(new Uint8Array(12));entry.value.version=2;const nextAad=new TextEncoder().encode(JSON.stringify(entry.value));
    const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:nextAad},fresh,new TextEncoder().encode(text));
    await new Promise((r,j)=>{const tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').put({value:entry.value,iv,ciphertext},'draft-1');tx.oncomplete=r;tx.onerror=()=>j(tx.error);});db.close();
    const check=new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:nextAad},fresh,ciphertext));
    return {restored:text==='架空候補者の未同期入力',reencrypted:check===text,badAad,tamper,webStorageEmpty:localStorage.length===0&&sessionStorage.length===0};
  });for(const v of Object.values(restored))assert.equal(v,true);
  await page.evaluate(()=>fetch('/revoke'));assert.equal(await page.evaluate(async()=>(await fetch('/keys/1')).status),409);assert.equal(await page.evaluate(async()=>(await fetch('/keys/999')).status),404);
  const evidence={scope:'browser crypto and IndexedDB, fixture key service only; not product auth/RLS',node:process.version,arch:process.arch,chromium:context.browser()?.version()||'persistent-context',checks:{...restored,oldKeyAfterRestart:true,signedOutDenied:true,revokedDenied:true,unknownVersionDenied:true},keyMaterialLogged:false};
  fs.writeFileSync(path.join(out,'keys.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
 }finally{if(context)await context.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e.message);server.close();process.exitCode=1;});
