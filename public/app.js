/* Secondhand Arbitrage — frontend logic.
 * Talks to the existing REST API (/v1/search, /v1/locations/resolve, /health).
 */
const $ = (s) => document.querySelector(s);

const PLACEHOLDER_PRICES = new Set([0, 1, 5]);
function hasRealPrice(l) {
  if (l.priceNumeric == null) return false;
  const n = l.priceNumeric;
  if (n <= 0 || PLACEHOLDER_PRICES.has(n)) return false;
  if (n > 50_000_000) return false; // absurd = placeholder
  return true;
}

let lastData = null;

// --- Product/model categorization + average asking price (across all found) ---
const FX_DOP_PER_USD = 60; // heuristic; adjust to current rate
const toDOP = (l) => {
  if (typeof l.priceNumeric !== 'number') return null;
  const c = String(l.currency || '').toUpperCase();
  return c === 'USD' || c === '$' ? l.priceNumeric * FX_DOP_PER_USD : l.priceNumeric;
};
const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const _storage = (t) => {
  const m = t.match(/(\d+(?:\.\d+)?)\s?(gb|tb)/i);
  return m ? ` ${m[1].toUpperCase()}${m[2].toUpperCase()}` : '';
};
function modelKey(title) {
  const t = String(title || '').toLowerCase();
  const cap = (w) => w ? w.charAt(0).toUpperCase() + w.slice(1) : '';
  if (/iphone/.test(t)) {
    let k = 'iPhone';
    const m = t.match(/iphone\s*(\d+)(?:\s*(pro|max|mini|plus|air|ultra))?/i);
    if (m) k += ` ${m[1]}${m[2] ? ' ' + cap(m[2]) : ''}`;
    if (/ultra/.test(t)) k += ' Ultra';
    return k + _storage(t);
  }
  if (/ipad/.test(t)) {
    let k = 'iPad';
    const m = t.match(/(mini|air|pro)/i);
    const gen = t.match(/(\d+)(?:st|nd|rd|th)?\s*(?:gen|generation)/i) || t.match(/generaci[oó]n\s*(\d+)/i) || t.match(/ipad\s*(\d+)/i);
    if (m) k += ` ${cap(m[1])}`;
    else if (gen) k += ` ${gen[1]}`;
    return k + _storage(t);
  }
  if (/apple watch|applewatch|iwatch|watch\s*(se|ultra|series)|series|serie/.test(t)) {
    let k = 'Apple Watch';
    const s = t.match(/series\s*(\d+)|serie\s*(\d+)| ultra| se\b/i);
    if (s) k += ` ${s[2] ? cap('Serie') + ' ' + s[2] : cap(s[0].trim())}`;
    return k;
  }
  if (/macbook|mac book/.test(t)) {
    const s = t.match(/(pro|air|m\d+)/i);
    return 'MacBook' + (s ? ' ' + s[1].toUpperCase() : '') + _storage(t);
  }
  if (/samsung|galaxy/.test(t)) {
    const s = t.match(/galaxy\s*([\w\d]+)/i);
    return 'Samsung' + (s ? ' ' + s[1] : '') + _storage(t);
  }
  const fallback = String(title || '').replace(/[^a-z0-9 ]/gi, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 2).join(' ');
  return fallback || 'Otro';
}
function computeStats(listings) {
  const groups = new Map();
  for (const l of listings) {
    const key = modelKey(l.title) || 'Otro';
    const g = groups.get(key) || { key, count: 0, priced: [], sum: 0 };
    g.count += 1;
    const dop = toDOP(l);
    if (dop != null && dop > 1) { g.priced.push(dop); g.sum += dop; }
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({
      key: g.key,
      count: g.count,
      sample: g.priced.length,
      avg: g.priced.length ? g.sum / g.priced.length : null,
      median: g.priced.length ? median(g.priced) : null,
      min: g.priced.length ? Math.min(...g.priced) : null,
      max: g.priced.length ? Math.max(...g.priced) : null,
    }))
    .sort((a, b) => (b.count - a.count) || ((b.avg ?? 0) - (a.avg ?? 0)));
}
function renderStats(listings) {
  const stats = computeStats(listings);
  const tb = document.querySelector('#stats tbody');
  $('#statsCount').textContent = `${stats.length} modelo(s) · ${listings.length} listings`;
  tb.innerHTML = '';
  $('#statsEmpty').hidden = stats.length > 0;
  const fmt = (n) => (n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US'));
  for (const s of stats) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escape(s.key)}</td><td>${s.count}</td><td>${fmt(s.avg)}</td><td>${fmt(s.median)}</td><td>${fmt(s.min)}</td><td>${fmt(s.max)}</td>`;
    tb.appendChild(tr);
  }
}

async function init() {
  try {
    const h = await (await fetch('/health')).json();
    const names = (h.marketplaces || []).map((m) => m.name);
    const hasEbay = names.includes('ebay');
    $('#mpStatus').textContent = `Mercados: ${names.join(', ') || 'ninguno'}`;
    if (!hasEbay) {
      $('#mpStatus').textContent += ' · eBay: SIN CLAVES';
      showEbayHint('eBay no está configurado. Añade EBAY_CLIENT_ID / EBAY_CLIENT_SECRET a .env y reinicia la API para activar la comparación.');
    } else {
      $('#mpStatus').textContent += ' · eBay: listo';
      showEbayHint('eBay configurado: usa "eBay" en el selector de mercado para comparar.');
    }
  } catch {
    $('#mpStatus').textContent = 'no se pudo leer /health';
  }
}

async function fillCoords() {
  const location = $('#location').value.trim();
  if (!location) return;
  try {
    const j = await (await fetch('/v1/locations/resolve?marketplace=facebook&location=' + encodeURIComponent(location))).json();
    if (j && typeof j.latitude === 'number') {
      $('#coords').textContent = `✓ ${j.name ?? ''} ${j.latitude.toFixed(4)}, ${j.longitude.toFixed(4)}`;
    } else {
      $('#coords').textContent = 'No se pudo resolver';
    }
  } catch {
    $('#coords').textContent = 'Error al resolver';
  }
}

async function runSearch(e) {
  e.preventDefault();
  const body = {
    marketplace: $('#marketplace').value,
    query: $('#query').value.trim(),
    location: $('#location').value.trim() || undefined,
    radius: num($('#radius')), minPrice: num($('#minPrice')),
    maxPrice: num($('#maxPrice')), limit: num($('#limit')) || 40,
  };
  $('#empty').hidden = true;
  $('#listings').innerHTML = '<p class="empty">Buscando…</p>';
  $('#note').textContent = '';
  try {
    const res = await fetch('/v1/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (res.status >= 400) throw new Error(data.error || ('HTTP ' + res.status));
    lastData = data;
    render(data);
  } catch (err) {
    $('#note').textContent = 'Error: ' + err.message;
    $('#listings').innerHTML = '';
    $('#count').textContent = '';
    $('#empty').hidden = false;
  }
}

function render(data) {
  const all = data.listings || [];
  let listings = all;
  $('#count').textContent = `${listings.length}${data.totalFound != null ? ' / ' + data.totalFound : ''}`;

  // Stats are computed over ALL records found (not just the filtered/sorted set).
  renderStats(all);

  if ($('#hideUnpriced').checked) listings = listings.filter(hasRealPrice);
  if ($('#sortPrice').checked) listings = [...listings].sort((a, b) => (a.priceNumeric ?? Infinity) - (b.priceNumeric ?? Infinity));

  $('#note').textContent = !data.success ? 'El mercado devolvió error: ' + (data.error || 'desconocido') : '';

  const box = $('#listings');
  box.innerHTML = '';
  if (!listings.length) { $('#empty').hidden = false; }

  for (const l of listings) {
    const img = (l.images && l.images[0]) || '';
    const real = hasRealPrice(l);
    const card = document.createElement('div');
    card.className = 'listing' + (real ? '' : ' unpriced');

    const detId = 'det-' + l.id.replace(/[^a-zA-Z0-9]/g, '');
    card.innerHTML = `
      ${img ? `<img loading="lazy" src="${escapeAttr(img)}" alt="" onerror="this.style.display='none'" />` : '<div class="ph"></div>'}
      <div class="body">
        <div class="title">${escape(l.title)}</div>
        <div class="price">${escape(l.price)}${real ? '' : ' ⚠'}</div>
        ${l.location ? `<div class="loc">📍 ${escape(l.location)}</div>` : ''}
        ${l.condition ? `<div class="meta">Condición: ${escape(l.condition)}</div>` : ''}
        ${l.seller ? `<div class="seller">👤 ${escape(l.seller)}</div>` : ''}
        <div class="meta">${escape(l.marketplace)}</div>
        <button class="ghost details-btn" type="button" data-id="${escapeAttr(l.id)}" data-mp="${escapeAttr(l.marketplace)}">Detalles</button>
        <a href="${escapeAttr(l.url)}" target="_blank" rel="noopener">Ver en ${escape(l.marketplace)} ↗</a>
        <div class="details" id="${detId}" hidden></div>
      </div>`;
    box.appendChild(card);
  }
  $('#empty').hidden = true;
}

async function fetchDetail(l) {
  const box = document.getElementById('det-' + l.id.replace(/[^a-zA-Z0-9]/g, ''));
  if (!box) return;
  if (!box.hidden) { box.hidden = true; return; } // toggle
  box.hidden = false;
  box.innerHTML = 'Cargando detalles…';
  try {
    const res = await fetch(`/v1/listings/${encodeURIComponent(l.marketplace)}/${encodeURIComponent(l.id)}`);
    const d = await res.json();
    if (d.error || !res.ok) { box.innerHTML = 'No se pudieron cargar los detalles.'; return; }
    box.innerHTML = `
      ${d.condition ? `<div class="meta">Condición: ${escape(d.condition)}</div>` : '<div class="meta">Condición: no informada</div>'}
      ${d.location ? `<div class="loc">📍 ${escape(d.location)}</div>` : ''}
      ${(d.deliveryTypes || []).length ? `<div class="meta">🚚 ${escape(d.deliveryTypes.join(', '))}</div>` : ''}
      ${d.description ? `<div class="desc">${escape(d.description)}</div>` : '<div class="meta">Sin descripción</div>'}`;
  } catch {
    box.innerHTML = 'Error al cargar los detalles.';
  }
}

const num = (input) => (input.value === '' ? undefined : Number(input.value));
const escape = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const escapeAttr = (s) => escape(s);

function showEbayHint(msg) {
  const h = $('#ebayHint'); h.hidden = false; $('#ebayMsg').textContent = msg;
}

// --- Arbitrage (use case #1): cross-market comparison via /v1/arbitrage -------
async function runArbitrage(e) {
  const body = {
    marketplace: $('#marketplace').value,
    query: $('#query').value.trim(),
    location: $('#location').value.trim() || undefined,
    radius: num($('#radius')), minPrice: num($('#minPrice')),
    maxPrice: num($('#maxPrice')), limit: num($('#limit')) || 40,
    topN: 3, minMatches: 3,
  };
  const res = $('#arbRes');
  res.innerHTML = '<p class="empty">Analizando… (búsqueda + comparación, puede tardar)</p>';
  $('#arbNote').textContent = '';
  try {
    const r = await fetch('/v1/arbitrage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json();
    if (r.status >= 400) throw new Error(data.error || ('HTTP ' + r.status));
    renderArbitrage(data);
  } catch (err) {
    $('#arbNote').textContent = 'Error: ' + err.message;
    res.innerHTML = '';
  }
}

function renderArbitrage(data) {
  const t = data.totals || {};
  $('#arbTotals').textContent = `${t.listingsCount ?? 0} listings · ${t.modelCount ?? 0} modelos · mediana USD$${t.usd?.median ?? '—'}`;
  $('#arbNote').textContent = 'Precios normalizados a USD (DOP→USD ÷60). Margen estimado (net) = eBay mediana − fees(13%) − envío($10) − FB mediana. Solo lectura: el link abre eBay para que tú pujes/veas.';

  const res = $('#arbRes');
  res.innerHTML = '';

  // Distribution
  const dist = t.distribution || [];
  if (dist.length) {
    const maxC = Math.max(...dist.map((b) => b.count));
    const d = document.createElement('div');
    d.className = 'arb-dist';
    d.innerHTML = '<div class="arb-head">Distribución (USD)</div>' + dist.map((b) =>
      `<div class="arb-barline"><span class="arb-label">$${b.from}–$${b.to}</span><span class="arb-bar">${'▇'.repeat(Math.round((b.count / (maxC || 1)) * 20))}</span><span class="arb-n">${b.count}</span></div>`
    ).join('');
    res.appendChild(d);
  }

  // Selected models side-by-side
  for (const s of data.selected || []) {
    const p = s.primary; const sec = s.secondary || {};
    const em = (sec.usd || {}).median;
    const c = s.comparison || {};
    const pos = (c.netUsd ?? 0) > 0;
    const card = document.createElement('div');
    card.className = 'arb-model';
    card.innerHTML = `
      <div class="arb-model-title">${escape(s.key)} <span class="pill">${p.count ?? 0} en ${escape(data.primaryMarket)}</span></div>
      <div class="arb-cols">
        <div class="arb-col">
          <div class="arb-col-title">${escape(data.primaryMarket)} (origen)</div>
          <div>n=${p.count ?? 0} · mediana <b>$${p.median ?? '—'}</b></div>
        </div>
        <div class="arb-col">
          <div class="arb-col-title">${escape(data.secondaryMarket)} (comparación)</div>
          <div>n=${sec.count ?? 0} · mediana <b>$${em ?? '—'}</b> ${(sec.error ? '· <em>' + escape(sec.error) + '</em>' : '')}</div>
        </div>
      </div>
      <div class="arb-comparison">
        Delta <b>$${c.deltaUsd ?? '—'}</b> · Ganancia neta est. <b class="${pos ? 'pos' : 'neg'}">$${c.netUsd ?? '—'}</b>
        <span class="arb-fee">(fee ${Math.round((c.feeRate ?? 0) * 100)}% + envío $${c.shippingUsd ?? 0})</span>
      </div>
      <div class="row">
        <a class="arb-link" href="${escapeAttr(s.ebaySearchUrl || '')}" target="_blank" rel="noopener">Abrir en eBay (bids/listing) ↗</a>
        <button class="ghost details-btn" type="button" data-draft="${escapeAttr(s.key)}">Borrador listing</button>
      </div>`;
    res.appendChild(card);
  }
  if (!(data.selected || []).length) {
    $('#arbNote').textContent = 'Ningún modelo alcanzó el mínimo de matches (' + (data.selected ? '' : 'revisá el log') + ') para comparar.';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  init();
  $('#searchForm').addEventListener('submit', runSearch);
  $('#resolveLoc').addEventListener('click', fillCoords);
  const rerender = () => { if (lastData) render(lastData); };
  $('#hideUnpriced').addEventListener('change', rerender);
  $('#sortPrice').addEventListener('change', rerender);

  // Delegated click handler for the per-listing "Detalles" buttons.
  $('#listings').addEventListener('click', (ev) => {
    const btn = ev.target.closest('.details-btn');
    if (!btn) return;
    const mp = btn.getAttribute('data-mp');
    const id = btn.getAttribute('data-id');
    fetchDetail({ marketplace: mp, id });
  });

  $('#goArb').addEventListener('click', runArbitrage);
});
