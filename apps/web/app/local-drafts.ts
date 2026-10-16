// Only ciphertext and scoped metadata are durable. Keys live in the authenticated page.
export type LocalMeta = {
    id: string;
    form_type: string;
    target_id: string | null;
    context_id: string | null;
    schema_version: number;
    base_resource_version: number | null;
    revision: number;
    expires_at: string;
};
export type Intent = {
    id: string;
    path: string;
    method: string;
    hash: string;
    body: Record<string, unknown>;
};
export type LocalValue = {
    payload: Record<string, unknown>;
    saved: string;
    pending?: {
        body: string;
        payload: string;
    };
    intent?: Intent;
};
export type Envelope = LocalMeta & {
    slot: string;
    owner: string;
    tab: string;
    seq: number;
    key_version: number;
    iv: number[];
    cipher: ArrayBuffer;
    terminal: boolean;
    operation_id?: string;
};
export const stable = (v: unknown): string => JSON.stringify(v, (_, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
export const digest = async (v: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable(v))))).map(v => v.toString(16).padStart(2, '0')).join('');
const dbName = 'recruitment-private-drafts-v1';
function database(): Promise<IDBDatabase> { return new Promise((resolve, reject) => { const r = indexedDB.open(dbName, 1); r.onupgradeneeded = () => r.result.createObjectStore('drafts', { keyPath: 'slot' }); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(Error('端末保存を開けません。入力は画面に保持しています。')); }); }
async function store<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await database();
    try {
        return await new Promise<T>((resolve, reject) => { const tx = db.transaction('drafts', mode), r = run(tx.objectStore('drafts')); tx.oncomplete = () => resolve(r.result); tx.onabort = tx.onerror = () => reject(Error('端末保存に失敗しました。容量とブラウザ設定を確認してください。')); });
    }
    finally {
        db.close();
    }
}
export async function candidates(owner: string, kind: string, target: string | null, context: string | null): Promise<Envelope[]> {
    const rows = await store('readonly', s => s.getAll()) as Envelope[];
    const selected = rows.filter(r => r.owner === owner && r.form_type === kind && r.target_id === target && r.context_id === context && !r.terminal);
    for (const e of selected) {
        if (!/^[0-9a-f-]{36}$/.test(e.id) || e.operation_id && !/^[0-9a-f-]{36}$/.test(e.operation_id) || e.schema_version !== 1 || !Number.isSafeInteger(e.seq) || e.seq < 0 || !Number.isSafeInteger(e.key_version) || e.key_version < 1 || !Array.isArray(e.iv) || e.iv.length !== 12 || !(e.cipher instanceof ArrayBuffer) || e.cipher.byteLength > 262160)
            throw Error('未対応または破損した端末下書きです。暗号文を保持しています。');
    }
    return selected;
}
function aad(e: Envelope) { return new TextEncoder().encode(stable([location.origin, e.owner, e.id, e.form_type, e.target_id, e.context_id, e.schema_version, e.base_resource_version, e.revision, e.expires_at, e.tab, e.seq, e.key_version, e.operation_id || null])); }
export async function decrypt(e: Envelope, key: CryptoKey): Promise<LocalValue> {
    if (e.schema_version !== 1)
        throw Error('未対応の端末下書きです。');
    try {
        return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(e.iv), additionalData: aad(e) }, key, e.cipher))) as LocalValue;
    }
    catch {
        throw Error('端末下書きの認証に失敗しました。暗号文は保持しています。');
    }
}
export async function write(meta: LocalMeta, owner: string, tab: string, seq: number, version: number, key: CryptoKey, value: LocalValue): Promise<Envelope> {
    const raw = new TextEncoder().encode(stable(value));
    if (raw.byteLength > 262144)
        throw Error('端末下書きが上限を超えています。');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const e: Envelope = { ...meta, owner, tab, seq, key_version: version, iv: Array.from(iv), cipher: new ArrayBuffer(0), terminal: false, slot: owner + ':' + meta.id + ':' + tab, ...(value.intent ? { operation_id: value.intent.id } : {}) };
    e.cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(e) }, key, raw);
    const db = await database();
    try {
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('drafts', 'readwrite'), s = tx.objectStore('drafts'), marker = s.get(owner + ':' + meta.id + ':terminal');
            marker.onsuccess = () => {
                if (marker.result) {
                    tx.abort();
                    return;
                }
                const r = s.get(e.slot);
                r.onsuccess = () => {
                    const old = r.result as Envelope | undefined;
                    if (old?.terminal || old && old.seq >= seq) {
                        tx.abort();
                        return;
                    }
                    s.put(e);
                };
            };
            tx.oncomplete = () => resolve();
            tx.onabort = tx.onerror = () => reject(Error('端末保存に失敗しました。入力は画面に保持しています。'));
        });
    }
    finally {
        db.close();
    }
    return e;
}
export async function finish(owner: string, id: string): Promise<void> {
    const db = await database();
    try {
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('drafts', 'readwrite'), s = tx.objectStore('drafts'), r = s.getAll();
            r.onsuccess = () => {
                const entries = (r.result as Envelope[]).filter(e => e.owner === owner && e.id === id);
                const first = entries[0];
                s.put({ slot: owner + ':' + id + ':terminal', owner, id, tab: 'terminal', terminal: true, seq: 0, cipher: new ArrayBuffer(0) });
                if (first)
                    s.put({ ...first, slot: owner + ':' + id + ':terminal', tab: 'terminal', terminal: true, cipher: new ArrayBuffer(0), iv: [], operation_id: undefined });
                for (const e of entries)
                    s.put({ ...e, terminal: true, cipher: new ArrayBuffer(0), iv: [], operation_id: undefined });
            };
            tx.oncomplete = () => resolve();
            tx.onabort = tx.onerror = () => reject(Error('端末の終了状態を保存できません。'));
        });
    }
    finally {
        db.close();
    }
}
export async function importKey(base64: string): Promise<CryptoKey> {
    const raw = Uint8Array.from(atob(base64.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
    try {
        return await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    }
    finally {
        raw.fill(0);
    }
}
export async function retire(slot: string): Promise<void> {
    const db = await database();
    try {
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('drafts', 'readwrite'), s = tx.objectStore('drafts'), r = s.get(slot);
            r.onsuccess = () => {
                if (r.result)
                    s.put({ ...r.result, terminal: true, cipher: new ArrayBuffer(0), iv: [], operation_id: undefined });
            };
            tx.oncomplete = () => resolve();
            tx.onabort = tx.onerror = () => reject(Error('旧端末下書きの終了保存に失敗しました。'));
        });
    }
    finally {
        db.close();
    }
}
export function notify(owner: string, id: string) {
    if (typeof BroadcastChannel === 'undefined')
        return;
    const c = new BroadcastChannel('recruitment-draft-updates');
    c.postMessage({ owner, id });
    c.close();
}
// This opaque tab label is not a credential and contains no form data.
let fallbackTab = '';
let tabPromise: Promise<string> | undefined;
export function tabIdentity() { return fallbackTab || (fallbackTab = crypto.randomUUID()); }
export function prepareTab(): Promise<string> {
    if (tabPromise)
        return tabPromise;
    tabPromise = new Promise((resolve, reject) => {
        let candidate: string | null = null;
        try {
            candidate = sessionStorage.getItem('rp-draft-tab-id');
        }
        catch { }
        const remember = (id: string) => { fallbackTab = id; try {
            sessionStorage.setItem('rp-draft-tab-id', id);
        }
        catch { } resolve(id); };
        if (!navigator.locks) {
            remember(crypto.randomUUID());
            return;
        }
        const claim = (id: string) => {
            void navigator.locks.request('rp-draft-tab:' + id, { ifAvailable: true }, lock => {
                if (!lock) {
                    claim(crypto.randomUUID());
                    return;
                }
                remember(id);
                // The document owns this label until its browsing context terminates.
                return new Promise<void>(() => { });
            }).catch(reject);
        };
        claim(candidate && /^[0-9a-f-]{36}$/.test(candidate) ? candidate : crypto.randomUUID());
    });
    return tabPromise;
}
