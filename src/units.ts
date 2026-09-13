/**
 * One mile-to-kilometre conversion for the whole project.
 *
 * Facebook's marketplace search takes its radius in kilometres (`filter_radius_km`,
 * see src/marketplaces/facebook.ts) while SearchParams carries miles, so the number
 * crosses the unit boundary twice on every request. It used to exist only as a local
 * `KM_PER_MILE` inside facebook.ts; it lives here because the public API now also
 * accepts a kilometre radius, and two copies of a rate is precisely how public/fx.js
 * and src/arbitrage.ts drifted apart over the DOP/USD rate. Do not add a second copy.
 */

export const KM_PER_MILE = 1.609344;

export const milesToKm = (miles: number): number => miles * KM_PER_MILE;

/**
 * Kilometres to miles, or undefined when there is nothing usable to convert.
 *
 * Returning undefined for zero, negatives, NaN and null is what lets a caller write
 * `kmToMiles(radiusKm) ?? optNum(radiusMiles)` and have the fallback actually apply
 * instead of propagating a NaN radius into the marketplace request.
 */
export function kmToMiles(km: number | null | undefined): number | undefined {
  if (km == null || !Number.isFinite(km) || km <= 0) return undefined;
  return km / KM_PER_MILE;
}
