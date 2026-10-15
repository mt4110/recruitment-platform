const { expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const dir = process.env.RP_E2E_DIR;
const marker = JSON.parse(fs.readFileSync(path.join(dir,'test-instance.json'),'utf8'));
if (!marker.test_only || marker.instance!==process.env.RP_INSTANCE || !/^e2e-[a-z0-9-]+$/.test(marker.instance)) throw Error('TEST_INSTANCE_REQUIRED');
const accounts = JSON.parse(fs.readFileSync(path.join(dir,'demo-accounts.json'),'utf8'));
const origin = `http://localhost:${process.env.RP_APP_PORT}`;
function sql(statement) {
  const p = cp.spawnSync('python3',['scripts/local.py','compose','exec','-T','db','psql','-U','postgres','-d','recruitment','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-At'],{cwd:path.resolve(__dirname,'..'),env:process.env,input:statement,encoding:'utf8'});
  if (p.status!==0) { const state=p.stderr?.match(/ERROR:\s+([0-9A-Z]{5}):/); throw Error('DB_CONTROL_FAILED'+(state?':'+state[1]:'')); }
  return p.stdout.trim();
}
async function loginPage(page) {
  for (let i=0;i<20;i++) {
    const response = await page.goto(origin+'/auth/login');
    if (response.status()!==429) { expect(response.ok(), 'login endpoint ready').toBe(true); break; }
    // Respect the application's rate limit; no bypass header or relaxed config.
    await new Promise(r=>setTimeout(r,6000));
  }
  const user = page.locator('#username');
  if (!await user.isVisible()) {
    const reset = page.locator('#reset-login');
    if (await reset.isVisible()) await reset.click();
  }
  await user.waitFor();
}
async function signIn(page,name='agency-a',beforeSubmit) {
  await loginPage(page);
  await page.locator('#username').fill(name);
  await page.locator('#password').fill(accounts[name]);
  if (beforeSubmit) await beforeSubmit();
  const pending = page.waitForResponse(r=>r.url().startsWith(origin+'/auth/callback'));
  await page.locator('#kc-login').click();
  const response = await pending;
  await page.waitForLoadState('domcontentloaded');
  return response;
}
async function identity(context) {
  const r=await context.request.get(origin+'/api/v1/me');
  expect(r.status(), 'authenticated /me').toBe(200);
  return r.json();
}
async function anonymous(page) { await expect(page.getByRole('link',{name:'ログインする',exact:true})).toBeVisible(); }
async function shot(page,name) {
  expect(new URL(page.url()).origin===origin && ((['/', '/login'].includes(new URL(page.url()).pathname) || /^\/(jobs|candidates)(?:\/[a-f0-9-]{36}(?:\/edit)?|\/new)?$/.test(new URL(page.url()).pathname)) || (new URL(page.url()).pathname==='/auth/callback' && await page.getByRole('heading',{name:'ログインを完了できませんでした'}).count()===1)), 'safe screenshot path').toBe(true);
  await page.screenshot({path:path.join(dir,'artifacts',name+'.png'),fullPage:true});
}
module.exports={sql,signIn,identity,anonymous,shot,origin,loginPage};
