import { describe, expect, it } from 'vitest';
import { clusterKeys, normalizeTokens, similarity } from '../src/fuzzy.js';

describe('normalizeTokens', () => {
  it('lowercases, strips punctuation and drops capacity', () => {
    expect(normalizeTokens('iPhone 15 Pro Max 256GB')).toEqual(['15', 'iphone', 'max', 'pro']);
    expect(normalizeTokens('IPHONE-15-PRO')).toEqual(['15', 'iphone', 'pro']);
  });

  it('drops filler and descriptor words in both languages', () => {
    expect(normalizeTokens('New Lenovo Thinkpad Black')).toEqual(['lenovo', 'thinkpad']);
    expect(normalizeTokens('Laptop Nuevo Para Venta')).toEqual(['laptop']);
    expect(normalizeTokens('Laptop Gamer Negro')).toEqual(['gamer', 'laptop']);
    expect(normalizeTokens('Silla Gamer Roja Reacondicionada')).toEqual(['gamer', 'silla']);
  });

  it('returns no tokens for empty or all-noise keys', () => {
    expect(normalizeTokens('')).toEqual([]);
    expect(normalizeTokens('The New')).toEqual([]);
  });
});

describe('similarity', () => {
  it('scores word-reordered twins as identical', () => {
    expect(similarity('iPhone 15 Pro Max 256GB', 'Pro Max iPhone 15')).toBe(1);
  });

  it('keeps a single meaningful token difference far below the threshold', () => {
    expect(similarity('Marlin 5', 'Marlin 6')).toBe(0.5);
    expect(similarity('a b c d e', 'a b c d f')).toBe(0.8);
  });

  it('handles empty and disjoint token sets', () => {
    expect(similarity('', '')).toBe(1);
    expect(similarity('chair', '')).toBe(0);
    expect(similarity('', 'chair')).toBe(0);
    expect(similarity('apple', 'samsung')).toBe(0);
  });

  it('counts repeated tokens as a multiset, not a set', () => {
    expect(similarity('a a b', 'a a a b')).toBe(6 / 7);
  });

  it('sits exactly on the 0.85 boundary for a 17-of-20 overlap', () => {
    const k1 = Array.from({ length: 20 }, (_, i) => 't' + String(i + 1).padStart(2, '0')).join(' ');
    const k2 = [...Array.from({ length: 17 }, (_, i) => 't' + String(i + 1).padStart(2, '0')), 'u1', 'u2', 'u3'].join(' ');
    expect(similarity(k1, k2)).toBe(0.85);
  });
});

describe('clusterKeys', () => {
  it('merges keys identical after normalization (word reorder)', () => {
    const map = clusterKeys(['tablet pro max', 'pro max tablet']);
    // Same tokens, same length and frequency: the lexicographic one wins.
    expect(map.get('tablet pro max')).toBe('pro max tablet');
    expect(map.get('pro max tablet')).toBe('pro max tablet');
  });

  it('merges keys that differ only by filler or descriptor noise', () => {
    const map = clusterKeys(['Lenovo Thinkpad Black New', 'Lenovo Thinkpad']);
    expect(map.get('Lenovo Thinkpad')).toBe(map.get('Lenovo Thinkpad Black New'));
  });

  it('merges keys that differ only by a Spanish colour', () => {
    const map = clusterKeys(['Laptop Gamer Negro', 'Laptop Gamer Rojo']);
    expect(map.get('Laptop Gamer Negro')).toBe(map.get('Laptop Gamer Rojo'));
  });

  it('folds chains together even when the ends are not directly similar', () => {
    const [a, b, c] = ['aa bb cc dd', 'aa bb cc dd ee', 'aa bb cc dd ee ff'];
    // a~b and b~c are >= 0.85, a~c is 0.8 — yet all three belong to one cluster.
    const map = clusterKeys([a, b, c]);
    expect(map.get(a)).toBe(map.get(b));
    expect(map.get(b)).toBe(map.get(c));
  });

  it('respects the threshold boundary inclusive', () => {
    const k1 = Array.from({ length: 20 }, (_, i) => 't' + String(i + 1).padStart(2, '0')).join(' ');
    const k2 = [...Array.from({ length: 17 }, (_, i) => 't' + String(i + 1).padStart(2, '0')), 'u1', 'u2', 'u3'].join(' ');
    expect(clusterKeys([k1, k2]).get(k1)).toBe(clusterKeys([k1, k2]).get(k2));
    expect(clusterKeys([k1, k2], 0.86).get(k1)).toBe(k1);
    expect(clusterKeys([k1, k2], 0.86).get(k2)).toBe(k2);
  });

  it('keeps single-token differences apart', () => {
    const map = clusterKeys(['Marlin 5', 'Marlin 6']);
    expect(map.get('Marlin 5')).toBe('Marlin 5');
    expect(map.get('Marlin 6')).toBe('Marlin 6');
  });

  it('picks the most frequent key as canonical', () => {
    const map = clusterKeys(['alpha beta gamma', 'alpha beta gamma', 'gamma beta alpha', 'delta epsilon zeta']);
    expect(map.get('gamma beta alpha')).toBe('alpha beta gamma');
    expect(map.get('delta epsilon zeta')).toBe('delta epsilon zeta');
  });

  it('breaks canonical frequency ties by longer key, then lexicographic', () => {
    // 3-of-4 token overlap scores 6/7 >= 0.85, so these merge.
    // One longer member vs two of a short phrasing: frequency wins over length.
    const freqMap = clusterKeys(['alpha beta gamma', 'alpha beta gamma', 'alpha beta gamma delta']);
    expect(freqMap.get('alpha beta gamma delta')).toBe('alpha beta gamma');
    // Equal frequency: longer wins.
    const lenMap = clusterKeys(['alpha beta gamma', 'alpha beta gamma delta']);
    expect(lenMap.get('alpha beta gamma')).toBe('alpha beta gamma delta');
    // Equal frequency and length: lexicographic wins.
    const lexMap = clusterKeys(['gamma beta', 'beta gamma']);
    expect(lexMap.get('gamma beta')).toBe('beta gamma');
  });

  it('handles empty and singleton inputs', () => {
    expect(clusterKeys([]).size).toBe(0);
    expect(clusterKeys(['solo key']).get('solo key')).toBe('solo key');
  });
});
