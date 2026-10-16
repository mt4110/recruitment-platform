import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const { sql, signIn, identity, origin } = require('./helpers.cjs');
const { rotate } = require('./draft-key.cjs');
const dir = process.env.RP_E2E_DIR!;
const knownKeys = new Map<number, Buffer>();
const stable = (v: unknown) => JSON.stringify(v, (_, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
async function rememberKey() { const r = await context.request.post(origin + '/api/v1/drafts/key', { headers: { Origin: origin, 'X-CSRF-Token': me.csrf_token }, data: {} }); expect(r.status()).toBe(200); const k = await r.json(); knownKeys.set(k.key_version, Buffer.from(k.key, 'base64url')); }
let context: BrowserContext, p: Page, profile: string, me: {
    user: {
        id: string;
    };
    organization: {
        id: string;
    };
    csrf_token: string;
};
test.describe.configure({ mode: 'default' });
// Independent isolated fixture boundary: preserve ciphertext, keep all product quotas unchanged.
test.beforeAll(() => sql("UPDATE form_drafts SET expires_at=now()-interval '1 second',revision=revision+1 WHERE state='active' AND expires_at>now();"));
async function envelopes(page = p) {
    return page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('recruitment-private-drafts-v1', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(Error('IDB')); });
        try {
            return await new Promise<{
                id: string;
                slot: string;
                tab: string;
                seq: number;
                key_version: number;
                terminal: boolean;
                operation_id?: string;
                iv: number[];
                cipher: number[];
                form_type: string;
                owner: string;
                target_id: string | null;
                context_id: string | null;
                schema_version: number;
                base_resource_version: number | null;
                revision: number;
                expires_at: string;
            }[]>((resolve, reject) => { const r = db.transaction('drafts').objectStore('drafts').getAll(); r.onsuccess = () => resolve(r.result.map(e => ({ ...e, cipher: Array.from(new Uint8Array(e.cipher)) }))); r.onerror = () => reject(Error('read')); });
        }
        finally {
            db.close();
        }
    });
}
async function open() { context = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1280, height: 900 } }); p = context.pages()[0] || await context.newPage(); }
async function fresh(url = '/candidates/new') {
    await p.goto(origin + url);
    const region = p.getByRole('complementary', { name: '個人下書き' }).first();
    await expect(region).toBeVisible();
    await expect(region).not.toContainText('下書きを確認中');
    const start = p.getByRole('button', { name: '新しい下書きを開始する', exact: true });
    if (await start.isVisible())
        await start.click();
    await expect(region).toContainText(/サーバーへ保存|下書きを復元/);
    await expect(p.getByLabel('架空氏名')).toBeEnabled();
    await expect.poll(() => sql(`SELECT count(*) FROM form_drafts WHERE user_id='${me.user.id}' AND form_type='candidate_new' AND state='active';`)).not.toBe('0');
}
async function synchronized() { await expect(p.getByRole('complementary', { name: '個人下書き' }).first()).toContainText('サーバーへ保存しました'); }
async function interrupted() { await context.route('**/api/v1/drafts/*', async (r) => r.request().method() === 'PUT' ? r.abort() : r.continue()); }
async function checkpoint(marker: string) { await expect.poll(async () => { const rows = await envelopes(); return rows.filter(e => !e.terminal && e.cipher.length > 16).length; }).toBeGreaterThan(0); await expect(p.getByRole('complementary', { name: '個人下書き' }).first()).toContainText('端末保存済み・未同期'); const rows = await envelopes(); expect(JSON.stringify(rows)).not.toContain(marker); expect(rows.every(e => !('key' in e) && !('payload' in e) && !('csrf_token' in e))).toBe(true); const matching = rows.filter(e => !e.terminal && knownKeys.has(e.key_version)).filter(e => { const c = Buffer.from(e.cipher), d = crypto.createDecipheriv('aes-256-gcm', knownKeys.get(e.key_version)!, Buffer.from(e.iv)); d.setAAD(Buffer.from(stable([origin, e.owner, e.id, e.form_type, e.target_id, e.context_id, e.schema_version, e.base_resource_version, e.revision, e.expires_at, e.tab, e.seq, e.key_version, e.operation_id || null]))); d.setAuthTag(c.subarray(-16)); const value = JSON.parse(Buffer.concat([d.update(c.subarray(0, -16)), d.final()]).toString()); expect(c.includes(Buffer.from(marker))).toBe(false); return JSON.stringify(value.payload).includes(marker); }).sort((a, b) => b.seq - a.seq); expect(matching.length).toBeGreaterThan(0); return matching[0]; }
async function expire() { const cookie = (await context.cookies(origin)).find(v => v.name === 'rp_session')!; const hash = crypto.createHash('sha256').update(cookie.value).digest('hex'); sql(`UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=decode('${hash}','hex');`); }
test.beforeEach(async () => { profile = path.join(dir, 'r5-profile-' + crypto.randomUUID()); await open(); await signIn(p); me = await identity(context); knownKeys.clear(); await rememberKey(); sql(`UPDATE draft_admissions SET at=now()-interval '2 hours' WHERE user_id='${me.user.id}';`); });
test.afterEach(async () => { await context.close(); });
test('R5 offline ciphertext survives real browser restart and reauthentication, then syncs without restoring confirmation', async () => {
    await fresh();
    await context.setOffline(true);
    await p.getByLabel('架空氏名').fill('R5未同期の架空入力');
    await p.getByLabel('経歴の概要').fill('R5架空の未同期経歴');
    await p.getByLabel('氏名・経歴はすべて架空のデータです').check();
    const e = await checkpoint('R5未同期の架空入力');
    await expire();
    await context.close();
    await open();
    await signIn(p);
    await p.goto(origin + '/candidates/new');
    await expect(p.getByLabel('架空氏名')).toHaveValue('R5未同期の架空入力');
    await expect(p.getByLabel('氏名・経歴はすべて架空のデータです')).not.toBeChecked();
    await synchronized();
    await expect.poll(() => sql(`SELECT revision FROM form_drafts WHERE id='${e.id}';`)).not.toBe('1');
    expect(await p.title()).toBeTruthy();
    expect(new URL(p.url()).pathname).toBe('/candidates/new');
    await expect(p.locator('main')).not.toBeEmpty();
    await expect(p.locator('nextjs-portal')).toHaveCount(0);
    await p.getByLabel('架空氏名').focus();
    await expect(p.getByLabel('架空氏名')).toBeFocused();
    await p.screenshot({ path: path.join(dir, 'artifacts/r5-restored-desktop.png') });
    await p.setViewportSize({ width: 390, height: 844 });
    await p.screenshot({ path: path.join(dir, 'artifacts/r5-restored-mobile.png') });
});
test('R5 lost business response resolves committed outcome after browser restart without another candidate', async () => {
    await fresh();
    await p.getByLabel('架空氏名').fill('R5応答喪失候補者');
    await p.getByLabel('経歴の概要').fill('架空経歴');
    await synchronized();
    await p.getByLabel('氏名・経歴はすべて架空のデータです').check();
    let committed = false;
    await p.route('**/api/v1/candidates', async (route) => {
        if (route.request().method() !== 'POST')
            return route.continue();
        const r = await route.fetch();
        expect(r.status()).toBe(201);
        committed = true;
        await route.abort();
    });
    await p.getByRole('button', { name: '保存する', exact: true }).click();
    await expect.poll(() => committed).toBe(true);
    expect((await envelopes()).some(e => !!e.operation_id)).toBe(true);
    await context.close();
    await open();
    await p.goto(origin + '/candidates/new');
    await expect(p).toHaveURL(/\/candidates\/[0-9a-f-]{36}$/);
    await expect(p.getByRole('heading', { name: 'R5応答喪失候補者', exact: true })).toBeVisible();
    expect(sql("SELECT count(*) FROM candidates WHERE name='R5応答喪失候補者';")).toBe('1');
});
test('R5 other account cannot decrypt or display this profile unsynchronized input', async () => {
    await fresh();
    await interrupted();
    await p.getByLabel('架空氏名').fill('R5別人には非表示');
    await checkpoint('R5別人には非表示');
    await context.unroute('**/api/v1/drafts/*');
    await context.request.post(origin + '/auth/logout', { headers: { 'X-CSRF-Token': me.csrf_token } });
    await signIn(p, 'agency-b');
    await p.goto(origin + '/candidates/new');
    await expect(p.getByLabel('架空氏名')).not.toHaveValue('R5別人には非表示');
    expect(await p.locator('body').textContent()).not.toContain('R5別人には非表示');
    expect((await envelopes()).some(e => !e.terminal)).toBe(true);
});
test('R5 old key restores and reencrypts under current key; revoked version never restores', async () => {
    await fresh();
    await interrupted();
    await p.getByLabel('架空氏名').fill('R5旧版鍵の入力');
    const old = await checkpoint('R5旧版鍵の入力');
    const next = rotate(me);
    await context.close();
    await open();
    await p.goto(origin + '/candidates/new');
    await expect(p.getByLabel('架空氏名')).toHaveValue('R5旧版鍵の入力');
    await synchronized();
    await expect.poll(async () => { const rows = await envelopes(); return rows.some(e => e.key_version === next && !e.terminal) && rows.find(e => e.slot === old.slot)?.terminal; }).toBe(true);
    await rememberKey();
    await interrupted();
    await p.getByLabel('架空氏名').fill('R5失効鍵の入力');
    await checkpoint('R5失効鍵の入力');
    sql(`UPDATE draft_keys SET revoked_at=now() WHERE user_id='${me.user.id}' AND key_version=${next};`);
    rotate(me);
    await context.close();
    await open();
    await p.goto(origin + '/candidates/new');
    await expect(p.getByRole('complementary', { name: '個人下書き' })).toContainText('復元用の鍵は失効しています');
    await expect(p.getByLabel('架空氏名')).not.toHaveValue('R5失効鍵の入力');
});
test('R5 tampered ciphertext and expired server draft are refused, not erased or replayed', async () => {
    await fresh();
    await interrupted();
    await p.getByLabel('架空氏名').fill('R5改ざん対象');
    const e = await checkpoint('R5改ざん対象');
    await p.evaluate(async (slot) => { const r = indexedDB.open('recruitment-private-drafts-v1'); await new Promise<void>(resolve => { r.onsuccess = () => { const tx = r.result.transaction('drafts', 'readwrite'), s = tx.objectStore('drafts'), q = s.get(slot); q.onsuccess = () => { const v = q.result, b = new Uint8Array(v.cipher); b[0] ^= 1; s.put({ ...v, cipher: b.buffer }); }; tx.oncomplete = () => { r.result.close(); resolve(); }; }; }); }, e.slot);
    await context.close();
    await open();
    await p.goto(origin + '/candidates/new');
    await expect(p.getByRole('complementary', { name: '個人下書き' })).toContainText('認証に失敗');
    await expect(p.getByLabel('架空氏名')).not.toHaveValue('R5改ざん対象');
    expect((await envelopes()).find(v => v.slot === e.slot)?.terminal).toBe(false);
    sql(`UPDATE form_drafts SET expires_at=now()-interval '1 second',revision=revision+1 WHERE id='${e.id}';`);
    await p.reload();
    await expect(p.getByRole('complementary', { name: '個人下書き' })).toContainText(/期限|終了/);
    expect(sql(`SELECT state FROM form_drafts WHERE id='${e.id}';`)).toBe('active');
});
test('R5 IndexedDB failure is not reported as durable and blocks business submission', async () => {
    await fresh();
    await p.evaluate(() => { indexedDB.open = () => { throw new DOMException('Synthetic quota', 'QuotaExceededError'); }; });
    await p.getByLabel('架空氏名').fill('R5容量不足');
    await expect(p.getByRole('complementary', { name: '個人下書き' })).toContainText(/Synthetic quota|端末保存に失敗|容量/);
    await p.getByLabel('氏名・経歴はすべて架空のデータです').check();
    await expect(p.getByRole('button', { name: '保存する', exact: true })).toBeDisabled();
    expect(sql("SELECT count(*) FROM candidates WHERE name='R5容量不足';")).toBe('0');
});
test('R5 concurrent tab candidates remain distinct without overwriting typed input', async () => {
    await fresh();
    await interrupted();
    await p.getByLabel('架空氏名').fill('R5タブ一の入力');
    const first = await checkpoint('R5タブ一の入力');
    const second = await context.newPage();
    await second.goto(origin + '/candidates/new');
    await expect(second.getByLabel('架空氏名')).toHaveValue('R5タブ一の入力');
    await second.getByLabel('架空氏名').fill('R5タブ二の入力');
    await expect(second.getByRole('complementary', { name: '個人下書き' })).toContainText('端末保存済み・未同期');
    const rows = (await envelopes()).filter(e => !e.terminal && e.id === first.id);
    expect(new Set(rows.map(e => e.tab)).size).toBeGreaterThan(1);
    await expect(p.getByLabel('架空氏名')).toHaveValue('R5タブ一の入力');
    await context.unroute('**/api/v1/drafts/*');
    await second.close();
    await p.reload();
    await expect(p.getByLabel('架空氏名')).toHaveValue('R5タブ一の入力');
    expect((await envelopes()).filter(v => v.id === first.id && !v.terminal).length).toBeGreaterThan(1);
});
test('R5 not-recorded intent waits for confirmation and reuses original operation instead of a new key', async () => {
    await fresh();
    await p.getByLabel('架空氏名').fill('R5未確定の再試行');
    await p.getByLabel('経歴の概要').fill('架空の元入力');
    await synchronized();
    await p.getByLabel('氏名・経歴はすべて架空のデータです').check();
    let original = '';
    await p.route('**/api/v1/candidates', async (r) => {
        if (r.request().method() !== 'POST')
            return r.continue();
        original = r.request().postDataJSON().operation_id;
        await r.abort();
    });
    await p.getByRole('button', { name: '保存する', exact: true }).click();
    await expect.poll(() => original).not.toBe('');
    await context.close();
    await open();
    await p.goto(origin + '/candidates/new');
    await expect(p.getByLabel('架空氏名')).toHaveValue('R5未確定の再試行');
    await expect(p.getByLabel('氏名・経歴はすべて架空のデータです')).not.toBeChecked();
    expect(sql("SELECT count(*) FROM candidates WHERE name='R5未確定の再試行';")).toBe('0');
    let retry = '';
    p.on('request', r => {
        if (r.method() === 'POST' && r.url() === origin + '/api/v1/candidates')
            retry = r.postDataJSON().operation_id;
    });
    await p.getByLabel('氏名・経歴はすべて架空のデータです').check();
    await p.getByRole('button', { name: '保存する', exact: true }).click();
    await expect(p.getByRole('heading', { name: 'R5未確定の再試行', exact: true })).toBeVisible();
    expect(retry).toBe(original);
    expect(sql("SELECT count(*) FROM candidates WHERE name='R5未確定の再試行';")).toBe('1');
});
test('R5 durable draft-wide tombstone refuses a delayed crypto write from another tab', async () => {
    await fresh();
    await interrupted();
    await p.getByLabel('架空氏名').fill('R5確定と遅延保存');
    await p.getByLabel('経歴の概要').fill('R5競合検証の架空経歴');
    const e = await checkpoint('R5確定と遅延保存');
    const second = await context.newPage();
    await second.goto(origin + '/candidates/new');
    await expect(second.getByLabel('架空氏名')).toHaveValue('R5確定と遅延保存');
    await second.evaluate(() => {
        const original = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle);
        const w = window as unknown as {
            r5Held?: boolean;
            r5Release?: () => void;
        };
        globalThis.crypto.subtle.encrypt = async (...args: Parameters<SubtleCrypto['encrypt']>) => { w.r5Held = true; await new Promise<void>(resolve => { w.r5Release = resolve; }); return original(...args); };
    });
    await second.getByLabel('架空氏名').fill('R5遅延した端末入力');
    await expect.poll(() => second.evaluate(() => (window as unknown as {
        r5Held?: boolean;
    }).r5Held)).toBe(true);
    await context.unroute('**/api/v1/drafts/*');
    await p.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(async () => { const r = await context.request.get(origin + '/api/v1/drafts/' + e.id); return r.ok() ? (await r.json()).payload.name : ''; }).toBe('R5確定と遅延保存');
    await expect(p.getByLabel('架空氏名')).toHaveValue('R5確定と遅延保存');
    await synchronized();
    await p.getByLabel('氏名・経歴はすべて架空のデータです').check();
    await p.getByRole('button', { name: '保存する', exact: true }).click();
    await expect(p.getByRole('heading', { name: 'R5確定と遅延保存', exact: true })).toBeVisible();
    await expect.poll(async () => (await envelopes()).some(v => v.id === e.id && v.tab === 'terminal')).toBe(true);
    await second.evaluate(() => (window as unknown as {
        r5Release?: () => void;
    }).r5Release?.());
    await expect(second.getByRole('complementary', { name: '個人下書き' })).toContainText(/終了|失敗|保存/);
    await expect.poll(async () => (await envelopes()).filter(v => v.id === e.id && !v.terminal).length).toBe(0);
    expect(sql("SELECT count(*) FROM candidates WHERE name='R5確定と遅延保存';")).toBe('1');
    await second.close();
});
test('R5 uncertain draft mutation is replayed before syncing the newer local input', async () => {
    await fresh();
    let dropped = false;
    await p.route('**/api/v1/drafts/*', async (route) => {
        if (route.request().method() !== 'PUT')
            return route.continue();
        if (!dropped) {
            const r = await route.fetch();
            expect(r.ok()).toBe(true);
            dropped = true;
        }
        await route.abort();
    });
    await p.getByLabel('架空氏名').fill('R5保存応答喪失初版');
    await expect.poll(() => dropped).toBe(true);
    await p.getByLabel('架空氏名').fill('R5保存応答喪失最新版');
    const e = await checkpoint('R5保存応答喪失最新版');
    await context.close();
    await open();
    await p.goto(origin + '/candidates/new');
    await expect(p.getByLabel('架空氏名')).toHaveValue('R5保存応答喪失最新版');
    await synchronized();
    const r = await context.request.get(origin + '/api/v1/drafts/' + e.id);
    expect(r.status()).toBe(200);
    expect((await r.json()).payload.name).toBe('R5保存応答喪失最新版');
});
test('R5 opener-cloned sessionStorage gets a separate tab identity and preserves both inputs', async () => {
    await fresh();
    await interrupted();
    await p.getByLabel('架空氏名').fill('R5複製元の入力');
    const e = await checkpoint('R5複製元の入力');
    await p.evaluate(() => { const a = document.createElement('a'); a.id = 'r5-clone-link'; a.href = '/candidates/new'; a.target = '_blank'; a.rel = 'opener'; a.textContent = '複製タブの検証'; document.body.append(a); });
    const waiting = p.waitForEvent('popup');
    await p.locator('#r5-clone-link').click();
    const q = await waiting;
    await expect(q.getByLabel('架空氏名')).toHaveValue('R5複製元の入力');
    const a = await p.evaluate(() => sessionStorage.getItem('rp-draft-tab-id')), b = await q.evaluate(() => sessionStorage.getItem('rp-draft-tab-id'));
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
    await q.getByLabel('架空氏名').fill('R5複製先の独立入力');
    await expect(q.getByRole('complementary', { name: '個人下書き' })).toContainText('端末保存済み・未同期');
    expect((await envelopes()).filter(v => v.id === e.id && !v.terminal).length).toBeGreaterThan(1);
    await expect(p.getByLabel('架空氏名')).toHaveValue('R5複製元の入力');
    await q.close();
});
test('R5 discard creates a durable marker before any local slot and rejects its delayed first write', async () => {
    const headers = { Origin: origin, 'X-CSRF-Token': me.csrf_token, 'Idempotency-Key': crypto.randomUUID() };
    const cr = await context.request.post(origin + '/api/v1/candidates', { headers, data: { name: 'R5初回保存競合の架空候補者', summary: '架空の初期経歴', fictional_confirmed: true } });
    expect(cr.status()).toBe(201);
    const c = await cr.json(), id = crypto.randomUUID();
    const dr = await context.request.put(origin + '/api/v1/drafts/' + id, { headers, data: { revision: 0, form_type: 'candidate_edit', target_id: c.id, context_id: null, base_resource_version: c.version, schema_version: 1, mutation_id: crypto.randomUUID(), payload: { name: c.name, summary: c.summary } } });
    expect(dr.status()).toBe(201);
    await p.goto(origin + '/candidates/' + c.id + '/edit');
    await expect(p.getByLabel('架空氏名')).toHaveValue(c.name);
    expect((await envelopes()).some(v => v.id === id)).toBe(false);
    await p.evaluate(() => {
        const original = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle), w = window as unknown as {
            r5Held?: boolean;
            r5Release?: () => void;
        };
        globalThis.crypto.subtle.encrypt = async (...args: Parameters<SubtleCrypto['encrypt']>) => { w.r5Held = true; await new Promise<void>(resolve => { w.r5Release = resolve; }); return original(...args); };
    });
    await p.getByLabel('架空氏名').fill('R5遅延した初回入力');
    await expect.poll(() => p.evaluate(() => (window as unknown as {
        r5Held?: boolean;
    }).r5Held)).toBe(true);
    const q = await context.newPage();
    await q.goto(origin + '/candidates/' + c.id + '/edit');
    await expect(q.getByLabel('架空氏名')).toHaveValue(c.name);
    q.once('dialog', d => d.accept());
    await q.getByRole('button', { name: 'この下書きを破棄する', exact: true }).click();
    await expect.poll(async () => (await envelopes()).some(v => v.id === id && v.tab === 'terminal')).toBe(true);
    await p.evaluate(() => (window as unknown as {
        r5Release?: () => void;
    }).r5Release?.());
    await expect.poll(async () => (await envelopes()).filter(v => v.id === id && !v.terminal).length).toBe(0);
    expect(sql(`SELECT state FROM form_drafts WHERE id='${id}';`)).toBe('discarded');
    expect(sql(`SELECT name FROM candidates WHERE id='${c.id}';`)).toBe(c.name);
    await q.close();
});
test('R5 inactive form resolves a committed pending receipt from the list without decrypting or replaying it', async () => {
    await fresh();
    await p.getByLabel('架空氏名').fill('R5一覧からの確定照合');
    await p.getByLabel('経歴の概要').fill('架空の経歴');
    await synchronized();
    await p.getByLabel('氏名・経歴はすべて架空のデータです').check();
    let committed = false;
    await p.route('**/api/v1/candidates', async (r) => {
        if (r.request().method() !== 'POST')
            return r.continue();
        expect((await r.fetch()).status()).toBe(201);
        committed = true;
        await r.abort();
    });
    await p.getByRole('button', { name: '保存する', exact: true }).click();
    await expect.poll(() => committed).toBe(true);
    const receipt = (await envelopes()).find(e => !!e.operation_id)!;
    expect(receipt).toBeTruthy();
    await context.close();
    await open();
    await p.goto(origin + '/candidates');
    await expect.poll(async () => (await envelopes()).some(e => e.id === receipt.id && e.tab === 'terminal')).toBe(true);
    expect(sql("SELECT count(*) FROM candidates WHERE name='R5一覧からの確定照合';")).toBe('1');
    await expect(p.getByText('R5一覧からの確定照合', { exact: true })).toBeVisible();
});
test('R5 slow first initialization shares the serial save queue and never rolls back newer input', async () => {
    const cr = await context.request.post(origin + '/api/v1/candidates', { headers: { Origin: origin, 'X-CSRF-Token': me.csrf_token, 'Idempotency-Key': crypto.randomUUID() }, data: { name: 'R5初期化競合の元候補者', summary: '架空の初期経歴', fictional_confirmed: true } });
    expect(cr.status()).toBe(201);
    const c = await cr.json();
    const keys: import('@playwright/test').Route[] = [];
    await p.route('**/api/v1/drafts/key', async (r) => { keys.push(r); });
    let active = 0, peak = 0, first = true, draftId = '', release: () => void = () => { };
    const held = new Promise<void>(resolve => { release = resolve; });
    await p.route(/\/api\/v1\/drafts\/[0-9a-f-]{36}$/, async (r) => { if (r.request().method() !== 'PUT' || r.request().postDataJSON().target_id !== c.id)
        return r.continue(); active++; peak = Math.max(peak, active); draftId = new URL(r.request().url()).pathname.split('/').pop()!; const response = await r.fetch(); if (first) {
        first = false;
        await held;
    } active--; await r.fulfill({ response }); });
    await p.goto(origin + '/candidates/' + c.id + '/edit');
    await expect(p.getByLabel('架空氏名')).toBeEnabled();
    await p.getByLabel('架空氏名').fill('R5初期化競合の最初の入力');
    await expect.poll(() => keys.length).toBeGreaterThanOrEqual(2);
    await Promise.all(keys.map(async (r) => r.fulfill({ response: await r.fetch() })));
    await expect.poll(() => active).toBe(1);
    await p.getByLabel('架空氏名').fill('R5初期化競合の最新版');
    await p.evaluate(() => window.dispatchEvent(new Event('blur')));
    // Hold the first response across the configured 500ms debounce; this is a fault fixture, not a latency SLA.
    await p.waitForTimeout(750);
    const beforeRelease=peak;
    release();
    expect(beforeRelease).toBe(1);
    await synchronized();
    await expect.poll(async () => { const r = await context.request.get(origin + '/api/v1/drafts/' + draftId); return r.ok() ? (await r.json()).payload.name : ''; }).toBe('R5初期化競合の最新版');
    await expect(p.getByLabel('架空氏名')).toHaveValue('R5初期化競合の最新版');
    expect(peak).toBe(1);
});
