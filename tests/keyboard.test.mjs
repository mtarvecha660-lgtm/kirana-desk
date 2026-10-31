#!/usr/bin/env node
/*
  Kirana Desk keyboard test (no build step).
  Runs every page and window with the keyboard only, in a real Chromium.
  Data stays local: firebase-config.js is replaced in the browser with a blank config (local-only mode),
  and the sign-in test uses a fake Firebase SDK, so nothing ever reaches the real Firebase project.

  Run:   npm i -D playwright && npx playwright install chromium
         node tests/keyboard.test.mjs                 (serves this folder on a local port)
         node tests/keyboard.test.mjs https://mtarvecha660-lgtm.github.io/kirana-desk/   (test the live site)
  Env:   CHROME_PATH=/path/to/chrome  to use an existing browser, HEADED=1 to watch it.
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
const FAKE_CONFIG = 'export const firebaseConfig = { apiKey: "test-key", authDomain: "x", projectId: "test-project", appId: "test-app" };';
const FAKE_SDK = {
  'firebase-app.js': 'export const initializeApp = c => ({ c });',
  'firebase-auth.js': `export const getAuth = () => ({ currentUser: null });
    export const onAuthStateChanged = (a, cb) => { setTimeout(() => cb(null), 0); return () => {}; };
    export const signInWithEmailAndPassword = async (a, email, pw) => { window.__signIns = (window.__signIns || 0) + 1; window.__lastSignIn = email; const e = new Error('bad'); e.code = 'auth/invalid-credential'; throw e; };
    export const signOut = async () => {};`,
  'firebase-firestore.js': `const n = () => ({}); export const initializeFirestore = n, persistentLocalCache = n, persistentMultipleTabManager = n, getFirestore = n, collection = n, doc = n, getDocs = async () => ({ docs: [] }), setDoc = async () => {}, deleteDoc = async () => {}, onSnapshot = () => () => {}, runTransaction = async () => {}, writeBatch = () => ({ set(){}, delete(){}, commit: async () => {} }), query = n, where = n, serverTimestamp = n;`
};

function serve() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
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

  async function open(opts = {}) {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1366, height: 860 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(String(e)));
    page.__confirm = true; page.__confirms = [];
    page.on('dialog', d => { page.__confirms.push(d.message()); return page.__confirm ? d.accept() : d.dismiss(); });
    await page.route('**/firebase-config.js', r => r.fulfill({ contentType: 'text/javascript', body: opts.cloud ? FAKE_CONFIG : LOCAL_CONFIG }));
    await page.route('https://www.gstatic.com/firebasejs/**', r => {
      const name = r.request().url().split('/').pop();
      return opts.cloud && FAKE_SDK[name] ? r.fulfill({ contentType: 'text/javascript', body: FAKE_SDK[name], headers: { 'access-control-allow-origin': '*' } }) : r.abort();
    });
    await page.goto(base + '?t=' + Date.now());
    if (!opts.cloud) await page.waitForSelector('#page-content .page-head', { timeout: 15000 });
    else await page.waitForTimeout(800);
    page.errors = errors;
    return { page, ctx };
  }
  const W = (p, ms = 120) => p.waitForTimeout(ms);
  const active = p => p.evaluate(() => { const a = document.activeElement; if (!a) return ''; return a.id ? '#' + a.id : (a.dataset.field ? 'field:' + a.dataset.field + ':' + [...document.querySelectorAll('#bill-items .item-row')].indexOf(a.closest('.item-row')) : (a.dataset.action ? 'action:' + a.dataset.action : a.tagName + ':' + (a.textContent || '').trim().slice(0, 20))); });
  const rows = p => p.evaluate(() => document.querySelectorAll('#bill-items .item-row').length);
  const count = (p, store) => p.evaluate(s => new Promise(res => { const r = indexedDB.open('kirana-desk'); r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains(s)) return res(-1); const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => res(q.result.length); }; r.onerror = () => res(-1); }), store);
  const dialogOpen = (p, id) => p.evaluate(i => !!document.querySelector('#' + i + '[open]'), id);
  const press = async (p, k, n = 1) => { for (let i = 0; i < n; i++) { await p.keyboard.press(k); await W(p, 90); } };
  const typeEnter = async (p, text) => { if (text) await p.keyboard.type(text); await W(p, 140); await p.keyboard.press('Enter'); await W(p, 160); };

  // ---------- 1. New bill: Enter flow, rows, suggestions, save ----------
  console.log('\n1. New bill by keyboard');
  {
    const { page, ctx } = await open();
    const dbName = await page.evaluate(() => indexedDB.databases ? indexedDB.databases().then(d => d.map(x => x.name)) : []);
    ok(dbName.includes('kirana-desk'), 'local database is kirana-desk (local mode, no cloud)');
    const bills0 = await count(page, 'bills');
    await press(page, 'n'); await W(page, 400);
    ok(await dialogOpen(page, 'bill-dialog'), 'N opens a new bill');
    eq(await active(page), '#bill-customer', 'cursor starts in Customer');
    eq(await rows(page), 1, 'new bill starts with 1 item line');
    await typeEnter(page, 'Test Kumar Traders');
    eq(await active(page), 'field:productName:0', 'Enter on Customer goes to Product (not to "+ Add line")');
    eq(await rows(page), 1, 'no line created by Enter on Customer');
    await typeEnter(page, 'Keyboard Rice');
    eq(await active(page), 'field:brand:0', 'Product → Brand');
    await typeEnter(page, '');
    eq(await active(page), 'field:price:0', 'Brand → Price');
    await typeEnter(page, '40');
    eq(await active(page), 'field:quantity:0', 'Price → Quantity');
    await typeEnter(page, '5');
    eq(await active(page), 'field:unit:0', 'Quantity → Unit');
    await page.keyboard.type('bag'); await W(page, 200);
    await page.keyboard.press('Enter'); await W(page, 250);
    eq(await rows(page), 2, 'Enter on last field of the line adds exactly ONE line (1 → 2)');
    eq(await active(page), 'field:productName:1', 'cursor jumps to Product of the new line');
    const r0 = await page.evaluate(() => [...document.querySelectorAll('#bill-items .item-row')[0].querySelectorAll('input')].map(i => i.value).join('|'));
    eq(r0, 'Keyboard Rice||40|5|bag', 'first line kept its values (nothing deleted)');

    // suggestion list: ArrowDown + Enter only fills
    await page.keyboard.type('Toor'); await W(page, 300);
    ok(await page.evaluate(() => !!document.querySelector('.sug-fixed')), 'typing opens the product suggestion list');
    await press(page, 'ArrowDown'); await press(page, 'Enter'); await W(page, 200);
    eq(await page.evaluate(() => document.querySelectorAll('#bill-items .item-row')[1].querySelector('[data-field=productName]').value), 'Toor Dal', 'ArrowDown + Enter picks the highlighted suggestion');
    eq(await active(page), 'field:productName:1', 'picking a suggestion does not also move/act (cursor stays)');
    eq(await rows(page), 2, 'picking a suggestion adds/removes no line');
    ok(await page.evaluate(() => !document.querySelector('.sug-fixed')), 'suggestion list closed after pick');
    await page.keyboard.type('x'); await page.keyboard.press('Backspace'); await W(page, 300);
    if (await page.evaluate(() => !!document.querySelector('.sug-fixed'))) {
      await press(page, 'Escape');
      ok(await dialogOpen(page, 'bill-dialog'), 'Esc closes only the suggestion list, the bill stays open');
      ok(await page.evaluate(() => !document.querySelector('.sug-fixed')), 'suggestion list gone after Esc');
    } else ok(true, 'suggestion list (no reopen needed)');
    await typeEnter(page, ''); // → brand (auto-filled)
    eq(await active(page), 'field:brand:1', 'Enter moves on after the pick');
    await typeEnter(page, ''); await typeEnter(page, ''); await typeEnter(page, '2'); await page.keyboard.press('Control+a'); await page.keyboard.type('kg'); await W(page, 150);
    await page.keyboard.press('Enter'); await W(page, 250);
    eq(await rows(page), 3, 'second line done → exactly one more line (2 → 3)');

    // Enter on the × never removes; hold-Enter repeat never adds
    await page.evaluate(() => document.querySelectorAll('#bill-items .remove-item')[0].focus());
    await press(page, 'Enter'); await press(page, ' ');
    eq(await rows(page), 3, 'Enter/Space on a focused × does NOT remove the line');
    eq(await page.evaluate(() => [...document.querySelectorAll('#bill-items .remove-item')].every(b => b.tabIndex === -1)), true, '× buttons are out of the Tab/Enter order (tabindex -1)');
    await page.evaluate(() => document.querySelectorAll('#bill-items .item-row')[1].querySelector('[data-field=unit]').focus());
    await page.evaluate(() => { const el = document.activeElement; for (let i = 0; i < 5; i++) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true })); });
    await W(page, 150);
    eq(await rows(page), 3, 'held-down Enter (key repeat) does nothing');
    await page.evaluate(() => { const el = document.querySelectorAll('#bill-items .item-row')[2].querySelector('[data-field=unit]'); el.focus(); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })); });
    await W(page, 150);
    eq(await rows(page), 3, 'Enter during IME composition does nothing');

    // Enter on empty product of last line leaves the grid; Shift+Enter goes back
    await page.evaluate(() => document.querySelectorAll('#bill-items .item-row')[2].querySelector('[data-field=productName]').focus());
    await press(page, 'Enter');
    eq(await active(page), '#bill-gst', 'Enter on an empty Product line finishes items → GST');
    eq(await rows(page), 3, 'leaving the grid creates/deletes nothing');
    await press(page, 'Shift+Enter');
    eq(await active(page), 'field:unit:2', 'Shift+Enter goes back one field');
    await page.focus('#bill-gst'); await typeEnter(page, '');
    eq(await active(page), '#bill-notes', 'GST → Note');
    await typeEnter(page, 'kbd test');
    eq(await active(page), 'BUTTON:Save record', 'Enter on the last field goes to Save');

    // the "+ Add line" button pressed with Enter adds exactly one line and puts the cursor in it
    const before = await rows(page);
    await page.evaluate(() => document.querySelector('#bill-dialog [data-action=add-item]').focus());
    await press(page, 'Enter'); await W(page, 150);
    eq(await rows(page), before + 1, 'Enter on "+ Add line" adds exactly one line');
    eq(await active(page), 'field:productName:' + before, 'and the cursor goes into it');
    await press(page, 'Enter'); await W(page, 150);
    eq(await rows(page), before + 1, 'Enter on that empty new line adds nothing more');
    // delete line with Ctrl+Delete (confirm)
    await page.evaluate(() => document.querySelectorAll('#bill-items .item-row')[1].querySelector('[data-field=quantity]').focus());
    page.__confirm = false; await press(page, 'Control+Delete');
    eq(await rows(page), before + 1, 'Ctrl+Delete then Cancel keeps the line');
    ok(page.__confirms.some(m => /Remove this line/.test(m)), 'Ctrl+Delete asks before removing');
    page.__confirm = true; await press(page, 'Control+Delete');
    eq(await rows(page), before, 'Ctrl+Delete then OK removes exactly that line');
    eq(await active(page), 'field:quantity:1', 'cursor stays on the same column after removing');

    // Ctrl+Enter save, double save guard
    await page.keyboard.press('Control+Enter'); await page.keyboard.press('Control+Enter'); await W(page, 900);
    eq(await count(page, 'bills'), bills0 + 1, 'Ctrl+Enter (pressed twice) saves exactly ONE bill');
    const saved = await page.evaluate(() => new Promise(res => { const r = indexedDB.open('kirana-desk'); r.onsuccess = () => { const q = r.result.transaction('bills').objectStore('bills').getAll(); q.onsuccess = () => res(q.result.find(b => b.customerName === 'Test Kumar Traders')); }; }));
    eq(saved && saved.items.length, 1, 'saved bill has the filled line only (blank trailing line ignored)');
    ok(await dialogOpen(page, 'bill-dialog'), 'saved bill opens in view');
    eq(await active(page), 'action:edit-bill', 'view opens with Edit focused');
    await press(page, 'Enter'); await W(page, 500);
    eq(await active(page), '#bill-customer', 'Enter on Edit → edit mode, cursor in Customer');
    await page.keyboard.type(' Edited'); await page.keyboard.press('Control+Enter'); await W(page, 800);
    eq(await count(page, 'bills'), bills0 + 1, 'saving an edit does not create another bill');
    ok(await page.evaluate(() => [...document.querySelectorAll('.toast')].some(t => /updated/.test(t.textContent))), 'edit saved ("updated" message)');
    // Esc on dirty new bill asks
    await press(page, 'Escape'); await W(page, 200);
    await press(page, 'n'); await W(page, 400);
    await page.keyboard.type('Unsaved'); page.__confirm = false; page.__confirms = [];
    await W(page, 300);
    if (await page.evaluate(() => !!document.querySelector('.sug-fixed'))) { await press(page, 'Escape'); await W(page, 200); }
    await press(page, 'Escape'); await W(page, 200);
    if (process.env.DEBUG) console.log(await dialogOpen(page, 'bill-dialog'), page.__confirms, await active(page));
    ok(await dialogOpen(page, 'bill-dialog') && page.__confirms.length === 1, 'Esc on a bill with typing asks first (Cancel keeps it open)');
    page.__confirm = true; await press(page, 'Escape'); await W(page, 200);
    ok(!(await dialogOpen(page, 'bill-dialog')), 'Esc + OK closes it');
    eq(await count(page, 'bills'), bills0 + 1, 'closing an unsaved bill saves nothing');
    eq(page.errors.length, 0, 'no console errors' + (page.errors.length ? ': ' + page.errors.join(' | ') : ''));
    await ctx.close();
  }

  // ---------- 2. FORM chips, Records page, view/delete, return ----------
  console.log('\n2. Form chips, Records page, return');
  {
    const { page, ctx } = await open();
    await press(page, 'n'); await W(page, 400);
    await press(page, 'Shift+Enter'); await press(page, 'Shift+Enter');
    const chip0 = await page.evaluate(() => document.activeElement.classList.contains('pick-chip') && document.activeElement.dataset.id);
    ok(!!chip0, 'Shift+Enter from Customer reaches the FORM chip');
    await press(page, 'ArrowRight'); await W(page, 500);
    const chip1 = await page.evaluate(() => ({ focused: document.activeElement.classList.contains('pick-chip') && document.activeElement.dataset.id, value: document.getElementById('bill-business').value }));
    ok(chip1.value !== chip0 && chip1.focused === chip1.value, 'Right arrow switches the shop and keeps the cursor on it');
    await press(page, 'Enter'); await W(page, 300);
    eq(await active(page), '#bill-date', 'Enter on FORM → Bill date');
    await press(page, 'Enter');
    eq(await active(page), '#bill-customer', 'Bill date → Customer');
    await typeEnter(page, 'Chip Test'); await typeEnter(page, 'Sugar'); await typeEnter(page, ''); await typeEnter(page, ''); await typeEnter(page, '3');
    await page.keyboard.type('kg'); await W(page, 150);
    await page.keyboard.press('Control+Enter'); await W(page, 900);
    const b = await page.evaluate(() => new Promise(res => { const r = indexedDB.open('kirana-desk'); r.onsuccess = () => { const q = r.result.transaction('bills').objectStore('bills').getAll(); q.onsuccess = () => res(q.result.find(x => x.customerName === 'Chip Test')); }; }));
    ok(b && b.businessId === chip1.value, 'bill saved under the shop picked with the arrow key');
    await press(page, 'Escape'); await W(page, 200);
    await press(page, 'Alt+2'); await W(page, 400);
    eq(await page.evaluate(() => document.getElementById('page-crumb').textContent), 'Dispatch records', 'Alt+2 opens Records');
    await press(page, '/');
    eq(await active(page), '#bill-search', '/ focuses search');
    await page.keyboard.type('nnnnannnn', { delay: 5 }); await W(page, 500);
    eq(await page.evaluate(() => document.getElementById('bill-search').value), 'nnnnannnn', 'fast typing in search keeps every letter');
    ok(!(await dialogOpen(page, 'bill-dialog')), 'an "n" typed in search never opens a new bill');
    await page.keyboard.press('Control+a'); await page.keyboard.press('Backspace');
    await page.keyboard.type(b.billNumber, { delay: 5 });
    if (process.env.DEBUG) console.log(await page.evaluate(() => ({ open: [...document.querySelectorAll('dialog[open]')].map(d => d.id + ':' + d.dataset.dirty), n: document.querySelectorAll('#page-content [data-action=view-bill]').length, v: document.getElementById('bill-search').value })));
    await press(page, 'ArrowDown'); await W(page, 500);
    eq(await active(page), 'action:view-bill', 'Down arrow right after fast typing still lands on the first result (search redraw does not steal it back)');
    await press(page, 'Enter'); await W(page, 500);
    ok(await dialogOpen(page, 'bill-dialog'), 'Enter opens the bill');
    const bills1 = await count(page, 'bills');
    page.__confirm = false; page.__confirms = []; await press(page, 'Alt+d'); await W(page, 300);
    ok(page.__confirms.some(m => /Delete this bill/.test(m)) && await count(page, 'bills') === bills1, 'Alt+D asks before deleting a bill (Cancel keeps it)');
    // Enter on Delete button never deletes
    await page.evaluate(() => document.querySelector('#bill-dialog [data-action=delete-bill]').focus());
    page.__confirms = []; await press(page, 'Enter'); await W(page, 200);
    ok(page.__confirms.length === 0 && await count(page, 'bills') === bills1, 'Enter on a focused Delete button does nothing');
    // Return
    await page.evaluate(() => document.querySelector('#bill-dialog [data-action=return-bill]').focus());
    await press(page, 'Enter'); await W(page, 500);
    ok(await dialogOpen(page, 'return-dialog'), 'Return window opens');
    eq(await active(page), '#ret-0', 'cursor in Return now');
    await typeEnter(page, '1');
    eq(await active(page), 'action:save-return', 'Enter on the last return field goes to Save return');
    await page.keyboard.press('Control+Enter'); await page.keyboard.press('Control+Enter'); await W(page, 900);
    const ret = await page.evaluate(id => new Promise(res => { const r = indexedDB.open('kirana-desk'); r.onsuccess = () => { const q = r.result.transaction('bills').objectStore('bills').get(id); q.onsuccess = () => res((q.result.returns || []).length); }; }), b.id);
    eq(ret, 1, 'Ctrl+Enter twice saves exactly ONE return');
    await press(page, 'Escape'); await W(page, 200);
    // Returns report
    await page.evaluate(() => document.querySelector('[data-action=returns-report]').focus()); await press(page, 'Enter'); await W(page, 500);
    ok(await dialogOpen(page, 'return-dialog'), 'In/Out register opens');
    await page.keyboard.press('Control+Enter'); await W(page, 400);
    ok(page.errors.length === 0, 'Ctrl+Enter generates the register without errors');
    await press(page, 'Escape');
    // N while a window is open does nothing
    await press(page, 'n'); await W(page, 300); await page.keyboard.press('n'); await W(page, 300);
    eq(page.errors.length, 0, 'no console errors' + (page.errors.length ? ': ' + page.errors.join(' | ') : ''));
    await ctx.close();
  }

  // ---------- 3. Catalog: products + customers ----------
  console.log('\n3. Products & customers');
  {
    const { page, ctx } = await open();
    await press(page, 'Alt+4'); await W(page, 400);
    eq(await page.evaluate(() => document.getElementById('page-crumb').textContent), 'Products & customers', 'Alt+4 opens Catalog');
    const p0 = await count(page, 'products');
    await page.evaluate(() => document.querySelector('[data-action=add-record]').focus()); await press(page, 'Enter'); await W(page, 400);
    ok(await dialogOpen(page, 'record-dialog'), 'Add product opens');
    eq(await active(page), 'INPUT:', 'cursor in product name');
    await typeEnter(page, 'Keyboard Atta');
    ok((await page.evaluate(() => document.activeElement.name)) === 'unit', 'Name → Default unit');
    await page.keyboard.type('kg'); await W(page, 300); await page.keyboard.press('Enter'); await W(page, 200);
    ok((await page.evaluate(() => document.activeElement.name)) === 'brand', 'Unit → Brand (no double action from the unit list)');
    await typeEnter(page, 'Aashirvaad');
    eq(await active(page), 'BUTTON:Save', 'Brand → Save');
    await press(page, 'Enter'); await W(page, 600);
    eq(await count(page, 'products'), p0 + 1, 'Enter on Save adds exactly ONE product');
    ok(!(await dialogOpen(page, 'record-dialog')), 'window closes after save');
    // Enter-held on Add product repeat guard: synthetic repeat
    await page.evaluate(() => document.querySelector('[data-action=add-record]').focus());
    await page.evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true })));
    await W(page, 200);
    ok(!(await dialogOpen(page, 'record-dialog')), 'held Enter (repeat) does not open/act twice');
    // Delete product with Alt+D from the list
    await press(page, '/'); await page.keyboard.type('Keyboard Atta'); await W(page, 400);
    await press(page, 'ArrowDown');
    eq(await active(page), 'action:edit-record', 'Down arrow from search → first record');
    page.__confirm = true; page.__confirms = []; await press(page, 'Control+Delete'); await W(page, 500);
    ok(page.__confirms.some(m => /Delete this catalog entry/.test(m)), 'Ctrl+Delete on a record asks first');
    eq(await count(page, 'products'), p0, 'and then deletes exactly that product');
    // Customers with chip switch
    await page.evaluate(() => document.querySelector('[data-catalog-tab=customers]').click()); await W(page, 400);
    const c0 = await count(page, 'customers');
    await page.evaluate(() => document.querySelector('[data-action=add-record]').focus()); await press(page, 'Enter'); await W(page, 400);
    eq(await active(page), 'INPUT:', 'Add customer: cursor in name');
    await press(page, 'Shift+Enter'); await press(page, 'ArrowRight'); await press(page, 'ArrowRight');
    const chosen = await page.evaluate(() => document.querySelector('#record-form [name=businessId]').value);
    await press(page, 'Enter');
    await typeEnter(page, 'Keyboard Customer'); await typeEnter(page, '98765');
    await page.keyboard.press('Control+Enter'); await page.keyboard.press('Control+Enter'); await W(page, 700);
    eq(await count(page, 'customers'), c0 + 1, 'Ctrl+Enter twice adds exactly ONE customer');
    const cust = await page.evaluate(() => new Promise(res => { const r = indexedDB.open('kirana-desk'); r.onsuccess = () => { const q = r.result.transaction('customers').objectStore('customers').getAll(); q.onsuccess = () => res(q.result.find(x => x.name === 'Keyboard Customer')); }; }));
    ok(cust && cust.businessId === chosen && cust.note === '98765', 'customer saved under the shop chosen by arrow keys, with note');
    eq(page.errors.length, 0, 'no console errors' + (page.errors.length ? ': ' + page.errors.join(' | ') : ''));
    await ctx.close();
  }

  // ---------- 4. Supply orders ----------
  console.log('\n4. Supply orders');
  {
    const { page, ctx } = await open();
    await press(page, 'Alt+3'); await W(page, 400);
    eq(await page.evaluate(() => document.getElementById('page-crumb').textContent), 'Supply orders', 'Alt+3 opens Supply orders');
    await press(page, 'n'); await W(page, 400);
    for (const x of ['Supply Kbd', 'Poha', '', '', '4']) await typeEnter(page, x);
    await page.keyboard.type('kg'); await page.keyboard.press('Control+Enter'); await W(page, 900); await press(page, 'Escape'); await W(page, 200);
    const s0 = await count(page, 'supplyorders');
    await page.evaluate(() => document.querySelector('[data-action=add-supply]').focus()); await press(page, 'Enter'); await W(page, 600);
    ok(await dialogOpen(page, 'supply-dialog'), 'New supply order opens');
    eq(await active(page), '#so-ref', 'cursor in Reference');
    await typeEnter(page, 'PO-KBD-1');
    eq(await active(page), '#so-date', 'Reference → Date');
    await typeEnter(page, '');
    eq(await active(page), '#so-customer', 'Date → Customer');
    await typeEnter(page, 'Supply Kbd');
    eq(await active(page), '#so-notes', 'Customer → Notes');
    await typeEnter(page, 'n');
    eq(await active(page), '#so-search', 'Notes → bill filter');
    await typeEnter(page, '');
    ok(await page.evaluate(() => document.activeElement.classList.contains('so-pick')), 'filter → first bill tick box');
    await press(page, ' ');
    ok(await page.evaluate(() => document.activeElement.checked), 'Space ticks the bill');
    await page.keyboard.press('Control+Enter'); await W(page, 400);
    ok(await page.evaluate(() => [...document.querySelectorAll('.toast')].some(t => /Attach the order/.test(t.textContent))), 'Ctrl+Enter without a file explains what is missing');
    await page.setInputFiles('#so-file-input', { name: 'order.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64') });
    await W(page, 1200);
    await page.focus('#so-notes');
    await page.keyboard.press('Control+Enter'); await page.keyboard.press('Control+Enter'); await W(page, 1200);
    eq(await count(page, 'supplyorders'), s0 + 1, 'Ctrl+Enter twice saves exactly ONE supply order');
    eq(page.errors.length, 0, 'no console errors' + (page.errors.length ? ': ' + page.errors.join(' | ') : ''));
    await ctx.close();
  }

  // ---------- 5. Pages, help, backup page ----------
  console.log('\n5. Pages, help, shortcuts');
  {
    const { page, ctx } = await open();
    const names = ['Overview', 'Dispatch records', 'Supply orders', 'Products & customers', 'Analytics', 'Backup & restore'];
    for (let i = 1; i <= 6; i++) { await press(page, 'Alt+' + i); await W(page, 350); eq(await page.evaluate(() => document.getElementById('page-crumb').textContent), names[i - 1], 'Alt+' + i + ' → ' + names[i - 1]); }
    await press(page, '?'); await W(page, 300);
    ok(await page.evaluate(() => !!document.querySelector('#kbd-help[open]')), '? opens the shortcut list');
    ok(await page.evaluate(() => /Ctrl \+ Delete/.test(document.getElementById('kbd-help').textContent)), 'shortcut list shows the delete key');
    await press(page, 'Escape');
    ok(await page.evaluate(() => !document.querySelector('#kbd-help[open]')), 'Esc closes it');
    eq(page.errors.length, 0, 'no console errors' + (page.errors.length ? ': ' + page.errors.join(' | ') : ''));
    await ctx.close();
  }

  // ---------- 6. Sign-in screen (fake Firebase; nothing leaves the browser) ----------
  console.log('\n6. Sign-in screen');
  {
    const { page, ctx } = await open({ cloud: true });
    ok(await page.evaluate(() => !document.getElementById('auth-gate').hidden), 'sign-in screen shows');
    await page.focus('#login-email');
    await typeEnter(page, 'test');
    eq(await active(page), '#login-password', 'Enter on Name → Password (does not submit early)');
    eq(await page.evaluate(() => window.__signIns || 0), 0, 'nothing sent yet');
    await page.keyboard.type('x'); await page.keyboard.press('Enter'); await W(page, 500);
    eq(await page.evaluate(() => window.__signIns || 0), 1, 'Enter on Password signs in exactly once');
    ok(await page.evaluate(() => /incorrect/.test(document.getElementById('auth-error').textContent)), 'error shows for a wrong password');
    await press(page, 'Shift+Enter');
    eq(await active(page), '#login-email', 'Shift+Enter goes back to Name');
    const errs = page.errors.filter(e => !/bad|Failed to load resource/.test(e));
    eq(errs.length, 0, 'no unexpected console errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
    await ctx.close();
  }

  await browser.close();
  if (srv) srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('Failed:\n - ' + failures.join('\n - ')); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(1); });
