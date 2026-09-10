/**
 * Shared types for the Secondhand MCP server
 */

export interface Listing {
  id: string;
  title: string;
  price: string;
  priceNumeric?: number;
  currency?: string;
  location?: string;
  description?: string;
  url: string;
  images?: string[];
  seller?: string;
  condition?: string;
  marketplace: string;
  scrapedAt: string;
  /**
   * Marketplace's own category for the listing, e.g. "Headphones" or "Cases,
   * Covers & Skins". More reliable than reading the title, because it is the
   * marketplace asserting what the thing is.
   */
  category?: string;
  categoryId?: string;
  /** eBay: how the item can be bought, e.g. FIXED_PRICE, AUCTION, BEST_OFFER. */
  buyingOptions?: string[];
  /** eBay auctions: bids so far. Present only when the item accepts bids. */
  bidCount?: number;
  /** eBay auctions: ISO end time of the bidding. */
  endsAt?: string;
  /**
   * True when the ONLY way to buy is bidding — priceNumeric is then the
   * current bid, which is not what the item will cost.
   */
  auctionOnly?: boolean;
}

export interface SearchParams {
  query: string;
  location?: string;
  maxPrice?: number;
  minPrice?: number;
  radius?: number; // in miles
  condition?: 'new' | 'like_new' | 'excellent' | 'good' | 'fair' | 'used' | 'any';
  limit?: number;
  offset?: number; // starting result offset for pagination (eBay)
  showSold?: boolean;
  /**
   * eBay buying format. 'fixed' excludes bidding entirely, 'auction' returns
   * only biddable items, 'any' (default) leaves eBay's own ranking alone.
   */
  buyingFormat?: 'any' | 'fixed' | 'auction';
  /**
   * eBay auctions only: restrict to bids closing within this many minutes. A
   * bid an hour from close is near its final value, so its price is usable;
   * one closing in five days is not.
   */
  endingWithinMinutes?: number;
  sort?: 'relevance' | 'newest' | 'price_low_to_high' | 'price_high_to_low' | 'most_popular';
  category?: string;
  brand?: string;
  department?: string;
  sizes?: string[];
  colors?: string[];
}

export interface SearchResult {
  marketplace: string;
  success: boolean;
  listings: Listing[];
  error?: string;
  totalFound?: number;
  note?: string;
}

export interface ListingDetails {
  id: string;
  description?: string;
  images: string[];
  location?: string;
  locationCoords?: { latitude: number; longitude: number };
  seller?: string;
  deliveryTypes?: string[];
  isShippingOffered?: boolean;
  url: string;
}

export interface MarketplaceConfig {
  enabled: boolean;
  requiresAuth?: boolean;
  authToken?: string;
}

export interface LocationCoordinates {
  latitude: number;
  longitude: number;
  name: string;
}
