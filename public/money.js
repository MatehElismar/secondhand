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

  const DOP = forCurrency('DOP');
  const USD = forCurrency('USD');

  /**
   * A listing's price, formatted in the currency it declares.
   *
   * The cards used to print the seller's raw string, which used a dot for thousands
   * ("RD$20.000") while the summary table formatted the same amount with a comma. Once
   * both sides name the currency, that difference is the only thing left disagreeing, so
   * the card is formatted too. A listing whose currency cannot be mapped keeps the
   * seller's string: readCurrency in src/marketplaces/base.ts reports an unrecognised
   * symbol rather than guessing and fx.js drops those listings, so inventing one here
   * would disagree with every other figure on the page.
   *
   * A bare "$" is the ambiguous case, and fx.js reads it as dollars. This has to agree,
   * or a card and the table beside it would describe one listing in two currencies.
   */
  const label = (listing) => {
    const value = listing?.priceNumeric;
    const raw = listing?.price;
    if (typeof value !== 'number' || !Number.isFinite(value)) return String(raw ?? '');
    const code = String(listing?.currency ?? '').toUpperCase();
    if (code === 'DOP' || code === 'RD$') return DOP.format(value);
    if (code === 'USD' || code === 'US$' || code === '$') return USD.format(value);
    return String(raw ?? value);
  };

  root.SecondhandMoney = { DOP, USD, label };
})(typeof globalThis !== 'undefined' ? globalThis : this);
