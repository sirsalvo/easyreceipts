/**
 * Free-tier quota UX, in a real browser with the API mocked.
 *
 * Covers the frontend half of the trial -> free-tier-forever switch: the
 * banner shows "X of N receipts used" (not the old trial-day countdown),
 * hides entirely for an active subscriber, switches to the exhausted-quota
 * message at 0 remaining, and a 402 QUOTA_EXCEEDED from POST /receipts shows
 * a friendly toast and sends the user to Settings instead of the raw JSON
 * body or a forced logout (apiRequest treats 401/403, not 402, as an expired
 * session).
 *
 *     cd frontend && npm ci && npm run build -- --mode prod && cd ..
 *     node test/e2e_free_tier.mjs frontend/dist
 *
 * Uses Playwright from e2e/node_modules. No network: every request to the
 * API host is answered locally and anything else is blocked.
 */
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import {createRequire} from 'node:module';
const require=createRequire('/home/salvo/easyreceipts/e2e/package.json'); const {chromium}=require('playwright');
const dist=path.resolve(process.argv[2]||'frontend/dist');
const M={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
const srv=http.createServer((q,r)=>{let f=path.join(dist,new URL(q.url,'http://x').pathname);if(!fs.existsSync(f)||fs.statSync(f).isDirectory())f=path.join(dist,'index.html');r.setHeader('content-type',M[path.extname(f)]||'application/octet-stream');fs.createReadStream(f).pipe(r)});
await new Promise(r=>srv.listen(0,'127.0.0.1',r)); const origin='http://127.0.0.1:'+srv.address().port;
const browser=await chromium.launch();
let failures=0; const check=(name,cond,detail='')=>{console.log((cond?'ok    ':'FAIL  ')+name+(cond?'':'  -> '+detail)); if(!cond) failures++;};

async function openPage(path, me, receiptsPostHandler){
  const ctx=await browser.newContext({viewport:{width:430,height:900}});
  await ctx.addInitScript(()=>localStorage.setItem('spendify_id_token','fake-token'));
  const page=await ctx.newPage();
  const cors={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*'};
  await page.route('**/*',async route=>{
    const u=new URL(route.request().url()); const m=route.request().method();
    if(!u.hostname.includes('execute-api')) return u.origin===origin?route.continue():route.abort();
    if(m==='OPTIONS') return route.fulfill({status:200,headers:cors,body:'{}'});
    const j=(status,b)=>route.fulfill({status,headers:{...cors,'content-type':'application/json'},body:JSON.stringify(b)});
    if(u.pathname==='/me') return j(200, me);
    if(u.pathname==='/categories') return j(200,{categories:['Food'],source:'user'});
    if(u.pathname==='/receipts'&&m==='POST') return receiptsPostHandler(j);
    if(u.pathname==='/receipts'&&m==='GET') return j(200,{items:[],count:0,truncated:false});
    return j(200,{});
  });
  await page.goto(origin+path);
  return {page,ctx};
}

const freeUser=(used,limit=5)=>({userId:'u',status: used>=limit?'expired':'trial', freeTier:{limit,used,remaining:Math.max(0,limit-used),period:'2026-09',resetsAt:'2026-10-01T00:00:00+00:00'}});
const activeUser={userId:'u',status:'active',freeTier:null};

// A. banner shows partial usage, not the old trial-days copy
{ const {page,ctx}=await openPage('/upload', freeUser(3,5), j=>j(200,{receiptId:'r1',uploadUrl:origin+'/x'}));
  await page.waitForSelector('text=Free plan');
  const banner=await page.textContent('body');
  check('A1 banner shows "3 of 5" usage', banner.includes('3 of 5 receipts used'), banner.slice(0,200));
  check('A2 old trial-days wording is gone', !banner.includes('days remaining') && !banner.includes('free trial has ended'));
  check('A3 button says Upgrade', (await page.locator('button:has-text("Upgrade")').count())>0);
  await ctx.close(); }

// B. banner hidden for an active (paying) subscriber
{ const {page,ctx}=await openPage('/upload', activeUser, j=>j(200,{receiptId:'r1',uploadUrl:origin+'/x'}));
  await page.waitForTimeout(600);
  check('B1 no banner for an active subscriber', (await page.locator('text=Free plan').count())===0 && (await page.locator('text=Upgrade').count())===0);
  await ctx.close(); }

// C. quota exhausted: banner in the urgent state
{ const {page,ctx}=await openPage('/upload', freeUser(5,5), j=>j(200,{receiptId:'r1',uploadUrl:origin+'/x'}));
  await page.waitForSelector('text=Resets');
  const banner=await page.textContent('body');
  check('C1 banner shows the exhausted-quota message', banner.includes("used all 5 free receipts"), banner.slice(0,200));
  await ctx.close(); }

// D. a 402 from the backend on upload shows a friendly message, not raw JSON, and does not log the user out
{ const {page,ctx}=await openPage('/upload', freeUser(5,5),
    j=>j(402,{error:'QUOTA_EXCEEDED',message:"You've used all 5 free receipts this month. Upgrade to keep scanning, or wait for your quota to reset.",limit:5,used:5,resetsAt:'2026-10-01T00:00:00+00:00'}));
  await page.setInputFiles('input[type=file]', {name:'r.png',mimeType:'image/png',buffer:Buffer.from([137,80,78,71,13,10,26,10])});
  const uploadBtn = page.getByRole('button', {name:'Upload', exact:true}).first();
  await uploadBtn.waitFor({state:'visible'});
  await uploadBtn.click();
  await page.waitForSelector('text=Free plan limit reached');
  check('D1 toast title is friendly, not a generic failure', (await page.locator('text=Free plan limit reached').count())>0);
  check('D2 toast body is the backend message, not raw JSON', (await page.locator('text=Upgrade to keep scanning').count())>0 && (await page.locator('text={"error"').count())===0);
  await page.waitForURL('**/settings', {timeout:3000}).catch(()=>{});
  check('D3 redirected to Settings so the user can upgrade', page.url().includes('/settings'), page.url());
  check('D4 user was not logged out (still has a token)', await page.evaluate(()=>!!localStorage.getItem('spendify_id_token')));
  await ctx.close(); }

await browser.close(); srv.close();
console.log(failures?`\n${failures} FAILED`:'\nall passed'); process.exit(failures?1:0);
