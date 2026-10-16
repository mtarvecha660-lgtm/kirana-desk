import { firebaseConfig } from './firebase-config.js';

/* Local-first dispatch register. Price on each bill line is optional; no GST or payment fields. */
(() => {
  'use strict';
  const BIZ = [
    { id: 'sampurn', name: 'Sampurn Kirana', prefix: 'SK', color: '#a5cc62', addr: 'Kalakhet, Mandsaur', gstin: '23AEZPT3880L1ZI' },
    { id: 'surya', name: 'Surya Supplies', prefix: 'SS', color: '#76b7a6' },
    { id: 'dhanraj', name: 'Dhanraj Products', prefix: 'DP', color: '#d1a66c' }
  ];
  const names = { dashboard: 'Overview', bills: 'Dispatch records', catalog: 'Products & customers', analytics: 'Analytics', backup: 'Backup & restore' };
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
      toast('Auto backup folder set. Records will be copied there after every change.');
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
      const r = await Promise.all([all('bills'), all('counters'), all('products'), all('customers')]);
      const data = { app:'Kirana Desk', schemaVersion:1, exportedAt:new Date().toISOString(), auto:true, reason:reason, bills:r[0], counters:r[1], products:r[2], customers:r[3] };
      const fh = await backupDir.getFileHandle('kirana-desk-backup-' + today() + '.json', { create:true });
      const w = await fh.createWritable();
      await w.write(new Blob([JSON.stringify(data, null, 2)], { type:'application/json' }));
      await w.close();
      localStorage.setItem('kiranaDeskLastBackup', new Date().toISOString());
      if(page === 'backup') render();
    }catch(e){ console.warn('Automatic backup failed this time.', e); }
  }
  function scheduleAutoBackup(){ if(!autoEnabled) return; clearTimeout(autoTimer); autoTimer = setTimeout(() => writeAutoBackup('change'), 15000); }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('kirana-desk', 2);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('bills', { keyPath:'id' }).createIndex('date', 'date');
        d.createObjectStore('counters', { keyPath:'id' });
        d.createObjectStore('products', { keyPath:'id' });
        d.createObjectStore('customers', { keyPath:'id' });
        d.createObjectStore('settings', { keyPath:'id' });
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
      return '<tr><td class="strong-cell">' + esc(b.billNumber) + '</td>' + (showForm ? '<td>' + chip(b.businessId) + '</td>' : '') + '<td>' + esc(b.customerName) + '</td><td class="muted-cell">' + dateLabel(b.date) + '</td><td>' + b.items.length + '</td><td>' + number(q) + '</td><td><button class="icon-button" data-action="view-bill" data-id="' + esc(b.id) + '" title="View record">↗</button></td></tr>';
    }).join('') + '</tbody></table></div>';
  }
  async function renderDashboard() {
    const results = await Promise.all([all('bills'), all('products'), all('customers')]), bills = results[0], products = results[1], customers = results[2];
    const chosen = bills.filter(b => form === 'all' || b.businessId === form), year = fy(today()), current = chosen.filter(b => b.financialYear === year);
    const itemLines = current.reduce((s, b) => s + b.items.length, 0);
    const p = products.filter(x => form === 'all' || x.businessId === form), c = customers.filter(x => form === 'all' || x.businessId === form);
    const recent = chosen.sort((a,b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)).slice(0,6);
    $('#page-content').innerHTML = head('GOOD DAY', form === 'all' ? 'Dispatch overview' : esc(biz(form).name), 'Track bills and quantities for FY ' + year + '.', '<div class="head-actions">' + (can('bill') ? '<button class="button button-primary" data-action="new-bill">＋ Create bill</button>' : '') + '</div>') + tabs() +
      '<section class="stats-grid">' + stat('Bills this financial year', current.length, 'Across FY ' + year, '▤') + stat('Items dispatched', itemLines, 'Bill line items this FY', '↗') + stat('Products in catalog', p.length, 'Across selected forms', '◫') + stat('Saved customers', c.length, 'Across selected forms', '♙') + '</section>' +
      (can('bill') ? '<div class="quick-grid">' + BIZ.map(b => '<article class="form-card"><span class="form-code">' + b.prefix + '</span><h3>' + esc(b.name) + '</h3><p>Start a dispatch bill. Numbering is separate for this form.</p><button class="button button-light button-small" data-action="new-bill" data-form="' + b.id + '">Create bill →</button></article>').join('') + '</div>' : '') +
      '<section class="panel activity-panel"><div class="panel-head"><div><div class="panel-title">Recent bills</div><div class="panel-caption">Latest dispatches</div></div><button class="button button-light button-small" data-action="goto-bills">View all bills →</button></div>' + billTable(recent, form === 'all') + '</section>';
  }
  async function renderBills() {
    const bills = (await all('bills')).sort((a,b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
    const visible = bills.filter(b => {
      const q = search.toLowerCase(), match = !q || [b.billNumber,b.customerName,...b.items.map(i => i.productName)].some(v => String(v).toLowerCase().includes(q));
      return (form === 'all' || b.businessId === form) && match && (period === 'all' || (period === 'fy' ? b.financialYear === fy(today()) : b.date.startsWith(period)));
    });
    $('#page-content').innerHTML = head('DISPATCH RECORDS','Dispatch records','Find and review entries without paging through the bill book.','<div class="head-actions">' + (can('bill') ? '<button class="button button-primary" data-action="new-bill">＋ Add record</button>' : '') + '</div>') + tabs() +
      '<section class="panel"><div class="toolbar" style="padding:15px 17px;margin:0;border-bottom:1px solid var(--line)"><div class="toolbar-left"><div class="search-box"><span>⌕</span><input id="bill-search" class="input" placeholder="Search bill, customer, product…" value="' + esc(search) + '"></div><span class="tag gray">' + visible.length + ' bills</span></div><div class="toolbar-right"><select id="bill-period" class="select" style="width:auto"><option value="all">All dates</option><option value="fy" ' + (period === 'fy' ? 'selected' : '') + '>Current FY</option></select></div></div>' + billTable(visible, form === 'all') + '</section>';
  }
  async function renderCatalog() {
    const res = await Promise.all([all('products'),all('customers')]), products=res[0], customers=res[1], list=catalog==='products'?products:customers;
    const shown = list.filter(r => (form==='all'||r.businessId===form) && (!catalogSearch || (r.name+' '+(r.note||'')).toLowerCase().includes(catalogSearch.toLowerCase())));
    const label = catalog==='products'?'product':'customer', records = shown.length ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>'+(catalog==='products'?'PRODUCT':'CUSTOMER')+'</th><th>FORM</th><th>'+(catalog==='products'?'UNIT':'CONTACT / NOTE')+'</th><th>ADDED</th><th></th></tr></thead><tbody>'+shown.map(r => '<tr><td><div class="row-title"><span class="avatar">'+esc(r.name.slice(0,1).toUpperCase())+'</span><span class="strong-cell">'+esc(r.name)+'</span>'+(r.isSample?'<span class="tag gray">SAMPLE</span>':'')+(catalog==='products'&&r.brand?'<span class="tag gray">'+esc(r.brand)+'</span>':'')+'</div></td><td>'+chip(r.businessId)+'</td><td class="muted-cell">'+esc(catalog==='products'?(r.unit||'—'):(r.note||'—'))+'</td><td class="muted-cell">'+dateLabel(r.createdAt.slice(0,10))+'</td><td>'+(can('catalog')?'<button class="icon-button" data-action="edit-record" data-kind="'+catalog+'" data-id="'+esc(r.id)+'" title="Edit">✎</button>':'')+(can('delete')?'<button class="icon-button" data-action="delete-record" data-kind="'+catalog+'" data-id="'+esc(r.id)+'" title="Delete">⌫</button>':'')+'</td></tr>').join('')+'</tbody></table></div>' : empty('No '+catalog+' yet','Add '+(catalog==='products'?'products dispatched from this form':'the people who receive products from this form')+'. They will be searchable on bills.', can('catalog') ? '<button class="button button-primary" data-action="add-record" data-kind="'+catalog+'">＋ Add '+label+'</button>' : '');
    $('#page-content').innerHTML = head('MASTER LISTS','Products & customers','Each form has its own searchable lists.','<div class="head-actions">' + (can('catalog') ? '<button class="button button-primary" data-action="add-record" data-kind="'+catalog+'">＋ Add '+label+'</button>' : '') + '</div>')+tabs()+
      '<div class="tabs-underline"><button class="underline-tab '+(catalog==='products'?'active':'')+'" data-catalog-tab="products">Products ('+products.filter(r=>form==='all'||r.businessId===form).length+')</button><button class="underline-tab '+(catalog==='customers'?'active':'')+'" data-catalog-tab="customers">Customers ('+customers.filter(r=>form==='all'||r.businessId===form).length+')</button></div><section class="panel" style="margin-top:15px"><div class="toolbar" style="padding:14px 17px;margin:0;border-bottom:1px solid var(--line)"><div class="toolbar-left"><div class="search-box"><span>⌕</span><input id="catalog-search" class="input" placeholder="Search '+catalog+'…" value="'+esc(catalogSearch)+'"></div><span class="tag gray">'+shown.length+' records</span></div></div>'+records+'</section>';
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
    return '<section class="panel" style="margin-top:16px"><div class="panel-head"><div><div class="panel-title">Automatic backup on this computer</div><div class="panel-caption">A fresh copy is saved here after every change, even if the shared backend fails.</div></div></div><div style="padding:19px">'+(backupDir?'<span class="tag gray">Folder: '+esc(backupDir.name)+'</span> ':'')+'<button class="button button-primary" data-action="set-backup-folder">'+(backupDir?'Change folder':'Choose auto backup folder')+'</button> '+(backupDir&&!autoEnabled?'<button class="button button-light" data-action="reallow-backup">Allow access again</button>':'')+'<p class="field-hint" style="line-height:1.6;margin-top:10px">'+(auto?'Automatic backup is on. One file per day, always the latest records inside.':'Choose the folder once. Chrome or Edge will ask for permission, then keep the copy fresh on its own.')+'</p></div></section>';
  }
  async function renderBackup() {
    const res=await Promise.all([all('bills'),all('products'),all('customers')]), last=localStorage.getItem('kiranaDeskLastBackup');
    $('#page-content').innerHTML=head('DATA SAFETY','Backup & restore','Create a portable copy of the records on this computer.')+
      '<div class="notice"><strong>How your data is saved:</strong> your bills, customers, and products are stored in this browser on this computer. They work offline. Export backups to protect against device loss or cleared browser data.</div>'+
      '<section class="stats-grid" style="margin-top:16px">'+stat('Bills',res[0].length,'On this computer','▤')+stat('Products',res[1].length,'On this computer','◫')+stat('Customers',res[2].length,'On this computer','♙')+stat('Last backup',last?dateLabel(last.slice(0,10)):'Not yet',last?new Date(last).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}):'Export a copy now','↥')+'</section>'+
      '<div class="split-grid"><section class="panel"><div class="panel-head"><div><div class="panel-title">Create a backup</div><div class="panel-caption">All forms, lists, bills, and bill counters in one file.</div></div></div><div style="padding:19px"><button class="button button-primary" data-action="export-backup">↓ Download backup file</button><p class="field-hint" style="line-height:1.6">Save the file somewhere private and separate. Create a fresh copy after each day’s work.</p></div></section><section class="panel"><div class="panel-head"><div><div class="panel-title">Restore a backup</div><div class="panel-caption">Replace local records with a saved backup.</div></div></div><div style="padding:19px"><label class="button button-light" for="backup-file">Choose backup file</label><input id="backup-file" type="file" accept="application/json,.json" hidden><p class="field-hint" style="line-height:1.6">Restore replaces current local data. Export it first if you want to keep a copy.</p></div></section></section>' + autoBackupPanel() + '</div>'+
      '<div class="backup-steps"><div class="backup-step"><span class="step-number">1</span><b>Export after billing</b><p>Download a fresh copy after each work session.</p></div><div class="backup-step"><span class="step-number">2</span><b>Keep another copy</b><p>Move the file to a separate drive or your brother’s computer.</p></div><div class="backup-step"><span class="step-number">3</span><b>Restore when needed</b><p>Choose the file on the computer where you want the records.</p></div></div>';
  }
  async function render() {
    $('#page-crumb').textContent=names[page]; $$('.main-nav [data-page]').forEach(x=>x.classList.toggle('active',x.dataset.page===page)); $('#bill-nav-count').textContent=String((await all('bills')).length);
    if(page==='dashboard')return renderDashboard(); if(page==='bills')return renderBills(); if(page==='catalog')return renderCatalog(); if(page==='analytics')return renderAnalytics(); if(page==='backup')return renderBackup();
  }
  function go(p){page=p;render().catch(e=>{console.error(e);toast('Could not load this page.',true);});}
  function billDialog(data, editMode) {
    Promise.all([all('products'),all('customers')]).then(res=>{
      const products=res[0].filter(x=>x.businessId===data.businessId), customers=res[1].filter(x=>x.businessId===data.businessId);
      const isSaved=!!data.billNumber, editing=isSaved&&!!editMode&&can('bill');
      const lockCore=isSaved, lockFields=isSaved&&!editing;
      const rows=data.items.map(i=>'<div class="item-row"><input class="input" data-field="productName" value="'+esc(i.productName)+'" placeholder="Search product" required '+(lockFields?'readonly':'')+'><input class="input" type="number" min="0" step="any" data-field="price" value="'+esc(i.price==null?'':i.price)+'" placeholder="price"><input class="input" type="number" min="0.001" step="any" data-field="quantity" value="'+esc(i.quantity)+'" placeholder="0" required '+(lockFields?'readonly':'')+'><input class="input" data-field="unit" value="'+esc(i.unit)+'" placeholder="e.g. bag" required '+(lockFields?'readonly':'')+'>'+(lockFields?'':'<button class="icon-button remove-item" type="button" data-action="remove-item">×</button>')+'</div>').join('');
      const total=data.items.reduce((s,i)=>s+(Number(i.price)>0?Number(i.price)*Number(i.quantity||0):0),0);
      $('#bill-dialog').innerHTML='<div class="modal-head"><div><div class="eyebrow">'+(editing?'EDIT RECORD':(isSaved?'DISPATCH RECORD':'NEW DISPATCH'))+'</div><h2>'+(isSaved?esc(data.billNumber):'Create a bill')+'</h2><p>'+esc(biz(data.businessId).name)+' · '+(isSaved?'FY '+esc(data.financialYear):'Number assigned when saved for FY '+fy(data.date))+'</p></div><button class="icon-button" data-action="close-dialog">✕</button></div>'+
       '<form id="bill-form"><input type="hidden" name="billId" value="'+(isSaved?esc(data.id):'')+'"><div class="modal-body"><div class="form-grid"><div><label class="field-label">FORM</label><input type="hidden" id="bill-business" name="businessId" value="'+esc(data.businessId)+'"><div class="chip-row">'+BIZ.map(b=>'<button type="button" class="pick-chip'+(data.businessId===b.id?' active':'')+'" data-action="pick-business" data-id="'+b.id+'" '+(lockCore?'disabled':'')+'>'+esc(b.name)+'</button>').join('')+'</div></div><div><label class="field-label">BILL DATE</label><input id="bill-date" name="date" class="input" type="date" value="'+esc(data.date)+'" required '+(lockCore?'disabled':'')+'></div><div class="full"><label class="field-label">CUSTOMER / RECEIVER</label><input id="bill-customer" class="input" name="customerName" placeholder="Search or enter customer" value="'+esc(data.customerName)+'" required '+(lockFields?'readonly':'')+'></div></div>'+
       '<div class="items-toolbar"><strong>Products being dispatched</strong>'+(lockFields?'':'<button class="button button-light button-small" type="button" data-action="add-item">＋ Add line</button>')+'</div><div class="items-table"><div class="items-table-head"><div>PRODUCT</div><div>PRICE <span style="font-weight:400">(optional)</span></div><div>QUANTITY</div><div>UNIT</div><div></div></div><div id="bill-items">'+rows+'</div></div>'+
       (isSaved&&total>0?'<div class="modal-section total-line"><span>Amount total (priced lines)</span><b>₹'+number(Math.round(total*100)/100)+'</b></div>':'')+
       '<div class="modal-section"><label class="field-label">NOTE <span style="font-weight:400;color:#97a29b">(optional)</span></label><input id="bill-notes" class="input" value="'+esc(data.notes||'')+'" placeholder="Delivery or dispatch note" '+(lockFields?'readonly':'')+'></div><div class="modal-section"><label class="field-label">BILL PHOTO <span style="font-weight:400;color:#97a29b">(optional)</span></label><div id="bill-photo-area" data-editable="'+(lockFields?'no':'yes')+'" data-bill-id="'+(isSaved?esc(data.id):'')+'"></div><input type="file" id="bill-photo-input" accept="image/*" hidden><input type="hidden" id="bill-photo-value" value="'+(data.photo||'')+'"></div><div class="modal-section helper-box">'+(isSaved?(editing?'Update the customer, items, or note. Bill number and date stay fixed.':'Saved dispatch record. Price is optional on each line.'):'Bill number is assigned on save. Price on each line is optional. No GST.')+'</div></div>'+
       '<div class="modal-foot">'+(isSaved&&!editing?'<button class="button button-light" type="button" data-action="print-bill" data-id="'+esc(data.id)+'">⎙ Print</button>':'<span class="field-hint">'+(editing?'Bill number stays the same':'Product · price (optional) · quantity · unit')+'</span>')+'<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end"><button class="button button-light" type="button" data-action="close-dialog">Close</button>'+(editing?'<button class="button button-primary" type="submit">Save changes</button>':(!isSaved?'<button class="button button-primary" type="submit">Save record</button>':(can('bill')?'<button class="button button-primary" type="button" data-action="edit-bill" data-id="'+esc(data.id)+'">Edit</button>':'')))+(isSaved&&!editing&&can('delete')?'<button class="button button-danger" type="button" data-action="delete-bill" data-id="'+esc(data.id)+'">Delete</button>':'')+'</div></div></form>';
      renderPhotoArea(data.photo||'', !lockFields);
    }).catch(e=>{console.error(e);toast('Could not load your catalog.',true);});
  }
  function newBill(key) { const businessId=key||(form==='all'?'sampurn':form); billDialog({businessId,date:today(),customerName:'',items:[{productName:'',quantity:'',unit:''}],notes:''}); $('#bill-dialog').showModal(); }
  function recordDialog(kind, key, existing) {
    const product=kind==='products', bizId=key||(existing&&existing.businessId)||(form==='all'?'sampurn':form);
    $('#record-dialog').innerHTML='<div class="modal-head"><div><div class="eyebrow">FORM CATALOG</div><h2>'+(existing?'Edit ':'Add ')+(product?'product':'customer')+'</h2><p>This record belongs to the selected form only.</p></div><button class="icon-button" data-action="close-dialog">✕</button></div><form id="record-form"><div class="modal-body"><div class="form-grid"><div class="full"><label class="field-label">FORM</label><input type="hidden" name="businessId" value="'+esc(bizId)+'"><div class="chip-row">'+BIZ.map(b=>'<button type="button" class="pick-chip'+(b.id===bizId?' active':'')+'" data-action="pick-record-business" data-id="'+b.id+'">'+esc(b.name)+'</button>').join('')+'</div></div><div class="full"><label class="field-label">'+(product?'PRODUCT NAME':'CUSTOMER NAME')+'</label><input class="input" name="name" value="'+esc(existing&&existing.name||'')+'" required maxlength="100" placeholder="'+(product?'e.g. Basmati rice':'e.g. Sharma Stores')+'"></div>'+(product?'<div class="full"><label class="field-label">DEFAULT UNIT <span style="font-weight:400">(optional)</span></label><input class="input" name="unit" value="'+esc(existing&&existing.unit||'')+'" list="unit-list" placeholder="bag, kg, box"><datalist id="unit-list"><option value="bag"><option value="kg"><option value="box"><option value="piece"><option value="quintal"></datalist></div><div class="full"><label class="field-label">BRAND <span style="font-weight:400">(optional)</span></label><input class="input" name="brand" value="'+esc(existing&&existing.brand||'')+'" placeholder="e.g. Fortune"></div>':'<div class="full"><label class="field-label">CONTACT / NOTE <span style="font-weight:400">(optional)</span></label><input class="input" name="note" value="'+esc(existing&&existing.note||'')+'" placeholder="Phone or delivery note"></div>')+'</div></div><div class="modal-foot"><span></span><div style="display:flex;gap:8px"><button class="button button-light" type="button" data-action="close-dialog">Cancel</button><button class="button button-primary" type="submit">Save</button></div></div><input type="hidden" name="kind" value="'+kind+'"><input type="hidden" name="recordId" value="'+esc(existing&&existing.id||'')+'"></form>';
    $('#record-dialog').showModal();
  }
  async function backup() {
    const r=await Promise.all([all('bills'),all('counters'),all('products'),all('customers')]), data={app:'Kirana Desk',schemaVersion:1,exportedAt:new Date().toISOString(),bills:r[0],counters:r[1],products:r[2],customers:r[3]};
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})), a=document.createElement('a'); a.href=url; a.download='kirana-desk-backup-'+today()+'.json'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
    localStorage.setItem('kiranaDeskLastBackup',new Date().toISOString()); toast('Backup downloaded. Save another copy on a separate device.'); if(page==='backup')render();
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
    if(!confirm('Restore '+data.bills.length+' bills, '+data.products.length+' products, and '+data.customers.length+' customers? Current records on this computer will be replaced.'))return;
    await new Promise((resolve,reject)=>{const tx=db.transaction(['bills','counters','products','customers'],'readwrite');['bills','counters','products','customers'].forEach(k=>{const s=tx.objectStore(k);s.clear();data[k].forEach(x=>s.put(x));});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});
    localStorage.setItem('kiranaDeskLastBackup',data.exportedAt||new Date().toISOString()); localStorage.setItem('kiranaDeskSampleSeeded','yes'); scheduleAutoBackup(); toast('Backup restored.'); render();
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
    const stores=['bills','counters','products','customers'];
    const local=await Promise.all(stores.map(localAll)), remote=await Promise.all(stores.map(window.KiranaCloud.list));
    const localCount=local.reduce((sum,rows)=>sum+rows.length,0), remoteCount=remote.reduce((sum,rows)=>sum+rows.length,0);
    if(remoteCount===0&&localCount>0){
      stores.forEach((store,index)=>local[index].forEach(record=>window.KiranaCloud.write(store,record).catch(console.warn)));
      return;
    }
    await Promise.all(stores.map((store,index)=>replaceLocal(store,remote[index])));
  }
  function printChoice(b) {
    $('#bill-dialog').innerHTML = '<div class="modal-head"><div><div class="eyebrow">PRINT</div><h2>Bill ' + esc(b.billNumber) + '</h2><p>This bill has prices. Print with price or without?</p></div><button class="icon-button" data-action="close-dialog">✕</button></div><div class="modal-body"><div style="display:flex;flex-direction:column;gap:10px"><button class="button button-primary" type="button" data-action="print-priced" data-id="' + esc(b.id) + '">With price</button><button class="button button-light" type="button" data-action="print-unpriced" data-id="' + esc(b.id) + '">Without price</button></div></div>';
  }
  function printBill(b, withPrice) {
    const bb = biz(b.businessId);
    all('products').then(products => {
      const brandMap = {};
      products.forEach(p => { brandMap[(p.businessId || '') + '|' + String(p.name || '').toLowerCase()] = p.brand || ''; });
      const brandOf = i => brandMap[(b.businessId || '') + '|' + String(i.productName || '').toLowerCase()] || '';
      const money = v => '\u20B9' + new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v) || 0);
      const anyPrice = b.items.some(i => Number(i.price) > 0);
      const showPrice = !!withPrice && anyPrice;
      const q2 = v => Number(v || 0).toFixed(2);
      const dmy = s => { const d = new Date(s + 'T00:00:00'); return isNaN(d) ? esc(s || '') : String(d.getDate()).padStart(2, '0') + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + d.getFullYear(); };
      const rows = b.items.map((i, n) => { const br = brandOf(i); return '<tr><td class="c">' + (n + 1) + '</td><td>' + esc(i.productName) + (br ? '<div class="bname">' + esc(br) + '</div>' : '') + '</td><td class="c">' + q2(i.quantity) + '&nbsp;' + esc(i.unit || '') + '</td>' + (showPrice ? '<td class="r">' + (Number(i.price) > 0 ? money(i.price) : '') + '</td><td class="r">' + (Number(i.price) > 0 ? money(Number(i.price) * Number(i.quantity || 0)) : '') + '</td>' : '') + '</tr>'; }).join('');
      const total = b.items.reduce((s, i) => s + (Number(i.price) > 0 ? Number(i.price) * Number(i.quantity || 0) : 0), 0);
      const subBits = [];
      if (bb.addr) subBits.push(esc(bb.addr));
      if (bb.gstin) subBits.push('GSTIN: ' + esc(bb.gstin));
      const html = '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(b.billNumber) + '</title><style>body{font:12.5px/1.55 Arial,Helvetica,sans-serif;color:#111;margin:16px}.shop{text-align:center;font-size:19px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;margin:0}.shopsub{text-align:center;font-size:12px;margin:2px 0 0}.doc-title{text-align:center;font-size:14px;font-weight:bold;letter-spacing:2px;margin:12px 0 10px;border-top:2px solid #111;border-bottom:2px solid #111;padding:6px 0}.head{width:100%;border-collapse:collapse}.head td{border:1px solid #111;padding:8px 10px;vertical-align:top;width:58%}.head td.right{width:42%}.line{margin:3px 0}.blank{display:inline-block;border-bottom:1px solid #111;min-width:140px}table.items{width:100%;border-collapse:collapse}table.items th,table.items td{border:1px solid #111;padding:5px 8px;font-size:12px;text-align:left}table.items th{background:#eee}.c{text-align:center}.r{text-align:right;white-space:nowrap}.bname{font-size:11px;color:#555}.tot td{font-weight:bold;border-top:2px solid #111}.terms{border:1px solid #111;padding:6px 10px;font-size:11px;margin-top:12px}.terms b{display:block;margin-bottom:2px}.terms p{margin:1px 0}.sign{margin-top:34px;text-align:right;font-size:12px}@page{margin:12mm}</style></head><body>'
        + '<p class="shop">' + esc(bb.name) + '</p>'
        + (subBits.length ? '<p class="shopsub">' + subBits.join(' &nbsp;·&nbsp; ') + '</p>' : '')
        + '<div class="doc-title">Delivery Challan</div>'
        + '<table class="head"><tr><td><div class="line">Party&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;: <b>' + esc(b.customerName) + '</b></div>'
        + '<div class="line">Address&nbsp;&nbsp;: <span class="blank">&nbsp;</span></div>'
        + '<div class="line">Mobile No.: <span class="blank">&nbsp;</span></div></td>'
        + '<td class="right"><div class="line">DC No.&nbsp;&nbsp;: <b>' + esc(b.billNumber) + '</b></div>'
        + '<div class="line">DC.Date&nbsp;: <b>' + dmy(b.date) + '</b></div>'
        + '<div class="line">Transport: <span class="blank">&nbsp;</span></div></td></tr></table>'
        + '<table class="items"><thead><tr><th style="width:6%">S.N</th><th style="width:50%">Description of Goods</th><th style="width:18%">Qty.Unit</th>' + (showPrice ? '<th style="width:13%" class="r">Price</th><th style="width:13%" class="r">Amount</th>' : '') + '</tr></thead><tbody>' + rows
        + (showPrice && total > 0 ? '<tr class="tot"><td colspan="2"></td><td class="c">Grand Total</td><td></td><td class="r">' + money(total) + '</td></tr>' : '')
        + '</tbody></table>'
        + '<div class="terms"><b>Terms &amp; Conditions</b><p>1. Kindly check item from challan.</p><p>2. Cash Transaction only. If credit, payment should be made within 7 days from the bill date.</p><p>3. Goods once sold will not be taken back.</p><p>4. Subject to &quot;Mandsaur&quot; Jurisdiction.</p></div>'
        + '<div class="sign">Receiver\u2019s Signature</div>'
        + '</body></html>';
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
  let sugBox=null;
  function closeSug(){ if(sugBox){sugBox.remove();sugBox=null;} }
  function openSug(input, values){
    closeSug();
    const q=input.value.trim().toLowerCase();
    const picks=values.filter(v=>!q||v.toLowerCase().includes(q)).slice(0,8);
    if(!picks.length)return;
    const rect=input.getBoundingClientRect();
    const box=document.createElement('div'); box.className='suggestions sug-fixed';
    picks.forEach(v=>{
      const b=document.createElement('button'); b.type='button'; b.className='suggestion'; b.textContent=v;
      const pick=e=>{e.preventDefault();input.value=v;input.dispatchEvent(new Event('change',{bubbles:true}));closeSug();input.focus();};
      b.addEventListener('mousedown',pick);
      b.addEventListener('touchstart',pick,{passive:false});
      box.append(b);
    });
    document.body.append(box);
    const bh=Math.min(box.scrollHeight,160);
    let top=rect.bottom+4;
    if(top+bh>window.innerHeight-8)top=Math.max(8,rect.top-bh-4);
    box.style.top=top+'px'; box.style.left=Math.max(8,rect.left)+'px'; box.style.width=rect.width+'px';
    sugBox=box;
  }
  function sugValuesFor(input){
    if(input.id==='bill-customer')return all('customers').then(rows=>rows.filter(x=>form==='all'||x.businessId===(($('#bill-business')||{}).value)||x.businessId===undefined).map(x=>x.name));
    if(input.dataset.field==='productName')return all('products').then(rows=>rows.filter(x=>x.businessId===(($('#bill-business')||{}).value)||x.businessId===undefined).map(x=>x.name));
    if(input.dataset.field==='unit')return Promise.resolve(['bag','kg','g','litre','box','piece','quintal','tonne','packet','dozen']);
    return Promise.resolve([]);
  }
  function maybeSug(target){ if(target&&(target.id==='bill-customer'||target.dataset.field==='productName'||target.dataset.field==='unit')){ if(target.readOnly||target.disabled){closeSug();return;} sugValuesFor(target).then(vals=>{ if(document.activeElement===target)openSug(target,vals); }); } }
  document.addEventListener('focusin',e=>maybeSug(e.target));
  document.addEventListener('input',e=>{ if(e.target&&(e.target.id==='bill-customer'||e.target.dataset.field==='productName'||e.target.dataset.field==='unit')){ if(e.target.value.trim()===''){maybeSug(e.target);}else{sugValuesFor(e.target).then(vals=>openSug(e.target,vals));} } });
  document.addEventListener('click',e=>{ if(sugBox&&!e.target.closest('.sug-fixed'))closeSug(); },true);
  window.addEventListener('scroll',closeSug,true);
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
    if(x==='export-analytics')exportAnalytics().catch(()=>toast('Could not export this report.',true));
    if(x==='add-item')$('#bill-items').insertAdjacentHTML('beforeend','<div class="item-row"><input class="input" data-field="productName" placeholder="Search product" required><input class="input" type="number" min="0" step="any" data-field="price" placeholder="price"><input class="input" type="number" min="0.001" step="any" data-field="quantity" placeholder="0" required><input class="input" data-field="unit" placeholder="e.g. bag" required><button class="icon-button" type="button" data-action="remove-item">×</button></div>');
    if(x==='remove-item'){const rows=$$('.item-row',$('#bill-items'));if(rows.length>1)a.closest('.item-row').remove();else toast('A bill needs one item.');}
    if(x==='view-bill')all('bills').then(items=>{const b=items.find(v=>v.id===a.dataset.id);if(b){billDialog(b);$('#bill-dialog').showModal();}});
    if(x==='pick-business'){const inp=$('#bill-business');if(inp&&!inp.disabled){inp.value=a.dataset.id;$$('.pick-chip',a.closest('.chip-row')).forEach(c=>c.classList.toggle('active',c===a));inp.dispatchEvent(new Event('change',{bubbles:true}));}}
    if(x==='pick-record-business'){const inp=a.closest('form').querySelector('[name="businessId"]');if(inp){inp.value=a.dataset.id;$$('.pick-chip',a.closest('.chip-row')).forEach(c=>c.classList.toggle('active',c===a));}}
    if(x==='edit-bill')all('bills').then(items=>{const b=items.find(v=>v.id===a.dataset.id);if(b){$('#bill-dialog').close();billDialog(b,true);$('#bill-dialog').showModal();}});
    if(x==='view-photo'){const local=$('#bill-photo-value'),src2=local?local.value:'';if(src2){photoView(src2,a.dataset.id||'');}else if(a.dataset.id){all('bills').then(items=>{const b=items.find(v=>v.id===a.dataset.id);if(b&&b.photo)photoView(b.photo,a.dataset.id);});}}
    if(x==='back-to-bill')all('bills').then(items=>{const b=items.find(v=>v.id===a.dataset.id);if(b){billDialog(b);}});
    if(x==='remove-photo'){const v=$('#bill-photo-value');if(v)v.value='';const area=$('#bill-photo-area');renderPhotoArea('',area&&area.dataset.editable!=='no');}
    if(x==='print-bill')all('bills').then(items=>{const b=items.find(v=>v.id===a.dataset.id);if(!b)return;if(b.items.some(i=>Number(i.price)>0))printChoice(b);else printBill(b,false);});
    if(x==='print-priced'||x==='print-unpriced')all('bills').then(items=>{const b=items.find(v=>v.id===a.dataset.id);if(b)printBill(b,x==='print-priced');});
    if(x==='delete-bill'&&confirm('Delete this bill? Its number remains reserved and will never be reused.'))del('bills',a.dataset.id).then(()=>{$('#bill-dialog').close();toast('Bill deleted. Number remains reserved.');render();});
    if(x==='delete-record'&&confirm('Delete this catalog entry? Existing bills will not change.'))del(a.dataset.kind,a.dataset.id).then(()=>{toast('Catalog entry removed.');render();});

    if(x==='set-backup-folder')pickBackupDir();
    if(x==='reallow-backup')reallowBackup();
    if(x==='pick-role'&&ROLES[a.dataset.role]){role=a.dataset.role;$('#record-dialog').close();applyRole();render();saveUserRole(window.KiranaCloud&&window.KiranaCloud.user?window.KiranaCloud.user.email:'');toast('Role saved.');}
  });
  document.addEventListener('input',e=>{
    if(e.target.id==='bill-search'){search=e.target.value;const n=e.target.value.length;renderBills().then(()=>{const field=$('#bill-search');if(field){field.focus();field.setSelectionRange(n,n);}});}
    if(e.target.id==='catalog-search'){catalogSearch=e.target.value;const n=e.target.value.length;renderCatalog().then(()=>{const field=$('#catalog-search');if(field){field.focus();field.setSelectionRange(n,n);}});}
  });
  document.addEventListener('change',e=>{
    if(e.target.id==='bill-period'){period=e.target.value;renderBills();}
    if(e.target.id==='analytics-period'){analyticsPeriod=e.target.value;renderAnalytics();}
    if(e.target.id==='bill-business'){const key=e.target.value;billDialog({businessId:key,date:$('#bill-date').value,customerName:$('#bill-customer').value,items:$$('.item-row',$('#bill-items')).map(r=>Object.fromEntries($$('[data-field]',r).map(i=>[i.dataset.field,i.value]))),notes:$('#bill-notes').value,photo:$('#bill-photo-value')?$('#bill-photo-value').value:''});}
    if(e.target.dataset.field==='productName'){const name=e.target.value.trim().toLowerCase(), row=e.target.closest('.item-row'), selectedBusiness=$('#bill-business')?.value;all('products').then(items=>{const item=items.find(p=>p.businessId===selectedBusiness&&p.name.toLowerCase()===name);const unit=$('[data-field="unit"]',row);if(item&&item.unit&&unit&&!unit.value)unit.value=item.unit;});}
    if(e.target.id==='bill-photo-input'&&e.target.files[0]){const f=e.target.files[0],area=$('#bill-photo-area'),editable=area&&area.dataset.editable!=='no';toast('Preparing photo…');compressImage(f).then(d=>{const v=$('#bill-photo-value');if(v)v.value=d;renderPhotoArea(d,editable);toast('Photo attached.');}).catch(()=>toast('Could not attach that photo.',true));e.target.value='';}
    if(e.target.id==='backup-file'&&e.target.files[0])restore(e.target.files[0]).catch(err=>{console.error(err);toast(err.message||'Could not restore backup.',true);e.target.value='';});
  });
  document.addEventListener('submit',async e=>{
    if(e.target.id==='record-form'){
      e.preventDefault();const f=new FormData(e.target), kind=f.get('kind'), oldId=f.get('recordId'), prior=oldId?(await all(kind)).find(x=>x.id===oldId):null, r={id:oldId||uid(),businessId:f.get('businessId'),name:String(f.get('name')).trim(),createdAt:prior?prior.createdAt:new Date().toISOString()};
      if(prior&&prior.isSample&&prior.name===r.name)r.isSample=true;
      if(kind==='products'){r.unit=String(f.get('unit')||'').trim();r.brand=String(f.get('brand')||'').trim();await put('products',r);}else{r.note=String(f.get('note')||'').trim();await put('customers',r);}
      $('#record-dialog').close();toast('Saved to this form.');render();
    }
    if(e.target.id==='bill-form'){
      e.preventDefault();const rows=$$('.item-row',e.target), items=rows.map(r=>{const pr=$('[data-field="price"]',r);return {productName:$('[data-field="productName"]',r).value.trim(),quantity:Number($('[data-field="quantity"]',r).value),unit:$('[data-field="unit"]',r).value.trim(),price:pr&&pr.value!==''?Number(pr.value):null};});
      const photoVal=$('#bill-photo-value'),data={businessId:$('#bill-business').value,date:$('#bill-date').value,customerName:$('#bill-customer').value.trim(),notes:$('#bill-notes').value.trim(),items,photo:photoVal&&photoVal.value?photoVal.value:null};
      const idInput=e.target.querySelector('[name="billId"]'), billId=idInput?idInput.value:'';
      if(!data.customerName||!data.date||items.some(i=>!i.productName||!(i.quantity>0)||!i.unit)){toast('Fill in the customer, date, product, quantity, and unit.',true);return;}
      try{
        if(billId){const existing=(await all('bills')).find(b=>b.id===billId);if(existing){existing.customerName=data.customerName;existing.notes=data.notes;existing.items=items;existing.photo=data.photo;await put('bills',existing);$('#bill-dialog').close();toast(existing.billNumber+' updated.');render();return;}}
        const saved=await makeBill(data);$('#bill-dialog').close();toast(saved.billNumber+' saved.');billDialog(saved);$('#bill-dialog').showModal();render();
      }catch(err){console.error(err);toast(window.KiranaCloud&&window.KiranaCloud.configured?'Could not save. Check internet; shared bill numbering needs a connection.':'Could not save bill.',true);}
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
            await reconcileCloud();await seedSamples();
            subscriptions=window.KiranaCloud.listen(async(store,records)=>{
              await replaceLocal(store,records);
              if(document.visibilityState==='visible')render().catch(console.warn);
            },error=>{console.warn('Cloud listener unavailable.',error);$('#online-label').textContent='Sync pending';});
            await render();
          }catch(error){console.error(error);toast('Could not load shared records. Check the Firebase setup.',true);}
        });
      }else{await seedSamples();$('#online-label').textContent=navigator.onLine?'Local only':'Working offline';await render();}
      if('serviceWorker'in navigator&&location.protocol!=='file:')navigator.serviceWorker.register('./sw.js').catch(console.info);
    }
    catch(err){console.error(err);$('#page-content').innerHTML=empty('Local storage unavailable','Open the app through a local web server or secure website. Browser storage is unavailable in this page context.');}
  }
  start();
})();
