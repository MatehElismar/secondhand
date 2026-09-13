import { describe, expect, it } from 'vitest';
import {
  DR_BOUNDS,
  DR_GROUPS,
  DR_PLACES,
  listDrPlaces,
  lookupDrPlace,
} from '../src/marketplaces/dr-places.js';

/**
 * Why this table is guarded this hard.
 *
 * The app searches Greater Santo Domingo. Before this list existed, "Santo Domingo,
 * Dominican Republic" — the value the form shipped with — was answered by Facebook's
 * own place search, which ranks by check-ins, with Santo Domingo, PARAGUAY
 * (-25.2797, -57.5829). Every default search looked at another continent and nothing
 * on screen said so. A closed list of eight places is what makes that impossible, so
 * "inside the country" is treated below as an invariant, not as a property of today's
 * numbers.
 */

/** The wrong answer this list exists to prevent. */
const PARAGUAY = { latitude: -25.27965526902, longitude: -57.582947820289 };

const inside = (p: { latitude: number; longitude: number }): boolean =>
  p.latitude >= DR_BOUNDS.south &&
  p.latitude <= DR_BOUNDS.north &&
  p.longitude >= DR_BOUNDS.west &&
  p.longitude <= DR_BOUNDS.east;

describe('the Greater Santo Domingo place list', () => {
  it('covers the Distrito Nacional and the seven municipalities of Santo Domingo province', () => {
    const names = (group: string) => DR_PLACES.filter((p) => p.group === group).map((p) => p.name);

    expect(names('dn')).toEqual(['Santo Domingo']);
    expect(names('sd')).toEqual([
      'Santo Domingo Este',
      'Santo Domingo Norte',
      'Santo Domingo Oeste',
      'Boca Chica',
      'Los Alcarrizos',
      'Pedro Brand',
      'San Antonio de Guerra',
    ]);
    expect(DR_PLACES).toHaveLength(8);
  });

  it('has a unique id and a unique name for every place', () => {
    for (const field of ['id', 'name'] as const) {
      const values = DR_PLACES.map((p) => p[field]);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it('assigns every place to a declared group', () => {
    const ids = DR_GROUPS.map((g) => g.id);
    for (const p of DR_PLACES) expect(ids).toContain(p.group);
  });

  it('keeps the GeoNames admin1 code of the province each place sits in', () => {
    expect(DR_PLACES.filter((p) => p.group === 'dn').map((p) => p.adminCode)).toEqual(['34']);
    for (const p of DR_PLACES.filter((x) => x.group === 'sd')) expect(p.adminCode).toBe('37');
  });

  it.each(DR_PLACES.map((p) => [p.name, p] as const))('%s sits inside the country', (_name, place) => {
    expect(inside(place)).toBe(true);
  });

  it('has bounds that exclude the Paraguay answer, so the invariant proves something', () => {
    expect(inside(PARAGUAY)).toBe(false);
  });
});

describe('lookupDrPlace', () => {
  it.each(DR_PLACES.map((p) => [p.name, p.id] as const))('resolves %j by its canonical name', (name, id) => {
    expect(lookupDrPlace(name)?.id).toBe(id);
  });

  it.each([
    ['distrito nacional', 'dn-santo-domingo'],
    ['DN', 'dn-santo-domingo'],
    ['santo domingo de guzman', 'dn-santo-domingo'],
    ['sde', 'sd-santo-domingo-este'],
    ['villa mella', 'sd-santo-domingo-norte'],
    ['herrera', 'sd-santo-domingo-oeste'],
    ['alcarrizos', 'sd-los-alcarrizos'],
    ['guerra', 'sd-san-antonio-de-guerra'],
    ['bocachica', 'sd-boca-chica'],
  ])('resolves the alias %j', (alias, id) => {
    expect(lookupDrPlace(alias)?.id).toBe(id);
  });

  // The form used to ship this exact string, and it is still in bookmarks and in the
  // README, so it has to keep resolving — to the Dominican capital this time.
  it.each([
    'Santo Domingo',
    'santo domingo',
    'SANTO DOMINGO',
    '  Santo Domingo  ',
    'Santo Domingo, Dominican Republic',
    'Santo Domingo, Republica Dominicana',
    'Santo Domingo, República Dominicana',
    'santo domingo, DO',
    'Santo Domingo, RD',
    'Santo Domingo, Rep. Dominicana',
  ])('resolves %j to the capital regardless of case or country suffix', (query) => {
    expect(lookupDrPlace(query)?.id).toBe('dn-santo-domingo');
  });

  it('resolves a municipality with or without the country suffix', () => {
    expect(lookupDrPlace('Santo Domingo Este')?.id).toBe('sd-santo-domingo-este');
    expect(lookupDrPlace('Santo Domingo Este, República Dominicana')?.id).toBe('sd-santo-domingo-este');
    expect(lookupDrPlace('Los Alcarrizos, Republica Dominicana')?.id).toBe('sd-los-alcarrizos');
  });

  it('never answers with the Paraguayan city that used to win', () => {
    const dr = lookupDrPlace('Santo Domingo, Dominican Republic');
    expect(dr).not.toBeNull();
    expect(inside(dr!)).toBe(true);
    expect(Math.abs(dr!.latitude - PARAGUAY.latitude)).toBeGreaterThan(10);
    expect(Math.abs(dr!.longitude - PARAGUAY.longitude)).toBeGreaterThan(10);
  });

  // A wrong guess here is not a bad label, it is a search of the wrong city, so an
  // unknown name has to fail loudly rather than fall back to something plausible.
  it.each([
    'Santo Domingo, Cuba',
    'Santiago',
    'Santiago de los Caballeros',
    'La Vega',
    'Higüey',
    'New York, NY',
    'Miami',
    'Santo Domingo Este, Cuba',
    '',
    '   ',
  ])('refuses %j instead of guessing', (query) => {
    expect(lookupDrPlace(query)).toBeNull();
  });

  it('does not let one place shadow another', () => {
    expect(lookupDrPlace('Santo Domingo')?.name).toBe('Santo Domingo');
    expect(lookupDrPlace('Santo Domingo Este')?.name).toBe('Santo Domingo Este');
    expect(lookupDrPlace('Santo Domingo Norte')?.name).toBe('Santo Domingo Norte');
    expect(lookupDrPlace('Santo Domingo Oeste')?.name).toBe('Santo Domingo Oeste');
  });
});

describe('listDrPlaces', () => {
  it('returns the two groups in the order the picker renders them', () => {
    expect(listDrPlaces().map((g) => g.id)).toEqual(['dn', 'sd']);
    expect(listDrPlaces().map((g) => g.label)).toEqual(['Distrito Nacional', 'Provincia Santo Domingo']);
  });

  it('gives every place a label to show, falling back to its name', () => {
    const flat = listDrPlaces().flatMap((g) => g.places);
    expect(flat).toHaveLength(8);
    for (const p of flat) expect(p.label.length).toBeGreaterThan(0);
    expect(flat.find((p) => p.id === 'dn-santo-domingo')?.label).toBe('Santo Domingo (capital)');
    expect(flat.find((p) => p.id === 'sd-boca-chica')?.label).toBe('Boca Chica');
  });

  it('ships coordinates so a client can show where it will search', () => {
    for (const group of listDrPlaces()) {
      for (const place of group.places) expect(inside(place)).toBe(true);
    }
  });
});
