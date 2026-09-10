/**
 * Base interface for all marketplace implementations
 */

import { SearchParams, SearchResult, LocationCoordinates } from '../types.js';

export interface Marketplace {
  /** Unique identifier for this marketplace */
  readonly name: string;
  
  /** Human-readable display name */
  readonly displayName: string;
  
  /** Whether this marketplace requires authentication */
  readonly requiresAuth: boolean;
  
  /** Search for listings */
  search(params: SearchParams): Promise<SearchResult>;
  
  /** Get location coordinates for a city/area (if supported) */
  getLocation?(query: string): Promise<LocationCoordinates | null>;
  
  /** Check if the marketplace is accessible */
  healthCheck(): Promise<boolean>;
}

// A currency label in front of the amount, a bare symbol, or a three-letter code
// after it: "RD$1.190", "US$1.200", "DOP500", "€45", "1,200 DOP". Matching any
// code rather than a list means a marketplace in a currency we have not seen
// still reports it correctly instead of silently claiming dollars. Letters in
// front of a symbol stay attached to it, so an unmapped prefix is still
// recognisable ("CA$100" reports "CA$").
const PRICE_PATTERN =
  /(?:([A-Z]{2,3})([£€$])(?=\s*\d)|([A-Z]{3})(?=\s*\d)|([£€$]))?\s*(\d[\d.,]*)(?:\s*([A-Z]{3}))?/;

// A two-letter prefix is not an ISO code, so the pair only becomes a currency
// when we know it. Report, do not guess: an unlisted pair comes back as the
// literal label the listing used.
const PREFIX_CURRENCIES: Record<string, string> = {
  RD: 'DOP',
  US: 'USD',
};

/**
 * The label the listing itself states. A bare `$` stays deliberately ambiguous
 * rather than being upgraded to USD, because the amount alone cannot tell us.
 */
function readCurrency(match: RegExpMatchArray): string {
  if (match[1]) {
    // "RD$"/"US$": the two letters are not an ISO code on their own, so an
    // unmapped pair keeps the symbol it carries. Three letters are a code.
    if (match[1].length === 3) return match[1];
    return PREFIX_CURRENCIES[match[1]] ?? `${match[1]}${match[2]}`;
  }
  // A stated label in front of the amount wins over a code after it: a seller
  // who writes "$" or "£" has already labelled the amount.
  if (match[3]) return match[3];
  if (match[4]) return match[4];
  if (match[6]) return match[6];
  return '$';
}

/**
 * Rightmost separator wins when both appear ("1,234.56", "1.234,56"). With only
 * one kind, three-digit runs mean grouping ("1,234,567") and anything else is a
 * decimal ("89,00").
 */
function parseAmount(raw: string): number {
  const digits = raw.replace(/[.,]+$/, '');
  const sepIndex = Math.max(digits.lastIndexOf(','), digits.lastIndexOf('.'));
  if (sepIndex === -1) return parseFloat(digits);

  const separator = digits[sepIndex];
  const plain = digits.replace(/[.,]/g, '');

  if (!digits.includes(separator === ',' ? '.' : ',')) {
    const parts = digits.split(separator);
    const grouped = parts.slice(1).every((p) => p.length === 3) && parts[0].length <= 3;
    if (grouped) return parseFloat(plain);
  }

  const decimals = digits.length - sepIndex - 1;
  return parseFloat(`${plain.slice(0, plain.length - decimals)}.${plain.slice(plain.length - decimals)}`);
}

export abstract class BaseMarketplace implements Marketplace {
  abstract readonly name: string;
  abstract readonly displayName: string;
  abstract readonly requiresAuth: boolean;
  
  abstract search(params: SearchParams): Promise<SearchResult>;
  
  async healthCheck(): Promise<boolean> {
    return true;
  }
  
  protected parsePrice(priceStr: string): { numeric: number; currency: string } | null {
    const match = priceStr.match(PRICE_PATTERN);
    if (!match) return null;

    const numeric = parseAmount(match[5]);
    if (Number.isNaN(numeric)) return null;

    return { numeric, currency: readCurrency(match) };
  }

  protected createError(message: string): SearchResult {
    return {
      marketplace: this.name,
      success: false,
      listings: [],
      error: message
    };
  }
}
