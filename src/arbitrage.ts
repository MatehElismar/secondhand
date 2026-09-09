/**
 * Arbitrage analysis: compare a primary market's listings against another
 * market, per normalized product/model, and surface price deltas and profit
 * estimates.
 *
 *   POST /v1/arbitrage
 *   primary search  ->  group by model  ->  pick top N (count >= minMatches)
 *   ->  search the OTHER market for each model  ->  figure the delta/margin.
 *
 * Currency is normalized to USD (DOP -> USD at a fixed rate). eBay is a
 * national search, so the comparison is "local primary cost" vs "national
 * secondary price" — treat the margin as an estimate.
 */

import { getMarketplace } from './marketplaces/index.js';

const FX_DOP_PER_USD = 60; // heuristic; adjust to current rate
const EBAY_FEE_RATE = 0.13; // rough final-value fee
const SHIPPING_COST_USD = 10;
const SECONDS_IN_DAY = 24 * 60 * 60;

export interface GroupStat {
  key: string;
  count: number;
  sample: number;
  avg: number | null;
  median: number | null;
  p25: number | null;
  p75: number | null;
  min: number | null;
  max: number | null;
}

export interface PriceStats {
  sample: number;
  avg: number | null;
  median: number | null;
  p25: number | null;
  p75: number | null;
  min: number | null;
  max: number | null;
}

export interface ArbitrageOptions {
  marketplace?: string;
  query: string;
  location?: string;
  radius?: number;
  minPrice?: number;
  maxPrice?: number;
  limit?: number;
  topN?: number;
  minMatches?: number;
}

export function toUsd(n: number | undefined, currency?: string): number | null {
  if (n == null) return null;
  const c = String(currency || '').toUpperCase();
  return c === 'DOP' ? n / FX_DOP_PER_USD : n;
}

export function dollar(n: number | null | undefined): number | null {
  return n == null ? null : Math.round(n);
}

export function modelKey(title: string): string {
  const t = String(title || '').toLowerCase();
  const cap = (w: string) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : '');
  const storage = (): string => {
    const m = t.match(/(\d+(?:\.\d+)?)\s?(gb|tb)/i);
    return m ? ` ${m[1].toUpperCase()}${m[2].toUpperCase()}` : '';
  };

  if (/iphone/.test(t)) {
    let k = 'iPhone';
    const m = t.match(/iphone\s*(\d+)(?:\s*(pro|max|mini|plus|air|ultra))?/i);
    if (m) k += ` ${m[1]}${m[2] ? ' ' + cap(m[2]) : ''}`;
    return k + storage();
  }
  if (/ipad/.test(t)) {
    let k = 'iPad';
    const m = t.match(/(mini|air|pro)/i);
    const gen = t.match(/(\d+)(?:st|nd|rd|th)?\s*(?:gen|generation)/i) || t.match(/generaci[oó]n\s*(\d+)/i) || t.match(/ipad\s*(\d+)/i);
    if (m) k += ` ${cap(m[1])}`;
    else if (gen) k += ` ${gen[1]}`;
    return k + storage();
  }
  if (/apple watch|applewatch|iwatch|watch\s*(se|ultra|series)|series|serie/.test(t)) {
    let k = 'Apple Watch';
    const s = t.match(/series\s*(\d+)|serie\s*(\d+)| ultra| se\b/i);
    if (s) k += ` ${s[2] ? `Serie ${s[2]}` : cap(s[0].trim())}`;
    return k;
  }
  if (/macbook|mac book/.test(t)) {
    const s = t.match(/(pro|air|m\d+)/i);
    return 'MacBook' + (s ? ' ' + s[1].toUpperCase() : '') + storage();
  }
  if (/samsung|galaxy/.test(t)) {
    const s = t.match(/galaxy\s*([\w\d]+)/i);
    return 'Samsung' + (s ? ' ' + s[1] : '') + storage();
  }
  const fallback = String(title || '').replace(/[^a-z0-9 ]/gi, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 2).join(' ');
  return fallback || 'Other';
}

function percentile(arr: number[], p: number): number | null {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const v = s[lo] + (s[hi] - s[lo]) * (idx - lo);
  return Math.round(v);
}

export function statsOf(prices: number[]): PriceStats {
  const avg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
  return {
    sample: prices.length,
    avg: dollar(avg ?? 0),
    median: percentile(prices, 50),
    p25: percentile(prices, 25),
    p75: percentile(prices, 75),
    min: prices.length ? Math.round(Math.min(...prices)) : null,
    max: prices.length ? Math.round(Math.max(...prices)) : null,
  };
}

export function groupStats(listings: any[]): GroupStat[] {
  const groups = new Map<string, { key: string; count: number; prices: number[] }>();
  for (const l of listings) {
    const key = modelKey(l.title) || 'Other';
    const g = groups.get(key) || { key, count: 0, prices: [] };
    g.count += 1;
    const u = toUsd(l.priceNumeric, l.currency);
    if (u != null && u > 0) g.prices.push(u);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({
    key: g.key,
    count: g.count,
    ...statsOf(g.prices),
  }));
}

export function bucketize(prices: number[], buckets = 6): Array<{ from: number; to: number; count: number }> {
  if (!prices.length) return [];
  const max = Math.max(...prices);
  const width = Math.max(1, Math.round(max / buckets));
  const out = Array.from({ length: buckets }, (_, i) => ({ from: i * width, to: (i + 1) * width, count: 0 }));
  for (const p of prices) {
    const idx = Math.min(buckets - 1, Math.floor(p / width));
    out[idx].count += 1;
  }
  return out;
}

export async function runArbitrage(opts: ArbitrageOptions) {
  const marketplace = opts.marketplace || 'facebook';
  const secondaryName = marketplace === 'facebook' ? 'ebay' : 'facebook';
  const limit = opts.limit || 40;
  const topN = opts.topN || 3;
  const minMatches = opts.minMatches || 3;

  const primary = getMarketplace(marketplace);
  const secondary = getMarketplace(secondaryName);

  const params: any = {
    query: opts.query,
    location: opts.location,
    radius: opts.radius,
    minPrice: opts.minPrice,
    maxPrice: opts.maxPrice,
    limit,
  };
  if (!primary) throw new Error(`Unknown marketplace: ${marketplace}`);

  const primaryResult = await primary.search(params);
  const listings = primaryResult.listings || [];
  const allModels = groupStats(listings);

  const priced = listings.map((l: any) => toUsd(l.priceNumeric, l.currency)).filter((v): v is number => v != null && v > 0);
  const totals = {
    success: primaryResult.success,
    error: primaryResult.error || undefined,
    listingsCount: listings.length,
    modelCount: allModels.length,
    distribution: bucketize(priced),
    usd: statsOf(priced),
  };

  const eligible = allModels.filter((s) => s.count >= minMatches);
  const top = eligible.slice().sort((a, b) => b.count - a.count || (b.avg ?? 0) - (a.avg ?? 0)).slice(0, topN);

  const selected = [];
  for (const s of top) {
    let secondaryInfo: any = { count: 0, sample: 0, usd: null, listings: [], error: undefined };
    if (secondary) {
      const secResult = await secondary.search({ query: s.key, limit });
      const secListings = secResult.listings || [];
      const secPriced = secListings.map((l: any) => toUsd(l.priceNumeric, l.currency)).filter((v): v is number => v != null && v > 0);
      secondaryInfo = { count: secListings.length, sample: secPriced.length, usd: statsOf(secPriced), listings: secListings, error: secResult.error || undefined };
    } else {
      secondaryInfo = { count: 0, sample: 0, usd: null, listings: [], error: 'marketplace not configured' };
    }

    const primaryMedian = s.median; // USD
    const ebMedian = secondaryInfo.usd?.median ?? null;
    const delta = primaryMedian != null && ebMedian != null ? ebMedian - primaryMedian : null;
    const gross = delta;
    const net =
      ebMedian != null && primaryMedian != null
        ? ebMedian - ebMedian * EBAY_FEE_RATE - SHIPPING_COST_USD - primaryMedian
        : null;

    selected.push({
      key: s.key,
      count: s.count,
      primary: s,
      secondary: secondaryInfo,
      ebaySearchUrl: secondaryName === 'ebay' ? `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(s.key)}&_sop=13` : null,
      comparison: {
        deltaUsd: dollar(delta),
        grossUsd: dollar(gross),
        netUsd: dollar(net),
        feeRate: EBAY_FEE_RATE,
        shippingUsd: SHIPPING_COST_USD,
      },
    });
  }

  return {
    primaryMarket: marketplace,
    secondaryMarket: secondaryName,
    query: opts.query,
    location: opts.location,
    radius: opts.radius,
    limit,
    totals,
    allModels,
    selected,
  };
}
