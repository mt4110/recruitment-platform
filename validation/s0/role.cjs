// Isolated S0 fixture service. No product authentication, upload ticket or API.
const http=require('node:http'),fs=require('node:fs'),c=require('node:crypto');
const role=process.env.S0_ROLE,root=role==='broker'?'/broker-secret':'/viewer-secret';
const keys=new Map(),revoked=new Set(); let released=0;
const digest=b=>c.createHash('sha256').update(b).digest('hex');
const b64=b=>Buffer.from(b).toString('base64'),un64=s=>Buffer.from(s,'base64');
const context=(version,kind='original',page=null,generation=1)=>JSON.stringify([
 's0-v1','fictional-org-a','fictional-document-1',role==='broker'?'attempt-1':'original-hash-fixture',
 'policy-fixture',generation,kind,page,version]);
if(role!=='relay')for(const version of ['v1','v2']){
 const file=root+'/'+version+'.pem';
 if(!fs.existsSync(file)){
  const pair=c.generateKeyPairSync('rsa',{modulusLength:3072});
  fs.writeFileSync(file,pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600,flag:'wx'});
  fs.writeFileSync(root+'/'+version+'.backup.pem',fs.readFileSync(file),{mode:0o600,flag:'wx'});
 }
 keys.set(version,c.createPrivateKey(fs.readFileSync(file)));
}
function unwrap(p){
 if(revoked.has(p.version)||!keys.has(p.version))throw Error('KEY_UNAVAILABLE');
 return c.privateDecrypt({key:keys.get(p.version),oaepHash:'sha256',padding:c.constants.RSA_PKCS1_OAEP_PADDING},un64(p.wrapped));
}
function decrypt(p){
 const key=unwrap(p),iv=un64(p.iv),raw=un64(p.ciphertext);
 if(key.length!==32||iv.length!==12||raw.length<16||raw.length>10*1024*1024+4116)throw Error('LIMIT');
 const decipher=c.createDecipheriv('aes-256-gcm',key,iv,{authTagLength:16});
 const expected=context(p.version,p.kind,p.page,p.generation);
 decipher.setAAD(Buffer.from(expected));decipher.setAuthTag(raw.subarray(-16));
 // update() output remains local until final() authenticates the entire payload.
 const plain=Buffer.concat([decipher.update(raw.subarray(0,-16)),decipher.final()]);
 key.fill(0);
 if(role==='broker'){
  if(plain.length<4)throw Error('FRAME');const n=plain.readUInt32BE();
  if(n>4096||plain.length<4+n||plain.length-4-n>10*1024*1024)throw Error('FRAME');
  const meta=JSON.parse(plain.subarray(4,4+n).toString('utf8'));
  if(meta.fictional!==true)throw Error('METADATA');
  released++;return {sha256:digest(plain.subarray(4+n)),bytes:plain.length-4-n};
 }
 released++;return {sha256:digest(plain),bytes:plain.length};
}
async function route(req,res){
 if(req.method==='GET'&&req.url==='/'){
  res.setHeader('content-type','text/html; charset=utf-8');
  return res.end('<!doctype html><html lang="ja"><title>S0 暗号検証</title><button id="run">暗号検証を実行</button><p id="result">未実行</p></html>');
 }
 if(req.url==='/favicon.ico'){res.statusCode=204;return res.end();}
 if(req.url==='/health')return res.end(JSON.stringify({role,ok:true}));
 if(role==='relay'){
  if(req.url==='/job'&&req.method==='POST'){
   let n=0;for await(const b of req){n+=b.length;if(n>1024)throw Error('LIMIT');}
   return res.end(JSON.stringify({accepted:true,bytes:n}));
  }throw Error('ROUTE');
 }
 if(req.method==='GET'&&req.url==='/public'){
  const publicKeys=Object.fromEntries([...keys].map(([v,k])=>[v,c.createPublicKey(k).export({format:'jwk'})]));
  return res.end(JSON.stringify({role,publicKeys}));
 }
 if(req.method==='GET'&&req.url==='/state')return res.end(JSON.stringify({role,released}));
 let n=0,chunks=[];for await(const b of req){n+=b.length;if(n>15*1024*1024)throw Error('LIMIT');chunks.push(b);}
 const p=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 if(req.url==='/decrypt')return res.end(JSON.stringify(decrypt(p)));
 if(req.url==='/revoke'){revoked.add(p.version);return res.end('{"revoked":true}');}
 if(req.url==='/restore'){
  // Simulate key loss in memory, then reconstruct from a separately retained backup.
  keys.delete(p.version);keys.set(p.version,c.createPrivateKey(fs.readFileSync(root+'/'+p.version+'.backup.pem')));
  return res.end(JSON.stringify({restored:true,mode:fs.statSync(root+'/'+p.version+'.backup.pem').mode&0o777}));
 }
 if(req.url==='/seal'&&role==='broker'){
  const plain=un64(p.data);if(plain.length>8*1024*1024)throw Error('LIMIT');
  const key=c.randomBytes(32),iv=c.randomBytes(12);
  // Viewer context is deterministic and distinct from original-upload context.
  const aad=JSON.stringify(['s0-v1','fictional-org-a','fictional-document-1','original-hash-fixture','policy-fixture',p.generation,p.kind,p.page,p.version]);
  const cipher=c.createCipheriv('aes-256-gcm',key,iv,{authTagLength:16});cipher.setAAD(Buffer.from(aad));
  const encrypted=Buffer.concat([cipher.update(plain),cipher.final(),cipher.getAuthTag()]);
  const wrapped=c.publicEncrypt({key:c.createPublicKey({key:p.jwk,format:'jwk'}),oaepHash:'sha256'},key);
  const result={version:p.version,kind:p.kind,page:p.page,generation:p.generation,ciphertext:b64(encrypted),iv:b64(iv),wrapped:b64(wrapped),sha256:digest(plain),key_fingerprint:digest(key)};
  key.fill(0);return res.end(JSON.stringify(result));
 }
 throw Error('ROUTE');
}
const server=http.createServer((req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('content-type','application/json');
 route(req,res).catch(()=>{res.statusCode=422;res.end('{"error":"REJECTED"}');});
});server.requestTimeout=30000;server.listen(8080,'0.0.0.0');
