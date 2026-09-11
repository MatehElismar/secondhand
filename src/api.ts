/**
 * Secondhand REST API
 *
 * A lightweight HTTP front-end over the existing marketplace abstraction.
 * It deliberately talks to the same Marketplace registry that the MCP server
 * uses — it never re-implements scraping or search logic.
 *
 *   REST API  ->  Marketplace abstraction  ->  Facebook / eBay / Depop / Poshmark
 *   MCP       ->  Marketplace abstraction  ->  Facebook / eBay / Depop / Poshmark
 *
 * Endpoints:
 *   GET  /health
 *   GET  /v1/locations/resolve?marketplace=<m>&location=<query>
 *   POST /v1/search
 *   GET  /v1/listings/:marketplace/:id
 *
 * Interactive docs (Swagger UI) are served at /docs, and the raw OpenAPI
 * document at /docs/json.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastify, { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fastifyStatic from '@fastify/static';
import {
  initializeMarketplaces,
  getMarketplace,
  getAllMarketplaces,
} from './marketplaces/index.js';
import { runArbitrage } from './arbitrage.js';
import { isAccessoryListing, modelFamily, parseModel } from './models.js';
import { clusterKeys } from './fuzzy.js';
import { classifyQueryRelevance, resolveQueryFamily, NOT_APPLICABLE } from './relevance.js';
import type { QueryRelevance } from './relevance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { SearchParams, Listing, ListingDetails, LocationCoordinates } from './types.js';

const DEFAULT_PORT = 3000;

export interface ResolvedLocation {
  input: string;
  name?: string;
  latitude?: number;
  longitude?: number;
}

// ── Shared JSON Schema shapes (reused across route schemas) ─────────────

const listingProps: Record<string, unknown> = {
  id: { type: 'string' },
  title: { type: 'string' },
  price: { type: 'string' },
  priceNumeric: { type: 'number' },
  currency: { type: 'string' },
  location: { type: 'string' },
  description: { type: 'string' },
  url: { type: 'string' },
  images: { type: 'array', items: { type: 'string' } },
  seller: { type: 'string' },
  condition: { type: 'string' },
  marketplace: { type: 'string' },
  scrapedAt: { type: 'string' },
  // eBay buying format. Undeclared properties are stripped on serialization,
  // so anything a client needs to see has to be listed here.
  buyingOptions: { type: 'array', items: { type: 'string' } },
  bidCount: { type: 'number' },
  endsAt: { type: 'string' },
  auctionOnly: { type: 'boolean' },
  category: { type: 'string' },
  categoryId: { type: 'string' },
  // Canonical model, resolved server-side. The browser used to re-implement
  // this and the two copies had already drifted apart.
  model: { type: 'string' },
  modelFamily: { type: 'string' },
  // The grouping key for the per-model summary: identical to `model` except
  // that low-confidence keys are fuzzy-merged with their near-twins, so the
  // browser renders one row per vague product instead of one per phrasing.
  modelGroup: { type: 'string' },
  isAccessory: { type: 'boolean' },
  // Server-side query-relevance decision (Unit 3): the browser consumes this
  // and never re-implements the classifier. Absent fields are omitted.
  queryRelevance: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['matched', 'ambiguous', 'mismatch'] },
      reason: {
        type: 'string',
        enum: [
          'matched',
          'typo-matched',
          'missing-product-anchor',
          'competing-family',
          'ambiguous-title',
          'accessory',
        ],
      },
      family: { type: 'string' },
      productKind: { type: 'string' },
      distance: { type: 'number' },
    },
  },
};

const resolvedLocationProps: Record<string, unknown> = {
  input: { type: 'string' },
  name: { type: 'string' },
  latitude: { type: 'number' },
  longitude: { type: 'number' },
};

const listingDetailProps: Record<string, unknown> = {
  id: { type: 'string' },
  description: { type: 'string' },
  images: { type: 'array', items: { type: 'string' } },
  location: { type: 'string' },
  locationCoords: {
    type: 'object',
    properties: { latitude: { type: 'number' }, longitude: { type: 'number' } },
  },
  seller: { type: 'string' },
  deliveryTypes: { type: 'array', items: { type: 'string' } },
  isShippingOffered: { type: 'boolean' },
  url: { type: 'string' },
};

const marketplaceId = {
  type: 'string',
  description: 'Marketplace id. Valid values: facebook, ebay, depop, poshmark',
};

/**
 * Build the Fastify application with every route registered. Marketplaces are
 * initialized here so the API sees exactly the adapters MCP would.
 */
export async function buildApiServer(): Promise<FastifyInstance> {
  initializeMarketplaces();

  const app = fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Secondhand MCP REST API',
        description:
          'Self-hosted HTTP front-end over the marketplace abstraction. Searches ' +
          'Facebook Marketplace, eBay, Depop and Poshmark through the same registry the ' +
          'MCP server uses. Interactive docs below; raw spec at /docs/json.',
        version: '1.0.0',
      },
      tags: [
        { name: 'health', description: 'Service and marketplace status' },
        { name: 'locations', description: 'Resolve place names to coordinates' },
        { name: 'search', description: 'Search live listings on a marketplace' },
        { name: 'listings', description: 'Fetch full details for one listing' },
        { name: 'arbitrage', description: 'Cross-market price comparison + profit estimate' },
      ],
    },
  });

  // Serve the web UI (use-case tooling) from /public at the site root.
  await app.register(fastifyStatic, {
    root: path.join(__dirname, '..', 'public'),
    prefix: '/',
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
    // No `upgrade-insecure-requests`: it forces browsers to fetch assets over
    // HTTPS, which a plain-HTTP server can't answer. Serving HTTP locally, the
    // Swagger UI + spec load fine without it.
    staticCSP: [
      "default-src 'self'",
      "base-uri 'self'",
      "font-src 'self' https: data:",
      "img-src 'self' data: validator.swagger.io",
      "object-src 'none'",
      "script-src 'self'",
      "script-src-attr 'none'",
      "style-src 'self' https:",
      "frame-ancestors 'self'",
    ].join('; '),
  });

  // ── Health ───────────────────────────────────────────────────────────
  app.get(
    '/health',
    {
      schema: {
        tags: ['health'],
        summary: 'Service health',
        description: 'Reports that the API is up and lists the marketplaces currently registered (eBay/Depop/Poshmark may be absent if their credentials/browser are unavailable).',
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              server: { type: 'string' },
              marketplaces: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    displayName: { type: 'string' },
                    requiresAuth: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async () => {
      return {
        status: 'ok',
        server: 'secondhand-mcp',
        marketplaces: getAllMarketplaces().map((m) => ({
          name: m.name,
          displayName: m.displayName,
          requiresAuth: m.requiresAuth,
        })),
      };
    }
  );

  // ── Location resolution ──────────────────────────────────────────────
  app.get<{ Querystring: { marketplace?: string; location?: string } }>(
    '/v1/locations/resolve',
    {
      schema: {
        tags: ['locations'],
        summary: 'Resolve a place name to coordinates',
        description:
          "Asks a marketplace to resolve a human-readable place to latitude/longitude. For Facebook the server reads Facebook's own location search (it is not hard-coded); the input and resolved name/coords are returned token-for-token.",
        querystring: {
          type: 'object',
          required: ['location'],
          properties: {
            marketplace: { ...marketplaceId, default: 'facebook' },
            location: { type: 'string', description: 'Place to resolve, e.g. "Santo Domingo, Dominican Republic"' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: resolvedLocationProps,
          },
          400: { type: 'object', properties: { error: { type: 'string' } } },
          404: {
            type: 'object',
            properties: {
              input: { type: 'string' },
              found: { type: 'boolean' },
              error: { type: 'string' },
            },
          },
          501: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      const { marketplace = 'facebook', location } = request.query;

      if (!location) {
        return reply.code(400).send({ error: 'Missing required query parameter: location' });
      }

      const mp = getMarketplace(marketplace);
      if (!mp) {
        return reply.code(404).send({
          error: `Unknown marketplace: ${marketplace}. Available: ${getAllMarketplaces().map((m) => m.name).join(', ')}`,
        });
      }

      if (typeof mp.getLocation !== 'function') {
        return reply.code(501).send({
          error: `Marketplace "${mp.name}" does not support location resolution`,
        });
      }

      try {
        const coords = await mp.getLocation(location);
        if (!coords) {
          return reply.code(404).send({
            input: location,
            found: false,
            error: `Could not resolve location "${location}" for ${mp.name}`,
          });
        }
        return resolveBody(location, coords);
      } catch (error) {
        return reply.code(502).send({
          input: location,
          error: `Location resolution for ${mp.name} failed: ${error}`,
        });
      }
    }
  );

  // ── Search ───────────────────────────────────────────────────────────
  app.post<{ Body: Record<string, unknown> }>(
    '/v1/search',
    {
      schema: {
        tags: ['search'],
        summary: 'Search live listings on a marketplace',
        description:
          'Searches a marketplace using the requested query and filters. The response includes the resolved search location (the coordinates the adapter actually searched with) alongside the normalized listings. minPrice/maxPrice are applied by the target marketplace in its own currency.',
        body: {
          type: 'object',
          required: ['query'],
          properties: {
            marketplace: { ...marketplaceId, default: 'facebook' },
            query: { type: 'string', description: 'Search terms, e.g. "iphone 15"' },
            location: { type: 'string', description: 'Place to search around (Facebook only)' },
            radius: { type: 'number', description: 'Search radius in miles (alias; Facebook only)' },
            radiusMiles: { type: 'number', description: 'Search radius in miles (Facebook only)' },
            minPrice: { type: 'number', minimum: 0 },
            maxPrice: { type: 'number', minimum: 0 },
            limit: { type: 'number', minimum: 1 },
            offset: { type: 'number', minimum: 0 },
            showSold: { type: 'boolean' },
            buyingFormat: {
              type: 'string',
              enum: ['any', 'fixed', 'auction'],
              description:
                "eBay buying format: 'fixed' excludes bidding, 'auction' returns only biddable items (price shown is the current bid), 'any' leaves eBay's ranking alone.",
            },
            endingWithinMinutes: {
              type: 'number',
              minimum: 1,
              description:
                'With buyingFormat=auction: only bids closing within this many minutes. Near close the current bid approximates the final price.',
            },
            sort: { type: 'string', description: 'Sort order (Depop, Poshmark)' },
            condition: { type: 'string' },
            category: { type: 'string' },
            brand: { type: 'string' },
            department: { type: 'string' },
            sizes: { type: 'array', items: { type: 'string' } },
            colors: { type: 'array', items: { type: 'string' } },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              search: {
                type: 'object',
                properties: {
                  marketplace: { type: 'string' },
                  query: { type: 'string' },
                  location: { type: 'object', properties: resolvedLocationProps },
                  radiusMiles: { type: 'number' },
                  minPrice: { type: ['number', 'null'] },
                  maxPrice: { type: ['number', 'null'] },
                },
              },
              success: { type: 'boolean' },
              marketplace: { type: 'string' },
              listings: {
                type: 'array',
                items: { type: 'object', properties: listingProps },
              },
              totalFound: { type: 'number' },
              // Aggregate relevance counters for the resolved query family
              // (currently google-pixel). Present only when the query resolved
              // to a supported family; unsupported queries mark every listing
              // queryRelevance = not-applicable and keep the legacy pipeline.
              relevance: {
                type: 'object',
                properties: {
                  raw: { type: 'number' },
                  matched: { type: 'number' },
                  excluded: { type: 'number' },
                  reasons: {
                    type: 'object',
                    properties: {
                      mismatch: { type: 'number' },
                      ambiguous: { type: 'number' },
                      accessory: { type: 'number' },
                    },
                  },
                },
              },
              note: { type: 'string' },
              error: { type: 'string' },
            },
          },
          400: { type: 'object', properties: { error: { type: 'string' } } },
          404: { type: 'object', properties: { error: { type: 'string' } } },
          502: {
            type: 'object',
            properties: {
              search: { type: 'object' },
              success: { type: 'boolean' },
              listings: { type: 'array' },
              error: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const {
        marketplace = 'facebook',
        query,
        location,
        radius,
        radiusMiles,
        minPrice,
        maxPrice,
        limit,
        offset,
        showSold,
        buyingFormat,
        endingWithinMinutes,
        sort,
        condition,
        category,
        brand,
        department,
        sizes,
        colors,
      } = request.body as bodyShape;

      if (!query || typeof query !== 'string') {
        return reply.code(400).send({ error: 'Missing required parameter: query' });
      }
      if (rangeInvalid(minPrice) || rangeInvalid(maxPrice)) {
        return reply.code(400).send({
          error: 'minPrice and maxPrice must be non-negative numbers when provided',
        });
      }

      const mp = getMarketplace(marketplace);
      if (!mp) {
        return reply.code(404).send({
          error: `Unknown marketplace: ${marketplace}. Available: ${getAllMarketplaces().map((m) => m.name).join(', ')}`,
        });
      }

      const params: SearchParams = {
        query,
        location,
        maxPrice: optNum(maxPrice),
        minPrice: optNum(minPrice),
        // Accept both `radius` (SearchParams) and `radiusMiles` (public API name).
        radius: optNum(radiusMiles) ?? optNum(radius),
        limit: optNum(limit),
        offset: optNum(offset),
        showSold: optBool(showSold),
        buyingFormat: buyingFormat as SearchParams['buyingFormat'],
        endingWithinMinutes: optNum(endingWithinMinutes),
        sort: sort as SearchParams['sort'],
        condition: condition as SearchParams['condition'],
        category: category as string | undefined,
        brand: brand as string | undefined,
        department: department as string | undefined,
        sizes: (sizes as string[] | undefined),
        colors: (colors as string[] | undefined),
      };

      // Resolve the location first so the response can expose the real search
      // coordinates (Phase 5). Only marketplaces that support getLocation are
      // probed; a failed or unsupported resolution does not fail the search.
      let resolved: ResolvedLocation | null = null;
      if (location && typeof mp.getLocation === 'function') {
        try {
          const coords = await mp.getLocation(location);
          if (coords) resolved = resolveBody(location, coords);
        } catch {
          resolved = null;
        }
      }

      let result;
      try {
        result = await mp.search(params);
      } catch (error) {
        return reply.code(502).send({
          search: searchMeta(marketplace, query, location, resolved, radiusMiles ?? radius, minPrice, maxPrice),
          success: false,
          listings: [],
          error: `Search failed: ${error}`,
        });
      }

      // Classify once, server-side, so every consumer groups identically.
      const { listings, relevanceCounters } = (() => {
          // A resolved query (currently the Google Pixel family) gives every
          // returned listing a real queryRelevance decision; unsupported
          // queries mark each listing not-applicable (visible, never
          // excluded) and keep the legacy pipeline intact.
          const family = resolveQueryFamily(query);
          const classified = (result.listings || []).map((l) => {
            const parsed = parseModel(String(l.title || ''));
            const relevance = family
              ? classifyQueryRelevance(String(l.title || ''), query)
              : NOT_APPLICABLE;
            return { l, parsed, relevance };
          });
          // The shared eligibility rule (review W1): a row is statistical only
          // when the relevance contract AND the model accessory logic both call
          // it a device — a matched/phone verdict plus `isAccessoryListing` (a
          // different vocabulary, e.g. "mica") is still an accessory.
          const isEligible = (c: { l: Listing; relevance: QueryRelevance }) =>
            c.relevance.status === 'matched' &&
            c.relevance.reason !== 'accessory' &&
            !isAccessoryListing(c.l);
          const clusterCandidates = family
            ? classified.filter(isEligible)
            : classified;
          // Only low-confidence keys may cluster: "Laptop Lenovo" vs
          // "Lenovo Laptop" are the same vague bucket, but "iPhone 15
          // Pro" vs "iPhone 15 Pro Max" are different machines and stay
          // put. Pass the key once per listing so the canonical key is
          // the phrasing describing the most listings.
          const canonical = clusterKeys(
            clusterCandidates
              .filter(({ parsed }) => parsed.confidence === 'low')
              .map(({ parsed }) => parsed.key),
          );
          return {
            listings: classified.map(({ l, parsed, relevance }) => ({
              ...l,
              model: parsed.key,
              modelFamily: modelFamily(String(l.title || '')),
              // high/medium keys are their own group; only low keys remap,
              // and only when the listing is eligible to be grouped at all.
              modelGroup:
                parsed.confidence === 'low'
                  ? family
                    ? isEligible({ l, relevance })
                      ? canonical.get(parsed.key) ?? parsed.key
                      : parsed.key
                    : canonical.get(parsed.key) ?? parsed.key
                  : parsed.key,
              ...(isAccessoryListing(l) ? { isAccessory: true } : {}),
              queryRelevance: relevance,
            })),
            relevanceCounters: family ? aggregateRelevance(classified) : undefined,
          };
      })();

      return {
        search: searchMeta(marketplace, query, location, resolved, radiusMiles ?? radius, minPrice, maxPrice),
        success: result.success,
        marketplace: result.marketplace,
        listings,
        ...(relevanceCounters ? { relevance: relevanceCounters } : {}),
        ...(result.totalFound != null ? { totalFound: result.totalFound } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.note ? { note: result.note } : {}),
      };
    }
  );

  // ── Arbitrage analysis ───────────────────────────────────────────────
  app.post<{ Body: Record<string, unknown> }>(
    '/v1/arbitrage',
    {
      schema: {
        tags: ['arbitrage'],
        summary: 'Cross-market arbitrage analysis',
        description:
          'Searches the primary marketplace, groups found listings by product/model, picks the top models by count (min. matches), then compares each against the other marketplace. Prices are normalized to USD (DOP -> USD). Returns distribution stats, per-model summaries, and a delta/profit estimate.',
        body: {
          type: 'object',
          required: ['query'],
          properties: {
            marketplace: { type: 'string', default: 'facebook' },
            query: { type: 'string' },
            location: { type: 'string' },
            radius: { type: 'number' },
            minPrice: { type: 'number' },
            maxPrice: { type: 'number' },
            limit: { type: 'number', default: 40 },
            topN: { type: 'number', default: 3 },
            minMatches: { type: 'number', default: 3 },
            buyingFormat: {
              type: 'string',
              enum: ['any', 'fixed', 'auction'],
              default: 'fixed',
              description:
                "Buy-side buying format (eBay). 'fixed' (default) only items purchasable at a known price; 'auction' only biddable items, whose price is the current bid and will rise; 'any' leaves the marketplace ranking alone.",
            },
            endingWithinMinutes: {
              type: 'number',
              minimum: 1,
              description:
                'With buyingFormat=auction: only bids closing within this many minutes. Near close the current bid approximates the final price.',
            },
            enrichDescriptions: {
              type: 'boolean',
              default: true,
              description:
                'Fetch the description for listings whose title did not identify a model, and reclassify them. Costs one extra request per such listing (bounded by maxEnrich); a search where every title parsed cleanly costs nothing.',
            },
            maxEnrich: {
              type: 'number',
              minimum: 0,
              default: 40,
              description: 'Ceiling on those extra description requests.',
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      const query = body.query;
      if (!query || typeof query !== 'string') {
        return reply.code(400).send({ error: 'Missing required parameter: query' });
      }
      try {
        const result = await runArbitrage({
          marketplace: (body.marketplace as string) || 'facebook',
          query,
          location: body.location as string | undefined,
          radius: body.radius as number | undefined,
          minPrice: body.minPrice as number | undefined,
          maxPrice: body.maxPrice as number | undefined,
          limit: body.limit as number | undefined,
          topN: body.topN as number | undefined,
          minMatches: body.minMatches as number | undefined,
          buyingFormat: body.buyingFormat as 'any' | 'fixed' | 'auction' | undefined,
          endingWithinMinutes: body.endingWithinMinutes as number | undefined,
          enrichDescriptions: body.enrichDescriptions as boolean | undefined,
          maxEnrich: body.maxEnrich as number | undefined,
        });
        return result;
      } catch (error) {
        return reply.code(502).send({ error: `Arbitrage analysis failed: ${error}` });
      }
    }
  );

  // ── Listing details ──────────────────────────────────────────────────
  app.get<{ Params: { marketplace: string; id: string } }>(
    '/v1/listings/:marketplace/:id',
    {
      schema: {
        tags: ['listings'],
        summary: 'Full details for a single listing',
        description:
          'Returns the normalized listing detail object for a marketplace id from a search result: description, every photo, location, seller and delivery options.',
        params: {
          type: 'object',
          required: ['marketplace', 'id'],
          properties: {
            marketplace: { ...marketplaceId },
            id: { type: 'string', description: 'Listing id from a search result' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              marketplace: { type: 'string' },
              ...listingDetailProps,
            },
          },
          404: {
            type: 'object',
            properties: {
              marketplace: { type: 'string' },
              id: { type: 'string' },
              error: { type: 'string' },
            },
          },
          501: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      const { marketplace, id } = request.params;

      const mp = getMarketplace(marketplace);
      if (!mp) {
        return reply.code(404).send({
          error: `Unknown marketplace: ${marketplace}. Available: ${getAllMarketplaces().map((m) => m.name).join(', ')}`,
        });
      }

      const mpWithDetails = mp as unknown as {
        getListingDetails?: (id: string) => Promise<ListingDetails>;
      };
      if (typeof mpWithDetails.getListingDetails !== 'function') {
        return reply.code(501).send({
          error: `Marketplace "${mp.name}" does not support listing details`,
        });
      }

      try {
        // Invoke as a method so the adapter's `this` (cached tokens, GraphQL
        // client, map caches) stays bound.
        const details = await mpWithDetails.getListingDetails.call(mp, id);
        return { marketplace, ...details };
      } catch (error) {
        return reply.code(404).send({
          marketplace,
          id,
          error: `Could not fetch listing details for ${mp.name}/${id}: ${error}`,
        });
      }
    }
  );

  return app;
}

type bodyShape = {
  query?: string;
  marketplace?: string;
  location?: string;
  radius?: number;
  radiusMiles?: number;
  minPrice?: number;
  maxPrice?: number;
  limit?: number;
  offset?: number;
  showSold?: boolean;
  buyingFormat?: 'any' | 'fixed' | 'auction';
  endingWithinMinutes?: number;
  sort?: string;
  condition?: string;
  category?: string;
  brand?: string;
  department?: string;
  sizes?: string[];
  colors?: string[];
};

function resolveBody(input: string, coords: LocationCoordinates): ResolvedLocation {
  return {
    input,
    name: coords.name,
    latitude: coords.latitude,
    longitude: coords.longitude,
  };
}

function searchMeta(
  marketplace: string,
  query: string,
  location: string | undefined,
  resolved: ResolvedLocation | null,
  radius: unknown,
  minPrice: unknown,
  maxPrice: unknown,
) {
  return {
    marketplace,
    query,
    location: resolved ?? (location ? { input: location } : undefined),
    radiusMiles: radius ?? undefined,
    minPrice: optNum(minPrice) ?? null,
    maxPrice: optNum(maxPrice) ?? null,
  };
}

function optNum(v: unknown): number | undefined {
  if (v == null || v === '' || typeof v === 'boolean') return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

function rangeInvalid(v: unknown): boolean {
  const n = optNum(v);
  return n != null && n < 0;
}

function optBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

/**
 * Aggregate the per-listing relevance decisions into the response counters,
 * with the same accessory rule as the eligibility filter (review W1): a row is
 * counted accessory when the relevance contract says so OR the model accessory
 * logic does (`isAccessoryListing`), and only matched non-accessory rows are
 * `matched`. raw is the full returned set.
 */
function aggregateRelevance(rows: Array<{ l: Listing; relevance: QueryRelevance }>): {
  raw: number;
  matched: number;
  excluded: number;
  reasons: { mismatch: number; ambiguous: number; accessory: number };
} {
  const raw = rows.length;
  let matched = 0;
  const reasons = { mismatch: 0, ambiguous: 0, accessory: 0 };
  for (const { l, relevance } of rows) {
    const accessory = relevance.reason === 'accessory' || isAccessoryListing(l);
    if (relevance.status === 'matched' && !accessory) matched += 1;
    if (accessory) reasons.accessory += 1;
    else if (relevance.reason === 'competing-family') reasons.mismatch += 1;
    else if (relevance.status === 'ambiguous') reasons.ambiguous += 1;
  }
  return { raw, matched, excluded: raw - matched, reasons };
}

// ── Entry point ────────────────────────────────────────────────────────
async function start(): Promise<void> {
  const app = await buildApiServer();
  const port = Number(process.env.PORT ?? process.env.API_PORT ?? DEFAULT_PORT);
  const host = process.env.HOST ?? '0.0.0.0';
  await app.listen({ port, host });
  app.log.info(`Secondhand REST API listening on http://${host}:${port}`);
}

const isDirectRun =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isDirectRun) {
  start().catch((error) => {
    // eslint-disable-next-line no-console
    console.error('Fatal error starting API:', error);
    process.exit(1);
  });
}
