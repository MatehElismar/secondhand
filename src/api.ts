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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { SearchParams, ListingDetails, LocationCoordinates } from './types.js';

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

      return {
        search: searchMeta(marketplace, query, location, resolved, radiusMiles ?? radius, minPrice, maxPrice),
        success: result.success,
        marketplace: result.marketplace,
        listings: result.listings,
        ...(result.totalFound != null ? { totalFound: result.totalFound } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.note ? { note: result.note } : {}),
      };
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
