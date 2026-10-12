/* Optimizador de compras — lógica principal (sin dependencias) */
'use strict';
const STORE_KEY = 'optcompras-v1';
const LEVELS = { A: 4, B: 3, C: 2, D: 1 };
const CHANNEL_LABEL = { online: 'Tienda online', b2b: 'IndiaMART / cotización', telegram: 'Telegram / foro', directorio: 'Directorio / PDF' };
let S = null;          // estado completo (datos + ajustes)
let DEFAULTS = null;   // datos de fábrica (data.json)

/* ---------- utilidades ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = n => (n == null || isNaN(n)) ? '—' : n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const num = v => { const x = parseFloat(String(v).replace(',', '.')); return isNaN(x) ? null : x; };
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2200); }
function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { /* almacenamiento no disponible */ } }
function load() { try { const r = localStorage.getItem(STORE_KEY); return r ? JSON.parse(r) : null; } catch (e) { return null; } }
const vendorById = id => S.vendors.find(v => v.id === id);
const productById = id => S.products.find(p => p.id === id);
function offerEUR(o) { const fx = S.fx[o.currency] || 1; return o.price * o.units / fx; }
function vendorShipping(v) { return v.shipping != null ? { value: v.shipping, est: false } : { value: v.shippingEstimate ?? 0, est: true }; }
function payOK(v) { return /tarjeta|paypal/i.test(v.payment || ''); }

/* ---------- carga ---------- */
async function init() {
  try {
    const r = await fetch('data.json', { cache: 'no-cache' });
    if (r.ok) DEFAULTS = await r.json();
  } catch (e) { DEFAULTS = null; }
  S = load();
  if (!S && DEFAULTS) S = structuredClone(DEFAULTS);
  if (!S) S = { version: 1, dataDate: '', fx: { USD: 1.1206, INR: 108.3965, EUR: 1 }, products: [], vendors: [], offers: [], excluded: [] };
  S.settings = Object.assign({ maxPkg: 8, minLevel: 'C', channels: ['online', 'b2b', 'telegram', 'directorio'], onlyCard: false }, S.settings || {});
  bindTabs(); bindPlan(); bindSettings();
  renderAll();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

function renderAll() {
  $('#dataInfo').textContent = S.products.length
    ? `${S.products.length} productos · ${S.vendors.length} proveedores · ${S.offers.length} ofertas · datos del ${S.dataDate || '—'}`
    : 'Sin datos: importa un archivo .json en Ajustes';
  renderPlanControls(); renderProducts(); renderVendors(); renderSettings();
  if (!S.products.length) $('#results').innerHTML = `<div class="card"><h2>Sin datos todavía</h2><p>Esta app no incluye la tabla de proveedores. Ve a <b>Ajustes → Importar datos (.json)</b> y elige el archivo de datos que tienes en el móvil. Se guardará solo en este dispositivo.</p></div>`;
}

/* ---------- pestañas ---------- */
function bindTabs() {
  $$('.tabs button').forEach(b => b.addEventListener('click', () => {
    $$('.tabs button').forEach(x => x.setAttribute('aria-selected', x === b ? 'true' : 'false'));
    $$('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
    window.scrollTo({ top: 0 });
  }));
}

/* ---------- optimizador ---------- */
function eligibleVendors() {
  const st = S.settings;
  return S.vendors.filter(v => v.active
    && st.channels.includes(v.channel)
    && (LEVELS[v.level] || 0) >= LEVELS[st.minLevel]
    && (!st.onlyCard || payOK(v)));
}

function optimize() {
  const st = S.settings;
  const prods = S.products.filter(p => p.active);
  const vend = eligibleVendors();
  const vIndex = new Map(vend.map((v, i) => [v.id, i]));
  const perProd0 = prods.map(p => S.offers
    .filter(o => o.active && o.productId === p.id && vIndex.has(o.vendorId))
    .map(o => ({ o, vi: vIndex.get(o.vendorId), cost: offerEUR(o) * (p.qty || 1) }))
    .sort((a, b) => a.cost - b.cost));
  // proveedores candidatos, ordenados por nº de productos en los que son los más baratos (mejores primero)
  const wins = new Map();
  perProd0.forEach(l => l.forEach((x, j) => wins.set(x.vi, (wins.get(x.vi) || 0) + (j === 0 ? 10 : 1))));
  const cand = [...wins.keys()].sort((a, b) => wins.get(b) - wins.get(a));
  if (cand.length > 30) return { error: 'Demasiados proveedores elegibles (máx. 30). Desactiva algunos.' };
  const n = cand.length;
  const bitOf = new Map(cand.map((vi, k) => [vi, 1 << k]));
  const full = n === 31 ? 0x7fffffff : (2 ** n) - 1;
  // por producto: ofertas con su bit y coste mínimo posible (con cupón) para la cota inferior
  const perProd = perProd0.map(l => l.map(x => {
    const v = vend[x.vi];
    return { ...x, bit: bitOf.get(x.vi), lb: x.cost * (1 - (v.couponPct || 0) / 100) };
  }));
  const perProdLB = perProd.map(l => [...l].sort((a, b) => a.lb - b.lb));
  const maxK = Math.min(st.maxPkg, n);
  const ship = vend.map(v => vendorShipping(v));
  const KEEP = 6, best = [];
  let evaluated = 0, nodes = 0;
  const sub = new Float64Array(vend.length);

  function evalMask(mask) {
    evaluated++;
    sub.fill(0);
    const picks = [];
    let uncovered = 0;
    for (let pi = 0; pi < perProdLB.length; pi++) {
      const l = perProdLB[pi]; let pick = null;
      for (let j = 0; j < l.length; j++) if (mask & l[j].bit) { pick = l[j]; break; }
      if (!pick) { if (l.length) uncovered++; continue; }
      sub[pick.vi] += pick.cost; picks.push({ p: prods[pi], ...pick });
    }
    let total = 0, shipT = 0, coupon = 0, estShip = 0;
    const orders = [];
    for (let k = 0; k < n; k++) {
      if (!(mask & (1 << k))) continue;
      const vi = cand[k], v = vend[vi];
      if (sub[vi] === 0) return null;                       // proveedor sin uso: combinación no mínima
      const c = sub[vi] * (v.couponPct || 0) / 100, net = sub[vi] - c;
      if (v.minOrder && net < v.minOrder) return null;       // no alcanza el pedido mínimo
      const s = (v.freeFrom && net >= v.freeFrom) ? 0 : ship[vi].value;
      if (s && ship[vi].est) estShip++;
      total += net + s; shipT += s; coupon += c;
      orders.push({ v, subtotal: sub[vi], coupon: c, ship: s, shipEst: ship[vi].est && s > 0, lines: picks.filter(x => x.vi === vi) });
    }
    return { total, shipT, coupon, uncovered, orders, estShip, score: total + uncovered * 1e6 };
  }
  function push(r) {
    if (!r) return;
    best.push(r); best.sort((a, b) => a.score - b.score);
    if (best.length > KEEP) best.pop();
  }
  // cota inferior: cada producto al menor precio posible entre los proveedores aún permitidos; envíos ≥ 0
  function lowerBound(allowed) {
    let lb = 0, unc = 0;
    for (let pi = 0; pi < perProdLB.length; pi++) {
      const l = perProdLB[pi]; if (!l.length) continue;
      let found = false;
      for (let j = 0; j < l.length; j++) if (allowed & l[j].bit) { lb += l[j].lb; found = true; break; }
      if (!found) unc++;
    }
    return lb + unc * 1e6;
  }
  // ramificación y poda: incluir/excluir cada proveedor
  function rec(k, mask, depth) {
    nodes++;
    const allowed = depth === maxK ? mask : (mask | (full & ~((1 << k) - 1)));
    if (best.length === KEEP && lowerBound(allowed) >= best[KEEP - 1].score) return;
    if (k === n || depth === maxK) { if (depth > 0) push(evalMask(mask)); return; }
    rec(k + 1, mask | (1 << k), depth + 1);
    rec(k + 1, mask, depth);
  }
  const t0 = performance.now();
  rec(0, 0, 0);
  return { best, evaluated, nodes, ms: Math.round(performance.now() - t0), total: prods.length, noOffer: prods.filter((p, i) => !perProd[i].length) };
}

function bindPlan() {
  $('#btnCalc').addEventListener('click', () => {
    readPlanControls();
    const res = optimize();
    renderResults(res);
  });
}
function readPlanControls() {
  const st = S.settings;
  st.maxPkg = Math.max(1, Math.min(10, parseInt($("#maxPkg").value) || 8));
  st.minLevel = $('#minLevel').value;
  st.channels = $$('.chan').filter(c => c.checked).map(c => c.value);
  st.onlyCard = $('#onlyCard').checked;
  save();
}
function renderPlanControls() {
  const st = S.settings;
  $('#maxPkg').value = st.maxPkg; $('#minLevel').value = st.minLevel;
  $$('.chan').forEach(c => c.checked = st.channels.includes(c.value));
  $('#onlyCard').checked = st.onlyCard;
}

function orderText(r) {
  const out = [];
  r.orders.forEach(o => {
    out.push(`== ${o.v.name} ==`);
    o.lines.forEach(l => out.push(`- ${l.p.name}: ${l.o.desc}${(l.p.qty || 1) > 1 ? ' ×' + l.p.qty : ''} — ${eur(l.cost)}`));
    out.push(`Subtotal ${eur(o.subtotal)}${o.coupon ? ' · cupón −' + eur(o.coupon) : ''} · envío ${o.ship ? eur(o.ship) + (o.shipEst ? ' (estimado)' : '') : 'gratis'}`);
    out.push('');
  });
  out.push(`TOTAL ${eur(r.total)}`);
  return out.join('\n');
}

function renderResults(res) {
  const box = $('#results');
  if (res.error) { box.innerHTML = `<div class="card"><p>${esc(res.error)}</p></div>`; return; }
  $('#calcInfo').textContent = `${res.evaluated.toLocaleString('es-ES')} combinaciones completas evaluadas (${res.nodes.toLocaleString('es-ES')} nodos) en ${res.ms} ms. Óptimo exacto en precio de productos; el envío gratis y los pedidos mínimos se aplican sobre la asignación más barata.`;
  if (!res.best.length) { box.innerHTML = `<div class="card empty">No hay ninguna combinación válida con estas condiciones. Prueba a permitir más paquetes o más canales.</div>`; return; }
  const r = res.best[0];
  const warn = [];
  if (r.uncovered) warn.push(`<span class="tag bad">${r.uncovered} producto(s) sin cubrir con ${S.settings.maxPkg} paquetes</span>`);
  if (res.noOffer.length) warn.push(`<span class="tag bad">Sin oferta disponible: ${res.noOffer.map(p => esc(p.name)).join(', ')}</span>`);
  if (r.estShip) warn.push(`<span class="tag warn">${r.estShip} envío(s) estimado(s)</span>`);
  if (r.orders.some(o => o.v.channel === 'b2b')) warn.push(`<span class="tag warn">Incluye precios de IndiaMART: pedir cotización</span>`);
  let html = `<div class="card">
    <h2>Plan más barato</h2>
    <div class="total">${eur(r.total)}</div>
    <div class="kpis">
      <div class="kpi"><b>${r.orders.length}</b><span>paquetes</span></div>
      <div class="kpi"><b>${eur(r.total - r.shipT)}</b><span>productos (con cupón)</span></div>
      <div class="kpi"><b>${eur(r.shipT)}</b><span>envíos</span></div>
      <div class="kpi"><b>${eur(r.coupon)}</b><span>ahorro cupones</span></div>
    </div>
    <div>${warn.join('')}</div>`;
  r.orders.forEach(o => {
    html += `<div class="vendor-order"><header><h3>${esc(o.v.name)}</h3><b>${eur(o.subtotal - o.coupon + o.ship)}</b></header>
      <div><span class="tag">${esc(CHANNEL_LABEL[o.v.channel] || o.v.channel)}</span><span class="tag">Pago: ${esc(o.v.payment || '—')}</span><span class="tag ${o.v.level === 'D' ? 'bad' : ''}">Nivel ${esc(o.v.level)}</span></div>
      <table class="lines">${o.lines.map(l => `<tr><td>${esc(l.p.name)}<br><small class="hint">${esc(l.o.desc)}${(l.p.qty || 1) > 1 ? ' ×' + l.p.qty : ''}</small></td><td class="num">${eur(l.cost)}</td></tr>`).join('')}
      ${o.coupon ? `<tr><td>Cupón ${o.v.couponPct}%</td><td class="num">−${eur(o.coupon)}</td></tr>` : ''}
      <tr><td>Envío${o.shipEst ? ' (estimado)' : ''}</td><td class="num">${o.ship ? eur(o.ship) : 'gratis'}</td></tr></table></div>`;
  });
  html += `<div class="row wrap" style="margin-top:12px"><button class="ghost" id="copyPlan">Copiar pedido</button></div></div>`;
  if (res.best.length > 1) {
    html += `<div class="card"><h2>Alternativas</h2>${res.best.slice(1).map(a => `<div class="alt"><span>${a.orders.map(o => esc(o.v.name.split(' (')[0])).join(' + ')}${a.uncovered ? ` <span class="tag bad">${a.uncovered} sin cubrir</span>` : ''}</span><b>${eur(a.total)} <small class="hint">(+${eur(a.total - r.total)})</small></b></div>`).join('')}</div>`;
  }
  box.innerHTML = html;
  $('#copyPlan').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(orderText(r)); toast('Pedido copiado'); } catch (e) { toast('No se pudo copiar'); }
  });
}

/* ---------- productos ---------- */
function renderProducts() {
  const list = $('#productList');
  if (!S.products.length) { list.innerHTML = '<div class="empty">Sin productos.</div>'; return; }
  const open = new Set($$('details.prod[open]').map(d => d.dataset.id));
  list.innerHTML = S.products.map(p => {
    const offs = S.offers.filter(o => o.productId === p.id);
    const act = offs.filter(o => o.active && vendorById(o.vendorId)?.active);
    const min = act.length ? Math.min(...act.map(o => offerEUR(o) * (p.qty || 1))) : null;
    return `<details class="prod" data-id="${p.id}" ${open.has(String(p.id)) ? 'open' : ''}>
      <summary><input type="checkbox" class="pActive" data-id="${p.id}" ${p.active ? 'checked' : ''} aria-label="Activar ${esc(p.name)}">
        <span class="name">${esc(p.name)}<small>${esc(p.target)} · ${esc(p.category)}</small></span>
        <span class="best">${min != null ? 'desde ' + eur(min) : 'sin oferta'}</span></summary>
      <div class="body">
        <div class="grid2">
          <label>Objetivo<input type="text" class="pTarget" data-id="${p.id}" value="${esc(p.target)}"></label>
          <label>Lotes del objetivo<input type="number" min="1" step="1" class="pQty" data-id="${p.id}" value="${p.qty || 1}"></label>
        </div>
        ${offs.sort((a, b) => offerEUR(a) - offerEUR(b)).map(o => offerRow(o, p)).join('') || '<p class="hint">Sin ofertas.</p>'}
        <button class="mini addOffer" data-id="${p.id}">+ Añadir oferta</button>
        <div class="newOffer" data-id="${p.id}"></div>
      </div></details>`;
  }).join('');
  bindProductEvents();
}
function offerRow(o, p) {
  const v = vendorById(o.vendorId);
  return `<div class="offer" data-oid="${o.id}">
    <input type="checkbox" class="oActive" data-oid="${o.id}" ${o.active ? 'checked' : ''} aria-label="Usar oferta">
    <div><b>${esc(v ? v.name : o.vendorId)}</b>${v && !v.active ? ' <span class="tag bad">proveedor desactivado</span>' : ''}<div class="meta">${esc(o.desc)} · ${o.price} ${esc(o.currency)} × ${o.units} · ${esc(o.status || '')}${o.url ? ` · <a href="${esc(o.url)}" target="_blank" rel="noopener">fuente</a>` : ''}</div></div>
    <div class="side"><span class="eur">${eur(offerEUR(o) * (p.qty || 1))}</span><button class="mini oEdit" data-oid="${o.id}">Editar</button></div>
    <div class="edit"><div class="grid3">
      <label>Precio<input type="number" step="0.01" class="oPrice" data-oid="${o.id}" value="${o.price}"></label>
      <label>Divisa<select class="oCur" data-oid="${o.id}">${Object.keys(S.fx).map(c => `<option ${c === o.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <label>Unidades a comprar<input type="number" step="0.01" min="0" class="oUnits" data-oid="${o.id}" value="${o.units}"></label>
    </div>
    <label>Descripción<input type="text" class="oDesc" data-oid="${o.id}" value="${esc(o.desc)}"></label>
    <div class="row"><button class="mini oDel" data-oid="${o.id}">Eliminar oferta</button></div></div>
  </div>`;
}
function bindProductEvents() {
  $$('.pActive').forEach(c => { c.addEventListener('click', e => e.stopPropagation()); c.addEventListener('change', () => { productById(+c.dataset.id).active = c.checked; save(); }); });
  $$('.pTarget').forEach(i => i.addEventListener('change', () => { productById(+i.dataset.id).target = i.value; save(); renderProducts(); }));
  $$('.pQty').forEach(i => i.addEventListener('change', () => { productById(+i.dataset.id).qty = Math.max(1, parseInt(i.value) || 1); save(); renderProducts(); }));
  $$('.oActive').forEach(c => c.addEventListener('change', () => { S.offers.find(o => o.id === c.dataset.oid).active = c.checked; save(); renderProducts(); }));
  $$('.oEdit').forEach(b => b.addEventListener('click', () => b.closest('.offer').classList.toggle('editing')));
  const upd = (sel, key, fn) => $$(sel).forEach(i => i.addEventListener('change', () => { const o = S.offers.find(x => x.id === i.dataset.oid); const val = fn(i.value); if (val == null) return toast('Valor no válido'); o[key] = val; save(); renderProducts(); }));
  upd('.oPrice', 'price', num); upd('.oUnits', 'units', num); upd('.oCur', 'currency', v => v); upd('.oDesc', 'desc', v => v);
  $$('.oDel').forEach(b => b.addEventListener('click', () => { if (!confirm('¿Eliminar esta oferta?')) return; S.offers = S.offers.filter(o => o.id !== b.dataset.oid); save(); renderProducts(); }));
  $$('.addOffer').forEach(b => b.addEventListener('click', () => {
    const box = $(`.newOffer[data-id="${b.dataset.id}"]`);
    box.innerHTML = `<div class="card" style="margin-top:8px"><div class="grid2">
      <label>Proveedor<select class="nV">${S.vendors.map(v => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')}</select></label>
      <label>Descripción<input type="text" class="nD" placeholder="p. ej. 40 mg × 300"></label>
      <label>Precio<input type="number" step="0.01" class="nP"></label>
      <label>Divisa<select class="nC">${Object.keys(S.fx).map(c => `<option>${c}</option>`).join('')}</select></label>
      <label>Unidades a comprar<input type="number" step="0.01" class="nU" value="1"></label>
      <label>URL<input type="url" class="nL" placeholder="https://"></label></div>
      <button class="primary nSave">Guardar oferta</button></div>`;
    $('.nSave', box).addEventListener('click', () => {
      const price = num($('.nP', box).value), units = num($('.nU', box).value);
      if (price == null || units == null) return toast('Indica precio y unidades');
      S.offers.push({ id: 'u' + Date.now(), productId: +b.dataset.id, vendorId: $('.nV', box).value, desc: $('.nD', box).value || '—', price, currency: $('.nC', box).value, units, status: 'Añadida por el usuario', url: $('.nL', box).value, active: true });
      save(); renderProducts(); toast('Oferta añadida');
    });
  }));
}
$('#allOn')?.addEventListener('click', () => { S.products.forEach(p => p.active = true); save(); renderProducts(); });
$('#allOff')?.addEventListener('click', () => { S.products.forEach(p => p.active = false); save(); renderProducts(); });

/* ---------- proveedores ---------- */
function renderVendors() {
  const list = $('#vendorList');
  const open = new Set($$('details.vend[open]').map(d => d.dataset.id));
  list.innerHTML = S.vendors.map(v => {
    const n = S.offers.filter(o => o.vendorId === v.id).length;
    const sh = vendorShipping(v);
    return `<details class="vend" data-id="${esc(v.id)}" ${open.has(v.id) ? 'open' : ''}>
      <summary><input type="checkbox" class="vActive" data-id="${esc(v.id)}" ${v.active ? 'checked' : ''} aria-label="Activar ${esc(v.name)}">
        <span class="name">${esc(v.name)}<small>${esc(CHANNEL_LABEL[v.channel] || v.channel)} · nivel ${esc(v.level)} · ${n} oferta(s)</small></span>
        <span class="best">${sh.value ? eur(sh.value) + (sh.est ? '*' : '') : 'envío 0'}</span></summary>
      <div class="body">
        <div class="grid3">
          <label>Envío (€, vacío = desconocido)<input type="number" step="0.01" class="vf" data-k="shipping" data-id="${esc(v.id)}" value="${v.shipping ?? ''}"></label>
          <label>Envío estimado (€)<input type="number" step="0.01" class="vf" data-k="shippingEstimate" data-id="${esc(v.id)}" value="${v.shippingEstimate ?? ''}"></label>
          <label>Envío gratis desde (€)<input type="number" step="0.01" class="vf" data-k="freeFrom" data-id="${esc(v.id)}" value="${v.freeFrom ?? ''}"></label>
          <label>Pedido mínimo (€)<input type="number" step="0.01" class="vf" data-k="minOrder" data-id="${esc(v.id)}" value="${v.minOrder ?? ''}"></label>
          <label>Cupón (%)<input type="number" step="1" class="vf" data-k="couponPct" data-id="${esc(v.id)}" value="${v.couponPct ?? 0}"></label>
          <label>Nivel<select class="vs" data-k="level" data-id="${esc(v.id)}">${['A', 'B', 'C', 'D'].map(l => `<option ${l === v.level ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        </div>
        <div class="grid2">
          <label>Canal<select class="vs" data-k="channel" data-id="${esc(v.id)}">${Object.entries(CHANNEL_LABEL).map(([k, l]) => `<option value="${k}" ${k === v.channel ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label>Pago<input type="text" class="vs" data-k="payment" data-id="${esc(v.id)}" value="${esc(v.payment || '')}"></label>
        </div>
        <label>Notas<input type="text" class="vs" data-k="notes" data-id="${esc(v.id)}" value="${esc(v.notes || '')}"></label>
        ${v.url ? `<p class="hint"><a href="${esc(v.url)}" target="_blank" rel="noopener">Abrir web del proveedor</a></p>` : ''}
      </div></details>`;
  }).join('');
  $$('.vActive').forEach(c => { c.addEventListener('click', e => e.stopPropagation()); c.addEventListener('change', () => { vendorById(c.dataset.id).active = c.checked; save(); }); });
  $$('.vf').forEach(i => i.addEventListener('change', () => { const v = vendorById(i.dataset.id); v[i.dataset.k] = i.value === '' ? (i.dataset.k === 'couponPct' ? 0 : null) : num(i.value); save(); renderVendors(); }));
  $$('.vs').forEach(i => i.addEventListener('change', () => { vendorById(i.dataset.id)[i.dataset.k] = i.value; save(); renderVendors(); }));
}
$('#addVendor')?.addEventListener('click', () => {
  const name = prompt('Nombre del proveedor'); if (!name) return;
  const id = 'v' + Date.now();
  S.vendors.push({ id, name, country: '', channel: 'online', payment: 'Por confirmar', shipping: null, shippingEstimate: 30, freeFrom: null, minOrder: null, couponPct: 0, level: 'C', notes: 'Añadido por el usuario', url: '', active: true });
  save(); renderVendors(); toast('Proveedor añadido');
});

/* ---------- ajustes ---------- */
function renderSettings() {
  $('#fxUSD').value = S.fx.USD; $('#fxINR').value = S.fx.INR;
  $('#excludedInfo').textContent = (S.excluded || []).length ? 'Excluidos de la tabla: ' + S.excluded.join(' · ') : '';
}
function uiPrefs() { try { return JSON.parse(localStorage.getItem('optcompras-ui') || '{}'); } catch (e) { return {}; } }
function setUI(k, v) { const u = uiPrefs(); u[k] = v; try { localStorage.setItem('optcompras-ui', JSON.stringify(u)); } catch (e) {} applyUI(); }
function applyUI() {
  const u = uiPrefs(); const el = document.documentElement;
  el.dataset.size = u.size || 'grande'; el.dataset.contrast = u.contrast || 'normal';
  $$('#sizeSeg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.size === el.dataset.size ? 'true' : 'false'));
  $('#contrastHigh').checked = el.dataset.contrast === 'alto';
}
function bindSettings() {
  $$('#sizeSeg button').forEach(b => b.addEventListener('click', () => setUI('size', b.dataset.size)));
  $('#contrastHigh').addEventListener('change', e => setUI('contrast', e.target.checked ? 'alto' : 'normal'));
  applyUI();
  ['USD', 'INR'].forEach(c => $('#fx' + c).addEventListener('change', e => { const v = num(e.target.value); if (!v) return toast('Tipo no válido'); S.fx[c] = v; save(); renderProducts(); toast('Tipo de cambio actualizado'); }));
  $('#btnExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(S, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `optimizador-compras-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#fileImport').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!Array.isArray(d.products) || !Array.isArray(d.vendors) || !Array.isArray(d.offers)) throw new Error('formato');
      S = d; S.settings = Object.assign({ maxPkg: 8, minLevel: 'C', channels: ['online', 'b2b', 'telegram', 'directorio'], onlyCard: false }, S.settings || {});
      save(); renderAll(); $('#results').innerHTML = ''; toast('Datos importados');
    } catch (err) { toast('Archivo no válido'); }
    e.target.value = '';
  });
  $('#btnReset').addEventListener('click', () => {
    if (!DEFAULTS) return toast('Esta instalación no incluye datos: importa de nuevo tu archivo .json');
    if (!confirm('Se perderán tus cambios. ¿Restaurar los datos de la tabla?')) return;
    S = structuredClone(DEFAULTS); S.settings = { maxPkg: 8, minLevel: 'C', channels: ['online', 'b2b', 'telegram', 'directorio'], onlyCard: false };
    save(); renderAll(); $('#results').innerHTML = ''; toast('Datos restaurados');
  });
}

/* ---------- instalación (PWA) ---------- */
let deferredInstall = null;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; if (!isStandalone()) $('#btnInstall').hidden = false; });
window.addEventListener('appinstalled', () => { deferredInstall = null; $('#btnInstall').hidden = true; $('#installHelp').hidden = true; toast('App instalada'); });
window.addEventListener('load', () => { if (!isStandalone()) setTimeout(() => { $('#btnInstall').hidden = false; }, 1500); });
$('#btnInstall').addEventListener('click', async () => {
  if (deferredInstall) {
    deferredInstall.prompt();
    const r = await deferredInstall.userChoice.catch(() => null);
    deferredInstall = null;
    if (r && r.outcome === 'accepted') $('#btnInstall').hidden = true;
  } else {
    $('#installHelp').hidden = !$('#installHelp').hidden;
  }
});
$('#closeInstallHelp').addEventListener('click', () => { $('#installHelp').hidden = true; });

init();
