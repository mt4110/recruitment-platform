import {chromium} from 'playwright';
import fs from 'node:fs';
const started=Date.now(), out='/out';fs.mkdirSync(out,{recursive:true});
for(const d of ['/tmp/m0-home','/tmp/m0-config','/tmp/m0-cache'])fs.mkdirSync(d,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chromium',chromiumSandbox:true});
const sandboxPage=await browser.newPage();await sandboxPage.goto('chrome://sandbox/');
const sandbox=await sandboxPage.locator('body').innerText();await sandboxPage.close();
const checks=[{name:'chromium_seccomp_sandbox',pass:/Seccomp-BPF sandbox\s+Yes/.test(sandbox)},{name:'chromium_namespace_sandbox',pass:/Layer 1 Sandbox\s+Namespace/.test(sandbox)&&/PID namespaces\s+Yes/.test(sandbox)&&/Network namespaces\s+Yes/.test(sandbox)}];
const segmenter=new Intl.Segmenter('ja',{granularity:'grapheme'});
const shorten=s=>{const a=[...segmenter.segment(s)].map(x=>x.segment);return a.length<=40?s:a.slice(0,39).join('')+'…';};
const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const examples=[
 {name:'invoice-normal',employer:'架空求人株式会社X',agency:'架空紹介会社A'},
 {name:'invoice-long',employer:'架空求人企業検証専用名称'.repeat(20),agency:'架空紹介会社長い名称の確認'.repeat(18)},
 {name:'invoice-escaped',employer:'架空<株式会社> & 検証',agency:'架空<img src=x onerror=alert(1)>紹介会社'}
];
let blockedRequests=0;
for(const data of examples){
 const page=await browser.newPage();await page.route('**/*',r=>{blockedRequests++;r.abort();});
 const e=escape(shorten(data.employer)),a=escape(shorten(data.agency));
 await page.setContent(`<!doctype html><html lang="ja"><meta charset="utf-8"><style>
 @page{size:A4;margin:16mm}*{box-sizing:border-box}body{margin:0;font-family:"Noto Sans CJK JP",sans-serif;font-size:12px;color:#20252a}
 .sheet{position:relative;height:264mm;width:178mm;padding:6mm 2mm}.demo{font-size:11px;color:#585d63;border-bottom:1px solid #d9dcdf;padding-bottom:12px}
 h1{font-size:27px;font-weight:500;letter-spacing:2px;margin:30px 0 25px}.parties{display:grid;grid-template-columns:1fr 1fr;gap:22px;margin:24px 0}
 .label{font-size:10px;color:#63696f;margin-bottom:8px}.name{font-size:14px;line-height:22px;min-height:44px;word-break:break-all}.id{font-family:monospace;font-size:10px;white-space:nowrap}
 .amount{margin-top:32px;font-size:36px;letter-spacing:1px}.caption{font-size:11px;color:#63696f;margin-top:8px}
 table{border-collapse:collapse;width:100%;margin-top:34px}th,td{text-align:left;border-bottom:1px solid #d9dcdf;padding:16px 8px}th{font-size:11px;color:#63696f;font-weight:400}td:last-child,th:last-child{text-align:right}
 .note{margin-top:24px;font-size:11px;line-height:1.8;color:#63696f}.footer{position:absolute;bottom:8mm;border-top:1px solid #d9dcdf;width:100%;padding-top:14px;font-size:11px;color:#585d63}
 </style><body><main class="sheet"><div class="demo">架空データ専用 / 請求書プレビュー</div><h1>請求書</h1>
 <div class="id">DEMO-00000000-0000-0000-0000-000000000001</div><div class="caption">採用決定日 2026年10月15日</div>
 <div class="parties"><section><div class="label">宛先</div><div class="name">${e}</div></section><section><div class="label">発行者</div><div class="name">${a}</div></section></div>
 <div class="amount">¥500,000</div><div class="caption">固定デモ金額</div><table><thead><tr><th>明細</th><th>金額</th></tr></thead><tbody><tr><td>人材紹介サービス（デモ）</td><td>¥500,000</td></tr></tbody></table>
 <div class="note">税額：未計算<br>支払い先・期日・登録番号は設定していません。</div><footer class="footer">デモ用・実際の請求には使用できません。</footer></main></body></html>`);
 await page.evaluate(()=>document.fonts.ready);
 const layout=await page.evaluate(()=>{
  const sheet=document.querySelector('.sheet').getBoundingClientRect(), footer=document.querySelector('.footer').getBoundingClientRect();
  return {names:[...document.querySelectorAll('.name')].map(x=>({height:x.getBoundingClientRect().height,overflow:x.scrollWidth>x.clientWidth+1})),
   unsafeElements:document.querySelectorAll('script,img,iframe').length,footerInside:footer.bottom<=sheet.bottom+1,bodyWidth:document.body.scrollWidth};
 });
 const ok=layout.names.every(x=>x.height<=44.5&&!x.overflow)&&layout.unsafeElements===0&&layout.footerInside;
 checks.push({name:data.name+'_layout',pass:ok,layout});
 if(!ok)throw Error('PDF_LAYOUT_ERROR');
 await page.pdf({path:out+'/'+data.name+'.pdf',format:'A4',preferCSSPageSize:true,printBackground:true});
 await page.close();
}
const result={scope:'M0 fixed-schema HTML rendering only; not app invoice endpoint',playwright:'1.62.1',chromium:browser.version(),sandbox_status:sandbox,
 elapsed_seconds:(Date.now()-started)/1000,blocked_requests:blockedRequests,checks,all_passed:checks.every(x=>x.pass)};
fs.writeFileSync(out+'/pdf-generation-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));await browser.close();
