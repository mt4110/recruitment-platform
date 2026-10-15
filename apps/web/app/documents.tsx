'use client';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import type {Member} from './business';
export type DocumentData={id:string;original_name:string;size_bytes:number;status:'pending'|'ready'|'rejected';rejection_code:string|null;retry_allowed:boolean;available:boolean;format_checked:boolean;file_format:'pdf'|'xlsx';document_kind:'resume'|'career_history'|'other'};
const reasons:Record<string,string>={UNSUPPORTED_STRUCTURE:'未対応のXLSX構造です。外部リンクを外して保存するか、PDFへ書き出してください。',UNSUPPORTED_FORMULA:'未対応の数式です。数式を値にするか、PDFへ書き出してください。',STRUCTURE_LIMIT:'XLSXの展開量や構造が上限を超えています。',CANDIDATE_ARCHIVED:'候補者がアーカイブされたため登録できません。',UPLOAD_INTERRUPTED:'保存が中断されました。新しい操作で登録してください。',ENCRYPTED:'暗号化せずにPDFを書き出してください。',PAGES:'1〜20ページにしてください。',PDF_STRUCTURE_UNSUPPORTED:'対応していないPDF構造です。サンプルPDFでお試しください。',PDF_REJECTED:'リンクやフォームを含めずPDFを書き出してください。'};
export default function Documents({candidate,initial,archived,me,signedIn,onUnauthorized}:{candidate:string;initial:DocumentData[];archived:boolean;me:Member;signedIn:boolean;onUnauthorized:()=>Promise<void>}){
 const [items,setItems]=useState(initial),[file,setFile]=useState<File|null>(null),[kind,setKind]=useState('other'),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const input=useRef<HTMLInputElement|null>(null);
 const key=useRef<string|null>(null),active=useRef(true),controller=useRef<AbortController|null>(null);
 useEffect(()=>{active.current=true;return()=>{active.current=false;controller.current?.abort();};},[]);
 useEffect(()=>{setItems(initial);},[initial]);
 useEffect(()=>{if(!signedIn){controller.current?.abort();setItems([]);setFile(null);key.current=null;}},[signedIn]);
 useEffect(()=>{
  if(!signedIn||!items.some(d=>d.status==='pending'&&!d.format_checked))return;
  const abort=new AbortController();let loading=false;
  const timer=setInterval(()=>{if(loading)return;loading=true;void(async()=>{
   try{for(const d of items.filter(d=>d.status==='pending')){
    const r=await fetch('/api/v1/documents/'+d.id,{cache:'no-store',signal:abort.signal});
    if(r.status===401){void onUnauthorized();break;}
    if(r.ok){const next=await r.json();if(!abort.signal.aborted)setItems(v=>v.map(x=>x.id===d.id?next:x));}
   }}catch{ /* Keep pending visible; user can refresh after connectivity returns. */ }finally{loading=false;}
  })();},2000);return()=>{clearInterval(timer);abort.abort();};
 },[items,signedIn,onUnauthorized]);
 async function send(e?:FormEvent,id?:string){
  e?.preventDefault();if(busy||!signedIn||(!id&&(!file||!confirmed||archived)))return;
  setBusy(true);setMessage('');const abort=new AbortController();controller.current=abort;
  try{
   let body:FormData|undefined;
   if(!id){body=new FormData();body.append('fictional_confirmed','true');body.append('document_kind',kind);body.append('file',file!);key.current??=crypto.randomUUID();}
   const r=await fetch(id?`/api/v1/documents/${id}/retry`:`/api/v1/candidates/${candidate}/documents`,{method:'POST',body,signal:abort.signal,headers:{'X-CSRF-Token':me.csrf_token,...(!id?{'Idempotency-Key':key.current!}:{})}});
   const data=await r.json().catch(()=>null);if(!active.current||abort.signal.aborted)return;
   if(r.status===401){void onUnauthorized();setMessage('再ログイン後はファイルを選び直してください。');return;}
   if(!r.ok){if(data?.error?.document_id){const status=await fetch('/api/v1/documents/'+data.error.document_id,{cache:'no-store',signal:abort.signal});if(status.status===401){void onUnauthorized();}if(status.ok){const d=await status.json();if(active.current&&!abort.signal.aborted)setItems(v=>[d,...v.filter(x=>x.id!==d.id)]);}}setMessage(data?.error?.message||'登録できませんでした。状態を確認して再試行してください。');return;}
   setItems(v=>[data,...v.filter(d=>d.id!==data.id)]);setMessage(data.available?'書類を登録しました。':data.format_checked?'形式検査が完了しました。ウイルス検査待ちのため、ダウンロード・推薦はできません。':'検査・復旧の処理中です。状態は自動で確認します。');
   if(!id){key.current=null;setFile(null);setConfirmed(false);if(input.current)input.current.value='';}
  }catch{if(active.current&&!abort.signal.aborted)setMessage('接続が途切れました。同じファイルで再試行すると同じ操作キーを使います。');}
  finally{if(active.current)setBusy(false);}
 }
 if(!signedIn)return null;
 return <section className="documents" aria-labelledby="documents-title"><h3 id="documents-title">履歴書・職務経歴書</h3><p className="hint">架空情報のみ。PDF／XLSXは10MiB以内。PDFは1〜20ページ、XLSXはSheets由来を初期対応とします。外部リンク・埋め込み・暗号化などを含む書類は登録できません。</p><p><a href="/sample-resume.pdf" download>架空レジュメのサンプルPDF</a></p>
 {message&&<p className="notice" role="status">{message}</p>}
 {items.length===0?<p>書類はまだ登録されていません。</p>:<ul className="records">{items.map(d=><li key={d.id}><strong className="prose">{d.original_name}</strong><p>{d.available?'登録完了':d.status==='rejected'?'登録拒否':d.format_checked||d.status==='ready'?'追加検査待ち':'処理中'} · {Math.ceil(d.size_bytes/1024)}KiB</p>{d.rejection_code&&<p>{reasons[d.rejection_code]||reasons.PDF_REJECTED}</p>}<div className="actions">{d.available&&<a className="button secondary" href={`/api/v1/documents/${d.id}/content`}>{d.file_format.toUpperCase()}をダウンロード</a>}{d.status==='pending'&&!d.format_checked&&d.retry_allowed&&<button type="button" disabled={busy} onClick={()=>void send(undefined,d.id)}>処理を再試行する</button>}</div></li>)}</ul>}
 {!archived&&<form onSubmit={send}><fieldset disabled={busy}><legend>架空の書類を登録する</legend><label htmlFor="document-kind">書類の種類</label><select id="document-kind" value={kind} onChange={e=>{setKind(e.target.value);key.current=null;}}><option value="resume">履歴書</option><option value="career_history">職務経歴書</option><option value="other">その他</option></select><label>PDF／XLSXファイル<input ref={input} type="file" accept="application/pdf,.pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xlsx" onChange={e=>{const next=e.target.files?.[0]||null;key.current=null;if(next&&next.size>10*1024*1024){setFile(null);setMessage('書類は10MiB以内にしてください。');}else{setFile(next);setMessage('');}}}/></label><label className="check"><input type="checkbox" checked={confirmed} required onChange={e=>setConfirmed(e.target.checked)}/>書類の内容はすべて架空の情報です</label><button disabled={!file||!confirmed||busy} type="submit">{busy?'登録中…':'書類を登録する'}</button></fieldset></form>}
 </section>;
}
