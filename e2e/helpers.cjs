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
async function freshDraft(page) {
  const panel=page.getByRole('complementary',{name:'個人下書き'}).first();
  await expect(panel).toBeVisible();
  await expect(panel).not.toContainText('下書きを確認中');
  const start=panel.getByRole('button',{name:'新しい下書きを開始する',exact:true});
  const failedStart=panel.getByRole('button',{name:'現在の入力で新しい下書きを開始する',exact:true});
  await expect.poll(async()=>await start.isVisible()||await failedStart.isVisible()||/下書きをサーバーへ保存しました|保存した下書きを復元しました/.test(await panel.textContent()||'')).toBe(true);
  if(await start.isVisible())await start.click();
  else{
    if(await failedStart.isVisible()){page.once('dialog',d=>d.accept());await failedStart.click();}
  }
  await expect(panel).toContainText(/下書きをサーバーへ保存しました|保存した下書きを復元しました/);
}
async function assertPrivateStorage(page) {
  const errors=await page.evaluate(async()=>{
    const errors=[],uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if(localStorage.length!==0)errors.push('LOCAL_STORAGE_NOT_EMPTY');
    for(const name of Object.keys(sessionStorage))if(name!=='rp-draft-tab-id'||!uuid.test(sessionStorage.getItem(name)||''))errors.push('SESSION_STORAGE_NOT_OPAQUE_TAB_ID');
    const databases=await indexedDB.databases();
    if(databases.some(d=>d.name!=='recruitment-private-drafts-v1'||d.version!==1))errors.push('UNEXPECTED_DATABASE');
    if(!databases.some(d=>d.name==='recruitment-private-drafts-v1'))return errors;
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('recruitment-private-drafts-v1');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(Error('PRIVATE_STORAGE_INSPECTION_FAILED'));});
    try{
      if(JSON.stringify(Array.from(db.objectStoreNames))!==JSON.stringify(['drafts']))return [...errors,'UNEXPECTED_STORE'];
      const rows=await new Promise((resolve,reject)=>{const tx=db.transaction('drafts','readonly'),r=tx.objectStore('drafts').getAll();tx.oncomplete=()=>resolve(r.result);tx.onabort=tx.onerror=()=>reject(Error('PRIVATE_STORAGE_INSPECTION_FAILED'));});
      const allowed=['id','form_type','target_id','context_id','schema_version','base_resource_version','revision','expires_at','slot','owner','tab','seq','key_version','iv','cipher','terminal','operation_id'];
      const types=['job_new','job_edit','candidate_new','candidate_edit','application_new','application_reason','application_submit','selection_note','document_upload','job_filters','candidate_filters','application_filters'];
      for(const e of rows){
        if(!e||typeof e!=='object'||Object.keys(e).some(k=>!allowed.includes(k))){errors.push('UNEXPECTED_ENVELOPE_FIELD');continue;}
        const owner=typeof e.owner==='string'?e.owner.split(':'):[];
        if(owner.length!==2||!owner.every(v=>uuid.test(v))||!uuid.test(e.id)||!Number.isSafeInteger(e.seq)||e.seq<0||typeof e.terminal!=='boolean'||!(e.cipher instanceof ArrayBuffer)){errors.push('INVALID_ENVELOPE_SCOPE');continue;}
        if(e.slot!==e.owner+':'+e.id+':'+e.tab)errors.push('INVALID_SLOT');
        if(e.operation_id!==undefined&&!uuid.test(e.operation_id))errors.push('INVALID_OPERATION_ID');
        if(e.terminal){
          if(e.cipher.byteLength!==0||e.operation_id!==undefined||e.iv!==undefined&&(!Array.isArray(e.iv)||e.iv.length!==0))errors.push('TERMINAL_RETAINS_CONTENT');
          if(e.schema_version===undefined){
            if(e.tab!=='terminal'||Object.keys(e).some(k=>!['slot','owner','id','tab','terminal','seq','cipher','iv','operation_id'].includes(k)))errors.push('INVALID_TERMINAL_MARKER');
            continue;
          }
        }else if(!Array.isArray(e.iv)||e.iv.length!==12||!e.iv.every(v=>Number.isInteger(v)&&v>=0&&v<=255)||e.cipher.byteLength<16||e.cipher.byteLength>262160)errors.push('INVALID_CIPHERTEXT');
        if(e.tab!=='terminal'&&!(typeof e.tab==='string'&&uuid.test(e.tab.split('.')[0])&&/\.[1-9][0-9]*$/.test(e.tab)&&e.tab.split('.').length===2))errors.push('INVALID_TAB');
        if(!e.terminal&&e.tab==='terminal')errors.push('ACTIVE_TERMINAL_SLOT');
        if(!types.includes(e.form_type)||e.schema_version!==1||!Number.isSafeInteger(e.revision)||e.revision<0||!Number.isSafeInteger(e.key_version)||e.key_version<1||typeof e.expires_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(e.expires_at)||!Number.isFinite(Date.parse(e.expires_at)))errors.push('INVALID_ENVELOPE_METADATA');
        if(![e.target_id,e.context_id].every(v=>v===null||typeof v==='string'&&uuid.test(v))||!(e.base_resource_version===null||Number.isSafeInteger(e.base_resource_version)&&e.base_resource_version>0))errors.push('INVALID_RESOURCE_METADATA');
      }
      return errors;
    }finally{db.close();}
  });
  expect(errors,'only scoped ciphertext envelopes and opaque tab identity may persist').toEqual([]);
}
async function shot(page,name) {
  expect(new URL(page.url()).origin===origin && ((['/', '/login'].includes(new URL(page.url()).pathname) || /^\/(jobs|candidates|applications)(?:\/[a-f0-9-]{36}(?:\/edit)?|\/new)?$/.test(new URL(page.url()).pathname)) || (new URL(page.url()).pathname==='/auth/callback' && await page.getByRole('heading',{name:'ログインを完了できませんでした'}).count()===1)), 'safe screenshot path').toBe(true);
  await page.screenshot({path:path.join(dir,'artifacts',name+'.png'),fullPage:true});
}
module.exports={sql,signIn,identity,anonymous,shot,origin,loginPage,freshDraft,assertPrivateStorage};
