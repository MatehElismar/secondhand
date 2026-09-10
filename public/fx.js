/* Secondhand Arbitrage — FX helpers for the browser.
 *
 * This lives in its own file, loaded as a classic script before public/app.js,
 * because app.js and src/arbitrage.ts used to hold two independent copies of the
 * same rate — and they disagreed about what "$" meant. A peso listing labelled
 * "$" was read as dollars by the server and multiplied by 60 by the browser, so
 * the same data was wrong in both directions at once.
 *
 * test/arbitrage-conversion.test.ts drives this file and src/arbitrage.ts from a
 * single table: the two copies cannot drift apart again. Do not add a third copy
 * of the rate here or anywhere else.
 */
(function (root) {
  'use strict';

  const FX_DOP_PER_USD = 60; // heuristic; adjust to current rate

  /**
   * Listing -> DOP. Mirror of `toUsd` in src/arbitrage.ts, so the two must agree
   * on the contract: `USD` and `$` are dollars, `DOP` is already pesos, and a
   * currency we hold no rate for returns null so the caller skips the listing
   * instead of charting a price we invented.
   */
  const toDOP = (l) => {
    if (typeof l?.priceNumeric !== 'number') return null;
    const c = String(l.currency || '').toUpperCase();
    if (c === 'USD' || c === '$') return l.priceNumeric * FX_DOP_PER_USD;
    if (c === 'DOP') return l.priceNumeric;
    // No known rate: the caller skips the listing. Returning the number here
    // would chart a peso figure as dollars, which is the 60x error itself.
    return null;
  };

  root.SecondhandFX = { FX_DOP_PER_USD, toDOP };
})(typeof globalThis !== 'undefined' ? globalThis : this);
