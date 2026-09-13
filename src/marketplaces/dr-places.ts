/**
 * The only places this app searches: Greater Santo Domingo.
 *
 * This is a closed list, not a geocoder, and that is the point. Facebook's own
 * location search ranks by check-ins: asked for "Santo Domingo, Dominican
 * Republic" it answered Santo Domingo, PARAGUAY (lat -25.28, lon -57.58), so
 * every default search quietly looked at another continent. An offline GeoNames
 * lookup was added to fix exactly this class of bug (see us-cities.ts) but it was
 * filtered to US cities, so Dominican input still fell through to Facebook.
 *
 * With eight known places there is nothing to rank, nothing to disambiguate, and
 * no way to end up outside the country. Input that is not one of these eight
 * resolves to null and says so.
 *
 * The two groups mirror the country's real first-level division. The Distrito
 * Nacional is a single municipality; Santo Domingo province is divided into seven
 * (Boca Chica, Los Alcarrizos, Pedro Brand, San Antonio de Guerra, Santo Domingo
 * Este, Santo Domingo Norte, Santo Domingo Oeste). The province's eight municipal
 * districts (La Caleta, Pantoja, San Luis, La Victoria, La Cuaba, La Guáyiga, Hato
 * Viejo, Palmarejo-Villa Linda) are deliberately left out: none of them changes a
 * result at the distances this app searches. Adding one is one row.
 *
 * Coordinates come from the Spanish Wikipedia infoboxes, cross-checked against
 * the all-the-cities GeoNames dump — which carries Santo Domingo Oeste and Boca
 * Chica rounded to two decimals, and is missing Santo Domingo Norte, Los
 * Alcarrizos and Pedro Brand entirely. `adminCode` is GeoNames' admin1 code
 * (34 = Distrito Nacional, 37 = Santo Domingo province), kept so a listing can
 * still be attributed to a side of the metro area.
 */

export const DR_GROUPS = [
  { id: 'dn', label: 'Distrito Nacional' },
  { id: 'sd', label: 'Provincia Santo Domingo' },
] as const;

export type DrGroupId = (typeof DR_GROUPS)[number]['id'];

export interface DrPlace {
  /** Stable id, safe to put in a URL or a test fixture. */
  id: string;
  /** Canonical name. This is what travels as `location` on the API. */
  name: string;
  /** What the picker shows when the name alone would be ambiguous. Defaults to `name`. */
  label?: string;
  group: DrGroupId;
  latitude: number;
  longitude: number;
  /** GeoNames admin1 code for the province this sits in. */
  adminCode: string;
  /** Other spellings people actually type. */
  aliases: string[];
}

export const DR_PLACES: DrPlace[] = [
  {
    id: 'dn-santo-domingo',
    name: 'Santo Domingo',
    label: 'Santo Domingo (capital)',
    group: 'dn',
    latitude: 18.4719,
    longitude: -69.8923,
    adminCode: '34',
    aliases: ['distrito nacional', 'dn', 'capital', 'santo domingo de guzman', 'zona colonial'],
  },
  {
    id: 'sd-santo-domingo-este',
    name: 'Santo Domingo Este',
    group: 'sd',
    latitude: 18.4855,
    longitude: -69.87341,
    adminCode: '37',
    aliases: ['sde', 'este'],
  },
  {
    id: 'sd-santo-domingo-norte',
    name: 'Santo Domingo Norte',
    group: 'sd',
    latitude: 18.55,
    longitude: -69.9,
    adminCode: '37',
    aliases: ['sdn', 'norte', 'villa mella'],
  },
  {
    id: 'sd-santo-domingo-oeste',
    name: 'Santo Domingo Oeste',
    group: 'sd',
    latitude: 18.5,
    longitude: -70.0,
    adminCode: '37',
    aliases: ['sdo', 'oeste', 'herrera', 'manoguayabo'],
  },
  {
    id: 'sd-boca-chica',
    name: 'Boca Chica',
    group: 'sd',
    latitude: 18.45389,
    longitude: -69.60639,
    adminCode: '37',
    aliases: ['bocachica'],
  },
  {
    id: 'sd-los-alcarrizos',
    name: 'Los Alcarrizos',
    group: 'sd',
    latitude: 18.51667,
    longitude: -70.01667,
    adminCode: '37',
    aliases: ['alcarrizos'],
  },
  {
    id: 'sd-pedro-brand',
    name: 'Pedro Brand',
    group: 'sd',
    latitude: 18.56667,
    longitude: -70.09111,
    adminCode: '37',
    aliases: ['pedrobrand'],
  },
  {
    id: 'sd-san-antonio-de-guerra',
    name: 'San Antonio de Guerra',
    group: 'sd',
    latitude: 18.55,
    longitude: -69.7,
    adminCode: '37',
    aliases: ['guerra', 'san antonio'],
  },
];

/**
 * Greater Santo Domingo. Every place above must fall inside this box, and nothing
 * outside it may ever be returned — that invariant is what keeps a search in the
 * country, so test/dr-places.test.ts asserts it rather than trusting the table.
 */
export const DR_BOUNDS = { south: 17.5, north: 20.0, west: -72.1, east: -68.3 };

/** Lowercase, accent- and punctuation-insensitive, single-spaced. */
function keyify(value: string): string {
  return String(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Country qualifiers people append: "Santo Domingo, Dominican Republic" is the
 * default the form shipped with and is still in bookmarks and the README, so it
 * has to keep resolving to the capital rather than becoming an unknown place.
 */
const COUNTRY_TAIL = /\s*(\s|,)?(dominican republic|republica dominicana|rep dominicana|dominicana|rd|do)$/;

/** "Santo Domingo, Dominican Republic" -> "santo domingo". */
function stripCountry(value: string): string {
  let out = keyify(value);
  // Applied twice: "Santo Domingo Este, Republica Dominicana, RD" is unlikely but
  // cheap to survive, and a single pass over the raw string would leave one tail.
  for (let i = 0; i < 2; i += 1) out = out.replace(COUNTRY_TAIL, '').trim();
  return out;
}

/** The eight places, plus their aliases, as one flat lookup table. */
let index: Map<string, DrPlace> | null = null;

function buildIndex(): Map<string, DrPlace> {
  const idx = new Map<string, DrPlace>();
  for (const place of DR_PLACES) {
    for (const key of [place.name, ...place.aliases]) {
      const k = keyify(key);
      // First writer wins so a place cannot shadow another's alias silently.
      if (!idx.has(k)) idx.set(k, place);
    }
  }
  return idx;
}

/**
 * Resolve a place to coordinates, or null if it is not one of the eight.
 *
 * Deliberately exact: no fuzzy matching, no longest-prefix, no guessing. A wrong
 * guess here does not produce a bad label, it produces a search of the wrong
 * city, so an unrecognised name has to fail loudly instead.
 */
export function lookupDrPlace(query: string): (DrPlace & { latitude: number; longitude: number }) | null {
  if (!index) index = buildIndex();
  const key = stripCountry(query);
  if (!key) return null;
  return index.get(key) ?? null;
}

export interface DrPlaceGroup {
  id: DrGroupId;
  label: string;
  places: Array<{ id: string; name: string; label: string; latitude: number; longitude: number }>;
}

/** The picker's contents, in the order the UI should render them. */
export function listDrPlaces(): DrPlaceGroup[] {
  return DR_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    places: DR_PLACES.filter((p) => p.group === group.id).map((p) => ({
      id: p.id,
      name: p.name,
      label: p.label ?? p.name,
      latitude: p.latitude,
      longitude: p.longitude,
    })),
  }));
}
