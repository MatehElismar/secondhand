import { describe, expect, it } from 'vitest';
import { KM_PER_MILE, kmToMiles, milesToKm } from '../src/units.js';

describe('mile/kilometre conversion', () => {
  it('round-trips a radius without drifting', () => {
    for (const km of [1, 5, 25, 40, 100, 200]) {
      expect(kmToMiles(milesToKm(km))).toBeCloseTo(km, 10);
    }
  });

  // The UI is kilometre-native because the market is Dominican, so these are the
  // numbers a user actually types and what the marketplace is asked for.
  it.each([
    [40, 24.85],
    [25, 15.53],
    [10, 6.21],
    [1, 0.62],
  ])('converts %i km to about %f miles', (km, miles) => {
    expect(kmToMiles(km)).toBeCloseTo(miles, 2);
    expect(kmToMiles(km)! * KM_PER_MILE).toBeCloseTo(km, 10);
  });

  // Undefined lets `kmToMiles(x) ?? legacyMiles` fall back instead of sending NaN.
  it.each([[undefined], [null], [0], [-5], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'returns undefined for %j so a fallback can take over',
    (input) => {
      expect(kmToMiles(input as number | null | undefined)).toBeUndefined();
    }
  );

  it('keeps the default search area unchanged now that the UI speaks kilometres', () => {
    // The form used to default to 25 miles; 40 km is the same area, which is why it
    // is the new default rather than 25.
    expect(kmToMiles(40)!).toBeCloseTo(25, 0);
  });
});
