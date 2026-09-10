import { describe, expect, it } from 'vitest';
import { BaseMarketplace } from '../src/marketplaces/base.js';
import type { SearchParams, SearchResult } from '../src/types.js';

/** parsePrice is protected, so reach it through a concrete subclass. */
class TestMarketplace extends BaseMarketplace {
  readonly name = 'test';
  readonly displayName = 'Test Marketplace';
  readonly requiresAuth = false;

  async search(_params: SearchParams): Promise<SearchResult> {
    return this.createError('not implemented');
  }

  price(input: string) {
    return this.parsePrice(input);
  }
}

const price = (input: string) => new TestMarketplace().price(input);

describe('parsePrice currency labels', () => {
  it.each([
    ['RD$1.190', 1190, 'DOP'],
    ['RD$14.500', 14500, 'DOP'],
    ['US$1.200', 1200, 'USD'],
    ['US$14.800', 14800, 'USD'],
    ['RD$ 6.500', 6500, 'DOP'],
    ['RD$0', 0, 'DOP'],
    ['DOP1.190', 1190, 'DOP'],
    // Three letters plus a symbol: the code wins over the symbol it carries.
    ['DOP$500', 500, 'DOP'],
  ])('reads the prefix of %s as a currency', (input, numeric, currency) => {
    expect(price(input)).toEqual({ numeric, currency });
  });

  it.each([
    ['1,200 DOP', 1200, 'DOP'],
    ['1.200 DOP', 1200, 'DOP'],
    ['1,200 USD', 1200, 'USD'],
    // An unknown code after the amount is reported as itself, not as dollars.
    ['1,200 EUR', 1200, 'EUR'],
  ])('reads the trailing code of %s as a currency', (input, numeric, currency) => {
    expect(price(input)).toEqual({ numeric, currency });
  });

  it('keeps the symbol of an unmapped two-letter prefix', () => {
    // "CA$" is not in the known-prefix table, so the label is reported literally.
    expect(price('CA$100')).toEqual({ numeric: 100, currency: 'CA$' });
  });

  it('reads the cents of a prefixed price', () => {
    expect(price('RD$1.190,50')).toEqual({ numeric: 1190.5, currency: 'DOP' });
  });
});

describe('parsePrice unchanged labels', () => {
  it.each([
    ['$100', 100, '$'],
    ['$1,234.56', 1234.56, '$'],
    ['$0', 0, '$'],
    ['€45', 45, '€'],
    ['£20.50', 20.5, '£'],
    ['€25,00', 25, '€'],
    ['DOP500', 500, 'DOP'],
    ['EUR45.00', 45, 'EUR'],
    // 120,00 is a comma decimal (120), not a thousands group (1200).
    ['BRL120,00', 120, 'BRL'],
    ['$ 40', 40, '$'],
    ['50', 50, '$'],
    // The first labelled amount still wins.
    ['was €80 now €30', 80, '€'],
  ])('still reads %s as %s', (input, numeric, currency) => {
    expect(price(input)).toEqual({ numeric, currency });
  });

  it.each(['Price not listed', 'Free', 'Make an offer', ''])(
    'returns null for %s',
    (input) => {
      expect(price(input)).toBeNull();
    },
  );
});

describe('parsePrice trailing code boundaries', () => {
  it('does not let a word after a labelled amount override the label', () => {
    // $100 OBO is read as dollars: the amount already carries a label, so the
    // uppercase word after it does not become a currency.
    expect(price('$100 OBO')).toEqual({ numeric: 100, currency: '$' });
  });

  it('reports an uppercase word after an unlabelled amount as the stated code', () => {
    // Nothing else labels "100", so the trailing word is reported as stated.
    // Consumers treat an unknown code as unconvertible (null) instead of
    // assuming USD, so the listing is skipped rather than mispriced.
    expect(price('100 OBO')).toEqual({ numeric: 100, currency: 'OBO' });
  });

  it('ignores a lowercase word after the amount', () => {
    expect(price('$100 usd')).toEqual({ numeric: 100, currency: '$' });
  });

  it('does not treat a lowercase prefix as a code', () => {
    // Out of contract: the frozen table lists RD$/US$/codes in upper case.
    expect(price('us$1.200')).toEqual({ numeric: 1200, currency: '$' });
  });
});
