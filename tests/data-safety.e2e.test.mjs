#!/usr/bin/env node
/*
  Kirana Desk data-safety test: Recycle bin (soft delete), restore, bill numbers never reused,
  no edit history kept (an edit overwrites; old history fields are dropped), automatic daily backup (once per day), and backup → restore round trip.
  Runs on local data only (firebase-config.js is swapped for a blank config inside the test browser).

  Run:   node tests/data-safety.e2e.test.mjs            (serves this folder on a local port)
         node tests/data-safety.e2e.test.mjs https://mtarvecha660-lgtm.github.io/kirana-desk/   (live site)
  Env:   CHROME_PATH=/path/to/chrome, PLAYWRIGHT_PATH=/path/to/playwright-core, HEADED=1
*/
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.woff2': 'font/woff2' };
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

let pass = 0, fail = 0; const failures = [];
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; failures.push(msg); console.log('  ✗ ' + msg); } }
const eq = (a, b, msg) => ok(a === b, msg + (a === b ? '' : ` (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`));

async function main() {
  let base = process.argv[2], srv = null;
  if (!base) { srv = await serve(); base = `http://127.0.0.1:${srv.address().port}/`; }
  if (!base.endsWith('/')) base += '/';
  console.log('Testing ' + base);
  const browser = await chromium.launch({ headless: !process.env.HEADED, executablePath: process.env.CHROME_PATH || undefined });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kirana-safety-'));

  async function open() {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1366, height: 900 }, acceptDownloads: true });
    const page = await ctx.newPage();
    page.errors = []; page.downloads = []; page.__confirms = [];
    page.on('console', m => { if (m.type() === 'error') page.errors.push(m.text()); });
    page.on('pageerror', e => page.errors.push(String(e)));
    page.on('dialog', d => { page.__confirms.push(d.message()); d.accept(); });
    page.on('download', async d => { const file = path.join(tmp, Date.now() + '-' + d.suggestedFilename()); await d.saveAs(file); page.downloads.push({ name: d.suggestedFilename(), file }); });
    await page.route('**/firebase-config.js', r => r.fulfill({ contentType: 'text/javascript', body: LOCAL_CONFIG }));
    await page.route('https://www.gstatic.com/firebasejs/**', r => r.abort());
    await page.goto(base + '?t=' + Date.now());
    await page.waitForSelector('#page-content .page-head', { timeout: 15000 });
    return { page, ctx };
  }
  const W = (p, ms = 150) => p.waitForTimeout(ms);
  const press = async (p, k) => { await p.keyboard.press(k); await W(p, 120); };
  const typeEnter = async (p, text) => { if (text) await p.keyboard.type(text); await W(p, 140); await p.keyboard.press('Enter'); await W(p, 160); };
  const raw = (p, store) => p.evaluate(s => new Promise(res => { const r = indexedDB.open('kirana-desk'); r.onsuccess = () => { const q = r.result.transaction(s).objectStore(s).getAll(); q.onsuccess = () => res(q.result); }; }), store);
  const todayIn = p => p.evaluate(() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); });
  const dailies = p => p.downloads.filter(d => /^kirana-backup-\d{4}-\d{2}-\d{2}\.json$/.test(d.name));
  async function newBill(p, customer, product, qty) {
    await press(p, 'Escape'); await press(p, 'Escape');
    await press(p, 'n'); await W(p, 400);
    await typeEnter(p, customer); await typeEnter(p, product); await typeEnter(p, ''); await typeEnter(p, ''); await typeEnter(p, String(qty));
    await p.keyboard.type('kg'); await W(p, 150);
    await p.keyboard.press('Control+Enter'); await W(p, 900);
    const bills = await raw(p, 'bills');
    const b = bills.filter(x => x.customerName === customer).sort((a, c) => String(c.createdAt).localeCompare(String(a.createdAt)))[0];
    await press(p, 'Escape'); await W(p, 200);
    return b;
  }
  async function openBill(p, id) {
    await press(p, 'Escape'); await p.evaluate(() => document.querySelectorAll('dialog[open]').forEach(d => d.close()));
    await press(p, 'Alt+2'); await W(p, 400);
    await p.click(`#page-content [data-action=view-bill][data-id="${id}"]`); await W(p, 500);
  }

  // ---------- 1. Daily backup on first open, once per day ----------
  console.log('\n1. Automatic daily backup');
  const A = await open(); const page = A.page;
  await W(page, 2600);
  const day = await todayIn(page);
  eq(dailies(page).length, 1, 'first open of the day downloads one full backup');
  eq(dailies(page)[0] && dailies(page)[0].name, 'kirana-backup-' + day + '.json', 'file is named kirana-backup-YYYY-MM-DD.json');
  eq(await page.evaluate(() => localStorage.getItem('kiranaDeskDailyBackupDay')), day, 'today is recorded as backed up');
  ok(await page.evaluate(() => [...document.querySelectorAll('.toast')].some(t => /Daily backup saved/.test(t.textContent))), 'a small toast says the daily backup was saved');
  await page.reload(); await page.waitForSelector('#page-content .page-head'); await W(page, 2600);
  eq(dailies(page).length, 1, 'reopening the same day does NOT download again (once per day)');

  // ---------- 2. Bills, soft delete, numbering ----------
  console.log('\n2. Soft delete and bill numbers');
  const b1 = await newBill(page, 'Safety One', 'Sugar', 2);
  const b2 = await newBill(page, 'Safety Two', 'Sugar', 3);
  const b3 = await newBill(page, 'Safety Three', 'Sugar', 4);
  ok(b1 && b2 && b3, 'three bills saved');
  const n = b => Number(String(b.billNumber).slice(-4));
  eq([n(b2) - n(b1), n(b3) - n(b2)].join(','), '1,1', 'bills get consecutive numbers (' + b1.billNumber + ' … ' + b3.billNumber + ')');
  await W(page, 5600);
  eq(dailies(page).length, 1, 'saving bills later the same day does not make another daily file');

  await openBill(page, b3.id);
  page.__confirms = [];
  await page.click('#bill-dialog [data-action=delete-bill]'); await W(page, 700);
  ok(page.__confirms.some(m => /Delete this bill/.test(m) && /Recycle bin/.test(m)), 'delete asks first and mentions the Recycle bin');
  let r3 = (await raw(page, 'bills')).find(x => x.id === b3.id);
  ok(r3 && r3.deleted === true, 'deleted bill is still in the database, marked deleted:true');
  ok(r3 && r3.deletedAt && r3.deletedBy === 'this computer', 'deletedAt and deletedBy are recorded');
  await press(page, 'Alt+2'); await W(page, 500);
  ok(!(await page.evaluate(id => !!document.querySelector(`#page-content [data-action=view-bill][data-id="${id}"]`), b3.id)), 'deleted bill is hidden from Records');
  eq(await page.evaluate(() => document.getElementById('bill-nav-count').textContent), '2', 'bill count in the menu excludes the deleted bill');
  const busy = await page.evaluate(async bills => { const m = await import('./busy-export.js'); return { n: m.buildBusyExport(bills, {}).files.length + m.buildBusyExport(bills, {}).skipped.length, find: !!m.findBillByNo(bills, bills.find(b => b.deleted).billNumber), one: !!m.singleBillExport(bills.find(b => b.deleted), {}).file }; }, await raw(page, 'bills'));
  eq(busy.n, 2, 'Busy export leaves out the deleted bill');
  ok(!busy.find && !busy.one, 'single-bill Busy export cannot pick a deleted bill');

  const b4 = await newBill(page, 'Safety Four', 'Sugar', 5);
  eq(n(b4), n(b3) + 1, 'next bill gets a NEW number; the deleted number ' + b3.billNumber + ' is not reused');
  await page.evaluate(id => new Promise(res => { const r = indexedDB.open('kirana-desk'); r.onsuccess = () => { const tx = r.result.transaction('counters', 'readwrite'); tx.objectStore('counters').delete(id); tx.oncomplete = res; }; }), b4.businessId + ':' + b4.financialYear);
  const b5 = await newBill(page, 'Safety Five', 'Sugar', 6);
  eq(n(b5), n(b4) + 1, 'even with the counter missing, numbering continues after the highest used number');

  // ---------- 3. Recycle bin + restore ----------
  console.log('\n3. Recycle bin and restore');
  await press(page, 'Alt+6'); await W(page, 600);
  ok(await page.evaluate(no => { const t = document.getElementById('recycle-bin'); return !!t && t.textContent.includes(no); }, b3.billNumber), 'Backup & restore page lists the deleted bill in the Recycle bin');
  ok(/^Last backup: /.test(await page.textContent('#last-backup-line')) && !/never/.test(await page.textContent('#last-backup-line')), 'Backup page shows "Last backup: <date time>"');
  ok(!(await page.$('#backup-warning')), 'no warning badge right after a backup');
  await page.click(`#recycle-bin [data-action=restore-deleted][data-id="${b3.id}"]`); await W(page, 700);
  r3 = (await raw(page, 'bills')).find(x => x.id === b3.id);
  ok(r3 && r3.deleted === false && r3.restoredBy === 'this computer' && !r3.deletedAt, 'Restore brings the bill back (deleted:false, restoredBy recorded)');
  eq(r3.billNumber, b3.billNumber, 'restored bill keeps its original number');
  ok(await page.evaluate(() => /Nothing deleted/.test(document.getElementById('recycle-bin').textContent)), 'Recycle bin is empty again');
  await press(page, 'Alt+2'); await W(page, 500);
  ok(await page.evaluate(id => !!document.querySelector(`#page-content [data-action=view-bill][data-id="${id}"]`), b3.id), 'restored bill is back in Records');

  // product soft delete + restore
  await press(page, 'Alt+4'); await W(page, 500);
  const pid = await page.evaluate(() => { const b = document.querySelector('#page-content [data-action=delete-record][data-kind=products]'); return b && b.dataset.id; });
  await page.click(`#page-content [data-action=delete-record][data-id="${pid}"]`); await W(page, 600);
  ok((await raw(page, 'products')).find(x => x.id === pid).deleted === true, 'deleting a product also only marks it deleted');
  await press(page, 'Alt+6'); await W(page, 600);
  await page.click(`#recycle-bin [data-action=restore-deleted][data-id="${pid}"]`); await W(page, 600);
  ok((await raw(page, 'products')).find(x => x.id === pid).deleted === false, 'product restored from the Recycle bin');

  // ---------- 4. No edit history ----------
  console.log('\n4. No edit history is stored');
  const putRaw = (p, store, rec) => p.evaluate(([s, v]) => new Promise(res => { const r = indexedDB.open('kirana-desk'); r.onsuccess = () => { const tx = r.result.transaction(s, 'readwrite'); tx.objectStore(s).put(v); tx.oncomplete = res; }; }), [store, rec]);
  const noHist = x => !!x && !('history' in x) && !('editedAt' in x) && !('editedBy' in x);
  await openBill(page, b1.id);
  await page.click('#bill-dialog [data-action=edit-bill]'); await W(page, 600);
  await page.fill('#bill-customer', 'Safety One Edited');
  await page.click('#bill-dialog button[type=submit]'); await W(page, 800);
  let e1 = (await raw(page, 'bills')).find(x => x.id === b1.id);
  eq(e1.customerName, 'Safety One Edited', 'editing a saved bill saves the change');
  ok(noHist(e1), 'editing stores no previous version (no history / editedAt / editedBy)');
  await openBill(page, b1.id);
  ok(await page.evaluate(() => !document.getElementById('bill-safety-line') && !/Edited/.test(document.getElementById('bill-dialog').textContent) && !document.querySelector('[data-action=bill-history]')), 'bill view shows no "Edited" line and no "View previous versions"');
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(d => d.close()));
  await press(page, 'Alt+2'); await W(page, 400);
  ok(await page.evaluate(() => ![...document.querySelectorAll('#page-content .tag')].some(t => /edited/i.test(t.textContent))), 'Records list has no "edited" tag');
  // a bill that still carries history from the old build: shown without it, and the field is dropped on its next save
  const oldHist = { history: [{ editedAt: '2026-11-03T10:00:00.000Z', editedBy: 'this computer', prev: { customerName: 'Old name', items: e1.items } }], editedAt: '2026-11-03T10:00:00.000Z', editedBy: 'this computer' };
  await putRaw(page, 'bills', Object.assign({}, e1, oldHist));
  await openBill(page, b1.id);
  ok(await page.evaluate(() => !document.getElementById('bill-safety-line') && !document.querySelector('[data-action=bill-history]')), 'an old bill with stored history shows no history UI');
  await page.click('#bill-dialog [data-action=edit-bill]'); await W(page, 600);
  await page.click('#bill-dialog button[type=submit]'); await W(page, 800);
  e1 = (await raw(page, 'bills')).find(x => x.id === b1.id);
  ok(noHist(e1), 'its next save drops the old history field (space freed)');
  eq(e1.customerName + '|' + e1.billNumber + '|' + JSON.stringify(e1.items), 'Safety One Edited|' + b1.billNumber + '|' + JSON.stringify(b1.items), 'the rest of the bill is unchanged');
  // on load: old history is stripped from every bill, nothing else changes (deleted flags stay)
  const r5 = (await raw(page, 'bills')).find(x => x.id === b5.id);
  await putRaw(page, 'bills', Object.assign({}, r5, oldHist));
  await page.reload(); await page.waitForSelector('#page-content .page-head'); await W(page, 1500);
  const r5b = (await raw(page, 'bills')).find(x => x.id === b5.id);
  ok(noHist(r5b), 'opening the app strips old history from stored bills');
  eq(JSON.stringify(r5b), JSON.stringify(r5), 'stripping on load leaves every other field exactly as it was');

  // ---------- 5. Warning badge ----------
  console.log('\n5. Stale backup warning');
  await page.evaluate(() => localStorage.setItem('kiranaDeskLastBackup', new Date(Date.now() - 5 * 86400000).toISOString()));
  await press(page, 'Alt+1'); await W(page, 300); await press(page, 'Alt+6'); await W(page, 500);
  ok(/No backup in 5 days/.test((await page.textContent('#backup-warning').catch(() => '')) || ''), 'warning badge shows after 3+ days without a backup');

  // ---------- 6. Next day: a new daily file with everything ----------
  console.log('\n6. Next day backup + restore round trip');
  await openBill(page, b2.id);
  await page.click('#bill-dialog [data-action=delete-bill]'); await W(page, 700);
  await page.evaluate(() => localStorage.setItem('kiranaDeskDailyBackupDay', '2000-01-01'));
  await page.reload(); await page.waitForSelector('#page-content .page-head'); await W(page, 2800);
  eq(dailies(page).length, 2, 'a new day makes exactly one new daily backup');
  const file = dailies(page)[1].file, data = JSON.parse(fs.readFileSync(file, 'utf8'));
  eq(data.bills.length, 5, 'daily backup has every bill, including deleted ones');
  ok(data.bills.find(b => b.id === b2.id).deleted === true, 'deleted bill is in the backup, still marked deleted');
  ok(data.bills.every(noHist), 'the backup carries no edit history');
  ok(data.products.length > 0 && data.customers.length > 0 && Array.isArray(data.counters) && Array.isArray(data.supplyorders), 'products, customers, counters and supply orders are in the backup');
  ok(!/No backup in/.test(await page.evaluate(() => document.body.textContent)), 'warning clears after the new backup');
  const before = { bills: await raw(page, 'bills'), products: await raw(page, 'products'), customers: await raw(page, 'customers') };
  await A.ctx.close();

  // fresh computer: restore the daily file
  const B = await open(); const p2 = B.page; await W(p2, 2600);
  await press(p2, 'Alt+6'); await W(p2, 500);
  p2.__confirms = [];
  const histFile = path.join(tmp, 'with-history.json');
  fs.writeFileSync(histFile, JSON.stringify(Object.assign({}, data, { bills: data.bills.map(b => b.id === b1.id ? Object.assign({}, b, oldHist) : b) })));
  await p2.setInputFiles('#backup-file', histFile); await W(p2, 1500);
  ok(p2.__confirms.some(m => /Restore 5 bills/.test(m)), 'restore asks before replacing');
  ok(p2.downloads.some(d => /^kirana-before-restore-/.test(d.name)), 'a safety copy of the current data is downloaded before restoring');
  const after = { bills: await raw(p2, 'bills'), products: await raw(p2, 'products'), customers: await raw(p2, 'customers') };
  eq(after.bills.length, before.bills.length, 'all bills restored');
  eq(after.products.length, before.products.length, 'all products restored');
  eq(after.customers.length, before.customers.length, 'all customers restored');
  ok(after.bills.find(b => b.id === b2.id).deleted === true, 'deleted bill comes back in the Recycle bin, not in Records');
  ok(after.bills.every(noHist), 'restoring a backup that has old history fields does not bring them back');
  eq(JSON.stringify(after.bills.find(b => b.id === b1.id).items), JSON.stringify(before.bills.find(b => b.id === b1.id).items), 'bill lines are identical after restore');
  await press(p2, 'Alt+1'); await W(p2, 300); await press(p2, 'Alt+6'); await W(p2, 500);
  ok(await p2.evaluate(no => document.getElementById('recycle-bin').textContent.includes(no), b2.billNumber), 'restored Recycle bin lists the deleted bill');
  const b6 = await newBill(p2, 'Safety Six', 'Sugar', 1);
  eq(n(b6), n(b5) + 1, 'after restore, numbering continues (' + b6.billNumber + '); no number reused');
  ok(B.page.errors.length === 0 && page.errors.length === 0, 'no console errors' + (B.page.errors.concat(page.errors).length ? ': ' + B.page.errors.concat(page.errors).slice(0, 3).join(' | ') : ''));

  // screenshots for the report (optional)
  if (process.env.SHOT_DIR) {
    fs.mkdirSync(process.env.SHOT_DIR, { recursive: true });
    await press(p2, 'Escape'); await press(p2, 'Alt+1'); await W(p2, 300); await press(p2, 'Alt+6'); await W(p2, 800);
    await p2.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove()));
    await p2.screenshot({ path: path.join(process.env.SHOT_DIR, 'backup.png'), fullPage: true });
    await p2.locator('#recycle-bin').screenshot({ path: path.join(process.env.SHOT_DIR, 'recycle-bin.png') });
  }
  await B.ctx.close();
  await browser.close(); if (srv) srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('Failures:\n - ' + failures.join('\n - ')); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(1); });
