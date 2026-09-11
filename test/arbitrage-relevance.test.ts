/**
 * Unit 4 — shared query-relevance contract inside runArbitrage.
 *
 * For a supported Google Pixel-family query, the primary listings are
 * classified server-side after enrichment and only `matched` non-accessory
 * rows may drive allModels, totals.usd, the distribution and the selected
 * groups — an iPhone or a Google DE128 config title must never steer the
 * comparison. Unsupported families keep the legacy pipeline untouched: no
 * relevance counters, nothing excluded merely because the first resolver is
 * not-applicable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runArbitrage } from '../src/arbitrage.js';

const h = vi.hoisted(() => ({
  primary: [] as any[],
  secondary: [] as any[],
}));

vi.mock('../src/marketplaces/index.js', () => {
  const facebook: any = {
    name: 'facebook',
    displayName: 'Facebook Marketplace',
    requiresAuth: false,
    async search() {
      return { marketplace: 'facebook', success: true, listings: h.primary };
    },
  };
  const ebay: any = {
    name: 'ebay',
    displayName: 'eBay',
    requiresAuth: true,
    async search() {
      return { marketplace: 'ebay', success: true, listings: h.secondary };
    },
  };
  return {
    initializeMarketplaces: () => {},
    getMarketplace: (name: string) => (name === 'facebook' ? facebook : name === 'ebay' ? ebay : undefined),
    getAllMarketplaces: () => [facebook, ebay],
    registerMarketplace: () => {},
    listMarketplaceNames: () => ['facebook', 'ebay'],
  };
});

const listing = (id: string, title: string, priceNumeric: number) => ({
  id,
  title,
  price: `$${priceNumeric}`,
  priceNumeric,
  currency: 'USD',
  url: `https://example.com/${id}`,
  marketplace: 'facebook',
  scrapedAt: '2026-01-01T00:00:00.000Z',
});

/** A Google Pixel result polluted by competitors, config junk and accessories. */
const mixedPrimary = () => [
  // matched Pixel phones (3x Pixel 8 Pro, 2x Pixel 7a, 1 typo'd Google)
  listing('p1', 'Google Pixel 8 Pro 256GB Unlocked', 500),
  listing('p2', 'Google Pixel 8 Pro 256GB Unlocked', 520),
  listing('p3', 'Google Pixel 8 Pro 256GB Unlocked', 540),
  listing('a1', 'Pixel 7a 128GB', 250),
  listing('a2', 'Pixel 7a 128GB', 260),
  listing('g1', 'Gogle Pixel 8 128GB Factory Unlocked', 380),
  // matched Watch and Tablet
  listing('w1', 'Pixel Watch 2 GPS 41mm', 180),
  listing('w2', 'Pixel Watch 2 GPS 41mm', 190),
  listing('t1', 'Pixel Tablet 128GB', 300),
  // competing families — must never surface in a Pixel comparison
  listing('i1', 'iPhone 15 Pro 256GB Unlocked', 800),
  listing('i2', 'iPhone 15 Pro 256GB Unlocked', 820),
  listing('i3', 'iPhone 15 Pro 256GB Unlocked', 840),
  listing('ga1', 'Samsung Galaxy S23 Ultra 512GB', 650),
  listing('xm1', 'Xiaomi Redmi Note 13 128GB', 150),
  listing('op1', 'OnePlus 12 16GB', 520),
  // ambiguous Google config title
  listing('de1', 'Google DE128', 999),
  // accessories
  listing('c1', 'Case For Google Pixel 8', 40),
  listing('c2', 'Case For Google Pixel 8', 45),
  // models-only accessory vocabulary: relevance says matched, isAccessoryListing catches it
  listing('mica', 'Mica Para Pixel 8', 15),
];

beforeEach(() => {
  h.primary = [];
  h.secondary = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runArbitrage — Google Pixel query (Unit 4)', () => {
  it('exposes aggregate relevance counters while keeping the raw listing count', async () => {
    h.primary = mixedPrimary();
    const r = await runArbitrage({
      marketplace: 'facebook',
      query: 'google pixel',
      topN: 3,
      minMatches: 2,
      enrichDescriptions: false,
    });
    // raw list semantics: every returned listing is counted.
    expect(r.totals.listingsCount).toBe(19);
    // 9 matched non-accessory (Pixel 8 Pro x3, 7a x2, Watch x2, Tablet, typo
    // Pixel 8) vs 4+1+1 mismatches, 1 ambiguous DE128, 2 accessories.
    expect(r.totals.relevance).toEqual({
      raw: 19,
      matched: 9,
      excluded: 10,
      reasons: { mismatch: 6, ambiguous: 1, accessory: 3 },
    });
  });

  it('computes allModels, usd and distribution only from matched non-accessory listings', async () => {
    h.primary = mixedPrimary();
    const r = await runArbitrage({
      marketplace: 'facebook',
      query: 'google pixel',
      topN: 3,
      minMatches: 2,
      enrichDescriptions: false,
    });
    const keys = r.allModels.map((s) => s.key);
    expect(keys.sort()).toEqual([
      'Pixel 7a 128GB',
      'Pixel 8 128GB',
      'Pixel 8 Pro 256GB',
      'Pixel Tablet 128GB',
      'Pixel Watch 2',
    ]);
    // Competitors, the config title and the cases never form a group.
    expect(keys.join('|')).not.toMatch(/iPhone|Galaxy|Xiaomi|OnePlus|DE128|De128/i);
    expect(r.allModels.find((s) => s.key === 'Pixel 8 Pro 256GB')?.count).toBe(3);
    // W1: the mica row (models-only accessory vocabulary) never forms a group.
    expect(keys.join('|')).not.toMatch(/Mica/i);
    expect(r.totals.usd.sample).toBe(9);
    // median of matched prices [500,520,540,250,260,380,180,190,300] == 300
    expect(r.totals.usd.median).toBe(300);
    const bucketCount = r.totals.distribution.reduce((n: number, b) => n + b.count, 0);
    expect(bucketCount).toBe(9);
  });

  it('selected groups and secondary comparisons cannot be driven by competitors or junk', async () => {
    h.primary = mixedPrimary();
    const r = await runArbitrage({
      marketplace: 'facebook',
      query: 'google pixel',
      topN: 3,
      minMatches: 2,
      enrichDescriptions: false,
    });
    expect(r.selected.map((s) => s.key)).toEqual(['Pixel 8 Pro 256GB', 'Pixel 7a 128GB', 'Pixel Watch 2']);
    // The iPhone group also has 3 listings — in a Pixel comparison it must not
    // win a slot (and therefore never drives a secondary eBay comparison).
    expect(r.selected.map((s) => s.key).join('|')).not.toMatch(/iPhone/i);
    for (const s of r.selected) {
      expect(s.secondary.error).toBeUndefined();
      expect(s.secondary.usd?.median).toBeNull(); // stub eBay returns nothing
    }
  });
});

describe('runArbitrage — unsupported family keeps legacy behavior', () => {
  it('does not exclude listings and exposes no relevance counters for a non-Pixel query', async () => {
    h.primary = mixedPrimary();
    const r = await runArbitrage({
      marketplace: 'facebook',
      query: 'samsung galaxy s23',
      topN: 3,
      minMatches: 2,
      enrichDescriptions: false,
    });
    expect(r.totals.relevance).toBeUndefined();
    // raw semantics unchanged: everything counts, nothing is excluded.
    expect(r.totals.listingsCount).toBe(19);
    // Legacy grouping keeps real competitor groups (iPhone found here).
    expect(r.allModels.some((s) => /iPhone/.test(s.key))).toBe(true);
    // The ambiguous config title still surfaces as a low-confidence bucket, not
    // a high-confidence Google model.
    expect(r.allModels.some((s) => /DE128|De128/.test(s.key))).toBe(true);
  });
});