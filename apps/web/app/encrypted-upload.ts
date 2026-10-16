// Browser-only transport: no DEK, ticket or File bytes enter drafts/storage/logs.
export type Receipt={upload_id:string;document_id:string;attempt_id:string;state:string;attempt_state:string;attempt_expires_at?:string|null;wrap_public_spki:string;wrap_key_version:string;aad:string};
type Encrypted={attempt:string;bytes:ArrayBuffer;envelope:{schema:number;key_version:string;wrapped_dek:string;nonce:string;aad:string};hash:string};
const pending=new Map<string,Encrypted>();
const b64=(bytes:Uint8Array)=>btoa(Array.from(bytes,b=>String.fromCharCode(b)).join('')).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const unbase64=(s:string)=>Uint8Array.from(atob(s),v=>v.charCodeAt(0));
async function encrypt(file:File,r:Receipt):Promise<Encrypted>{
 const meta=new TextEncoder().encode(JSON.stringify({original_name:file.name}));if(meta.length>4096)throw Error('ファイル名が長すぎます。');
 const frame=new Uint8Array(4+meta.length+file.size);new DataView(frame.buffer).setUint32(0,meta.length,false);frame.set(meta,4);frame.set(new Uint8Array(await file.arrayBuffer()),4+meta.length);
 const dek=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt']);const nonce=crypto.getRandomValues(new Uint8Array(12));
 const publicKey=await crypto.subtle.importKey('spki',unbase64(r.wrap_public_spki),{name:'RSA-OAEP',hash:'SHA-256'},false,['wrapKey']);
 const bytes=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:new TextEncoder().encode(r.aad),tagLength:128},dek,frame);
 const wrapped=await crypto.subtle.wrapKey('raw',dek,publicKey,{name:'RSA-OAEP'});
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
 return {attempt:r.attempt_id,bytes,hash,envelope:{schema:1,key_version:r.wrap_key_version,wrapped_dek:b64(new Uint8Array(wrapped)),nonce:b64(nonce),aad:r.aad}};
}
async function upload(candidate:string,key:string,kind:string,file:File,csrf:string,signal:AbortSignal){
 const api=async(path:string,method='GET',data?:unknown)=>{const response=await fetch('/api/v1'+path,{method,signal,cache:'no-store',headers:{'X-CSRF-Token':csrf,'Idempotency-Key':key,...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});const value=await response.json();if(!response.ok)throw Error(value?.error?.message||'暗号化受付を確認できません。再ログイン後に受付結果を確認してください。');return value;};
 let r=await api(`/candidates/${candidate}/document-uploads`,'POST',{document_kind:kind,file_format:file.name.toLowerCase().endsWith('.xlsx')?'xlsx':'pdf',plain_length:file.size,fictional_confirmed:true}) as Receipt;
 r=await api(`/document-uploads/${r.upload_id}`) as Receipt;
 if(['receiving','reconciling'].includes(r.attempt_state))throw Error('受信状態を照合しています。時間をおいて受付結果を確認してください。');
 if(r.state==='rejected')throw Error('受付期限を過ぎています。元の受付を再実行できません。');
 if(!['stored','attached'].includes(r.attempt_state)){
  let encrypted=pending.get(key);
  if(r.attempt_state==='closed'||r.attempt_state==='authorized'&&(encrypted?.attempt!==r.attempt_id||!!r.attempt_expires_at&&Date.parse(r.attempt_expires_at)<=Date.now())){r=await api(`/document-uploads/${r.upload_id}/attempts`,'POST') as Receipt;encrypted=undefined;}
  if(!encrypted||encrypted.attempt!==r.attempt_id){encrypted=await encrypt(file,r);pending.set(key,encrypted);}
  const authorization=await api(`/document-uploads/${r.upload_id}/authorize`,'POST',{attempt_id:r.attempt_id,ciphertext_hash:encrypted.hash,ciphertext_size:encrypted.bytes.byteLength,envelope:encrypted.envelope});
  const response=await fetch(authorization.upload_url,{method:'PUT',signal,cache:'no-store',headers:{'Content-Type':'application/octet-stream','X-CSRF-Token':csrf,'X-Upload-Ticket':authorization.ticket},body:encrypted.bytes});
  if(!response.ok)throw Error('暗号文の送信結果を確認できません。受付結果を確認してください。');
  r=await api(`/document-uploads/${r.upload_id}`) as Receipt;
  if(!['stored','attached'].includes(r.attempt_state))throw Error('受信が続いています。受付結果を確認してください。');
 }
 const completed=await api(`/document-uploads/${r.upload_id}/complete`,'POST') as Receipt;pending.delete(key);return completed;
}
export function forgetEncryptedUploads(){pending.clear();}

export async function encryptedUpload(candidate:string,key:string,kind:string,file:File,csrf:string,signal:AbortSignal){
 if(!navigator.locks)throw Error('このブラウザでは安全な直列受付を利用できません。対応ブラウザで開いてください。');
 return navigator.locks.request('rp-encrypted-document-upload-v1',{mode:'exclusive',signal},()=>upload(candidate,key,kind,file,csrf,signal));
}
