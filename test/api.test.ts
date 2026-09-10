import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApiServer } from '../src/api.js';
import type { Listing, ListingDetails, SearchParams, SearchResult } from '../src/types.js';

// A controllable fake marketplace so tests never hit the network.
const h = vi.hoisted(() => {
  const state = {
    list: [] as Listing[],
    searchResult: null as SearchResult | null,
    location: null as { latitude: number; longitude: number; name: string } | null,
    detail: null as ListingDetails | null,
    searchCalls: [] as SearchParams[],
  };
  return state;
});

vi.mock('../src/marketplaces/index.js', () => {
  const facebook: any = {
    name: 'facebook',
    displayName: 'Facebook Marketplace',
    requiresAuth: false,
    async search(params: SearchParams) {
      h.searchCalls.push(params);
      if (h.searchResult) return h.searchResult;
      return { marketplace: 'facebook', success: true, listings: h.list };
    },
    async getLocation(q: string) {
      return h.location;
    },
    async getListingDetails(id: string) {
      if (h.detail) return h.detail;
      throw new Error('gone');
    },
  };
  const ebay: any = {
    name: 'ebay',
    displayName: 'eBay',
    requiresAuth: true,
    async search(params: SearchParams) {
      h.searchCalls.push(params);
      return { marketplace: 'ebay', success: true, listings: [], note: 'national' };
    },
  };
  return {
    initializeMarketplaces: () => {},
    getMarketplace: (name: string) => (name === 'facebook' ? facebook : name === 'ebay' ? ebay : undefined),
    getAllMarketplaces: () => [facebook, ebay],
    registerMarketplace: () => {},
    listMarketplaceNames: () => ['facebook', 'ebay'],
  };
});

const listing = (over: Partial<Listing> = {}): Listing => ({
  id: 'l1',
  title: 'Blue Chair',
  price: '$50',
  priceNumeric: 50,
  url: 'https://example.com/l1',
  marketplace: 'facebook',
  scrapedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  h.list = [];
  h.searchResult = null;
  h.location = null;
  h.detail = null;
  h.searchCalls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

const app = await buildApiServer();

describe('Swagger docs', () => {
  it('serves the raw OpenAPI document at /docs/json', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toBe('3.0.3');
    expect(doc.info.title).toBe('Secondhand MCP REST API');
    const paths = Object.keys(doc.paths);
    expect(paths).toEqual(
      expect.arrayContaining(['/health', '/v1/locations/resolve', '/v1/search', '/v1/listings/{marketplace}/{id}']),
    );
  });

  it('renders the Swagger UI page at /docs', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });
});

describe('GET /health', () => {
  it('reports ok and the enabled marketplaces', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'ok',
      server: 'secondhand-mcp',
    });
    expect(res.json().marketplaces).toHaveLength(2);
  });
});

describe('GET /v1/locations/resolve', () => {
  it('resolves coordinates for a facebook location', async () => {
    h.location = { latitude: 18.4727, longitude: -69.8946, name: 'Ciudad' };
    const res = await app.inject({
      method: 'GET',
      url: '/v1/locations/resolve?marketplace=facebook&location=Santo%20Domingo%2C%20Dominican%20Republic',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      input: 'Santo Domingo, Dominican Republic',
      name: 'Ciudad',
      latitude: 18.4727,
      longitude: -69.8946,
    });
  });

  it('returns 400 when location is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/locations/resolve?marketplace=facebook' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for an unknown marketplace', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/locations/resolve?marketplace=etsy&location=nyc' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('etsy');
  });

  it('returns 404 when the location cannot be resolved', async () => {
    h.location = null;
    const res = await app.inject({
      method: 'GET',
      url: '/v1/locations/resolve?marketplace=facebook&location=atlantis',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().found).toBe(false);
  });

  it('returns 501 for a marketplace without location support', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/locations/resolve?marketplace=ebay&location=nyc',
    });
    expect(res.statusCode).toBe(501);
  });
});

describe('POST /v1/search', () => {
  it('requires a query', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/search',
      payload: { marketplace: 'facebook' },
    });
    expect(res.statusCode).toBe(400);
    expect(h.searchCalls).toEqual([]);
  });

  it('rejects a negative price bound', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/search',
      payload: { marketplace: 'facebook', query: 'chair', minPrice: -5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for an unknown marketplace', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/search',
      payload: { marketplace: 'etsy', query: 'chair' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('passes the params through to the marketplace and wraps the result', async () => {
    h.list = [listing({ id: 'a', title: 'Chair', priceNumeric: 30 })];
    h.location = { latitude: 18.47, longitude: -69.89, name: 'Ciudad' };
    const res = await app.inject({
      method: 'POST',
      url: '/v1/search',
      payload: {
        marketplace: 'facebook',
        query: 'chair',
        location: 'Santo Domingo',
        radiusMiles: 25,
        minPrice: 10,
        maxPrice: 100,
        limit: 5,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(h.searchCalls).toEqual([
      {
        query: 'chair',
        location: 'Santo Domingo',
        maxPrice: 100,
        minPrice: 10,
        radius: 25,
        limit: 5,
      },
    ]);
    expect(body.search).toEqual({
      marketplace: 'facebook',
      query: 'chair',
      location: { input: 'Santo Domingo', name: 'Ciudad', latitude: 18.47, longitude: -69.89 },
      radiusMiles: 25,
      minPrice: 10,
      maxPrice: 100,
    });
    expect(body.success).toBe(true);
    expect(body.marketplace).toBe('facebook');
    expect(body.listings).toHaveLength(1);
    expect(body.listings[0].title).toBe('Chair');
  });

  it('uses radius when radiusMiles is absent', async () => {
    h.searchResult = { marketplace: 'facebook', success: true, listings: [] };
    await app.inject({
      method: 'POST',
      url: '/v1/search',
      payload: { marketplace: 'facebook', query: 'chair', radius: 50 },
    });
    expect(h.searchCalls[0].radius).toBe(50);
  });

  it('surfaces a marketplace-reported error without a 5xx', async () => {
    h.searchResult = { marketplace: 'facebook', success: false, listings: [], error: 'rate limited' };
    const res = await app.inject({
      method: 'POST',
      url: '/v1/search',
      payload: { marketplace: 'facebook', query: 'chair' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.listings).toEqual([]);
    expect(body.error).toBe('rate limited');
  });

  it('propagates the eBay note for a national search', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/search',
      payload: { marketplace: 'ebay', query: 'chair' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().note).toBe('national');
    // eBay has no location support, so location stays a plain input echo.
    expect(res.json().search.location).toBeUndefined();
  });

  it('attaches a fuzzy modelGroup key shared by low-confidence twins', async () => {
    h.list = [
      listing({ id: 'a', title: 'Wooden Vintage Chair', priceNumeric: 100 }),
      listing({ id: 'b', title: 'Vintage Wooden Chair', priceNumeric: 120 }),
      listing({ id: 'c', title: 'Apple iPhone 15 Pro 256GB', priceNumeric: 700 }),
    ];
    const res = await app.inject({
      method: 'POST',
      url: '/v1/search',
      payload: { marketplace: 'facebook', query: 'chair' },
    });
    expect(res.statusCode).toBe(200);
    const byId = Object.fromEntries(res.json().listings.map((l: any) => [l.id, l]));
    // Word-reordered low keys land in the same group (canonical wins by
    // lexicographic tie-break here), while the high key never remaps.
    expect(byId.a.model).toBe('Wooden Vintage Chair');
    expect(byId.a.modelGroup).toBe('Vintage Wooden Chair');
    expect(byId.b.modelGroup).toBe('Vintage Wooden Chair');
    expect(byId.c.modelGroup).toBe('iPhone 15 Pro 256GB');
    expect(byId.c.modelGroup).toBe(byId.c.model);
  });
});

describe('POST /v1/arbitrage', () => {
  const item = (title: string, priceNumeric: number, currency = 'DOP') => ({
    id: Math.random().toString(36).slice(2),
    title,
    price: `${currency}${priceNumeric}`,
    priceNumeric,
    currency,
    url: 'https://example.com/' + Math.random().toString(36).slice(2),
    marketplace: 'facebook',
    scrapedAt: '2026-01-01T00:00:00.000Z',
  });

  it('groups, filters by min matches, selects top N and computes comparison', async () => {
    h.list = [
      // 4 x iPhone 15 (eligible), 3 x iPad Air (eligible), 2 x iPad Pro (excluded)
      ...Array.from({ length: 4 }, () => item('iPhone 15 128GB azul', 25000)),
      ...Array.from({ length: 3 }, () => item('iPad Air 4 64GB', 24000)),
      ...Array.from({ length: 2 }, () => item('iPad Pro 11 128GB', 30000)),
    ];
    const res = await app.inject({
      method: 'POST',
      url: '/v1/arbitrage',
      payload: { marketplace: 'facebook', query: 'iphone', topN: 3, minMatches: 3 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.primaryMarket).toBe('facebook');
    expect(body.secondaryMarket).toBe('ebay');
    expect(body.totals.listingsCount).toBe(9);
    // Only iPhone 15 (4) and iPad Air (3) qualify (iPad Pro has 2).
    expect(body.selected.map((s: any) => s.key)).toEqual(['iPhone 15 128GB', 'iPad Air 4 64GB']);
    // eBay is a stub that returns no listings → delta null, handled gracefully.
    expect(body.selected[0].secondary.error).toBeUndefined();
    expect(body.selected[0].comparison.deltaUsd).toBe(null);
    // Prices normalized to USD (25000 DOP / 60 ≈ 417).
    expect(body.selected[0].primary.median).toBe(Math.round(25000 / 60));
  });

  it('returns 400 without a query', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/arbitrage', payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/listings/:marketplace/:id', () => {
  it('returns the normalized listing details', async () => {
    h.detail = {
      id: 'l1',
      description: 'Solid oak desk',
      images: ['https://cdn/1.jpg'],
      location: 'Austin, TX',
      seller: 'woodshop',
      url: 'https://fb/l1',
    };
    const res = await app.inject({ method: 'GET', url: '/v1/listings/facebook/l1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      marketplace: 'facebook',
      id: 'l1',
      description: 'Solid oak desk',
      seller: 'woodshop',
    });
  });

  it('returns 501 for a marketplace without details support', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/listings/ebay/l1' });
    expect(res.statusCode).toBe(501);
  });

  it('returns 404 for an unknown marketplace', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/listings/etsy/l1' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when adapter throws (removed listing)', async () => {
    h.detail = null;
    const res = await app.inject({ method: 'GET', url: '/v1/listings/facebook/l1' });
    expect(res.statusCode).toBe(404);
  });
});
