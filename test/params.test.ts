import { describe, expect, it } from 'vitest';

/**
 * One table for the browser's form -> API translation.
 *
 * `public/params.js` is a classic browser script: public/index.html loads it with a
 * plain <script src> before app.js, and it installs `SecondhandParams` on the global
 * object. Importing it here is a side-effect import that runs the exact bytes the
 * browser runs, so a change to the page's parameter mapping cannot pass here by
 * accident. The same trick test/arbitrage-conversion.test.ts uses for public/fx.js.
 *
 * The invariant worth protecting: the search form decides how you BROWSE, and the
 * arbitrage panel decides what things COST. Only the first may see the buying format
 * and the closing window. When the second inherited them, the arbitrage buy side was
 * priced off live bids — which only go up — and reported margins that expire with the
 * next bid. `arbitrageBody` must never emit those two fields again.
 */
// @ts-expect-error — public/params.js is a browser asset with no type declarations (allowJs is off)
await import('../public/params.js');

interface AuctionWindow {
  minutes: number;
  label: string;
  group: string;
}

interface ParamsNamespace {
  AUCTION_WINDOWS: AuctionWindow[];
  WINDOW_GROUPS: { id: string; label: string }[];
  MAX_WINDOW_MINUTES: number;
  buyingFormatParams: (format: string, windowValue: unknown) => Record<string, unknown>;
  searchBody: (values: Record<string, unknown>) => Record<string, unknown>;
  arbitrageBody: (values: Record<string, unknown>) => Record<string, unknown>;
}

const P = (globalThis as unknown as { SecondhandParams: ParamsNamespace }).SecondhandParams;

/** Every combination the form can actually produce, minus `marketplace`/`query`. */
const FORMATS = ['fixed', 'auction', 'any'];
const WINDOW_VALUES: unknown[] = ['', ...P.AUCTION_WINDOWS.map((w) => String(w.minutes))];

const baseForm = (format: string, windowValue: unknown) => ({
  marketplace: 'ebay',
  query: 'iphone 15',
  location: 'Santo Domingo',
  radiusKm: '40',
  minPrice: '100',
  maxPrice: '900',
  limit: '40',
  format,
  window: windowValue,
});

describe('buyingFormatParams', () => {
  it.each([
    ['fixed', '', { buyingFormat: 'fixed' }],
    ['any', '', { buyingFormat: 'any' }],
    ['auction', '', { buyingFormat: 'auction' }],
    ['auction', '5', { buyingFormat: 'auction', endingWithinMinutes: 5 }],
    ['auction', '1440', { buyingFormat: 'auction', endingWithinMinutes: 1440 }],
  ])('maps format %s with window %j', (format, windowValue, expected) => {
    expect(P.buyingFormatParams(format, windowValue)).toEqual(expected);
  });

  // eBay applies itemEndDate under the auction format alone. Sending the window with
  // any other format would be a parameter that silently does nothing, so it is dropped
  // rather than forwarded — the request has to describe what actually happened.
  it.each(['fixed', 'any'])('drops the window for the non-auction format %s', (format) => {
    expect(P.buyingFormatParams(format, '5')).toEqual({ buyingFormat: format });
    expect(P.buyingFormatParams(format, '1440')).toEqual({ buyingFormat: format });
  });

  it.each([['0'], ['-5'], ['abc'], ['   '], [null], [undefined]])(
    'treats window %j as "any moment" rather than a filter',
    (windowValue) => {
      expect(P.buyingFormatParams('auction', windowValue)).toEqual({ buyingFormat: 'auction' });
    }
  );
});

describe('auction window ladder', () => {
  it('stays within the maximum the API accepts', () => {
    const widest = Math.max(...P.AUCTION_WINDOWS.map((w) => w.minutes));
    expect(widest).toBeLessThanOrEqual(P.MAX_WINDOW_MINUTES);
  });

  it('offers 5 minutes as the shortest window', () => {
    expect(Math.min(...P.AUCTION_WINDOWS.map((w) => w.minutes))).toBe(5);
  });

  it.each([['minutes'], ['label']])('has no duplicate %s', (field) => {
    const seen = P.AUCTION_WINDOWS.map((w) => String(w[field as 'minutes' | 'label']));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('is ordered from the narrowest window outwards', () => {
    const minutes = P.AUCTION_WINDOWS.map((w) => w.minutes);
    expect(minutes).toEqual([...minutes].sort((a, b) => a - b));
  });

  it('uses positive whole minutes', () => {
    for (const w of P.AUCTION_WINDOWS) {
      expect(Number.isInteger(w.minutes)).toBe(true);
      expect(w.minutes).toBeGreaterThan(0);
    }
  });

  it('assigns every window to a declared group, and every group a window', () => {
    const ids = P.WINDOW_GROUPS.map((g) => g.id);
    for (const w of P.AUCTION_WINDOWS) expect(ids).toContain(w.group);
    for (const id of ids) {
      expect(P.AUCTION_WINDOWS.filter((w) => w.group === id).length).toBeGreaterThan(0);
    }
  });
});

describe('searchBody', () => {
  it('carries the auction format and its window', () => {
    const body = P.searchBody(baseForm('auction', '15'));
    expect(body.buyingFormat).toBe('auction');
    expect(body.endingWithinMinutes).toBe(15);
  });

  it('carries the format without a window for "any moment"', () => {
    const body = P.searchBody(baseForm('auction', ''));
    expect(body.buyingFormat).toBe('auction');
    expect(body).not.toHaveProperty('endingWithinMinutes');
  });

  it('coerces numeric fields and keeps the default limit', () => {
    const body = P.searchBody({ marketplace: 'facebook', query: ' lamp ', limit: '' });
    expect(body.radiusKm).toBeUndefined();
    expect(body.minPrice).toBeUndefined();
    expect(body.maxPrice).toBeUndefined();
    expect(body.limit).toBe(40);
    expect(body.query).toBe('lamp');
  });

  // The key stays present with an undefined value, as it always has; JSON.stringify
  // drops it on the wire. What matters is that a blank field never becomes ''.
  it('never turns an empty location into an empty string', () => {
    expect(P.searchBody({ marketplace: 'facebook', query: 'lamp', location: '  ' }).location).toBeUndefined();
  });

  it('sends location when there is one', () => {
    expect(P.searchBody(baseForm('fixed', '')).location).toBe('Santo Domingo');
  });
});

describe('arbitrageBody', () => {
  // The whole point of the decoupling: no browsing choice may reach the comparison.
  it.each(FORMATS.flatMap((format) => WINDOW_VALUES.map((w) => [format, w] as const)))(
    'never forwards the buying basis for format %s window %j',
    (format, windowValue) => {
      const body = P.arbitrageBody(baseForm(format, windowValue));
      expect(body).not.toHaveProperty('buyingFormat');
      expect(body).not.toHaveProperty('endingWithinMinutes');
    }
  );

  it('keeps the comparison parameters it does own', () => {
    const body = P.arbitrageBody({ ...baseForm('auction', '5'), enrich: true });
    expect(body.topN).toBe(3);
    expect(body.minMatches).toBe(3);
    expect(body.enrichDescriptions).toBe(true);
    expect(body.limit).toBe(40);
    expect(body.marketplace).toBe('ebay');
  });

  it('only disables enrichment when the caller explicitly opts out', () => {
    expect(P.arbitrageBody({ ...baseForm('fixed', ''), enrich: false }).enrichDescriptions).toBe(false);
    expect(P.arbitrageBody(baseForm('fixed', '')).enrichDescriptions).toBe(true);
  });

  it('carries the same price and location filters as the search', () => {
    const form = baseForm('fixed', '');
    const arb = P.arbitrageBody(form);
    const search = P.searchBody(form);
    for (const field of ['marketplace', 'query', 'location', 'radiusKm', 'minPrice', 'maxPrice', 'limit']) {
      expect(arb[field]).toEqual(search[field]);
    }
  });
});
