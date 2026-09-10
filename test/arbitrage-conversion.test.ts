import { describe, expect, it } from 'vitest';
import { toUsd } from '../src/arbitrage.js';

/**
 * One table for both sides of the wire.
 *
 * The server (`toUsd`, src/arbitrage.ts) answers "what does this listing cost in
 * USD?" and the browser (`toDOP`, public/fx.js) answers "what does it cost in
 * pesos?". Those are two views of a single rate, and they were shipped as two
 * independent copies of it — which is how a peso price ended up multiplied by 60
 * on one side and read as dollars on the other. Driving both from the rows below
 * means a change to one copy without the other fails here.
 *
 * `public/fx.js` is a classic browser script: public/index.html loads it with a
 * plain <script src> before app.js, and it installs `SecondhandFX` on the global
 * object. Importing it here is a side-effect import that runs the exact file the
 * browser runs — no third copy of the rate is created for the tests.
 */
// @ts-expect-error — public/fx.js is a browser asset with no type declarations
// (allowJs is off), but importing it is the point: the test must run the same
// bytes the browser loads rather than a copy of them.
await import('../public/fx.js');

interface FxNamespace {
  FX_DOP_PER_USD: number;
  toDOP: (listing: { priceNumeric?: number; currency?: string }) => number | null;
}

const fx = (globalThis as unknown as { SecondhandFX: FxNamespace }).SecondhandFX;
const { FX_DOP_PER_USD, toDOP } = fx;

interface Row {
  /** Omitted rows exercise a listing whose currency was never parsed. */
  currency?: string;
  amount: number;
  /** Expected `toUsd(amount, currency)`. Null = no known FX rate. */
  usd: number | null;
  /** Expected `toDOP({ priceNumeric: amount, currency })`. */
  dop: number | null;
}

const CONTRACT: Row[] = [
  // DOP is the local market: the only rate we actually hold.
  { currency: 'DOP', amount: 1190, usd: 1190 / FX_DOP_PER_USD, dop: 1190 },
  // The live probe's own numbers: the reported Mín/Mediana/Máx were RD$1,190,
  // RD$11,000 and RD$19,700, charted as $71,400 / $660,000 / $1,182,000.
  { currency: 'DOP', amount: 14_500, usd: 14_500 / FX_DOP_PER_USD, dop: 14_500 },
  { currency: 'DOP', amount: 19_700, usd: 19_700 / FX_DOP_PER_USD, dop: 19_700 },
  // "$" and "USD" are already dollars. "$" is ambiguous in a listing string, so
  // it is read at face value and never silently scaled in either direction.
  { currency: '$', amount: 1190, usd: 1190, dop: 1190 * FX_DOP_PER_USD },
  { currency: 'USD', amount: 1190, usd: 1190, dop: 1190 * FX_DOP_PER_USD },
  // Case is not meaningful, and both sides normalize it the same way.
  { currency: 'dop', amount: 1190, usd: 1190 / FX_DOP_PER_USD, dop: 1190 },
  { currency: 'usd', amount: 100, usd: 100, dop: 100 * FX_DOP_PER_USD },
  { currency: 'UsD', amount: 25, usd: 25, dop: 25 * FX_DOP_PER_USD },
  // Neither side rounds: a fractional price stays fractional.
  { currency: 'USD', amount: 19.99, usd: 19.99, dop: 19.99 * FX_DOP_PER_USD },
  { currency: 'DOP', amount: 19.99, usd: 19.99 / FX_DOP_PER_USD, dop: 19.99 },
  // No known rate: null, never quietly reported as USD.
  { currency: 'EUR', amount: 1190, usd: null, dop: null },
  { currency: 'GBP', amount: 100, usd: null, dop: null },
  { currency: 'MXN', amount: 5000, usd: null, dop: null },
  // 'RD$' is a token the price parser maps to DOP, not a currency code in its own
  // right. If one ever reaches the converters it is unknown, not a guess.
  { currency: 'RD$', amount: 1190, usd: null, dop: null },
];

describe('currency conversion contract (server)', () => {
  it('converts a listing to USD, or reports null when the rate is unknown', () => {
    for (const row of CONTRACT) {
      const got = toUsd(row.amount, row.currency);
      if (row.usd == null) expect(got, `${row.currency} must not be claimed as USD`).toBeNull();
      else expect(got, row.currency!).toBeCloseTo(row.usd, 10);
    }
  });

  it('does not inflate a peso price into dollars (the 60x regression)', () => {
    // Live probe: RD$1,190 listings were fed to the buy/sell medians as $1,190
    // and every reported figure came out 60x too high.
    expect(toUsd(1190, 'DOP')).toBeCloseTo(19.83, 2);
    expect(toUsd(11_000, 'DOP')).toBeCloseTo(183.33, 2);
  });
});

describe('currency conversion contract (browser)', () => {
  it('converts a listing to DOP, or reports null when the rate is unknown', () => {
    for (const row of CONTRACT) {
      const got = toDOP({ priceNumeric: row.amount, currency: row.currency });
      if (row.dop == null) expect(got, `${row.currency} must not be charted as pesos`).toBeNull();
      else expect(got, row.currency!).toBeCloseTo(row.dop, 10);
    }
  });

  it('does not scale a peso listing up by 60 (the 60x regression)', () => {
    // Live probe: Mín $71,400 / Mediana $660,000 were really RD$1,190 / RD$11,000.
    expect(toDOP({ priceNumeric: 1190, currency: 'DOP' })).toBe(1190);
    expect(toDOP({ priceNumeric: 11_000, currency: 'DOP' })).toBe(11_000);
  });
});

describe('the two copies cannot drift apart', () => {
  it('reads the same rate on both sides', () => {
    // 600 DOP is 10 USD on the server and 10 USD is 600 DOP in the browser. If
    // either copy changes its rate alone, one of these fails.
    expect(toUsd(600, 'DOP')).toBeCloseTo(10, 10);
    expect(toDOP({ priceNumeric: 10, currency: 'USD' })).toBeCloseTo(600, 10);
  });

  it('stays inverse across the whole table, or agrees on the same null', () => {
    for (const row of CONTRACT) {
      const usd = toUsd(row.amount, row.currency);
      const dop = toDOP({ priceNumeric: row.amount, currency: row.currency });
      if (usd == null) expect(dop, `${row.currency}`).toBeNull();
      else expect(dop, `${row.currency}`).toBeCloseTo(usd * FX_DOP_PER_USD, 10);
    }
  });
});

describe('conversion edge cases', () => {
  const missing = [
    ['an absent currency', undefined],
    ['an empty currency', ''],
    // Neither side trims, so both must agree that this is not a currency.
    ['a whitespace-only currency', ' '],
    ['a padded currency', ' DOP '],
  ] as const;

  it('treats an unparsed currency as unknown on both sides', () => {
    for (const [label, currency] of missing) {
      expect(toUsd(100, currency), label).toBeNull();
      expect(toDOP({ priceNumeric: 100, currency }), label).toBeNull();
    }
  });

  it('treats a missing price as unknown on both sides', () => {
    expect(toUsd(undefined, 'DOP')).toBeNull();
    expect(toUsd(undefined, 'USD')).toBeNull();
    expect(toDOP({ currency: 'DOP' })).toBeNull();
    expect(toDOP({ currency: 'USD' })).toBeNull();
    expect(toDOP({})).toBeNull();
    expect(toDOP(null as unknown as { priceNumeric?: number })).toBeNull();
  });

  it('keeps a real zero instead of calling it unknown', () => {
    expect(toUsd(0, 'DOP')).toBe(0);
    expect(toUsd(0, 'USD')).toBe(0);
    expect(toDOP({ priceNumeric: 0, currency: 'DOP' })).toBe(0);
    expect(toDOP({ priceNumeric: 0, currency: 'USD' })).toBe(0);
  });

  it('agrees that a negative price is negative on both sides', () => {
    // A negative price is a data error, not an unknown currency: neither side is
    // allowed to turn it into a rate-dependent value, and both stay non-positive
    // so the range filters below every consumer drop it.
    expect(toUsd(-100, 'DOP')! < 0).toBe(true);
    expect(toDOP({ priceNumeric: -100, currency: 'DOP' })! < 0).toBe(true);
    expect(toUsd(-100, 'USD')! < 0).toBe(true);
    expect(toDOP({ priceNumeric: -100, currency: 'USD' })! < 0).toBe(true);
  });

  it('passes a NaN price through as NaN on both sides (consumers drop it)', () => {
    // Not a fix, a documented agreement: a NaN price reaching either copy is
    // dropped by the `> 0` filters in groupStats/toUsd callers and in app.js, so
    // neither side invents a rate for it. Pinned so the two stay identical.
    expect(Number.isNaN(toUsd(NaN, 'DOP') as number)).toBe(true);
    expect(Number.isNaN(toDOP({ priceNumeric: NaN, currency: 'DOP' }) as number)).toBe(true);
    expect(Number.isNaN(toUsd(NaN, 'EUR') as number)).toBe(false); // unknown still wins
    expect(Number.isNaN(toDOP({ priceNumeric: NaN, currency: 'EUR' }) as number)).toBe(false);
  });
});
