const {test,expect} = require('@playwright/test');
const crypto = require('node:crypto'), cp=require('node:child_process'), path=require('node:path');
const {sql,signIn,identity,anonymous,shot,origin,loginPage}=require('./helpers.cjs');
const userId='10000000-0000-0000-0000-000000000001';
const orgId='00000000-0000-0000-0000-000000000001';
function attempt(page) {
  const state=new URL(page.url()).searchParams.get('state');
  if (!state) throw Error('AUTH_STATE_REQUIRED');
  return `state_hash=decode('${crypto.createHash('sha256').update(state).digest('hex')}','hex')`;
}
async function sessionWhere(context) {
  const cookie=(await context.cookies(origin)).find(c=>c.name==='rp_session');
  if (!cookie) throw Error('SESSION_REQUIRED');
  return `token_hash=decode('${crypto.createHash('sha256').update(cookie.value).digest('hex')}','hex')`;
}
test('nine services are healthy; DB roles and immutable identity are enforced',async({request})=>{
  expect((await request.get(origin+'/ready')).status()).toBe(200);
  const p=cp.spawnSync('python3',['scripts/local.py','compose','ps','--format','json'],{encoding:'utf8',cwd:path.resolve(__dirname,'..')});
  expect(p.status).toBe(0);
  const rows=p.stdout.trim().split('\n').map(s=>JSON.parse(s));
  expect(rows.length).toBe(9);expect(rows.every(r=>r.Health==='healthy')).toBe(true);
  expect(sql('SELECT count(*) FROM organizations; SELECT count(*) FROM users;')).toBe('4\n4');
  expect(sql("SELECT NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole FROM pg_roles WHERE rolname='app_auth';")).toBe('t');
  expect(sql("SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tableowner='app_auth';")).toBe('0');
  for(const statement of [
    `UPDATE users SET organization_id='00000000-0000-0000-0000-000000000002' WHERE id='${userId}';`,
    `UPDATE users SET oidc_subject='wrong' WHERE id='${userId}';`,
    `UPDATE organizations SET kind='employer' WHERE id='${orgId}';`,
  ]) expect(()=>sql(statement)).toThrow('DB_CONTROL_FAILED:23514');
});
for(const [name,organization] of [['agency-a','架空紹介会社A'],['agency-b','架空紹介会社B'],['employer-x','架空求人企業X'],['employer-y','架空求人企業Y']]) {
  test(`${name}: real OIDC login, fixed organization, protected logout`,async({page,context})=>{
    const errors=[];page.on('pageerror',e=>errors.push(e.name));
    expect((await signIn(page,name,()=>{
      const authorize=new URL(page.url());
      expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
      expect(Boolean(authorize.searchParams.get('code_challenge')?.match(/^[A-Za-z0-9_-]{43}$/))).toBe(true);
      expect(sql(`SELECT expires_at>now()+interval '4 minutes' AND octet_length(encrypted_pkce_verifier)>28 FROM auth_attempts WHERE ${attempt(page)};`)).toBe('t');
    })).status()).toBe(303);
    await expect(page.getByRole('heading',{name:'ログインできました'})).toBeVisible();
    await expect(page.getByRole('region',{name:'アカウント'}).getByText(organization,{exact:true})).toBeVisible();
    const me=await identity(context);
    expect(me.organization.name).toBe(organization);
    expect(Object.keys(me).sort()).toEqual(['csrf_token','expires_at','organization','user']);
    const cookies=await context.cookies(origin);const session=cookies.find(c=>c.name==='rp_session');
    expect(Boolean(session&&session.httpOnly&&session.sameSite==='Lax'&&session.path==='/'&&!session.secure&&session.expires-Date.now()/1000>28700)).toBe(true);
    expect(cookies.some(c=>/token/i.test(c.name))).toBe(false);
    const where=await sessionWhere(context);
    expect(sql(`SELECT octet_length(token_hash)=32 AND expires_at>now()+interval '7 hours 59 minutes' FROM sessions WHERE ${where};`)).toBe('t');
    for(const headers of [{Origin:origin},{Origin:origin,'X-CSRF-Token':'wrong'},{Origin:'http://example.invalid','X-CSRF-Token':me.csrf_token}]) {
      const response=await context.request.post(origin+'/auth/logout',{headers});
      expect(response.status()).toBe(403);expect((await response.json()).error.code).toBe('CSRF_REJECTED');
      expect((await context.request.get(origin+'/api/v1/me')).status()).toBe(200);
    }
    if(name==='agency-a') {
      await expect(page).toHaveTitle('recruitment-platform');
      expect(await page.locator('nextjs-portal').count()).toBe(0);
      await shot(page,'desktop-signed-in');
    }
    await page.getByRole('button',{name:'ログアウト',exact:true}).click();await anonymous(page);
    await expect(page.getByRole('link',{name:'ログインする',exact:true})).toBeFocused();
    expect((await context.request.get(origin+'/api/v1/me')).status()).toBe(401);
    expect(sql(`SELECT count(*) FROM sessions WHERE ${where};`)).toBe('0');
    expect((await context.cookies(origin)).some(c=>c.name==='rp_session')).toBe(false);
    expect(await page.evaluate(()=>localStorage.length+sessionStorage.length)).toBe(0);
    expect(errors).toEqual([]);
  });
}
test('same browser changes agency A to B after logout',async({page})=>{
  await signIn(page,'agency-a');await page.getByRole('button',{name:'ログアウト',exact:true}).click();await anonymous(page);
  await signIn(page,'agency-b');await expect(page.getByText('架空紹介会社B',{exact:true})).toBeVisible();
  await expect(page.getByText('架空紹介会社A',{exact:true})).toHaveCount(0);
});
test('unregistered user sees a recoverable HTML error and no new session',async({page,context})=>{
  const response=await signIn(page,'unregistered');expect(response.status()).toBe(403);
  await expect(page.getByRole('heading',{name:'ログインを完了できませんでした'})).toBeVisible();
  await expect(page.getByRole('link',{name:'ログインをやり直す'})).toBeVisible();
  await shot(page,'login-error');
  expect((await context.request.get(origin+'/api/v1/me')).status()).toBe(401);
  await page.getByRole('link',{name:'ログイン画面へ戻る'}).click();await anonymous(page);await shot(page,'login-recovery');
});
for(const [label,table,id] of [['user','users',userId],['organization','organizations',orgId]]) {
 test(`disabled ${label} invalidates a session and refuses login`,async({page,context})=>{
  await signIn(page);
  try {
    sql(`UPDATE ${table} SET active=false WHERE id='${id}';`);
    expect((await context.request.get(origin+'/api/v1/me')).status()).toBe(401);
    await page.reload();await anonymous(page);
    expect((await signIn(page)).status()).toBe(403);
    await expect(page.getByRole('heading',{name:'ログインを完了できませんでした'})).toBeVisible();
  } finally { sql(`UPDATE ${table} SET active=true WHERE id='${id}';`); }
 });
}
for(const [label,mutation] of [
 ['nonce mismatch',where=>`UPDATE auth_attempts SET nonce='deliberately-invalid' WHERE ${where};`],
 ['expired attempt',where=>`UPDATE auth_attempts SET expires_at=now()-interval '1 second' WHERE ${where};`],
 ['tampered encrypted verifier',where=>`UPDATE auth_attempts SET encrypted_pkce_verifier=set_byte(encrypted_pkce_verifier,15,get_byte(encrypted_pkce_verifier,15)#1) WHERE ${where};`],
]) {
 test(`${label} refuses authentication`,async({page,context})=>{
  const response=await signIn(page,'agency-a',()=>sql(mutation(attempt(page))));
  expect(response.status()).toBe(400);
  await expect(page.getByRole('link',{name:'ログインをやり直す'})).toBeVisible();
  expect((await context.request.get(origin+'/api/v1/me')).status()).toBe(401);
 });
}
test('missing or foreign browser binding refuses authentication',async({page,context})=>{
 const response=await signIn(page,'agency-a',async()=>{
   const values=await context.cookies();const cookie=values.find(c=>c.name==='rp_attempt');
   expect(Boolean(cookie)).toBe(true);
   await context.addCookies([{...cookie,value:crypto.randomBytes(32).toString('base64url')}]);
 });
 expect(response.status()).toBe(400);expect((await context.request.get(origin+'/api/v1/me')).status()).toBe(401);
});
test('wrong state and malformed query are rejected without consuming a valid attempt',async({page,context})=>{
 const response=await signIn(page,'agency-a',async()=>{
  for(const query of ['state=wrong&code=wrong','state=one&state=two&code=wrong']) {
   const bad=await context.request.get(origin+'/auth/callback?'+query,{headers:{Accept:'application/json'}});
   expect(bad.status()).toBe(400);expect((await bad.json()).error.code).toBe('AUTH_ATTEMPT_INVALID');
  }
 });expect(response.status()).toBe(303);
});
test('callback reuse is rejected and cannot switch the existing identity',async({page,context})=>{
 const response=await signIn(page);const callback=response.url();
 const result=await context.request.get(callback,{headers:{Accept:'application/json'}});
 expect(result.status()).toBe(400);expect((await result.json()).error.code).toBe('AUTH_ATTEMPT_INVALID');
 expect((await identity(context)).organization.name).toBe('架空紹介会社A');
});
test('expired session clears stale UI on focus and offers login',async({page,context})=>{
 await signIn(page);await expect(page.getByText('架空紹介会社A',{exact:true})).toBeVisible();
 sql(`UPDATE sessions SET expires_at=now()-interval '1 second' WHERE ${await sessionWhere(context)};`);
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await anonymous(page);
 await expect(page.getByText('架空紹介会社A',{exact:true})).toHaveCount(0);
 expect((await context.request.get(origin+'/api/v1/me')).status()).toBe(401);
});
test('logout clears the other tab and discards a delayed identity response',async({page,context})=>{
 await signIn(page);await expect(page.getByRole('button',{name:'ログアウト',exact:true})).toBeVisible();
 const second=await context.newPage();await second.goto(origin);await expect(second.getByText('架空紹介会社A',{exact:true})).toBeVisible();
 let release;const gate=new Promise(r=>release=r);let intercepted;
 const arrived=new Promise(r=>intercepted=r);
 await page.route('**/api/v1/me',async route=>{const response=await route.fetch();intercepted();await gate;try{await route.fulfill({response});}catch{}});
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await arrived;
 await second.getByRole('button',{name:'ログアウト',exact:true}).click();await anonymous(second);await anonymous(page);
 release();await page.unrouteAll({behavior:'wait'});
 await anonymous(page);await expect(page.getByText('架空紹介会社A',{exact:true})).toHaveCount(0);
 await second.close();
});
test('API restart preserves the database session',async({page,context})=>{
 await signIn(page);const before=await identity(context);
 const result=cp.spawnSync('python3',['scripts/local.py','compose','restart','api'],{encoding:'utf8',cwd:path.resolve(__dirname,'..')});expect(result.status).toBe(0);
 await expect.poll(async()=>{try{return (await context.request.get(origin+'/ready')).status();}catch{return 0;}},{timeout:40000}).toBe(200);
 expect((await identity(context)).user.id).toBe(before.user.id);
 await page.reload();await expect(page.getByText('架空紹介会社A',{exact:true})).toBeVisible();
});
test('identity and logout network errors are visible and recoverable',async({page,context})=>{
 await page.route('**/api/v1/me',route=>route.abort());await page.goto(origin);
 await expect(page.locator('.panel').getByRole('alert')).toContainText('ログイン状態を確認できませんでした');
 await page.unroute('**/api/v1/me');await page.getByRole('button',{name:'再読み込み'}).click();await anonymous(page);
 await signIn(page);await page.route('**/auth/logout',route=>route.abort());
 await page.getByRole('button',{name:'ログアウト',exact:true}).click();await expect(page.getByRole('status')).toContainText('接続できませんでした');
 expect((await context.request.get(origin+'/api/v1/me')).status()).toBe(200);
 await page.unroute('**/auth/logout');await page.getByRole('button',{name:'ログアウト',exact:true}).click();await anonymous(page);
});
test('mobile layout, keyboard login and logout work',async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.goto(origin);await anonymous(page);
 await page.keyboard.press('Tab');await page.keyboard.press('Tab');await expect(page.getByRole('link',{name:'ログインする',exact:true})).toBeFocused();
 await page.keyboard.press('Enter');await expect(page).not.toHaveURL(origin+'/');
 await signIn(page);await expect(page.getByText('架空紹介会社A',{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await shot(page,'mobile-signed-in');
 await page.getByRole('button',{name:'ログアウト',exact:true}).click();await anonymous(page);
});

const browserProblems=new Map();
test.beforeEach(async({page,context},info)=>{
 const problems=[];browserProblems.set(info.testId,problems);
 const wired=new WeakSet();
 const wire=p=>{
  if(wired.has(p))return;wired.add(p);
  p.on('pageerror',()=>problems.push('UNCAUGHT_PAGE_ERROR'));
  p.on('console',m=>{
   if(!['error','warning'].includes(m.type()))return;
   const text=m.text();
   if(/^Failed to load resource: the server responded with a status of (400|401|403|429)\b/.test(text))return;
   if(info.title==='identity and logout network errors are visible and recoverable' && /net::ERR_FAILED/.test(text))return;
   problems.push('UNEXPECTED_BROWSER_CONSOLE_'+m.type().toUpperCase());
  });
 };
 wire(page);context.on('page',wire);
});
test.afterEach(async({},info)=>{
 expect(browserProblems.get(info.testId)||[], 'no unexpected browser console or runtime error').toEqual([]);
 browserProblems.delete(info.testId);
});
