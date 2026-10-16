'use strict';
const fs=require('node:fs'),c=require('node:crypto');
const {unwrap,seal,sha}=require('./crypto.cjs');
const credential=fs.readFileSync('/run/broker-auth');if(credential.length!==32)throw Error('WORKER_KEY_UNAVAILABLE');
const auth=c.createHmac('sha256',credential).update('document-worker-v1').digest('base64url');
const scanKey=fs.readFileSync('/run/scan-auth','utf8');
let job;
async function bounded(url,options={},limit=524288,ms=30000){
 const r=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(ms)});
 const n=Number(r.headers.get('content-length'));if(n>limit)throw Error('RESPONSE_LIMIT');
 const chunks=[];let size=0;for await(const b of r.body||[]){size+=b.length;if(size>limit)throw Error('RESPONSE_LIMIT');chunks.push(b);}return {status:r.status,bytes:Buffer.concat(chunks)};
}
async function api(op,result={}){
 const url=op==='claim'?'http://api-control:8081/claim':`http://api-control:8081/jobs/${job.document_id}/${op}`;
 const r=await bounded(url,{method:'POST',headers:{'X-Worker-Auth':auth,'Content-Type':'application/json'},body:JSON.stringify(op==='claim'?{}:{lease_token:job.lease_token,result})},op==='ciphertext'?10489876:524288);
 if(r.status===204)return null;if(r.status!==200)throw Error('AUTHORITY_UNAVAILABLE');return op==='ciphertext'?r.bytes:JSON.parse(r.bytes);
}
function validateScan(s,nonce,hash){
 const age=Date.now()/1000-s.last_successful_check;
 if(s.nonce!==nonce||s.sha256!==hash||!['clean','blocked'].includes(s.verdict)||s.engine_version!=='1.5.4'||s.update_ok!==true||age<0||age>86400||!s.databases||Object.keys(s.databases).sort().join(',')!=='bytecode,daily,main'||!Object.values(s.databases).every(d=>Number.isInteger(d.version)&&d.version>0&&/^[a-f0-9]{64}$/.test(d.sha256)))throw Error('SCANNER_UNAVAILABLE');
}
async function main(){
 job=await api('claim');if(!job||job.paused)return console.log(JSON.stringify({event:'no_job'}));
 const started=Date.now();
 await api('authorize');
 const raw=await api('ciphertext');
 // Authorization is checked immediately before private-key use and before commit.
 await api('authorize');
 let original;try{const key=c.createPrivateKey(fs.readFileSync('/run/keys/'+job.envelope.key_version+'.pem'));if(key.asymmetricKeyDetails.modulusLength!==3072||c.createPublicKey(key).export({type:'spki',format:'der'}).toString('base64')!==job.original_public_spki)throw Error('KEY_UNAVAILABLE');original=unwrap(job,raw,key);}catch(e){if(['METADATA_REJECTED','CRYPTO_REJECTED'].includes(e.message))throw e;if(e.code?.startsWith('ERR_OSSL')||e.code==='ERR_CRYPTO_INVALID_AUTH_TAG'||/authenticate/.test(e.message))throw Error('CRYPTO_REJECTED');throw Error('KEY_UNAVAILABLE');}
 const hash=sha(original.bytes),nonce=c.randomUUID();
 const av=await bounded('http://scan:8080/internal/scan',{method:'POST',headers:{'X-Scan-Key':scanKey,'X-Scan-Nonce':nonce,'Content-Type':'application/octet-stream'},body:original.bytes},32768,23000);
 if(av.status!==200)throw Error('SCANNER_UNAVAILABLE');const scan=JSON.parse(av.bytes);validateScan(scan,nonce,hash);if(scan.verdict==='blocked')throw Error('AV_BLOCKED');
 await api('authorize');
 const result=await bounded('http://relay:8080/check',{method:'POST',headers:{'Content-Type':job.file_format==='pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','X-Job-ID':job.generation},body:original.bytes},4096,10000);
 if(result.status!==200)throw Error('SANDBOX_UNAVAILABLE');const check=JSON.parse(result.bytes);
 if(Object.keys(check).sort().join(',')!=='ok,policy,rejection_code,sha256'||check.sha256!==hash||check.policy!==(job.file_format==='pdf'?'static-resume-v1':'xlsx-resume-v1')||typeof check.ok!=='boolean'||(check.ok?check.rejection_code!==null:!/^FORMAT_[A-Z0-9_]{1,64}$/.test(check.rejection_code)))throw Error('SANDBOX_UNAVAILABLE');
 if(!check.ok)throw Error('FORMAT_REJECTED');
 const manifest=Buffer.from(JSON.stringify({schema:1,document_id:job.document_id,generation:job.generation,original_hash:hash,original_name:original.original_name,file_format:job.file_format,policy:'inspection-v1',phase:'awaiting_conversion',scan_generation:scan.generation_id}));
 const sealed=seal(job,manifest,hash);
 original.bytes.fill(0);
 if(Date.now()-started>115000)throw Error('JOB_TIMEOUT');
 await api('commit',{original_name:original.original_name,sha256:hash,artifact_id:job.artifact_id,generation:job.generation,checks:{scan,format:check},...sealed});
 console.log(JSON.stringify({event:'checked'}));
}
main().catch(async e=>{
 const terminal=['CRYPTO_REJECTED','METADATA_REJECTED','AV_BLOCKED','FORMAT_REJECTED'].includes(e.message);
 if(job&&!job.paused)try{await api(terminal?'reject':'retry',{code:terminal?e.message:'WORKER_UNAVAILABLE'});}catch{}
 console.log(JSON.stringify({event:terminal?'rejected':'retryable'}));process.exitCode=1;
});
