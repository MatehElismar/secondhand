/**
 * Fuzzy grouping for low-confidence model keys.
 *
 * The per-model summary groups listings by their canonical key, but the keys'
 * reliability is not uniform: a 'high' key is a structural identity and a 'low'
 * key is literally the first three words of a title that named no model
 * ("Laptop Lenovo", "Wooden Vintage Chair"). Sellers phrase those titles every
 * possible way, so one vague product fragments into several one-listing groups:
 * "Laptop Lenovo" next to "Lenovo Laptop", "Laptop Gamer Negro" next to "Laptop
 * Gamer". For low-confidence keys that is noise, not identity — this module
 * merges them by token-similarity, and only them.
 *
 * All functions here are pure and dependency-free on purpose: the same
 * clustering must run server-side (arbitrage) and per-listing (the web UI's
 * /v1/search path) without a browser, network or shared state.
 */

import { FILLER_WORDS_RE } from './models.js';

/**
 * Colour and condition words a seller attaches to a vague title. They describe
 * the unit on offer, not which product it is, so two listings of the same thing
 * differing only here are the same group. Kept deliberately short — an aggressive
 * list starts eating model words ("Pro", "Max", "Plus").
 *
 * The market is bilingual (see the titles in models.ts), so both languages are
 * listed: a listing saying "Laptop Gamer Negro" and one saying "Laptop Gamer
 * Rojo" are one vague bucket, not two.
 */
const DESCRIPTOR_WORDS = new Set([
  // Colour — English
  'black', 'white', 'silver', 'gray', 'grey', 'graphite', 'gold', 'rose',
  'blue', 'red', 'green', 'pink', 'purple', 'titanium', 'midnight',
  'starlight', 'space', 'mint',
  // Colour — Spanish
  'negro', 'negra', 'blanco', 'blanca', 'azul', 'rojo', 'roja', 'verde',
  'gris', 'dorado', 'dorada', 'plateado', 'plateada', 'plata', 'rosa',
  'rosado', 'morado', 'morada', 'violeta',
  // Condition / provenance
  'good', 'fair', 'great', 'excellent', 'perfect', 'clean', 'working',
  'refurbished', 'renewed', 'worn', 'boxed',
  'bueno', 'buena', 'excelente', 'perfecto', 'perfecta', 'impecable',
  'reacondicionado', 'reacondicionada', 'renovado', 'renovada',
  'seminuevo', 'seminueva',
]);

/**
 * A key reduced to the words that carry identity. Lowercased, punctuation-free,
 * capacity dropped ("256GB" adds nothing to a product name), filler and
 * descriptor words removed. Order is irrelevant to the caller — the similarity
 * coefficient compares these as multisets — so tokens are sorted to make
 * comparisons (and tests) deterministic.
 */
export function normalizeTokens(key: string): string[] {
  return String(key || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\b\d+(?:\.\d+)?\s*(?:gb|tb)\b/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !FILLER_WORDS_RE.test(w) && !DESCRIPTOR_WORDS.has(w))
    .sort();
}

/**
 * Sørensen–Dice coefficient over the token multisets of both keys:
 * 2*|A∩B| / (|A|+|B|). Deliberately NOT character-level Levenshtein: a single
 * token difference that matters (M2 vs M3, "Marlin 5" vs "Marlin 6") is a whole
 * character-level mess but only one token apart, and Dice keeps it cleanly below
 * the merge threshold while a word-reordered twin scores 1.0.
 */
export function similarity(a: string, b: string): number {
  const A = normalizeTokens(a);
  const B = normalizeTokens(b);
  // Two empty keys are the same (empty) key; an empty key and a real one are not.
  if (!A.length && !B.length) return 1;
  if (!A.length || !B.length) return 0;
  const counts = new Map<string, number>();
  for (const t of A) counts.set(t, (counts.get(t) ?? 0) + 1);
  let shared = 0;
  for (const t of B) {
    const n = counts.get(t);
    if (n) {
      shared += 1;
      counts.set(t, n - 1);
    }
  }
  return (2 * shared) / (A.length + B.length);
}

/**
 * Cluster similar keys (Sørensen–Dice >= threshold) and pick a canonical key per
 * cluster: the most frequent, ties broken by longer key, then lexicographic.
 * Returns one entry per distinct input key, mapping it to its cluster's
 * canonical key (a key merges to itself when it is its own cluster).
 *
 * Repeated entries count as votes: the caller passes the key once per listing,
 * so the canonical key is the one describing the most listings. Pairs are
 * compared only between *distinct* keys while votes come from all entries, so
 * a 500-listing search stays well under O(n²) on distinct keys.
 */
export function clusterKeys(keys: string[], threshold = 0.85): Map<string, string> {
  const freq = new Map<string, number>();
  for (const k of keys) freq.set(k, (freq.get(k) ?? 0) + 1);
  const unique = [...freq.keys()];

  // Union-find: similarity is not transitive ("abc"~"abcd"~"abcde" chains) but
  // the merge must be, or a three-way overlap splits into two groups.
  const parent = new Map<string, string>();
  for (const k of unique) parent.set(k, k);
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };

  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      if (similarity(unique[i], unique[j]) < threshold) continue;
      const [ra, rb] = [find(unique[i]), find(unique[j])];
      if (ra !== rb) parent.set(rb, ra);
    }
  }

  const clusters = new Map<string, string[]>();
  for (const k of unique) {
    const root = find(k);
    const members = clusters.get(root);
    if (members) members.push(k);
    else clusters.set(root, [k]);
  }

  const canonicalOf = new Map<string, string>();
  for (const members of clusters.values()) {
    members.sort(
      (a, b) => freq.get(b)! - freq.get(a)! || b.length - a.length || (a < b ? -1 : a > b ? 1 : 0),
    );
    const canonical = members[0];
    for (const m of members) canonicalOf.set(m, canonical);
  }
  return canonicalOf;
}