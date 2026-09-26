/**
 * Review form, VAT fields, in a real browser with the API mocked.
 *
 * Covers what a scan that misses the VAT used to break: the form refused an
 * empty VAT amount and silently defaulted the rate to 22. Also checks that a
 * detected rate (20%) is not rounded to an Italian one, that typing the amount
 * pre-fills the rate, and that a rate typed by hand is never rewritten.
 *
 *     cd frontend && npm ci && npm run build -- --mode prod && cd ..
 *     node test/e2e_review_vat.mjs frontend/dist
 *
 * Uses Playwright from e2e/node_modules. No network: every request to the API
 * host is answered locally and anything else is blocked.
 */
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import {createRequire} from 'node:module';
const require=createRequire('/home/salvo/easyreceipts/e2e/package.json'); const {chromium}=require('playwright');
const dist=path.resolve(process.argv[2]||'frontend/dist');
const M={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
const srv=http.createServer((q,r)=>{let f=path.join(dist,new URL(q.url,'http://x').pathname);if(!fs.existsSync(f)||fs.statSync(f).isDirectory())f=path.join(dist,'index.html');r.setHeader('content-type',M[path.extname(f)]||'application/octet-stream');fs.createReadStream(f).pipe(r)});
await new Promise(r=>srv.listen(0,'127.0.0.1',r)); const origin='http://127.0.0.1:'+srv.address().port;
const browser=await chromium.launch();
let failures=0; const check=(name,cond,detail='')=>{console.log((cond?'ok    ':'FAIL  ')+name+(cond?'':'  -> '+detail)); if(!cond) failures++;};

async function open(receipt){
  const ctx=await browser.newContext({viewport:{width:430,height:1100}});
  await ctx.addInitScript(()=>localStorage.setItem('spendify_id_token','fake-token'));
  const page=await ctx.newPage(); const puts=[]; const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const cors={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*'};
  await page.route('**/*',async route=>{
    const u=new URL(route.request().url()); const m=route.request().method();
    if(!u.hostname.includes('execute-api')) return u.origin===origin?route.continue():route.abort();
    if(m==='OPTIONS') return route.fulfill({status:200,headers:cors,body:'{}'});
    const j=b=>route.fulfill({status:200,headers:{...cors,'content-type':'application/json'},body:JSON.stringify(b)});
    if(u.pathname==='/categories') return j({categories:['Food','Travel'],source:'user'});
    if(u.pathname==='/me') return j({userId:'u',status:'trial',daysRemaining:10,trialEndsAt:0});
    if(u.pathname==='/receipts/r1'&&m==='GET') return j(receipt);
    if(u.pathname==='/receipts/r1'&&m==='PUT'){puts.push(JSON.parse(route.request().postData()));return j({receiptId:'r1',item:{}});}
    return j({});
  });
  await page.goto(origin+'/review/r1'); await page.waitForSelector('#vat');
  await page.waitForFunction(()=>document.querySelector('#total')?.value!=='' ,null,{timeout:5000});
  return {page,puts,errors,ctx};
}
const val=(page,sel)=>page.inputValue(sel);
const base={receiptId:'r1',status:'OCR_DONE',payee:'Bar Roma',date:'2026-03-04',total:'12.20'};

// A. the scan found no VAT
{ const {page,puts,ctx}=await open(base);
  check('A1 no VAT scanned: amount defaults to 0', await val(page,'#vat')==='0', await val(page,'#vat'));
  check('A2 no VAT scanned: rate defaults to 0 (not the old 22)', await val(page,'#vatRate')==='0', await val(page,'#vatRate'));
  await page.click('#vat'); await page.fill('#vat','2,20');
  check('A3 typing the VAT amount pre-fills the rate (12,20 / 2,20 -> 22)', await val(page,'#vatRate')==='22', await val(page,'#vatRate'));
  await page.click('text=Save Draft'); await page.waitForTimeout(500);
  check('A4 saved with vat 2.2 and rate 22', puts[0]?.vat===2.2 && puts[0]?.vatRate==='22', JSON.stringify(puts[0]));
  await ctx.close(); }

// B. empty VAT field is accepted
{ const {page,puts,ctx}=await open(base);
  await page.fill('#vat','');
  await page.click('text=Save Draft'); await page.waitForTimeout(500);
  check('B1 empty VAT amount is accepted (no validation error)', (await page.locator('text=Enter a number').count())===0 && puts.length===1, JSON.stringify(puts));
  check('B2 empty VAT amount is stored as 0 at rate 0', puts[0]?.vat===0 && puts[0]?.vatRate==='0', JSON.stringify(puts[0]));
  await ctx.close(); }

// C. the scan found VAT and a rate: typing must not rewrite the rate
{ const {page,puts,ctx}=await open({...base,total:'12.00',vat:'2.00',vatRate:'20'});
  check('C1 scanned VAT and rate are shown as they are', await val(page,'#vat')==='2' || await val(page,'#vat')==='2,00' , await val(page,'#vat'));
  check('C2 the scanned 20% is not rounded to 22', await val(page,'#vatRate')==='20', await val(page,'#vatRate'));
  await page.fill('#vat','3'); 
  check('C3 editing the amount does not overwrite a detected rate', await val(page,'#vatRate')==='20', await val(page,'#vatRate'));
  await ctx.close(); }

// D. a rate typed by hand stays
{ const {page,puts,ctx}=await open(base);
  await page.fill('#vatRate','7,7'); await page.fill('#vat','0,90');
  check('D1 a manual rate is not overwritten by later amounts', await val(page,'#vatRate')==='7,7', await val(page,'#vatRate'));
  await page.click('text=Save Draft'); await page.waitForTimeout(500);
  check('D2 saved as 7.7', puts[0]?.vatRate==='7.7' && puts[0]?.vat===0.9, JSON.stringify(puts[0]));
  await ctx.close(); }

// E. junk is still refused
{ const {page,puts,ctx}=await open(base);
  await page.fill('#vat','abc'); await page.click('text=Save Draft'); await page.waitForTimeout(400);
  check('E1 a non-numeric VAT amount is still refused', puts.length===0 && (await page.locator('text=Enter a number').count())>0);
  await ctx.close(); }

await browser.close(); srv.close();
console.log(failures?`\n${failures} FAILED`:'\nall passed'); process.exit(failures?1:0);
