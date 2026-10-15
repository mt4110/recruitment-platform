const {chromium}=require('playwright');
const fs=require('fs');
const root=__dirname, passwords=JSON.parse(fs.readFileSync(root+'/secrets.json')).users;
(async()=>{
 const started=Date.now(), browser=await chromium.launch({headless:true}), results=[];
 async function flow(ctx,user,kind='normal',expected=200){
  const page=await ctx.newPage();
  try{
   const initial=await page.goto('http://localhost:18081/login?user='+user+'&case='+kind,{timeout:30000});
   let response;
   if(['badredirect','nopkce'].includes(kind)) response=initial;
   else{
    if(await page.locator('#username').count()===0 && await page.locator('#reset-login').count())await page.locator('#reset-login').click();
    await page.locator('#username').fill(user);await page.locator('#password').fill(passwords[user]);
    [response]=await Promise.all([page.waitForResponse(r=>r.url().startsWith('http://localhost:18081/callback?'),{timeout:65000}),page.locator('#kc-login').click({timeout:65000})]);
   }
   const status=response.status(), body=await response.text();
   const expectedCodes={badstate:'STATE_OR_ATTEMPT_INVALID',badnonce:'NONCE_OR_KEY_INVALID',badverifier:'TOKEN_EXCHANGE_REJECTED',badissuer:'InvalidIssuerError',badaudience:'InvalidAudienceError',badsignature:'InvalidSignatureError',expired:'ExpiredSignatureError',nopkce:'PROVIDER_PKCE_REQUIRED'};
   const expectedCode=expectedCodes[kind]||(user==='unregistered'?'MEMBERSHIP_REJECTED':null);
   const actualCode=expectedCode?JSON.parse(body).error:null;
   const providerReason=kind==='badredirect'?body.includes('redirect_uri'):true;
   const ok=status===expected && providerReason && (!expectedCode||actualCode===expectedCode) && (expected!==200 || JSON.parse(body).user===user);
   results.push({name:user+'/'+kind,pass:ok,http_status:status,...(actualCode?{rejection_code:actualCode}:{}),...(kind==='expired'?{suite_elapsed_at_response_seconds:Math.round((Date.now()-started)/1000)}:{})});
   if(!ok)throw Error('Unexpected status '+status+' for '+kind);
   if(expected===200){
    const savedUrl=page.url();
    const replay=await ctx.request.get(savedUrl);
    results.push({name:'single_use_attempt/'+user,pass:replay.status()===400,http_status:replay.status()});
    const cookies=await ctx.cookies('http://localhost:18081');const cookie=cookies.find(c=>c.name==='m0sid');
    results.push({name:'cookie_flags/'+user,pass:!!cookie&&cookie.httpOnly&&cookie.sameSite==='Lax'});
    if(user==='agency-a' && kind==='normal') await page.screenshot({path:root+'/auth-success.png'});
    const beforeLogout=await ctx.request.get('http://localhost:18081/me');const csrf=(await beforeLogout.json()).csrf_token;
    const denied=await ctx.request.post('http://localhost:18081/logout');
    results.push({name:'logout_csrf_rejected/'+user,pass:denied.status()===403});
    const logout=await ctx.request.post('http://localhost:18081/logout',{headers:{Origin:'http://localhost:18081','X-CSRF-Token':csrf}});
    const me=await ctx.request.get('http://localhost:18081/me');
    results.push({name:'logout_invalidates_local_session/'+user,pass:logout.status()===200&&me.status()===401});
   }
  }catch(e){
   const debug=await page.locator('body').innerText().catch(()=>'<unavailable>');
   fs.writeFileSync(root+'/auth-failure-info.json',JSON.stringify({user,kind,error_class:e.name,body_text:debug,inputs:await page.locator('input').evaluateAll(xs=>xs.map(x=>({id:x.id,type:x.type,name:x.name}))).catch(()=>[])}));
   await page.screenshot({path:root+'/auth-failure.png'}).catch(()=>{});throw e;
  }finally{await page.close();}
 }
 try{
  const reused=await browser.newContext();
  await flow(reused,'agency-a');await flow(reused,'agency-b');await reused.close();
  for(const user of ['employer-x','employer-y']){const ctx=await browser.newContext();await flow(ctx,user);await ctx.close();}
  for(const kind of ['badstate','badnonce','badverifier','badissuer','badaudience','badsignature','expired','badredirect','nopkce']){
   const ctx=await browser.newContext();await flow(ctx,'agency-a',kind,400);await ctx.close();
  }
  const ctx=await browser.newContext();await flow(ctx,'unregistered','normal',403);await ctx.close();
  const result={scope:'real Keycloak + disposable Python OIDC relying party; not Rust API',harness_sha256:require('crypto').createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),elapsed_seconds:(Date.now()-started)/1000,checks:results,all_passed:results.every(r=>r.pass)};
  fs.writeFileSync(root+'/auth-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }catch(e){fs.writeFileSync(root+'/auth-partial-result.json',JSON.stringify({checks:results,error_class:e.name},null,2));console.error('Auth probe failed; sanitized status checks saved.');process.exitCode=1;}
 finally{await browser.close();}
})();
