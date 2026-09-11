/* Secondhand Arbitrage — currency formatting for the browser.
 *
 * Its own file, loaded as a classic script before public/app.js, for the same reason
 * public/fx.js and public/params.js are: app.js wires up DOMContentLoaded at import
 * time and cannot be imported by the node test environment, so anything worth asserting
 * has to live somewhere a test can reach. test/money.test.ts imports this exact file.
 *
 * What it fixes: every money formatter in app.js hard-coded a bare "$", so the peso
 * summary and the dollar arbitrage panel printed what looked like the same unit. The
 * peso case was worse than cosmetic — a listing priced in dollars is multiplied by the
 * DOP rate on the way in, so a US$100 item reached the peso table as 6,000 and printed
 * as "$6,000": a hundred dollars reading as six thousand.
 *
 * Naming the currency is the whole fix. Intl also keeps the separators consistent with
 * the locale instead of pinning en-US, which happened to agree on Dominican grouping
 * and still got the symbol wrong.
 */
(function (root) {
  'use strict';

  /**
   * CLDR es-DO groups with "," and separates decimals with "." — the same convention as
   * en-US, and the opposite of es-ES and es-AR. That is why the old `toLocaleString('en-US')`
   * looked right while it was lying: correct digits, wrong currency.
   *
   * Whole units only. Marketplace asking prices are round numbers and centavos in the
   * middle of a median are noise, so nothing here should ever show `.00`.
   */
  const forCurrency = (currency) =>
    new Intl.NumberFormat('es-DO', { style: 'currency', currency, maximumFractionDigits: 0 });

  root.SecondhandMoney = { DOP: forCurrency('DOP'), USD: forCurrency('USD') };
})(typeof globalThis !== 'undefined' ? globalThis : this);
