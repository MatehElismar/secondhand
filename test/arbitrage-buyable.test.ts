import { describe, expect, it } from 'vitest';
import { bucketize, filterBuyable, modelKey, sameModel } from '../src/arbitrage.js';

const price = (l: { priceNumeric: number }) => l.priceNumeric;

const phone = (priceNumeric: number, title = 'Apple iPhone 15 Pro 256GB Unlocked') => ({
  title,
  priceNumeric,
});

describe('filterBuyable', () => {
  it('drops cheap accessories and parts that match the model keyword', () => {
    const listings = [
      phone(520),
      phone(540),
      phone(560),
      phone(580),
      phone(600),
      { title: 'Silicone Phone Case For iPhone 15 Pro Max', priceNumeric: 19.99 },
      { title: 'ZAGG Glass Screen Protector for iPhone 15 Pro', priceNumeric: 10.57 },
      { title: 'iPhone 15 Pro OLED Display Replacement Screen', priceNumeric: 39.99 },
    ];
    const { kept, dropped } = filterBuyable(listings, price);
    expect(dropped).toBe(3);
    expect(kept.every((l) => l.priceNumeric > 100)).toBe(true);
  });

  it('keeps a real device whose title merely mentions an accessory', () => {
    const listings = [
      phone(520),
      phone(540),
      phone(560),
      phone(580),
      phone(545, 'Apple iPhone 15 Pro 256GB Unlocked - includes case and charger'),
    ];
    const { kept } = filterBuyable(listings, price);
    expect(kept).toHaveLength(5);
  });

  it('drops broken / for-parts units regardless of price', () => {
    const listings = [
      phone(520),
      phone(540),
      phone(560),
      phone(580),
      { title: 'Apple iPhone 15 Pro 256GB - FOR PARTS ONLY, iCloud lock', priceNumeric: 505 },
    ];
    const { kept } = filterBuyable(listings, price);
    expect(kept.map((l) => l.title)).not.toContain(
      'Apple iPhone 15 Pro 256GB - FOR PARTS ONLY, iCloud lock',
    );
  });

  it('drops carrier-locked and beat-up units that would fake a big margin', () => {
    const traps = [
      'Apple iPhone 15 - 128GB (T-Mobile ONLY) WORKS BUT VERY ROUGH CONDITION',
      'Apple iPhone 15 Pro 256GB - carrier locked, cracked back',
      'iPhone 15 Pro - iCloud lock, read description',
    ];
    for (const title of traps) {
      const { kept } = filterBuyable([phone(520), phone(540), phone(560), phone(580), { title, priceNumeric: 230 }], price);
      expect(kept.map((l) => l.title)).not.toContain(title);
    }
  });

  it('keeps an unlocked unit that merely names a carrier', () => {
    const title = 'T-Mobile Apple iPhone 15 Pro Max 256GB Black Titanium Unlocked';
    const { kept } = filterBuyable([phone(520), phone(540), phone(560), phone(580), { title, priceNumeric: 430 }], price);
    expect(kept.map((l) => l.title)).toContain(title);
  });

  it('distinguishes damage wording from a clean-condition claim', () => {
    const base = [phone(520), phone(540), phone(560), phone(580)];
    const bad = 'Apple iPhone 15 Pro 256GB Unlocked - HEAVY SCRATCH on back';
    expect(filterBuyable([...base, { title: bad, priceNumeric: 350 }], price).kept.map((l) => l.title)).not.toContain(bad);
    const good = 'Apple iPhone 15 Pro 256GB Unlocked - no scratches, mint';
    expect(filterBuyable([...base, { title: good, priceNumeric: 530 }], price).kept.map((l) => l.title)).toContain(good);
  });

  it('drops a unit with missing parts without flagging one that has none', () => {
    const base = [phone(520), phone(540), phone(560), phone(580)];
    const broken = 'PlayStation 5 Slim Digital Console White 1TB - Missing Side Panels';
    expect(filterBuyable([...base, { title: broken, priceNumeric: 400 }], price).kept.map((l) => l.title))
      .not.toContain(broken);
    // "nothing missing" is a seller advertising completeness, not a defect.
    const good = 'Apple iPhone 15 Pro 256GB Unlocked, nothing missing, complete box';
    expect(filterBuyable([...base, { title: good, priceNumeric: 545 }], price).kept.map((l) => l.title))
      .toContain(good);
  });

  it('rejects a bargain whose own title admits the condition', () => {
    const base = [phone(520), phone(540), phone(560), phone(580)];
    for (const title of [
      'Bad Condition Sony WH-1000XM4 Black Wireless Headphones',
      'Sony WH-1000XM4 - poor condition, para reparar',
    ]) {
      expect(filterBuyable([...base, { title, priceNumeric: 200 }], price).kept.map((l) => l.title))
        .not.toContain(title);
    }
  });

  it('drops multi-unit lots far above the median', () => {
    const listings = [phone(500), phone(520), phone(540), phone(560), phone(4200, 'Lot of 8 iPhone 15 Pro')];
    const { kept } = filterBuyable(listings, price);
    expect(kept.some((l) => l.priceNumeric === 4200)).toBe(false);
  });

  it('excludes bid-only auctions by default and admits them on request', () => {
    const auction = {
      title: 'Apple iPhone 15 Pro 256GB Unlocked',
      priceNumeric: 300,
      buyingOptions: ['AUCTION'],
    };
    const base = [phone(520), phone(540), phone(560), phone(580)];
    expect(filterBuyable([...base, auction], price).kept).toHaveLength(4);
    expect(filterBuyable([...base, auction], price, { includeAuctions: true }).kept).toHaveLength(5);
  });

  it('keeps an auction that also has Buy It Now', () => {
    const bin = {
      title: 'Apple iPhone 15 Pro 256GB Unlocked',
      priceNumeric: 545,
      buyingOptions: ['AUCTION', 'FIXED_PRICE'],
    };
    const kept = filterBuyable([phone(520), phone(540), phone(560), phone(580), bin], price).kept;
    expect(kept).toHaveLength(5);
  });

  it('drops box-only and multi-unit lot listings', () => {
    const base = [phone(520), phone(540), phone(560), phone(580)];
    for (const title of ['Apple iPhone Retail Box Packaging Purple 128GB', 'Lot of 4 Smartphones Apple iPhone']) {
      expect(filterBuyable([...base, { title, priceNumeric: 60 }], price).kept.map((l) => l.title)).not.toContain(title);
    }
  });

  it('still drops accessories when the sample is too small for a median', () => {
    // A narrow search (one auction window) can return two or three items. The
    // median of those is meaningless, so the keyword has to decide alone —
    // otherwise a $12 case becomes a candidate with a huge fake margin.
    const listings = [phone(500), { title: 'Case for iPhone 15', priceNumeric: 12 }];
    const { kept } = filterBuyable(listings, price);
    expect(kept.map((l) => l.title)).toEqual(['Apple iPhone 15 Pro 256GB Unlocked']);
  });

  it('skips listings with no usable price', () => {
    const listings = [
      phone(500),
      phone(520),
      phone(540),
      phone(560),
      { title: 'Apple iPhone 15 Pro', priceNumeric: 0 },
    ];
    const { kept, dropped } = filterBuyable(listings, price);
    expect(kept).toHaveLength(4);
    expect(dropped).toBe(1);
  });
});

describe('bucketize', () => {
  it('scales on p95 so one outlier does not collapse the histogram', () => {
    const prices = [...Array(39).fill(0).map((_, i) => 300 + i * 5), 25000];
    const buckets = bucketize(prices);
    const populated = buckets.filter((b) => b.count > 0);
    expect(populated.length).toBeGreaterThan(1);
    // The outlier lands in a trailing open-ended bucket, not the main scale.
    expect(buckets[buckets.length - 1].count).toBe(1);
    expect(buckets[buckets.length - 1].to).toBe(25000);
  });

  it('returns an empty array for no prices', () => {
    expect(bucketize([])).toEqual([]);
  });
});

describe('sameModel', () => {
  it('matches the same generation regardless of stated storage', () => {
    expect(sameModel('iPhone 15 Pro 256GB', 'iPhone 15 Pro')).toBe(true);
    expect(sameModel('iPhone 15 Pro', 'iPhone 15 Pro 512GB')).toBe(true);
  });

  it('refuses a different generation or family', () => {
    expect(sameModel('iPhone 13 128GB', 'iPhone 15 Pro')).toBe(false);
    expect(sameModel('iPhone 15 Plus 128GB', 'iPhone 15 Pro')).toBe(false);
    expect(sameModel('iPhone 15', 'iPhone 15 Pro')).toBe(false);
  });

  it('rejects the eBay cross-generation results seen in practice', () => {
    const key = 'iPhone 15 Pro';
    const strays = [
      'Genuine Apple iPhone 13 128GB Black Unlocked',
      'Apple iPhone 14 128GB Smartphone A2649',
      'APPLE iPhone 15 Plus Smartphone 6.7in Unlocked 128GB',
    ];
    for (const t of strays) expect(sameModel(modelKey(t), key)).toBe(false);
    expect(sameModel(modelKey('Apple iPhone 15 Pro 256GB Unlocked Very Good'), key)).toBe(true);
  });
});
