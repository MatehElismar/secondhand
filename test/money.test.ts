import { describe, expect, it } from 'vitest';

/**
 * Why this file exists.
 *
 * Every money formatter in public/app.js built its string by concatenating a bare "$",
 * so the peso summary table and the dollar arbitrage panel rendered the same unit. The
 * peso case was not cosmetic: a listing priced in dollars is multiplied by the DOP rate
 * on the way in, so a US$100 item reached the peso table as 6,000 and printed "$6,000" —
 * a hundred dollars reading as six thousand.
 *
 * `public/money.js` is a classic browser script: public/index.html loads it with a plain
 * <script src> before app.js, and it installs `SecondhandMoney` on the global object.
 * Importing it here runs the exact bytes the browser runs, the same trick
 * test/arbitrage-conversion.test.ts and test/params.test.ts use.
 */
// @ts-expect-error — public/money.js is a browser asset with no type declarations (allowJs is off)
await import('../public/money.js');

interface Money {
  DOP: { format(n: number): string };
  USD: { format(n: number): string };
  label: (listing?: {
    price?: unknown;
    priceNumeric?: unknown;
    currency?: unknown;
  }) => string;
}

const M = (globalThis as unknown as { SecondhandMoney: Money }).SecondhandMoney;

describe('SecondhandMoney', () => {
  it('names the currency instead of leaving a bare symbol', () => {
    expect(M.DOP.format(22000)).toBe('RD$22,000');
    expect(M.USD.format(100)).toBe('US$100');
  });

  // The exact failure this module exists to prevent.
  it('reads as pesos when a dollar listing was converted into the peso table', () => {
    // US$100 -> x60 -> 6,000 DOP, printed with a bare "$" it claimed six thousand dollars.
    expect(M.DOP.format(6000)).toBe('RD$6,000');
  });

  // CLDR es-DO matches the US convention: "," groups, "." separates decimals. The old
  // code pinned en-US, which agreed on grouping and still got the currency wrong, so the
  // agreement is asserted here on purpose rather than left accidental.
  it('groups the Dominican way, which is not the es-ES way', () => {
    expect(M.DOP.format(1234567)).toBe('RD$1,234,567');
    expect(M.DOP.format(1234567)).not.toContain('.');
  });

  it('never shows centavos in the middle of a median', () => {
    expect(M.DOP.format(34990.4)).toBe('RD$34,990');
    expect(M.USD.format(1850.5)).toBe('US$1,851');
    expect(M.DOP.format(0)).toBe('RD$0');
  });

  it('keeps the sign on a negative margin', () => {
    expect(M.USD.format(-180)).toBe('-US$180');
    expect(M.DOP.format(-3500)).toBe('-RD$3,500');
  });
});

describe('SecondhandMoney.label', () => {
  const listing = (over: Record<string, unknown> = {}) => ({
    price: 'RD$20.000',
    priceNumeric: 20000,
    currency: 'DOP',
    ...over,
  });

  // The cards used to print the seller's string, which uses a dot for thousands while the
  // table formatted the same amount with a comma.
  it('formats a peso listing the way the summary table does', () => {
    expect(M.label(listing())).toBe('RD$20,000');
    expect(M.label(listing({ currency: 'RD$' }))).toBe('RD$20,000');
  });

  it('formats a dollar listing as dollars', () => {
    expect(M.label(listing({ price: 'US$100', priceNumeric: 100, currency: 'USD' }))).toBe('US$100');
  });

  // fx.js reads a bare "$" as dollars, so this has to agree, or a card and the summary
  // table would describe the same listing in two different currencies.
  it('treats a bare "$" exactly the way fx.js does', () => {
    expect(M.label(listing({ price: '$100', priceNumeric: 100, currency: '$' }))).toBe('US$100');
  });

  // readCurrency reports an unmapped symbol instead of guessing, and fx.js drops those
  // listings, so there is nothing honest to invent here.
  it('keeps the seller string when the currency cannot be mapped', () => {
    const guarani = listing({ price: '₲2.100.000', priceNumeric: 2100000, currency: '₲' });
    expect(M.label(guarani)).toBe('₲2.100.000');
  });

  it('falls back to the seller string when no number was parsed', () => {
    expect(M.label({ price: 'A convenir' })).toBe('A convenir');
    expect(M.label({ price: 'A convenir', priceNumeric: null, currency: 'DOP' })).toBe('A convenir');
  });

  it('survives a listing with no price at all', () => {
    expect(M.label({})).toBe('');
    expect(M.label(undefined)).toBe('');
  });
});
