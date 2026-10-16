'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { usePathname } from 'next/navigation';
import Documents, {type DocumentData} from './documents';
import {useDraft,DraftStatus} from './drafts';
export type Member = {
    user: {
        id: string;
    };
    organization: {
        id: string;
        kind: 'agency' | 'employer';
    };
    csrf_token: string;
};
type RecordData = {
    id: string;
    title?: string;
    description?: string;
    location?: string;
    employment_type?: string;
    employer_name?: string;
    name?: string;
    summary?: string;
    status?: string;
    archived_at?: string | null;
    version: number;
    favorited?: boolean;
    documents?: DocumentData[];
};
type Filters = {
    q: string;
    location: string;
    employment_type: string;
    favorited: boolean;
    archived: boolean;
};
const emptyFilters: Filters = { q: '', location: '', employment_type: '', favorited: false, archived: false };
const labels: Record<string, string> = { draft: '下書き', published: '公開中', closed: '募集終了', full_time: '正社員', contract: '契約社員', part_time: 'パート・アルバイト' };
export default function Business({ me, signedIn = true, onUnauthorized }: {
    me: Member;
    signedIn?: boolean;
    onUnauthorized: () => Promise<void>;
}) {
    const pathname = usePathname();
    const parts = pathname.split('/').filter(Boolean);
    const jobs = parts[0] !== 'candidates';
    const id = parts[1] && parts[1] !== 'new' ? parts[1] : null;
    const editing = parts[1] === 'new' || parts[2] === 'edit';
    const detail = !!id && !editing;
    const agency = me.organization.kind === 'agency';
    const base = jobs ? '/jobs' : '/candidates';
    const [items, setItems] = useState<RecordData[]>([]), [record, setRecord] = useState<RecordData | null>(null), [form, setForm] = useState<Record<string, string>>({});
    const [filters, setFilters] = useState<Filters>(emptyFilters), [applied, setApplied] = useState<Filters>(emptyFilters), [cursor, setCursor] = useState<string | null>(null), [next, setNext] = useState<string | null>(null);
    const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(''), [reload, setReload] = useState(0), [confirmed, setConfirmed] = useState(false), [conflict, setConflict] = useState(false), [expired, setExpired] = useState(false);
    const generation = useRef(0), alive = useRef(true), mutation = useRef<AbortController | null>(null), idem = useRef<{
        body: string;
        key: string;
        request?:object;
    } | null>(null);
    const allowed = jobs || agency;
    const draft=useDraft({me,paused:busy,enabled:signedIn&&allowed&&editing&&!loading,kind:jobs?(id?'job_edit':'job_new'):(id?'candidate_edit':'candidate_new'),target:id,base:id?record?.version:null,payload:form,restore:p=>{setForm({...Object.fromEntries((jobs?['title','description','location','employment_type']:['name','summary']).map(k=>[k,String((record as Record<string,unknown>|null)?.[k]??(k==='employment_type'?'full_time':''))])),...Object.fromEntries(Object.entries(p).filter(([k])=>k!=='view'))} as Record<string,string>);setConfirmed(false);},unauthorized:onUnauthorized});
    const filterDraft=useDraft({me,enabled:signedIn&&allowed&&!editing&&!detail,kind:jobs?'job_filters':'candidate_filters',payload:{...filters,cursor:cursor||''},restore:p=>{const next={...emptyFilters,...Object.fromEntries(Object.entries(p).filter(([k])=>!['view','cursor'].includes(k)))} as Filters;setFilters(next);setApplied(next);setCursor(typeof p.cursor==='string'?p.cursor||null:null);},unauthorized:onUnauthorized});

    useEffect(() => { if (!signedIn) {
        mutation.current?.abort();
        generation.current += 1;
        setExpired(true);
        setItems([]);
        setForm({});
        setFilters(emptyFilters);setApplied(emptyFilters);setCursor(null);idem.current=null;
        setRecord(null);
        setBusy(false);
        setError('ログインを確認できません。入力を非表示にしました。保存済みの下書きは再ログイン後に復元できます。');
    } }, [signedIn]);
    useEffect(() => { alive.current = true; return () => { alive.current = false; mutation.current?.abort(); }; }, []);
    useEffect(() => {
        if (!signedIn)
            return;
        const current = ++generation.current;
        const abort = new AbortController();
        setError('');
        setConflict(false);
        setExpired(false);
        setRecord(null);
        setLoading(true);
        if (!allowed) {
            setError('この利用区分では候補者を閲覧できません。');
            setLoading(false);
            return () => abort.abort();
        }
        if (editing && !id) {
            setForm(jobs ? { title: '', description: '', location: '', employment_type: 'full_time' } : { name: '', summary: '' });
            setLoading(false);
            return () => abort.abort();
        }
        const query = new URLSearchParams();
        if (!id) {
            if (applied.q)
                query.set('q', applied.q);
            if (jobs) {
                if (applied.location)
                    query.set('location', applied.location);
                if (applied.employment_type)
                    query.set('employment_type', applied.employment_type);
                if (applied.favorited && agency)
                    query.set('favorited', 'true');
            }
            else
                query.set('archived', String(applied.archived));
            if (cursor)
                query.set('cursor', cursor);
        }
        void (async () => {
            try {
                const r = await fetch('/api/v1' + base + (id ? '/' + id : '?' + query), { cache: 'no-store', signal: abort.signal });
                if (abort.signal.aborted || current !== generation.current)
                    return;
                if (!r.ok) {
                    if (r.status === 401) {
                        setExpired(true);
                        void onUnauthorized();
                    }
                    setError(r.status === 404 ? '見つからない、または閲覧できません。' : r.status === 401 ? 'ログインの有効期限が切れています。' : '読み込めませんでした。再読み込みしてください。');
                    return;
                }
                const data = await r.json();
                if (abort.signal.aborted || current !== generation.current)
                    return;
                if (id) {
                    setRecord(data);
                    setForm(jobs ? { title: data.title, description: data.description, location: data.location, employment_type: data.employment_type } : { name: data.name, summary: data.summary });
                }
                else {
                    setItems(data.items);
                    setNext(data.next_cursor);
                }
            }
            catch {
                if (!abort.signal.aborted && current === generation.current)
                    setError('接続できませんでした。再読み込みしてください。');
            }
            finally {
                if (!abort.signal.aborted && current === generation.current)
                    setLoading(false);
            }
        })();
        return () => abort.abort();
    }, [pathname, base, id, jobs, editing, allowed, agency, applied, cursor, reload, signedIn, onUnauthorized]);
    async function change(path: string, method: string, body?: object) {
        if (busy || expired)
            return;
        setBusy(true);
        setError('');
        setConflict(false);
        const signature = JSON.stringify([path, method, body]);
        if (idem.current?.body !== signature)
            idem.current = { body: signature, key: crypto.randomUUID() };
        const abort = new AbortController();
        mutation.current = abort;
        try {
            if(editing&&body&&!idem.current.request){const meta=await draft.flush();idem.current.request={...body,...meta,operation_id:idem.current.key};}
            const submitted=editing?idem.current.request:body;
            const r = await fetch('/api/v1' + path, { method, credentials: 'same-origin', signal: abort.signal, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token, ...(method === 'POST' ? { 'Idempotency-Key': idem.current.key } : {}) }, ...(body ? { body: JSON.stringify(submitted) } : {}) });
            if (!alive.current || abort.signal.aborted)
                return;
            if (!r.ok) {
                const data = await r.json().catch(() => null);
                if (r.status === 401) {
                    setExpired(true);
                    void onUnauthorized();
                    setError('ログインを確認できません。入力を非表示にしました。保存済みの下書きは再ログイン後に復元できます。');
                }
                else if (r.status === 409) {
                    setConflict(true);
                    setError(data?.error?.code === 'IDEMPOTENCY_MISMATCH' ? '同じ操作キーで内容が変わっています。' : '情報が変更されています。入力を控えたうえで最新情報を読み直してください。');
                }
                else
                    setError(data?.error?.message || '操作を完了できませんでした。');
                return;
            }
            idem.current = null;
            if(editing)draft.consumed();
            if (r.status === 204) {
                setRecord(previous => previous ? { ...previous, favorited: method === 'PUT' } : previous);
                setError(method === 'PUT' ? '求人を保存しました。' : '保存を解除しました。');
            }
            else {
                const data = await r.json();
                if (!alive.current || abort.signal.aborted)
                    return;
                if (editing) {
                    window.location.assign(base + '/' + data.id);
                }
                else {
                    setRecord(data);
                    setError('変更を保存しました。');
                }
            }
        }
        catch (e) {
            if (alive.current && !abort.signal.aborted) {
                const code=(e as {code?:string}).code;if(code){setError(e instanceof Error?e.message:'下書きを確認してください。');if(['DRAFT_VERSION_CONFLICT','DRAFT_CONTEXT_CHANGED'].includes(code))setConflict(true);}else
                setError('接続が途切れました。結果を一覧で確認するか、同じボタンで再試行してください。POSTは同じ操作キーを使います。');}
        }
        finally {
            if (alive.current)
                setBusy(false);
        }
    }
    function save(e: FormEvent) { e.preventDefault(); if (!jobs && !id && !confirmed) {
        setError('架空データの確認が必要です。');
        return;
    } void change(base + (id ? '/' + id : ''), id ? 'PATCH' : 'POST', { ...form, ...(id ? { version: record?.version } : {}), ...(!jobs && !id ? { fictional_confirmed: confirmed } : {}) }); }
    const title = jobs ? (agency ? '求人を探す' : '自社求人') : '候補者';
    if (!signedIn && !editing)
        return null;
    return <section className="workspace" aria-labelledby="workspace-title">
    {signedIn && <nav aria-label="業務メニュー"><a href="/jobs" aria-current={jobs ? 'page' : undefined}>{agency ? '求人' : '自社求人'}</a>{agency && <a href="/candidates" aria-current={!jobs ? 'page' : undefined}>候補者</a>}<a href="/applications">推薦</a><a href="/notifications">通知モック</a></nav>}
    <div className="section-title"><h2 id="workspace-title">{editing ? (id ? '編集する' : jobs ? '求人を登録する' : '候補者を登録する') : detail ? (record?.title || record?.name || '詳細') : title}</h2>{!id && !editing && allowed && (!jobs || !agency) && <a className="button" href={base + '/new'}>{jobs ? '求人を登録する' : '候補者を登録する'}</a>}</div>
    {error && <div className="notice" role="alert"><p>{error}</p>{conflict && <p>現在の入力は自動で上書きしません。</p>}{!expired && <button type="button" className="secondary" onClick={() => {if(conflict)draft.prepareFresh();setReload(v => v + 1);}}>{conflict ? '最新情報を読み直す' : '再読み込み'}</button>}{expired && <a href="/auth/login">再ログインする</a>}</div>}
    {loading ? <p role="status">読み込んでいます…</p> : !allowed ? null : editing ? <form className="editor" onSubmit={save}><DraftStatus draft={draft}/>
      <fieldset disabled={busy || !draft.ready || expired || !!record?.archived_at || record?.status === 'closed'}><legend>{jobs ? '求人の内容' : '架空候補者の情報'}</legend>
      {(jobs ? [['title', '求人名', 200], ['description', '仕事内容', 10000], ['location', '勤務地', 200]] : [['name', '架空氏名', 100], ['summary', '経歴の概要', 10000]]).map(([key, label, max]) => <label key={key}> {label}<span className="hint">必須・{max}文字以内</span>{key === 'description' || key === 'summary' ? <textarea name={String(key)} required maxLength={Number(max)} rows={7} value={form[key] || ''} onChange={e => setForm(v => ({ ...v, [key]: e.target.value }))}/> : <input name={String(key)} required maxLength={Number(max)} value={form[key] || ''} onChange={e => setForm(v => ({ ...v, [key]: e.target.value }))}/>}</label>)}
      {jobs && <label>雇用形態<select name="employment_type" value={form.employment_type || 'full_time'} onChange={e => setForm(v => ({ ...v, employment_type: e.target.value }))}>{['full_time', 'contract', 'part_time'].map(v => <option key={v} value={v}>{labels[v]}</option>)}</select></label>}
      {!jobs && !id && <label className="check"><input type="checkbox" required checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>氏名・経歴はすべて架空のデータです</label>}
      <div className="actions"><button type="submit">{busy ? '保存中…' : jobs && !id ? '下書き保存' : '保存する'}</button><a href={id ? base + '/' + id : base}>戻る</a></div></fieldset>
    </form> : detail && record ? <article className="detail">
      <div className="metadata"><span className="badge">{jobs ? labels[record.status || ''] : record.archived_at ? 'アーカイブ済み' : '登録済み'}</span><span>更新版 {record.version}</span></div>
      {jobs ? <><p>{record.employer_name}</p><dl><div><dt>勤務地</dt><dd>{record.location}</dd></div><div><dt>雇用形態</dt><dd>{labels[record.employment_type || '']}</dd></div></dl><h3>仕事内容</h3><p className="prose">{record.description}</p></> : <><h3>経歴の概要</h3><p className="prose">{record.summary}</p><Documents key={record.id} candidate={record.id} initial={record.documents || []} archived={!!record.archived_at} me={me} signedIn={signedIn} onUnauthorized={onUnauthorized}/></>}
      <div className="actions">{jobs && agency && <a className="button" href={'/applications/new?job_id='+record.id}>この求人に推薦する</a>}{(jobs && !agency && record.status !== 'closed' || !jobs && !record.archived_at) && <a className="button secondary" href={base + '/' + id + '/edit'}>編集する</a>}
      {jobs && !agency && record.status !== 'closed' && <button disabled={busy || expired} onClick={() => { if (record.status === 'published' && !window.confirm('募集を終了します。公開求人から非表示になり、再公開はできません。'))
            return; void change(base + '/' + id + '/status', 'POST', { version: record.version, status: record.status === 'draft' ? 'published' : 'closed' }); }}>{record.status === 'draft' ? '公開する' : '募集を終了する'}</button>}
      {jobs && agency && <button disabled={busy || expired} onClick={() => void change(base + '/' + id + '/favorite', record.favorited ? 'DELETE' : 'PUT')}>{record.favorited ? '保存を解除する' : '求人を保存する'}</button>}
      {!jobs && !record.archived_at && <button disabled={busy || expired} className="secondary" onClick={() => { if (window.confirm('候補者をアーカイブします。元に戻せず、編集できなくなります。'))
            void change(base + '/' + id + '/archive', 'POST', { version: record.version }); }}>アーカイブする</button>}
      <a href={base}>一覧へ戻る</a></div>
    </article> : !id ? <>
      <DraftStatus draft={filterDraft}/><form className="filters" onSubmit={e => { e.preventDefault(); void filterDraft.flush().then(()=>{setCursor(null);setApplied({...filters});}).catch(()=>undefined); }}><label>検索<input name="q" maxLength={100} value={filters.q} onChange={e => setFilters(v => ({ ...v, q: e.target.value }))} placeholder={jobs ? '求人名・仕事内容' : '氏名・経歴'}/></label>
        {jobs && <><label>勤務地<input maxLength={100} value={filters.location} onChange={e => setFilters(v => ({ ...v, location: e.target.value }))}/></label><label>雇用形態<select value={filters.employment_type} onChange={e => setFilters(v => ({ ...v, employment_type: e.target.value }))}><option value="">すべて</option>{['full_time', 'contract', 'part_time'].map(v => <option key={v} value={v}>{labels[v]}</option>)}</select></label></>}
        {(agency || !jobs) && <label className="check"><input type="checkbox" checked={jobs ? filters.favorited : filters.archived} onChange={e => setFilters(v => ({ ...v, [jobs ? 'favorited' : 'archived']: e.target.checked }))}/>{jobs ? '保存した求人のみ' : 'アーカイブ済みのみ'}</label>}
        <div className="actions"><button type="submit">検索する</button><button className="secondary" type="button" onClick={() => { setFilters(emptyFilters); setApplied({ ...emptyFilters }); setCursor(null); }}>条件を解除</button></div>
      </form><p className="hint">{jobs && agency ? '公開中の求人だけを表示しています。保存は同じ紹介会社の利用者で共有されます。' : jobs ? '自社の求人だけを表示しています。' : '自社の架空候補者だけを表示しています。'}</p>
      {items.length === 0 ? <div className="empty"><h3>該当する{jobs ? '求人' : '候補者'}がありません</h3><p>検索条件を解除するか、新しいデータを登録してください。</p></div> : <ul className="records">{items.map(v => <li key={v.id}><a href={base + '/' + v.id}><span className="record-title">{v.title || v.name}</span><span>{jobs ? v.employer_name : v.summary?.slice(0, 100)}</span><span className="hint">{jobs ? `${v.location} · ${labels[v.employment_type || '']} · ${labels[v.status || '']}${v.favorited ? ' · 保存済み' : ''}` : v.archived_at ? 'アーカイブ済み' : '登録済み'}</span></a></li>)}</ul>}
      <div className="actions">{next && <button className="secondary" onClick={() => setCursor(next)}>次のページ</button>}{cursor && <button className="secondary" onClick={() => setCursor(null)}>先頭に戻る</button>}</div>
    </> : null}
  </section>;
}
