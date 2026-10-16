const {chromium}=require(process.env.S0_PLAYWRIGHT||'../../.local/s0-browser/node_modules/playwright');
const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const [broker,viewer,out]=process.argv.slice(2),checks=[],timings=[];let activeBrowser;
const check=(name,value)=>{checks.push({name,pass:!!value});assert(value,name);};
async function post(base,path,data){const r=await fetch(base+path,{method:'POST',body:JSON.stringify(data)});return {status:r.status,body:await r.json()};}
(async()=>{
 const browser=activeBrowser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});await page.goto(broker);
 check('page_identity',(await page.title())==='S0 暗号検証');check('not_blank',await page.locator('#run').isVisible());
 const pubs=await(await fetch(broker+'/public')).json(),vp=await(await fetch(viewer+'/public')).json();
 const packet=await page.evaluate(async(pub)=>{
  const b64=b=>{let s='';for(let i=0;i<b.length;i+=16384)s+=String.fromCharCode(...b.subarray(i,i+16384));return btoa(s);};
  window.makePacket=async(version,size,wrongContext=false)=>{
   const start=performance.now(),plain=new Uint8Array(size).fill(37),meta=new TextEncoder().encode(JSON.stringify({fictional:true}));
   const frame=new Uint8Array(4+meta.length+size);new DataView(frame.buffer).setUint32(0,meta.length);frame.set(meta,4);frame.set(plain,4+meta.length);
   const raw=crypto.getRandomValues(new Uint8Array(32)),key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt']);
   const publicKey=await crypto.subtle.importKey('jwk',pub[version],{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
   const iv=crypto.getRandomValues(new Uint8Array(12)),kind='original',pg=null,generation=1;
   const aad=new TextEncoder().encode(JSON.stringify(['s0-v1',wrongContext?'fictional-org-b':'fictional-org-a','fictional-document-1','attempt-1','policy-fixture',generation,kind,pg,version]));
   const ciphertext=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad,tagLength:128},key,frame));
   const wrapped=new Uint8Array(await crypto.subtle.encrypt({name:'RSA-OAEP'},publicKey,raw));raw.fill(0);
   return {version,kind,page:pg,generation,iv:b64(iv),wrapped:b64(wrapped),ciphertext:b64(ciphertext),ms:performance.now()-start};
  };
  document.querySelector('#run').onclick=async()=>{window.small=await window.makePacket('v1',64);document.querySelector('#result').textContent='暗号化完了';};
  return {secure:window.isSecureContext,webCrypto:!!crypto.subtle};
 },pubs.publicKeys);
 check('secure_loopback_webcrypto',packet.secure&&packet.webCrypto);
 await page.locator('#run').click();await page.waitForFunction(()=>document.querySelector('#result').textContent==='暗号化完了');
 const small=await page.evaluate(()=>window.small);let r=await post(broker,'/decrypt',small);
 check('browser_to_node',r.status===200&&r.body.bytes===64);check('plain_hash',r.body.sha256===crypto.createHash('sha256').update(Buffer.alloc(64,37)).digest('hex'));
 const before=(await(await fetch(broker+'/state')).json()).released;
 for(const field of ['ciphertext','wrapped','iv']){const bad=structuredClone(small),v=Buffer.from(bad[field],'base64');v[0]^=1;bad[field]=v.toString('base64');check('reject_'+field,(await post(broker,'/decrypt',bad)).status===422);}
 const badTag=structuredClone(small),tagged=Buffer.from(badTag.ciphertext,'base64');tagged[tagged.length-1]^=1;badTag.ciphertext=tagged.toString('base64');check('reject_tag',(await post(broker,'/decrypt',badTag)).status===422);
 const otherOrg=await page.evaluate(()=>window.makePacket('v1',64,true));check('reject_other_org',(await post(broker,'/decrypt',otherOrg)).status===422);
 for(const field of ['kind','page','generation','version']){const bad={...small,[field]:field==='version'?'missing':field==='kind'?'other':2};check('reject_'+field,(await post(broker,'/decrypt',bad)).status===422);}
 check('no_unauthenticated_release',(await(await fetch(broker+'/state')).json()).released===before);
 check('broker_backup_restore',(await post(broker,'/restore',{version:'v1'})).body.mode===0o600);
 check('original_after_restore',(await post(broker,'/decrypt',small)).status===200);
 const fresh=await page.evaluate(()=>window.makePacket('v2',64));check('new_original_key',(await post(broker,'/decrypt',fresh)).status===200);
 await post(broker,'/revoke',{version:'v1'});check('revoked_original',(await post(broker,'/decrypt',small)).status===422);
 const fingerprints=new Set(),ivs=new Set();
 for(const [kind,pg,gen] of [['page',1,1],['page',2,1],['text',null,1],['table',null,1],['manifest',null,1],['page',1,2]]){
  const e=(await post(broker,'/seal',{jwk:vp.publicKeys.v1,version:'v1',kind,page:pg,generation:gen,data:Buffer.from('synthetic output').toString('base64')})).body;
  check(`viewer_${kind}_${pg}_${gen}`,(await post(viewer,'/decrypt',e)).body.sha256===e.sha256);
  fingerprints.add(e.key_fingerprint);ivs.add(e.iv);
  check(`reject_context_${kind}_${pg}_${gen}`,(await post(viewer,'/decrypt',{...e,page:pg===null?1:pg+1})).status===422);
  if(kind==='manifest'){
   await post(viewer,'/restore',{version:'v1'});check('viewer_backup_restore',(await post(viewer,'/decrypt',e)).status===200);
  }
 }
 check('per_artifact_keys_nonces',fingerprints.size===6&&ivs.size===6);
 const old=(await post(broker,'/seal',{jwk:vp.publicKeys.v1,version:'v1',kind:'page',page:1,generation:1,data:'YWJj'})).body;
 await post(viewer,'/revoke',{version:'v1'});check('revoked_viewer',(await post(viewer,'/decrypt',old)).status===422);
 const newArtifact=(await post(broker,'/seal',{jwk:vp.publicKeys.v2,version:'v2',kind:'page',page:1,generation:2,data:'YWJj'})).body;
 check('new_viewer_key',(await post(viewer,'/decrypt',newArtifact)).status===200);
 for(let i=0;i<4;i++){
  const large=await page.evaluate(()=>window.makePacket('v2',10*1024*1024)),start=performance.now(),result=await post(broker,'/decrypt',large);
  check('10MiB_'+i,result.status===200&&result.body.bytes===10*1024*1024);
  timings.push({sample:i,cold:i===0,encrypt_ms:large.ms,fixture_http_decrypt_ms:performance.now()-start});
 }
 check('no_browser_storage',await page.evaluate(()=>localStorage.length===0&&sessionStorage.length===0));check('console_health',errors.length===0);
 // Only the fixture status UI is captured; raw original content/keys never appear.
 await page.screenshot({path:out+'/crypto-status.png'});
 fs.writeFileSync(out+'/crypto.json',JSON.stringify({scope:'S0 fixture services, not product auth/ticket/retention',browser:browser.version(),playwright:require((process.env.S0_PLAYWRIGHT||'../../.local/s0-browser/node_modules/playwright')+'/package.json').version,browser_plugin:'absent; regular Playwright',checks,timings},null,2));
 await browser.close();console.log(JSON.stringify({crypto_checks:checks.length,passed:checks.every(x=>x.pass)}));
})().catch(async e=>{if(activeBrowser)await activeBrowser.close();fs.writeFileSync(out+'/crypto-failure.json',JSON.stringify({checks,error:e.message}));console.error(e.message);process.exitCode=1;});
