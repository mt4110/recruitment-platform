'use client';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {usePathname} from 'next/navigation';
import type {Member} from './business';
import {documentLabel,kinds,type DocumentInfo} from './document-info';
type FileInfo=DocumentInfo & {status?:string};
type Candidate={id:string;name:string;summary:string;version:number;archived_at:string|null;documents:FileInfo[]};
type Job={id:string;title:string;description:string;employer_name:string;version:number};
type Application={id:string;candidate_id?:string;job_id:string;reason?:string;status:string;version:number;sharing_active:boolean;share_revoked_at:string|null;job_snapshot?:{title:string;description:string;location:string;employment_type:string;agency_name:string;employer_name:string};candidate_snapshot?:{name:string;summary:string};documents?:FileInfo[];events:{id:string;event_type:string;from_status:string;to_status:string;reason?:string;created_at:string}[];placement?:{id:string;decided_at:string;demo_fee_yen:number}};
type Item={id:string;status:string;version:number;candidate_name?:string;job_title?:string};
const labels:Record<string,string>={draft:'下書き',submitted:'提出済み',screening:'選考中',rejected:'不採用',hired:'採用決定',withdrawn:'辞退'};
const when=(s:string)=>new Intl.DateTimeFormat('ja-JP',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Tokyo'}).format(new Date(s));
export default function Applications({me,signedIn,onUnauthorized}:{me:Member;signedIn:boolean;onUnauthorized:()=>Promise<void>}){
 const pathname=usePathname(),parts=pathname.split('/').filter(Boolean),creating=parts[1]==='new',id=parts[1]&&!creating?parts[1]:null,agency=me.organization.kind==='agency';
 const [record,setRecord]=useState<Application|null>(null),[items,setItems]=useState<Item[]>([]),[candidates,setCandidates]=useState<Candidate[]>([]),[candidate,setCandidate]=useState<Candidate|null>(null),[job,setJob]=useState<Job|null>(null);
 const [jobId,setJobId]=useState(''),[candidateId,setCandidateId]=useState(''),[reason,setReason]=useState(''),[note,setNote]=useState(''),[selected,setSelected]=useState<string[]>([]),[fictional,setFictional]=useState(false),[consent,setConsent]=useState(false);
 const [status,setStatus]=useState(''),[applied,setApplied]=useState(''),[cursor,setCursor]=useState<string|null>(null),[next,setNext]=useState<string|null>(null),[query,setQuery]=useState('');
 const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[message,setMessage]=useState(''),[contextError,setContextError]=useState(''),[conflict,setConflict]=useState(false),[reload,setReload]=useState(0);
 const draftInput=useRef(false);
 const alive=useRef(true),generation=useRef(0),mutation=useRef<AbortController|null>(null),latest=useRef<Application|null>(null),idem=useRef<{signature:string;key:string}|null>(null);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;mutation.current?.abort();};},[]);
 useEffect(()=>{if(!signedIn){mutation.current?.abort();generation.current++;setRecord(null);latest.current=null;setItems([]);setCandidate(null);setCandidates([]);setJob(null);setSelected([]);setNote('');setBusy(false);setMessage('ログインを確認できません。再ログイン後は再入力が必要です。');}},[signedIn]);
 useEffect(()=>{
  if(!signedIn)return;
  const abort=new AbortController(),epoch=++generation.current;
  setLoading(true);setMessage('');setContextError('');setConflict(false);setRecord(null);latest.current=null;setCandidate(null);setJob(null);setSelected([]);setConsent(false);setFictional(false);
  async function get(url:string){const r=await fetch('/api/v1'+url,{cache:'no-store',signal:abort.signal});if(r.status===401)void onUnauthorized();if(!r.ok)throw Error(r.status===404?'見つからない、または閲覧できません。':'読み込めませんでした。再読み込みしてください。');return r.json();}
  void(async()=>{try{
   if(parts.length>2)throw Error('見つからない、または閲覧できません。');
   if(creating){if(!agency)throw Error('この利用区分では推薦を作成できません。');const target=new URLSearchParams(window.location.search).get('job_id');if(!target)throw Error('求人詳細の「この求人に推薦する」から開始してください。');setJobId(target);
    const [j,c]=await Promise.all([get('/jobs/'+encodeURIComponent(target)),get('/candidates?limit=100')]);if(abort.signal.aborted||epoch!==generation.current)return;setJob(j);setCandidates(c.items);setReason('');setCandidateId('');
   }else if(id){const data:Application=await get('/applications/'+id);if(abort.signal.aborted||epoch!==generation.current)return;setRecord(data);draftInput.current=data.status==='draft';latest.current=data;setReason(data.reason||'');setNote('');
    if(agency&&data.status==='draft'){try{const[c,j]=await Promise.all([get('/candidates/'+data.candidate_id),get('/jobs/'+data.job_id)]);if(abort.signal.aborted||epoch!==generation.current)return;setCandidate(c);setJob(j);}catch{if(!abort.signal.aborted)setContextError('候補者または求人を確認できません。募集終了・アーカイブ・接続状況を確認してください。');}}
   }else{const q=new URLSearchParams();if(applied)q.set('status',applied);if(cursor)q.set('cursor',cursor);const data=await get('/applications?'+q);if(abort.signal.aborted||epoch!==generation.current)return;setItems(data.items);setNext(data.next_cursor);}
  }catch(e){if(!abort.signal.aborted&&epoch===generation.current)setMessage(e instanceof Error?e.message:'読み込めませんでした。');}finally{if(!abort.signal.aborted&&epoch===generation.current)setLoading(false);}})();return()=>abort.abort();
 },[pathname,id,creating,agency,applied,cursor,reload,signedIn,onUnauthorized]);
 // Shared details are refreshed on focus/visibility and every two seconds. A
 // changed version clears revoked content, but never silently rebases an edit.
 useEffect(()=>{
  if(!id||!signedIn||loading)return;const abort=new AbortController();let running=false;
  async function check(){if(running||document.hidden)return;running=true;try{const r=await fetch('/api/v1/applications/'+id,{cache:'no-store',signal:abort.signal});if(r.status===401){void onUnauthorized();return;}if(r.status===404){if(!abort.signal.aborted){setRecord(null);latest.current=null;setMessage('見つからない、または閲覧できません。');}return;}if(!r.ok)return;const data:Application=await r.json();if(abort.signal.aborted||!latest.current)return;
   if(data.version!==latest.current.version){if(latest.current.status==='draft'&&agency){setConflict(true);setMessage('下書きが更新されています。入力を控えたうえで最新情報を読み直してください。');}else{latest.current=data;setRecord(data);if(!data.sharing_active&&!agency){setReason('');setNote('');setSelected([]);setCandidate(null);}}}
  }catch{/* Keep existing UI; writes still verify the current server version. */}finally{running=false;}}
  const timer=setInterval(()=>void check(),2000);const focus=()=>void check();window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);return()=>{abort.abort();clearInterval(timer);window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);};
 },[id,signedIn,loading,agency,onUnauthorized]);
 useEffect(()=>{
  if(id||creating||!signedIn||loading)return;const abort=new AbortController();let running=false;
  const refresh=async()=>{if(running||document.hidden)return;running=true;try{const q=new URLSearchParams();if(applied)q.set('status',applied);if(cursor)q.set('cursor',cursor);const r=await fetch('/api/v1/applications?'+q,{cache:'no-store',signal:abort.signal});if(r.status===401){void onUnauthorized();return;}if(r.ok){const d=await r.json();if(!abort.signal.aborted){setItems(d.items);setNext(d.next_cursor);}}}catch{/* The next refresh can recover. */}finally{running=false;}};
  const timer=setInterval(()=>void refresh(),2000),focus=()=>void refresh();window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);return()=>{abort.abort();clearInterval(timer);window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);};
 },[id,creating,signedIn,loading,applied,cursor,onUnauthorized]);
 async function searchCandidates(e:FormEvent){e.preventDefault();const abort=new AbortController();mutation.current=abort;try{const r=await fetch('/api/v1/candidates?limit=100'+(query?'&q='+encodeURIComponent(query):''),{cache:'no-store',signal:abort.signal});if(r.status===401){void onUnauthorized();return;}if(!r.ok){setMessage('候補者を検索できませんでした。');return;}const d=await r.json();if(alive.current&&!abort.signal.aborted){setCandidates(d.items);setCandidateId('');}}catch{if(alive.current&&!abort.signal.aborted)setMessage('候補者を検索できませんでした。');}}
 async function change(path:string,method:string,body:object){
  if(busy||!signedIn||conflict)return;setBusy(true);setMessage('');const signature=JSON.stringify([path,method,body]);if(idem.current?.signature!==signature)idem.current={signature,key:crypto.randomUUID()};
  const abort=new AbortController();mutation.current=abort;
  try{const r=await fetch('/api/v1'+path,{method,signal:abort.signal,headers:{'Content-Type':'application/json','X-CSRF-Token':me.csrf_token,...(method==='POST'?{'Idempotency-Key':idem.current.key}:{})},body:JSON.stringify(body)});const data=await r.json().catch(()=>null);if(!alive.current||abort.signal.aborted)return;
   if(!r.ok){if(r.status===401){void onUnauthorized();setMessage('再ログイン後は再入力が必要です。');}else{setMessage(data?.error?.message||'操作できませんでした。');if(r.status===409)setConflict(true);if(data?.error?.code==='SHARING_REVOKED'){setRecord(null);latest.current=null;setNote('');setReason('');setCandidate(null);setReload(v=>v+1);}}return;}
   idem.current=null;if(creating){window.location.assign('/applications/'+data.id);return;}latest.current=data;draftInput.current=data.status==='draft';setRecord(data);setReason(data.reason||'');setNote('');setConsent(false);setFictional(false);setSelected([]);setMessage('変更を保存しました。');
  }catch{if(alive.current&&!abort.signal.aborted)setMessage('接続が途切れました。一覧で結果を確認するか、同じ操作で再試行してください。POSTは同じ操作キーを使います。');}finally{if(alive.current)setBusy(false);}
 }
 async function submitCurrent(){
  if(!record||!candidate||!job||busy||!fictional||!consent||!selected.length)return;
  const abort=new AbortController();mutation.current=abort;setBusy(true);
  try{
   const [cr,jr]=await Promise.all([fetch('/api/v1/candidates/'+candidate.id,{cache:'no-store',signal:abort.signal}),fetch('/api/v1/jobs/'+job.id,{cache:'no-store',signal:abort.signal})]);
   if(cr.status===401||jr.status===401){void onUnauthorized();return;}
   if(!cr.ok||!jr.ok)throw Error('候補者・求人の現在の権限を確認できません。提出していません。');
   const c=await cr.json() as Candidate,j=await jr.json() as Job;
   if(!alive.current||abort.signal.aborted)return;
   if(c.version!==candidate.version||j.version!==job.version||c.archived_at||selected.some(id=>!c.documents.some(d=>d.id===id&&d.available))){
    setCandidate(c);setJob(j);setSelected(ids=>ids.filter(id=>c.documents.some(d=>d.id===id&&d.available)));setConsent(false);setFictional(false);setMessage('候補者・求人・書類の状態が変わっています。共有する版を見直して、確認し直してください。');return;
   }
   // The server checks the same immutable IDs/hash and authorization again in its transaction.
   await change('/applications/'+record.id+'/submit','POST',{version:record.version,candidate_version:c.version,job_version:j.version,document_ids:selected,fictional_confirmed:true,consent_confirmed:true});
  }catch(e){if(alive.current&&!abort.signal.aborted)setMessage(e instanceof Error?e.message:'現在の状態を確認できません。提出していません。');}
  finally{if(alive.current)setBusy(false);}
 }
 function act(action:string,to?:string){if(!record)return;if(['revoke-sharing','withdrawn','rejected'].includes(to||action)&&!note.trim()){setMessage('操作の理由を入力してください。');return;}
  if((action==='revoke-sharing'||to==='withdrawn')&&!window.confirm(record.status==='hired'||record.status==='rejected'?'候補者・書類の共有を取り消します。採用記録と選考結果は維持され、再共有できません。取得済みの書類は回収できません。':'辞退として確定し、企業の候補者・書類閲覧を止めます。取得済みの書類は回収できません。'))return;
  void change(`/applications/${record.id}/${action}`,'POST',{version:record.version,...(to?{to_status:to}:{}),...(note.trim()?{reason:note}:{})});
 }
 if(!signedIn)return creating||draftInput.current?<section className="workspace applications"><p role="alert">ログインを確認できません。入力を控えてください。再ログイン後は再入力が必要です。</p><label>推薦理由<textarea aria-label="推薦理由" disabled value={reason}/></label><a href="/auth/login">再ログインする</a></section>:null;
 return <section className="workspace applications" aria-labelledby="applications-title"><nav aria-label="業務メニュー"><a href="/jobs">{agency?'求人':'自社求人'}</a>{agency&&<a href="/candidates">候補者</a>}<a href="/applications" aria-current="page">推薦</a></nav>
 <div className="section-title"><h2 id="applications-title">{creating?'推薦の下書きを作る':id?'推薦の詳細':'推薦一覧'}</h2></div>
 {message&&<div className="notice" role="alert"><p>{message}</p><button className="secondary" onClick={()=>setReload(v=>v+1)}>最新情報を読み直す</button></div>}
 {loading?<p role="status">読み込んでいます…</p>:creating&&job?<><article className="detail"><h3>{job.title}</h3><p>{job.employer_name}</p><p className="hint">下書きは企業には公開されません。書類の種類・版と共有内容は提出時に確認します。</p></article>
 <form className="filters" onSubmit={searchCandidates}><label>候補者を検索<input maxLength={100} value={query} onChange={e=>setQuery(e.target.value)}/></label><button type="submit">候補者を検索する</button></form>
 <form className="editor" onSubmit={e=>{e.preventDefault();if(candidateId)void change('/applications','POST',{job_id:jobId,candidate_id:candidateId,reason});}}><fieldset disabled={busy}><legend>下書きの内容</legend><label>候補者<select aria-label="候補者" required value={candidateId} onChange={e=>setCandidateId(e.target.value)}><option value="">候補者を選択</option>{candidates.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><p className="hint">自社の候補者を最大100件表示します。見つからない場合は検索してください。</p><label>推薦理由<textarea aria-label="推薦理由" required maxLength={2000} rows={5} value={reason} onChange={e=>setReason(e.target.value)}/></label><button type="submit" disabled={!candidateId||!reason.trim()||conflict}>{busy?'保存中…':'下書きを保存する'}</button></fieldset></form></>:record?<article className="detail">
 <div className="metadata"><span className="badge">{labels[record.status]}</span><span>更新版 {record.version}</span></div><p className="hint">案件ID {record.id}</p>
 {record.job_snapshot&&<section><h3>{record.job_snapshot.title}</h3><p>{record.job_snapshot.agency_name} → {record.job_snapshot.employer_name}</p><p className="prose">{record.job_snapshot.description}</p><p>{record.job_snapshot.location}</p><p className="hint">提出時点の求人です。現在の求人を変更しても、この内容は変わりません。</p></section>}
 {record.status==='draft'&&agency?<><h3>推薦理由</h3><form onSubmit={e=>{e.preventDefault();void change('/applications/'+record.id,'PATCH',{version:record.version,reason});}}><label>推薦理由<textarea aria-label="推薦理由" required maxLength={2000} rows={5} disabled={busy} value={reason} onChange={e=>setReason(e.target.value)}/></label><button type="submit" disabled={busy||conflict||reason===record.reason}>理由を保存する</button></form>
 {contextError&&<p role="alert">{contextError}</p>}{candidate&&job&&<><h3>企業に共有する内容</h3><section className="share-preview"><h4>{candidate.name}</h4><p className="prose">{candidate.summary}</p><p>求人：{job.title}</p><p className="prose">推薦理由：{record.reason}</p><p className="hint">以下で選択した書類だけが企業に共有されます。</p><ul>{selected.map(id=><li key={id}>{candidate.documents.find(d=>d.id===id)?documentLabel(candidate.documents.find(d=>d.id===id)!):'利用できない書類'}</li>)}</ul></section>
 <form onSubmit={e=>{e.preventDefault();if(!candidate.archived_at&&reason===record.reason)void submitCurrent();}}><fieldset disabled={busy||conflict||!!candidate.archived_at}><legend>提出する書類と確認</legend>{candidate.documents.filter(d=>d.available).map(d=><label className="check" key={d.id}><input type="checkbox" checked={selected.includes(d.id)} onChange={e=>{setSelected(v=>e.target.checked?[...v,d.id]:v.filter(id=>id!==d.id));setConsent(false);setFictional(false);}}/>{documentLabel(d)}</label>)}{!candidate.documents.some(d=>d.available)&&<p>検査完了の書類が必要です。<a href={'/candidates/'+candidate.id}>候補者で書類を登録する</a></p>}<label className="check"><input type="checkbox" required checked={fictional} onChange={e=>setFictional(e.target.checked)}/>氏名・経歴・書類はすべて架空の情報です</label><label className="check"><input type="checkbox" required checked={consent} onChange={e=>setConsent(e.target.checked)}/>選択した架空情報を企業に共有する操作を確認しました（demo-share-v1）</label>{reason!==record.reason&&<p>推薦理由を保存してから提出してください。</p>}{candidate.archived_at&&<p>候補者はアーカイブ済みです。</p>}<button type="submit" disabled={!fictional||!consent||!selected.length||reason!==record.reason}>推薦を提出する</button></fieldset></form></>}
 </>:<>{record.candidate_snapshot&&<section aria-label="共有された候補者"><h3>{record.candidate_snapshot.name}</h3><p className="prose">{record.candidate_snapshot.summary}</p><p className="hint">提出時点の候補者情報です。</p></section>}{record.reason!==undefined&&<><h3>推薦理由</h3><p className="prose">{record.reason}</p></>}{record.documents&&<section><h3>共有書類</h3><ul>{record.documents.map(d=><li key={d.id}><span>{kinds[d.document_kind||'other']} 第{d.document_version||1}版 · {(d.file_format||'pdf').toUpperCase()} </span>{d.available?<a href={`/api/v1/applications/${record.id}/documents/${d.id}/content`}>{d.original_name}をダウンロード</a>:<span>{d.original_name}（追加検査待ち・利用不可）</span>}</li>)}</ul></section>}{!record.sharing_active&&<p className="notice">共有は失効しています。企業は候補者・書類・自由記入理由を閲覧できません。取得済みの書類は回収できません。</p>}
 {record.placement&&<p>採用記録を作成済みです。請求プレビューは次の段階で追加します。</p>}
 {(agency&&record.sharing_active||!agency&&record.sharing_active&&['submitted','screening'].includes(record.status))&&<fieldset disabled={busy||conflict}><legend>選考・共有の操作</legend><label>操作の理由<span className="hint">辞退・不採用・共有取消では必須、500文字以内</span><textarea aria-label="操作の理由" maxLength={500} rows={3} value={note} onChange={e=>setNote(e.target.value)}/></label><div className="actions">{!agency&&record.status==='submitted'&&<button onClick={()=>act('transition','screening')}>選考を開始する</button>}{!agency&&record.status==='screening'&&<button onClick={()=>act('transition','hired')}>採用を決定する</button>}{!agency&&<button className="secondary" onClick={()=>act('transition','rejected')}>不採用にする</button>}{agency&&['submitted','screening'].includes(record.status)&&<button className="secondary" onClick={()=>act('transition','withdrawn')}>辞退する</button>}{agency&&<button className="secondary" onClick={()=>act('revoke-sharing')}>共有を取り消す</button>}</div></fieldset>}
 </>}
 <h3>操作履歴</h3>{record.events.length?<ol>{record.events.map(e=><li key={e.id}><p>{e.event_type==='sharing_revoked'?'共有取消':`${labels[e.from_status]} → ${labels[e.to_status]}`} · {when(e.created_at)}</p>{e.reason!==undefined&&e.reason!==null&&<p className="prose">{e.reason}</p>}</li>)}</ol>:<p>まだ操作履歴はありません。</p>}<div className="actions"><a href="/applications">推薦一覧へ戻る</a><button className="secondary" onClick={()=>setReload(v=>v+1)}>最新情報を読み直す</button></div>
 </article>:!id&&!creating?<><form className="filters" onSubmit={e=>{e.preventDefault();setCursor(null);setApplied(status);}}><label>推薦の状態<select aria-label="推薦の状態" value={status} onChange={e=>setStatus(e.target.value)}><option value="">すべて</option>{Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label><button type="submit">絞り込む</button></form>{!items.length?<div className="empty"><p>該当する推薦はありません。</p>{agency&&<a href="/jobs">求人から推薦を作成する</a>}</div>:<ul className="records">{items.map(a=><li key={a.id}><a href={'/applications/'+a.id}><span className="record-title">{a.candidate_name||'推薦 '+a.id.slice(0,8)}</span><span>{a.job_title||'下書きの推薦'}</span><span>{labels[a.status]}</span></a></li>)}</ul>}<div className="actions">{next&&<button onClick={()=>setCursor(next)}>次のページ</button>}{cursor&&<button onClick={()=>setCursor(null)}>先頭に戻る</button>}</div></>:null}
 </section>;
}
