'use client';
import Business from './business';
import { useCallback, useEffect, useRef, useState } from 'react';
type Me = { user: { id: string; display_name: string }; organization: { id: string; name: string; kind: 'agency' | 'employer' }; expires_at: string; csrf_token: string };
type View = { phase: 'loading' | 'anonymous' | 'error' } | { phase: 'signed-in'; me: Me };
export default function Home() {
  const [view, setView] = useState<View>({ phase: 'loading' });
  const [businessMe, setBusinessMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const request = useRef<AbortController | null>(null);
  const revision = useRef(0);
  const knownSession = useRef(false);
  const channel = useRef<BroadcastChannel | null>(null);
  const loginLink = useRef<HTMLAnchorElement>(null);
  const clearSession = useCallback((notice: string) => {
    revision.current += 1;
    request.current?.abort();
    knownSession.current = false;
    setView({ phase: 'anonymous' });
    setBusinessMe(null);
    setMessage(notice);
  }, []);
  const refresh = useCallback(async () => {
    const current = ++revision.current;
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    try {
      const r = await fetch('/api/v1/me', { cache: 'no-store', credentials: 'same-origin', signal: abort.signal });
      if (abort.signal.aborted || current !== revision.current) return;
      if (r.status === 401) {
        if (knownSession.current) setMessage('ログインの有効期限が切れています。もう一度ログインしてください。');
        knownSession.current = false;
        setView({ phase: 'anonymous' });
      } else if (r.ok) {
        const me = await r.json() as Me;
        if (abort.signal.aborted || current !== revision.current) return;
        knownSession.current = true;
        setView({ phase: 'signed-in', me });
        setBusinessMe(me);
        setMessage('');
      } else setView({ phase: 'error' });
    } catch { if (!abort.signal.aborted && current === revision.current) setView({ phase: 'error' }); }
  }, []);
  useEffect(() => {
    void refresh();
    const onFocus = () => { void refresh(); };
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    if ('BroadcastChannel' in window) {
      const bc = new BroadcastChannel('recruitment-session');
      channel.current = bc;
      bc.onmessage = event => { if (event.data === 'logout') clearSession('別のタブでログアウトしました。'); };
    }
    return () => {
      revision.current += 1;
      request.current?.abort();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      channel.current?.close(); channel.current = null;
    };
  }, [refresh, clearSession]);
  const expiresAt = view.phase === 'signed-in' ? view.me.expires_at : null;
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setTimeout(() => { void refresh(); }, Math.max(0, Date.parse(expiresAt) - Date.now() + 50));
    return () => clearTimeout(timer);
  }, [expiresAt, refresh]);
  useEffect(() => { if (view.phase === 'anonymous' && message) loginLink.current?.focus(); }, [view.phase, message]);
  async function logout() {
    if (view.phase !== 'signed-in' || busy) return;
    setBusy(true); setMessage('');
    try {
      const r = await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': view.me.csrf_token } });
      if (r.ok || r.status === 401) { clearSession('ログアウトしました。'); channel.current?.postMessage('logout'); }
      else setMessage('ログアウトできませんでした。もう一度お試しください。');
    } catch { setMessage('接続できませんでした。もう一度お試しください。'); }
    finally { setBusy(false); }
  }
  return <><header><a className="brand" href="/">recruitment-platform</a><span className="badge">架空データ専用デモ</span></header>
    <main><p className="eyebrow">求人プラットフォーム</p><h1>{view.phase === 'signed-in' ? 'ログインできました' : 'ようこそ'}</h1>
      <p className="lead">紹介会社と求人企業のための、採用業務のワークスペース。</p>
      <section className="panel" aria-labelledby="account-heading"><h2 id="account-heading">アカウント</h2>
        {view.phase === 'loading' && <p role="status">ログイン状態を確認しています…</p>}
        {view.phase === 'anonymous' && <><p>用意されたデモアカウントでログインしてください。</p><a ref={loginLink} className="button" href="/auth/login">ログインする</a></>}
        {view.phase === 'error' && <div role="alert"><p>ログイン状態を確認できませんでした。</p><button onClick={() => { setView({ phase: 'loading' }); void refresh(); }}>再読み込み</button></div>}
        {view.phase === 'signed-in' && <><dl><div><dt>所属組織</dt><dd>{view.me.organization.name}</dd></div><div><dt>利用区分</dt><dd>{view.me.organization.kind === 'agency' ? '紹介会社' : '求人企業'}</dd></div><div><dt>利用者</dt><dd>{view.me.user.display_name}</dd></div></dl><button onClick={logout} disabled={busy}>{busy ? 'ログアウト中…' : 'ログアウト'}</button></>}
        <p className="message" role="status" aria-live="polite">{message}</p>
      </section>{businessMe && <Business key={businessMe.user.id} me={businessMe} signedIn={view.phase === 'signed-in'} onUnauthorized={refresh}/>}<aside><h2>現在できること</h2><p>求人の登録・公開・検索・保存、架空候補者の登録・更新・アーカイブ、架空PDFの登録・検査・ダウンロードができます。推薦は、次の開発段階で追加します。</p><p>実在する求職者の情報は入力しないでください。</p></aside>
    </main><footer>recruitment-platform · ローカルプロトタイプ</footer></>;
}
