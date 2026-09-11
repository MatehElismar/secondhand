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
// FX conversion lives in public/fx.js, loaded before this file. This file used
// to carry its own copy of the rate, and the two copies disagreed about what
// "$" meant: the server fed a peso price to its medians as dollars while this
// file multiplied a dollar price by 60. test/arbitrage-conversion.test.ts drives
// public/fx.js and src/arbitrage.ts from one table, so conversion is not
// re-implemented here — the same reason the model parser is not.
const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
// Models are classified server-side (src/models.ts) and arrive on each listing
// as `model`. The browser used to re-implement that parser; the two copies had
// already drifted, so this table and the arbitrage disagreed on what a model
// even was — the same MacBook showed as "MacBook AIR 8GB" here and
// "MacBook Air M2 256GB" there.
// The server computes the fuzzy merge of low-confidence models and sends it
// as `modelGroup`; the browser must never re-implement grouping, only consume
// what the API already decided. Fall back to `model` for older API responses.
const modelOf = (l) => l.modelGroup || l.model || 'Otro';

function computeStats(listings) {
  const groups = new Map();
  for (const l of listings) {
    // Parts and accessories are not the product; they inflated these groups.
    if (l.isAccessory) continue;
    const key = modelOf(l);
    const g = groups.get(key) || { key, count: 0, priced: [], sum: 0 };
    g.count += 1;
    const dop = SecondhandFX.toDOP(l);
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
/** Wipe the per-model summary while a new search is in flight. */
function clearStats(message) {
  document.querySelector('#stats tbody').innerHTML = '';
  $('#statsCount').textContent = '';
  $('#statsEmpty').hidden = true;
  $('#stats').hidden = true;
  const pending = $('#statsPending');
  pending.textContent = message;
  pending.hidden = false;
}

function renderStats(listings) {
  const stats = computeStats(listings);
  const tb = document.querySelector('#stats tbody');
  $('#statsCount').textContent = `${stats.length} modelo(s) · ${listings.length} listings`;
  tb.innerHTML = '';
  $('#statsPending').hidden = true;
  $('#stats').hidden = stats.length === 0;
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

/**
 * The places this app can search, as served by GET /v1/locations/places.
 *
 * The browser keeps no list of its own: the server's closed table is the single source
 * of truth, so the picker cannot offer a place the resolver does not know. That is the
 * bug this replaces — a free-text field whose value was ranked by Facebook's own place
 * search, which answered "Santo Domingo, Dominican Republic" with a city in Paraguay.
 */
let placeGroups = [];

async function loadPlaces() {
  const province = $('#province');
  const municipality = $('#municipality');

  try {
    const j = await (await fetch('/v1/locations/places')).json();
    placeGroups = Array.isArray(j.groups) ? j.groups : [];
  } catch {
    placeGroups = [];
  }

  province.innerHTML = '';
  for (const group of placeGroups) {
    const option = document.createElement('option');
    option.value = group.id;
    option.textContent = group.label;
    province.appendChild(option);
  }

  if (!placeGroups.length) {
    municipality.innerHTML = '';
    $('#coords').textContent = 'No se pudieron cargar las ubicaciones';
    return;
  }
  syncMunicipalities();
}

function placesOf(groupId) {
  const group = placeGroups.find((g) => g.id === groupId);
  return group ? group.places : [];
}

/** Rebuild the municipality list for whichever province is selected. */
function syncMunicipalities() {
  const municipality = $('#municipality');
  municipality.innerHTML = '';
  for (const place of placesOf($('#province').value)) {
    const option = document.createElement('option');
    option.value = place.name;
    option.textContent = place.label;
    municipality.appendChild(option);
  }
  showSelection();
}

/**
 * Name the selected place and show its coordinates. The picker already makes a wrong
 * city impossible, but the coordinates are the number the search is really built on,
 * so they are worth stating rather than hiding behind a 12px grey hint.
 */
function showSelection() {
  const place = placesOf($('#province').value).find((p) => p.name === $('#municipality').value);
  $('#coords').textContent = place
    ? `✓ ${place.label} · ${place.latitude.toFixed(4)}, ${place.longitude.toFixed(4)}`
    : '';
}

/** Show the closing-window select only when the format can actually use it. */
function syncWindowVisibility() {
  const isAuction = $('#buyingFormat').value === 'auction';
  $('#endingWithinWrap').hidden = !isAuction;
  // Leaving a stale window behind would resend a filter the user can no longer see.
  if (!isAuction) $('#endingWithin').value = '';
}

/**
 * Build the window ladder from the single definition in public/params.js, so the
 * options the UI offers and the values the mapping accepts cannot drift apart.
 */
function fillAuctionWindows() {
  const select = $('#endingWithin');
  const any = document.createElement('option');
  any.value = '';
  any.textContent = 'Cualquier momento';
  select.appendChild(any);

  for (const group of SecondhandParams.WINDOW_GROUPS) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = group.label;
    for (const w of SecondhandParams.AUCTION_WINDOWS.filter((x) => x.group === group.id)) {
      const option = document.createElement('option');
      option.value = String(w.minutes);
      option.textContent = w.label;
      optgroup.appendChild(option);
    }
    select.appendChild(optgroup);
  }
}

/**
 * Why the list is empty depends on the window. A bare "no results" reads as a broken
 * app, when the honest answer is that a five-minute window over a whole marketplace is
 * usually empty: measured on the live API, 0 to 2 listings for most queries.
 */
function emptyMessage() {
  const minutes = Number($('#endingWithin').value) || 0;
  if ($('#buyingFormat').value === 'auction' && minutes > 0 && minutes <= 15) {
    return 'Sin resultados. Las subastas que cierran en minutos son muy pocas: es normal que una ventana así venga vacía. Probá ≤1 h, o 2-24 h si querés ver volumen.';
  }
  return 'Sin resultados para mostrar.';
}

async function runSearch(e) {
  e.preventDefault();
  const body = SecondhandParams.searchBody({
    marketplace: $('#marketplace').value,
    query: $('#query').value,
    // The municipality picker, not a text field: a free-text place name was ranked by
    // Facebook's own search and answered with a city in Paraguay.
    location: $('#municipality').value,
    // Kilometres, because the market is Dominican; the API converts to the miles its
    // SearchParams still carries.
    radiusKm: $('#radius').value,
    minPrice: $('#minPrice').value,
    maxPrice: $('#maxPrice').value,
    limit: $('#limit').value,
    format: $('#buyingFormat').value,
    window: $('#endingWithin').value,
  });
  $('#empty').hidden = true;
  $('#listings').innerHTML = '<p class="empty">Buscando…</p>';
  $('#note').textContent = '';
  // The old comparison belongs to the previous query — drop it now rather than
  // leaving stale numbers on screen for the length of the primary search.
  clearArbitrage('Esperando los resultados de la búsqueda…');
  clearStats('Esperando los resultados de la búsqueda…');
  try {
    const res = await fetch('/v1/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (res.status >= 400) throw new Error(data.error || ('HTTP ' + res.status));
    lastData = data;
    render(data);
    // Auto-trigger the cross-market arbitrage with the same search params.
    runArbitrage();
  } catch (err) {
    $('#note').textContent = 'Error: ' + err.message;
    $('#listings').innerHTML = '';
    $('#count').textContent = '';
    $('#empty').hidden = false;
    clearArbitrage('Sin comparación: la búsqueda falló.');
    clearStats('Sin resumen: la búsqueda falló.');
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
  if (!listings.length) { $('#empty').textContent = emptyMessage(); $('#empty').hidden = false; }

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

const escape = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const escapeAttr = (s) => escape(s);

function showEbayHint(msg) {
  const h = $('#ebayHint'); h.hidden = false; $('#ebayMsg').textContent = msg;
}

// --- Arbitrage (use case #1): cross-market comparison via /v1/arbitrage -------
/** Wipe every trace of the previous comparison, including the cached data. */
function clearArbitrage(message) {
  lastArb = null;
  $('#arbTotals').textContent = '';
  $('#arbNote').textContent = '';
  $('#arbRes').innerHTML = message ? `<p class="empty">${escape(message)}</p>` : '';
}

let arbRunId = 0;

async function runArbitrage(e) {
  const runId = ++arbRunId;
  // No buying format and no closing window here on purpose: how you chose to browse the
  // list above must not rewrite what the comparison prices against. See public/params.js
  // and the note above `isAuctionOnly` in src/arbitrage.ts.
  const body = SecondhandParams.arbitrageBody({
    marketplace: $('#marketplace').value,
    query: $('#query').value,
    location: $('#municipality').value,
    radiusKm: $('#radius').value,
    minPrice: $('#minPrice').value,
    maxPrice: $('#maxPrice').value,
    limit: $('#limit').value,
    enrich: $('#enrich').checked,
  });
  const res = $('#arbRes');
  clearArbitrage();
  res.innerHTML =
    '<div class="skel"><div class="skel-card"></div><div class="skel-card"></div><div class="skel-card"></div></div>' +
    '<p class="empty">Analizando ambos mercados… puede tardar unos segundos.</p>';
  try {
    const r = await fetch('/v1/arbitrage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json();
    if (runId !== arbRunId) return; // a newer search already took over
    if (r.status >= 400) throw new Error(data.error || ('HTTP ' + r.status));
    renderArbitrage(data);
  } catch (err) {
    if (runId !== arbRunId) return;
    $('#arbNote').textContent = 'Error: ' + err.message;
    res.innerHTML = '';
  }
}

// --- Arbitrage rendering ------------------------------------------------
let lastArb = null;
let onlyProfitable = false;

const usd = (n) =>
  n == null ? '—' : (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');

/** Net margin, or null when the buy side has no median to net against. */
function effNet(s) {
  if (s?.secondary?.usd?.median == null) return null;
  return s.comparison?.netUsd ?? null;
}

/** Individual listings that turn a profit even when the median does not. */
const unitWins = (s) => (s?.candidates || []).filter((c) => (c.netUsd ?? 0) > 0);

/**
 * Verdict from the net margin. A model whose median loses money can still hold
 * specific underpriced units — that is a real opportunity, not a "no".
 */
function verdictOf(net, wins = 0) {
  if (net == null) return wins ? { cls: 'v-partial', label: `${wins} unidad(es) con margen` } : { cls: 'v-unknown', label: 'Sin comparación' };
  if (net > 0) return { cls: 'v-good', label: 'Conviene' };
  if (wins) return { cls: 'v-partial', label: `Solo ${wins} unidad(es) puntual(es)` };
  return { cls: 'v-bad', label: 'No conviene' };
}

/** Two price ranges on ONE shared scale, so the overlap is visible at a glance. */
function rangesHtml(buy, sell) {
  const vals = [];
  for (const s of [buy, sell]) {
    if (!s) continue;
    for (const k of ['p25', 'median', 'p75']) if (typeof s[k] === 'number') vals.push(s[k]);
  }
  if (vals.length < 2) return '';
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max((hi - lo) * 0.15, hi * 0.05, 1);
  lo = Math.max(0, lo - pad); hi = hi + pad;
  const pct = (v) => ((v - lo) / (hi - lo)) * 100;

  const row = (cls, label, s) => {
    if (!s || s.median == null) return '';
    const a = pct(s.p25 ?? s.median), b = pct(s.p75 ?? s.median);
    const left = Math.min(a, b), width = Math.max(Math.abs(b - a), 1.5);
    return `<div class="arb-range ${cls}">
      <span class="arb-range-label">${escape(label)}</span>
      <span class="arb-range-track">
        <span class="arb-range-band" style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%"></span>
        <span class="arb-range-med" style="left:${pct(s.median).toFixed(1)}%"></span>
      </span>
      <span class="arb-range-val">${usd(s.median)}</span>
    </div>`;
  };
  return `<div class="arb-ranges">
    <div class="arb-ranges-head">Rango de precios · p25–p75, línea = mediana</div>
    ${row('buy', 'Compra', buy)}
    ${row('sell', 'Venta', sell)}
    <div class="arb-range-scale"><span>${usd(lo)}</span><span>${usd(hi)}</span></div>
  </div>`;
}

function modelCardHtml(s, data) {
  const p = s.primary || {};
  const sec = s.secondary || {};
  const secUsd = sec.usd || null;
  const c = s.comparison || {};

  const sell = p.median ?? null;
  const buy = secUsd?.median ?? null;
  const fee = sell != null ? sell * (c.feeRate ?? 0) : null;
  const ship = c.shippingUsd ?? 0;

  const lowSample = (p.count ?? 0) < 5;
  const noSecondary = buy == null;
  const net = effNet(s);
  const wins = unitWins(s);
  const bestUnit = wins.length ? wins[0].netUsd : null;
  const v = verdictOf(net, wins.length);

  const buyLeg = noSecondary
    ? `<div class="arb-leg buy empty">
         <span class="arb-leg-label">Compras en ${escape(data.secondaryMarket)}</span>
         <span class="arb-leg-price">Sin datos</span>
         <span class="arb-leg-sub">${escape(sec.error || 'ningún listado con precio')}</span>
       </div>`
    : `<div class="arb-leg buy">
         <span class="arb-leg-label">Compras en ${escape(data.secondaryMarket)}</span>
         <span class="arb-leg-price">${usd(buy)}</span>
         <span class="arb-leg-sub">mediana · n=${secUsd.sample ?? sec.count ?? 0}${sec.offModel ? ` · ${sec.offModel} de otro modelo excluido(s)` : ''}</span>
       </div>`;

  const math = noSecondary
    ? ''
    : `<div class="arb-math">
         <span class="term">${usd(sell)} <small>venta</small></span>
         <span class="op">−</span>
         <span class="term">${usd(buy)} <small>compra</small></span>
         <span class="op">−</span>
         <span class="term">${usd(fee)} <small>fee ${Math.round((c.feeRate ?? 0) * 100)}%</small></span>
         <span class="op">−</span>
         <span class="term">${usd(ship)} <small>envío</small></span>
         <span class="op">=</span>
         <span class="res">${usd(net)}</span>
       </div>`;

  return `<article class="arb-card ${v.cls}">
    <div class="arb-card-head">
      <div>
        <h3 class="arb-title">${escape(s.key)}</h3>
        <div class="arb-chips">
          <span class="chip">${p.count ?? 0} en ${escape(data.primaryMarket)}</span>
          <span class="chip">${sec.matchedCount ?? sec.count ?? 0} en ${escape(data.secondaryMarket)}</span>
          ${lowSample ? '<span class="chip warn">muestra baja</span>' : ''}
          ${s.approximate ? '<span class="chip warn">aproximado · el título no fija el modelo exacto</span>' : ''}
        </div>
      </div>
      <div class="arb-verdict-wrap">
        <div class="arb-net">${net == null ? '—' : (net > 0 ? '+' : '') + usd(net)}</div>
        <div class="arb-verdict">${v.label}</div>
        ${net != null && net <= 0 && bestUnit != null ? `<div class="arb-best-unit">mejor unidad +${usd(bestUnit)}</div>` : ''}
      </div>
    </div>
    <div class="arb-flow">
      ${buyLeg}
      <div class="arb-arrow">→</div>
      <div class="arb-leg sell">
        <span class="arb-leg-label">Vendes en ${escape(data.primaryMarket)}</span>
        <span class="arb-leg-price">${usd(sell)}</span>
        <span class="arb-leg-sub">mediana · n=${p.sample ?? p.count ?? 0}</span>
      </div>
    </div>
    ${math}
    ${rangesHtml(secUsd, p)}
    ${candidatesHtml(s, data)}
    <div class="arb-actions">
      ${s.otherMarketUrl ? `<a class="arb-link muted" href="${escapeAttr(s.otherMarketUrl)}" target="_blank" rel="noopener">Ver todas las ofertas en ${escape(data.secondaryMarket)} ↗</a>` : ''}
      <button class="ghost details-btn" type="button" data-draft="${escapeAttr(s.key)}">Borrador listing</button>
      ${sec.excluded ? `<span class="arb-hint">${sec.excluded} resultado(s) descartados: accesorios, repuestos o lotes.</span>` : ''}
    </div>
  </article>`;
}

/**
 * Concrete units to buy, each with its own margin — the point of the whole
 * screen. Only real devices reach here; the API already strips accessories,
 * parts and lots from the buy side.
 */
/** Short local date for an auction end time. */
function fmtEnds(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function candidatesHtml(s, data) {
  const list = (s.candidates || []).filter((c) => c.url);
  if (!list.length) return '';
  const profitable = list.filter((c) => (c.netUsd ?? 0) > 0);
  const show = (profitable.length ? profitable : list).slice(0, 5);

  return `<div class="arb-buys">
    <div class="arb-buys-head">
      ${profitable.length
        ? `Comprar ahora en ${escape(data.secondaryMarket)} · ${profitable.length} con margen`
        : `Unidades reales en ${escape(data.secondaryMarket)} · ninguna deja margen`}
    </div>
    ${show.map((c) => {
      const good = (c.netUsd ?? 0) > 0;
      return `<a class="arb-buy ${good ? 'good' : ''}" href="${escapeAttr(c.url)}" target="_blank" rel="noopener">
        ${c.image ? `<img class="arb-buy-img" loading="lazy" src="${escapeAttr(c.image)}" alt="" onerror="this.style.visibility='hidden'" />` : '<span class="arb-buy-img"></span>'}
        <span class="arb-buy-main">
          <span class="arb-buy-title">${escape(c.title)}</span>
          <span class="arb-buy-meta">${c.auction ? '<span class="tag-auction">SUBASTA</span> ' : ''}${escape(c.condition || 'condición no informada')}${c.seller ? ' · ' + escape(c.seller) : ''}${c.auction ? ` · ${c.bidCount ?? 0} puja(s)${c.endsAt ? ' · cierra ' + escape(fmtEnds(c.endsAt)) : ''}` : ''}</span>
        </span>
        <span class="arb-buy-nums">
          <span class="arb-buy-price">${usd(c.priceUsd)}</span>
          <span class="arb-buy-net ${good ? 'pos' : 'neg'}">${c.netUsd == null ? '—' : (good ? '+' : '') + usd(c.netUsd)}</span>
        </span>
      </a>`;
    }).join('')}
    <div class="arb-buys-foot">${show.some((c) => c.auction)
      ? 'En subastas el precio es la <b>puja actual</b>, no lo que pagarás: el margen sube o desaparece con cada puja. '
      : ''}Precio de compra y margen por unidad ya con fee y envío. Verifica condición, bloqueo y envío antes de comprar.</div>
  </div>`;
}

function distributionHtml(dist) {
  if (!dist || !dist.length) return '';
  const maxC = Math.max(...dist.map((b) => b.count)) || 1;
  // The backend folds prices above p95 into a trailing open-ended bucket.
  const width = dist[0].to - dist[0].from;
  const isOverflow = (b, i) => i === dist.length - 1 && b.to - b.from > width * 1.5;
  return `<div class="arb-dist">
    <div class="arb-dist-head">Distribución de precios en el mercado de venta (USD)</div>
    ${dist.map((b, i) => `<div class="arb-barline">
        <span class="arb-label">${isOverflow(b, i) ? usd(b.from) + '+' : usd(b.from) + '–' + usd(b.to)}</span>
        <span class="arb-bar-track"><span class="arb-bar-fill" style="width:${((b.count / maxC) * 100).toFixed(1)}%"></span></span>
        <span class="arb-n">${b.count}</span>
      </div>`).join('')}
  </div>`;
}

function renderArbitrage(data) {
  if (data) lastArb = data;
  data = lastArb;
  if (!data) return;

  const t = data.totals || {};
  $('#arbTotals').textContent =
    `${t.listingsCount ?? 0} listings · ${t.modelCount ?? 0} modelos · mediana ${usd(t.usd?.median)}`;

  const note = [];
  if (!t.success) note.push(`El mercado de origen devolvió error: ${t.error || 'desconocido'}`);
  // "Nothing qualified" and "your search was too generic to compare" are
  // different answers, and the second one is actionable.
  const enr = data.enrichment;
  if (enr && enr.attempted) {
    note.push(
      `Se leyeron ${enr.attempted} descripción(es) porque el título no decía el modelo; ${enr.enriched} sirvieron para identificarlo.`
    );
  }
  const vague = data.skippedVague || [];
  if (vague.length) {
    const top = vague.slice(0, 3).map((v) => `${v.key} (${v.count})`).join(', ');
    note.push(
      `Sin comparar por títulos imprecisos: ${top}. ` +
      'Los anuncios no dicen el modelo exacto, así que compararlos sería inventar un margen. Busca algo más específico.'
    );
  }
  const secErr = (data.selected || []).map((s) => s.secondary?.error).find(Boolean);
  if (secErr) note.push(`${data.secondaryMarket}: ${secErr}`);
  $('#arbNote').textContent = note.join(' · ');

  // Rank by the best buy actually available, falling back to the median margin:
  // a model whose typical unit loses money can still hold an underpriced one.
  const bestUnitOf = (s) => unitWins(s)[0]?.netUsd ?? null;
  const rank = (s) => bestUnitOf(s) ?? effNet(s) ?? -Infinity;
  const all = (data.selected || []).slice().sort((a, b) => rank(b) - rank(a));
  const buyCount = all.reduce((n, s) => n + unitWins(s).length, 0);
  const bestUnit = all.map(bestUnitOf).filter((n) => n != null).sort((a, b) => b - a)[0] ?? null;
  const shown = onlyProfitable ? all.filter((s) => unitWins(s).length > 0) : all;

  const res = $('#arbRes');
  if (!all.length) {
    const vagueMsg = (data.skippedVague || []).length
      ? 'Los títulos no identifican un modelo concreto (p. ej. «Laptop Lenovo»), así que no hay nada comparable.<br />Prueba una búsqueda más específica: marca y modelo.'
      : 'Ningún modelo alcanzó el mínimo de 3 apariciones para poder comparar.<br />Prueba una búsqueda más amplia o sube el límite.';
    res.innerHTML = `<p class="empty">${vagueMsg}</p>` + distributionHtml(t.distribution);
    return;
  }

  res.innerHTML = `
    <div class="arb-hero">
      <div class="arb-score">
        <span class="arb-score-num ${buyCount ? 'pos' : 'neg'}">${buyCount}</span>
        <span class="arb-score-label">unidad(es) concretas<br />con margen en <b>${all.length}</b> modelos</span>
      </div>
      <div class="arb-hero-sep"></div>
      <div class="arb-hero-stat">
        <span class="k">Mejor unidad</span>
        <span class="v ${bestUnit != null && bestUnit > 0 ? 'pos' : ''}">${bestUnit == null ? '—' : (bestUnit > 0 ? '+' : '') + usd(bestUnit)}</span>
      </div>
      <div class="arb-hero-stat">
        <span class="k">Compras en</span>
        <span class="v">${escape(data.secondaryMarket)}</span>
      </div>
      <div class="arb-hero-stat">
        <span class="k">Vendes en</span>
        <span class="v">${escape(data.primaryMarket)}</span>
      </div>
      <label class="toggle arb-filter">
        <input type="checkbox" id="onlyProfitable" ${onlyProfitable ? 'checked' : ''} /> Solo con margen
      </label>
    </div>
    <div class="arb-list">
      ${shown.length
        ? shown.map((s) => modelCardHtml(s, data)).join('')
        : '<p class="empty">Ninguna unidad concreta deja margen con estos parámetros.</p>'}
    </div>
    ${distributionHtml(t.distribution)}`;

  const chk = document.getElementById('onlyProfitable');
  if (chk) chk.addEventListener('change', (ev) => { onlyProfitable = ev.target.checked; renderArbitrage(); });
}

document.addEventListener('DOMContentLoaded', () => {
  init();
  // Both sets belong: the closing-window ladder and the place picker are independent
  // controls, and each has to be built before it can be read.
  loadPlaces();
  $('#province').addEventListener('change', syncMunicipalities);
  $('#municipality').addEventListener('change', showSelection);
  fillAuctionWindows();
  syncWindowVisibility();
  $('#buyingFormat').addEventListener('change', syncWindowVisibility);
  $('#searchForm').addEventListener('submit', runSearch);
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
