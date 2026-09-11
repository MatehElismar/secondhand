/**
 * Unit 1 — relevance contract and pure classifier (test/relevance.test.ts).
 *
 * RED/GREEN tests for: exact matching, Pixel family scope (phones, Fold,
 * Watch, Tablet), Watch/Tablet inclusion, identity-token typo tolerance at
 * Levenshtein distance <= 2, out-of-bound typos, competing families,
 * ambiguous titles, accessories, and the documented not-applicable result for
 * non-Pixel queries.
 */
import { describe, expect, it } from 'vitest';
import type { QueryRelevance } from '../src/relevance.js';
import {
  classifyQueryRelevance,
  levenshtein,
  normalizeText,
  resolveQueryFamily,
  NOT_APPLICABLE,
} from '../src/relevance.js';

describe('normalizeText', () => {
  it('lowercases and strips punctuation', () => {
    expect(normalizeText('Google Pixel 8 Pro')).toBe('google pixel 8 pro');
    expect(normalizeText('Google, Pixel... 8: Pro!')).toBe('google pixel 8 pro');
    expect(normalizeText('Google–Pixel! 8·Pro')).toBe('google pixel 8 pro');
  });

  it('strips accents (NFD) but keeps the letter', () => {
    expect(normalizeText('PÍXEL 9 PRO XL')).toBe('pixel 9 pro xl');
    expect(normalizeText('Fúnda Píxel')).toBe('funda pixel');
  });

  it('collapses repeated whitespace and trims', () => {
    expect(normalizeText('   Google    Pixel   8   ')).toBe('google pixel 8');
    expect(normalizeText('')).toBe('');
  });

  it('keeps digits and the +/& conjunctions used for accessory disambiguation', () => {
    expect(normalizeText('Pixel 8 Pro + Case & Glass')).toBe('pixel 8 pro + case & glass');
  });
});

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('pixel', 'pixel')).toBe(0);
    expect(levenshtein('', '')).toBe(0);
  });

  it('counts insertion, deletion and substitution as 1', () => {
    expect(levenshtein('gogle', 'google')).toBe(1); // insertion
    expect(levenshtein('googlee', 'google')).toBe(1); // deletion
    expect(levenshtein('xixel', 'pixel')).toBe(1); // substitution
    expect(levenshtein('', 'pixel')).toBe(5);
  });

  it('counts a transposition as 2 (classic Levenshtein, not Damerau)', () => {
    expect(levenshtein('pixle', 'pixel')).toBe(2);
  });

  it('matches the classic kitten/sitting example', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
  });

  it('documents the configured identity-token bound of 2', () => {
    expect(levenshtein('pixl', 'pixel')).toBe(1);
    expect(levenshtein('pixle', 'pixel')).toBe(2);
    expect(levenshtein('pixelllll', 'pixel')).toBeGreaterThan(2); // out of bound
    expect(levenshtein('gooogleee', 'google')).toBe(3); // out of bound (delete an o and two e's)
  });
});

describe('resolveQueryFamily', () => {
  it('resolves Google Pixel and bare Pixel to the complete family', () => {
    const full = resolveQueryFamily('google pixel');
    const bare = resolveQueryFamily('Pixel');
    expect(full?.key).toBe('google-pixel');
    expect(full?.label).toBe('Google Pixel');
    // The family scope covers phones, Fold, Watch and Tablet together.
    expect(full?.productKinds).toEqual(['phone', 'fold', 'watch', 'tablet']);
    expect(bare?.key).toBe(full?.key);
    expect(bare?.productKinds).toEqual(full?.productKinds);
  });

  it('resolves pixel variant queries without requiring a model', () => {
    expect(resolveQueryFamily('pixel 8 pro')?.key).toBe('google-pixel');
    expect(resolveQueryFamily('pixel 9 pro fold')?.key).toBe('google-pixel');
    expect(resolveQueryFamily('pixel watch 3')?.key).toBe('google-pixel');
    expect(resolveQueryFamily('pixel tablet')?.key).toBe('google-pixel');
    expect(resolveQueryFamily('pixel buds')?.key).toBe('google-pixel');
  });

  it('accepts identity-token typos up to distance 2 in the query too', () => {
    expect(resolveQueryFamily('gogle pixel 8')?.key).toBe('google-pixel'); // google typo d=1
    expect(resolveQueryFamily('googel pixle')?.key).toBe('google-pixel'); // both typo'd
    expect(resolveQueryFamily('pixle')?.key).toBe('google-pixel'); // pixel typo d=2
  });

  it('returns null for non-Pixel and anchor-less queries', () => {
    expect(resolveQueryFamily('iphone 15')).toBeNull();
    expect(resolveQueryFamily('samsung galaxy s23')).toBeNull();
    expect(resolveQueryFamily('xiaomi redmi')).toBeNull();
    expect(resolveQueryFamily('oneplus 12')).toBeNull();
    expect(resolveQueryFamily('huawei p30')).toBeNull();
    expect(resolveQueryFamily('macbook pro')).toBeNull();
    expect(resolveQueryFamily('google')).toBeNull(); // generic Google has no Pixel anchor
    expect(resolveQueryFamily('chromecast')).toBeNull();
    expect(resolveQueryFamily('')).toBeNull();
  });
});

describe('classifyQueryRelevance — exact matching and family scope', () => {
  const results: QueryRelevance[] = [];

  it('matches a recognized Pixel phone', () => {
    const r = classifyQueryRelevance('Google Pixel 8 Pro 256GB Unlocked', 'google pixel');
    expect(r).toEqual({ status: 'matched', reason: 'matched', family: 'google-pixel', productKind: 'phone' });
    results.push(r);
  });

  it('includes Fold, Watch and Tablet in the same family', () => {
    expect(classifyQueryRelevance('Google Pixel Fold 256GB', 'google pixel')).toEqual({
      status: 'matched', reason: 'matched', family: 'google-pixel', productKind: 'fold',
    });
    expect(classifyQueryRelevance('Pixel Watch 2 GPS 41mm', 'pixel')).toEqual({
      status: 'matched', reason: 'matched', family: 'google-pixel', productKind: 'watch',
    });
    expect(classifyQueryRelevance('Google Pixel Tablet 128GB', 'google pixel')).toEqual({
      status: 'matched', reason: 'matched', family: 'google-pixel', productKind: 'tablet',
    });
  });

  it('matches a bare family anchor without a model', () => {
    expect(classifyQueryRelevance('Google Pixel', 'pixel')).toMatchObject({
      status: 'matched', reason: 'matched', family: 'google-pixel',
    });
    expect(classifyQueryRelevance('Pixel', 'google pixel')).toMatchObject({ status: 'matched' });
  });

  it('accepts a pre-resolved family object (decouples intent from classification)', () => {
    const fam = resolveQueryFamily('google pixel');
    expect(fam).not.toBeNull();
    expect(classifyQueryRelevance('Pixel 9 Pro', fam!)).toMatchObject({
      status: 'matched', family: 'google-pixel', productKind: 'phone',
    });
  });
});

describe('classifyQueryRelevance — identity-token typos (max distance 2)', () => {
  it('accepts Gogle Pixel (google typo, distance 1)', () => {
    expect(classifyQueryRelevance('Gogle Pixel 8', 'google pixel')).toEqual({
      status: 'matched', reason: 'typo-matched', family: 'google-pixel', productKind: 'phone', distance: 1,
    });
  });

  it('accepts a pixel typo at exactly distance 2', () => {
    expect(classifyQueryRelevance('Google Pixle 8', 'google pixel').reason).toBe('typo-matched');
    expect(classifyQueryRelevance('Google Pixle 8', 'google pixel').distance).toBe(2);
    expect(classifyQueryRelevance('Pixle 8 pro', 'pixel')).toMatchObject({
      status: 'matched', reason: 'typo-matched', distance: 2,
    });
  });

  it('reports the largest identity-token distance when both tokens are typo\'d', () => {
    expect(classifyQueryRelevance('Gogle Pixle 8', 'pixel')).toMatchObject({
      status: 'matched', reason: 'typo-matched', distance: 2,
    });
  });

  it('is distance 0 (exact) when only exact anchors are present', () => {
    const r = classifyQueryRelevance('Pixel 8', 'google pixel');
    expect(r.reason).toBe('matched');
    expect(r).not.toHaveProperty('distance');
  });

  it('rejects typos beyond distance 2: no identity token survives', () => {
    expect(classifyQueryRelevance('Pixelllll 8', 'google pixel')).toEqual({
      status: 'ambiguous', reason: 'ambiguous-title',
    });
    expect(classifyQueryRelevance('Gooooogle Pixelllll 8', 'google pixel')).toEqual({
      status: 'ambiguous', reason: 'ambiguous-title',
    });
  });

  it('never fuzzy-matches whole titles (unrelated words are not typo\'-relevant)', () => {
    expect(classifyQueryRelevance('HP Laptop 15 inch Intel i5', 'google pixel')).toEqual({
      status: 'ambiguous', reason: 'ambiguous-title',
    });
  });
});

describe('classifyQueryRelevance — competing families (mismatch)', () => {
  it('flags the required non-Pixel brands as mismatch', () => {
    expect(classifyQueryRelevance('iPhone 15 Pro 256GB Unlocked', 'pixel')).toEqual({
      status: 'mismatch', reason: 'competing-family',
    });
    expect(classifyQueryRelevance('Samsung Galaxy S23 Ultra', 'google pixel')).toEqual({
      status: 'mismatch', reason: 'competing-family',
    });
    expect(classifyQueryRelevance('Xiaomi Redmi Note 13', 'pixel')).toEqual({
      status: 'mismatch', reason: 'competing-family',
    });
    expect(classifyQueryRelevance('OnePlus 12 16GB', 'pixel')).toEqual({
      status: 'mismatch', reason: 'competing-family',
    });
    expect(classifyQueryRelevance('Huawei P30 Pro', 'pixel')).toEqual({
      status: 'mismatch', reason: 'competing-family',
    });
  });

  it('denies competing family when it appears alongside a Pixel anchor', () => {
    expect(classifyQueryRelevance('Google Pixel 8 vs Samsung Galaxy S24', 'pixel')).toEqual({
      status: 'mismatch', reason: 'competing-family',
    });
  });

  it('catches concatenated competitor tokens after tokenization', () => {
    expect(classifyQueryRelevance('GalaxyS23 Ultra', 'pixel')).toEqual({
      status: 'mismatch', reason: 'competing-family',
    });
  });
});

describe('classifyQueryRelevance — ambiguous titles', () => {
  it('keeps generic Google titles without a Pixel anchor ambiguous', () => {
    expect(classifyQueryRelevance('Google DE128', 'google pixel')).toEqual({
      status: 'ambiguous', reason: 'missing-product-anchor',
    });
    expect(classifyQueryRelevance('Google XL256', 'google pixel')).toEqual({
      status: 'ambiguous', reason: 'missing-product-anchor',
    });
    expect(classifyQueryRelevance('Google PRO128', 'google pixel')).toEqual({
      status: 'ambiguous', reason: 'missing-product-anchor',
    });
    expect(classifyQueryRelevance('Google TV 4K', 'google pixel')).toEqual({
      status: 'ambiguous', reason: 'missing-product-anchor',
    });
  });

  it('keeps anchor-less generic titles ambiguous', () => {
    expect(classifyQueryRelevance('DE128', 'pixel')).toEqual({
      status: 'ambiguous', reason: 'ambiguous-title',
    });
    expect(classifyQueryRelevance('Unlocked Phone 256GB', 'pixel')).toEqual({
      status: 'ambiguous', reason: 'ambiguous-title',
    });
  });

  it('treats out-of-scope Pixel lines (Buds) as ambiguous, never matched', () => {
    expect(classifyQueryRelevance('Pixel Buds Pro 2', 'google pixel')).toEqual({
      status: 'ambiguous', reason: 'ambiguous-title',
    });
  });
});

describe('classifyQueryRelevance — accessories', () => {
  it('flags obvious case/screen/part titles as accessory', () => {
    expect(classifyQueryRelevance('Case For Google Pixel 8', 'google pixel')).toEqual({
      status: 'matched', reason: 'accessory', family: 'google-pixel',
    });
    expect(classifyQueryRelevance('Google Pixel 8 Pro Case', 'pixel')).toEqual({
      status: 'matched', reason: 'accessory', family: 'google-pixel',
    });
    expect(classifyQueryRelevance('OLED Screen Replacement For Google Pixel 7', 'pixel')).toEqual({
      status: 'matched', reason: 'accessory', family: 'google-pixel',
    });
    expect(classifyQueryRelevance('Tempered Glass For Pixel 8', 'pixel')).toEqual({
      status: 'matched', reason: 'accessory', family: 'google-pixel',
    });
    expect(classifyQueryRelevance('Pixel 8 Backhousing', 'pixel')).toEqual({
      status: 'matched', reason: 'accessory', family: 'google-pixel',
    });
    expect(classifyQueryRelevance('Pixel 8 Charger', 'pixel')).toEqual({
      status: 'matched', reason: 'accessory', family: 'google-pixel',
    });
    expect(classifyQueryRelevance('Pixel Stand 2', 'google pixel')).toEqual({
      status: 'matched', reason: 'accessory', family: 'google-pixel',
    });
    expect(classifyQueryRelevance('Pixel Watch Band', 'pixel')).toEqual({
      status: 'matched', reason: 'accessory', family: 'google-pixel',
    });
    expect(classifyQueryRelevance('Screen For Pixel 8', 'pixel')).toEqual({
      status: 'matched', reason: 'accessory', family: 'google-pixel',
    });
    expect(classifyQueryRelevance('Pixel 8 Charger Cable', 'pixel')).toEqual({
      status: 'matched', reason: 'accessory', family: 'google-pixel',
    });
  });

  it('does not flag accessories that come bundled with the device', () => {
    expect(classifyQueryRelevance('Google Pixel 8 Pro w/ Case', 'pixel')).toMatchObject({
      status: 'matched', productKind: 'phone',
    });
    expect(classifyQueryRelevance('Pixel 8 Pro with Case & Screen Protector', 'pixel')).toMatchObject({
      status: 'matched', productKind: 'phone',
    });
    expect(classifyQueryRelevance('Pixel 8 128GB with Box', 'pixel')).toMatchObject({
      status: 'matched', productKind: 'phone',
    });
  });

  it('does not flag condition phrases that mention a screen', () => {
    expect(classifyQueryRelevance('Pixel 6a screen cracked', 'pixel')).toMatchObject({
      status: 'matched', productKind: 'phone',
    });
    expect(classifyQueryRelevance('Google Pixel 8 screen cracked for parts', 'pixel')).toMatchObject({
      status: 'matched', productKind: 'phone',
    });
  });
});

describe('classifyQueryRelevance — non-Pixel queries return the documented not-applicable result', () => {
  it('returns the shared NOT_APPLICABLE result for any non-Pixel query', () => {
    expect(classifyQueryRelevance('Google Pixel 8 Pro', 'iphone 15')).toBe(NOT_APPLICABLE);
    expect(classifyQueryRelevance('Google Pixel 8 Pro', 'samsung galaxy s23')).toBe(NOT_APPLICABLE);
    expect(classifyQueryRelevance('Google Pixel 8 Pro', 'xbox')).toBe(NOT_APPLICABLE);
    expect(classifyQueryRelevance('Google Pixel 8 Pro', '')).toBe(NOT_APPLICABLE);
  });

  it('documents the not-applicable shape (ambiguous, missing-product-anchor)', () => {
    expect(NOT_APPLICABLE.status).toBe('ambiguous');
    expect(NOT_APPLICABLE.reason).toBe('missing-product-anchor');
    expect(classifyQueryRelevance('anything', 'macbook')).toEqual(NOT_APPLICABLE);
  });
});

describe('triangulate', () => {
  it('classifies representative titles from the reported Google Pixel result', () => {
    // Matched phones.
    expect(classifyQueryRelevance('Google Pixel 8 Pro 256GB Unlocked - Excellent', 'google pixel').status).toBe('matched');
    expect(classifyQueryRelevance('Pixel 7a 128GB Charcoal', 'pixel')).toMatchObject({ status: 'matched', productKind: 'phone' });
    expect(classifyQueryRelevance('Pixel XL 32GB Verizon', 'pixel')).toMatchObject({ status: 'matched', productKind: 'phone' });
    expect(classifyQueryRelevance('Google Pixel 8 - Brand New Sealed', 'google pixel')).toMatchObject({ status: 'matched' });
    expect(classifyQueryRelevance('Pixel 8 128GB', 'pixel')).toMatchObject({ status: 'matched', productKind: 'phone' });

    // Whole family scope: phone, Fold, Watch, Tablet coexist under one query.
    expect(classifyQueryRelevance('Pixel 9 Pro Fold 256GB', 'google pixel')).toMatchObject({ status: 'matched', productKind: 'fold' });
    expect(classifyQueryRelevance('Pixel Watch GPS Only', 'google pixel')).toMatchObject({ status: 'matched', productKind: 'watch' });
    expect(classifyQueryRelevance('Pixel Tablet 128GB WiFi', 'google pixel')).toMatchObject({ status: 'matched', productKind: 'tablet' });

    // Real-world phrasing that must not fall out of the family.
    expect(classifyQueryRelevance('Google Pixel 6a - screen has a crack', 'google pixel').status).toBe('matched');
    expect(classifyQueryRelevance('Gogle Pixel 8 128GB Factory Unlocked', 'google pixel').reason).toBe('typo-matched');

    // Accessories.
    expect(classifyQueryRelevance('Case for Google Pixel 8 - OtterBox', 'google pixel').reason).toBe('accessory');
    expect(classifyQueryRelevance('Pixel 8 Screen Protector 2-pack', 'pixel').reason).toBe('accessory');

    // Competing families stay out of statistics.
    expect(classifyQueryRelevance('iPhone 13 128GB Great Condition', 'pixel')).toMatchObject({ status: 'mismatch' });
    expect(classifyQueryRelevance('Galaxy S22 Ultra 512GB', 'google pixel')).toMatchObject({ status: 'mismatch' });

    // No anchor, no claim.
    expect(classifyQueryRelevance('Google DE128', 'google pixel').status).toBe('ambiguous');
  });
});
describe('plus/ampersand-joined titles split into tokens', () => {
  it('normalizes + and & into standalone separator tokens, keeping the marker', () => {
    // Facebook returns URL-joined titles: "Google+Pixel+6+Leer+descripción."
    expect(normalizeText('Google+Pixel+6')).toBe('google + pixel + 6');
    expect(normalizeText('Google+pixel+4XL')).toBe('google + pixel + 4xl');
    expect(normalizeText('Pixel 8 Pro + Case & Glass')).toBe('pixel 8 pro + case & glass');
  });

  it('matches plus-joined Pixel titles that arrive with + instead of spaces', () => {
    expect(classifyQueryRelevance('Google+Pixel+6+Leer+descripción.', 'google pixel')).toEqual({
      status: 'matched', reason: 'matched', family: 'google-pixel', productKind: 'phone',
    });
    expect(classifyQueryRelevance('Google+pixel+4XL', 'google pixel')).toEqual({
      status: 'matched', reason: 'matched', family: 'google-pixel', productKind: 'phone',
    });
    expect(classifyQueryRelevance('Pixel+8+Pro+256GB', 'pixel')).toMatchObject({
      status: 'matched', reason: 'matched', productKind: 'phone',
    });
  });

  it('still treats + and & before a part word as an included extra', () => {
    // "Pixel 8 Pro + Case" is the phone with a case, not a case listing.
    expect(classifyQueryRelevance('Pixel 8 Pro + Case', 'pixel')).toMatchObject({
      status: 'matched', reason: 'matched', productKind: 'phone',
    });
    expect(classifyQueryRelevance('Pixel 8 Pro & Screen Protector', 'pixel')).toMatchObject({
      status: 'matched', reason: 'matched', productKind: 'phone',
    });
    // The joined form reads the same way: Pro+Case = Pro with a case.
    expect(classifyQueryRelevance('Pixel 8 Pro+Case', 'pixel')).toMatchObject({
      status: 'matched', reason: 'matched', productKind: 'phone',
    });
  });

  it('still flags a subject accessory written with + or & separators', () => {
    expect(classifyQueryRelevance('Pixel 8 Case & Screen Protector', 'pixel')).toEqual({
      status: 'matched', reason: 'accessory', family: 'google-pixel',
    });
    expect(classifyQueryRelevance('Pixel 8 Backhousing + Glass', 'pixel')).toEqual({
      status: 'matched', reason: 'accessory', family: 'google-pixel',
    });
  });
});

describe('pixel typo matcher is conservative (B1)', () => {
  it('still accepts genuine distance-2 transpositions', () => {
    // Exact anchor present -> plain matched; the typo'd twin is still accepted.
    expect(classifyQueryRelevance('Pixle Pixel 8 Pro', 'pixel').status).toBe('matched');
    expect(classifyQueryRelevance('Pixle 8 pro', 'pixel')).toMatchObject({
      status: 'matched', reason: 'typo-matched', distance: 2,
    });
    expect(classifyQueryRelevance('Google Pixle 8', 'google pixel').status).toBe('matched');
  });

  it('rejects dictionary words that sit at distance 2 (Pixma/Pixar)', () => {
    expect(classifyQueryRelevance('Canon Pixma Printer', 'google pixel').status).toBe('ambiguous');
    expect(classifyQueryRelevance('Pixar Movie Collection', 'pixel').status).toBe('ambiguous');
    expect(classifyQueryRelevance('Google Pixma', 'pixel')).toEqual({ status: 'ambiguous', reason: 'missing-product-anchor' });
    expect(resolveQueryFamily('pixma')).toBeNull();
  });

  it('keeps exact and distance-1 matches universal', () => {
    expect(classifyQueryRelevance('Pixl 8', 'pixel')).toMatchObject({ status: 'matched', reason: 'typo-matched', distance: 1 });
    expect(classifyQueryRelevance('Gogle Pixel 8', 'google pixel').status).toBe('matched');
  });
});

describe('representative accessory forms and bundled extras (W2)', () => {
  it('flags case / cover / funda / pantalla / charger as accessory', () => {
    for (const t of ['Pixel 8 Case', 'Pixel 8 Cover', 'Funda Para Pixel 8', 'Pantalla Para Pixel 8', 'Pixel 8 Pro Charger']) {
      const r = classifyQueryRelevance(t, 'pixel');
      expect(r.status, t).toBe('matched');
      expect(r.reason, t).toBe('accessory');
    }
  });

  it('keeps real devices with bundled extras statistical', () => {
    for (const t of ['Pixel 8 Pro con Funda', 'Google Pixel 8 Pro w/ Charger', 'Pixel 8 128GB + Cargador']) {
      expect(classifyQueryRelevance(t, 'pixel'), t).toMatchObject({ status: 'matched', reason: 'matched', productKind: 'phone' });
    }
  });
});

describe('competitor mentions never become matched statistics (W3)', () => {
  it('chooses mismatch for a Pixel title that mentions a competitor as extra or comparison', () => {
    for (const t of [
      'Google Pixel 8 Pro w/ iPhone Charger',
      'Google Pixel 8 Compatible Samsung Cable',
      'Google Pixel 8 vs iPhone 15',
    ]) {
      expect(classifyQueryRelevance(t, 'pixel'), t).toEqual({ status: 'mismatch', reason: 'competing-family' });
    }
  });
});
