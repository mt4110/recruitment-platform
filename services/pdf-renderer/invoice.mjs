import {chromium} from 'playwright';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const data=JSON.parse(fs.readFileSync(0,'utf8'));
const keys=['placement_id','invoice_number','decided_on','issuer','recipient','amount_yen','tax_label','demo_notice'];
if(Object.keys(data).sort().join()!==keys.sort().join()||data.amount_yen!==500000||data.tax_label!=='未計算'||data.demo_notice!=='デモ用・実際の請求には使用できません。'||!/^DEMO-[0-9a-f-]{36}$/.test(data.invoice_number)||data.invoice_number!=='DEMO-'+data.placement_id||!/^\d{4}-\d{2}-\d{2}$/.test(data.decided_on)||![data.issuer,data.recipient].every(s=>typeof s==='string'&&Array.from(s).length>=1&&Array.from(s).length<=200&&!/[\u0000-\u001f\u007f]/.test(s)))throw Error('INVALID_SCHEMA');
for(const p of ['/tmp/pdf-home','/tmp/pdf-config','/tmp/pdf-cache'])fs.mkdirSync(p,{recursive:true});
const segmenter=new Intl.Segmenter('ja',{granularity:'grapheme'});
const shorten=s=>{const a=[...segmenter.segment(s)].map(x=>x.segment);return a.length<=40?s:a.slice(0,39).join('')+'…';};
const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
let browser;
process.on('SIGTERM',()=>{void (async()=>{await browser?.close();process.exit(1);})();});
try{
 browser=await chromium.launch({headless:true,channel:'chromium',chromiumSandbox:true,timeout:3000});
 const check=await browser.newPage();await check.goto('chrome://sandbox/');const sandbox=await check.locator('body').innerText();await check.close();
 if(!/Seccomp-BPF sandbox\s+Yes/.test(sandbox)||!/Layer 1 Sandbox\s+Namespace/.test(sandbox)||!/PID namespaces\s+Yes/.test(sandbox)||!/Network namespaces\s+Yes/.test(sandbox))throw Error('SANDBOX_REQUIRED');
 const page=await browser.newPage();await page.route('**/*',r=>r.abort());
 const e=escape(shorten(data.recipient)),a=escape(shorten(data.issuer));
 await page.setContent(`<!doctype html><html lang="ja"><meta charset="utf-8"><style>
 @page{size:A4;margin:16mm}*{box-sizing:border-box}body{margin:0;font-family:"Noto Sans CJK JP",sans-serif;font-size:12px;color:#20252a}
 .sheet{position:relative;height:264mm;width:178mm;padding:6mm 2mm}.demo{font-size:11px;color:#585d63;border-bottom:1px solid #d9dcdf;padding-bottom:12px}
 h1{font-size:27px;font-weight:500;letter-spacing:2px;margin:30px 0 25px}.parties{display:grid;grid-template-columns:1fr 1fr;gap:22px;margin:24px 0}
 .label{font-size:10px;color:#63696f;margin-bottom:8px}.name{font-size:14px;line-height:22px;min-height:44px;word-break:break-all}.id{font-family:monospace;font-size:10px;white-space:nowrap}
 .amount{margin-top:32px;font-size:36px;letter-spacing:1px}.caption{font-size:11px;color:#63696f;margin-top:8px}
 table{border-collapse:collapse;width:100%;margin-top:34px}th,td{text-align:left;border-bottom:1px solid #d9dcdf;padding:16px 8px}th{font-size:11px;color:#63696f;font-weight:400}td:last-child,th:last-child{text-align:right}
 .note{margin-top:24px;font-size:11px;line-height:1.8;color:#63696f}.footer{position:absolute;bottom:8mm;border-top:1px solid #d9dcdf;width:100%;padding-top:14px;font-size:11px;color:#585d63}
 </style><body><main class="sheet"><div class="demo">デモ用・実際の請求には使用できません。</div><h1>請求書</h1>
 <div class="id">${escape(data.invoice_number)}</div><div class="caption">採用決定日 ${escape(data.decided_on)}</div>
 <div class="parties"><section><div class="label">宛先</div><div class="name">${e}</div></section><section><div class="label">発行者</div><div class="name">${a}</div></section></div>
 <div class="amount">¥500,000</div><div class="caption">固定デモ金額</div><table><thead><tr><th>明細</th><th>金額</th></tr></thead><tbody><tr><td>人材紹介サービス（デモ）</td><td>¥500,000</td></tr></tbody></table>
 <div class="note">税額：未計算<br>支払い先・期日・登録番号は設定していません。</div><footer class="footer">デモ用・実際の請求には使用できません。</footer></main></body></html>`);
 await page.evaluate(()=>document.fonts.ready);
 const layout=await page.evaluate(()=>{const sheet=document.querySelector('.sheet').getBoundingClientRect(),footer=document.querySelector('.footer').getBoundingClientRect();return document.fonts.check('12px "Noto Sans CJK JP"')&&[...document.querySelectorAll('.name')].every(x=>x.getBoundingClientRect().height<=44.5&&x.scrollWidth<=x.clientWidth+1)&&!document.querySelector('script,img,iframe')&&footer.bottom<=sheet.bottom+1;});
 if(!layout)throw Error('PDF_LAYOUT_ERROR');
 const pdf=await page.pdf({format:'A4',preferCSSPageSize:true,printBackground:true});
 execFileSync('/usr/local/bin/python',['-c','import sys,io,pikepdf; p=pikepdf.Pdf.open(io.BytesIO(sys.stdin.buffer.read())); assert len(p.pages)==1; b=p.pages[0].mediabox; assert abs(float(b[2])-595.28)<2 and abs(float(b[3])-841.89)<2'],{input:pdf,timeout:1000,stdio:['pipe','pipe','pipe']});
 if(pdf.length>524288)throw Error('PDF_LAYOUT_ERROR');process.stdout.write(pdf);
}catch(e){process.stderr.write(e.message==='PDF_LAYOUT_ERROR'?'PDF_LAYOUT_ERROR':'PDF_UNAVAILABLE');process.exitCode=1;}finally{await browser?.close();}
