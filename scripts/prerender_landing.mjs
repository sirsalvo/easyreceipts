#!/usr/bin/env node
// Bakes the rendered homepage into dist/index.html so crawlers get real text
// and an <h1> without executing JS. The Lovable build ships `<div id="root">`
// empty. Usage: node scripts/prerender_landing.mjs <dist-dir>
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '..', 'e2e', 'package.json'));
const { chromium } = require('playwright');

const dist = path.resolve(process.argv[2] || '');
const indexPath = path.join(dist, 'index.html');
if (!process.argv[2] || !fs.existsSync(indexPath)) {
  console.error('usage: prerender_landing.mjs <dist-dir containing index.html>');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.json': 'application/json', '.txt': 'text/plain',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.join(dist, urlPath);
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = indexPath;
  }
  res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  // Only our own files: keeps the output deterministic (no font/CDN variance).
  await page.route('**/*', (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await page.goto(origin + '/', { waitUntil: 'load' });
  await page.waitForSelector('h1');
  // framer-motion writes inline opacity/transform; let it settle so the baked
  // markup is in its final state, not mid-animation.
  await page.waitForTimeout(2000);
  const rootHtml = await page.$eval('#root', (el) => el.innerHTML);
  const text = await page.$eval('#root', (el) => el.innerText);

  if (!/<h1[\s>]/.test(rootHtml) || text.trim().length < 500) {
    throw new Error(`prerender looks wrong: h1=${/<h1[\s>]/.test(rootHtml)} textLength=${text.trim().length}`);
  }

  let html = fs.readFileSync(indexPath, 'utf8');
  if (!html.includes('<div id="root"></div>')) {
    throw new Error('dist/index.html has no empty <div id="root"></div> (already prerendered?)');
  }
  html = html.replace('<div id="root"></div>', () => `<div id="root">${rootHtml}</div>`);

  // No ratings exist for this product; Google treats invented review markup
  // as a structured-data spam violation.
  html = html.replace(/,\s*"aggregateRating":\s*\{[^}]*\}/, '');

  // The build declares /spendify-icon.png (694x677, not square), which Google
  // rejects and answers with the root /favicon.ico. Declare the square set.
  const icons = [
    '<link rel="icon" href="/favicon.ico" sizes="any" />',
    '<link rel="icon" type="image/png" sizes="96x96" href="/favicon-96.png" />',
    '<link rel="icon" type="image/png" sizes="192x192" href="/favicon-192.png" />',
    '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />',
  ].join('\n    ');
  const before = html;
  html = html
    .replace(/<link rel="icon"[^>]*spendify-icon\.png"[^>]*\/>\s*/, `${icons}\n    `)
    .replace(/<link rel="apple-touch-icon" href="\/spendify-icon\.png"[^>]*\/>\s*/, '');
  if (html === before) throw new Error('favicon links not found in dist/index.html');

  // Canonical form is with a trailing slash; without it CloudFront answers 301.
  html = html.replace(/href="\/(ynab-receipts|receipt-to-csv)"/g, 'href="/$1/"');

  fs.writeFileSync(indexPath, html);
  console.log(`prerendered: ${rootHtml.length} bytes of markup, ${text.trim().length} chars of text`);
} finally {
  await browser.close();
  server.close();
}
