/**
 * Query relevance and product-family classification — Unit 1 of the Query
 * Relevance / Product-Family Filtering plan (.atl/QUERY-RELEVANCE-PLAN.md).
 *
 * Scope of THIS unit: the Google Pixel family only, served as the first of
 * several family resolvers. The module is pure and dependency-free: it never
 * touches a marketplace, a price, or a category hint, so any lane (api,
 * arbitrage, browser tests) can run the same decision. Later units plug the
 * result into listing annotation and relevant-only statistics.
 *
 * Contract (matching the plan):
 *  - `matched`   — proven member of the requested family (or an accessory
 *                  that is *relevant* to it but excluded from statistics).
 *  - `ambiguous` — insufficient evidence; visible, never statistical.
 *  - `mismatch`  — evidence points to another product/family; visible, never
 *                  statistical.
 *
 * Normalization is Unicode/case/punctuation-safe. Identity-token typos are
 * tolerated up to a configured Levenshtein distance, but arbitrary whole-title
 * fuzzy matching is forbidden: the classifier only ever compares single tokens
 * against recognized identity tokens, so `DE128`/`XL256`/`PRO128` can never be
 * promoted to identity, and non-Pixel queries return the documented
 * not-applicable result (`NOT_APPLICABLE`) because this first resolver does not
 * claim them.
 */

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** Whether a listing belongs to the requested product family (excluding stats only for `accessory`). */
export type RelevanceStatus = 'matched' | 'ambiguous' | 'mismatch';

/** Why a listing got the status it did. Mirrors the plan's reason union. */
export type RelevanceReason =
  | 'matched'
  | 'typo-matched'
  | 'missing-product-anchor'
  | 'competing-family'
  | 'ambiguous-title'
  | 'accessory';

/** Product lines the Google Pixel family spans as separate kinds. */
export type ProductKind = 'phone' | 'fold' | 'watch' | 'tablet';

/** Families this resolver can claim. More resolvers land in later units. */
export type QueryFamilyKey = 'google-pixel';

/**
 * One server-side relevance decision for a listing.
 *
 * `family` is only set when the listing is a member of the requested family
 * (or is a relevant accessory): ambiguous/mismatch rows intentionally do not
 * claim a family. `productKind` is set for matched non-accessory devices.
 * `distance` is present only when an identity token was typo-matched, and then
 * it is the largest identity-token distance observed (each within the family's
 * tolerance).
 */
export interface QueryRelevance {
  status: RelevanceStatus;
  reason: RelevanceReason;
  family?: string;
  productKind?: ProductKind;
  distance?: number;
}

/**
 * A query resolved to a product family, separating query-intent resolution
 * from listing classification. `identityTokens` are the recognized
 * identity-token spellings, matched exactly or within `typoTolerance`
 * (never whole-title fuzzy). `typoTolerance` is per-family so unknown future
 * families stay conservative.
 */
export interface QueryFamilyResolution {
  key: QueryFamilyKey;
  label: string;
  productKinds: readonly ProductKind[];
  identityTokens: readonly string[];
  typoTolerance: number;
}

/**
 * Maximum Levenshtein distance for identity-token typos. `Gogle Pixel` is
 * distance 1 on `google`; `Pixle` is distance 2 on `pixel`; anything beyond is
 * no longer recognized identity.
 */
export const MAX_IDENTITY_TOKEN_DISTANCE = 2;

/** The Google Pixel family: phones, Fold, Watch and Tablet share one family. */
export const PIXEL_FAMILY: QueryFamilyResolution = Object.freeze({
  key: 'google-pixel',
  label: 'Google Pixel',
  productKinds: Object.freeze<ProductKind[]>(['phone', 'fold', 'watch', 'tablet']),
  identityTokens: Object.freeze(['google', 'pixel']),
  typoTolerance: MAX_IDENTITY_TOKEN_DISTANCE,
});

/**
 * The documented not-applicable result. Returned whenever the query carries no
 * recognizable Pixel anchor (e.g. `samsung galaxy s23`, `macbook`, `''`): this
 * first resolver deliberately claims nothing. Later units add other family
 * resolvers for those queries. Status is `ambiguous` — visible, excluded from
 * statistics — with `missing-product-anchor` explaining why.
 */
export const NOT_APPLICABLE: QueryRelevance = Object.freeze({
  status: 'ambiguous',
  reason: 'missing-product-anchor',
});

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

/**
 * Lowercase, decompose accents (NFD) so `PÍXEL` and `pixel` are the same
 * token, and replace every run of non-alphanumeric characters with a single
 * space. Digits survive. `+` and `&` are kept but split into standalone
 * tokens: a URL-joined "Google+Pixel+6" reads as "google + pixel + 6" and
 * anchors the family, while a separated marker ("Pixel 8 Pro + Case") keeps
 * its meaning as an "included as an extra" conjunction for the accessory
 * classifier. Non-Latin scripts are stripped, which is deliberate: unknown
 * scripts cannot claim identity and fall through to `ambiguous`.
 */
export function normalizeText(input: string): string {
  return String(input ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9+&]+/g, ' ')
    .replace(/([+&])/g, ' $1 ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Levenshtein distance
// ---------------------------------------------------------------------------

/**
 * Classic Levenshtein edit distance (insert/delete/substitute = 1,
 * transposition = 2). Case-sensitive on raw input: callers comparing natural
 * text should pass `normalizeText()` output first, which the classifier always
 * does. Used only to compare a single token against a recognized identity
 * token; never applied to whole titles.
 */
export function levenshtein(a: string, b: string): number {
  const s = String(a ?? '');
  const t = String(b ?? '');
  if (s === t) return 0;
  const m = s.length;
  const n = t.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1);
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

// ---------------------------------------------------------------------------
// Tokenizer (internal)
// ---------------------------------------------------------------------------

/** Split a letter↔digit junction so `Pixel8Pro` tokenizes as `pixel 8 pro`. */
const DIGIT_JUNCTION_RE = /(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])/g;

function tokenizeTitle(title: string): string[] {
  const spaced = normalizeText(title).replace(DIGIT_JUNCTION_RE, ' ');
  return spaced.length > 0 ? spaced.split(' ') : [];
}

// ---------------------------------------------------------------------------
// Identity tokens
// ---------------------------------------------------------------------------

interface IdentityMatch {
  /** Canonical token matched (e.g. 'pixel'). */
  matched: string;
  /** Distance of the title token from the canonical token (0 = exact). */
  distance: number;
}

/**
 * Find the best match of a single recognized identity token among the title
 * tokens, within the given tolerance. Exact spellings win trivially; otherwise
 * the closest conservative distance inside the bound (see `identityDistance`:
 * distance 1 is universal, distance 2 only as one adjacent transposition, so
 * "Pixle" matches "pixel" but the dictionary words "Pixma"/"Pixar" never do).
 * Returns null when nothing is close enough, which is the deny-by-default
 * outcome.
 */
function matchIdentityToken(tokens: string[], canonical: string, tolerance: number): IdentityMatch | null {
  if (tokens.includes(canonical)) return { matched: canonical, distance: 0 };
  let best: IdentityMatch | null = null;
  for (const token of tokens) {
    const distance = identityDistance(token, canonical);
    if (distance <= tolerance && (best === null || distance < best.distance)) {
      best = { matched: canonical, distance };
    }
  }
  return best;
}

/**
 * Distance between a title token and a canonical identity token, made
 * conservative at the bound: 0/1 edits are unambiguous, but distance 2 only
 * proves a typo when one adjacent transposition explains it ("pixle" →
 * "pixel", "googel" → "google"). Two independent edits ("pixma" → "pixel")
 * merely equal real words — Pixma/Pixar must never become Pixel identity, so
 * they return a distance above the tolerance and are dropped.
 */
function identityDistance(token: string, canonical: string): number {
  const d = levenshtein(token, canonical);
  if (d <= 1) return d;
  // Distance 2 is identity only when one adjacent transposition explains it;
  // otherwise the distance is reported beyond the tolerance so the caller
  // drops it ("pixma" -> "pixel" is a coincidence, not a typo).
  if (d === 2 && isSingleTransposition(token, canonical)) return 2;
  return Infinity;
}

/** Is `a` one adjacent-character swap away from `b`? (Preserves length.) */
function isSingleTransposition(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i + 1 < a.length; i++) {
    if (a[i] === a[i + 1]) continue; // swapping identical chars changes nothing
    if (a.slice(0, i) + a[i + 1] + a[i] + a.slice(i + 2) === b) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Competing families
// ---------------------------------------------------------------------------

/**
 * Product families that prove a listing is NOT a Pixel. Tokens are matched
 * exactly or as a prefix (`galaxys23` → `galaxys` after digit-splitting, still
 * a Galaxy). No typo forgiveness here: `phone` is distance 1 from `iphone`, so
 * fuzzy competitor matching would evict every "Pixel 8 phone" listing.
 *
 * Deliberate choice (review W3): a real Pixel title that mentions a competitor
 * at all — as a bundled extra ("w/ iPhone Charger") or as a comparison ("vs
 * iPhone 15") — classifies `mismatch`/`competing-family` and is excluded from
 * Pixel statistics rather than guessed at. Evidence of another family on the
 * listing outweighs the Pixel anchor under deny-by-default.
 */
const COMPETING_FAMILY_TOKENS: readonly string[] = [
  'iphone', 'galaxy', 'samsung', 'xiaomi', 'oneplus', 'huawei',
];

function hasCompetingFamily(tokens: string[]): boolean {
  return tokens.some((token) =>
    COMPETING_FAMILY_TOKENS.some((family) => token === family || token.startsWith(family)),
  );
}

// ---------------------------------------------------------------------------
// Accessory classification (title-only, conservative)
// ---------------------------------------------------------------------------

/**
 * Leading preambles that make the accessory the subject of the title:
 * "Case For Google Pixel 8" -> the case is for sale. `for sale` / `for parts`
 * preambles describe the device instead and are skipped below.
 */
const FOR_PREFIX_SKIP: ReadonlySet<string> = new Set(['parts', 'salvage', 'sale', 'sold', 'trade', 'trades']);

function isForPreamble(tokens: string[]): boolean {
  const [t0, t1, t2] = tokens;
  if (t0 === 'for' || t0 === 'para' || t0 === 'fits') return !FOR_PREFIX_SKIP.has(t1 ?? '');
  if (t0 === 'compatible' && (t1 === 'with' || t1 === 'con')) return !FOR_PREFIX_SKIP.has(t2 ?? '');
  if (t0 === 'replacement' && (t1 === 'for' || t1 === 'para')) return true;
  return false;
}

/**
 * Words that name an add-on unambiguously, wherever they appear in a
 * Pixel-anchored title. Mirrors the models.ts strong-accessory vocabulary,
 * kept dependency-free. Bare `box` stays out so "Pixel 8 with Box" is a phone.
 */
const STRONG_ACCESSORY_RE = new RegExp(
  '\\b(' +
    'cases?|covers?|fundas?|carcasas?|skins?|stickers?|bumpers?|holsters?|' +
    'screen\\s+protectors?|protectors?\\s+de\\s+pantalla|tempered\\s+glass|' +
    'glass\\s+protectors?|lens\\s+protectors?|camera\\s+protectors?|' +
    'backhousing|back\\s+housing|digitizers?|motherboards?|logic\\s+boards?|' +
    '(lcd|oled)\\s+(screens?|displays?|panels?|assembl(y|ies)|replacements?)|' +
    '(screens?|displays?|panels?)\\s+(lcd|oled)|' +
    'replacement\\s+(kits?|parts?|screens?|batter(y|ies)|displays?|digitizers?)|' +
    '(screens?|displays?|batter(y|ies)|digitizers?)\\s+replacement|' +
    'repair\\s+kits?|repuestos?|empty\\s+box|retail\\s+box|box\\s+only|lot\\s+of\\s+\\d+' +
    ')\\b',
);

/**
 * Sentence-dependent add-on words. They are accessories when nothing else is
 * being described (subject position), never when they name an included extra.
 */
const WEAK_ACCESSORY_TOKENS: ReadonlySet<string> = new Set([
  'screen', 'screens', 'display', 'displays', 'pantalla', 'pantallas',
  'battery', 'batteries', 'charger', 'chargers', 'cargador', 'cargadores',
  'cable', 'cables', 'adapter', 'adapters',
  'stand', 'stands', 'dock', 'docks', 'mount', 'mounts', 'holder', 'holders',
  'band', 'bands', 'strap', 'straps', 'grip', 'grips',
]);

/** Words signalling the device is being described, not the add-on. */
const CONDITION_WORDS: ReadonlySet<string> = new Set([
  'cracked', 'broken', 'damaged', 'dead', 'fix', 'fixed', 'fixing',
  'need', 'needs', 'needed', 'repair', 'repairs', 'repaired', 'repairing',
  'parts', 'salvage', 'for', 'as', 'is', 'not', 'wont', 'won', 'can', 'turn', 'on',
  'works', 'work', 'working', 'non', 'functional', 'untested',
  'mint', 'perfect', 'pristine', 'flawless', 'excellent', 'good', 'great', 'fine',
]);

/** "Included as an extra" markers before an accessory word (`+`, `w/`, `with`…). */
const EXTRA_MARKERS: ReadonlySet<string> = new Set([
  'w', 'with', 'con', 'incl', 'includes', 'included', 'including',
  'incluye', 'incluido', 'viene', '+', '&',
]);

/** Is the accessory word introduced as an included extra ("Pixel 8 Pro w/ Case")? */
function precededByExtraMarker(tokens: string[], index: number): boolean {
  for (let j = Math.max(0, index - 4); j < index; j++) {
    if (EXTRA_MARKERS.has(tokens[j])) return true;
  }
  return false;
}

/** "…Case Included" / "…Case + Protector Included": device with extras, not an accessory. */
function followedByIncluded(tokens: string[], index: number): boolean {
  const next = tokens[index + 1];
  return next === 'included' || next === 'includes' || next === 'include' || next === 'incluye';
}

/**
 * Decide whether a weak accessory word in subject position is really the
 * listing's subject. A device phrase anywhere in the title overrides the
 * subject reading: "Pixel 6a screen cracked" is a phone, "Pixel 8 Charger" is
 * a charger, and "Charger For Pixel 8" still resolves to the anchor after the
 * part word.
 */
function weakWordIsAccessory(tokens: string[], index: number): boolean {
  // A part word thrown in as an included extra ("Pixel 8 Pro w/ Charger",
  // "Pixel 8 128GB + Cargador", "…Charger Included") describes the device,
  // not the add-on — the marker rules apply to weak words too (W2).
  if (precededByExtraMarker(tokens, index) || followedByIncluded(tokens, index)) return false;
  const before = tokens.slice(0, index);
  const after = tokens.filter((_, i) => i > index);
  if (before.length === 0) return true; // "Screen For Pixel 8": the part leads.

  const conditionIn = (words: string[]): boolean => words.some((w) => CONDITION_WORDS.has(w));
  if (conditionIn(before) || conditionIn(after)) return false; // Device phrase present.

  const significant = after.filter((w) => !/^\d+$/.test(w));
  if (significant.length === 0) return true; // "Pixel Stand 2"
  if (significant.some((w) => w === 'pixel' || w === 'google' || WEAK_ACCESSORY_TOKENS.has(w))) {
    return true; // "Pixel 8 Charger Cable", "Charger for Pixel 8"
  }
  return false; // Title keeps describing the device ("Pixel 8 screen 128GB").
}

function isAccessoryTitle(tokens: string[]): boolean {
  if (isForPreamble(tokens)) return true;

  // Strong patterns anywhere in the anchored title.
  const title = tokens.join(' ');
  let match: RegExpExecArray | null;
  const re = new RegExp(STRONG_ACCESSORY_RE, 'g');
  while ((match = re.exec(title)) !== null) {
    const wordIndex = title.slice(0, match.index).split(' ').filter(Boolean).length;
    if (!precededByExtraMarker(tokens, wordIndex) && !followedByIncluded(tokens, wordIndex)) return true;
    if (re.lastIndex === match.index) re.lastIndex++;
  }

  // Weak words only in subject position.
  return tokens.some((token, i) => WEAK_ACCESSORY_TOKENS.has(token) && weakWordIsAccessory(tokens, i));
}

/** Google Pixel lines that exist but are outside the phone/Fold/Watch/Tablet scope. */
const OUT_OF_SCOPE_TOKENS: ReadonlySet<string> = new Set(['buds', 'earbuds']);

function isOutOfScopeLine(tokens: string[]): boolean {
  return tokens.some((token) => OUT_OF_SCOPE_TOKENS.has(token));
}

function resolveProductKind(tokens: string[]): ProductKind {
  if (tokens.includes('fold')) return 'fold';
  if (tokens.includes('watch')) return 'watch';
  if (tokens.includes('tablet')) return 'tablet';
  return 'phone';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a marketplace search query to a product family, or return null when
 * this first resolver has no claim on it. A query resolves only when it
 * carries the family's identity anchor (`pixel`, exact or within the typo
 * bound): `google` alone, `iphone 15`, `macbook` and empty strings return
 * null, so the classifier can answer with the documented not-applicable
 * result. `Google Pixel` and `Pixel` resolve to the complete family scope —
 * phones, Fold, Watch and Tablet.
 */
export function resolveQueryFamily(query: string): QueryFamilyResolution | null {
  const tokens = tokenizeTitle(query);
  if (tokens.length === 0) return null;
  const pixel = matchIdentityToken(tokens, 'pixel', PIXEL_FAMILY.typoTolerance);
  return pixel ? PIXEL_FAMILY : null;
}

/**
 * Classify one listing title against a query (string) or an already-resolved
 * family. Order of checks:
 *   1. non-Pixel / anchor-less query -> `NOT_APPLICABLE`;
 *   2. competing family present       -> mismatch `competing-family`;
 *   3. no `pixel` identity token      -> ambiguous (`missing-product-anchor`
 *      when Google itself is present, `ambiguous-title` otherwise);
 *   4. accessory evidence on a Pixel anchor -> matched `accessory`;
 *   5. out-of-scope Pixel lines (Buds)-> ambiguous `ambiguous-title`;
 *   6. otherwise matched with a product kind (`typo-matched` when any identity
 *      token exceeded distance 0, carrying the largest distance).
 *
 * Never fuzzy-matches whole titles: only single tokens vs. identity tokens.
 */
export function classifyQueryRelevance(title: string, query: string | QueryFamilyResolution): QueryRelevance {
  const family = typeof query === 'string' ? resolveQueryFamily(query) : query;
  if (!family || family.key !== 'google-pixel') return NOT_APPLICABLE;

  const tokens = tokenizeTitle(title);
  if (tokens.length === 0) return { status: 'ambiguous', reason: 'ambiguous-title' };

  if (hasCompetingFamily(tokens)) return { status: 'mismatch', reason: 'competing-family' };

  const pixel = matchIdentityToken(tokens, 'pixel', family.typoTolerance);
  const google = matchIdentityToken(tokens, 'google', family.typoTolerance);
  if (!pixel) {
    if (google) return { status: 'ambiguous', reason: 'missing-product-anchor' };
    return { status: 'ambiguous', reason: 'ambiguous-title' };
  }

  if (isAccessoryTitle(tokens)) return { status: 'matched', reason: 'accessory', family: family.key };

  if (isOutOfScopeLine(tokens)) return { status: 'ambiguous', reason: 'ambiguous-title' };

  const productKind = resolveProductKind(tokens);
  const distance = Math.max(pixel.distance, google?.distance ?? 0);
  if (distance > 0) {
    return { status: 'matched', reason: 'typo-matched', family: family.key, productKind, distance };
  }
  return { status: 'matched', reason: 'matched', family: family.key, productKind };
}