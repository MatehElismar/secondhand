/**
 * Product/model classification.
 *
 * Everything downstream leans on this: listings are grouped by model, the group
 * key becomes the query sent to the other marketplace, and margins are only
 * meaningful when both sides resolved to the same model. A sloppy key does not
 * degrade gracefully — it prices one phone against another.
 *
 * Titles are written by sellers, in two languages, and routinely list several
 * configurations at once ("128/256/512GB"). So parsing is structural: pull out
 * what is actually asserted, and leave the rest null rather than guessing.
 */

export interface ParsedModel {
  /** 'Apple', 'Samsung', … or null when unrecognized. */
  brand: string | null;
  /** Product line: 'iPhone', 'iPad', 'MacBook', 'Apple Watch', 'Galaxy'. */
  line: string | null;
  /** Generation/number within the line: '15', '4', '9', 'SE'. */
  generation: string | null;
  /** Trim: 'Pro Max', 'Pro', 'Plus', 'mini', 'Ultra', 'FE', 'Air'. */
  variant: string | null;
  /**
   * A refinement of the model rather than a different model: console 'Digital'
   * vs 'Disc'. A seller who omits it has not named a third product, so it is a
   * wildcard when matching — unlike a trim, where Pro and Pro Max are two
   * different machines at two different prices.
   */
  edition: string | null;
  /** Apple silicon, when named: 'M2', 'M4 Pro'. */
  chip: string | null;
  /** Storage in GB — never RAM, and null when the title lists several. */
  storageGb: number | null;
  /** The title advertises multiple configurations, so no single capacity. */
  multiStorage: boolean;
  /** Watch case size in mm. */
  sizeMm: number | null;
  /** Not a device: a case, a screen assembly, a lot, an empty box. */
  isAccessory: boolean;
  /** Canonical, human-readable key. */
  key: string;
  /**
   * How much the key can be trusted as an identity.
   *  high   - brand, line and a model identifier were all recognized.
   *  medium - brand and line, but nothing pinning the specific model.
   *  low    - the title never named a model ("Laptop Lenovo", "Laptop Gamer").
   *
   * Nothing downstream may price a margin off a 'low' key: two listings that
   * share it are not the same product, they are merely described as vaguely.
   */
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Titles describing something other than the device itself. Grouping has to
 * know about these too: an "OLED For iPhone 15 Pro Replacement" is not an
 * iPhone 15 Pro, and letting it into the group corrupts that group's median
 * before any buy-side filtering gets a chance to run.
 */
/**
 * Parts and add-ons that are never the product, whatever else the title says.
 *
 * Note what is NOT here: headphones, headsets, AirPods and earbuds are
 * products in their own right. Listing them as accessory words — they were
 * added for phones sold with earbuds — flagged 13 of 60 real Sony WH-1000XM4
 * listings as accessories and removed them from their own group.
 */
export const STRONG_ACCESSORY_RE =
  /\b(backhousing|back housing|digitizer|motherboard|logic board|dis[ck] drive|faceplate|dualsense|dualshock|joy-?con|screen protector|protector de pantalla|tempered glass|lens protector|replacement (kit|part|screen|battery|display|digitizer)|(camera|screen|battery|display|glass|port|flex|housing|hinge|keyboard|charging port)\s+replacement|repair (kit|part)|repuesto|(lcd|oled)\s*(screen|display|panel|assembly|replacement)|(screen|display|panel)\s*(lcd|oled)|empty box|box only|caja vac|retail box|box packaging|lot of \d+|(hard|carrying|travel|protective|zipper)\s+case|case\s+(for|only)|cooling stand|charging (station|dock))\b/i;

/**
 * Words that name an accessory OR an included extra, depending on the
 * sentence: "Headphones w/ Case" is headphones; "Headphones Hard Case" is a
 * case. Resolved by position rather than by presence.
 */
const WEAK_ACCESSORY_RE =
  /\b(case|funda|carcasa|cover|skin|sticker|bumper|wallet|holster|mica|charger|cargador|cable|adapter|adaptador|holder|mount|stand|tripod|grip|strap|band only|packaging)\b/i;

/** "For iPhone 15" / "Compatible with iPhone 15" only ever precede accessories. */
const FOR_PREFIX_RE = /^\s*(for|para|compatible (with|con)|fits|replacement (for|para)|genuine\s+\w+\s+\w*\s*case)\b/i;

/** The accessory word is offered alongside the product, not as the product. */
const INCLUDED_EXTRA_RE = /\b(w\/|with|incl(?:udes|uding|uded)?|incluye|incluido|viene con|\+|&)\s*(\w+\s+){0,2}$/i;

export const ACCESSORY_RE = STRONG_ACCESSORY_RE;

/**
 * Marketplace categories that describe an add-on rather than the product.
 * eBay sorts its own catalogue far more reliably than a title can be read:
 * for "sony wh-1000xm4" it reports 40 Headphones, 6 Cases/Covers/Skins, 3
 * Headsets and 1 Replacement Parts — no keyword guessing required.
 */
const ACCESSORY_CATEGORY_RE =
  /\b(cases?|covers?|skins?|screen protectors?|replacement parts?|parts? & tools?|smartphone parts|laptop screens?|lcd panels?|motherboards?|batteries|chargers?|cables?|adapters?|mounts?|stands?|accessor(y|ies)|straps?|bands?)\b/i;

/** Does the marketplace itself file this listing under accessories or parts? */
export function categoryIsAccessory(category?: string | null): boolean {
  return Boolean(category && ACCESSORY_CATEGORY_RE.test(category));
}

/**
 * How strongly a listing looks like an add-on rather than the product.
 *
 *  'strong' — the title says so unambiguously ("Replacement For…", "Case for
 *             iPhone", a backhousing). Safe to drop on its own.
 *  'weak'   — the marketplace filed it under an accessory category, or a
 *             sentence-dependent word appeared in subject position. Sellers
 *             miscategorize: three real WH-1000XM4 headphones, priced at ~$100
 *             against a $130 device median, sit under "Cases, Covers & Skins".
 *             So this needs the price to agree before it is acted on.
 *  'none'   — looks like the product.
 */
export function accessorySignal(l: { title?: string; category?: string | null }): 'strong' | 'weak' | 'none' {
  const title = String(l.title || '');
  if (FOR_PREFIX_RE.test(title) || STRONG_ACCESSORY_RE.test(title)) return 'strong';
  if (categoryIsAccessory(l.category) || isAccessoryTitle(title)) return 'weak';
  return 'none';
}

/**
 * Verdict for callers that have no price to weigh. Treats 'weak' as accessory,
 * which is right for display but too blunt for pricing — those callers should
 * use accessorySignal and check the price themselves.
 */
export function isAccessoryListing(l: { title?: string; category?: string | null }): boolean {
  return accessorySignal(l) !== 'none';
}

function isAccessoryTitle(t: string): boolean {
  if (FOR_PREFIX_RE.test(t) || STRONG_ACCESSORY_RE.test(t)) return true;
  const m = WEAK_ACCESSORY_RE.exec(t);
  if (!m) return false;
  const before = t.slice(0, m.index);
  // Offered as an extra ("... w/ Case", "... + charger") — the product is
  // whatever came before it.
  if (INCLUDED_EXTRA_RE.test(before)) return false;
  // Nothing before it: the accessory is the subject of the listing.
  return before.trim().split(/\s+/).filter(Boolean).length < 2;
}

/**
 * Storage, in GB, ignoring RAM.
 *
 * "MacBook Air M2 8GB RAM 256GB SSD" must not classify as an 8GB machine —
 * that single mistake split one MacBook model across four groups. And a title
 * offering "128/256/512GB" has no single capacity, so it reports none rather
 * than silently claiming the first.
 */
export function parseStorage(title: string): { storageGb: number | null; multiStorage: boolean } {
  const t = title.toLowerCase();

  // Capacities explicitly labelled as memory are not storage.
  const ramValues = new Set<number>();
  for (const m of t.matchAll(/(\d+)\s*gb\s*(?:de\s*)?ram|ram[:\s]*(\d+)\s*gb/gi)) {
    ramValues.add(Number(m[1] ?? m[2]));
  }

  // "128/256/512GB" and "128GB 256GB 512GB" both mean "pick a configuration".
  const slashRun = t.match(/(\d+\s*(?:\/\s*\d+\s*){1,}(?:gb|tb))/i);

  const found: number[] = [];
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(gb|tb)\b/gi)) {
    const value = Number(m[1]) * (m[2].toLowerCase() === 'tb' ? 1024 : 1);
    const after = t.slice(m.index! + m[0].length, m.index! + m[0].length + 6);
    if (/^\s*ram/.test(after)) continue;
    found.push(value);
  }
  const storages = found.filter((v) => !ramValues.has(v) || found.filter((f) => f === v).length > 1);
  const distinct = [...new Set(storages)];

  if (slashRun || distinct.length >= 3) return { storageGb: null, multiStorage: true };
  if (distinct.length === 0) return { storageGb: null, multiStorage: false };
  if (distinct.length === 1) return { storageGb: distinct[0], multiStorage: false };

  // Two capacities and no RAM label: the smaller one is almost always memory
  // (8/16/24/32GB) next to a real disk. Otherwise it is a two-config listing.
  const [small, large] = [Math.min(...distinct), Math.max(...distinct)];
  if (small <= 32 && large >= 128) return { storageGb: large, multiStorage: false };
  return { storageGb: null, multiStorage: true };
}

const titleCase = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

/**
 * Words that carry no model information — condition, provenance and Spanish
 * connectives. They show up in every other title ("New iPhone …", "iPhone
 * para piezas"), so anything deriving meaning from a title's words has to drop
 * them first. Shared with the fuzzy grouper so both filters stay identical.
 */
export const FILLER_WORDS_RE =
  /^(new|nuevo|nueva|used|usado|usada|oem|original|genuine|sealed|sellado|sellada|unlocked|factory|vendo|venta|vende|cambio|oferta|the|de|para|con|en|y)$/i;

function parseChip(t: string): string | null {
  const m = t.match(/\bm([1-9])\s*(pro|max|ultra)?\b/i);
  if (!m) return null;
  return `M${m[1]}${m[2] ? ' ' + titleCase(m[2]) : ''}`;
}

/** Parse a listing title into its structural parts. */
export function parseModel(title: string): ParsedModel {
  const raw = String(title || '');
  const t = raw.toLowerCase();
  const { storageGb, multiStorage } = parseStorage(raw);
  const isAccessory = isAccessoryTitle(raw);

  const base = {
    brand: null as string | null,
    line: null as string | null,
    generation: null as string | null,
    variant: null as string | null,
    edition: null as string | null,
    chip: null as string | null,
    storageGb,
    multiStorage,
    sizeMm: null as number | null,
    isAccessory,
  };

  // ── Apple Watch ────────────────────────────────────────────────────────
  if (/\b(apple\s*watch|iwatch)\b/i.test(t) || /\bwatch\s*(series|ultra|se)\b/i.test(t)) {
    const series = t.match(/serie?s?\s*(\d+)/i);
    const ultra = /\bwatch\s*ultra\s*(\d)?/i.exec(t);
    const se = /\bwatch\s*se\b|\bse\s*\(?(2nd|2)\b/i.test(t);
    const mm = t.match(/(\d{2})\s*mm/);
    const variant = ultra ? `Ultra${ultra[1] ? ' ' + ultra[1] : ''}` : se ? 'SE' : null;
    return finish({
      ...base,
      brand: 'Apple',
      line: 'Apple Watch',
      generation: series ? series[1] : null,
      variant,
      sizeMm: mm ? Number(mm[1]) : null,
      storageGb: null, // watch capacity is never the price driver
      multiStorage: false,
    });
  }

  // ── iPhone ─────────────────────────────────────────────────────────────
  if (/\biphone\b/i.test(t)) {
    // "Pro Max" must be tried before "Pro", or every Max collapses into Pro.
    const m = t.match(/iphone\s*(se|xr|xs|x|\d{1,2})\s*(pro\s*max|pro|plus|\+|mini|max)?/i);
    let generation = m ? m[1].toUpperCase() : null;
    let variant: string | null = null;
    if (m?.[2]) {
      const v = m[2].toLowerCase().replace(/\s+/g, ' ');
      variant = v === 'pro max' ? 'Pro Max' : v === '+' ? 'Plus' : titleCase(v);
    }
    if (generation === 'SE') {
      const gen = t.match(/se\s*\(?(2nd|3rd|2|3)/i);
      generation = gen ? `SE ${gen[1].replace(/nd|rd/, '')}` : 'SE';
    }
    return finish({ ...base, brand: 'Apple', line: 'iPhone', generation, variant });
  }

  // ── iPad ───────────────────────────────────────────────────────────────
  if (/\bipad\b/i.test(t)) {
    const variantMatch = t.match(/ipad\s*(pro|air|mini)/i);
    const variant = variantMatch ? titleCase(variantMatch[1]) : null;
    // "iPad Air 4", "iPad Air 4th Gen", "iPad 9th generation", "iPad Air M2".
    const gen =
      t.match(/ipad\s*(?:pro|air|mini)?\s*(\d{1,2})(?:st|nd|rd|th)?\s*(?:gen|generation)?\b/i) ||
      t.match(/generaci[oó]n\s*(\d{1,2})/i);
    const chip = parseChip(t);
    const inches = t.match(/(\d{1,2}(?:\.\d)?)\s*(?:-)?\s*inch|(\d{1,2}(?:\.\d)?)"/i);
    return finish({
      ...base,
      brand: 'Apple',
      line: 'iPad',
      variant,
      // A chip names the model just as well as a generation number does.
      generation: gen ? gen[1] : chip ? null : inches ? `${inches[1] ?? inches[2]}"` : null,
      chip,
    });
  }

  // ── MacBook ────────────────────────────────────────────────────────────
  if (/\bmac\s?book\b/i.test(t)) {
    const variantMatch = t.match(/mac\s?book\s*(air|pro)/i);
    return finish({
      ...base,
      brand: 'Apple',
      line: 'MacBook',
      variant: variantMatch ? titleCase(variantMatch[1]) : null,
      chip: parseChip(t),
    });
  }

  // ── Samsung Galaxy ─────────────────────────────────────────────────────
  if (/\b(samsung|galaxy)\b/i.test(t)) {
    // S23 / S23+ / S23 Plus / S23 Ultra / S23 FE are different phones at very
    // different prices; collapsing them into one "Samsung S23" was the single
    // worst grouping error in practice.
    const s = t.match(/\b(s|note|a|m)\s*(\d{1,3})\s*(ultra|plus|\+|fe)?/i);
    const fold = t.match(/\b(z\s*fold|z\s*flip|fold|flip)\s*(\d)?/i);
    let generation: string | null = null;
    let variant: string | null = null;
    if (fold) {
      generation = fold[2] ?? null;
      variant = /fold/i.test(fold[1]) ? 'Z Fold' : 'Z Flip';
    } else if (s) {
      generation = `${s[1].toUpperCase()}${s[2]}`;
      if (s[3]) {
        const v = s[3].toLowerCase();
        variant = v === '+' ? 'Plus' : v === 'fe' ? 'FE' : titleCase(v);
      }
    }
    return finish({ ...base, brand: 'Samsung', line: 'Galaxy', generation, variant });
  }

  // ── Game consoles ──────────────────────────────────────────────────────
  const console_ = parseConsole(t);
  // Spread order matters: a console that sets storageGb (the Switch, whose
  // capacity never drives price) overrides it; the others inherit the parse.
  if (console_) return finish({ ...base, ...console_ });

  // ── Windows laptops ────────────────────────────────────────────────────
  const pc = parsePcLaptop(t);
  if (pc) return finish({ ...base, ...pc });

  // ── Anything carrying a manufacturer model code ────────────────────────
  const code = extractModelCode(raw);
  if (code) {
    const brand = CODE_BRANDS.find((b) => new RegExp(`\\b${b.replace('-', '[- ]?')}\\b`, 'i').test(t));
    const brandName = brand ? brand.split('-').map(titleCase).join('-') : null;
    return finish({
      ...base,
      brand: brandName,
      line: brandName,
      generation: code,
      key: [brandName, code].filter(Boolean).join(' '),
      // The code names one product; without a brand it is still a strong id.
      confidence: 'high',
    } as never);
  }

  // ── Unknown ────────────────────────────────────────────────────────────
  // Two leading words was the old fallback and it grouped by noise ("Apple
  // iPhone", "New Samsung"). Strip filler first so the words carry meaning.
  const words = raw
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !FILLER_WORDS_RE.test(w));
  return finish({
    ...base,
    generation: null,
    key: words.slice(0, 3).map(titleCase).join(' ') || 'Other',
    confidence: 'low',
  } as never);
}



/**
 * Consoles are a top secondhand category and sellers name them every possible
 * way: "PS5", "PlayStation 5", "Play Station 5", "Vendo PS5 Slim". Left to the
 * generic fallback these became six groups of one product, none of them
 * comparable to anything.
 *
 * Edition matters as much as the model does: a Digital has no disc drive and
 * sells for meaningfully less than the Disc version, so they must not merge.
 */
function parseConsole(t: string): Partial<ParsedModel> | null {
  const edition = () => {
    if (/\b(digital|digitale?)\b/i.test(t)) return 'Digital';
    if (/\b(disc|disco|disk|dis[ck] drive|con lector|blu-?ray)\b/i.test(t)) return 'Disc';
    return null;
  };

  const ps = t.match(/\bps\s?([2-5])\b/i) || t.match(/\bplay\s?station\s*([2-5])\b/i);
  if (ps) {
    const gen = ps[1];
    const slim = /\bslim\b/i.test(t);
    const pro = /\bpro\b/i.test(t);
    return {
      brand: 'Sony',
      line: 'PlayStation',
      generation: gen,
      variant: pro ? 'Pro' : slim ? 'Slim' : null,
      edition: edition(),
      confidence: 'high',
    };
  }

  const xbox = t.match(/\bxbox\s*(series\s*[xs]|one\s*[xs]?|360)?\b/i);
  if (xbox) {
    const raw = (xbox[1] || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const variant = raw
      ? raw.startsWith('series')
        ? `Series ${raw.slice(-1).toUpperCase()}`
        : raw === '360'
          ? '360'
          : `One${raw.length > 3 ? ' ' + raw.slice(-1).toUpperCase() : ''}`
      : null;
    return {
      brand: 'Microsoft',
      line: 'Xbox',
      generation: null,
      variant,
      edition: edition(),
      confidence: variant ? 'high' : 'medium',
    };
  }

  if (/\b(nintendo\s*switch|switch\s*(oled|lite|2))\b/i.test(t)) {
    const oled = /\boled\b/i.test(t);
    const lite = /\blite\b/i.test(t);
    const two = /\bswitch\s*2\b/i.test(t);
    return {
      brand: 'Nintendo',
      line: 'Nintendo Switch',
      generation: two ? '2' : null,
      variant: oled ? 'OLED' : lite ? 'Lite' : null,
      storageGb: null,
      confidence: 'high',
    };
  }
  return null;
}


/**
 * Manufacturer model codes — WH-1000XM4, WF-1000XM5, MDR-7506, SM-S911U.
 *
 * These are the most reliable identity a title can carry, and they generalize
 * where a brand table cannot: headphones, cameras, monitors, printers. They
 * are also written every possible way, so the code is normalized rather than
 * matched literally — "WH-1000XM4", "WH1000XM4" and "wh 1000xm4" are one
 * product, and the old fallback split them into three groups while merging
 * XM4 with XM5 by truncating both at the hyphen.
 */
// Hyphenated or joined: "WH-1000XM4", "WH1000XM4", "WH-CH520", "MDR-7506".
const CODE_JOINED_RE = /\b([a-z]{1,4}-?[a-z]{0,3}\d{2,5}[a-z]{0,4}\d{0,2})\b/gi;
// Space-separated: "wh 1000xm4". The prefix is capped at three letters so a
// brand word cannot be swallowed — "Sony wh1000xm4" must not read as one
// token "SONYWH1000XM4", which would not match "WH1000XM4" from the next
// listing of the same headphones.
const CODE_SPACED_RE = /\b([a-z]{2,3})\s(\d{3,5}[a-z]{0,4}\d{0,2})\b/gi;

/** Tokens shaped like a model code that never are one. */
const NOT_A_CODE = /^(usb\d|hdmi\d|mp\d|led\d|lcd\d|dc\d|ac\d|no\d|v\d{2,}|win\d|ddr\d|pcie\d|sata\d|cat\d)$/i;
/** Capacity, resolution and speed read as codes if not excluded. */
const MEASUREMENT = /\d+(gb|tb|mb|kb|hz|mah|mm|cm|w|v|k|p)$/i;

function acceptCode(raw: string, title: string, index: number): string | null {
  const token = raw.replace(/[-\s]/g, '').toUpperCase();
  if (token.length < 5) return null;
  if (NOT_A_CODE.test(token) || MEASUREMENT.test(token)) return null;
  // A CPU part number identifies a component, not the product for sale.
  const before = title.slice(Math.max(0, index - 12), index).toLowerCase();
  if (/\b(i[3579]|ryzen|core|celeron|pentium|athlon)\s*-?\s*$/.test(before)) return null;
  // A code has to mix letters and digits.
  if (!/[a-z]/i.test(token) || !/\d/.test(token)) return null;
  return token;
}

export function extractModelCode(title: string): string | null {
  const t = String(title || '');
  for (const m of t.matchAll(CODE_JOINED_RE)) {
    const code = acceptCode(m[1], t, m.index!);
    if (code) return code;
  }
  for (const m of t.matchAll(CODE_SPACED_RE)) {
    const code = acceptCode(m[1] + m[2], t, m.index!);
    if (code) return code;
  }
  return null;
}

/** Known brands, for pairing with a bare model code. */
const CODE_BRANDS = ['sony', 'bose', 'jbl', 'sennheiser', 'audio-technica', 'beats', 'anker', 'soundcore', 'skullcandy', 'canon', 'nikon', 'fujifilm', 'panasonic', 'gopro', 'dji', 'garmin', 'logitech', 'razer', 'steelseries', 'corsair', 'epson', 'brother', 'lg', 'philips', 'xiaomi', 'motorola', 'google', 'oneplus', 'huawei', 'oppo', 'realme', 'tcl', 'hisense', 'roku', 'netgear', 'tp-link', 'asus', 'acer', 'dell', 'hp', 'lenovo', 'samsung', 'apple', 'nintendo', 'microsoft'];

/** Brands and product lines that actually identify a Windows laptop. */
const PC_BRANDS = ['dell', 'hp', 'lenovo', 'acer', 'asus', 'msi', 'toshiba', 'razer', 'samsung', 'microsoft', 'alienware', 'gateway', 'huawei', 'lg'];
const PC_LINES = [
  'latitude', 'inspiron', 'xps', 'vostro', 'precision', 'alienware',
  'thinkpad', 'ideapad', 'yoga', 'legion', 'thinkbook',
  'elitebook', 'probook', 'pavilion', 'envy', 'omen', 'spectre', 'victus', 'chromebook',
  'aspire', 'predator', 'nitro', 'swift', 'travelmate',
  'zenbook', 'vivobook', 'rog', 'tuf',
  'surface laptop', 'surface pro', 'surface go', 'surface book',
  'macbook',
];

/**
 * A Windows laptop's identity is brand + line + model number. The number is
 * the hard part: "Dell Latitude 5420" names a machine, "Dell Latitude 14"
 * names a screen. Treating the screen size as a model split one machine into
 * several groups and merged different ones.
 */
function parsePcLaptop(t: string): Partial<ParsedModel> | null {
  const brand = PC_BRANDS.find((b) => new RegExp(`\\b${b}\\b`, 'i').test(t));
  const line = PC_LINES.find((l) => new RegExp(`\\b${l}\\b`, 'i').test(t));
  if (!brand && !line) return null;

  const brandName = brand ? titleCase(brand) : null;
  const lineName = line ? line.split(' ').map(titleCase).join(' ') : null;

  // A model identifier follows the line name and is not a screen measurement.
  let model: string | null = null;
  if (line) {
    const after = t.slice(t.toLowerCase().indexOf(line) + line.length);
    // Lenovo and HP put the code after a series number ("IdeaPad 3 15ITL6",
    // "Pavilion 15ba022nr"), and those codes lead with the screen size, so a
    // letters-first pattern alone misses them.
    const m = after.match(
      /^[\s-]*(?:\d\s+)?((?:[a-z]{1,2}\d{2,4}[a-z]{0,3}\d{0,2})|(?:\d{2,4}[a-z]{2,6}\d{0,2})|(?:\d{3,4}[a-z]{0,3}))\b/i,
    );
    if (m) {
      const token = m[1];
      // 13/14/15/16/17 alone is a screen size, and "15.6" never a model.
      const screenish = /^\d{2}$/.test(token) && Number(token) >= 10 && Number(token) <= 18;
      if (!screenish) model = token.toUpperCase();
    }
  }

  const parts = [brandName, lineName, model].filter(Boolean) as string[];
  if (!parts.length) return null;
  return {
    brand: brandName,
    line: lineName,
    generation: model,
    key: parts.join(' '),
    confidence: model ? 'high' : lineName ? 'medium' : 'low',
  } as Partial<ParsedModel>;
}

/** Assemble the canonical key from whatever the parse established. */
function finish(p: Omit<ParsedModel, 'key' | 'confidence'> & { key?: string; confidence?: ParsedModel['confidence'] }): ParsedModel {
  if (p.key) return { confidence: 'high', ...p, key: p.key } as ParsedModel;

  const parts: string[] = [];
  if (p.line) parts.push(p.line);
  // Each line names itself in its own order: "iPhone 15 Pro Max", but
  // "iPad Air 4" and "Galaxy S23 Ultra".
  if (p.line === 'iPhone' || p.line === 'PlayStation') {
    if (p.generation) parts.push(p.generation);
    if (p.variant) parts.push(p.variant);
  } else if (p.line === 'Apple Watch') {
    if (p.variant) parts.push(p.variant);
    else if (p.generation) parts.push('Series', p.generation);
  } else if (p.line === 'Galaxy') {
    if (p.generation) parts.push(p.generation);
    if (p.variant) parts.push(p.variant);
  } else {
    if (p.variant) parts.push(p.variant);
    if (p.generation) parts.push(p.generation);
  }
  if (p.edition) parts.push(p.edition);
  if (p.chip) parts.push(p.chip);
  if (p.sizeMm) parts.push(`${p.sizeMm}mm`);
  if (p.storageGb) parts.push(p.storageGb >= 1024 ? `${p.storageGb / 1024}TB` : `${p.storageGb}GB`);
  const key = parts.join(' ').trim() || 'Other';
  // A line with no generation, trim or chip is just a category name.
  const identified = Boolean(p.generation || p.chip || p.variant);
  const confidence: ParsedModel['confidence'] =
    p.confidence ?? (!p.line ? 'low' : identified ? 'high' : 'medium');
  return { ...p, key, confidence } as ParsedModel;
}

/** Canonical key for a title — the identity used for grouping and querying. */
export function modelKey(title: string): string {
  return parseModel(title).key;
}

/**
 * The key minus the capacity — what to compare and what to search with. Two
 * listings of the same phone in different capacities are the same model; a
 * listing that never states capacity is not a third model.
 */
export function modelFamily(title: string): string {
  const p = parseModel(title);
  return finish({ ...p, storageGb: null, key: undefined }).key;
}

/**
 * Do these two keys describe the same device? Capacity is a wildcard when
 * either side leaves it out, but "15 Pro" never matches "15 Pro Max", "15
 * Plus" or "13" — those cost hundreds of dollars apart.
 */
/**
 * Structural comparison. Brand, line, generation, trim and chip must agree
 * exactly — those name the product. Edition and capacity are wildcards when
 * either side leaves them out, because a seller who wrote "PS5 Slim" has not
 * named a third console, only a vaguer one.
 */
export function modelsMatch(a: ParsedModel, b: ParsedModel): boolean {
  const strict: Array<keyof ParsedModel> = ['line', 'generation', 'variant', 'chip'];
  for (const f of strict) {
    const [x, y] = [a[f], b[f]];
    if ((x ?? null) !== (y ?? null)) return false;
  }
  for (const f of ['edition', 'storageGb'] as Array<keyof ParsedModel>) {
    const [x, y] = [a[f] ?? null, b[f] ?? null];
    if (x !== null && y !== null && x !== y) return false;
  }
  return true;
}

export function sameModel(a: string, b: string): boolean {
  const strip = (k: string) =>
    k
      .toLowerCase()
      .replace(/\s*\d+(?:\.\d+)?(gb|tb)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const [x, y] = [strip(a), strip(b)];
  if (x === y) return true;
  // Capacity aside, one side may simply be less specific — but only trailing
  // capacity is optional, never a trim level.
  return false;
}

/**
 * The query to send to the other marketplace. Capacity narrows results
 * usefully, but a multi-configuration listing has none to offer.
 */
export function searchQueryFor(key: string): string {
  return key.replace(/\s+/g, ' ').trim();
}

/**
 * Classify a listing using its description when the title was not enough.
 *
 * Facebook sellers routinely title a listing "Laptop Lenovo" and then spell
 * out "ThinkPad T14 i7 16GB" in the description. Reading the description costs
 * an extra request per listing, so callers fetch it only for listings the
 * title failed to identify — and only then does this take it into account.
 *
 * The description is noisy ("no incluye cargador", "compatible con..."), so an
 * enriched parse is accepted only when it genuinely improves on the title and
 * does not contradict it.
 */
export function parseListingModel(l: { title?: string; description?: string | null }): ParsedModel {
  const fromTitle = parseModel(String(l.title || ''));
  if (fromTitle.confidence === 'high' || !l.description) return fromTitle;

  const enriched = parseModel(`${l.title || ''} ${l.description}`);
  const rank = { low: 0, medium: 1, high: 2 } as const;
  if (rank[enriched.confidence] <= rank[fromTitle.confidence]) return fromTitle;
  // The description must refine the title, not overrule it: a title that named
  // a line keeps that line.
  if (fromTitle.line && enriched.line !== fromTitle.line) return fromTitle;
  return enriched;
}
