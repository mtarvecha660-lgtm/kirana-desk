#!/usr/bin/env node
/*
  Busy export unit test: a Kirana Desk bill with the same 19 lines as a real Busy 21 sale voucher
  (tests/fixtures/busy-sale-37.xml, exported from Busy, party name anonymised) must produce the same
  per-line amounts, tax split and account totals.
  Run: node tests/busy-export.test.mjs
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBusyExport, billToVoucher, voucherXml, splitInclusive, taxRateOf, makeZip, latin1Bytes, xesc } from '../busy-export.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sample = fs.readFileSync(path.join(HERE, 'fixtures', 'busy-sale-37.xml'), 'latin1');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const eq = (a, b, m) => ok(String(a) === String(b), m + (String(a) === String(b) ? '' : ` (got ${a}, expected ${b})`));
const blocks = (xml, t) => [...xml.matchAll(new RegExp('<' + t + '>([\\s\\S]*?)</' + t + '>', 'g'))].map(m => m[1]);
const val = (xml, t) => { const m = xml.match(new RegExp('<' + t + '>([^<]*)</' + t + '>')); return m ? m[1] : undefined; };

// ---- read the real Busy voucher ----
const sItems = blocks(sample, 'ItemDetail').map(b => ({
  name: val(b, 'ItemName'), unit: val(b, 'UnitName'), qty: val(b, 'Qty'), hsn: val(b, 'ItemHSNCode') || '', cat: val(b, 'ItemTaxCategory'),
  price: val(b, 'Price'), amt: val(b, 'Amt'), nett: val(b, 'NettAmount'), st: val(b, 'STAmount'), half: val(b, 'TaxBeforeSurcharge'), half1: val(b, 'TaxBeforeSurcharge1'),
  pct: val(b, 'STPercent'), taxPaid: val(b, 'TaxPaid'), param: val(b, 'Param1') }));
const sAcc = blocks(sample, 'AccDetail').map(b => ({ name: val(b, 'AccountName'), type: val(b, 'AmountType'), amt: val(b, 'AmtMainCur') }));

console.log('\n1. Tax maths');
eq(taxRateOf('GST 5%'), 5, 'GST 5% → 5'); eq(taxRateOf('GST 12% to 5%'), 5, '"GST 12% to 5%" → 5 (the new rate)'); eq(taxRateOf('Non-GST'), 0, 'Non-GST → 0');
eq(JSON.stringify(splitInclusive(11165, 5)), JSON.stringify({ amt: 11165, half: 265.83, tax: 531.66, nett: 10633.34 }), 'Mirchi 11165 incl. 5% → 10633.34 + 265.83 + 265.83 (Busy rounds each half)');
eq(xesc('Dal & ₹'), 'Dal &amp; &#8377;', 'escapes & and writes ₹ as a character reference (iso8859-1 file)');

// ---- the same bill as a Kirana Desk record ----
const items = {}, units = {};
sItems.forEach(i => { items[i.name.toLowerCase()] = { taxCategory: i.cat, hsn: i.hsn, unit: i.unit, param: !!i.param }; });
const bill = { id: 'b37', businessId: 'sampurn', billNumber: '37', sequence: 37, date: '2026-07-28', customerName: 'Test Party', gst: null,
  items: sItems.map(i => ({ productName: i.name, brand: i.param || '', price: Number(i.price), quantity: Number(i.qty), unit: i.unit })) };
const cfg = { items, vchNoMode: 'full' };

console.log('\n2. Lines vs the real Busy voucher (19 lines)');
const v = billToVoucher(bill, cfg);
eq(v.lines.length, sItems.length, 'line count');
let lineMismatch = [];
v.lines.forEach((l, k) => {
  const s = sItems[k];
  const mine = [l.itemName, l.unit, String(l.qty), l.category, String(l.amt), String(l.nett), l.rate ? String(l.tax) : undefined, l.rate ? String(l.half) : undefined];
  const theirs = [s.name, s.unit, s.qty, s.cat, s.amt, s.nett, s.st, s.half];
  if (JSON.stringify(mine) !== JSON.stringify(theirs)) lineMismatch.push(s.name + ': ' + JSON.stringify(mine) + ' vs ' + JSON.stringify(theirs));
});
ok(!lineMismatch.length, 'every line: name, unit, qty, tax category, Amt, NettAmount, STAmount, CGST/SGST half match Busy exactly' + (lineMismatch.length ? '\n     ' + lineMismatch.join('\n     ') : ''));

console.log('\n3. Account entries vs the real Busy voucher');
const xml = voucherXml(v, cfg);
const myAcc = blocks(xml, 'AccDetail').map(b => ({ name: val(b, 'AccountName'), type: val(b, 'AmountType'), amt: val(b, 'AmtMainCur') }));
eq(JSON.stringify(myAcc), JSON.stringify(sAcc), 'AccEntries identical (party Dr −275381.1, Sales 266825.74, CGST 4277.68, SGST 4277.68)');
const sum = myAcc.reduce((a, b) => a + Math.round(Number(b.amt) * 100), 0);
eq(sum, 0, 'AccEntries balance to zero');

console.log('\n4. Generated XML = Busy format');
ok(xml.startsWith('<?xml version="1.0" encoding="iso8859-1"?><Sale>') && xml.endsWith('</Sale>'), 'iso8859-1 declaration, root <Sale>');
['VchSeriesName', 'Date', 'VchType', 'StockUpdationDate', 'VchNo', 'STPTName', 'MasterName1', 'MasterName2', 'TranCurName', 'InputType'].forEach(t => eq(val(xml, t), val(sample, t), 'header ' + t + ' = ' + val(sample, t)));
const myItems = blocks(xml, 'ItemDetail');
const fieldsSame = ['Price', 'ListPrice', 'Amt', 'NettAmount', 'STAmount', 'STPercent', 'TaxBeforeSurcharge', 'STPercent1', 'TaxBeforeSurcharge1', 'ItemHSNCode', 'TaxPaid', 'MC', 'Param1', 'MainQty', 'Amount'];
let fm = [];
// Known, deliberate differences: parameter stock in a different pack unit (ParamStockDetails ConFactor ≠ 1, e.g. Mirchi 0.5)
// is a Busy item-master setting we cannot know, and Busy also marks one taxed line (Ghee) TaxPaid=True; we write TaxPaid only on Non-GST lines.
myItems.forEach((b, k) => { const sb = blocks(sample, 'ItemDetail')[k]; fieldsSame.forEach(f => {
  if (f === 'MainQty' && val(sb, 'ConFactor', 1) !== undefined && /<ParamStockDetails>[\s\S]*<ConFactor>(?!1<)/.test(sb)) return;
  if (f === 'TaxPaid' && val(sb, 'ItemTaxCategory') !== 'Non-GST') return;
  if (val(b, f) !== val(sb, f)) fm.push(sItems[k].name + '.' + f + ' ' + val(b, f) + ' vs ' + val(sb, f)); }); });
ok(!fm.length, 'per-line XML fields equal the sample: ' + fieldsSame.join(', ') + (fm.length ? '\n     ' + fm.join('\n     ') : ''));
eq(val(xml, 'Value1'), val(sample, 'Value1'), 'bill-by-bill reference amount');
ok(!/tmp[A-Za-z]*Code|OriginalID|OldIdentity|CompName/.test(xml), 'no Busy-internal codes (tmp*Code, OriginalID, OldIdentity, CompName)');
const tagsSample = new Set([...sample.matchAll(/<([A-Za-z0-9]+)[ >\/]/g)].map(m => m[1]));
const extra = [...new Set([...xml.matchAll(/<([A-Za-z0-9]+)[ >\/]/g)].map(m => m[1]))].filter(t => !tagsSample.has(t));
ok(!extra.length, 'every tag we write exists in the real Busy export' + (extra.length ? ' — new: ' + extra.join(',') : ''));

console.log('\n5. Several bills, skips, cash party, zip');
const bills = [bill, Object.assign({}, bill, { id: 'b38', billNumber: 'RS/2026-27/0038', sequence: 38, customerName: '', items: [{ productName: 'Sugar', price: 44.6, quantity: 2, unit: 'kg' }] }),
  Object.assign({}, bill, { id: 'b39', billNumber: 'RS/2026-27/0039', sequence: 39, items: [{ productName: 'Sugar', price: null, quantity: 2, unit: 'kg' }] })];
const out = buildBusyExport(bills, cfg);
eq(out.files.length, 2, '2 vouchers made'); eq(out.skipped.length, 1, '1 bill skipped (no price)');
eq(out.files[1].name, 'Sales-RS-2026-27-0038.xml', 'file name from bill number');
eq(val(out.files[1].xml, 'MasterName1'), 'Cash', 'bill with no customer → Cash party');
ok(!out.files[1].xml.includes('PendingBillDetails'), 'no bill-by-bill reference for the cash party');
eq(val(out.files[1].xml, 'UnitName'), 'Kgs.', 'Kirana unit "kg" → Busy "Kgs."');
const seq = buildBusyExport([bills[1]], Object.assign({}, cfg, { vchNoMode: 'sequence' }));
eq(val(seq.files[0].xml, 'VchNo'), '38', 'voucher number mode "sequence" → 38');
const zip = makeZip(out.files.map(f => ({ name: f.name, bytes: latin1Bytes(f.xml) })));
eq(new DataView(zip.buffer).getUint32(0, true), 0x04034b50, 'zip starts with a local file header');

fs.mkdirSync(path.join(HERE, 'out'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'out', out.files[0].name), Buffer.from(latin1Bytes(out.files[0].xml)));
fs.writeFileSync(path.join(HERE, 'out', 'busy-export.zip'), Buffer.from(zip));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
