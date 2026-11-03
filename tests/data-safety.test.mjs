#!/usr/bin/env node
// Static + unit checks for the data-safety rules: no hard deletes anywhere, Firestore denies delete,
// Busy export never includes a bill from the Recycle bin, service worker cache bumped.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBusyExport, singleBillExport, findBillByNo } from '../busy-export.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

const app = read('app.js'), fb = read('firebase.js'), rules = read('firestore.rules'), sw = read('sw.js');
ok(!/deleteDoc|writeBatch\([^)]*\)\.delete|\.delete\(\s*docFor/.test(fb), 'firebase.js has no Firestore delete');
ok(!/KiranaCloud\.delete/.test(app), 'app.js never calls a cloud delete');
ok(!/\.delete\(key\)/.test(app), 'app.js has no local hard-delete helper');
ok(/async function del\(store, key, extra\)[\s\S]{0,200}deleted:true/.test(app), 'del() soft-deletes (deleted:true)');
ok(/allow delete: if false;/.test(rules), 'firestore.rules denies delete for everyone');
ok(/allow read, create, update: if isFamily\(\);/.test(rules), 'firestore.rules allows read/create/update only for the family');
ok(rules.includes("'mtarvecha660@gmail.com'") && rules.includes("'moksh7tarvecha@gmail.com'"), 'both family emails are in the rules');
ok(/match \/\{document=\*\*\}[\s\S]*allow read, write: if false;/.test(rules), 'everything else is closed');
ok(/kirana-desk-v30/.test(sw), 'service worker cache is v30');

// No edit history (Nov 3): nothing in the app keeps previous versions of a bill
ok(!/historyDialog|billSnapshot|bill-history|history-dialog|View previous versions/.test(app), 'app.js has no edit-history UI or snapshot code');
ok(!/\.history\s*=/.test(app) && !/editedAt\s*[:=]/.test(app) && !/editedBy\s*[:=]/.test(app), 'app.js never writes history / editedAt / editedBy');
ok(!/tag red[^']*'?>edited</.test(app), 'Records list has no "edited" tag');
ok(/value = Object\.assign\(\{\}, store==='bills'\?noHistory\(value\)/.test(app), 'put() drops old history fields from a bill on save');
ok(/incoming=\{bills:\(data\.bills\|\|\[\]\)\.map\(noHistory\)/.test(app), 'restore ignores history fields in a backup');
ok(/dropFields\(name, key, fields\)[\s\S]{0,200}updateDoc[\s\S]{0,120}deleteField\(\)/.test(fb) && !/dropFields[\s\S]{0,250}setDoc/.test(fb.slice(fb.indexOf('dropFields'))), 'cloud cleanup removes only the named fields (updateDoc + deleteField)');
const nh = app.match(/const HISTORY_FIELDS=\[[^\]]*\];\n\s*function noHistory\(r\)\{[^\n]*\}/);
ok(!!nh, 'noHistory() helper found');
const noHistory = nh ? new Function(nh[0] + '; return noHistory;')() : (x => x);
const withH = { id: 'x', billNumber: 'RS/2026-27/0009', items: [{ productName: 'Sugar', quantity: 1 }], deleted: true, deletedAt: 'd', deletedBy: 'e', history: [{ prev: {} }], editedAt: 't', editedBy: 'u' };
const stripped = noHistory(withH);
ok(!('history' in stripped) && !('editedAt' in stripped) && !('editedBy' in stripped), 'noHistory() removes history, editedAt, editedBy');
ok(stripped.deleted === true && stripped.deletedAt === 'd' && stripped.deletedBy === 'e' && stripped.billNumber === withH.billNumber && stripped.items === withH.items, 'noHistory() keeps everything else (Recycle bin fields included)');
ok('history' in withH, 'noHistory() does not change the original record');
const clean = { id: 'y', items: [] };
ok(noHistory(clean) === clean, 'a bill without history is returned untouched');

const item = { productName: 'Sugar', quantity: 2, unit: 'kg', price: 40 };
const bills = [
  { id: 'a', businessId: 'sampurn', financialYear: '2026-27', sequence: 1, billNumber: 'RS/2026-27/0001', date: '2026-11-01', customerName: 'A', items: [item] },
  { id: 'b', businessId: 'sampurn', financialYear: '2026-27', sequence: 2, billNumber: 'RS/2026-27/0002', date: '2026-11-02', customerName: 'B', items: [item], deleted: true, deletedAt: '2026-11-03T10:00:00Z' },
  { id: 'c', businessId: 'sampurn', financialYear: '2026-27', sequence: 3, billNumber: 'RS/2026-27/0003', date: '2026-11-03', customerName: 'C', items: [item], deleted: false }
];
const out = buildBusyExport(bills, {});
ok(out.files.length === 2 && !out.files.some(f => f.name.includes('0002')), 'buildBusyExport skips the deleted bill, keeps deleted:false');
ok(!!singleBillExport(bills[0], {}).file && !singleBillExport(bills[1], {}).file, 'singleBillExport refuses a deleted bill');
ok(findBillByNo(bills, '2', 'sampurn') === null && findBillByNo(bills, '3', 'sampurn').id === 'c', 'findBillByNo never returns a deleted bill');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
