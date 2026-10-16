'use strict';
// Artifact-only decryptor. No original key, database, blob mount or parser.
const http=require('node:http'),fs=require('node:fs'),c=require('node:crypto');
const key=fs.readFileSync('/run/viewer-auth');if(key.length!==32)throw Error('VIEWER_UNAVAILABLE');
const token=c.createHmac('sha256',key).update('artifact-view-v1').digest();let busy=0;
function sha(b){return c.createHash('sha256').update(b).digest('hex');}
http.createServer(async(req,res)=>{
 const reply=(status,data=Buffer.alloc(0))=>{res.writeHead(status,{'Content-Type':'application/octet-stream','Cache-Control':'no-store','Content-Length':data.length,'X-Content-Type-Options':'nosniff'});res.end(data);};
 if(req.method==='GET'&&req.url==='/live')return reply(200);
 let supplied;try{supplied=Buffer.from(req.headers['x-view-auth']||'','base64url');}catch{return reply(403);}
 const n=Number(req.headers['content-length']);
 if(req.method!=='POST'||req.url!=='/decrypt'||supplied.length!==32||!c.timingSafeEqual(supplied,token)||!Number.isInteger(n)||n<1||n>12582912)return reply(403);
 if(busy>=2)return reply(503);busy++;
 let dek;
 try{
  let size=0;const chunks=[];for await(const b of req){size+=b.length;if(size>n)throw Error('LIMIT');chunks.push(b);}if(size!==n)throw Error('LENGTH');
  const v=JSON.parse(Buffer.concat(chunks)),e=v.envelope,raw=Buffer.from(v.bytes,'base64url');
  if(!/^artifact-v[1-9][0-9]{0,3}$/.test(e.key_version)||e.schema!==1||!['manifest','page','text','table'].includes(e.kind)||raw.length!==v.size||sha(raw)!==v.hash||!/^[a-f0-9]{64}$/.test(e.plaintext_hash))throw Error('CONTEXT');
  const aad=JSON.stringify(['rp-artifact-v1',v.org_id,v.document_id,v.original_hash,'safe-view-v1',v.generation,v.id,e.kind,e.page,e.key_version]);
  if(e.aad!==aad||e.org_id!==v.org_id||e.document_id!==v.document_id||e.generation!==v.generation)throw Error('AAD');
  const secret=c.createPrivateKey(fs.readFileSync(e.key_version==='artifact-v1'?'/run/artifact-private.pem':'/run/viewer-keys/'+e.key_version+'.pem'));
  if(secret.asymmetricKeyDetails.modulusLength!==3072||c.createPublicKey(secret).export({type:'spki',format:'der'}).toString('base64')!==v.public_spki)throw Error('KEY');
  dek=c.privateDecrypt({key:secret,oaepHash:'sha256',padding:c.constants.RSA_PKCS1_OAEP_PADDING},Buffer.from(e.wrapped_dek,'base64url'));
  if(dek.length!==32||Buffer.from(e.nonce,'base64url').length!==12)throw Error('KEY');
  const decipher=c.createDecipheriv('aes-256-gcm',dek,Buffer.from(e.nonce,'base64url'));decipher.setAAD(Buffer.from(aad));decipher.setAuthTag(raw.subarray(-16));
  const data=Buffer.concat([decipher.update(raw.subarray(0,-16)),decipher.final()]);
  const limit={manifest:262144,page:8388608,text:1048576,table:1048576}[e.kind];
  if(data.length>limit||sha(data)!==e.plaintext_hash)throw Error('HASH');
  if(e.kind==='page'&&(data.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||data.readUInt32BE(16)<1||data.readUInt32BE(20)<1||data.readUInt32BE(16)>4096||data.readUInt32BE(20)>4096||data.readUInt32BE(16)*data.readUInt32BE(20)>8000000))throw Error('PNG');
  reply(200,data);
 }catch{reply(503);}finally{dek?.fill(0);busy--;}
}).listen(8080,'0.0.0.0');
