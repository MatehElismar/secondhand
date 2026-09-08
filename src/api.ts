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
 */

import fastify, { FastifyInstance } from 'fastify';
import {
  initializeMarketplaces,
  getMarketplace,
  getAllMarketplaces,
} from './marketplaces/index.js';
import { SearchParams, ListingDetails, LocationCoordinates } from './types.js';

const DEFAULT_PORT = 3000;

export interface ResolvedLocation {
  input: string;
  name?: string;
  latitude?: number;
  longitude?: number;
}

/**
 * Build the Fastify application with every route registered. Marketplaces are
 * initialized here so the API sees exactly the adapters MCP would.
 */
export function buildApiServer(): FastifyInstance {
  initializeMarketplaces();

  const app = fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
  });

  // ── Health ───────────────────────────────────────────────────────────
  app.get('/health', async () => {
    return {
      status: 'ok',
      server: 'secondhand-mcp',
      marketplaces: getAllMarketplaces().map((m) => ({
        name: m.name,
        displayName: m.displayName,
        requiresAuth: m.requiresAuth,
      })),
    };
  });

  // ── Location resolution ──────────────────────────────────────────────
  app.get<{ Querystring: { marketplace?: string; location?: string } }>(
    '/v1/locations/resolve',
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
  app.post<{ Body: Record<string, unknown> }>('/v1/search', async (request, reply) => {
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
  });

  // ── Listing details ──────────────────────────────────────────────────
  app.get<{ Params: { marketplace: string; id: string } }>(
    '/v1/listings/:marketplace/:id',
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
  const app = buildApiServer();
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
