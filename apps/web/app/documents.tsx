'use client';
import SafeView from './safe-view';
import {encryptedUpload,forgetEncryptedUploads} from './encrypted-upload';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import type {Member} from './business';
import {useDraft,DraftStatus} from './drafts';
import {kinds,documentTime,type Kind} from './document-info';
export type DocumentData={view_prepared?:boolean;encrypted_transport?:boolean;inspection_state:string;id:string;original_name:string;size_bytes:number;status:'pending'|'ready'|'rejected';rejection_code:string|null;retry_allowed:boolean;available:boolean;format_checked:boolean;file_format:'pdf'|'xlsx';document_kind:Kind;document_version:number;created_at:string};
type Stage='waiting'|'sending'|'checking'|'pending'|'complete'|'rejected'|'uncertain'|'unrecorded'|'expired';
type Upload={key:string;kind:Kind;file?:File;name?:string;hash?:string;stage:Stage;document?:DocumentData;message?:string};
type Receipt={v:1;user:string;org:string;candidate:string;operations:{key:string;kind:Kind}[]};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const stages:Record<Stage,string>={waiting:'待機',sending:'送信中',checking:'受付結果を確認中',pending:'検査・復旧待ち',complete:'登録完了',rejected:'登録拒否',uncertain:'再試行待ち',unrecorded:'受付未確認・再選択が必要',expired:'結果照合期限切れ'};
const reasons:Record<string,string>={MALWARE_DETECTED:'安全性検査で利用できない書類と判定されました。',UNSUPPORTED_STRUCTURE:'未対応のXLSX構造です。外部リンクを外して保存するか、PDFへ書き出してください。',UNSUPPORTED_FORMULA:'未対応の数式です。数式を値にするか、PDFへ書き出してください。',STRUCTURE_LIMIT:'XLSXの展開量や構造が上限を超えています。',CANDIDATE_ARCHIVED:'候補者がアーカイブされたため登録できません。',UPLOAD_INTERRUPTED:'保存が中断されました。新しい操作で登録してください。',ENCRYPTED:'暗号化せずにPDFを書き出してください。',PAGES:'1〜20ページにしてください。',PDF_STRUCTURE_UNSUPPORTED:'対応していないPDF構造です。サンプルPDFでお試しください。',PDF_REJECTED:'静的なPDFだけ登録できます。リンクやフォームを含めずPDFを書き出してください。'};
const stageOf=(d:DocumentData):Stage=>d.status==='rejected'||d.inspection_state==='blocked'?'rejected':d.available?'complete':'pending';
async function fingerprint(file:File){const hash=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());return Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('');}
export default function Documents({candidate,initial,archived,me,signedIn,onUnauthorized}:{candidate:string;initial:DocumentData[];archived:boolean;me:Member;signedIn:boolean;onUnauthorized:()=>Promise<void>}){
 const [items,setItems]=useState(initial),[queue,setQueue]=useState<Upload[]>([]),[kind,setKind]=useState<Kind>('other'),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[recovery,setRecovery]=useState(''),[encrypted,setEncrypted]=useState(true);
 const active=useRef(true),working=useRef(false),jobs=useRef<Upload[]>([]),controller=useRef<AbortController|null>(null),input=useRef<HTMLInputElement|null>(null),rechecks=useRef(new Map<string,string>());
 const uploadDraft=useDraft({me,paused:busy,enabled:signedIn,kind:'document_upload',target:candidate,payload:{document_kind:kind,encrypted_transport:encrypted,operations:queue.filter(q=>q.name&&q.hash).map(q=>({key:q.key,kind:q.kind,name:q.name,hash:q.hash,state:q.stage,...(q.document?{document_id:q.document.id}:{})}))},restore:p=>{setEncrypted(p.encrypted_transport!==false);const ops=p.operations;if(Array.isArray(ops)){try{if(location.hash.startsWith('#receipts=')){const r=JSON.parse(decodeURIComponent(location.hash.slice(10))) as Receipt;if(r.operations.some(o=>!ops.some(s=>s.key===o.key)))return false;}}catch{return false;}setKind(typeof p.document_kind==='string'&&Object.hasOwn(kinds,p.document_kind)?p.document_kind as Kind:ops.at(-1)?.kind||'other');const restored:Upload[]=ops.map(o=>({key:o.key,kind:o.kind,name:o.name,hash:o.hash,stage:'checking'}));update(()=>restored);setConfirmed(false);setMessage('保存した受付を照合しています。未送信ファイルは再選択が必要です。');if(restored.length)void action(async signal=>{for(const q of restored)await reconcile(q,signal);});}else{update(()=>[]);setConfirmed(false);}},unauthorized:onUnauthorized});
 function update(fn:(q:Upload[])=>Upload[]){const next=fn(jobs.current);jobs.current=next;if(active.current)setQueue(next);}
 function patch(key:string,next:Partial<Upload>){update(q=>q.map(v=>v.key===key?{...v,...next}:v));}
 function addDocument(d:DocumentData){if(active.current)setItems(v=>[d,...v.filter(x=>x.id!==d.id)]);}
 useEffect(()=>{active.current=true;return()=>{active.current=false;controller.current?.abort();forgetEncryptedUploads();};},[]);
 useEffect(()=>{setItems(initial);},[initial]);
 useEffect(()=>{if(!signedIn){forgetEncryptedUploads();controller.current?.abort();setItems([]);setConfirmed(false);update(()=>[]);setRecovery('');setMessage('');rechecks.current.clear();}},[signedIn]);
 // Only opaque operation identifiers live in the fragment. No File, original
 // name, hash, auth token or personal form payload is persisted by R3.
 useEffect(()=>{
  if(!signedIn)return;
  try{
   if(!location.hash.startsWith('#receipts='))return;
   if(location.hash.length>4096)throw Error();
   const r=JSON.parse(decodeURIComponent(location.hash.slice(10))) as Receipt;
   if(r.v!==1||r.user!==me.user.id||r.org!==me.organization.id||r.candidate!==candidate||!Array.isArray(r.operations)||r.operations.length>10||r.operations.some(o=>!uuid.test(o.key)||!Object.hasOwn(kinds,o.kind))||new Set(r.operations.map(o=>o.key)).size!==r.operations.length)throw Error();
   update(()=>r.operations.map(o=>({...o,stage:'checking'})));setRecovery(location.href);setMessage('復帰リンクの受付結果を確認してください。送信前のファイルは保存していません。');
  }catch{setMessage('この復帰リンクは形式または本人・所属が一致しません。書類一覧を確認してください。');}
 },[candidate,me.user.id,me.organization.id,signedIn]);
 function remember(q:Upload[]){
  const r:Receipt={v:1,user:me.user.id,org:me.organization.id,candidate,operations:q.map(v=>({key:v.key,kind:v.kind}))};
  const url=new URL(location.href);url.hash='receipts='+encodeURIComponent(JSON.stringify(r));history.replaceState(history.state,'',url);setRecovery(url.href);
 }
 const pending=items.filter(d=>d.status==='pending').map(d=>d.id).sort().join(',');
 useEffect(()=>{
  if(!signedIn||!pending)return;const abort=new AbortController();let loading=false;
  const check=async()=>{if(loading||document.hidden)return;loading=true;try{for(const id of pending.split(',')){const r=await fetch('/api/v1/documents/'+id,{cache:'no-store',signal:abort.signal});if(r.status===401){void onUnauthorized();break;}if(r.ok){const d=await r.json() as DocumentData;if(!abort.signal.aborted){addDocument(d);patchFromPoll(d);}}}}catch{/* Manual recovery remains available. */}finally{loading=false;}};
  function patchFromPoll(d:DocumentData){update(q=>q.map(v=>v.document?.id===d.id?{...v,document:d,stage:stageOf(d)}:v));}
  const timer=setInterval(()=>void check(),2000);window.addEventListener('focus',check);return()=>{clearInterval(timer);abort.abort();window.removeEventListener('focus',check);};
 },[pending,signedIn,onUnauthorized]);
 async function choose(files:FileList|null){
  if(!files?.length||working.current)return;
  const batch=Array.from(files);if(batch.length>10){setMessage('1回に選べるファイルは10件までです。');if(input.current)input.current.value='';return;}
  if(batch.some(f=>!f.size||f.size>10*1024*1024||!/\.(pdf|xlsx)$/i.test(f.name))){setMessage('空でないPDF／XLSXを10MiB以内で選んでください。');if(input.current)input.current.value='';return;}
  const previous=jobs.current.every(v=>['complete','rejected','expired'].includes(v.stage))?[]:jobs.current;
  if(previous.some(q=>!q.file&&(q.stage==='checking'||q.stage==='unrecorded'&&(!q.name||!q.hash)))){setMessage('先に元の受付結果を照合してください。元ファイル情報のない受付は一覧から確認してください。');if(input.current)input.current.value='';return;}
  working.current=true;setBusy(true);setMessage('');
  try{let all=[...previous];for(const file of batch){const hash=await fingerprint(file);const old=all.find(q=>q.stage==='unrecorded'&&!q.file&&q.hash===hash&&q.name===file.name&&q.kind===kind);if(old){all=all.map(q=>q.key===old.key?{...q,file,stage:'waiting',message:undefined}:q);}else{all.push({key:crypto.randomUUID(),kind,file,name:file.name,hash,stage:'waiting'});}}if(all.length>10){setMessage('現在の受付は10件までです。受付結果を確認してから追加してください。');return;}if(active.current){update(()=>all);remember(all);setConfirmed(false);}}
  catch{if(active.current)setMessage('ファイルを準備できませんでした。選び直してください。');}
  finally{working.current=false;if(active.current)setBusy(false);}
 }
 async function readDocument(id:string,signal:AbortSignal){
  const r=await fetch('/api/v1/documents/'+id,{cache:'no-store',signal});
  if(r.status===401){void onUnauthorized();throw Error('再ログイン後、復帰リンクを開いてください。');}
  if(!r.ok)throw Error('書類の現在の状態を確認できません。権限と接続状況を確認してください。');
  const d=await r.json() as DocumentData;addDocument(d);return d;
 }
 async function reconcile(job:Upload,signal:AbortSignal):Promise<DocumentData|null>{
  patch(job.key,{stage:'checking',message:undefined});
  const r=await fetch(`/api/v1/candidates/${candidate}/document-upload-outcome?key=${job.key}`,{cache:'no-store',signal});const data=await r.json();
  if(r.status===401){void onUnauthorized();throw Error('再ログイン後、復帰リンクを開いて受付結果を確認してください。');}
  if(data?.error?.code==='OPERATION_RESULT_EXPIRED'){patch(job.key,{stage:'expired',file:undefined,message:'7日間の照合期限を過ぎています。再送せず、書類一覧を確認してください。'});return null;}
  if(!r.ok)throw Error(data?.error?.message||'受付結果を照合できませんでした。');
  if(data.state==='not_recorded'){patch(job.key,{stage:'unrecorded',message:job.file?'まだ受付結果がありません。同じファイル・操作キーで再試行できます。':job.hash&&job.name?'未実行とは限りません。元と同じファイルを再選択してください。自動再送しません。':'未実行とは限りません。元ファイルの情報を復元できないため自動再送しません。書類一覧を確認してください。'});return null;}
  if(data.upload_id){
   const stateResponse=await fetch('/api/v1/document-uploads/'+data.upload_id,{cache:'no-store',signal});const receipt=await stateResponse.json();if(!stateResponse.ok)throw Error(receipt?.error?.message||'受付結果を確認できません。');
   if(['stored','attached'].includes(receipt.attempt_state)){
    if(receipt.attempt_state==='stored'){const c=await fetch('/api/v1/document-uploads/'+data.upload_id+'/complete',{method:'POST',signal,headers:{'X-CSRF-Token':me.csrf_token}});if(!c.ok)throw Error('暗号文は保存済みです。受付結果を確認して処理を再開してください。');}
    const d=await readDocument(data.document_id,signal);patch(job.key,{document:d,stage:'pending',file:undefined,message:'暗号化して受付済みです。安全性検査・閲覧用変換の完了をお待ちください。'});return d;
   }
   patch(job.key,{stage:receipt.state==='rejected'?'expired':'unrecorded',message:'受付予約を復元しました。受領未完了なら、元のファイルを再選択して同じ操作で再開してください。'});return null;
  }
  const d=await readDocument(data.document_id,signal);setMessage('受付済みの書類を確認しました。再アップロードはしていません。');patch(job.key,{document:d,stage:stageOf(d),file:undefined,message:d.rejection_code?reasons[d.rejection_code]:undefined});return d;
 }
 async function sendOne(job:Upload,signal:AbortSignal):Promise<boolean>{
  if(!job.file||!job.hash)return false;
  if(await fingerprint(job.file)!==job.hash){patch(job.key,{stage:'uncertain',message:'元のファイルと一致しません。受付結果を確認してください。'});return false;}
  patch(job.key,{stage:'sending',message:undefined});
  if(encrypted){
   const receipt=await encryptedUpload(candidate,job.key,job.kind,job.file,me.csrf_token,signal);
   const d=await readDocument(receipt.document_id,signal);addDocument(d);patch(job.key,{document:d,stage:'pending',file:undefined,message:'暗号化して受付済みです。安全性検査・閲覧用変換の完了をお待ちください。'});setMessage('暗号文を受け付けました。未検査のため閲覧・推薦はできません。');return true;
  }
  const body=new FormData();body.append('fictional_confirmed','true');body.append('document_kind',job.kind);body.append('file',job.file);
  const r=await fetch(`/api/v1/candidates/${candidate}/documents`,{method:'POST',body,signal,headers:{'X-CSRF-Token':me.csrf_token,'Idempotency-Key':job.key}});const data=await r.json().catch(()=>null);
  if(r.status===401){void onUnauthorized();throw Error('再ログイン後、復帰リンクから受付結果を確認してください。');}
  if(r.ok){const d=data as DocumentData;addDocument(d);patch(job.key,{document:d,stage:stageOf(d),file:undefined});setMessage(d.available?'書類を登録しました。':'検査・復旧待ちです。受付済みIDから状態を確認できます。');return d.available;}
  if(data?.error?.document_id){const d=await readDocument(data.error.document_id,signal);patch(job.key,{document:d,stage:stageOf(d),file:undefined,message:data.error.message});}
  else patch(job.key,{stage:data?.error?.code==='OPERATION_RESULT_EXPIRED'?'expired':'uncertain',message:data?.error?.message||'受付結果を確認してから再試行してください。'});
  setMessage(data?.error?.message||'受付結果を確認してください。');return r.status===422;
 }
 async function action(work:(signal:AbortSignal)=>Promise<void>){
  if(working.current||!signedIn)return;working.current=true;setBusy(true);const abort=new AbortController();controller.current=abort;
  try{await work(abort.signal);}catch(e){if(active.current&&!abort.signal.aborted)setMessage(e instanceof Error?e.message:'接続が途切れました。受付結果を確認してください。');}
  finally{working.current=false;if(active.current)setBusy(false);}
 }
 async function sendBatch(e:FormEvent){e.preventDefault();if(!confirmed||archived||jobs.current.some(q=>['pending','checking','uncertain','unrecorded'].includes(q.stage)))return;await action(async signal=>{
  await uploadDraft.flush();
  for(const job of jobs.current.filter(v=>v.stage==='waiting')){
   try{if(!await sendOne(job,signal))break;}
   catch(e){patch(job.key,{stage:'uncertain',message:'応答を確認できません。元の操作キーで受付結果を照合してください。'});throw e;}
  }
  if(active.current&&input.current)input.current.value='';
 });}
 async function recover(job:Upload,retry=false){await action(async signal=>{
  const d=await reconcile(job,signal);
  const current=jobs.current.find(v=>v.key===job.key);
  if(!retry||!current||current.stage==='expired')return;
  if(d?.status==='pending'&&d.retry_allowed){await retryDocument(d,false,signal);return;}
  if(!d&&current.stage==='unrecorded'&&current.file&&confirmed&&!archived)await sendOne(current,signal);
 });}
 async function retryDocument(d:DocumentData,recheck:boolean,signal:AbortSignal){
  let key=rechecks.current.get(d.id);if(!key){key=crypto.randomUUID();rechecks.current.set(d.id,key);}
  const r=await fetch(`/api/v1/documents/${d.id}/${recheck?'recheck':'retry'}`,{method:'POST',signal,headers:{'X-CSRF-Token':me.csrf_token,...(recheck?{'Idempotency-Key':key}:{})}});const data=await r.json().catch(()=>null);
  if(r.status===401){void onUnauthorized();throw Error('再ログイン後、受付結果を確認してください。');}
  if(!r.ok){setMessage(data?.error?.message||'検査を完了できませんでした。');return;}
  addDocument(data);update(q=>q.map(v=>v.document?.id===d.id?{...v,document:data,stage:stageOf(data)}:v));setMessage(data.available?'書類を登録しました。':'処理中です。状態を確認してください。');
 }
 if(!signedIn)return null;
 return <section className="documents" aria-labelledby="documents-title"><h3 id="documents-title">履歴書・職務経歴書</h3>
 <p className="hint">架空情報のみ。PDF／XLSXは各10MiB以内、1回10件まで順番に登録します。PDFは1〜20ページ、XLSXはSheets由来が初期対応です。旧版・提出済みの書類は上書きしません。</p>
 <p><a href="/sample-resume.pdf" download>架空レジュメのサンプルPDF</a></p>
 <DraftStatus draft={uploadDraft}/>
 {message&&<p className="notice" role="status">{message}</p>}
 {items.length===0?<p>書類はまだ登録されていません。</p>:(Object.keys(kinds) as Kind[]).map(k=><section key={k} aria-label={kinds[k]+'の版一覧'}><h4>{kinds[k]}</h4>{!items.some(d=>d.document_kind===k)?<p className="hint">まだ登録されていません。</p>:<ul className="records">{items.filter(d=>d.document_kind===k).sort((a,b)=>b.document_version-a.document_version).map(d=><li key={d.id}><strong className="prose">{d.original_name}</strong><p>第{d.document_version}版 · {d.file_format.toUpperCase()} · {Math.ceil(d.size_bytes/1024)}KiB · {documentTime(d.created_at)}</p><p>{d.available?'登録完了':d.inspection_state==='blocked'?'利用停止':d.status==='rejected'?'登録拒否':d.status==='ready'?'追加検査待ち':'処理中'}</p>{d.rejection_code&&<p>{reasons[d.rejection_code]||reasons.PDF_REJECTED}</p>}<div className="actions">{d.available&&d.view_prepared&&<SafeView url={`/api/v1/documents/${d.id}/view`} onUnauthorized={onUnauthorized}/>}{d.available&&!d.view_prepared&&<p className="hint">閲覧用の準備が必要です。旧書類は移行を行うまで閲覧できません。</p>}{d.status==='pending'&&d.retry_allowed&&<button type="button" disabled={busy} onClick={()=>void action(signal=>retryDocument(d,false,signal))}>処理を再試行する</button>}{d.status==='ready'&&!d.encrypted_transport&&!d.available&&d.inspection_state!=='blocked'&&<button type="button" disabled={busy} onClick={()=>void action(signal=>retryDocument(d,true,signal))}>追加検査を実行する</button>}</div></li>)}</ul>}</section>)}
 {queue.length>0&&<section aria-label="書類の受付状況"><h4>書類の受付状況</h4><p className="hint">確認後の再試行も元の操作キーを使います。送信前のファイルは、この画面を閉じると保持できません。</p><ol className="records">{queue.map(q=><li key={q.key}><strong>受付：{q.name||q.document?.original_name||q.key.slice(0,8)}</strong><p>{kinds[q.kind]} · {stages[q.stage]}</p>{q.message&&<p>{q.message}</p>}{q.document&&<p>受付済みID：{q.document.id}</p>}{!['waiting','sending','complete','rejected','expired'].includes(q.stage)&&<div className="actions"><button type="button" disabled={busy} onClick={()=>void recover(q)}>受付結果を確認する</button>{(q.document?.retry_allowed||q.file)&&<button type="button" disabled={busy||(!q.document&&!confirmed)} onClick={()=>void recover(q,true)}>受付結果を確認して再試行する</button>}</div>}</li>)}</ol><button type="button" disabled={busy} onClick={()=>void action(async signal=>{for(const q of jobs.current)await reconcile(q,signal);})}>受付結果をまとめて確認する</button></section>}
 {recovery&&<details><summary>再起動後の受付結果を確認する</summary><p className="hint">このリンクを保存し、再ログイン後に開いて受付結果を確認してください。リンクだけでは書類を取得できません。受付情報は本人用の下書きへ保存します。ファイル本体は保存しないため、未受領の場合は再選択してください。</p><a href={recovery}>受付結果の復帰リンク</a></details>}
 {!archived&&<form onSubmit={sendBatch}><fieldset disabled={busy||!uploadDraft.ready}><legend>架空の書類を登録する</legend><label className="check"><input type="checkbox" checked={encrypted} disabled={queue.length>0} onChange={e=>setEncrypted(e.target.checked)}/>暗号化受付を使う（検査・閲覧用変換を行います）</label><p className="hint">暗号化受付が標準です。解除すると既存デモの平文検査経路を使います。架空情報専用で、外部公開はできません。</p><label htmlFor="document-kind">書類の種類</label><select id="document-kind" value={kind} onChange={e=>setKind(e.target.value as Kind)}>{Object.entries(kinds).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select><label>PDF／XLSXファイル<input ref={input} type="file" multiple accept="application/pdf,.pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xlsx" onChange={e=>void choose(e.target.files)}/></label><label className="check"><input type="checkbox" checked={confirmed} required onChange={e=>setConfirmed(e.target.checked)}/>書類の内容はすべて架空の情報です</label><button disabled={!queue.some(q=>q.stage==='waiting')||queue.some(q=>['pending','checking','uncertain','unrecorded'].includes(q.stage))||!confirmed||busy} type="submit">{busy?'処理中…':'書類を登録する'}</button></fieldset></form>}
 </section>;
}
