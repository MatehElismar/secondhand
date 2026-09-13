/* Secondhand Arbitrage — form values -> API parameters, for the browser.
 *
 * Lives in its own file, loaded as a classic script before public/app.js, for the
 * same reason public/fx.js does: app.js runs top-level `document.addEventListener`
 * and cannot be imported by the node test environment, so anything worth testing
 * has to be reachable without a DOM. test/params.test.ts imports this exact file.
 *
 * It exists for one invariant that is easy to break by accident. The search form
 * decides HOW YOU BROWSE; the arbitrage panel decides WHAT THINGS COST. Those are
 * different questions, and only the first may see the buying format and the auction
 * closing window. Letting the second inherit them prices the arbitrage buy side off
 * live bids — which only ever go up — and `src/arbitrage.ts` already documents why
 * that "invents profit": see the note above `isAuctionOnly`. So `arbitrageBody`
 * never emits `buyingFormat` or `endingWithinMinutes`, and the test holds that line.
 */
(function (root) {
  'use strict';

  /**
   * The auction closing windows the UI offers, and why these values.
   *
   * Measured against the live eBay Browse API (EBAY_US, `totalFound`, 6 queries).
   * Auction volume grows monotonically with the window and is heavily skewed to the
   * wide end: everything closing within an hour is about 3% of what closes within a
   * day. A ladder that stops at an hour shows a rounding error of the market, so the
   * groups below deliberately span both regimes:
   *
   *   close   — few listings, but a current bid is closest to the final price
   *   explore — enough volume for a median to mean something, weaker price signal
   *
   * Steps of five minutes are NOT used: windows are nested ranges, not disjoint
   * buckets, so 20/25/35/40/50/55 only re-show the same listings as their neighbours
   * for a handful of extra items. 5 is the floor because it is the shortest window
   * still worth offering; it is frequently empty, which the UI states outright.
   */
  const AUCTION_WINDOWS = [
    { minutes: 5, label: '≤5 min', group: 'close' },
    { minutes: 10, label: '≤10 min', group: 'close' },
    { minutes: 15, label: '≤15 min', group: 'close' },
    { minutes: 30, label: '≤30 min', group: 'close' },
    { minutes: 60, label: '≤1 h', group: 'close' },
    { minutes: 120, label: '≤2 h', group: 'explore' },
    { minutes: 360, label: '≤6 h', group: 'explore' },
    { minutes: 720, label: '≤12 h', group: 'explore' },
    { minutes: 1440, label: '≤24 h', group: 'explore' },
  ];

  /** Group headings, in display order. Labels say what you pay for the extra volume. */
  const WINDOW_GROUPS = [
    { id: 'close', label: 'Cerrar pronto · el precio ya es casi el final' },
    { id: 'explore', label: 'Explorar · más volumen, precio menos confiable' },
  ];

  /**
   * Above this the parameter stops meaning "closing soon" and a current bid stops
   * approximating the final price. Mirrors the `maximum` on `endingWithinMinutes` in
   * src/api.ts; the test asserts the ladder above never exceeds it.
   */
  const MAX_WINDOW_MINUTES = 1440;

  /** Form value -> number, or undefined. Empty string and booleans are not numbers. */
  const num = (v) => {
    if (v == null || v === '' || typeof v === 'boolean') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  /**
   * Buying format -> the two parameters POST /v1/search understands.
   *
   * The window is only meaningful with `buyingFormat: 'auction'`: src/marketplaces/ebay.ts
   * applies `itemEndDate` under that format alone and ignores it for every other one.
   * Emitting it anyway would send a parameter that silently does nothing, so it is
   * dropped here instead.
   */
  const buyingFormatParams = (format, windowValue) => {
    if (format !== 'auction') return { buyingFormat: format };
    const minutes = num(windowValue);
    // 'Cualquier momento' means every auction, which is the absence of the filter —
    // not a filter of zero minutes.
    if (minutes == null || minutes <= 0) return { buyingFormat: 'auction' };
    return { buyingFormat: 'auction', endingWithinMinutes: minutes };
  };

  /** POST /v1/search body. `limit` keeps its historical default of 40. */
  const searchBody = (v) => ({
    marketplace: v.marketplace,
    query: String(v.query ?? '').trim(),
    location: String(v.location ?? '').trim() || undefined,
    // Kilometres: the UI is kilometre-native because the market it serves is Dominican.
    // The API converts to the miles its SearchParams still carries.
    radiusKm: num(v.radiusKm),
    minPrice: num(v.minPrice),
    maxPrice: num(v.maxPrice),
    limit: num(v.limit) || 40,
    ...buyingFormatParams(v.format, v.window),
  });

  /**
   * POST /v1/arbitrage body.
   *
   * Deliberately forwards neither the buying format nor the closing window. The
   * arbitrage answers "what does this cost on the other side" and prices its buy side
   * off Buy It Now, which is the endpoint's own documented default. Inheriting the
   * form's auction window would price that median off live bids, shrink its sample to
   * a couple of units, and report margins that expire with the next bid.
   */
  const arbitrageBody = (v) => ({
    marketplace: v.marketplace,
    query: String(v.query ?? '').trim(),
    location: String(v.location ?? '').trim() || undefined,
    radiusKm: num(v.radiusKm),
    minPrice: num(v.minPrice),
    maxPrice: num(v.maxPrice),
    limit: num(v.limit) || 40,
    topN: 3,
    minMatches: 3,
    enrichDescriptions: v.enrich !== false,
  });

  root.SecondhandParams = {
    AUCTION_WINDOWS,
    WINDOW_GROUPS,
    MAX_WINDOW_MINUTES,
    buyingFormatParams,
    searchBody,
    arbitrageBody,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
