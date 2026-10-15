'use client';
import { useEffect, useState } from 'react';
type Me = { user: { id: string; display_name: string }; organization: { id: string; name: string; kind: 'agency' | 'employer' }; expires_at: string; csrf_token: string };
type View = { phase: 'loading' | 'anonymous' | 'error' } | { phase: 'signed-in'; me: Me };
export default function Home() {
  const [view, setView] = useState<View>({ phase: 'loading' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    fetch('/api/v1/me', { cache: 'no-store', credentials: 'same-origin', signal: abort.signal })
      .then(async r => { if (r.status === 401) setView({ phase: 'anonymous' }); else if (r.ok) setView({ phase: 'signed-in', me: await r.json() as Me }); else setView({ phase: 'error' }); })
      .catch(() => { if (!abort.signal.aborted) setView({ phase: 'error' }); });
    return () => abort.abort();
  }, []);
  async function logout() {
    if (view.phase !== 'signed-in' || busy) return;
    setBusy(true); setMessage('');
    try {
      const r = await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': view.me.csrf_token } });
      if (r.ok || r.status === 401) { setView({ phase: 'anonymous' }); setMessage('ログアウトしました。'); }
      else setMessage('ログアウトできませんでした。もう一度お試しください。');
    } catch { setMessage('接続できませんでした。もう一度お試しください。'); }
    finally { setBusy(false); }
  }
  return <><header><a className="brand" href="/">recruitment-platform</a><span className="badge">架空データ専用デモ</span></header>
    <main><p className="eyebrow">求人プラットフォーム</p><h1>{view.phase === 'signed-in' ? 'ログインできました' : 'ようこそ'}</h1>
      <p className="lead">紹介会社と求人企業のための、採用業務のワークスペース。</p>
      <section className="panel" aria-labelledby="account-heading"><h2 id="account-heading">アカウント</h2>
        {view.phase === 'loading' && <p role="status">ログイン状態を確認しています…</p>}
        {view.phase === 'anonymous' && <><p>用意されたデモアカウントでログインしてください。</p><a className="button" href="/auth/login">ログインする</a></>}
        {view.phase === 'error' && <div role="alert"><p>ログイン状態を確認できませんでした。</p><button onClick={() => location.reload()}>再読み込み</button></div>}
        {view.phase === 'signed-in' && <><dl><div><dt>所属組織</dt><dd>{view.me.organization.name}</dd></div><div><dt>利用区分</dt><dd>{view.me.organization.kind === 'agency' ? '紹介会社' : '求人企業'}</dd></div><div><dt>利用者</dt><dd>{view.me.user.display_name}</dd></div></dl><button onClick={logout} disabled={busy}>{busy ? 'ログアウト中…' : 'ログアウト'}</button></>}
        <p className="message" role="status" aria-live="polite">{message}</p>
      </section><aside><h2>現在できること</h2><p>ログイン、所属の確認、ログアウトができます。求人・候補者・推薦の操作は、次の開発段階で追加します。</p><p>実在する求職者の情報は入力しないでください。</p></aside>
    </main><footer>recruitment-platform · ローカルプロトタイプ</footer></>;
}
