#!/usr/bin/env node
/*
  Busy export, in a real Chromium: seed bills, open "Export to Busy", download, check the file.
  Local-only mode (blank Firebase config), so nothing reaches the real project.
  Run:   node tests/busy-export.e2e.test.mjs            (serves this folder)
         node tests/busy-export.e2e.test.mjs https://mtarvecha660-lgtm.github.io/kirana-desk/
*/
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let pw;
for (const name of ['playwright', 'playwright-core', process.env.PLAYWRIGHT_PATH].filter(Boolean)) { try { pw = require(name); break; } catch (_) {} }
if (!pw) { console.error('Playwright not found. Run: npm i -D playwright && npx playwright install chromium'); process.exit(2); }
const { chromium } = pw;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_CONFIG = 'export const firebaseConfig = { apiKey: "REPLACE_", projectId: "REPLACE_", appId: "REPLACE_" };';

function serve() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }); fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const eq = (a, b, m) => ok(a === b, m + (a === b ? '' : ` (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`));
const val = (xml, t) => { const m = xml.match(new RegExp('<' + t + '>([^<]*)</' + t + '>')); return m ? m[1] : undefined; };

const BILLS = [
  { id: 't1', businessId: 'sampurn', financialYear: '2026-27', sequence: 41, billNumber: 'RS/2026-27/0041', date: '2026-10-05', customerName: 'Test Party', gst: 5, notes: '', createdAt: '2026-10-05T10:00:00Z',
    items: [{ productName: 'Sugar', brand: '', price: 44.6, quantity: 500, unit: 'kg' }, { productName: 'Rice', brand: '', price: 53.4, quantity: 10, unit: 'kg' }, { productName: 'Haldi Powder', brand: 'Pushp', price: 279, quantity: 30, unit: 'kg' }] },
  { id: 't2', businessId: 'sampurn', financialYear: '2026-27', sequence: 42, billNumber: 'RS/2026-27/0042', date: '2026-10-06', customerName: '', gst: null, notes: '', createdAt: '2026-10-06T10:00:00Z',
    items: [{ productName: 'Salt', brand: '', price: 8, quantity: 150, unit: 'kg' }] },
  { id: 't3', businessId: 'sampurn', financialYear: '2026-27', sequence: 43, billNumber: 'RS/2026-27/0043', date: '2026-10-07', customerName: 'Test Party', gst: null, notes: '', createdAt: '2026-10-07T10:00:00Z',
    items: [{ productName: 'Atta', brand: '', price: null, quantity: 5, unit: 'kg' }] },
  { id: 't4', businessId: 'surya', financialYear: '2026-27', sequence: 1, billNumber: 'SS/2026-27/0001', date: '2026-10-05', customerName: 'Other', gst: null, notes: '', createdAt: '2026-10-05T10:00:00Z',
    items: [{ productName: 'Salt', brand: '', price: 8, quantity: 1, unit: 'kg' }] }
];

async function main() {
  let base = process.argv[2], srv = null;
  if (!base) { srv = await serve(); base = `http://127.0.0.1:${srv.address().port}/`; }
  if (!base.endsWith('/')) base += '/';
  console.log('Testing ' + base);
  const browser = await chromium.launch({ headless: !process.env.HEADED, executablePath: process.env.CHROME_PATH || undefined });
  const ctx = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true, viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/firebase-config.js', r => r.fulfill({ contentType: 'text/javascript', body: LOCAL_CONFIG }));
  await page.route('https://www.gstatic.com/firebasejs/**', r => r.abort());
  await page.goto(base + '?t=' + Date.now()); await page.waitForSelector('#page-content .page-head', { timeout: 15000 });
  await page.evaluate(bills => new Promise((res, rej) => { const r = indexedDB.open('kirana-desk'); r.onsuccess = () => { const tx = r.result.transaction('bills', 'readwrite'); bills.forEach(b => tx.objectStore('bills').put(b)); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }; }), BILLS);

  console.log('\n1. Page');
  await page.click('.main-nav [data-page="busy"], [data-page="busy"]'); await page.waitForSelector('#busy-export-btn');
  eq(await page.textContent('.page-title'), 'Export to Busy', '"Export to Busy" page opens from the sidebar');
  ok((await page.textContent('#page-content')).includes('backup or test company'), 'page warns to try a backup/test company first');
  for (const n of ['Sugar', 'Rice', 'Haldi Powder', 'Salt', 'Atta']) ok(await page.$(`[data-busy-item="${n.toLowerCase()}"]`) !== null, 'item row for ' + n);
  // set a mapping: Haldi = GST 5%, HSN 0910, brand parameter; Rice/Salt Non-GST
  await page.fill('[data-busy-item="haldi powder"] [data-busy="taxCategory"]', 'GST 5%');
  await page.fill('[data-busy-item="haldi powder"] [data-busy="hsn"]', '0910');
  await page.check('[data-busy-item="haldi powder"] [data-busy="param"]');
  await page.fill('[data-busy-item="rice"] [data-busy="taxCategory"]', 'Non-GST');
  await page.fill('[data-busy-item="salt"] [data-busy="taxCategory"]', 'Non-GST');
  await page.fill('#busy-cashParty', 'Cash');
  await page.click('[data-action="busy-save"]'); await page.waitForTimeout(300);

  console.log('\n2. One bill → one .xml');
  await page.fill('#busy-from', '2026-10-05'); await page.fill('#busy-to', '2026-10-05');
  let [dl] = await Promise.all([page.waitForEvent('download'), page.click('#busy-export-btn')]);
  eq(dl.suggestedFilename(), 'Sales-RS-2026-27-0041.xml', 'downloads Sales-RS-2026-27-0041.xml (only the RS form, only that day)');
  const buf = fs.readFileSync(await dl.path()); const xml = buf.toString('latin1');
  const parsed = await page.evaluate(s => { const d = new DOMParser().parseFromString(s, 'application/xml'); return d.getElementsByTagName('parsererror').length ? 'ERROR' : d.documentElement.nodeName; }, xml);
  eq(parsed, 'Sale', 'file is well-formed XML with root <Sale>');
  ok(xml.startsWith('<?xml version="1.0" encoding="iso8859-1"?>'), 'iso8859-1 like Busy');
  eq(val(xml, 'Date'), '05-10-2026', 'date dd-mm-yyyy'); eq(val(xml, 'VchNo'), 'RS/2026-27/0041', 'VchNo = bill number');
  eq(val(xml, 'MasterName1'), 'Test Party', 'party = customer'); eq(val(xml, 'VchSeriesName'), 'Main', 'series Main'); eq(val(xml, 'MasterName2'), 'Main Store', 'material centre');
  const amts = [...xml.matchAll(/<AmtMainCur>([^<]*)<\/AmtMainCur>/g)].map(m => Number(m[1]));
  eq(amts.length, 4, '4 account lines (party, Sales, CGST, SGST)');
  eq(Math.round(amts.reduce((a, b) => a + b, 0) * 100), 0, 'account lines balance');
  eq(amts[0], -(22300 + 534 + 8370), 'party debit = bill total 31204');
  eq(amts[2], 530.95 + 199.29, 'CGST = 530.95 (sugar, from bill GST 5%) + 199.29 (haldi)');
  ok(xml.includes('<ItemTaxCategory>Non-GST</ItemTaxCategory>') && xml.includes('<ItemHSNCode>0910</ItemHSNCode>') && xml.includes('<Param1>Pushp</Param1>'), 'item mapping used: Non-GST rice, HSN 0910, brand parameter for Haldi');
  fs.mkdirSync(path.join(ROOT, 'tests', 'out'), { recursive: true }); fs.writeFileSync(path.join(ROOT, 'tests', 'out', 'e2e-' + dl.suggestedFilename()), buf);

  console.log('\n3. Several bills → .zip, unpriced bill skipped');
  await page.fill('#busy-from', '2026-10-01'); await page.fill('#busy-to', '2026-10-31');
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#busy-export-btn')]);
  eq(dl.suggestedFilename(), 'Busy-Sales-RS-2026-10-01-to-2026-10-31.zip', 'zip for a range');
  const zip = fs.readFileSync(await dl.path());
  const names = []; for (let i = 0; i + 30 < zip.length; i++) if (zip.readUInt32LE(i) === 0x04034b50) { const n = zip.readUInt16LE(i + 26); names.push(zip.slice(i + 30, i + 30 + n).toString()); }
  eq(names.join(','), 'Sales-RS-2026-27-0041.xml,Sales-RS-2026-27-0042.xml', 'zip holds one .xml per priced bill');
  const res = await page.textContent('#busy-result');
  ok(/2 vouchers/.test(res) && /RS\/2026-27\/0043/.test(res) && /no price/.test(res), 'screen says 2 vouchers and names the skipped unpriced bill');
  const shot = path.join(ROOT, 'tests', 'out', 'busy-page.png'); await page.screenshot({ path: shot, fullPage: true });

  console.log('\n4. Settings survive a reload');
  await page.reload(); await page.waitForSelector('#page-content .page-head'); await page.click('[data-page="busy"]'); await page.waitForSelector('#busy-export-btn');
  eq(await page.inputValue('[data-busy-item="haldi powder"] [data-busy="hsn"]'), '0910', 'item mapping saved');
  eq(errors.filter(e => !/firebase|gstatic|Failed to load resource/i.test(e)).join(' | '), '', 'no page errors');

  await browser.close(); if (srv) srv.close();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
