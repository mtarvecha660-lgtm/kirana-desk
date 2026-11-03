import { firebaseConfig } from './firebase-config.js';
import { mergeConfig, buildBusyExport, latin1Bytes, makeZip, singleBillExport, findBillByNo } from './busy-export.js';

/* Local-first dispatch register. Price on each bill line is optional; no GST or payment fields. */
(() => {
  'use strict';
  const BIZ = [
    { id: 'sampurn', name: 'Riddhi Siddhi Store', prefix: 'RS', color: '#2563eb', addr: 'Kalakhet, Mandsaur', gstin: '23AEZPT3880L1ZI', bank1: 'SBI Bank A/c. No.31452441452', bank2: 'IFSC Code. SBIN0030099' },
    { id: 'surya', name: 'Surya Supplies', prefix: 'SS', color: '#059669' },
    { id: 'dhanraj', name: 'Sampurn Kirana Shop', prefix: 'SK', color: '#d97706' }
  ];
  const names = { dashboard: 'Overview', bills: 'Dispatch records', catalog: 'Products & customers', analytics: 'Analytics', supply: 'Supply orders', busy: 'Export to Busy', backup: 'Backup & restore' };
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const fy = value => { const d = new Date(value + 'T12:00:00'); const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return y + '-' + String(y + 1).slice(-2); };
  const dateLabel = value => new Intl.DateTimeFormat('en-IN', { day:'2-digit', month:'short', year:'numeric' }).format(new Date(value + 'T12:00:00'));
  const number = v => new Intl.NumberFormat('en-IN', { maximumFractionDigits:3 }).format(Number(v) || 0);
  const biz = key => BIZ.find(b => b.id === key) || BIZ[0];
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2);
  let db, page = 'dashboard', form = 'all', catalog = 'products', search = '', catalogSearch = '', period = 'all', analyticsPeriod = 'fy';
  const ROLES = { owner:['bill','catalog','delete','analytics','backup'], entry:['bill','catalog','analytics'], analyst:['analytics'] };
  let role = 'owner', backupDir = null, autoEnabled = false, autoTimer = null;
  let backupPromptShown = false;
  const can = w => (ROLES[role] || ROLES.owner).includes(w);
  function applyRole(){ const top = $('#new-bill-top'); if(top) top.hidden = !can('bill'); }
  function roleDialog(email){
    $('#record-dialog').innerHTML = '<div class="modal-head"><div><div class="eyebrow">YOUR ROLE</div><h2>Choose your role</h2><p>Signed in as ' + esc(email) + '. This role applies on every device for this account.</p></div><button class="icon-button" data-action="close-dialog">✕</button></div><div class="modal-body"><div style="display:flex;flex-direction:column;gap:10px">' +
      [['owner','Owner','Everything, including deleting records and backups'],['entry','Data entry','Create bills and add products or customers'],['analyst','Analyst','View records and analytics, export reports']].map(r => '<button class="button button-light" data-action="pick-role" data-role="' + r[0] + '" style="display:flex;justify-content:space-between;align-items:center;padding:13px 15px"><b style="flex:none">' + r[1] + '</b><span style="font-size:12px;color:var(--muted);text-align:right">' + r[2] + '</span></button>').join('') + '</div></div>';
    $('#record-dialog').showModal();
  }
  async function saveUserRole(email){
    if(window.KiranaCloud && window.KiranaCloud.configured && window.KiranaCloud.user && email){
      try{ await window.KiranaCloud.write('users', { id: email, role: role, updatedAt: new Date().toISOString() }); }catch(e){ console.warn('Role save queued.', e); }
    }
  }
  function getSetting(id){ return new Promise(resolve => { try{ const r = db.transaction('settings').objectStore('settings').get(id); r.onsuccess = () => resolve(r.result && r.result.handle); r.onerror = () => resolve(null); }catch(e){ resolve(null); } }); }
  function saveSetting(id, value){ return new Promise((resolve, reject) => { const tx = db.transaction('settings','readwrite'); tx.objectStore('settings').put({ id, handle: value }); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); }
  async function loadBackupDir(){
    if(!window.showDirectoryPicker) return;
    try{
      const h = await getSetting('backupDir');
      if(h){ backupDir = h; const q = await h.queryPermission({ mode:'readwrite' }); if(q === 'granted'){ autoEnabled = true; writeAutoBackup('startup'); } }
    }catch(e){ console.warn('Auto backup load skipped.', e); }
  }
  async function pickBackupDir(){
    if(!window.showDirectoryPicker){ toast('Automatic backup needs Chrome or Edge on a computer.', true); return; }
    try{
      const h = await showDirectoryPicker({ mode:'readwrite' });
      backupDir = h; await saveSetting('backupDir', h);
      const q = await h.queryPermission({ mode:'readwrite' });
      if(q === 'granted'){ autoEnabled = true; await writeAutoBackup('folder-set'); }
      toast('Auto backup folder set. New records will be saved there as they come.');
      if(page === 'backup') render();
    }catch(e){ /* folder picker cancelled */ }
  }
  async function reallowBackup(){
    if(!backupDir) return;
    try{ const q = await backupDir.requestPermission({ mode:'readwrite' }); if(q === 'granted'){ autoEnabled = true; await writeAutoBackup('reallow'); toast('Automatic backup is back on.'); if(page === 'backup') render(); } }catch(e){ console.warn(e); }
  }
  async function writeAutoBackup(reason){
    if(!backupDir || !db) return;
    try{
      const q = await backupDir.queryPermission({ mode:'readwrite' });
      if(q !== 'granted'){ autoEnabled = false; return; }
      const b = await buildIncremental(reason);
      if(!b) return;
      const fh = await backupDir.getFileHandle('kirana-desk-backup-' + today() + '-' + backupStamp() + '.json', { create:true });
      const w = await fh.createWritable();
      await w.write(new Blob([JSON.stringify(b.data, null, 2)], { type:'application/json' }));
      await w.close();
      applyBackupMarks(b.marks);
      if(page === 'backup') render();
    }catch(e){ console.warn('Automatic backup failed this time.', e); }
  }
  function scheduleAutoBackup(){ if(!autoEnabled) return; clearTimeout(autoTimer); autoTimer = setTimeout(() => writeAutoBackup('change'), 15000); }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('kirana-desk', 3);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('bills')) d.createObjectStore('bills', { keyPath:'id' }).createIndex('date', 'date');
        if (!d.objectStoreNames.contains('counters')) d.createObjectStore('counters', { keyPath:'id' });
        if (!d.objectStoreNames.contains('products')) d.createObjectStore('products', { keyPath:'id' });
        if (!d.objectStoreNames.contains('customers')) d.createObjectStore('customers', { keyPath:'id' });
        if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath:'id' });
        if (!d.objectStoreNames.contains('supplyorders')) d.createObjectStore('supplyorders', { keyPath:'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  const localAll = store => new Promise((resolve, reject) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => resolve(r.result || []); r.onerror = () => reject(r.error); });
  const putLocal = (store, value) => new Promise((resolve, reject) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(value); tx.oncomplete = () => resolve(value); tx.onerror = () => reject(tx.error); });
  const delLocal = (store, key) => new Promise((resolve, reject) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).delete(key); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  async function all(store) {
    if(window.KiranaCloud&&window.KiranaCloud.configured&&window.KiranaCloud.user){
      try{
        const records=await window.KiranaCloud.list(store);
        await Promise.all(records.map(record=>putLocal(store,record)));
        return records;
      }catch(error){console.warn('Cloud read unavailable; using local cache.',error);}
    }
    return localAll(store);
  }
  async function put(store, value) {
    value = Object.assign({}, value, { updatedAt: new Date().toISOString() });
    await putLocal(store,value);scheduleAutoBackup();
    if(window.KiranaCloud&&window.KiranaCloud.configured&&window.KiranaCloud.user)window.KiranaCloud.write(store,value).catch(error=>{console.warn('Cloud write is queued or unavailable.',error);$('#online-label').textContent='Sync pending';});
    return value;
  }
  async function del(store, key) {
    await delLocal(store,key);scheduleAutoBackup();
    if(window.KiranaCloud&&window.KiranaCloud.configured&&window.KiranaCloud.user)window.KiranaCloud.delete(store,key).catch(error=>{console.warn('Cloud delete is queued or unavailable.',error);$('#online-label').textContent='Sync pending';});
  }
  function makeBill(data) {
    if(window.KiranaCloud&&window.KiranaCloud.configured&&window.KiranaCloud.user){
      const cloudBill=Object.assign({},data,{id:uid()});
      return window.KiranaCloud.createBill(cloudBill).then(saved=>new Promise((resolve,reject)=>{
        const tx=db.transaction(['counters','bills'],'readwrite');
        tx.objectStore('counters').put({id:saved.businessId+':'+saved.financialYear,businessId:saved.businessId,financialYear:saved.financialYear,lastNumber:saved.sequence});
        tx.objectStore('bills').put(saved);
        tx.oncomplete=()=>{resolve(saved);scheduleAutoBackup();};tx.onerror=()=>reject(tx.error);
      }));
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['counters', 'bills'], 'readwrite'), counters = tx.objectStore('counters');
      const year = fy(data.date), counterId = data.businessId + ':' + year, req = counters.get(counterId);
      let saved;
      req.onsuccess = () => {
        const seq = (req.result && req.result.lastNumber || 0) + 1, b = biz(data.businessId);
        saved = Object.assign({}, data, { id:uid(), financialYear:year, sequence:seq, billNumber:b.prefix + '/' + year + '/' + String(seq).padStart(4, '0'), createdAt:new Date().toISOString() });
        counters.put({ id:counterId, businessId:data.businessId, financialYear:year, lastNumber:seq });
        tx.objectStore('bills').add(saved);
      };
      tx.oncomplete = () => { resolve(saved); scheduleAutoBackup(); }; tx.onerror = () => reject(tx.error);
    });
  }
  async function autoSaveCatalog(data){
    let added=0;const iso=new Date().toISOString();
    const cname=String(data.customerName||'').trim();
    if(cname){
      const cs=await all('customers'),key=cname.toLowerCase();
      const known=cs.some(c=>String(c.name||'').trim().toLowerCase()===key&&(c.businessId===data.businessId||c.businessId===undefined||c.businessId==null));
      if(!known){await put('customers',{id:uid(),businessId:data.businessId,name:cname,note:'',createdAt:iso});added++;}
    }
    const ps=await all('products'),pmap={};
    ps.forEach(p=>{pmap[String(p.name||'').trim().toLowerCase()]=true;});
    for(const it of (data.items||[])){
      const pname=String(it.productName||'').trim();
      if(!pname)continue;
      if(!pmap[pname.toLowerCase()]){await put('products',{id:uid(),businessId:data.businessId,name:pname,unit:String(it.unit||'').trim(),brand:String(it.brand||'').trim(),createdAt:iso});pmap[pname.toLowerCase()]=true;added++;}
    }
    return added;
  }
  function toast(message, error) { const n = document.createElement('div'); n.className = 'toast' + (error ? ' error' : ''); n.textContent = message; $('#toast-region').append(n); setTimeout(() => n.remove(), 3200); }
  function head(kicker, title, subtitle, action) { return '<div class="page-head"><div><div class="eyebrow">' + kicker + '</div><h1 class="page-title">' + title + '</h1><p class="page-subtitle">' + subtitle + '</p></div>' + (action || '') + '</div>'; }
  function tabs() { return '<div class="business-tabs"><button class="business-tab ' + (form === 'all' ? 'active' : '') + '" data-business="all"><span class="tab-dot"></span>All forms</button>' + BIZ.map(b => '<button class="business-tab ' + (form === b.id ? 'active' : '') + '" data-business="' + b.id + '"><span class="tab-dot"></span>' + esc(b.name) + '</button>').join('') + '</div>'; }
  function stat(label, value, note, icon) { return '<div class="stat-card"><div class="stat-top"><span>' + label + '</span><span class="stat-icon">' + icon + '</span></div><div class="stat-number">' + value + '</div><div class="stat-note">' + note + '</div></div>'; }
  function chip(key) { const b = biz(key); return '<span class="business-chip"><i style="background:' + b.color + '"></i>' + esc(b.name) + '</span>'; }
  function empty(title, text, button) { return '<div class="empty-state"><div class="empty-mark">＋</div><b>' + title + '</b><p>' + text + '</p>' + (button || '') + '</div>'; }
  function billTable(items, showForm) {
    if (!items.length) return empty('No bills yet', 'Create your first dispatch bill. Each form gets its own number sequence for every financial year.', can('bill') ? '<button class="button button-primary" data-action="new-bill">＋ Create first bill</button>' : '');
    return '<div class="table-wrap"><table class="data-table"><thead><tr><th>BILL NUMBER</th>' + (showForm ? '<th>FORM</th>' : '') + '<th>CUSTOMER</th><th>DATE</th><th>ITEMS</th><th>QUANTITY</th><th></th></tr></thead><tbody>' + items.map(b => {
      const q = b.items.reduce((s, i) => s + Number(i.quantity || 0), 0);
      return '<tr><td class="strong-cell">' + esc(b.billNumber) + '</td>' + (showForm ? '<td>' + chip(b.businessId) + '</td>' : '') + '<td>' + esc(b.customerName) + '</td><td class="muted-cell">' + dateLabel(b.date) + '</td><td>' + b.items.length + '</td><td>' + number(q) + '</td><td class="row-actions" style="white-space:nowrap"><button class="icon-button" data-action="view-bill" data-id="' + esc(b.id) + '" title="View record">↗</button><button class="icon-button" data-action="busy-one" data-id="' + esc(b.id) + '" tabindex="-1" title="Export this bill to Busy (.xml) · Alt+B on a selected row">⇩</button></td></tr>';
    }).join('') + '</tbody></table></div>';
  }
  async function renderDashboard() {
    const results = await Promise.all([all('bills'), all('products'), all('customers')]), bills = results[0], products = results[1], customers = results[2];
    const chosen = bills.filter(b => form === 'all' || b.businessId === form), year = fy(today()), current = chosen.filter(b => b.financialYear === year);
    const itemLines = current.reduce((s, b) => s + b.items.length, 0);
    const p = products, c = customers.filter(x => form === 'all' || x.businessId === form);
    const recent = chosen.sort((a,b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)).slice(0,6);
    $('#page-content').innerHTML = head('GOOD DAY', form === 'all' ? 'Dispatch overview' : esc(biz(form).name), 'Track bills and quantities for FY ' + year + '.', '<div class="head-actions">' + (can('bill') ? '<button class="button button-primary" data-action="new-bill">＋ Create bill</button>' : '') + '</div>') + tabs() +
      '<section class="stats-grid">' + stat('Bills this financial year', current.length, 'Across FY ' + year, '▤') + stat('Items dispatched', itemLines, 'Bill line items this FY', '↗') + stat('Products in catalog', p.length, 'Across all forms', '◫') + stat('Saved customers', c.length, 'Across selected forms', '♙') + '</section>' +
      (can('bill') ? '<div class="quick-grid">' + BIZ.map(b => '<article class="form-card"><span class="form-code">' + b.prefix + '</span><h3>' + esc(b.name) + '</h3><p>Start a dispatch bill. Numbering is separate for this form.</p><button class="button button-light button-small" data-action="new-bill" data-form="' + b.id + '">Create bill →</button></article>').join('') + '</div>' : '') +
      '<section class="panel activity-panel"><div class="panel-head"><div><div class="panel-title">Recent bills</div><div class="panel-caption">Latest dispatches</div></div><button class="button button-light button-small" data-action="goto-bills">View all bills →</button></div>' + billTable(recent, form === 'all') + '</section>';
  }
  // Redraw a page without pulling the search box out from under the cursor (fast typing used to lose letters,
  // and a lost "n" opened a new bill).
  function setPage(html){
    const container=$('#page-content'), live=document.activeElement;
    const keep=live&&(live.id==='bill-search'||live.id==='catalog-search')&&container.contains(live)?live:null;
    if(!keep){container.innerHTML=html;return;}
    const tmp=document.createElement('div');tmp.innerHTML=html;
    let fn=tmp.querySelector('#'+keep.id), ln=keep;
    if(!fn){container.innerHTML=html;return;}
    const depth=(n,top)=>{let d=0;while(n&&n!==top){n=n.parentNode;d++;}return d;};
    if(depth(ln,container)!==depth(fn,tmp)){container.innerHTML=html;return;}
    Array.from(fn.attributes).forEach(a=>{if(a.name!=='value')ln.setAttribute(a.name,a.value);});
    while(ln!==container){
      const lp=ln.parentNode, fp=fn.parentNode;
      Array.from(lp.childNodes).forEach(c=>{if(c!==ln)lp.removeChild(c);});
      let seen=false;
      Array.from(fp.childNodes).forEach(c=>{if(c===fn){seen=true;return;} if(seen)lp.appendChild(c); else lp.insertBefore(c,ln);});
      if(fp!==tmp){Array.from(lp.attributes).forEach(a=>{if(!fp.hasAttribute(a.name))lp.removeAttribute(a.name);});Array.from(fp.attributes).forEach(a=>lp.setAttribute(a.name,a.value));}
      ln=lp;fn=fp;
    }
  }
  async function renderBills() {
    const bills = (await all('bills')).sort((a,b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
    const visible = bills.filter(b => {
      const q = search.toLowerCase(), match = !q || [b.billNumber,b.customerName,...b.items.map(i => i.productName)].some(v => String(v).toLowerCase().includes(q));
      return (form === 'all' || b.businessId === form) && match && (period === 'all' || (period === 'fy' ? b.financialYear === fy(today()) : b.date.startsWith(period)));
    });
    setPage(head('DISPATCH RECORDS','Dispatch records','Find and review entries without paging through the bill book.','<div class="head-actions">' + (can('bill') ? '<button class="button button-primary" data-action="new-bill">＋ Add record</button>' : '') + '</div>') + tabs() +
      '<section class="panel"><div class="toolbar" style="padding:15px 17px;margin:0;border-bottom:1px solid var(--line)"><div class="toolbar-left"><div class="search-box"><span>⌕</span><input id="bill-search" class="input" placeholder="Search bill, customer, product…" value="' + esc(search) + '"></div><span class="tag gray">' + visible.length + ' bills</span></div><div class="toolbar-right"><button class="button button-light button-small" data-action="returns-report">↩ Returns</button><select id="bill-period" class="select" style="width:auto"><option value="all">All dates</option><option value="fy" ' + (period === 'fy' ? 'selected' : '') + '>Current FY</option></select></div></div>' + billTable(visible, form === 'all') + '</section>');
  }
  async function renderCatalog() {
    const res = await Promise.all([all('products'),all('customers')]), products=res[0], customers=res[1], list=catalog==='products'?products:customers;
    const shown = list.filter(r => (catalog==='products'||form==='all'||r.businessId===form) && (!catalogSearch || (r.name+' '+(r.note||'')).toLowerCase().includes(catalogSearch.toLowerCase())));
    const label = catalog==='products'?'product':'customer', records = shown.length ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>'+(catalog==='products'?'PRODUCT':'CUSTOMER')+'</th><th>'+(catalog==='products'?'BRAND':'FORM')+'</th><th>'+(catalog==='products'?'UNIT':'CONTACT / NOTE')+'</th><th>ADDED</th><th></th></tr></thead><tbody>'+shown.map(r => '<tr><td><div class="row-title"><span class="avatar">'+esc(r.name.slice(0,1).toUpperCase())+'</span><span class="strong-cell">'+esc(r.name)+'</span>'+(r.isSample?'<span class="tag gray">SAMPLE</span>':'')+'</div></td><td>'+(catalog==='products'?esc(r.brand||'—'):chip(r.businessId))+'</td><td class="muted-cell">'+esc(catalog==='products'?(r.unit||'—'):(r.note||'—'))+'</td><td class="muted-cell">'+dateLabel(r.createdAt.slice(0,10))+'</td><td>'+(catalog==='customers'?'<button class="icon-button" data-action="customer-register" data-name="'+esc(r.name)+'" title="In / Out register">\u21a9</button>':'')+(can('catalog')?'<button class="icon-button" data-action="edit-record" data-kind="'+catalog+'" data-id="'+esc(r.id)+'" title="Edit">✎</button>':'')+(can('delete')?'<button class="icon-button" data-action="delete-record" data-kind="'+catalog+'" data-id="'+esc(r.id)+'" title="Delete">⌫</button>':'')+'</td></tr>').join('')+'</tbody></table></div>' : empty('No '+catalog+' yet','Add '+(catalog==='products'?'products dispatched from this form':'the people who receive products from this form')+'. They will be searchable on bills.', can('catalog') ? '<button class="button button-primary" data-action="add-record" data-kind="'+catalog+'">＋ Add '+label+'</button>' : '');
    setPage(head('MASTER LISTS','Products & customers','Products are shared across all forms. Customers belong to their form.','<div class="head-actions">' + (can('catalog') ? '<button class="button button-primary" data-action="add-record" data-kind="'+catalog+'">＋ Add '+label+'</button>' : '') + '</div>')+tabs()+
      '<div class="tabs-underline"><button class="underline-tab '+(catalog==='products'?'active':'')+'" data-catalog-tab="products">Products ('+products.length+')</button><button class="underline-tab '+(catalog==='customers'?'active':'')+'" data-catalog-tab="customers">Customers ('+customers.filter(r=>form==='all'||r.businessId===form).length+')</button></div><section class="panel" style="margin-top:15px"><div class="toolbar" style="padding:14px 17px;margin:0;border-bottom:1px solid var(--line)"><div class="toolbar-left"><div class="search-box"><span>⌕</span><input id="catalog-search" class="input" placeholder="Search '+catalog+'…" value="'+esc(catalogSearch)+'"></div><span class="tag gray">'+shown.length+' records</span></div></div>'+records+'</section>');
  }
  function startDate(scope) {
    const n=new Date();
    if(scope==='fy'){const y=n.getMonth()>=3?n.getFullYear():n.getFullYear()-1;return new Date(y,3,1);}
    return new Date(n.getFullYear(),n.getMonth()-Number(scope)+1,1);
  }
  async function renderAnalytics() {
    const bills=await all('bills'), start=startDate(analyticsPeriod), list=bills.filter(b=>(form==='all'||b.businessId===form)&&new Date(b.date+'T12:00:00')>=start), p=new Map(), c=new Map();
    let lines=0;
    list.forEach(b=>{c.set(b.customerName,(c.get(b.customerName)||0)+1);b.items.forEach(i=>{lines++;const key=i.productName+'|'+i.unit,v=p.get(key)||{name:i.productName,qty:0,unit:i.unit};v.qty+=Number(i.quantity)||0;p.set(key,v);});});
    const top=[...p.values()].sort((a,b)=>b.qty-a.qty), max=Math.max(1,...top.map(x=>x.qty));
    const productRows=top.length?top.map(x=>{const title=x.name+' ('+x.unit+')';return '<div class="bar-row"><span title="'+esc(title)+'">'+esc(title.length>19?title.slice(0,18)+'…':title)+'</span><div class="bar-track"><div class="bar-fill" style="width:'+Math.max(3,x.qty/max*100)+'%"></div></div><b>'+number(x.qty)+'</b></div>';}).join(''):'<div class="empty-inline">Bills will build this report as you go.</div>';
    const topC=[...c.entries()].sort((a,b)=>b[1]-a[1]), customerRows=topC.length?'<div class="metric-list">'+topC.map((x,i)=>'<div class="metric-row"><span class="row-title"><span class="avatar">'+(i+1)+'</span>'+esc(x[0])+'</span><span class="metric-value">'+x[1]+' bills</span></div>').join('')+'</div>':'<div class="empty-inline">Customer totals appear after bills are created.</div>';
    $('#page-content').innerHTML=head('BUSINESS INSIGHTS','Dispatch analytics','Product and customer activity, based on quantities and bill counts.','<div class="head-actions"><button class="button button-light" data-action="export-analytics">↓ Export CSV</button></div>')+tabs()+
      '<section class="stats-grid">'+stat('Bills in period',list.length,'Dispatches recorded','▤')+stat('Item lines',lines,'Line items across bills','◫')+stat('Product types',new Set([...p.values()].map(x=>x.name)).size,'Distinct products dispatched','↗')+stat('Customers served',c.size,'Unique customer names','♙')+'</section>'+
      '<div class="toolbar" style="justify-content:flex-end;margin:0 0 13px"><div class="toolbar-right"><span class="field-label" style="margin:0">PERIOD</span><select id="analytics-period" class="select" style="width:auto"><option value="fy" '+(analyticsPeriod==='fy'?'selected':'')+'>Current financial year</option><option value="3" '+(analyticsPeriod==='3'?'selected':'')+'>Last 3 months</option><option value="6" '+(analyticsPeriod==='6'?'selected':'')+'>Last 6 months</option><option value="12" '+(analyticsPeriod==='12'?'selected':'')+'>Last 12 months</option></select></div></div>'+
      '<div class="split-grid"><section class="panel"><div class="panel-head"><div><div class="panel-title">Products by quantity</div><div class="panel-caption">Most dispatched in this period</div></div></div>'+productRows+'</section><section class="panel"><div class="panel-head"><div><div class="panel-title">Frequent customers</div><div class="panel-caption">Ranked by number of bills</div></div></div>'+customerRows+'</section></div>';
  }
  function autoBackupPanel(){
    if(!window.showDirectoryPicker) return '<section class="panel" style="margin-top:16px"><div class="panel-head"><div><div class="panel-title">Automatic backup</div><div class="panel-caption">Needs Chrome or Edge on a computer.</div></div></div></section>';
    const auto = backupDir && autoEnabled;
    return '<section class="panel" style="margin-top:16px"><div class="panel-head"><div><div class="panel-title">Automatic backup on this computer</div><div class="panel-caption">A fresh copy is saved here after every change, even if the shared backend fails.</div></div></div><div style="padding:19px">'+(backupDir?'<span class="tag gray">Folder: '+esc(backupDir.name)+'</span> ':'')+'<button class="button button-primary" data-action="set-backup-folder">'+(backupDir?'Change folder':'Choose auto backup folder')+'</button> '+(backupDir&&!autoEnabled?'<button class="button button-light" data-action="reallow-backup">Allow access again</button>':'')+'<p class="field-hint" style="line-height:1.6;margin-top:10px">'+(auto?'Automatic backup is on. Every new batch of records becomes its own file. Earlier files are never rewritten.':'Choose the folder once. Chrome or Edge will ask for permission, then save every new batch of records there.')+'</p></div></section>';
  }
  async function renderBackup() {
    const res=await Promise.all([all('bills'),all('products'),all('customers')]), last=localStorage.getItem('kiranaDeskLastBackup');
    $('#page-content').innerHTML=head('DATA SAFETY','Backup & restore','Create a portable copy of the records on this computer.')+
      '<div class="notice"><strong>How your data is saved:</strong> your bills, customers, and products are stored in this browser on this computer. They work offline. Export backups to protect against device loss or cleared browser data.</div>'+
      '<section class="stats-grid" style="margin-top:16px">'+stat('Bills',res[0].length,'On this computer','▤')+stat('Products',res[1].length,'On this computer','◫')+stat('Customers',res[2].length,'On this computer','♙')+stat('Last backup',last?dateLabel(last.slice(0,10)):'Not yet',last?new Date(last).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}):'Export a copy now','↥')+'</section>'+
      '<div class="split-grid"><section class="panel"><div class="panel-head"><div><div class="panel-title">Create a backup</div><div class="panel-caption">All forms, lists, bills, and bill counters in one file.</div></div></div><div style="padding:19px"><button class="button button-primary" data-action="export-new-backup">↓ Download new records only</button><button class="button button-light" data-action="export-backup" style="margin-left:8px">Full copy</button><p class="field-hint" style="line-height:1.6">New records only saves just what is not in any earlier backup file, and the file name carries the time, so an earlier file is never rewritten. Full copy saves everything in one file.</p></div></section><section class="panel"><div class="panel-head"><div><div class="panel-title">Restore a backup</div><div class="panel-caption">Replace local records with a saved backup.</div></div></div><div style="padding:19px"><label class="button button-light" for="backup-file">Choose backup file</label><input id="backup-file" type="file" accept="application/json,.json" hidden><p class="field-hint" style="line-height:1.6">Restore replaces current local data. Export it first if you want to keep a copy.</p></div></section></section>' + autoBackupPanel() + '</div>'+
      '<div class="backup-steps"><div class="backup-step"><span class="step-number">1</span><b>Export after billing</b><p>Download a fresh copy after each work session.</p></div><div class="backup-step"><span class="step-number">2</span><b>Keep another copy</b><p>Move the file to a separate drive or your brother’s computer.</p></div><div class="backup-step"><span class="step-number">3</span><b>Restore when needed</b><p>Choose the file on the computer where you want the records.</p></div></div>';
  }

  /* ---------- Export to Busy (XML) ---------- */
  const BUSY_TAX_CATS = ['GST 5%', 'GST 12% to 5%', 'Non-GST', 'GST 0%', 'GST 12%', 'GST 18%', 'Exempt'];
  let busyFrom = null, busyTo = null, busyFirm = null;
  async function busyConfig(){ return mergeConfig(await getSetting('busyExport')); }
  const mapText = obj => Object.keys(obj).map(k => k + ' = ' + obj[k]).join('\n');
  const parseMap = text => { const o = {}; String(text || '').split(/\r?\n/).forEach(line => { const i = line.indexOf('='); if (i > 0) { const k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim(); if (k && v) o[k] = v; } }); return o; };
  async function renderBusy() {
    const cfg = await busyConfig(), bills = await all('bills'), products = await all('products');
    if (!busyFirm) busyFirm = cfg.firmId || BIZ[0].id;
    if (!busyTo) busyTo = today();
    if (!busyFrom) busyFrom = busyTo.slice(0, 8) + '01';
    const names = new Map();
    products.forEach(p => { const n = String(p.name || '').trim(); if (n) names.set(n.toLowerCase(), n); });
    bills.filter(b => b.businessId === busyFirm).forEach(b => (b.items || []).forEach(i => { const n = String(i.productName || '').trim(); if (n && !names.has(n.toLowerCase())) names.set(n.toLowerCase(), n); }));
    const inRange = bills.filter(b => b.businessId === busyFirm && b.date >= busyFrom && b.date <= busyTo);
    const field = (id, label, value, hint) => '<div><label class="field-label" for="' + id + '">' + label + '</label><input class="input" id="' + id + '" value="' + esc(value) + '">' + (hint ? '<p class="field-hint">' + hint + '</p>' : '') + '</div>';
    const rows = Array.from(names.keys()).sort().map(k => { const m = cfg.items[k] || {}; return '<tr data-busy-item="' + esc(k) + '"><td class="strong-cell">' + esc(names.get(k)) + '</td>' +
      '<td><input class="input" data-busy="busyName" placeholder="' + esc(names.get(k)) + '" value="' + esc(m.busyName || '') + '"></td>' +
      '<td><input class="input" data-busy="taxCategory" list="busy-tax-cats" placeholder="' + esc(cfg.defaultTaxCategory || 'from bill GST %') + '" value="' + esc(m.taxCategory || '') + '"></td>' +
      '<td><input class="input" data-busy="hsn" value="' + esc(m.hsn || '') + '" style="width:90px"></td>' +
      '<td><input class="input" data-busy="unit" placeholder="auto" value="' + esc(m.unit || '') + '" style="width:80px"></td>' +
      '<td style="text-align:center"><input type="checkbox" data-busy="param"' + (m.param ? ' checked' : '') + ' title="Send the brand as Busy parameter (only for items that have parameters in Busy)"></td></tr>'; }).join('');
    $('#page-content').innerHTML = head('ACCOUNTING', 'Export to Busy', 'Turn Kirana Desk bills into Busy 21 sales vouchers (XML) and import them in Busy.') +
      '<div class="notice"><strong>First time?</strong> Import into a <b>backup or test company</b> in Busy first and check the bills, stock and GST there. Names below must match the masters in Busy exactly. Bills with a line that has no price are skipped. One bill only? Use Single bill below, or open the bill and press Export to Busy.</div>' +
      '<datalist id="busy-tax-cats">' + BUSY_TAX_CATS.map(c => '<option value="' + esc(c) + '">').join('') + '</datalist>' +
      '<section class="panel" style="margin-top:16px"><div class="panel-head"><div><div class="panel-title">Download for Busy</div><div class="panel-caption">One Busy Sale voucher per bill. One bill → one .xml file; several bills → a .zip of .xml files.</div></div></div>' +
      '<div style="padding:19px;display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;align-items:end">' +
      '<div><label class="field-label" for="busy-firm">FORM</label><select class="input" id="busy-firm">' + BIZ.map(b => '<option value="' + b.id + '"' + (b.id === busyFirm ? ' selected' : '') + '>' + esc(b.prefix + ' · ' + b.name) + '</option>').join('') + '</select></div>' +
      '<div><label class="field-label" for="busy-from">FROM</label><input class="input" type="date" id="busy-from" value="' + busyFrom + '"></div>' +
      '<div><label class="field-label" for="busy-to">TO</label><input class="input" type="date" id="busy-to" value="' + busyTo + '"></div>' +
      '<div><button class="button button-primary" data-action="busy-export" id="busy-export-btn">↓ Download for Busy</button></div></div>' +
      '<div style="padding:0 19px 19px"><p class="field-hint" id="busy-count">' + inRange.length + ' bill' + (inRange.length === 1 ? '' : 's') + ' in this range.</p><div id="busy-result"></div></div></section>' +
      '<section class="panel" style="margin-top:16px" id="busy-single-panel"><div class="panel-head"><div><div class="panel-title">Single bill</div><div class="panel-caption">Type a bill no. (full, like RS/2026-27/0041, or just 41) and press Enter. Downloads one .xml: in Busy use Add Sale → Paste, or Import. Tip: Alt+B on an open bill does the same.</div></div></div>' +
      '<div style="padding:19px;display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;align-items:end"><div><label class="field-label" for="busy-billno">BILL NO.</label><input class="input" id="busy-billno" autocomplete="off" placeholder="e.g. 41"></div><div><button class="button button-primary" data-action="busy-single" id="busy-single-btn">↓ Export this bill</button></div></div><div style="padding:0 19px 19px" id="busy-single-result"></div></section>' +
      '<section class="panel" style="margin-top:16px"><div class="panel-head"><div><div class="panel-title">Busy names</div><div class="panel-caption">Exactly as they are written in Busy.</div></div><button class="button button-light button-small" data-action="busy-save">Save settings</button></div>' +
      '<div style="padding:19px;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">' +
      '<div><label class="field-label" for="busy-partyMode">PARTY</label><select class="input" id="busy-partyMode"><option value="customer"' + (cfg.partyMode === 'customer' ? ' selected' : '') + '>Bill\'s customer (account must exist in Busy)</option><option value="cash"' + (cfg.partyMode === 'cash' ? ' selected' : '') + '>Always the cash party</option></select></div>' +
      field('busy-cashParty', 'CASH SALE PARTY', cfg.cashParty, 'Used when the bill has no customer') +
      field('busy-companyName', 'BUSY COMPANY NAME', cfg.companyName, 'Exactly as Busy shows it (spaces + year). Needed for Busy Paste') + field('busy-salesAccount', 'SALES ACCOUNT', cfg.salesAccount) + field('busy-cgstAccount', 'CGST ACCOUNT', cfg.cgstAccount) + field('busy-sgstAccount', 'SGST ACCOUNT', cfg.sgstAccount) +
      field('busy-materialCentre', 'MATERIAL CENTRE', cfg.materialCentre) + field('busy-series', 'VOUCHER SERIES', cfg.series) + field('busy-stpt', 'SALE TYPE', cfg.stpt, 'L/GST-TaxIncl. = local sale, prices include GST') +
      '<div><label class="field-label" for="busy-vchNoMode">VOUCHER NUMBER</label><select class="input" id="busy-vchNoMode"><option value="full"' + (cfg.vchNoMode === 'full' ? ' selected' : '') + '>Full bill number (RS/2026-27/0012)</option><option value="sequence"' + (cfg.vchNoMode === 'sequence' ? ' selected' : '') + '>Number only (12)</option></select></div>' +
      '<div><label class="field-label" for="busy-defaultTaxCategory">DEFAULT TAX CATEGORY</label><input class="input" id="busy-defaultTaxCategory" list="busy-tax-cats" placeholder="from bill GST % (none → Non-GST)" value="' + esc(cfg.defaultTaxCategory) + '"><p class="field-hint">For items with no tax category below</p></div>' +
      '<div><label class="field-label"><input type="checkbox" id="busy-billRef"' + (cfg.billRef ? ' checked' : '') + '> Bill-by-bill reference for the party</label><p class="field-hint">Like Busy does for credit customers. Not added for the cash party.</p></div>' +
      '</div><div style="padding:0 19px 19px;display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px">' +
      '<div><label class="field-label" for="busy-units">UNITS (Kirana = Busy)</label><textarea class="input" id="busy-units" rows="5">' + esc(mapText(cfg.units)) + '</textarea></div>' +
      '<div><label class="field-label" for="busy-customers">CUSTOMERS (Kirana name = Busy party), optional</label><textarea class="input" id="busy-customers" rows="5" placeholder="Sharma ji = Sharma General Store">' + esc(mapText(cfg.customers)) + '</textarea></div></div></section>' +
      '<section class="panel" style="margin-top:16px"><div class="panel-head"><div><div class="panel-title">Items</div><div class="panel-caption">Busy item name (blank = same name), tax category, HSN, unit. Tick "Brand" only for items that have a brand parameter in Busy.</div></div><button class="button button-light button-small" data-action="busy-save">Save settings</button></div>' +
      '<div class="table-wrap"><table class="data-table"><thead><tr><th>KIRANA ITEM</th><th>BUSY ITEM NAME</th><th>TAX CATEGORY</th><th>HSN</th><th>UNIT</th><th>BRAND</th></tr></thead><tbody>' + (rows || '<tr><td colspan="6" class="muted-cell">No products yet.</td></tr>') + '</tbody></table></div></section>';
  }
  function readBusyForm(prev){
    const c = mergeConfig(prev), v = id => { const el = $('#busy-' + id); return el ? el.value.trim() : c[id]; };
    ['partyMode','companyName','cashParty','salesAccount','cgstAccount','sgstAccount','materialCentre','series','stpt','vchNoMode','defaultTaxCategory'].forEach(k => { c[k] = v(k); });
    if ($('#busy-billRef')) c.billRef = $('#busy-billRef').checked;
    if ($('#busy-units')) c.units = parseMap($('#busy-units').value);
    if ($('#busy-customers')) c.customers = parseMap($('#busy-customers').value);
    c.firmId = busyFirm || c.firmId;
    const items = Object.assign({}, c.items);
    $$('[data-busy-item]').forEach(r => { const m = {}; $$('[data-busy]', r).forEach(i => { if (i.type === 'checkbox') { if (i.checked) m.param = true; } else if (i.value.trim()) m[i.dataset.busy] = i.value.trim(); }); if (Object.keys(m).length) items[r.dataset.busyItem] = m; else delete items[r.dataset.busyItem]; });
    c.items = items;
    if (!c.cashParty) c.cashParty = 'Cash';
    return c;
  }
  async function saveBusy(quiet){ const c = readBusyForm(await getSetting('busyExport')); await saveSetting('busyExport', c); if (!quiet) toast('Busy settings saved.'); return c; }
  function downloadBytes(bytes, name, type){ const url = URL.createObjectURL(new Blob([bytes], { type })), a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500); }
  async function exportBusy(){
    busyFrom = $('#busy-from').value; busyTo = $('#busy-to').value; busyFirm = $('#busy-firm').value;
    if (!busyFrom || !busyTo || busyFrom > busyTo) { toast('Choose a valid date range.', true); return; }
    const cfg = await saveBusy(true);
    const bills = (await all('bills')).filter(b => b.businessId === busyFirm && b.date >= busyFrom && b.date <= busyTo);
    const out = buildBusyExport(bills, cfg), b = biz(busyFirm);
    const res = $('#busy-result');
    const skippedHtml = out.skipped.length ? '<div class="notice" style="margin-top:10px"><strong>Skipped ' + out.skipped.length + ':</strong> ' + out.skipped.map(s => esc(s.billNumber) + ' (' + esc(s.reason) + ')').join('; ') + '</div>' : '';
    const unmappedHtml = out.unmapped.length ? '<p class="field-hint" style="margin-top:8px">No tax category set for: ' + out.unmapped.map(esc).join(', ') + '. Used ' + esc(cfg.defaultTaxCategory || 'the bill\'s GST % (Non-GST if none)') + '. Set them in Items below if that is wrong.</p>' : '';
    if (!out.files.length) { if (res) res.innerHTML = '<p class="field-hint">No bills to export in this range.</p>' + skippedHtml; toast('No bills with prices in this range.', true); return; }
    const tag = b.prefix + '-' + busyFrom + '-to-' + busyTo;
    if (out.files.length === 1) downloadBytes(latin1Bytes(out.files[0].xml), out.files[0].name, 'application/xml');
    else downloadBytes(makeZip(out.files.map(f => ({ name: f.name, bytes: latin1Bytes(f.xml) }))), 'Busy-Sales-' + tag + '.zip', 'application/zip');
    const total = out.files.reduce((s, f) => s + f.voucher.total, 0);
    if (res) res.innerHTML = '<p class="field-hint" style="color:inherit"><b>' + out.files.length + ' voucher' + (out.files.length === 1 ? '' : 's') + '</b> · ₹' + number(Math.round(total * 100) / 100) + ' total · ' + (out.files.length === 1 ? esc(out.files[0].name) : 'zip: unzip into an empty folder, then import that folder in Busy') + '</p>' + unmappedHtml + skippedHtml;
    toast('Busy file downloaded: ' + out.files.length + ' voucher' + (out.files.length === 1 ? '' : 's') + '.');
  }
  function busyMessage(title, html){
    let d=document.getElementById('busy-msg');
    if(!d){d=document.createElement('dialog');d.id='busy-msg';d.className='modal modal-narrow';document.body.append(d);}
    d.innerHTML='<div class="modal-head"><div><div class="eyebrow">EXPORT TO BUSY</div><h2>'+esc(title)+'</h2></div><button class="icon-button" data-action="close-dialog">\u2715</button></div><div class="modal-body">'+html+'</div><div class="modal-foot"><span></span><button class="button button-primary" type="button" data-action="close-dialog" id="busy-msg-ok">OK</button></div>';
    d.showModal(); const ok=$('#busy-msg-ok'); if(ok)ok.focus();
  }
  // One bill → one .xml (never a zip). Same voucher format and settings as the Export to Busy page.
  async function exportBill(b){
    if(!b){toast('Bill not found.',true);return null;}
    const out=singleBillExport(b, await busyConfig());
    if(out.problem){
      if(out.unpriced&&out.unpriced.length) busyMessage('Bill '+b.billNumber+' needs prices','<p>Busy needs a price on every line. These items have no price:</p><p id="busy-unpriced"><b>'+out.unpriced.map(esc).join(', ')+'</b></p><p class="field-hint">Open the bill, press Edit, type the prices, save, then export again.</p>');
      else busyMessage('Bill '+b.billNumber+' cannot go to Busy','<p>'+esc(out.problem)+'</p>');
      return null;
    }
    downloadBytes(latin1Bytes(out.file.xml), out.file.name, 'application/xml');
    toast('Busy file downloaded: '+out.file.name);
    return out.file;
  }
  async function exportOneBill(id){ const b=(await all('bills')).find(v=>v.id===id); return exportBill(b); }
  async function exportBusySingle(){
    const inp=$('#busy-billno'), firm=$('#busy-firm'), typed=inp?inp.value.trim():'';
    if(!typed){toast('Type a bill number.',true);if(inp)inp.focus();return;}
    if(firm)busyFirm=firm.value;
    await saveBusy(true);
    const b=findBillByNo(await all('bills'), typed, busyFirm);
    const res=$('#busy-single-result');
    if(!b){ if(res)res.innerHTML='<p class="field-hint">No bill "'+esc(typed)+'" in '+esc(biz(busyFirm).name)+'.</p>'; toast('No bill '+typed+' in '+biz(busyFirm).name+'.',true); return; }
    const f=await exportBill(b);
    if(res)res.innerHTML=f?'<p class="field-hint" style="color:inherit"><b>'+esc(b.billNumber)+'</b> · ₹'+number(Math.round(f.voucher.total*100)/100)+' · '+esc(f.name)+'</p>':'';
  }
  async function render() {
    $('#page-crumb').textContent=names[page]; $$('.main-nav [data-page]').forEach(x=>x.classList.toggle('active',x.dataset.page===page)); $('#bill-nav-count').textContent=String((await all('bills')).length); all('supplyorders').then(rows=>{const c=$('#supply-nav-count');if(c)c.textContent=String(rows.length);});
    if(page==='dashboard')return renderDashboard(); if(page==='bills')return renderBills(); if(page==='catalog')return renderCatalog(); if(page==='supply')return renderSupply(); if(page==='analytics')return renderAnalytics(); if(page==='backup')return renderBackup(); if(page==='busy')return renderBusy();
  }
  function go(p){page=p;render().catch(e=>{console.error(e);toast('Could not load this page.',true);});}
  function billDialog(data, editMode) {
    Promise.all([all('products'),all('customers'),all('supplyorders')]).then(res=>{
      const soName=data.supplyOrderId?(((res[2]||[]).find(o=>o.id===data.supplyOrderId)||{}).ref||'Supply order'):'';
      const products=res[0].filter(x=>x.businessId===data.businessId), customers=res[1].filter(x=>x.businessId===data.businessId);const brandMap={};res[0].forEach(p=>{brandMap[String(p.name||'').trim().toLowerCase()]=p.brand||'';});
      const isSaved=!!data.billNumber, editing=isSaved&&!!editMode&&can('bill');
      const lockCore=isSaved, lockFields=isSaved&&!editing;
      const rows=data.items.map(i=>{const brv=i.brand!=null&&i.brand!==''?i.brand:(brandMap[String(i.productName||'').trim().toLowerCase()]||'');return itemRowHtml(i,lockFields,brv);}).join('');
      const total=data.items.reduce((s,i)=>s+(Number(i.price)>0?Number(i.price)*Number(i.quantity||0):0),0);
      $('#bill-dialog').innerHTML='<div class="modal-head"><div><div class="eyebrow">'+(editing?'EDIT RECORD':(isSaved?'DISPATCH RECORD':'NEW DISPATCH'))+'</div><h2>'+(isSaved?esc(data.billNumber):'Create a bill')+'</h2><p>'+esc(biz(data.businessId).name)+' · '+(isSaved?'FY '+esc(data.financialYear):'Number assigned when saved for FY '+fy(data.date))+'</p></div><button class="icon-button" data-action="close-dialog">✕</button></div>'+
       '<form id="bill-form" novalidate><input type="hidden" name="billId" value="'+(isSaved?esc(data.id):'')+'"><input type="hidden" name="soId" value="'+esc(data.supplyOrderId||'')+'"><div class="modal-body"><div class="form-grid"><div><label class="field-label">FORM</label><input type="hidden" id="bill-business" name="businessId" value="'+esc(data.businessId)+'"><div class="chip-row">'+BIZ.map(b=>'<button type="button" class="pick-chip'+(data.businessId===b.id?' active':'')+'" data-action="pick-business" data-id="'+b.id+'" '+(lockCore?'disabled':'')+'>'+esc(b.name)+'</button>').join('')+'</div></div><div><label class="field-label">BILL DATE</label><input id="bill-date" name="date" class="input" type="date" value="'+esc(data.date)+'" required '+(lockCore?'disabled':'')+'></div><div class="full"><label class="field-label">CUSTOMER / RECEIVER</label><input id="bill-customer" class="input" autocomplete="off" name="customerName" placeholder="Search or enter customer" value="'+esc(data.customerName)+'" required '+(lockFields?'readonly':'')+'></div>'+(editing?'<div class="full"><label class="field-label">BILL NO.</label><input id="bill-no" class="input" name="billNumber" value="'+esc(data.billNumber)+'" required></div>':'')+'</div>'+
       '<div class="items-toolbar"><strong>Products being dispatched</strong>'+(lockFields?'':'<button class="button button-light button-small" type="button" data-action="add-item">＋ Add line</button>')+'</div><div class="items-table bill-grid"><div class="items-table-head"><div>PRODUCT</div><div>BRAND</div><div>PRICE <span style="font-weight:400">(optional)</span></div><div>QUANTITY</div><div>UNIT</div><div></div></div><div id="bill-items">'+rows+'</div></div>'+
       (isSaved&&total>0?'<div class="modal-section total-line"><span>Amount total (priced lines)</span><b>₹'+number(Math.round(total*100)/100)+'</b></div>':'')+
       '<div class="modal-section"><label class="field-label">GST % <span style="font-weight:400;color:#9ca3af">(optional)</span></label><input id="bill-gst" class="input" type="number" min="0" max="28" step="0.01" value="'+(data.gst==null?'':data.gst)+'" placeholder="e.g. 5" '+(lockFields?'readonly':'')+'></div><div class="modal-section"><label class="field-label">NOTE <span style="font-weight:400;color:#9ca3af">(optional)</span></label><input id="bill-notes" class="input" value="'+esc(data.notes||'')+'" placeholder="Delivery or dispatch note" '+(lockFields?'readonly':'')+'></div><div class="modal-section"><label class="field-label">BILL PHOTO <span style="font-weight:400;color:#9ca3af">(optional)</span></label><div id="bill-photo-area" data-editable="'+(lockFields?'no':'yes')+'" data-bill-id="'+(isSaved?esc(data.id):'')+'"></div><input type="file" id="bill-photo-input" accept="image/*" hidden><input type="hidden" id="bill-photo-value" value="'+(data.photo||'')+'"></div>'+(isSaved&&data.supplyOrderId?'<div class="modal-section"><span class="field-label">SUPPLY ORDER</span> <button type="button" class="button button-light button-small" data-action="open-supply" data-id="'+esc(data.supplyOrderId)+'">'+esc(soName)+'</button></div>':'')+'<div class="modal-section helper-box">'+(isSaved?(editing?'Update the customer, items, note, or bill number. Date stays fixed.':'Saved dispatch record. Price is optional on each line.'):'Bill number is assigned on save. Price starts at 1 on each new line: type the real price over it. No GST. Keyboard: Enter goes to the next field; on the last line Enter adds one new line; Enter on an empty product line finishes items. Shift+Enter goes back, Ctrl+Enter saves, Ctrl+Delete removes a line. Press ? for all keys.')+'</div></div>'+
       '<div class="modal-foot">'+(isSaved&&!editing?'<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="button button-light" type="button" data-action="print-bill" data-id="'+esc(data.id)+'">⎙ Print</button>'+'<button class="button button-light" type="button" data-action="busy-one" data-id="'+esc(data.id)+'" title="Download this bill as one Busy .xml (Alt+B)">⇩ Export to Busy</button>'+(can('bill')?'<button class="button button-light" type="button" data-action="return-bill" data-id="'+esc(data.id)+'">↩ Return</button>':'')+'</div>':'<span class="field-hint">'+(editing?'Date stays fixed · bill number editable':'Product · price (optional) · quantity · unit')+'</span>')+'<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end"><button class="button button-light" type="button" data-action="close-dialog">Close</button>'+(editing?'<button class="button button-primary" type="submit">Save changes</button>':(!isSaved?'<button class="button button-primary" type="submit">Save record</button>':(can('bill')?'<button class="button button-primary" type="button" data-action="edit-bill" data-id="'+esc(data.id)+'">Edit</button>':'')))+(isSaved&&!editing&&can('delete')?'<button class="button button-danger" type="button" data-action="delete-bill" data-id="'+esc(data.id)+'">Delete</button>':'')+'</div></div></form>';
      renderPhotoArea(data.photo||'', !lockFields);
    }).catch(e=>{console.error(e);toast('Could not load your catalog.',true);});
  }
  function newBill(key) { const businessId=key||(form==='all'?'sampurn':form); billDialog({businessId,date:today(),customerName:'',items:[{productName:'',quantity:'',unit:''}],notes:''}); $('#bill-dialog').showModal(); }
  function recordDialog(kind, key, existing) {
    const product=kind==='products', bizId=key||(existing&&existing.businessId)||(form==='all'?'sampurn':form);
    $('#record-dialog').innerHTML='<div class="modal-head"><div><div class="eyebrow">FORM CATALOG</div><h2>'+(existing?'Edit ':'Add ')+(product?'product':'customer')+'</h2><p>'+(product?'Products are shared across all forms.':'This record belongs to the selected form only.')+'</p></div><button class="icon-button" data-action="close-dialog">✕</button></div><form id="record-form"><div class="modal-body"><div class="form-grid">'+(product?'<div class="full"><div class="helper-box">Products are shared across all forms. Add a product once and it is available in every form.</div><input type="hidden" name="businessId" value="'+esc(bizId)+'"></div>':'<div class="full"><label class="field-label">FORM</label><input type="hidden" name="businessId" value="'+esc(bizId)+'"><div class="chip-row">'+BIZ.map(b=>'<button type="button" class="pick-chip'+(b.id===bizId?' active':'')+'" data-action="pick-record-business" data-id="'+b.id+'">'+esc(b.name)+'</button>').join('')+'</div></div>')+'<div class="full"><label class="field-label">'+(product?'PRODUCT NAME':'CUSTOMER NAME')+'</label><input class="input" name="name" value="'+esc(existing&&existing.name||'')+'" required maxlength="100" placeholder="'+(product?'e.g. Basmati rice':'e.g. Sharma Stores')+'"></div>'+(product?'<div class="full"><label class="field-label">DEFAULT UNIT <span style="font-weight:400">(optional)</span></label><input class="input" name="unit" value="'+esc(existing&&existing.unit||'')+'" data-field="unit" autocomplete="off" placeholder="bag, kg, box"></div><div class="full"><label class="field-label">BRAND <span style="font-weight:400">(optional)</span></label><input class="input" name="brand" value="'+esc(existing&&existing.brand||'')+'" placeholder="e.g. Fortune"></div>':'<div class="full"><label class="field-label">CONTACT / NOTE <span style="font-weight:400">(optional)</span></label><input class="input" name="note" value="'+esc(existing&&existing.note||'')+'" placeholder="Phone or delivery note"></div>')+'</div></div><div class="modal-foot"><span></span><div style="display:flex;gap:8px"><button class="button button-light" type="button" data-action="close-dialog">Cancel</button><button class="button button-primary" type="submit">Save</button></div></div><input type="hidden" name="kind" value="'+kind+'"><input type="hidden" name="recordId" value="'+esc(existing&&existing.id||'')+'"></form>';
    $('#record-dialog').showModal();
  }
  function backupManifest(){ try{ return JSON.parse(localStorage.getItem('kiranaDeskBackupManifest')||'{}'); }catch(e){ return {}; } }
  function stampOf(r){ return String(r.updatedAt||r.createdAt||''); }
  async function unbackedCounts(){
    const stores=['bills','counters','products','customers','supplyorders'], m=backupManifest();
    const sets=await Promise.all(stores.map(s=>all(s)));
    const counts={}; let total=0;
    stores.forEach((s,i)=>{ const got=m[s]||{}; counts[s]=sets[i].filter(r=>got[String(r.id)]!==stampOf(r)); total+=counts[s].length; });
    return { counts:counts, total:total };
  }
  async function buildIncremental(reason){
    const c=await unbackedCounts();
    if(!c.total) return null;
    const counters=c.counts.bills.length?await all('counters'):[];
    const data={app:'Kirana Desk',schemaVersion:1,exportedAt:new Date().toISOString(),incremental:true,reason:reason||'manual',bills:c.counts.bills,counters:counters,products:c.counts.products,customers:c.counts.customers,supplyorders:c.counts.supplyorders};
    return { data:data, marks:{ bills:c.counts.bills, counters:counters, products:c.counts.products, customers:c.counts.customers, supplyorders:c.counts.supplyorders } };
  }
  function applyBackupMarks(marks){
    const m=backupManifest();
    Object.keys(marks).forEach(s=>{ m[s]=m[s]||{}; (marks[s]||[]).forEach(r=>{ m[s][String(r.id)]=stampOf(r); }); });
    localStorage.setItem('kiranaDeskBackupManifest',JSON.stringify(m));
    localStorage.setItem('kiranaDeskLastBackup',new Date().toISOString());
  }
  function backupStamp(){ const d=new Date(); return String(d.getHours()).padStart(2,'0')+String(d.getMinutes()).padStart(2,'0'); }
  async function backupIncremental(reason){
    const b=await buildIncremental(reason);
    if(!b){ toast('Everything is already backed up. No new records to save.'); return; }
    const url=URL.createObjectURL(new Blob([JSON.stringify(b.data,null,2)],{type:'application/json'})), a=document.createElement('a'); a.href=url; a.download='kirana-desk-backup-'+today()+'-'+backupStamp()+'.json'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
    applyBackupMarks(b.marks); toast('Backup downloaded with only the new records. Earlier files are untouched.');
    if(page==='backup')render();
  }
  function bkDlg(){ let d=$('#backup-dialog'); if(!d){ d=document.createElement('dialog'); d.id='backup-dialog'; d.className='modal'; document.body.append(d); } return d; }
  async function maybeBackupPrompt(){
    if(backupPromptShown||!can('backup'))return;
    let c; try{ c=await unbackedCounts(); }catch(e){ return; }
    if(!c.total)return;
    backupPromptShown=true;
    const bills=c.counts.bills.length, others=c.counts.products.length+c.counts.customers.length+c.counts.supplyorders.length;
    const line=(bills&&others)?bills+' bills and '+others+' catalog or supply entries':(bills?bills+(bills===1?' bill':' bills'):others+(others===1?' entry':' entries'));
    bkDlg().innerHTML='<div class="modal-head"><div><div class="eyebrow">DATA SAFETY</div><h2>Backup new records</h2><p>'+line+' on this computer are not in any backup file yet.</p></div><button class="icon-button" data-action="close-dialog">\u2715</button></div><div class="modal-body"><p style="line-height:1.6">The download carries only records not backed up before, and the file name includes the time, so an earlier backup file is never rewritten.</p></div><div class="modal-foot"><span></span><div style="display:flex;gap:8px"><button class="button button-light" type="button" data-action="close-dialog">Later</button><button class="button button-primary" type="button" data-action="quick-backup">\u2193 Backup now</button></div></div>';
    bkDlg().showModal();
  }
  async function backup() {
    const r=await Promise.all([all('bills'),all('counters'),all('products'),all('customers'),all('supplyorders')]), data={app:'Kirana Desk',schemaVersion:1,exportedAt:new Date().toISOString(),bills:r[0],counters:r[1],products:r[2],customers:r[3],supplyorders:r[4]};
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})), a=document.createElement('a'); a.href=url; a.download='kirana-desk-backup-'+today()+'-'+backupStamp()+'.json'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
    applyBackupMarks({ bills:r[0], counters:r[1], products:r[2], customers:r[3], supplyorders:r[4] });
    toast('Full backup downloaded. Save another copy on a separate device.'); if(page==='backup')render();
  }
  async function exportAnalytics() {
    const start=startDate(analyticsPeriod), bills=(await all('bills')).filter(b=>(form==='all'||b.businessId===form)&&new Date(b.date+'T12:00:00')>=start);
    const quote=value=>'"'+String(value==null?'':value).replace(/"/g,'""')+'"';
    const rows=[['Bill number','Financial year','Date','Form','Customer','Product','Price','Quantity','Unit','Amount','Note']];
    bills.forEach(b=>b.items.forEach(i=>rows.push([b.billNumber,b.financialYear,b.date,biz(b.businessId).name,b.customerName,i.productName,i.price==null?'':i.price,i.quantity,i.unit,i.price==null?'':Number(i.price)*Number(i.quantity||0),b.notes||''])));
    const csv='\uFEFF'+rows.map(row=>row.map(quote).join(',')).join('\r\n'), url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})), a=document.createElement('a');
    a.href=url;a.download='kirana-dispatch-report-'+today()+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    toast('CSV report downloaded. Open it in Excel or another spreadsheet app.');
  }
  async function restore(file) {
    const data=JSON.parse(await file.text());
    if(data.app!=='Kirana Desk'||data.schemaVersion!==1||!['bills','counters','products','customers'].every(k=>Array.isArray(data[k])))throw new Error('This is not a valid Kirana Desk backup.');
    const merge=!!data.incremental;
    if(merge){ if(!confirm('Add '+data.bills.length+' bills, '+data.products.length+' products, and '+data.customers.length+' customers from this backup? Existing records on this computer are kept.'))return; }
    else if(!confirm('Restore '+data.bills.length+' bills, '+data.products.length+' products, and '+data.customers.length+' customers? Current records on this computer will be replaced.'))return;
    await new Promise((resolve,reject)=>{const tx=db.transaction(['bills','counters','products','customers','supplyorders'],'readwrite');['bills','counters','products','customers','supplyorders'].forEach(k=>{const st=tx.objectStore(k);if(!merge)st.clear();(Array.isArray(data[k])?data[k]:[]).forEach(x=>st.put(x));});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});
    localStorage.setItem('kiranaDeskLastBackup',data.exportedAt||new Date().toISOString()); localStorage.setItem('kiranaDeskSampleSeeded','yes'); scheduleAutoBackup(); toast('Backup restored.'); render();
  }
  async function unifyProducts() {
    if(localStorage.getItem('kiranaDeskProductsUnified'))return;
    const rows=await all('products');const groups={};
    rows.forEach(pr=>{const k=String(pr.name||'').trim().toLowerCase();if(!k)return;(groups[k]=groups[k]||[]).push(pr);});
    for(const k in groups){const g=groups[k];if(g.length<2)continue;
      g.sort((a,b)=>(a.isSample?1:0)-(b.isSample?1:0)||String(a.createdAt||'').localeCompare(String(b.createdAt||'')));
      const keep=g[0];
      for(const d of g.slice(1)){if(!keep.unit&&d.unit)keep.unit=d.unit;if(!keep.brand&&d.brand)keep.brand=d.brand;await del('products',d.id);}
      keep.unit=keep.unit||'';keep.brand=keep.brand||'';await put('products',keep);
    }
    localStorage.setItem('kiranaDeskProductsUnified','yes');
  }
  async function seedSamples() {
    if(localStorage.getItem('kiranaDeskSampleSeeded'))return;
    const existing=await Promise.all([all('bills'),all('products'),all('customers')]);
    if(existing.some(records=>records.length)){localStorage.setItem('kiranaDeskSampleSeeded','yes');return;}
    const products={
      sampurn:[['Wheat Flour','kg'],['Rice','kg'],['Toor Dal','kg'],['Cooking Oil','litre']],
      surya:[['Basmati Rice','kg'],['Sugar','kg'],['Tea','kg'],['Detergent Powder','kg']],
      dhanraj:[['Maida','kg'],['Besan','kg'],['Poha','kg'],['Groundnut Oil','litre']]
    };
    const customers={
      sampurn:['Sharma General Store','Shree Ganesh Kirana','City Provision Store'],
      surya:['Mehta Super Mart','Patel Daily Needs','New Market Stores'],
      dhanraj:['Jain Food Corner','Khandelwal Kirana','Maa Ambe Stores']
    }, createdAt=new Date().toISOString(), writes=[];
    Object.entries(products).forEach(([businessId,items])=>items.forEach(([name,unit])=>writes.push(put('products',{id:uid(),businessId,name,unit,createdAt,isSample:true}))));
    Object.entries(customers).forEach(([businessId,items])=>items.forEach(name=>writes.push(put('customers',{id:uid(),businessId,name,note:'',createdAt,isSample:true}))));
    await Promise.all(writes);localStorage.setItem('kiranaDeskSampleSeeded','yes');
  }
  async function replaceLocal(store, records) {
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(store,'readwrite'), objectStore=tx.objectStore(store);
      objectStore.clear();records.forEach(record=>objectStore.put(record));
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
    });
  }
  async function reconcileCloud() {
    const stores=['bills','counters','products','customers','supplyorders'];
    const local=await Promise.all(stores.map(localAll)), remote=await Promise.all(stores.map(window.KiranaCloud.list));
    const localCount=local.reduce((sum,rows)=>sum+rows.length,0), remoteCount=remote.reduce((sum,rows)=>sum+rows.length,0);
    if(remoteCount===0&&localCount>0){
      stores.forEach((store,index)=>local[index].forEach(record=>window.KiranaCloud.write(store,record).catch(console.warn)));
      return;
    }
    await Promise.all(stores.map((store,index)=>replaceLocal(store,remote[index])));
  }
  function retDlg() { let d = $('#return-dialog'); if (!d) { d = document.createElement('dialog'); d.id = 'return-dialog'; d.className = 'modal'; document.body.append(d); } return d; }
  function returnDialog(b) {
    const bb = biz(b.businessId);
    const gotBack = {};
    (b.returns || []).forEach(r => r.items.forEach(i => { gotBack[i.productName] = (gotBack[i.productName] || 0) + (Number(i.qty) || 0); }));
    const rows = b.items.map((i, n) => '<div class="item-row"><input class="input" value="' + esc(i.productName) + '" readonly><input class="input" value="' + esc(i.quantity) + '" readonly><input class="input" value="' + (gotBack[i.productName] || 0) + '" readonly><input class="input" type="number" min="0" step="any" id="ret-' + n + '" placeholder="0"><input class="input" value="' + esc(i.unit || '') + '" readonly></div>').join('');
    const past = (b.returns || []).length ? '<div class="items-toolbar"><strong>Past returns</strong></div><div style="margin-top:8px">' + (b.returns || []).map(r => '<div class="total-line" style="margin-bottom:7px"><span style="font-size:10px">' + dateLabel(r.date) + ' · ' + r.items.map(i => esc(i.productName) + ' ' + i.qty + (i.unit ? ' ' + esc(i.unit) : '')).join(', ') + '</span><button class="button button-danger button-small" type="button" data-action="delete-return" data-id="' + esc(b.id) + '" data-rid="' + esc(r.id) + '">Delete</button></div>').join('') + '</div>' : '';
    retDlg().innerHTML = '<div class="modal-head"><div><div class="eyebrow">SALE RETURN</div><h2>Record return · ' + esc(b.billNumber) + '</h2><p>' + esc(bb.name) + ' · ' + esc(b.customerName) + '</p></div><button class="icon-button" data-action="close-dialog">✕</button></div><div class="modal-body"><div class="form-grid"><div class="full"><label class="field-label">RETURN DATE</label><input id="return-date" class="input" type="date" value="' + today() + '"></div></div><div class="items-toolbar"><strong>Items in this bill</strong></div><div class="items-table"><div class="items-table-head"><div>PRODUCT</div><div>SOLD QTY</div><div>ALREADY RETURNED</div><div>RETURN NOW</div><div>UNIT</div></div>' + rows + '</div>' + past + '<div class="modal-section helper-box">Enter how much of each item came back. Leave blank or 0 for items that did not return. Amount stays empty for lines that had no price in the bill.</div></div><div class="modal-foot"><span></span><div style="display:flex;gap:8px"><button class="button button-light" type="button" data-action="close-dialog">Cancel</button><button class="button button-primary" type="button" data-action="save-return" data-id="' + esc(b.id) + '">Save return</button></div></div>';
  }

  function soDlg() { let d = $('#supply-dialog'); if (!d) { d = document.createElement('dialog'); d.id = 'supply-dialog'; d.className = 'modal'; document.body.append(d); } return d; }
  function showSo() { const d = soDlg(); if (!d.open) d.showModal(); }
  function readPdf(file) { return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(new Error('bad file')); r.readAsDataURL(file); }); }
  let soCurrentFile = '';
  function renderSoFileArea(area, val, type, editable) {
    if (!area) return;
    area.innerHTML = val
      ? (editable
        ? '<div class="photo-chip">' + (type === 'pdf' ? '<span class="pdf-chip">PDF attached</span>' : '<img src="' + val + '" alt="">') + '<button type="button" class="icon-button" data-action="remove-so-file" title="Remove">✕</button><label class="button button-light button-small" for="so-file-input">Replace</label></div>'
        : (type === 'pdf' ? '<button type="button" class="button button-light button-small" data-action="open-so-pdf">Open order PDF</button>' : '<img class="so-preview" src="' + val + '" data-action="open-so-photo" alt="Supply order">'))
      : (editable ? '<label class="button button-light button-small" for="so-file-input">＋ Attach order (image or PDF)</label>' : '<span class="field-hint">No file attached</span>');
  }
  function soSummary(b) {
    const q = b.items.reduce((s, i) => s + Number(i.quantity || 0), 0);
    const priced = b.items.some(i => i.price != null);
    const amount = priced ? b.items.reduce((s, i) => s + (i.price == null ? 0 : Number(i.price) * Number(i.quantity || 0)), 0) : null;
    return { q: q, amount: amount };
  }
  async function renderSupply() {
    const results = await Promise.all([all('supplyorders'), all('bills')]), orders = results[0], bills = results[1];
    const c = $('#supply-nav-count'); if (c) c.textContent = String(orders.length);
    const rows = orders.filter(o => form === 'all' || o.businessId === form).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    const table = rows.length ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>REFERENCE</th><th>CUSTOMER</th><th>DATE</th><th>BILLS LINKED</th><th>FILE</th><th></th></tr></thead><tbody>' + rows.map(o => {
      const linked = bills.filter(b => b.supplyOrderId === o.id);
      return '<tr><td class="strong-cell">' + esc(o.ref || '(no reference)') + '</td><td>' + esc(o.customerName || '') + '</td><td class="muted-cell">' + dateLabel(o.date) + '</td><td>' + String(linked.length) + '</td><td>' + (o.fileType === 'pdf' ? 'PDF' : 'Photo') + '</td><td><button class="icon-button" data-action="open-supply" data-id="' + esc(o.id) + '" title="Open supply order">↗</button></td></tr>';
    }).join('') + '</tbody></table></div>' : empty('No supply orders yet', 'Add a customer supply order as an image or PDF, then pick the dispatch bills it covers.');
    $('#page-content').innerHTML = head('SUPPLY ORDERS', 'Supply orders', 'One customer order, dispatched across several bills. Attach the order file and link every bill raised against it.', '<div class="head-actions">' + (can('bill') ? '<button class="button button-primary" data-action="add-supply">＋ Add supply order</button>' : '') + '</div>') + tabs() + table;
  }
  function supplyDialog(data, editMode) {
    Promise.all([all('bills'), all('supplyorders')]).then(res => {
      const bills = res[0], isSaved = !!data.createdAt, editing = isSaved && !!editMode && can('bill');
      const viewMode = isSaved && !editing;
      const linked = bills.filter(b => b.supplyOrderId === data.id);
      soCurrentFile = data.file || '';
      let body = '', foot = '';
      if (viewMode) {
        const ordered = linked.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
        const linkedRows = ordered.length ? ordered.map(b => {
          const s = soSummary(b);
          return '<tr><td class="strong-cell">' + esc(b.billNumber) + '</td><td class="muted-cell">' + dateLabel(b.date) + '</td><td>' + esc(biz(b.businessId).prefix) + '</td><td>' + b.items.length + '</td><td>' + number(s.q) + '</td><td>' + (s.amount == null ? '—' : number(s.amount)) + '</td><td class="row-actions" style="white-space:nowrap"><button class="icon-button" data-action="view-bill" data-id="' + esc(b.id) + '" title="View record">↗</button><button class="icon-button" data-action="busy-one" data-id="' + esc(b.id) + '" tabindex="-1" title="Export this bill to Busy (.xml) · Alt+B on a selected row">⇩</button></td></tr>';
        }).join('') : '<tr><td colspan="7" class="muted-cell">No bills linked yet. Use "Link bills / edit".</td></tr>';
        body = '<div class="modal-body">' +
          '<div class="form-grid"><div><label class="field-label">CUSTOMER</label><div class="input">' + esc(data.customerName || '—') + '</div></div><div><label class="field-label">ORDER DATE</label><div class="input">' + dateLabel(data.date) + '</div></div><div class="full"><label class="field-label">NOTES</label><div class="input">' + esc(data.notes || '—') + '</div></div></div>' +
          '<div class="modal-section"><label class="field-label">ORDER FILE</label><div id="so-file-area"></div></div>' +
          '<div class="items-toolbar"><strong>Bills linked to this order (' + linked.length + ')</strong></div>' +
          '<div class="table-wrap"><table class="data-table"><thead><tr><th>BILL NO.</th><th>DATE</th><th>FORM</th><th>ITEMS</th><th>QTY</th><th>AMOUNT</th><th></th></tr></thead><tbody>' + linkedRows + '</tbody></table></div>' +
          '<div class="modal-section helper-box">Every bill raised against this order shows here with its quantities. Link more bills any time.</div></div>';
        foot = '<div class="modal-foot"><span></span><div style="display:flex;gap:8px">' + (can('bill') ? '<button class="button button-light" type="button" data-action="edit-supply" data-id="' + esc(data.id) + '">Link bills / edit</button>' : '') + (can('delete') ? '<button class="button button-danger" type="button" data-action="delete-supply" data-id="' + esc(data.id) + '">Delete</button>' : '') + '<button class="button button-primary" type="button" data-action="close-dialog">Close</button></div></div>';
      } else {
        const pickRows = bills.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, 80).map(b => {
          const s = soSummary(b);
          return '<label class="so-pick-row" style="display:flex;gap:10px;align-items:center;padding:8px 10px;border-bottom:1px solid #f1f5f9;cursor:pointer"><input type="checkbox" class="so-pick" value="' + esc(b.id) + '"' + (data.id && b.supplyOrderId === data.id ? ' checked' : '') + '><span style="display:flex;flex-direction:column;gap:2px"><strong>' + esc(b.billNumber) + '</strong><span class="muted-cell">' + dateLabel(b.date) + ' · ' + esc(b.customerName) + ' · ' + b.items.length + ' items · ' + number(s.q) + ' qty</span></span></label>';
        }).join('');
        body = '<div class="modal-body"><form id="supply-form">' +
          '<input type="hidden" id="so-id" value="' + esc(data.id || '') + '">' +
          '<input type="hidden" id="so-business" value="' + esc(data.businessId || (form === 'all' ? 'sampurn' : form)) + '">' +
          '<div class="form-grid"><div><label class="field-label">REFERENCE <span style="font-weight:400;color:#9ca3af">(optional)</span></label><input id="so-ref" class="input" value="' + esc(data.ref || '') + '" placeholder="e.g. PO number or customer order no."></div><div><label class="field-label">ORDER DATE</label><input id="so-date" class="input" type="date" value="' + esc(data.date || today()) + '"></div><div class="full"><label class="field-label">CUSTOMER</label><input id="so-customer" class="input" autocomplete="off" value="' + esc(data.customerName || '') + '" placeholder="Search or enter customer"></div><div class="full"><label class="field-label">NOTES <span style="font-weight:400;color:#9ca3af">(optional)</span></label><input id="so-notes" class="input" value="' + esc(data.notes || '') + '" placeholder="What this order covers"></div></div>' +
          '<div class="modal-section"><label class="field-label">ORDER FILE</label><div id="so-file-area"></div><input type="file" id="so-file-input" accept="image/*,application/pdf" hidden><input type="hidden" id="so-file-value" value="' + esc(data.file || '') + '"><input type="hidden" id="so-file-type" value="' + esc(data.fileType || '') + '"></div>' +
          '<div class="items-toolbar"><strong>Link dispatch bills</strong><span class="field-hint">Newest 80 bills shown</span></div>' +
          '<div class="modal-section" style="padding:0"><input id="so-search" class="input" placeholder="Filter by bill number or customer"></div>' +
          '<div id="so-pick-list" style="max-height:220px;overflow:auto;border:1.5px solid #111;border-radius:10px">' + pickRows + '</div>' +
          '<div class="modal-section helper-box">' + (isSaved ? 'Tick the bills this order covers, then save. New bills can be linked any time.' : 'Tick every bill raised against this order. You can add more later.') + '</div></form></div>';
        foot = '<div class="modal-foot"><span></span><div style="display:flex;gap:8px">' + (isSaved ? '<button class="button button-light" type="button" data-action="view-supply" data-id="' + esc(data.id) + '">← Back</button>' : '') + '<button class="button button-light" type="button" data-action="close-dialog">Cancel</button><button class="button button-primary" type="button" data-action="save-supply">Save supply order</button></div></div>';
      }
      soDlg().innerHTML = '<div class="modal-head"><div><div class="eyebrow">SUPPLY ORDER</div><h2>' + (viewMode ? esc(data.ref || 'Supply order') : (isSaved ? 'Edit supply order' : 'New supply order')) + '</h2><p>' + esc(data.customerName || (viewMode ? 'Order from the customer' : 'Attach the order and pick the bills it covers')) + '</p></div><button class="icon-button" data-action="close-dialog">✕</button></div>' + body + foot;
      renderSoFileArea($('#so-file-area'), data.file || '', data.fileType || '', !viewMode);
      showSo();
    });
  }
  function filterSoPick(){const q=($('#so-search')?$('#so-search').value:'').trim().toLowerCase();$$('.so-pick-row').forEach(r=>{r.style.display=!q||r.textContent.toLowerCase().includes(q)?'':'none';});}
  document.addEventListener('input',e=>{if(e.target&&e.target.id==='so-search')filterSoPick();});
  function buildReturnRows() {
    const from = $('#rep-from') ? ($('#rep-from').value || '0000-01-01') : '0000-01-01';
    const to = $('#rep-to') ? ($('#rep-to').value || '9999-12-31') : '9999-12-31';
    const cust = $('#rep-customer') ? $('#rep-customer').value : '';
    return all('bills').then(bills => {
      const rows = [];
      bills.filter(b => cust ? b.customerName === cust : (form === 'all' || b.businessId === form)).forEach(b => {
        if (b.date >= from && b.date <= to) b.items.forEach(i => { rows.push({ date: b.date, type: 'Sale', vch: b.billNumber, id: b.id, name: i.productName, unit: i.unit || '', out: Number(i.quantity) || 0, inn: null, amt: Number(i.price) > 0 ? Number(i.price) * Number(i.quantity || 0) : null }); });
        (b.returns || []).forEach(r => { if ((!cust || b.customerName === cust) && r.date >= from && r.date <= to) r.items.forEach(i => { rows.push({ date: r.date, type: 'Sl. Rt', vch: b.billNumber, id: b.id, name: i.productName, unit: i.unit || '', out: null, inn: Number(i.qty) || 0, amt: i.price != null && Number(i.price) > 0 ? Number(i.price) * Number(i.qty || 0) : null }); }); });
      });
      rows.sort((a, b2) => a.date.localeCompare(b2.date) || a.type.localeCompare(b2.type));
      return rows;
    });
  }
  function returnsReportDialog(preset) {
    const y = new Date(); const fyStart = (y.getMonth() < 3 ? y.getFullYear() - 1 : y.getFullYear()) + '-04-01';
    Promise.all([all('bills'), all('customers')]).then(r => {
      const bills = r[0];
      const names = Array.from(new Set(bills.map(b => b.customerName).filter(Boolean).concat(r[1].map(c => c.name)))).sort();
      retDlg().innerHTML = '<div class="modal-head"><div><div class="eyebrow">REPORT</div><h2>In / Out register</h2><p>What went out and what came back, with bill numbers</p></div><button class="icon-button" data-action="close-dialog">✕</button></div><div class="modal-body"><div class="form-grid"><div><label class="field-label">FROM</label><input id="rep-from" class="input" type="date" value="' + fyStart + '"></div><div><label class="field-label">TO</label><input id="rep-to" class="input" type="date" value="' + today() + '"></div><div class="full"><label class="field-label">CUSTOMER</label><select id="rep-customer" class="select"><option value="">All customers</option>' + names.map(n => '<option' + (preset === n ? ' selected' : '') + '>' + esc(n) + '</option>').join('') + '</select></div></div><div id="rep-out" style="margin-top:14px"><p class="field-hint">Set the duration and customer, then Generate. Bill numbers in the list open that bill.</p></div></div><div class="modal-foot"><button class="button button-light" type="button" data-action="print-return-report">⎙ Print</button><div style="display:flex;gap:8px"><button class="button button-light" type="button" data-action="close-dialog">Close</button><button class="button button-primary" type="button" data-action="generate-return-report">Generate</button></div></div>';
    if (!retDlg().open) retDlg().showModal();
    });
  }
  function renderReturnReport() {
    buildReturnRows().then(rows => {
      const money = v => new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v) || 0);
      const totOut = rows.reduce((s, r) => s + (r.out || 0), 0), totIn = rows.reduce((s, r) => s + (r.inn || 0), 0), totAmt = rows.reduce((s, r) => s + (r.amt || 0), 0);
      const body = rows.length ? rows.map(r => '<tr><td>' + dateLabel(r.date) + '</td><td>' + r.type + '</td><td><button class="tag gray" style="cursor:pointer;border:0" data-action="open-bill-report" data-id="' + esc(r.id) + '">' + esc(r.vch) + '</button></td><td>' + esc(r.name) + (r.unit ? ' <span class="muted-cell">(' + esc(r.unit) + ')</span>' : '') + '</td><td>' + (r.out != null ? r.out : '') + '</td><td>' + (r.inn != null ? r.inn : '') + '</td><td>' + (r.amt != null ? money(r.amt) : '') + '</td></tr>').join('') : '<tr><td colspan="7" class="empty-inline">No entries in this duration.</td></tr>';
      $('#rep-out').innerHTML = '<div class="table-wrap"><table class="data-table"><thead><tr><th>DATE</th><th>TYPE</th><th>VCH NO.</th><th>PARTICULARS</th><th>QTY OUT</th><th>QTY IN</th><th>AMOUNT(\u20B9)</th></tr></thead><tbody>' + body + '<tr><td colspan="4" class="strong-cell">Total</td><td class="strong-cell">' + totOut + '</td><td class="strong-cell">' + totIn + '</td><td class="strong-cell">' + money(totAmt) + '</td></tr></tbody></table></div>';
    });
  }
  function printReturnReport() {
    buildReturnRows().then(rows => {
      const from = $('#rep-from').value, to = $('#rep-to').value, cust = $('#rep-customer').value;
      const bb = biz(form === 'all' ? 'sampurn' : form);
      const money = v => new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v) || 0);
      const dmy = s => { const d = new Date(s + 'T00:00:00'); return isNaN(d) ? esc(s || '') : String(d.getDate()).padStart(2, '0') + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + d.getFullYear(); };
      const totOut = rows.reduce((s, r) => s + (r.out || 0), 0), totIn = rows.reduce((s, r) => s + (r.inn || 0), 0), totAmt = rows.reduce((s, r) => s + (r.amt || 0), 0);
      const body = rows.length ? rows.map(r => '<tr><td>' + dmy(r.date) + '</td><td>' + r.type + '</td><td>' + esc(r.vch) + '</td><td>' + esc(r.name) + (r.unit ? ' (' + esc(r.unit) + ')' : '') + '</td><td class="r">' + (r.out != null ? r.out : '') + '</td><td class="r">' + (r.inn != null ? r.inn : '') + '</td><td class="r">' + (r.amt != null ? money(r.amt) : '') + '</td></tr>').join('') : '<tr><td colspan="7" class="c">No entries in this duration.</td></tr>';
      const html = '<!doctype html><html><head><meta charset="utf-8"><title>Return register</title><style>body{font:12px/1.45 Arial,Helvetica,sans-serif;color:#000;margin:10px}.frame{border:1.5px solid #000}.sec{border-bottom:1.5px solid #000}.invhead{padding:8px 10px 9px;position:relative;text-align:center}.gstin{position:absolute;left:10px;top:8px;font-weight:bold;font-size:11px}.titleline{display:inline-block;font-size:13px;font-weight:bold;letter-spacing:1px;border-bottom:1px dashed #000;padding-bottom:2px;margin-bottom:2px}.firm{font-size:21px;font-weight:bold;letter-spacing:.5px}.firmaddr{font-size:11px}.partyrow{width:100%;border-collapse:collapse}.partyrow td{padding:6px 10px;vertical-align:top;font-size:12px}.partyrow td.left{width:52%;border-right:1.5px solid #000}.pline{margin:2px 0}table.items{width:100%;border-collapse:collapse}table.items th,table.items td{border:1px solid #000;padding:4px 8px;font-size:12px;text-align:left;vertical-align:top}table.items th{font-weight:bold}.c{text-align:center}.r{text-align:right;white-space:nowrap}.tot td{font-weight:bold;border-top:1.5px solid #000}@page{margin:10mm}</style></head><body><div class="frame"><div class="sec invhead"><div class="gstin">GSTIN : ' + (bb.gstin ? '<b>' + esc(bb.gstin) + '</b>' : '') + '</div><div class="titleline">RETURN REGISTER</div><div class="firm">' + esc(bb.name) + '</div>' + (bb.addr ? '<div class="firmaddr">' + esc(bb.addr) + '</div>' : '') + '</div><table class="sec partyrow"><tr><td class="left"><div class="pline">Account : <b>' + esc(cust || 'All customers') + '</b></div></td><td><div class="pline">From : <b>' + dmy(from) + '</b> &nbsp;&nbsp; To : <b>' + dmy(to) + '</b></div></td></tr></table><table class="items"><thead><tr><th style="width:12%">Date</th><th style="width:9%">Type</th><th style="width:16%">Vch No.</th><th style="width:35%">Particulars</th><th style="width:9%">Qty Out</th><th style="width:9%">Qty In</th><th style="width:10%">Amount(' + '\u20B9' + ')</th></tr></thead><tbody>' + body + '<tr class="tot"><td colspan="4">Grand Total</td><td class="r">' + totOut + '</td><td class="r">' + totIn + '</td><td class="r">' + money(totAmt) + '</td></tr></tbody></table></div></body></html>';
      const frame = document.createElement('iframe');
      frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
      document.body.append(frame);
      frame.srcdoc = html;
      frame.onload = () => { const w = frame.contentWindow; setTimeout(() => { try { if (!w.print) throw 0; w.focus(); w.print(); } catch (e) { const n = window.open('', '_blank'); if (n) { n.document.write(html); n.document.close(); } } setTimeout(() => frame.remove(), 60000); }, 250); };
    });
  }
  function printChoice(b) {
    $('#bill-dialog').innerHTML = '<div class="modal-head"><div><div class="eyebrow">PRINT</div><h2>Bill ' + esc(b.billNumber) + '</h2><p>This bill has prices. Print with price or without?</p></div><button class="icon-button" data-action="close-dialog">✕</button></div><div class="modal-body"><div style="display:flex;flex-direction:column;gap:10px"><button class="button button-primary" type="button" data-action="print-priced" data-id="' + esc(b.id) + '">With price</button><button class="button button-light" type="button" data-action="print-unpriced" data-id="' + esc(b.id) + '">Without price</button></div></div>';
  }
  function words(n) {
    const a = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'], b = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
    const two = x => x < 20 ? a[x] : (b[Math.floor(x / 10)] + (x % 10 ? ' ' + a[x % 10] : ''));
    const three = x => (x > 99 ? a[Math.floor(x / 100)] + ' Hundred' + (x % 100 ? ' ' : '') : '') + (x % 100 ? two(x % 100) : '');
    if (!n) return 'Zero';
    let out = ''; const cr = Math.floor(n / 1e7), l = Math.floor(n % 1e7 / 1e5), t = Math.floor(n % 1e5 / 1e3), h = n % 1e3;
    if (cr) out += three(cr) + ' Crore '; if (l) out += three(l) + ' Lakh '; if (t) out += three(t) + ' Thousand '; if (h) out += three(h);
    return out.trim();
  }
  function printBill(b, withPrice) {
    const bb = biz(b.businessId);
    all('products').then(products => {
      const brandMap = {};
      products.forEach(p => { brandMap[String(p.name || '').trim().toLowerCase()] = p.brand || ''; });
      const brandOf = i => brandMap[String(i.productName || '').trim().toLowerCase()] || '';
      const money = v => new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v) || 0);
      const anyPrice = b.items.some(i => Number(i.price) > 0);
      const showPrice = !!withPrice && anyPrice;
      const gstRate = Number(b.gst) > 0 ? Number(b.gst) : 0;
      const total = b.items.reduce((s, i) => s + (Number(i.price) > 0 ? Number(i.price) * Number(i.quantity || 0) : 0), 0);
      const totalQty = b.items.reduce((s, i) => s + (Number(i.quantity) || 0), 0);
      const unitSet = Array.from(new Set(b.items.map(i => String(i.unit || '').trim()).filter(Boolean)));
      const unitAll = unitSet.length === 1 ? unitSet[0] : '';
      const q2 = v => Number(v || 0).toFixed(2);
      const dmy = s => { const d = new Date(s + 'T00:00:00'); return isNaN(d) ? esc(s || '') : String(d.getDate()).padStart(2, '0') + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + d.getFullYear(); };
      const rows = b.items.map((i, n) => { const br = (i.brand!=null&&i.brand!==''?i.brand:brandOf(i)); return '<tr><td class="c">' + (n + 1) + '.</td><td>' + esc(i.productName) + (br ? '<div class="bname">' + esc(br) + '</div>' : '') + '</td>' + (showPrice ? '<td></td>' : '') + '<td class="r">' + q2(i.quantity) + '</td><td>' + esc(i.unit || '') + '</td>' + (showPrice ? '<td class="r">' + (Number(i.price) > 0 ? money(i.price) : '') + '</td><td class="r">' + (Number(i.price) > 0 ? money(Number(i.price) * Number(i.quantity || 0)) : '') + '</td>' : '') + '</tr>'; }).join('');
      const taxable = total / (1 + gstRate / 100), taxAmt = total - taxable, half = taxAmt / 2;
      const rup = Math.floor(total + 0.005), paise = Math.round(((total + 0.005) - rup) * 100);
      const html = '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(b.billNumber) + '</title><style>body{font:12px/1.45 Arial,Helvetica,sans-serif;color:#000;margin:10px}.frame{border:1.5px solid #000}.sec{border-bottom:1.5px solid #000}.invhead{padding:8px 10px 9px;position:relative;text-align:center}.gstin{position:absolute;left:10px;top:8px;font-weight:bold;font-size:11px}.titleline{display:inline-block;font-size:13px;font-weight:bold;letter-spacing:1px;border-bottom:1px dashed #000;padding-bottom:2px;margin-bottom:2px}.firm{font-size:21px;font-weight:bold;letter-spacing:.5px}.firmaddr{font-size:11px}.partyrow{width:100%;border-collapse:collapse}.partyrow td{padding:6px 10px;vertical-align:top;font-size:12px}.partyrow td.left{width:52%;border-right:1.5px solid #000}.plabel{font-weight:bold;font-style:italic;margin-bottom:2px}.pline{margin:2px 0}table.items{width:100%;border-collapse:collapse}table.items th,table.items td{border:1px solid #000;padding:4px 8px;font-size:12px;text-align:left;vertical-align:top}table.items th{font-weight:bold}.c{text-align:center}.r{text-align:right;white-space:nowrap}.bname{font-weight:bold;font-style:italic;font-size:10.5px;color:#222}.tot td{font-weight:bold;border-top:1.5px solid #000}.taxstrip{width:100%;border-collapse:collapse;margin:6px 0 2px}.taxstrip th{font-size:11px;font-weight:bold;border-bottom:1px solid #000;padding:2px 8px 1px;text-align:left}.taxstrip td{font-size:11px;padding:1px 8px}.words{font-size:12.5px;font-weight:bold;padding:6px 2px}.bankrow{width:100%;border-collapse:collapse}.bankrow td{padding:6px 10px;font-size:12px}.footrow{width:100%;border-collapse:collapse}.footrow td{padding:6px 10px;vertical-align:top;font-size:11px}.footrow td.tl{width:52%;border-right:1.5px solid #000}.sigline{font-size:12px}.sigfirm{text-align:right;margin-top:26px;font-size:12px}.sigauth{text-align:right;margin-top:14px;font-size:12px}@page{margin:10mm}</style></head><body>'
        + '<div class="frame">'
        + '<div class="sec invhead"><div class="gstin">GSTIN : ' + (bb.gstin ? '<b>' + esc(bb.gstin) + '</b>' : '________________') + '</div><div class="titleline">DELIVERY CHALLAN / ESTIMATION</div><div class="firm">' + esc(bb.name) + '</div>' + (bb.addr ? '<div class="firmaddr">' + esc(bb.addr) + '</div>' : '') + '</div>'
        + '<table class="sec partyrow"><tr><td class="left"><div class="plabel">Party Details :</div><div class="pline"><b>' + esc(b.customerName) + '</b></div><div class="pline">Address : ______________________________________</div><div class="pline">Mobile No. : ____________________</div></td><td><div class="pline">DC No. : <b>' + esc(b.billNumber) + '</b></div><div class="pline">Dated : <b>' + dmy(b.date) + '</b></div></td></tr></table>'
        + '<table class="sec items"><thead><tr><th style="width:6%">S.N.</th><th style="width:' + (showPrice ? '37' : '64') + '%">Description of Goods</th>' + (showPrice ? '<th style="width:12%">HSN/SAC Code</th>' : '') + '<th style="width:11%">Qty.</th><th style="width:11%">Unit</th>' + (showPrice ? '<th style="width:11%">Price</th><th style="width:12%">Amount(' + '\u20B9' + ')</th>' : '') + '</tr></thead><tbody>' + rows + (showPrice ? '<tr class="tot"><td colspan="3" class="c">Grand Total</td><td class="r">' + q2(totalQty) + '</td><td>' + esc(unitAll) + '</td><td class="c">' + '\u20B9' + '</td><td class="r">' + money(total) + '</td></tr>' : '') + '</tbody></table>'
        + (showPrice && gstRate > 0 ? '<table class="taxstrip"><tr><th>Tax Rate</th><th>Taxable Amt.</th><th>CGST Amt.</th><th>SGST Amt.</th><th>Total Tax</th></tr><tr><td>' + gstRate + '%</td><td class="r">' + money(taxable) + '</td><td class="r">' + money(half) + '</td><td class="r">' + money(half) + '</td><td class="r">' + money(taxAmt) + '</td></tr></table>' : '')
        + (showPrice ? '<div class="words">Rupees ' + words(rup) + (paise ? ' and ' + words(paise) + ' Paise' : '') + ' Only</div>' : '')
        + (showPrice && bb.bank1 ? '<table class="sec bankrow"><tr><td><b>Bank Details :</b> &nbsp;' + esc(bb.bank1) + (bb.bank2 ? '<div style="padding-left:117px">' + esc(bb.bank2) + '</div>' : '') + '</td></tr></table>' : '')
        + '<table class="footrow"><tr><td class="tl"><b><u>Terms &amp; Conditions</u></b>' + (showPrice ? '<br>E.&amp; O.E.' : '') + '<br>1. Kindly check item from challan.<br>2. Cash Transaction only. If credit, payment should be made within 7 days from the bill date.<br>3. Goods once sold will not be taken back.<br>4. Subject to \'Mandsaur\' Jurisdiction.</td><td><div class="sigline">Receiver&#8217;s Signature :</div><div class="sigfirm">for <b>' + esc(bb.name) + '</b></div><div class="sigauth"><b>Authorised Signatory</b></div></td></tr></table>'
        + '</div></body></html>';
      const frame = document.createElement('iframe');
      frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
      document.body.append(frame);
      frame.srcdoc = html;
      frame.onload = () => { const w = frame.contentWindow; setTimeout(() => { try { if (!w.print) throw 0; w.focus(); w.print(); } catch (e) { const n = window.open('', '_blank'); if (n) { n.document.write(html); n.document.close(); } } setTimeout(() => frame.remove(), 60000); }, 250); };
    });
  }
  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => {
        try {
          const max = 1400; let w = img.width, h = img.height;
          if (w > max || h > max) { const k = Math.min(max / w, max / h); w = Math.round(w * k); h = Math.round(h * k); }
          const c = document.createElement('canvas'); c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          let q = 0.72, out = c.toDataURL('image/jpeg', q);
          while (out.length > 190000 && q > 0.35) { q -= 0.07; out = c.toDataURL('image/jpeg', q); }
          URL.revokeObjectURL(url); resolve(out);
        } catch (err) { URL.revokeObjectURL(url); reject(err); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
      img.src = url;
    });
  }
  function renderPhotoArea(photo, editable) {
    const area = $('#bill-photo-area'); if (!area) return;
    area.innerHTML = photo
      ? (editable
        ? '<div class="photo-chip"><img src="' + photo + '" alt=""><button type="button" class="icon-button" data-action="remove-photo" title="Remove">✕</button><label class="button button-light button-small" for="bill-photo-input">Replace</label></div>'
        : '<img class="photo-thumb" src="' + photo + '" data-action="view-photo" data-id="' + esc(area.dataset.billId || '') + '" alt="Bill photo">')
      : (editable
        ? '<label class="button button-light button-small" for="bill-photo-input">＋ Attach photo</label>'
        : '<span class="field-hint">No photo attached</span>');
  }
  function photoView(src, id) {
    $('#bill-dialog').innerHTML = '<div class="modal-head"><div><div class="eyebrow">ATTACHMENT</div><h2>Bill photo</h2></div><button class="icon-button" data-action="close-dialog">✕</button></div><div class="modal-body"><div class="photo-view"><img src="' + src + '" alt="Bill photo"></div></div><div class="modal-foot"><span></span><div style="display:flex;gap:8px">' + (id ? '<button class="button button-light" type="button" data-action="back-to-bill" data-id="' + esc(id) + '">← Back</button>' : '') + '<button class="button button-primary" type="button" data-action="close-dialog">Close</button></div></div>';
  }
  let sugBox=null, sugItems=[], sugIdx=-1, sugInput=null;
  function closeSug(){ if(sugBox){sugBox.remove();sugBox=null;} sugItems=[]; sugIdx=-1; sugInput=null; }
  function openSug(input, values){
    closeSug();
    if(document.activeElement!==input)return;
    const q=input.value.trim().toLowerCase();
    const picks=values.filter(v=>!q||v.toLowerCase().includes(q)).slice(0,8);
    if(!picks.length)return;
    const rect=input.getBoundingClientRect();
    const box=document.createElement('div'); box.className='suggestions sug-fixed';
    picks.forEach(v=>{
      const b=document.createElement('button'); b.type='button'; b.className='suggestion'; b.tabIndex=-1; b.textContent=v;
      const pick=e=>{e.preventDefault();input.value=v;input.dispatchEvent(new Event('change',{bubbles:true}));closeSug();input.focus();};
      b.addEventListener('mousedown',pick);
      let tsy=null,tmoved=false;
      b.addEventListener('touchstart',e=>{tsy=e.touches[0].clientY;tmoved=false;},{passive:true});
      b.addEventListener('touchmove',e=>{if(tsy!=null&&Math.abs(e.touches[0].clientY-tsy)>10)tmoved=true;},{passive:true});
      b.addEventListener('touchend',e=>{if(tsy!=null&&!tmoved){e.preventDefault();pick(e);}},false);
      box.append(b);
    });
    const host=input.closest('dialog')||document.body;host.append(box);
    const bh=Math.min(box.scrollHeight,160);
    let top=rect.bottom+4;
    if(top+bh>window.innerHeight-8)top=Math.max(8,rect.top-bh-4);
    box.style.top=top+'px'; box.style.left=Math.max(8,rect.left)+'px'; box.style.width=rect.width+'px';
    sugBox=box; sugInput=input; sugItems=Array.prototype.slice.call(box.querySelectorAll('.suggestion')); sugIdx=-1;
  }
  const KBD_HELP=[
    ['Enter','Next field. On the last field of the last item line it adds ONE new line'],
    ['Enter on an empty product line','Finish items and jump to GST / note'],
    ['Shift + Enter','Previous field'],
    ['Up / Down, then Enter','Pick from the suggestion list (Enter only fills it)'],
    ['Left / Right on FORM','Switch between the three shops'],
    ['Ctrl + Enter or Ctrl + S','Save the open window'],
    ['Ctrl + Delete or Alt + D','Delete the line / record under the cursor (asks first)'],
    ['Esc','Close the suggestion list, then the window (asks if unsaved)'],
    ['N','New bill (when no window is open)'],
    ['/','Search on Records or Catalog, then Down arrow + Enter opens a result'],
    ['Alt + 1 to 7','Overview, Records, Supply, Catalog, Analytics, Backup, Export to Busy'],
    ['Alt + B','Export the open bill (or the selected bill on Records) to Busy as one .xml'],
    ['?','Show these shortcuts']
  ];
  function showKbdHelp(){
    let d=document.getElementById('kbd-help');
    if(!d){d=document.createElement('dialog');d.id='kbd-help';d.className='modal modal-narrow';document.body.append(d);}
    d.innerHTML='<div class="modal-head"><div><div class="eyebrow">KEYBOARD</div><h2>Shortcuts</h2><p>Use Kirana Desk without the mouse.</p></div><button class="icon-button" data-action="close-dialog">\u2715</button></div><div class="modal-body"><div class="metric-list">'
      +KBD_HELP
      .map(r=>'<div class="metric-row"><span class="row-title"><b>'+r[0]+'</b> \u00b7 '+r[1]+'</span></div>').join('')+'</div><p class="field-hint" style="margin-top:10px">Press ? anywhere to see this again.</p></div><div class="modal-foot"><span></span><button class="button button-primary" type="button" data-action="close-dialog">Got it</button></div>';
    d.showModal();
  }
  /* ---------- Keyboard: ONE central handler (Busy-style entry) ----------
     Enter = next field / pick highlighted suggestion · Shift+Enter = back
     Enter on the last field of the last item line = exactly one new line
     Ctrl+Enter (or Ctrl+S) = save · Ctrl+Delete or Alt+D = delete (always asks)
     Esc = close suggestion list, then the window. Enter never presses a delete/remove button. */
  const DANGER_SEL='[data-action^="delete-"],[data-action^="remove-"],.button-danger';
  const SAVE_SEL='button[type="submit"],[data-action="save-supply"],[data-action="save-return"],[data-action="generate-return-report"],[data-action="quick-backup"]';
  const LIST_BTN_SEL='[data-action="view-bill"],[data-action="edit-record"],[data-action="open-supply"]';
  let kbdNextFocus=null, kbdSaving=false, lastTypedAt=0, searchSeq=0, searchJob=Promise.resolve();
  function focusFirstResult(){ searchJob.then(()=>{ const first=$$(LIST_BTN_SEL,$('#page-content')).find(visible); if(first)first.focus(); }); }
  function topDialog(){ const open=$$('dialog[open]'); return open.length?open[open.length-1]:null; }
  function kbdRoot(){ const d=topDialog(); if(d)return d; const g=$('#auth-gate'); if(g&&!g.hidden)return g; return null; }
  function visible(el){ if(!el||el.disabled)return false; if(el.offsetParent===null){const cs=getComputedStyle(el);if(cs.position!=='fixed'||cs.display==='none'||cs.visibility==='hidden')return false;} return !el.closest('[hidden]'); }
  function flowFields(root){
    return $$('input:not([type=hidden]):not([type=file]):not([type=button]):not([type=submit]),select,textarea,.pick-chip.active',root)
      .filter(el=>visible(el)&&!el.readOnly&&!el.closest('.sug-fixed'));
  }
  function saveButton(root){ return root?$$(SAVE_SEL,root).find(b=>visible(b)&&!b.closest('.sug-fixed')):null; }
  function focusEl(el){ if(!el)return; el.focus(); if(el.select&&el.tagName==='INPUT'&&/^(text|search|number|tel|email|password|)$/.test(el.type||'')&&el.value){try{el.select();}catch(_){}} }
  function markDanger(root){ $$(DANGER_SEL,root||document).forEach(b=>{ if(b.getAttribute('tabindex')!=='-1')b.setAttribute('tabindex','-1'); }); }
  const DEFAULT_PRICE='1'; // new item lines start at price 1 (Busy needs a price on every line); saved lines keep what they had
  function itemRowHtml(i, lock, brv){
    i=i||{};
    return '<div class="item-row"><input class="input" data-field="productName" autocomplete="off" value="'+esc(i.productName||'')+'" placeholder="Search product" required '+(lock?'readonly':'')+'><input class="input" data-field="brand" autocomplete="off" value="'+esc(brv==null?(i.brand||''):brv)+'" placeholder="brand" '+(lock?'readonly':'')+'><input class="input" type="number" min="0" step="any" data-field="price" value="'+esc(i.price===undefined&&!lock?DEFAULT_PRICE:(i.price==null?'':i.price))+'" placeholder="price" '+(lock?'readonly':'')+'><input class="input" type="number" min="0.001" step="any" data-field="quantity" value="'+esc(i.quantity==null?'':i.quantity)+'" placeholder="0" required '+(lock?'readonly':'')+'><input class="input" data-field="unit" autocomplete="off" value="'+esc(i.unit||'')+'" placeholder="e.g. bag" required '+(lock?'readonly':'')+'>'+(lock?'':'<button class="icon-button remove-item" type="button" data-action="remove-item" tabindex="-1" title="Remove line (Ctrl+Delete)">×</button>')+'</div>';
  }
  function addItemRow(){
    const box=$('#bill-items'); if(!box)return null;
    box.insertAdjacentHTML('beforeend',itemRowHtml({}, false, ''));
    const row=box.lastElementChild; const inp=$('[data-field="productName"]',row); if(inp)inp.focus();
    return row;
  }
  function rowIsBlank(row){ return $$('[data-field]',row).every(i=>{const v=String(i.value||'').trim();return v===''||(i.dataset.field==='price'&&v===DEFAULT_PRICE);}); }
  function removeItemRow(row, ask){
    const box=$('#bill-items'); if(!box||!row)return;
    const rows=$$('.item-row',box);
    if(rows.length<=1){toast('A bill needs one item.');return;}
    if(ask&&!rowIsBlank(row)&&!confirm('Remove this line'+(($('[data-field="productName"]',row)||{}).value?' ('+$('[data-field="productName"]',row).value+')':'')+'?'))return;
    const field=(document.activeElement&&document.activeElement.dataset&&document.activeElement.dataset.field)||'productName';
    const idx=rows.indexOf(row); row.remove();
    const left=$$('.item-row',box), target=left[Math.min(idx,left.length-1)];
    if(ask&&target)focusEl($('[data-field="'+field+'"]',target));
  }
  function nextFromItemGrid(root, el){
    // first flow field after the item grid (GST on the bill form), else the save button
    const list=flowFields(root), grid=$('#bill-items');
    const after=list.find(f=>!grid.contains(f)&&(grid.compareDocumentPosition(f)&Node.DOCUMENT_POSITION_FOLLOWING));
    return after||saveButton(root);
  }
  function kbdMove(root, el, dir){
    const list=flowFields(root);
    // Bill item grid rules
    const row=el.closest&&el.closest('#bill-items .item-row');
    if(row&&dir>0){
      const rows=$$('.item-row',$('#bill-items')), isLastRow=row===rows[rows.length-1];
      const rowFields=list.filter(f=>row.contains(f)), lastInRow=rowFields[rowFields.length-1];
      const product=$('[data-field="productName"]',row), productEmpty=!product||!product.value.trim();
      if(isLastRow&&el===product&&productEmpty&&rows.length>1){ focusEl(nextFromItemGrid(root,el)); return; }
      if(isLastRow&&el===lastInRow){
        if(productEmpty){ focusEl(nextFromItemGrid(root,el)); return; }
        addItemRow(); return;
      }
    }
    const i=list.indexOf(el);
    if(i<0){ focusEl(list[0]||saveButton(root)); return; }
    const j=i+dir;
    if(j<0)return;
    if(j>=list.length){ const sb=saveButton(root); if(sb)sb.focus(); return; }
    focusEl(list[j]);
  }
  function kbdSave(root){
    const b=saveButton(root); if(!b||b.disabled)return false;
    if(kbdSaving)return true; kbdSaving=true; setTimeout(()=>{kbdSaving=false;},400);
    closeSug(); b.click(); return true;
  }
  function kbdDelete(){
    const t=document.activeElement, row=t&&t.closest&&t.closest('#bill-items .item-row');
    if(row&&$('[data-action="remove-item"]',row)){ removeItemRow(row,true); return true; }
    const tr=t&&t.closest&&t.closest('tr'), del=tr?$('[data-action="delete-record"]',tr):null;
    if(del){ del.click(); return true; }
    const d=topDialog(), dd=d?$$('[data-action="delete-bill"],[data-action="delete-supply"]',d).find(visible):null;
    if(dd){ dd.click(); return true; }
    toast('Nothing to delete here. Put the cursor on a line or record first.'); return true;
  }
  function onKey(e){
    if(e.isComposing||e.keyCode===229)return;
    const t=e.target||null, root=kbdRoot();
    const typing=t&&(t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.tagName==='SELECT'||t.isContentEditable);
    const ctrl=e.ctrlKey||e.metaKey;
    if(typing&&e.key&&e.key.length===1)lastTypedAt=Date.now();
    // 1. Suggestion list owns arrows / Enter / Esc while it is open — nothing else sees the key
    if(sugBox&&sugItems.length&&t===sugInput){
      if(e.key==='ArrowDown'||e.key==='ArrowUp'){
        e.preventDefault();e.stopImmediatePropagation();
        if(sugIdx<0)sugIdx=e.key==='ArrowDown'?0:sugItems.length-1;
        else sugIdx=(sugIdx+(e.key==='ArrowDown'?1:-1)+sugItems.length)%sugItems.length;
        sugItems.forEach((b,i)=>b.classList.toggle('active',i===sugIdx));
        sugItems[sugIdx].scrollIntoView({block:'nearest'});
        return;
      }
      if(e.key==='Enter'&&!ctrl&&!e.shiftKey&&!e.altKey&&sugIdx>=0){
        e.preventDefault();e.stopImmediatePropagation();
        if(!e.repeat)sugItems[sugIdx].dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));
        return;
      }
      if(e.key==='Escape'){ e.preventDefault();e.stopImmediatePropagation();closeSug();return; }
      if(e.key==='Tab')closeSug();
    }
    // 2. Save
    if(ctrl&&!e.altKey&&(e.key==='Enter'||e.key==='s'||e.key==='S')){
      if(root){ e.preventDefault(); if(!e.repeat)kbdSave(root); }
      return;
    }
    // 3. Delete — explicit key, always confirmed
    if((ctrl&&!e.altKey&&e.key==='Delete')||(e.altKey&&!ctrl&&(e.key==='d'||e.key==='D'||e.code==='KeyD'))){
      e.preventDefault(); if(!e.repeat)kbdDelete(); return;
    }
    // 3b. Alt+B — export the open bill (or the selected Records row) to Busy as one .xml
    if(e.altKey&&!ctrl&&(e.code==='KeyB'||e.key==='b'||e.key==='B')){
      const d=topDialog(); let btn=null;
      if(d&&d.id==='bill-dialog')btn=$('[data-action="busy-one"]',d);
      else if(!d&&t&&t.matches&&t.matches('[data-action="view-bill"],[data-action="busy-one"]'))btn=t.closest('tr')&&$('[data-action="busy-one"]',t.closest('tr'));
      if(btn&&visible(btn)){ e.preventDefault(); if(!e.repeat)btn.click(); return; }
    }
    // 4. Enter
    if(e.key==='Enter'&&!ctrl&&!e.altKey){
      if(t&&t.tagName==='TEXTAREA'&&!e.shiftKey)return;
      if(e.repeat){ e.preventDefault(); return; }
      if(t&&t.matches&&t.matches(DANGER_SEL)){ e.preventDefault(); return; }
      if(t&&t.classList&&t.classList.contains('pick-chip')&&root){
        e.preventDefault(); closeSug();
        if(e.shiftKey){ kbdMove(root,t,-1); return; }
        const list=flowFields(root), i=list.indexOf(t), nx=list[i+1];
        if(!t.classList.contains('active')){ if(nx&&nx.id)kbdNextFocus='#'+nx.id; t.click(); }
        if(nx&&document.contains(nx))focusEl(nx);
        return;
      }
      if(t&&(t.tagName==='BUTTON'||t.tagName==='A'||t.tagName==='SUMMARY')){
        if(e.shiftKey&&root){ e.preventDefault(); const list=flowFields(root); focusEl(list[list.length-1]); }
        return; // plain Enter on a normal button = press it once (native)
      }
      if(!typing&&t!==root&&!(root&&root.contains(t)))return;
      if(root&&(typing||t===root)){
        e.preventDefault(); closeSug();
        if(t.id==='login-password'&&!e.shiftKey){ const f=$('#sign-in-form'); if(f&&!f.dataset.busy)f_requestSubmit(f); return; }
        if(t===root){ const list=flowFields(root); focusEl(list[0]||saveButton(root)); return; }
        kbdMove(root,t,e.shiftKey?-1:1); return;
      }
      if(!root&&typing){
        if(t.id==='bill-search'||t.id==='catalog-search'){ e.preventDefault(); focusFirstResult(); return; }
        if(t.id==='busy-billno'){ e.preventDefault(); if(!e.repeat){ const sb=$('#busy-single-btn'); if(sb)sb.click(); } return; }
        if(t.tagName==='INPUT'&&t.form)e.preventDefault();
      }
      return;
    }
    // 5. Arrows: switch the FORM chip, walk lists on pages
    if((e.key==='ArrowLeft'||e.key==='ArrowRight')&&t&&t.classList&&t.classList.contains('pick-chip')){
      const chips=$$('.pick-chip',t.closest('.chip-row')).filter(c=>!c.disabled), i=chips.indexOf(t), n=chips[(i+(e.key==='ArrowRight'?1:-1)+chips.length)%chips.length];
      if(n&&n!==t){ e.preventDefault(); kbdNextFocus='.pick-chip[data-id="'+n.dataset.id+'"]'; n.click(); if(document.contains(n))n.focus(); }
      return;
    }
    if((e.key==='ArrowDown'||e.key==='ArrowUp')&&!root){
      if(t&&(t.id==='bill-search'||t.id==='catalog-search')&&e.key==='ArrowDown'){ e.preventDefault(); focusFirstResult(); return; }
      if(t&&t.matches&&t.matches(LIST_BTN_SEL)){
        const all2=$$('[data-action="'+t.dataset.action+'"]',$('#page-content')).filter(visible), i=all2.indexOf(t), n=all2[i+(e.key==='ArrowDown'?1:-1)];
        e.preventDefault();
        if(n)n.focus(); else if(e.key==='ArrowUp'){ const s=$('#bill-search')||$('#catalog-search'); if(s)s.focus(); }
        return;
      }
    }
    if(e.key==='Escape'){
      closeSug();
      const d=topDialog();
      if(d){ e.preventDefault(); if(e.repeat)return; if(d.dataset.dirty&&!confirm('Close without saving? What you typed will be lost.'))return; d.close(); }
      return;
    }
    // 6. Global shortcuts (never while a window is open or while typing)
    if(e.altKey&&!ctrl&&/^Digit[1-7]$/.test(e.code||'')||(e.altKey&&!ctrl&&/^[1-7]$/.test(e.key))){
      if(root)return;
      e.preventDefault();const nav=$$('.nav-item[data-page]'),n=nav[Number((e.code||'').replace('Digit','')||e.key)-1];if(n){page=n.dataset.page;render();}return;
    }
    if(typing||root||ctrl||e.altKey)return;
    if(Date.now()-lastTypedAt<700&&(e.key==='n'||e.key==='N'||e.key==='/'))return; // a letter typed a moment ago in a box: never treat it as a shortcut
    if(e.key==='?'){e.preventDefault();showKbdHelp();return;}
    if(e.key==='/'){e.preventDefault();const s=$('#bill-search')||$('#catalog-search');if(s){s.focus();if(s.select)s.select();}return;}
    if((e.key==='n'||e.key==='N')&&!e.repeat){if(can('bill')){e.preventDefault();newBill();}return;}
  }
  document.addEventListener('keydown',onKey,true);
  // Focus the first field whenever a window opens or redraws; keep delete buttons out of Tab/Enter order
  function dialogFocus(d){
    if(!d||!d.open)return;
    if(kbdNextFocus){ const el=$(kbdNextFocus,d); kbdNextFocus=null; if(el){ focusEl(el); return; } }
    const a=document.activeElement;
    if(a&&d.contains(a)&&a!==d&&!(a.matches&&a.matches('[data-action="close-dialog"]')))return;
    const list=flowFields(d);
    const target=list.find(f=>f.tagName==='INPUT'&&f.type!=='date'&&f.type!=='checkbox')||list.find(f=>f.tagName!=='BUTTON')||$('.modal-foot .button-primary',d)||saveButton(d);
    if(target)target.focus();
  }
  new MutationObserver(muts=>{
    const touched=new Set();
    muts.forEach(m=>{
      if(m.type==='childList'){ m.addedNodes.forEach(n=>{ if(n.nodeType===1){ if(n.matches&&n.matches(DANGER_SEL))n.setAttribute('tabindex','-1'); markDanger(n);} }); if(m.target.tagName==='DIALOG')touched.add(m.target); }
      if(m.type==='attributes'&&m.target.tagName==='DIALOG'&&m.target.open)touched.add(m.target);
    });
    touched.forEach(d=>setTimeout(()=>dialogFocus(d),0));
  }).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['open']});
  markDanger(document);
  document.addEventListener('close',e=>{ if(e.target&&e.target.tagName==='DIALOG'){ closeSug(); delete e.target.dataset.dirty; } },true);
  document.addEventListener('cancel',e=>{
    const d=e.target; if(!d||d.tagName!=='DIALOG')return;
    if(sugBox){ e.preventDefault(); closeSug(); return; }
    if(d.dataset.dirty&&!confirm('Close without saving? What you typed will be lost.')){ e.preventDefault(); }
  },true);
  document.addEventListener('input',e=>{ const d=e.target&&e.target.closest&&e.target.closest('dialog'); if(d&&e.target.closest('form')&&e.target.id!=='so-search')d.dataset.dirty='1'; },true);
  function f_requestSubmit(form){if(form.requestSubmit)form.requestSubmit();else form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));}
  function sugValuesFor(input){
    if(input.id==='bill-customer')return all('customers').then(rows=>rows.filter(x=>form==='all'||x.businessId===(($('#bill-business')||{}).value)||x.businessId===undefined).map(x=>x.name));
    if(input.id==='so-customer')return all('customers').then(rows=>{const seen={},out=[];rows.forEach(x=>{const k=String(x.name||'').trim().toLowerCase();if(k&&!seen[k]){seen[k]=true;out.push(String(x.name).trim());}});return out;});
    if(input.dataset.field==='productName')return all('products').then(rows=>{const seen={},out=[];rows.forEach(x=>{const k=String(x.name||'').trim().toLowerCase();if(k&&!seen[k]){seen[k]=true;out.push(String(x.name).trim());}});return out;});
    if(input.dataset.field==='unit')return Promise.resolve(['bag','kg','g','litre','box','piece','quintal','tonne','packet','dozen']);
    return Promise.resolve([]);
  }
  function maybeSug(target){ if(target&&(target.id==='bill-customer'||target.id==='so-customer'||target.dataset.field==='productName'||target.dataset.field==='unit')){ if(target.readOnly||target.disabled){closeSug();return;} sugValuesFor(target).then(vals=>{ if(document.activeElement===target)openSug(target,vals); }); } }
  document.addEventListener('focusin',e=>{ if(sugBox&&e.target!==sugInput&&!(e.target.closest&&e.target.closest('.sug-fixed')))closeSug(); maybeSug(e.target); });
  document.addEventListener('input',e=>{ if(e.target&&(e.target.id==='bill-customer'||e.target.id==='so-customer'||e.target.dataset.field==='productName'||e.target.dataset.field==='unit')){ if(e.target.value.trim()===''){maybeSug(e.target);}else{const el=e.target;sugValuesFor(el).then(vals=>{if(document.activeElement===el)openSug(el,vals);});} } });
  document.addEventListener('click',e=>{ if(sugBox&&!e.target.closest('.sug-fixed'))closeSug(); },true);
  window.addEventListener('scroll',e=>{if(sugBox&&sugBox.contains(e.target))return;closeSug();},true);
  document.addEventListener('click', e=>{
    const p=e.target.closest('[data-page]'); if(p){page=p.dataset.page;render();return;}
    const t=e.target.closest('[data-business]'); if(t){form=t.dataset.business;render();return;}
    const ct=e.target.closest('[data-catalog-tab]');if(ct){catalog=ct.dataset.catalogTab;catalogSearch='';render();return;}
    const a=e.target.closest('[data-action]');if(!a)return;
    const x=a.dataset.action;
    if(x==='new-bill')newBill(a.dataset.form);
    if(x==='goto-bills'){page='bills';render();}
    if(x==='close-dialog')a.closest('dialog').close();
    if(x==='add-record')recordDialog(a.dataset.kind);
    if(x==='edit-record'){const store=a.dataset.kind;all(store).then(items=>{const item=items.find(r=>r.id===a.dataset.id);if(item)recordDialog(store,item.businessId,item);});}
    if(x==='export-backup')backup().catch(()=>toast('Could not create backup.',true));
    if(x==='export-new-backup')backupIncremental('manual').catch(()=>toast('Could not create backup.',true));
    if(x==='quick-backup'){const d=a.closest('dialog');if(d&&d.open)d.close();backupIncremental('prompt').catch(()=>toast('Could not create backup.',true));}
    if(x==='busy-one')exportOneBill(a.dataset.id).catch(err=>{console.error(err);toast('Could not make the Busy file.',true);});
    if(x==='busy-single')exportBusySingle().catch(err=>{console.error(err);toast('Could not make the Busy file.',true);});
    if(x==='busy-export')exportBusy().catch(err=>{console.error(err);toast('Could not make the Busy file.',true);});
    if(x==='busy-save')saveBusy().catch(()=>toast('Could not save Busy settings.',true));
    if(x==='export-analytics')exportAnalytics().catch(()=>toast('Could not export this report.',true));
    if(x==='add-item')addItemRow();
    if(x==='remove-item'){if(e.detail===0)return;removeItemRow(a.closest('.item-row'),false);}
    if(x==='view-bill')all('bills').then(items=>{const b=items.find(v=>v.id===a.dataset.id);if(b){billDialog(b);$('#bill-dialog').showModal();}});
    if(x==='pick-business'){const inp=$('#bill-business');if(inp&&!inp.disabled){inp.value=a.dataset.id;$$('.pick-chip',a.closest('.chip-row')).forEach(c=>c.classList.toggle('active',c===a));inp.dispatchEvent(new Event('change',{bubbles:true}));}}
    if(x==='pick-record-business'){const inp=a.closest('form').querySelector('[name="businessId"]');if(inp){inp.value=a.dataset.id;$$('.pick-chip',a.closest('.chip-row')).forEach(c=>c.classList.toggle('active',c===a));}}
    if(x==='edit-bill')all('bills').then(items=>{const b=items.find(v=>v.id===a.dataset.id);if(b){$('#bill-dialog').close();billDialog(b,true);$('#bill-dialog').showModal();}});
    if(x==='view-photo'){const local=$('#bill-photo-value'),src2=local?local.value:'';if(src2){photoView(src2,a.dataset.id||'');}else if(a.dataset.id){all('bills').then(items=>{const b=items.find(v=>v.id===a.dataset.id);if(b&&b.photo)photoView(b.photo,a.dataset.id);});}}
    if(x==='back-to-bill')all('bills').then(items=>{const b=items.find(v=>v.id===a.dataset.id);if(b){billDialog(b);}});
    if(x==='remove-photo'){const v=$('#bill-photo-value');if(v)v.value='';const area=$('#bill-photo-area');renderPhotoArea('',area&&area.dataset.editable!=='no');}
    if(x==='print-bill')all('bills').then(items=>{const b=items.find(v=>v.id===a.dataset.id);if(!b)return;if(b.items.some(i=>Number(i.price)>0))printChoice(b);else printBill(b,false);});
    if(x==='print-priced'||x==='print-unpriced')all('bills').then(items=>{const b=items.find(v=>v.id===a.dataset.id);if(b)printBill(b,x==='print-priced');});
    if(x==='return-bill'&&can('bill'))all('bills').then(items=>{const b=items.find(v=>v.id===a.dataset.id);if(b){const open=$('#bill-dialog');if(open.open)open.close();returnDialog(b);retDlg().showModal();}});
if(x==='add-supply'){supplyDialog({businessId:form==='all'?'sampurn':form,date:today(),ref:'',customerName:'',notes:''});}
    if(x==='open-supply')all('supplyorders').then(rows=>{const o=rows.find(v=>v.id===a.dataset.id);if(o){$('#bill-dialog').close();supplyDialog(o);}});
    if(x==='edit-supply')all('supplyorders').then(rows=>{const o=rows.find(v=>v.id===a.dataset.id);if(o){supplyDialog(o,true);}});
    if(x==='view-supply')all('supplyorders').then(rows=>{const o=rows.find(v=>v.id===a.dataset.id);if(o){supplyDialog(o);}});
    if(x==='save-supply'){const f=$('#supply-form');if(f){if(f.requestSubmit)f.requestSubmit();else f.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));}}
    if(x==='remove-so-file'){const v=$('#so-file-value');if(v)v.value='';const t=$('#so-file-type');if(t)t.value='';soCurrentFile='';renderSoFileArea($('#so-file-area'),'','',true);}
    if(x==='open-so-pdf'){if(!soCurrentFile){toast('No PDF attached.',true);return;}try{const b64=soCurrentFile.split(',')[1]||'';const arr=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));const url=URL.createObjectURL(new Blob([arr],{type:'application/pdf'}));window.open(url,'_blank');}catch(err){toast('Could not open the PDF.',true);}}
    if(x==='open-so-photo'){if(soCurrentFile)photoView(soCurrentFile);}
    if(x==='delete-supply')all('supplyorders').then(rows=>{const o=rows.find(v=>v.id===a.dataset.id);if(!o)return;if(!confirm('Delete this supply order? The bills stay; only the link and the order file are removed.'))return;all('bills').then(bills=>{const touched=bills.filter(b=>b.supplyOrderId===o.id);return Promise.all(touched.map(b=>{delete b.supplyOrderId;return put('bills',b);})).then(()=>del('supplyorders',o.id));}).then(()=>{soDlg().close();toast('Supply order deleted.');render();}).catch(()=>toast('Could not delete the supply order.',true));});
        if(x==='save-return'){if(a.dataset.busy)return;a.dataset.busy='1';setTimeout(()=>{delete a.dataset.busy;},1500);const billId=a.dataset.id;all('bills').then(items=>{const b=items.find(v=>v.id===billId);if(!b)return;const date=$('#return-date').value||today();const lines=[];b.items.forEach((it,idx)=>{const el=$('#ret-'+idx),q=el?parseFloat(el.value):0;if(q>0)lines.push({productName:it.productName,unit:it.unit||'',qty:q,price:Number(it.price)>0?Number(it.price):null});});if(!lines.length){toast('Enter how much came back for at least one item.',true);return;}b.returns=(b.returns||[]).concat([{id:uid(),date,items:lines}]);put('bills',b).then(()=>{retDlg().close();toast('Return saved.');render();all('bills').then(items2=>{const nb=items2.find(v=>v.id===billId);if(nb){billDialog(nb);$('#bill-dialog').showModal();}});});});}
    if(x==='delete-return'){const billId=a.dataset.id,rid=a.dataset.rid;if(confirm('Delete this return entry?'))all('bills').then(items=>{const b=items.find(v=>v.id===billId);if(!b)return;b.returns=(b.returns||[]).filter(r=>r.id!==rid);put('bills',b).then(()=>{toast('Return entry removed.');returnDialog(b);});});}
    if(x==='returns-report')returnsReportDialog();
    if(x==='customer-register')returnsReportDialog(a.dataset.name);
    if(x==='generate-return-report')renderReturnReport();
    if(x==='print-return-report')printReturnReport();
    if(x==='open-bill-report')all('bills').then(items=>{const b=items.find(v=>v.id===a.dataset.id);retDlg().close();if(b){billDialog(b);$('#bill-dialog').showModal();}});
    if(x==='delete-bill'&&confirm('Delete this bill? Its number remains reserved and will never be reused.'))del('bills',a.dataset.id).then(()=>{$('#bill-dialog').close();toast('Bill deleted. Number remains reserved.');render();});
    if(x==='delete-record'&&confirm('Delete this catalog entry? Existing bills will not change.'))del(a.dataset.kind,a.dataset.id).then(()=>{toast('Catalog entry removed.');render();});

    if(x==='set-backup-folder')pickBackupDir();
    if(x==='reallow-backup')reallowBackup();
    if(x==='pick-role'&&ROLES[a.dataset.role]){role=a.dataset.role;$('#record-dialog').close();applyRole();render();saveUserRole(window.KiranaCloud&&window.KiranaCloud.user?window.KiranaCloud.user.email:'');toast('Role saved.');}
  });
  document.addEventListener('input',e=>{
    if(e.target.id==='bill-search'){search=e.target.value;const n=e.target.value.length,seq=++searchSeq;searchJob=renderBills().then(()=>{if(seq!==searchSeq)return;const field=$('#bill-search');if(field&&document.activeElement!==field&&(!document.activeElement||document.activeElement===document.body)){field.focus();field.setSelectionRange(n,n);}});}
    if(e.target.id==='catalog-search'){catalogSearch=e.target.value;const n=e.target.value.length,seq=++searchSeq;searchJob=renderCatalog().then(()=>{if(seq!==searchSeq)return;const field=$('#catalog-search');if(field&&document.activeElement!==field&&(!document.activeElement||document.activeElement===document.body)){field.focus();field.setSelectionRange(n,n);}});}
  });
  document.addEventListener('change',e=>{
    if(e.target.id==='bill-period'){period=e.target.value;renderBills();}
    if(e.target.id==='busy-firm'||e.target.id==='busy-from'||e.target.id==='busy-to'){busyFirm=$('#busy-firm').value;busyFrom=$('#busy-from').value;busyTo=$('#busy-to').value;if(e.target.id==='busy-firm')saveBusy(true).then(()=>renderBusy());else all('bills').then(bs=>{const n=bs.filter(b=>b.businessId===busyFirm&&b.date>=busyFrom&&b.date<=busyTo).length;const c=$('#busy-count');if(c)c.textContent=n+' bill'+(n===1?'':'s')+' in this range.';});}
    if(e.target.id==='analytics-period'){analyticsPeriod=e.target.value;renderAnalytics();}
    if(e.target.id==='bill-business'){const key=e.target.value;billDialog({businessId:key,date:$('#bill-date').value,customerName:$('#bill-customer').value,items:$$('.item-row',$('#bill-items')).map(r=>Object.fromEntries($$('[data-field]',r).map(i=>[i.dataset.field,i.value]))),notes:$('#bill-notes').value,photo:$('#bill-photo-value')?$('#bill-photo-value').value:'',gst:$('#bill-gst')?$('#bill-gst').value:'',supplyOrderId:(document.querySelector('#bill-form [name="soId"]')||{}).value||''});}
    if(e.target.dataset.field==='productName'){const name=e.target.value.trim().toLowerCase(), row=e.target.closest('.item-row'), selectedBusiness=$('#bill-business')?.value;all('products').then(items=>{const matches=items.filter(p=>p.name.toLowerCase()===name);const item=matches.find(p=>p.brand)||matches[0];const unit=$('[data-field="unit"]',row);if(item&&item.unit&&unit&&!unit.value)unit.value=item.unit;const brIn=$('[data-field="brand"]',row);if(item&&brIn&&!brIn.value)brIn.value=item.brand||'';});}
    if(e.target.id==='bill-photo-input'&&e.target.files[0]){const f=e.target.files[0],area=$('#bill-photo-area'),editable=area&&area.dataset.editable!=='no';toast('Preparing photo…');compressImage(f).then(d=>{const v=$('#bill-photo-value');if(v)v.value=d;renderPhotoArea(d,editable);toast('Photo attached.');}).catch(()=>toast('Could not attach that photo.',true));e.target.value='';}
    if(e.target.id==='so-file-input'&&e.target.files[0]){const f=e.target.files[0];toast('Preparing file…');const p=f.type==='application/pdf'?readPdf(f):compressImage(f);Promise.resolve(p).then(d=>{const v=$('#so-file-value');if(!v)return;if(d.length>850000){toast('That file is too large to store. Try a smaller PDF, or scan the order as a photo.',true);return;}v.value=d;const t=$('#so-file-type');if(t)t.value=f.type==='application/pdf'?'pdf':'image';soCurrentFile=d;renderSoFileArea($('#so-file-area'),d,f.type==='application/pdf'?'pdf':'image',true);toast('Order file attached.');}).catch(()=>toast('Could not attach that file.',true));e.target.value='';}
    if(e.target.id==='backup-file'&&e.target.files[0])restore(e.target.files[0]).catch(err=>{console.error(err);toast(err.message||'Could not restore backup.',true);e.target.value='';});
  });
  document.addEventListener('submit',async e=>{
    if(e.target.id==='record-form'){
      e.preventDefault();const rf=e.target;if(rf.dataset.busy)return;rf.dataset.busy='1';try{const f=new FormData(e.target), kind=f.get('kind'), oldId=f.get('recordId'), prior=oldId?(await all(kind)).find(x=>x.id===oldId):null, r={id:oldId||uid(),businessId:f.get('businessId'),name:String(f.get('name')).trim(),createdAt:prior?prior.createdAt:new Date().toISOString()};
      if(!r.name){toast('Enter a name.',true);return;}
      if(prior&&prior.isSample&&prior.name===r.name)r.isSample=true;
      if(kind==='products'){r.unit=String(f.get('unit')||'').trim();r.brand=String(f.get('brand')||'').trim();await put('products',r);}else{r.note=String(f.get('note')||'').trim();await put('customers',r);}
      $('#record-dialog').close();toast(kind==='products'?'Saved. Products are shared across all forms.':'Saved to this form.');render();
      }finally{delete rf.dataset.busy;}
    }
if(e.target.id==='supply-form'){
      e.preventDefault();
      const ref=$('#so-ref')?$('#so-ref').value.trim():'',customer=$('#so-customer')?$('#so-customer').value.trim():'',date=$('#so-date')?$('#so-date').value:'',notes=$('#so-notes')?$('#so-notes').value.trim():'';
      const fv=$('#so-file-value'),file=fv?fv.value:'',ft=$('#so-file-type'),ftype=ft?ft.value:'';
      const businessId=$('#so-business')?$('#so-business').value:'sampurn';
      if(!date){toast('Pick the order date.',true);return;}
      if(!file){toast('Attach the order image or PDF.',true);return;}
      const picked=$$('.so-pick').filter(c=>c.checked).map(c=>c.value);
      const sf=e.target;if(sf.dataset.busy)return;sf.dataset.busy='1';
      (async()=>{try{
        const idInput=$('#so-id'),old=idInput&&idInput.value?(await all('supplyorders')).find(o=>o.id===idInput.value):null;
        const rec=old?Object.assign({},old):{id:uid(),businessId:businessId,createdAt:new Date().toISOString()};
        Object.assign(rec,{ref:ref,customerName:customer,date:date,notes:notes,fileType:ftype,file:file});
        await put('supplyorders',rec);
        const bills=await all('bills'),prev=bills.filter(b=>b.supplyOrderId===rec.id).map(b=>b.id);
        for(const bid of picked){const b=bills.find(x=>x.id===bid);if(b&&b.supplyOrderId!==rec.id){b.supplyOrderId=rec.id;await put('bills',b);}}
        for(const bid of prev){if(picked.indexOf(bid)<0){const b=bills.find(x=>x.id===bid);if(b){delete b.supplyOrderId;await put('bills',b);}}}
        soCurrentFile=rec.file||'';toast(old?'Supply order updated.':'Supply order saved.');render();supplyDialog(rec);
      }catch(err){console.error(err);toast('Could not save the supply order.',true);}finally{delete sf.dataset.busy;}})();
    }
        if(e.target.id==='bill-form'){
      e.preventDefault();
      const bf=e.target; if(bf.dataset.busy)return; bf.dataset.busy='1';
      try{
      const allRows=$$('.item-row',bf), filled=allRows.filter(r=>!rowIsBlank(r)), rows=filled.length?filled:allRows.slice(0,1), items=rows.map(r=>{const pr=$('[data-field="price"]',r),brEl=$('[data-field="brand"]',r);return {productName:$('[data-field="productName"]',r).value.trim(),brand:brEl?String(brEl.value||'').trim():'',quantity:Number($('[data-field="quantity"]',r).value),unit:$('[data-field="unit"]',r).value.trim(),price:pr&&pr.value!==''?Number(pr.value):null};});
      const photoVal=$('#bill-photo-value'),gstVal=$('#bill-gst'),data={businessId:$('#bill-business').value,date:$('#bill-date').value,customerName:$('#bill-customer').value.trim(),notes:$('#bill-notes').value.trim(),items,photo:photoVal&&photoVal.value?photoVal.value:null,gst:gstVal&&gstVal.value!==''?parseFloat(gstVal.value):null};
      const idInput=e.target.querySelector('[name="billId"]'), billId=idInput?idInput.value:'';
      if(!data.customerName||!data.date||items.some(i=>!i.productName||!(i.quantity>0)||!i.unit)){toast('Fill in the customer, date, product, quantity, and unit.',true);return;}
      try{
        if(billId){const existing=(await all('bills')).find(b=>b.id===billId);if(existing){existing.customerName=data.customerName;existing.notes=data.notes;existing.items=items;existing.photo=data.photo;existing.gst=data.gst;const noInput=$('#bill-no');if(noInput){const nn=noInput.value.trim();if(!nn){toast('Bill number cannot be empty.',true);return;}const dup=(await all('bills')).some(x=>x.id!==billId&&x.businessId===existing.businessId&&x.billNumber===nn);if(dup){toast('This bill number is already used on another bill.',true);return;}existing.billNumber=nn;}await put('bills',existing);$('#bill-dialog').close();toast(existing.billNumber+' updated.');render();return;}}
        const added=await autoSaveCatalog(data).catch(()=>0);const saved=await makeBill(data);$('#bill-dialog').close();toast(saved.billNumber+' saved.');if(added)toast(added+(added===1?' new name saved to catalog.':' new names saved to catalog.'));billDialog(saved);$('#bill-dialog').showModal();render();
      }catch(err){console.error(err);toast(window.KiranaCloud&&window.KiranaCloud.configured?'Could not save. Check internet; shared bill numbering needs a connection.':'Could not save bill.',true);}
      }finally{delete bf.dataset.busy;}
    }
  });
  $('#new-bill-top').addEventListener('click',()=>newBill());
  $('#sign-in-form').addEventListener('submit',async e=>{
    e.preventDefault();const data=new FormData(e.currentTarget), error=$('#auth-error');error.textContent='';
    const ids={papa:'mtarvecha660@gmail.com',bhai:'moksh7tarvecha@gmail.com'};const raw=String(data.get('email')).trim();const email=raw.includes('@')?raw:(ids[raw.toLowerCase()]||raw);try{await window.KiranaCloud.signIn(email,String(data.get('password')));}
    catch(err){console.error(err);error.textContent=err.code==='auth/invalid-credential'?'Name or password is incorrect.':'Could not sign in. Check your connection and account details.';}
  });
  $('#sign-out').addEventListener('click',()=>window.KiranaCloud.signOut().catch(()=>toast('Could not sign out.',true)));
  window.addEventListener('online',()=>$('#online-label').textContent='Offline ready');
  window.addEventListener('offline',()=>$('#online-label').textContent='Working offline');
  async function start(){
    try{
      db=await openDb();
      loadBackupDir();applyRole();
      const firebaseExpected=Boolean(firebaseConfig&&firebaseConfig.apiKey&&!firebaseConfig.apiKey.startsWith('REPLACE_'));
      if(firebaseExpected&&!(window.KiranaCloud&&window.KiranaCloud.configured)){
        $('#auth-gate').hidden=false;$('#sign-in-form').hidden=true;$('#auth-error').textContent='Cloud connection did not load. Connect to the internet and reload this page.';return;
      }
      if(window.KiranaCloud&&window.KiranaCloud.configured){
        $('#auth-gate').hidden=false;
        let subscriptions=[];
        window.KiranaCloud.onAuthChange(async user=>{
          subscriptions.forEach(stop=>stop());subscriptions=[];
          if(!user){$('#auth-gate').hidden=false;$('#sign-out').hidden=true;return;}
          $('#auth-gate').hidden=true;$('#sign-out').hidden=false;$('#online-label').textContent='Shared workspace';
          try{const users=await window.KiranaCloud.list('users');const mine=users.find(u=>u.id===user.email);if(mine&&ROLES[mine.role])role=mine.role;else{role='owner';roleDialog(user.email);}}catch(e){role='owner';}
          applyRole();
          try{
            await reconcileCloud();await seedSamples();await unifyProducts();
            subscriptions=window.KiranaCloud.listen(async(store,records)=>{
              await replaceLocal(store,records);
              if(document.visibilityState==='visible')render().catch(console.warn);
            },error=>{console.warn('Cloud listener unavailable.',error);$('#online-label').textContent='Sync pending';});
            await render();
            setTimeout(()=>maybeBackupPrompt().catch(console.warn),2500);
          }catch(error){console.error(error);toast('Could not load shared records. Check the Firebase setup.',true);}
        });
      }else{await seedSamples();await unifyProducts();$('#online-label').textContent=navigator.onLine?'Local only':'Working offline';await render();}
      if('serviceWorker'in navigator&&location.protocol!=='file:')navigator.serviceWorker.register('./sw.js').catch(console.info);
    }
    catch(err){console.error(err);$('#page-content').innerHTML=empty('Local storage unavailable','Open the app through a local web server or secure website. Browser storage is unavailable in this page context.');}
  }
  start();
})();
