// Private fixture display proof, not an application frontend.
const {chromium}=require(process.env.S0_PLAYWRIGHT||'../../.local/s0-browser/node_modules/playwright');
const fs=require('node:fs'),assert=require('node:assert/strict');
const [source,out]=process.argv.slice(2);let browser;
(async()=>{
 const views=JSON.parse(fs.readFileSync(source)),checks=[],errors=[];
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1280,height:800}});
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});await page.route('**/*',r=>r.abort());
 for(const [name,view] of Object.entries(views)){
  await page.setContent('<!doctype html><html lang="ja"><title>S0 書類表表示</title><style>body{font:16px sans-serif;margin:32px}td,th{padding:8px;text-align:left;border-bottom:1px solid #ccc;white-space:pre-wrap}button{padding:12px}small{display:block;color:#555}</style><h1>S0 合成データ表示</h1><p>画像・図形・書式は省略。数式は再計算していません。</p><button>非表示部分を開く</button><main></main></html>');
  await page.evaluate(data=>{
   window.show=false;window.paint=()=>{
    const main=document.querySelector('main');main.replaceChildren();
    for(const sheet of data.sheets){
     if(sheet.hidden&&!window.show)continue;
     const h=document.createElement('h2');h.textContent=sheet.name;main.append(h);const table=document.createElement('table');main.append(table);
     for(const cell of sheet.cells){
      if(cell.hidden&&!window.show)continue;
      const row=document.createElement('tr');table.append(row);
      for(const value of [cell.cell,cell.value,cell.warnings.join(' / ')]){const td=document.createElement('td');td.textContent=value;row.append(td);}
     }
     for(const merge of sheet.merges){const note=document.createElement('small');note.textContent='結合範囲（左上が結合先）: '+merge.join(',');main.append(note);}
    }
   };document.querySelector('button').onclick=()=>{window.show=!window.show;window.paint();};window.paint();
  },view);
  const scripts=await page.locator('script,iframe,img,svg').count();assert.equal(scripts,0);
  if(name==='hidden.xlsx'){
   const hiddenName=view.sheets[0].name;const heading=page.getByRole('heading',{name:hiddenName,exact:true});assert.equal(await heading.count(),0);const rows=await page.locator('tr').count();await page.locator('button').click();assert(await heading.isVisible());assert((await page.locator('tr').count())>=rows+2);
  }
  checks.push({fixture:name,rendered:true,unsafe_elements:scripts});
  if(name==='types.xlsx'){
   assert((await page.locator('main').innerText()).includes('<script>noop</script>'));
   assert((await page.locator('main').innerText()).includes('再計算していない保存値'));
  }
  // Keep rendered original contents private, separate from committed status proof.
  if(['types.xlsx','sheets-resume.xlsx','sheets-career-history.xlsx'].includes(name))await page.screenshot({path:out+'/private/'+name+'.png'});
 }
 assert.equal(errors.length,0);fs.writeFileSync(out+'/view.json',JSON.stringify({scope:'S0 normalized fixture table only; not product routes',checks,console_errors:errors},null,2));
 await browser.close();console.log(JSON.stringify({view_cases:checks.length,passed:true}));
})().catch(async e=>{if(browser)await browser.close();console.error(e.message);process.exitCode=1;});
