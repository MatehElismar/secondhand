/**
 * Unit 5 — the browser consumes server-provided relevance, never re-implements
 * it. public/app.js is a classic browser script; like public/fx.js it exposes a
 * tiny pure seam (`SecondhandRelevance`) that these tests drive directly, so
 * the server decision can be pinned without a DOM.
 *
 * Contract under test:
 *  - when the API supplies top-level counters (supported family), only
 *    listings the server classified `matched` with a non-accessory reason are
 *    allowed into the model table;
 *  - without counters (legacy, unsupported family) every listing counts as
 *    before, and the raw array is never mutated — excluded rows are simply not
 *    statistical, they stay visible in the results list;
 *  - a small generic Spanish note surfaces the excluded counts/reasons.
 */
import { describe, expect, it, vi } from 'vitest';

// Module state is process-wide; import the exact bytes the browser loads.
vi.resetModules();
await import('../public/app.js');

const seam = (globalThis as unknown as { SecondhandRelevance: { eligibleForStats: Function; relevanceNote: Function } }).SecondhandRelevance;
const { eligibleForStats, relevanceNote } = seam;

const l = (id: string, title: string, priceNumeric: number, queryRelevance: unknown, isAccessory = false) => ({
  id,
  title,
  priceNumeric,
  currency: 'DOP',
  queryRelevance,
  ...(isAccessory ? { isAccessory: true } : {}),
});

/** The real mixed Google Pixel result shape used by the API/arbitrage units. */
const MIXED = [
  l('phone', 'Google Pixel 8 Pro 256GB Unlocked', 500, { status: 'matched', reason: 'matched', family: 'google-pixel', productKind: 'phone' }),
  l('watch', 'Pixel Watch 2 GPS 41mm', 180, { status: 'matched', reason: 'matched', family: 'google-pixel', productKind: 'watch' }),
  l('tablet', 'Pixel Tablet 128GB', 300, { status: 'matched', reason: 'matched', family: 'google-pixel', productKind: 'tablet' }),
  l('gogle', 'Gogle Pixel 8 128GB', 380, { status: 'matched', reason: 'typo-matched', family: 'google-pixel', productKind: 'phone', distance: 1 }),
  l('iphone', 'iPhone 15 Pro 256GB', 800, { status: 'mismatch', reason: 'competing-family' }),
  l('galaxy', 'Samsung Galaxy S23 Ultra', 650, { status: 'mismatch', reason: 'competing-family' }),
  l('xiaomi', 'Xiaomi Redmi Note 13', 150, { status: 'mismatch', reason: 'competing-family' }),
  l('oneplus', 'OnePlus 12', 520, { status: 'mismatch', reason: 'competing-family' }),
  l('de128', 'Google DE128', 999, { status: 'ambiguous', reason: 'missing-product-anchor' }),
  l('case', 'Case For Google Pixel 8', 40, { status: 'matched', reason: 'accessory', family: 'google-pixel' }, true),
  // models-only accessory vocabulary (W1): relevance says matched/phone, isAccessory says part.
  l('mica', 'Mica Para Pixel 8', 15, { status: 'matched', reason: 'matched', family: 'google-pixel', productKind: 'phone' }, true),
];

const COUNTERS = {
  raw: 10,
  matched: 4,
  excluded: 6,
  reasons: { mismatch: 4, ambiguous: 1, accessory: 1 },
};

describe('browser stats eligibility (Unit 5)', () => {
  it('with counters, only matched non-accessory listings feed the model table', () => {
    const ids = eligibleForStats(MIXED, COUNTERS).map((x: any) => x.id);
    expect(ids).toEqual(['phone', 'watch', 'tablet', 'gogle']);
  });

  it('without counters (legacy) every listing counts exactly as before', () => {
    expect(eligibleForStats(MIXED, undefined)).toHaveLength(MIXED.length);
    expect(eligibleForStats(MIXED, null)).toHaveLength(MIXED.length);
  });

  it('exclusion is a filter, never a loss: the raw listings stay untouched', () => {
    const before = MIXED.slice();
    eligibleForStats(MIXED, COUNTERS);
    expect(MIXED).toEqual(before);
  });
});

describe('browser relevance note (Unit 5)', () => {
  it('surfaces the excluded count and reasons in Spanish', () => {
    const note = relevanceNote(COUNTERS);
    expect(note).toContain('4 de 10');
    expect(note).toContain('6 excluido');
    expect(note).toContain('4 de otra familia');
    expect(note).toContain('1 sin identificar');
    expect(note).toContain('1 accesorio');
  });

  it('stays silent when the server supplied no counters', () => {
    expect(relevanceNote(undefined)).toBe('');
    expect(relevanceNote(null)).toBe('');
  });
});