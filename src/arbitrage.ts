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
import { ACCESSORY_RE, modelKey, parseModel, sameModel } from './models.js';

// Re-exported: callers imported these from here before the parser moved into
// its own module.
export { modelKey, parseModel, sameModel } from './models.js';

const FX_DOP_PER_USD = 60; // heuristic; adjust to current rate
// The SEARCHED marketplace (primary) is the SELL/target market; the OTHER
// marketplace (secondary) is where we BUY. Profit = sell median − buy median − fees − shipping.
const SELL_FEE_RATE = 0.05; // rough sell-side fee (e.g. Facebook local/shipping) — configurable
const SHIPPING_COST_USD = 15; // cost to get the bought item into the sell market
const SECONDS_IN_DAY = 24 * 60 * 60;

export interface GroupStat {
  key: string;
  count: number;
  /** How confidently the title named a specific product. See ParsedModel. */
  confidence: 'high' | 'medium' | 'low';
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
  /**
   * Buying format for the BUY-side search. Default 'fixed': only items that can
   * actually be bought at a known price. 'auction' hunts bids (margins are then
   * provisional), 'any' leaves the marketplace's own ranking alone.
   */
  buyingFormat?: 'any' | 'fixed' | 'auction';
  /** With buyingFormat 'auction': only bids closing within this many minutes. */
  endingWithinMinutes?: number;
}

export function toUsd(n: number | undefined, currency?: string): number | null {
  if (n == null) return null;
  const c = String(currency || '').toUpperCase();
  return c === 'DOP' ? n / FX_DOP_PER_USD : n;
}

export function dollar(n: number | null | undefined): number | null {
  return n == null ? null : Math.round(n);
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
  const groups = new Map<string, { key: string; count: number; prices: number[]; confidence: GroupStat['confidence'] }>();
  for (const l of listings) {
    // Parts and accessories are not the product. Letting them form or join a
    // group corrupts the sell-side median before any buy-side filter runs.
    const parsed = parseModel(String(l.title || ''));
    if (parsed.isAccessory) continue;
    const key = parsed.key || 'Other';
    const g = groups.get(key) || { key, count: 0, prices: [], confidence: parsed.confidence };
    g.count += 1;
    const u = toUsd(l.priceNumeric, l.currency);
    if (u != null && u > 0) g.prices.push(u);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({
    key: g.key,
    count: g.count,
    confidence: g.confidence,
    ...statsOf(g.prices),
  }));
}

/**
 * Explicitly dead, damaged or carrier-locked units — never a "good" buy
 * candidate. These are exactly why a listing is far below the median, so
 * leaving them in would surface the worst units as the best margins.
 */
const BROKEN_RE =
  /\b(for parts|parts only|not working|no funciona|broken|roto|cracked|crack|damaged|dañad|(heavy|deep|bad|major|lots of)\s+scratch|scratched|rough condition|poor condition|as is|as-is|bad esn|bad imei|icloud lock|activation lock|blacklisted|no power|does not|doesn'?t work|read description|carrier locked|locked to|network locked|(t-?mobile|at&t|verizon|sprint|cricket|boost|metropcs) only)\b/i;

const isPartsLike = (l: any) => BROKEN_RE.test(String(l?.title || '')) || BROKEN_RE.test(String(l?.condition || ''));

/**
 * A bid-only auction is priced at the CURRENT BID, which is not what the item
 * will cost — it only goes up, and the listing cannot be bought today. Costing
 * a margin off it invents profit that expires with the next bid.
 */
const isAuctionOnly = (l: any) =>
  l?.auctionOnly === true ||
  (Array.isArray(l?.buyingOptions) &&
    l.buyingOptions.includes('AUCTION') &&
    !l.buyingOptions.includes('FIXED_PRICE'));

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
  { includeAuctions = false }: { includeAuctions?: boolean } = {},
): { kept: T[]; dropped: number } {
  const withPrice = listings.filter((l) => {
    if (!includeAuctions && isAuctionOnly(l)) return false;
    const p = priceOf(l);
    return p != null && p > 0;
  });

  // Enough of a sample for the median to mean anything? A narrow search — one
  // auction window, say — can return three items, and the median of three
  // phone cases is a phone case.
  const trustworthy = withPrice.length >= 4;
  const rawMedian = trustworthy ? statsOf(withPrice.map((l) => priceOf(l) as number)).median ?? 0 : 0;

  const passA = withPrice.filter((l) => {
    if (isPartsLike(l)) return false;
    const looksAccessory = ACCESSORY_RE.test(String(l.title || ''));
    if (!looksAccessory) return true;
    // With a usable median, let the price vouch for a device that merely
    // mentions an accessory. Without one, the keyword decides alone: dropping a
    // real phone is a smaller error than pricing a margin off a $4 case.
    return trustworthy && (priceOf(l) as number) >= rawMedian * 0.6;
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
  const buyingFormat = opts.buyingFormat || 'fixed';
  const includeAuctions = buyingFormat !== 'fixed';

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

  // Only compare models the titles actually identified. A group like "Laptop
  // Dell Latitude" holds three different machines, and querying the other
  // market with that string returns a decade of unrelated stock — the margin
  // that falls out is fiction wearing a precise number.
  const identified = allModels.filter((s) => s.confidence === 'high');
  const skippedVague = allModels.filter((s) => s.confidence !== 'high' && s.count >= minMatches);
  const eligible = identified.filter((s) => s.count >= minMatches);
  const top = eligible.slice().sort((a, b) => b.count - a.count || (b.avg ?? 0) - (a.avg ?? 0)).slice(0, topN);

  const selected = [];
  for (const s of top) {
    let secondaryInfo: any = { count: 0, sample: 0, usd: null, listings: [], buyable: [], excluded: 0, error: undefined };
    if (secondary) {
      const secResult = await secondary.search({
        query: s.key, limit, buyingFormat, endingWithinMinutes: opts.endingWithinMinutes,
      });
      const secListings = secResult.listings || [];
      // Price the buy side off real units only — accessories and parts would
      // otherwise pull the median down and invent profit that is not there.
      const { kept, dropped } = filterBuyable(
        secListings,
        (l: any) => toUsd(l.priceNumeric, l.currency),
        { includeAuctions },
      );
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
        // An independent sanity check: nothing selling locally for $500 is
        // being bought for $6. This holds even when the buy-side sample is far
        // too small for its own median to be worth anything.
        if (sellMedian != null && buy < sellMedian * 0.35) return null;
        // And it has to be the same phone we are pricing.
        if (!sameModel(modelKey(String(l.title || '')), s.key)) return null;
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
          auction: isAuctionOnly(l) || undefined,
          bidCount: l.bidCount ?? undefined,
          endsAt: l.endsAt ?? undefined,
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
    buyingFormat,
    endingWithinMinutes: opts.endingWithinMinutes,
    query: opts.query,
    location: opts.location,
    radius: opts.radius,
    limit,
    totals,
    allModels,
    /**
     * Groups big enough to compare but too vaguely described to identify.
     * Reported rather than silently dropped: "nothing qualified" and "your
     * search was too generic to compare anything" are different answers.
     */
    skippedVague: skippedVague.map((s) => ({ key: s.key, count: s.count, confidence: s.confidence })),
    selected,
  };
}
