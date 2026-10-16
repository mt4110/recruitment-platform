'use strict';
const c=require('node:crypto');
const MAX=10489876,sha=b=>c.createHash('sha256').update(b).digest('hex');
function unwrap(job,raw,privateKey){
 if(raw.length!==job.ciphertext_size||raw.length>MAX||sha(raw)!==job.ciphertext_hash)throw Error('CRYPTO_REJECTED');
 const e=job.envelope,expected=`rp-upload-v1|${e.key_version}|${job.upload_id}|${job.document_id}|${job.attempt_id}|${job.org_id}|${job.file_format}`;
 if(e.schema!==1||!/^original-v[1-9][0-9]{0,3}$/.test(e.key_version)||e.aad!==expected)throw Error('CRYPTO_REJECTED');
 const key=c.privateDecrypt({key:privateKey,oaepHash:'sha256',padding:c.constants.RSA_PKCS1_OAEP_PADDING},Buffer.from(e.wrapped_dek,'base64url'));
 let plain;
 try{if(key.length!==32||Buffer.from(e.nonce,'base64url').length!==12)throw Error('CRYPTO_REJECTED');const d=c.createDecipheriv('aes-256-gcm',key,Buffer.from(e.nonce,'base64url'),{authTagLength:16});d.setAAD(Buffer.from(expected));d.setAuthTag(raw.subarray(-16));plain=Buffer.concat([d.update(raw.subarray(0,-16)),d.final()]);}finally{key.fill(0);}
 if(plain.length<5)throw Error('METADATA_REJECTED');const n=plain.readUInt32BE();
 if(n<1||n>4096||plain.length-4-n!==job.plain_length)throw Error('METADATA_REJECTED');
 let m;try{m=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain.subarray(4,4+n)));}catch{throw Error('METADATA_REJECTED');}
 if(!m||typeof m!=='object'||Array.isArray(m)||Object.keys(m).join(',')!=='original_name'||typeof m.original_name!=='string'||Array.from(m.original_name).length<1||Array.from(m.original_name).length>255||/[\x00-\x1f\x7f/\\]/.test(m.original_name))throw Error('METADATA_REJECTED');
 return {bytes:plain.subarray(4+n),original_name:m.original_name};
}
function seal(job,bytes,originalHash,kind='manifest',page=null){
 if(bytes.length>({manifest:262144,page:8388608,text:1048576,table:1048576}[kind]||0)||(kind==='page'?(!Number.isInteger(page)||page<1||page>20):page!==null))throw Error('ARTIFACT_LIMIT');
 const publicKey=c.createPublicKey({key:Buffer.from(job.artifact_public_spki,'base64'),format:'der',type:'spki'});
 if(publicKey.asymmetricKeyDetails.modulusLength!==3072)throw Error('KEY_UNAVAILABLE');
 const key=c.randomBytes(32),nonce=c.randomBytes(12),aad=JSON.stringify(['rp-artifact-v1',job.org_id,job.document_id,originalHash,'safe-view-v1',job.generation,job.artifact_id,kind,page,job.artifact_version]);
 try{const cipher=c.createCipheriv('aes-256-gcm',key,nonce,{authTagLength:16});cipher.setAAD(Buffer.from(aad));const raw=Buffer.concat([cipher.update(bytes),cipher.final(),cipher.getAuthTag()]);
 return {artifact_bytes:raw.toString('base64url'),artifact_hash:sha(raw),artifact_size:raw.length,artifact_envelope:{schema:1,key_version:job.artifact_version,wrapped_dek:c.publicEncrypt({key:publicKey,oaepHash:'sha256',padding:c.constants.RSA_PKCS1_OAEP_PADDING},key).toString('base64url'),nonce:nonce.toString('base64url'),aad,document_id:job.document_id,org_id:job.org_id,generation:job.generation,kind,page,plaintext_hash:sha(bytes)}};
 }finally{key.fill(0);}
}
module.exports={unwrap,seal,sha};
