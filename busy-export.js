/* Kirana Desk → Busy 21 sales voucher XML.
   Format copied from a real Busy 21 (Rel 13.0) export of one Sale voucher (root <Sale>, iso8859-1).
   Busy's internal fields (tmp*Code, OriginalID, OldIdentity, CompName) are left out on purpose:
   those codes belong to one Busy company. Busy matches accounts, items, units, tax categories and
   the material centre by NAME, so the names here must match the masters in Busy exactly.
   Pure functions only, so the same file runs in the browser and in Node tests. */

export const BUSY_DEFAULTS = {
  firmId: 'sampurn',            // Kirana Desk form whose bills go to this Busy company
  series: 'Main',               // VchSeriesName
  stpt: 'L/GST-TaxIncl.',       // Sale type: local, GST, prices include tax
  materialCentre: 'Main Store', // MasterName2 / MC
  salesAccount: 'Sales',
  cgstAccount: 'CGST Output',
  sgstAccount: 'SGST Output',
  partyMode: 'customer',        // 'customer' = bill's customer name is the Busy party; 'cash' = always cashParty
  cashParty: 'Cash',
  companyName: 'Ridhhi Sidhi Stores            (2025-26)', // CompName: Busy's Paste needs it to match the open company (verified by paste test, Nov 2)
  vchNoMode: 'full',            // 'full' = RS/2026-27/0012 ; 'sequence' = 12
  defaultTaxCategory: '',       // used for items with no mapping; '' = from the bill's GST % (none → Non-GST)
  brandAsParam: false,          // send every line's brand as Busy parameter Param1 (per item: items[name].param)
  billRef: true,                // add a bill-by-bill reference for the party (not for the cash party)
  units: { kg: 'Kgs.', kgs: 'Kgs.', 'kgs.': 'Kgs.', kilo: 'Kgs.', pc: 'Pcs.', pcs: 'Pcs.', 'pcs.': 'Pcs.', piece: 'Pcs.', pieces: 'Pcs.', nos: 'Pcs.' },
  items: {},                    // lower-case Kirana product name → { busyName, taxCategory, hsn, unit, param }
  customers: {}                 // lower-case Kirana customer name → Busy party name
};

export function mergeConfig(saved) {
  const c = Object.assign({}, BUSY_DEFAULTS, saved || {});
  c.units = Object.assign({}, BUSY_DEFAULTS.units, (saved && saved.units) || {});
  c.items = Object.assign({}, (saved && saved.items) || {});
  c.customers = Object.assign({}, (saved && saved.customers) || {});
  return c;
}

// Busy writes 2-decimal amounts without trailing zeros (761.9, 79245.6, 0.25).
export function round2(x) { const n = Number(x) || 0; return Math.round((n + (n >= 0 ? 1e-9 : -1e-9)) * 100) / 100; }
export function num(x) { const r = round2(x); return String(Object.is(r, -0) ? 0 : r); }
function numQty(x) { const n = Math.round((Number(x) || 0) * 1000) / 1000; return String(n); }

// "GST 5%" → 5, "GST 12% to 5%" → 5 (the rate it changed TO), "Non-GST"/"Exempt"/"Nil Rated" → 0
export function taxRateOf(category) {
  const s = String(category || '');
  if (/non[\s-]*gst|exempt|nil/i.test(s)) return 0;
  const all = s.match(/(\d+(?:\.\d+)?)\s*%/g);
  return all ? parseFloat(all[all.length - 1]) : 0;
}
export function categoryForRate(rate) { const r = Number(rate) || 0; return r > 0 ? 'GST ' + r + '%' : 'Non-GST'; }

// Tax-inclusive split, the way Busy rounds it: each half (CGST, SGST) is rounded to paise first,
// tax = 2 × half, taxable = amount − tax. Reproduces every line of Busy sale no. 37 exactly.
export function splitInclusive(amount, rate) {
  const amt = round2(amount), r = Number(rate) || 0;
  if (r <= 0) return { amt, half: 0, tax: 0, nett: amt };
  const half = round2(amt * r / 2 / (100 + r)), tax = round2(half * 2);
  return { amt, half, tax, nett: round2(amt - tax) };
}

export function busyDate(iso) { const [y, m, d] = String(iso).slice(0, 10).split('-'); return d + '-' + m + '-' + y; }

const XML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
// iso8859-1 file: anything above U+00FF (₹, Hindi) becomes a numeric character reference.
export function xesc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => XML_ESC[c]).replace(/[^\x09\x0a\x0d\x20-\xff]/gu, ch => { const cp = ch.codePointAt(0); return cp < 0x20 ? '' : '&#' + cp + ';'; });
}
export function latin1Bytes(str) { const out = new Uint8Array(str.length); for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff; return out; }

const key = s => String(s || '').trim().toLowerCase();

export function vchNoFor(bill, cfg) {
  if (cfg.vchNoMode === 'sequence' && bill.sequence != null) return String(bill.sequence);
  return String(bill.billNumber || bill.sequence || '');
}

// Kirana Desk bill → plain voucher object (all numbers computed), or { problem } if it can't go to Busy.
export function billToVoucher(bill, cfgIn) {
  const cfg = mergeConfig(cfgIn);
  const items = (bill.items || []).filter(i => String(i.productName || '').trim() && Number(i.quantity) > 0);
  if (!items.length) return { problem: 'no item lines' };
  const unpriced = items.filter(i => !(Number(i.price) > 0)).map(i => String(i.productName).trim());
  if (unpriced.length) return { problem: 'no price on ' + unpriced.join(', '), unpriced };
  const custKey = key(bill.customerName);
  const party = cfg.partyMode === 'cash' || !custKey ? cfg.cashParty : (cfg.customers[custKey] || String(bill.customerName).trim());
  const billRate = Number(bill.gst) > 0 ? Number(bill.gst) : 0;
  const unmapped = [];
  const lines = items.map((i, n) => {
    const m = cfg.items[key(i.productName)] || {};
    if (!cfg.items[key(i.productName)]) unmapped.push(i.productName);
    const category = (m.taxCategory || '').trim() || cfg.defaultTaxCategory || categoryForRate(billRate);
    const rate = taxRateOf(category);
    const qty = Number(i.quantity), price = Number(i.price);
    const s = splitInclusive(price * qty, rate);
    const unit = (m.unit || '').trim() || cfg.units[key(i.unit)] || String(i.unit || '').trim() || 'Pcs.';
    return { srNo: n + 1, itemName: (m.busyName || '').trim() || String(i.productName).trim(), unit, qty, price, hsn: (m.hsn || '').trim(),
      category, rate, brand: String(i.brand || '').trim(), param: !!m.param, amt: s.amt, nett: s.nett, tax: s.tax, half: s.half };
  });
  const total = round2(lines.reduce((a, l) => a + l.amt, 0));
  const cgst = round2(lines.reduce((a, l) => a + l.half, 0));
  const sales = round2(lines.reduce((a, l) => a + l.nett, 0));
  return { vchNo: vchNoFor(bill, cfg), date: busyDate(bill.date), party, partyIsCash: party === cfg.cashParty,
    billingName: String(bill.customerName || '').trim(), lines, total, sales, cgst, sgst: cgst, unmapped };
}

function tag(name, value) { return value === '' || value == null ? '<' + name + '/>' : '<' + name + '>' + xesc(value) + '</' + name + '>'; }

export function voucherXml(v, cfgIn) {
  const cfg = mergeConfig(cfgIn);
  const D = v.date, N = v.vchNo, mc = cfg.materialCentre;
  let x = '<?xml version="1.0" encoding="iso8859-1"?><Sale>' +
    tag('VchSeriesName', cfg.series) + tag('Date', D) + tag('VchType', 9) + tag('StockUpdationDate', D) + tag('VchNo', N) +
    tag('STPTName', cfg.stpt) + tag('MasterName1', v.party) + tag('MasterName2', mc) + tag('TranCurName', 'Rs.') + tag('InputType', 1) +
    '<BillingDetails>' + tag('PartyName', v.billingName || v.party) + '</BillingDetails>' +
    '<VchOtherInfoDetails><OFInfo/>' + tag('PurchaseBillNo', N) + tag('PurchaseBillDate', D) + '</VchOtherInfoDetails><ItemEntries>';
  v.lines.forEach(l => {
    x += '<ItemDetail>' + tag('Date', D) + tag('VchType', 9) + tag('VchNo', N) + tag('SrNo', l.srNo) + tag('ItemName', l.itemName) +
      tag('UnitName', l.unit) + tag('AltUnitName', l.unit) + tag('ConFactor', 1) + tag('Qty', numQty(l.qty)) + tag('QtyMainUnit', numQty(l.qty)) + tag('QtyAltUnit', numQty(l.qty)) +
      (l.hsn ? tag('ItemHSNCode', l.hsn) : '') + tag('ItemTaxCategory', l.category) + '<ItemDescInfo/>' +
      tag('Price', num(l.price)) + tag('PriceAltUnit', num(l.price)) + tag('ListPrice', num(l.price)) + tag('Amt', num(l.amt)) + tag('NettAmount', num(l.nett));
    if (l.rate > 0) x += tag('STAmount', num(l.tax)) + tag('STPercent', l.rate / 2) + tag('TaxBeforeSurcharge1', num(l.half)) + tag('STPercent1', l.rate / 2) + tag('TaxBeforeSurcharge', num(l.half));
    else x += tag('TaxPaid', 'True');
    x += tag('MC', mc) + '<ItemSerialNoEntries/>';
    if ((cfg.brandAsParam || l.param) && l.brand) {
      x += '<ParamStockEntries><ParamStockDetails>' + tag('Date', D) + tag('VchType', 9) + tag('VchNo', N) + tag('VchItemGridSN', l.srNo) + tag('SrNo', 1) + tag('Param1', l.brand) +
        tag('MainQty', numQty(-l.qty)) + tag('AltQty', numQty(-l.qty)) + tag('MainUnitPrice', num(l.price)) + tag('AltUnitPrice', num(l.price)) + tag('Amount', num(-l.amt)) +
        tag('Party', v.party) + tag('BCNMode', 1) + '<Discount/><Markup/>' + tag('NettAltPrice', num(l.price)) + tag('NettAmount', num(-l.amt)) + tag('NettPrice', num(l.price)) + tag('ConFactor', 1) +
        '</ParamStockDetails></ParamStockEntries>';
    } else x += '<ParamStockEntries/>';
    x += '<BatchEntries/>' + tag('RecType', 2) + '</ItemDetail>';
  });
  x += '</ItemEntries><AccEntries>';
  const acc = [[v.party, 1, -v.total], [cfg.salesAccount, 2, v.sales]];
  if (v.cgst > 0) acc.push([cfg.cgstAccount, 2, v.cgst], [cfg.sgstAccount, 2, v.sgst]);
  acc.forEach((a, i) => { x += '<AccDetail>' + tag('Date', D) + tag('VchType', 9) + tag('VchNo', N) + tag('SrNo', i + 1) + tag('AccountName', a[0]) + tag('AmountType', a[1]) + tag('AmtMainCur', num(a[2])) + '<BillRefs/></AccDetail>'; });
  x += '</AccEntries>';
  if (cfg.billRef && !v.partyIsCash) {
    x += '<PendingBillDetails><BillDetail>' + tag('MasterName1', v.party) + '<BillRefs>' + tag('Method', 1) + tag('SrNo', 1) + tag('RefNo', N) + tag('Date', D) + tag('DueDate', D) +
      tag('Value1', num(-v.total)) + tag('VchType', 9) + tag('MfgDate', D) + '</BillRefs></BillDetail></PendingBillDetails>';
  }
  x += '<POSVchData><CarrySettlement>True</CarrySettlement></POSVchData>' + (cfg.companyName ? tag('CompName', cfg.companyName) : '') + '</Sale>';
  return x;
}

export function fileNameFor(v) { return 'Sales-' + String(v.vchNo).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') + '.xml'; }

// bills already filtered by firm and date range
export function buildBusyExport(bills, cfgIn) {
  const cfg = mergeConfig(cfgIn);
  const files = [], skipped = [], unmapped = new Set();
  bills.filter(b => b && !b.deleted).sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.sequence || 0) - (b.sequence || 0)).forEach(b => {
    const v = billToVoucher(b, cfg);
    if (v.problem) { skipped.push({ billNumber: b.billNumber, reason: v.problem }); return; }
    v.unmapped.forEach(n => unmapped.add(n));
    files.push({ name: fileNameFor(v), xml: voucherXml(v, cfg), voucher: v });
  });
  return { files, skipped, unmapped: Array.from(unmapped) };
}

// One saved bill → exactly one .xml (never a zip), for Busy's Add Sale > Paste or Import.
// Returns { file: { name, xml, voucher } } or { problem, unpriced: [item names] }.
export function singleBillExport(bill, cfgIn) {
  if (!bill || bill.deleted) return { problem: 'bill not found', unpriced: [] };
  const cfg = mergeConfig(cfgIn);
  const v = billToVoucher(bill, cfg);
  if (v.problem) return { problem: v.problem, unpriced: v.unpriced || [] };
  return { file: { name: fileNameFor(v), xml: voucherXml(v, cfg), voucher: v } };
}

// Find a bill by what a person types: the full bill no. ("RS/2026-27/0041") or just its number ("41").
// Among several matches (different years) the newest wins.
export function findBillByNo(bills, typed, firmId) {
  const q = String(typed || '').trim().toLowerCase(); if (!q) return null;
  const pool = (bills || []).filter(b => b && !b.deleted && (!firmId || b.businessId === firmId));
  const newest = list => list.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.sequence || 0) - (a.sequence || 0))[0] || null;
  const exact = pool.filter(b => String(b.billNumber || '').trim().toLowerCase() === q);
  if (exact.length) return newest(exact);
  if (/^\d+$/.test(q)) { const n = Number(q); const bySeq = pool.filter(b => Number(b.sequence) === n || Number((String(b.billNumber || '').match(/(\d+)\s*$/) || [])[1]) === n); if (bySeq.length) return newest(bySeq); }
  return null;
}

// Minimal ZIP writer (stored, no compression) so many voucher files download as one.
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function makeZip(files, when = new Date()) {
  const dosTime = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
  const dosDate = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const chunks = [], central = []; let offset = 0;
  files.forEach(f => {
    const name = latin1Bytes(f.name), data = f.bytes, crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(8, 0, true); h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(h.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + data.length;
  });
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
  const all = chunks.concat(central, [new Uint8Array(e.buffer)]);
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0)); let p = 0; all.forEach(b => { out.set(b, p); p += b.length; });
  return out;
}
