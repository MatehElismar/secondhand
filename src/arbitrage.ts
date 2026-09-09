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
// The SEARCHED marketplace (primary) is the SELL/target market; the OTHER
// marketplace (secondary) is where we BUY. Profit = sell median − buy median − fees − shipping.
const SELL_FEE_RATE = 0.05; // rough sell-side fee (e.g. Facebook local/shipping) — configurable
const SHIPPING_COST_USD = 15; // cost to get the bought item into the sell market
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

/**
 * Titles that describe something other than the device itself. A keyword-only
 * rule is too blunt on its own ("iPhone 15 Pro 256GB, includes case" is a real
 * phone), so callers pair it with a price test — see filterBuyable.
 */
const ACCESSORY_RE =
  /\b(case|cover|funda|carcasa|skin|sticker|bumper|wallet|holster|screen protector|protector de pantalla|tempered glass|mica|charger|cargador|cable|adapter|adaptador|earpods|airpods|headphone|headset|auricular|lcd|oled|digitizer|back glass|housing|frame|flex|connector|motherboard|logic board|camera replacement|replacement (kit|part|screen|battery|display)|repair (kit|part)|repuesto|holder|mount|stand|tripod|lens protector|grip|strap|empty box|box only|caja vac)/i;

/**
 * Explicitly dead, damaged or carrier-locked units — never a "good" buy
 * candidate. These are exactly why a listing is far below the median, so
 * leaving them in would surface the worst units as the best margins.
 */
const BROKEN_RE =
  /\b(for parts|parts only|not working|no funciona|broken|roto|cracked|crack|damaged|dañad|(heavy|deep|bad|major|lots of)\s+scratch|scratched|rough condition|poor condition|as is|as-is|bad esn|bad imei|icloud lock|activation lock|blacklisted|no power|does not|doesn'?t work|read description|carrier locked|locked to|network locked|(t-?mobile|at&t|verizon|sprint|cricket|boost|metropcs) only)\b/i;

const isPartsLike = (l: any) => BROKEN_RE.test(String(l?.title || '')) || BROKEN_RE.test(String(l?.condition || ''));

/**
 * Drop listings that are not the product itself. eBay keyword search for
 * "iPhone 15 Pro" returns $14 cases and $25 screen assemblies; left in, they
 * drag the buy-side median down and would surface as fake "profitable" buys.
 *
 * Two passes: an accessory keyword that is ALSO cheap relative to the raw
 * median, then a price sanity band around the surviving median (catches parts
 * whose wording we did not anticipate, and multi-unit lots at the top end).
 */
export function filterBuyable<T extends { title?: string; priceNumeric?: number; condition?: string }>(
  listings: T[],
  priceOf: (l: T) => number | null,
): { kept: T[]; dropped: number } {
  const withPrice = listings.filter((l) => {
    const p = priceOf(l);
    return p != null && p > 0;
  });
  if (withPrice.length < 4) return { kept: withPrice, dropped: listings.length - withPrice.length };

  const rawMedian = statsOf(withPrice.map((l) => priceOf(l) as number)).median ?? 0;

  const passA = withPrice.filter((l) => {
    if (isPartsLike(l)) return false;
    const p = priceOf(l) as number;
    const looksAccessory = ACCESSORY_RE.test(String(l.title || ''));
    // Only trust the keyword when the price agrees it is not the device.
    return !(looksAccessory && p < rawMedian * 0.6);
  });
  if (passA.length < 4) return { kept: passA, dropped: listings.length - passA.length };

  const cleanMedian = statsOf(passA.map((l) => priceOf(l) as number)).median ?? 0;
  const kept = passA.filter((l) => {
    const p = priceOf(l) as number;
    return p >= cleanMedian * 0.4 && p <= cleanMedian * 2.5;
  });
  return { kept, dropped: listings.length - kept.length };
}

export function bucketize(prices: number[], buckets = 6): Array<{ from: number; to: number; count: number }> {
  if (!prices.length) return [];
  // Scale on p95 rather than max: a single absurd asking price ($25k for a used
  // phone) would otherwise collapse every real listing into the first bucket.
  // Anything above the last edge is folded into a final open-ended bucket.
  const sorted = [...prices].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  const top = Math.max(p95, sorted[0] + 1);
  const width = Math.max(1, Math.round(top / buckets));
  const out = Array.from({ length: buckets }, (_, i) => ({
    from: i * width,
    to: (i + 1) * width,
    count: 0,
  }));
  let overflow = 0;
  for (const p of prices) {
    const idx = Math.floor(p / width);
    if (idx >= buckets) overflow += 1;
    else out[idx].count += 1;
  }
  if (overflow) out.push({ from: buckets * width, to: Math.ceil(sorted[sorted.length - 1]), count: overflow });
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
    let secondaryInfo: any = { count: 0, sample: 0, usd: null, listings: [], buyable: [], excluded: 0, error: undefined };
    if (secondary) {
      const secResult = await secondary.search({ query: s.key, limit });
      const secListings = secResult.listings || [];
      // Price the buy side off real units only — accessories and parts would
      // otherwise pull the median down and invent profit that is not there.
      const { kept, dropped } = filterBuyable(secListings, (l: any) => toUsd(l.priceNumeric, l.currency));
      const secPriced = kept.map((l: any) => toUsd(l.priceNumeric, l.currency)).filter((v): v is number => v != null && v > 0);
      secondaryInfo = {
        count: secListings.length,
        sample: secPriced.length,
        usd: statsOf(secPriced),
        listings: secListings,
        buyable: kept,
        excluded: dropped,
        error: secResult.error || undefined,
      };
    } else {
      secondaryInfo = { count: 0, sample: 0, usd: null, listings: [], buyable: [], excluded: 0, error: 'marketplace not configured' };
    }

    // primary = SELL (target) market, secondary = BUY market.
    const sellMedian = s.median; // USD
    const buyMedian = secondaryInfo.usd?.median ?? null;
    const delta = sellMedian != null && buyMedian != null ? sellMedian - buyMedian : null;
    const net =
      sellMedian != null && buyMedian != null
        ? sellMedian - buyMedian - sellMedian * SELL_FEE_RATE - SHIPPING_COST_USD
        : null;

    // Concrete units to actually buy, each priced against the sell-side median
    // so the listing carries its own margin rather than the group average.
    const candidates = (secondaryInfo.buyable as any[])
      .map((l) => {
        const buy = toUsd(l.priceNumeric, l.currency);
        if (buy == null) return null;
        const unitNet =
          sellMedian != null ? sellMedian - buy - sellMedian * SELL_FEE_RATE - SHIPPING_COST_USD : null;
        return {
          id: l.id,
          title: l.title,
          priceUsd: dollar(buy),
          condition: l.condition ?? null,
          seller: l.seller ?? null,
          url: l.url,
          image: (l.images || [])[0] ?? null,
          netUsd: dollar(unitNet),
        };
      })
      .filter((c): c is NonNullable<typeof c> => c != null)
      .sort((a, b) => (b.netUsd ?? -Infinity) - (a.netUsd ?? -Infinity))
      .slice(0, 6);

    selected.push({
      key: s.key,
      count: s.count,
      primary: s,
      secondary: secondaryInfo,
      candidates,
      otherMarketUrl: secondaryName === 'ebay' ? `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(s.key)}&_sop=13` : null,
      comparison: {
        deltaUsd: dollar(delta),
        netUsd: dollar(net),
        feeRate: SELL_FEE_RATE,
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
