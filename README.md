[![Verified on MseeP](https://mseep.ai/badge.svg)](https://mseep.ai/app/3c5664f0-af0e-47f3-8027-de49f25cad5c)

# Secondhand MCP

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that lets AI assistants search secondhand marketplaces. Search Facebook Marketplace, eBay, Depop, and Poshmark for used and secondhand items — filter by price, category, condition, size, and color, then get full listing details with photos, descriptions, and seller info.

Works with Claude Desktop, Claude Code, Cursor, and other clients that run MCP servers locally.

> [!TIP]
> **Using ChatGPT? This one won't work there.**
>
> It runs on your computer, so it only works where your computer is — Claude Desktop, Claude Code, Cursor. [Secondhand MCP Cloud](https://secondhandmcp.com) is the same search, always on, so whichever assistant you actually use can reach it. Free tier, no card.

| | This repo | [Cloud](https://secondhandmcp.com) |
|---|---|---|
| Claude Desktop, Code, Cursor | ✅ | ✅ |
| ChatGPT, Claude, and other assistants | — | ✅ |
| Searching from your phone | — | ✅ |
| Chrome running in the background | needed | not needed |
| Price | free, forever | free tier, then $4.99 |

## Documentation

Detailed reference docs live in [`docs/`](./docs):

| Doc | What it covers |
|-----|----------------|
| [`docs/MCP.md`](./docs/MCP.md) | MCP server: connecting clients, every tool, params, JSON-RPC example, env vars |
| [`docs/REST-API.md`](./docs/REST-API.md) | REST API: endpoints, request/response, data model, curl examples |
| [`docs/openapi.json`](./docs/openapi.json) | Static OpenAPI 3.0 spec for the REST API (regenerate via `GET /docs/json`) |

## Supported Marketplaces

| Marketplace | Auth Required | Notes |
|-------------|---------------|-------|
| Facebook Marketplace | No | Location-based search |
| eBay | Yes (API keys) | Official Browse API |
| Depop | No | Requires Chrome installed |
| Poshmark | No | Requires Chrome installed |

## Setup

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "secondhand": {
      "command": "npx",
      "args": ["-y", "secondhand-mcp"],
      "env": {
        "EBAY_CLIENT_ID": "your-ebay-client-id",
        "EBAY_CLIENT_SECRET": "your-ebay-client-secret",
        "EBAY_MARKETPLACE_ID": "EBAY_US"
      }
    }
  }
}
```

### Claude Code

Add to `~/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "secondhand": {
      "command": "npx",
      "args": ["-y", "secondhand-mcp"],
      "env": {
        "EBAY_CLIENT_ID": "your-ebay-client-id",
        "EBAY_CLIENT_SECRET": "your-ebay-client-secret",
        "EBAY_MARKETPLACE_ID": "EBAY_US"
      }
    }
  }
}
```

eBay, Depop, and Poshmark are all optional — if eBay API keys are missing or Chrome isn't installed, those marketplaces are automatically disabled and the rest still work.

### Depop & Poshmark / Chrome Requirement

Depop and Poshmark require a headless browser. If **Google Chrome or Chromium** is installed on your system, both are automatically enabled — no config needed. If Chrome isn't found, they are silently skipped.

On macOS, the first time you search Depop or Poshmark, you may see a system prompt asking to allow Node.js to control Chrome. This is expected — puppeteer needs to launch Chrome in headless mode. Allow it once and it won't ask again.

The browser runs invisibly in the background and only launches when you actually search Depop or Poshmark.

## Configuration

### Choosing Marketplaces

By default all marketplaces are enabled. To limit which are active, set the `MARKETPLACES` env var (comma-separated):

```json
{
  "env": {
    "MARKETPLACES": "facebook,ebay"
  }
}
```

Valid values: `facebook`, `ebay`, `depop`, `poshmark`

### eBay API Keys

eBay uses the official [Browse API](https://developer.ebay.com/api-docs/buy/browse/overview.html). You need a free eBay developer account:

1. Create an account at [developer.ebay.com](https://developer.ebay.com)
2. Create an application to get a Client ID and Client Secret
3. Add them to your MCP config as `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET`

### eBay Marketplace / Region

By default the server targets the **US** eBay site. To search a different regional marketplace, set the `EBAY_MARKETPLACE_ID` environment variable:

```json
{
  "env": {
    "EBAY_MARKETPLACE_ID": "EBAY_DE"
  }
}
```

Common values:

| Value | Site |
|-------|------|
| `EBAY_US` | ebay.com (default) |
| `EBAY_DE` | ebay.de |
| `EBAY_GB` | ebay.co.uk |
| `EBAY_AU` | ebay.com.au |
| `EBAY_FR` | ebay.fr |
| `EBAY_IT` | ebay.it |
| `EBAY_ES` | ebay.es |
| `EBAY_CA` | ebay.ca |

The full list is available in the [eBay API docs](https://developer.ebay.com/api-docs/static/rest-request-components.html#marketpl).

## Tools

### `search_marketplace`

Search for items across marketplaces.

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `query` | Yes | | Search terms |
| `marketplace` | No | `facebook` | `facebook`, `ebay`, `depop`, `poshmark`, or `all` |
| `location` | No | `san francisco` | City to search in (Facebook only) |
| `radiusMiles` | No | `25` | Search radius in miles, up to 500 (Facebook only) |
| `maxPrice` | No | | Maximum price, in whole units of the marketplace currency (`600` = `DOP 600`, not `$6`) |
| `minPrice` | No | | Minimum price, in whole units of the marketplace currency (`300` = `DOP 300`, not `$3`) |
| `limit` | No | `20` | Max results |
| `showSold` | No | `false` | Include sold items (Facebook only) |
| `includeImages` | No | `false` | Accepted for compatibility — image URLs and the seller name are now always included when available |
| `sort` | No | `relevance` | Sort order (Depop, Poshmark): `relevance`, `newest`, `most_popular`, `price_low_to_high`, `price_high_to_low` |
| `condition` | No | | Item condition. eBay: `new`, `like_new`, `good`, `fair`. Depop: `new`, `like_new`, `excellent`, `good`, `fair`, `used`. Poshmark: `new` (NWT), `like_new` (NWOT), `good`, `fair` |
| `category` | No | | Product category. Depop: `tops`, `bottoms`, `dresses`, `coats-jackets`, `footwear`, `accessories`, `bags`, `jewellery`, `activewear`, `swimwear`. Poshmark: `Jackets_&_Coats`, `Dresses`, `Shoes`, `Accessories`, etc. |
| `brand` | No | | Brand filter (Poshmark only): e.g. `"Nike"`, `"Levi's"`, `"Gucci"` |
| `department` | No | | Department filter (Poshmark only): `Women`, `Men`, `Kids` |
| `sizes` | No | | Size filter (Depop, Poshmark): e.g. `["S", "M", "L"]` or `["US 9", "US 10"]` |
| `colors` | No | | Color filter (Depop, Poshmark): `black`, `white`, `red`, `blue`, `green`, `yellow`, `orange`, `pink`, `purple`, `brown`, `grey`, `cream`, `multi`, `silver`, `gold` |

**Data returned per marketplace:**

| Field | Facebook | eBay | Depop | Poshmark |
|-------|----------|------|-------|----------|
| Title | Yes | Yes | Yes | Yes |
| Price | Yes | Yes | Yes | Yes |
| Location | City | City, State | — | — |
| Condition | — | Yes | — | — |
| Photo count | 1 thumbnail | 1 thumbnail | 1 thumbnail | 1 thumbnail |
| Seller | Yes | Yes | — | — |

### `get_listing_details`

Get full details for a specific listing using an ID from search results.

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `listingId` | Yes | | Listing ID from search results |
| `marketplace` | No | `facebook` | `facebook`, `ebay`, `depop`, or `poshmark` |

**Data returned per marketplace:**

| Field | Facebook | eBay | Depop | Poshmark |
|-------|----------|------|-------|----------|
| Description | Yes | Yes | Yes | Yes |
| All photos | Yes | Yes | Yes | Yes |
| Location | City | City, State, Country | — | — |
| Seller | Name | Username | Username | Username |
| Delivery types | Yes | — | — | — |
| Shipping | Yes/No | Service codes | Yes/No | Always included |

### `list_marketplaces`

List all enabled marketplaces and their status.

### `search` / `fetch` (deep research)

Convenience pair following the [ChatGPT Deep Research tool contract](https://developers.openai.com/api/docs/guides/deep-research) — exact names, a single string argument each:

- `search(query)` — searches every enabled marketplace at once and returns `{ results: [{ id, title, text, url }] }`, where `id` is `marketplace:listingId`
- `fetch(id)` — returns full listing details for a `search` result ID as `{ id, title, text, url, metadata }`

Useful for research-style clients that expect these standard tool names; for filtered searches use `search_marketplace`.

## How It Works

**Facebook Marketplace** — Searches listings by location, radius, price, and query. Resolves city names to coordinates. No login or browser needed. Facebook serves non-browser callers a gated version of its search API from time to time (a single result with more pages behind it, or stubs with no listing inside); when that happens the server reads the logged-out search page instead, which still carries a full first page of results.

**eBay** — Uses the official eBay Browse API with OAuth 2.0 client credentials. Tokens are cached and auto-refreshed. The target regional marketplace is controlled by `EBAY_MARKETPLACE_ID` (default: `EBAY_US`).

**Depop** — Uses a headless browser to search listings with support for category, condition, size, and color filters. The browser instance is shared across requests.

**Poshmark** — Uses a headless browser to search listings with support for condition, size, color, sort, and price filters. Poshmark is not location-based — all items ship nationally.

## REST API (self-hosted)

MCP is not the only interface. The repo also ships a lightweight REST API that
sits in front of the exact same marketplace abstraction the MCP server uses — it
never re-implements scraping or search logic.

```
REST API  ->  Marketplace abstraction  ->  Facebook / eBay / Depop / Poshmark
MCP       ->  Marketplace abstraction  ->  Facebook / eBay / Depop / Poshmark
```

### Run it

```bash
npm install
npm run api          # builds then starts on :3000 (see PORT below)
```

For a single local server that also wants Facebook Marketplace working, no extra
config is needed; Facebook requires no credentials. eBay needs API keys and
Depop/Poshmark need Chrome to be registered (see Configuration).

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/docs` | Interactive Swagger UI |
| `GET` | `/docs/json` | Raw OpenAPI 3.0 document |
| `GET` | `/health` | Service status + which marketplaces are registered |
| `GET` | `/v1/locations/resolve` | Resolve a place name to coordinates |
| `POST` | `/v1/search` | Search via a marketplace |
| `GET` | `/v1/listings/:marketplace/:id` | Full details for one listing |

> **Interactive docs**: open <http://localhost:3000/docs> for the Swagger UI. Each
> endpoint has request/response schemas and example bodies; the raw spec (OpenAPI
> 3.0.3) is at `GET /docs/json` if you want to generate a client or import it into
> Postman.

**`GET /v1/locations/resolve?marketplace=facebook&location=...`**

```json
{
  "input": "Santo Domingo, Dominican Republic",
  "name": "Ciudad",
  "latitude": 18.4727,
  "longitude": -69.8946
}
```

**`POST /v1/search`**

```json
{
  "marketplace": "facebook",
  "query": "iphone 15",
  "location": "Santo Domingo, Dominican Republic",
  "radius": 25,
  "minPrice": 300,
  "maxPrice": 600,
  "limit": 25
}
```

```json
{
  "search": {
    "marketplace": "facebook",
    "query": "iphone 15",
    "location": {
      "input": "Santo Domingo, Dominican Republic",
      "name": "Ciudad",
      "latitude": 18.4727,
      "longitude": -69.8946
    },
    "radiusMiles": 25,
    "minPrice": 300,
    "maxPrice": 600
  },
  "success": true,
  "marketplace": "facebook",
  "listings": [
    {
      "id": "1388212513435917",
      "title": "Caja IPhone 15 Pro Max Titanium 512gb",
      "price": "DOP500",
      "priceNumeric": 500,
      "currency": "DOP",
      "location": "Santo Domingo, Dominican Republic",
      "url": "https://www.facebook.com/marketplace/item/1388212513435917",
      "images": ["..."],
      "marketplace": "facebook",
      "scrapedAt": "2026-09-08T16:05:15.310Z"
    }
  ],
  "totalFound": 10
}
```

The `search.location` above is the *resolved* coordinate for the search, populated
by the marketplace's own `getLocation()` — nothing is hard-coded.

The `minPrice: 300` / `maxPrice: 600` bounds in that request are **DOP**, so the
`DOP500` listing is inside the range. Facebook's GraphQL price filters are in
centavos; the adapter scales the bounds (300 -> `30000`, 600 -> `60000`) before
sending them, so the example above only returns in-range listings.

**`buyingFormat` / `endingWithinMinutes` (eBay only)**

Both fields are ignored by every marketplace except eBay.

| Field | Type | Range | Description |
|-------|------|-------|-------------|
| `buyingFormat` | string | `any` / `fixed` / `auction` | `fixed` excludes bidding, `auction` returns only biddable items (the price shown is the current bid), `any` leaves eBay's own ranking alone. |
| `endingWithinMinutes` | number | 1-1440 | With `buyingFormat: "auction"`, only bids closing within this many minutes. Out-of-range values are rejected with `400`, never silently clamped. |

```json
{
  "marketplace": "ebay",
  "query": "iphone 15",
  "buyingFormat": "auction",
  "endingWithinMinutes": 60
}
```

Two things worth knowing before you build on this:

- **The window is a range, not a bucket.** `endingWithinMinutes: 60` returns everything
  closing within the hour, which is a superset of what `15` returns. There is no
  disjoint "between 15 and 60" query.
- **Auction volume is thin at the short end.** Measured against the live Browse API,
  auctions closing within an hour are roughly 3% of those closing within a day, and a
  five-minute window returns nothing for most queries. That is why the shipped web UI
  offers windows out to 24 hours, and says so when a short window comes back empty.

`POST /v1/arbitrage` accepts both fields as well, but note what they do there: the
endpoint prices its buy side from `buyingFormat`, whose default is `fixed`. Passing
`auction` together with a narrow window prices that median off live bids, which sit
below the price the item will actually reach, so it shrinks the sample *and* biases it
downward. Omit both fields unless you specifically want an auction-based comparison.

**`GET /v1/listings/facebook/1589159836094134`**

Returns the normalized `ListingDetails` (description, all photos, location,
seller, delivery types).

### REST API environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Listen port |
| `API_PORT` | — | Alias for `PORT` |
| `HOST` | `0.0.0.0` | Bind address |
| `LOG_LEVEL` | `info` | Fastify log level |

Tip: the lookup and search endpoints accept the same filter fields the MCP
`search_marketplace` tool does (`minPrice`, `maxPrice`, `condition`, `sort`,
`category`, `brand`, `department`, `sizes`, `colors`, `showSold`, `offset`).

## Development

```bash
git clone https://github.com/jlsookiki/secondhand-mcp.git
cd secondhand-mcp
npm install
npm run build
```

| Command | What it does |
|---------|--------------|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm test` | Run the Vitest suite |
| `npm run dev` | Run the MCP server from source (ts-node; see note below) |
| `npm start` | Run the MCP server from `dist/` |
| `npm run api` | Build then start the REST API on `:3000` (loads `.env` if present) |
| `npm run fb:session` | One-time Facebook login flow → writes `FB_*` into `.env` |

> **Note on `npm run dev` / ts-node** — the source uses NodeNext ESM with `*.js`
> import specifiers, which the bundled `ts-node` version cannot resolve under
> recent Node builds. If `npm run dev` reports `ERR_MODULE_NOT_FOUND`, use
> `npm run build && npm start` (MCP) or `npm run api` (REST) instead. Both compile
> with `tsc` and run against `dist/`.

### Configuring via a `.env` file

The REST API reads `process.env`. On Node ≥ 22.9 you can load a `.env` file
without any dependency:

```bash
node --env-file=.env dist/api.js
```

`npm run api` already loads `.env` automatically
(`node --env-file-if-exists=.env dist/api.js`). A commented `/ .env.example`
lists every supported variable.

### Facebook session (optional, unlocks the real feed + pagination)

Facebook returns a gated/empty search feed to unauthenticated callers, so the
server falls back to a single logged-out HTML page (~24 results). Providing a
logged-in session makes the GraphQL feed come back real, and keyword searches
then **paginate** past 24 items.

Log in **once** to capture it automatically:

```bash
npm run fb:session
```

This opens a dedicated Chrome window; complete the login there and the script
writes `FB_COOKIE`, `FB_DTSG`, `FB_LSD`, `FB_USER`, `FB_JAZOEST` into `.env`.
It reads the session cookies (including the HttpOnly ones) via `page.cookies()`
plus `fb_dtsg`/`lsd` from a `/api/graphql` request, and keeps a persistent
profile in `.fb-session/` (gitignored) so you don't log in again.

Keep `.env` and `.fb-session/` private — they contain your live session. See
[`docs/MCP.md`](./docs/MCP.md) and [`docs/REST-API.md`](./docs/REST-API.md) for
the env vars and the pagination/gating behavior. Note this is unofficial
scraping of Facebook's internal GraphQL; use at your own account risk.

To get the **MCP** server (e.g. opencode) to use the same session, register it
with `--env-file-if-exists=<repo>/.env` in its launch command — the live session
then loads from `.env` without duplicating secrets. Full steps in
[`docs/MCP.md`](./docs/MCP.md)

## Docker

A multi-stage `Dockerfile` and `docker-compose.yml` are provided to run the REST
API as a self-hosted service. Facebook and eBay work out of the box; to also
enable Depop and Poshmark, install Chromium (`INSTALL_CHROME=true`).

```bash
cp .env.example .env     # optional: add eBay keys / SMARTPROXY_URL
docker compose up -d
```

The container:

* runs `node dist/api.js` (the REST API) on port 3000,
* binds `HOST=0.0.0.0`,
* has a `/health` Docker healthcheck,
* reads secrets from the GitHub-ignored `.env` file (or `docker compose` env).

To enable the browser marketplaces from the command line:

```bash
docker compose build --build-arg INSTALL_CHROME=true
docker compose up -d
```

> Note: the MCP stdio server (`npx secondhand-mcp` / `node dist/index.js`) is meant
> to run on the host and talk over stdio, so it is not what the container starts.

### Adding a Marketplace

1. Create a new file in `src/marketplaces/`
2. Extend `BaseMarketplace` and implement `search()` and optionally `getListingDetails()`
3. Add the constructor to `allMarketplaces` in `src/marketplaces/index.ts`

## Limitations

- **Facebook**: May break if Facebook changes their frontend
- **eBay**: Requires developer API keys (free tier available)
- **Depop**: Requires Chrome/Chromium installed; slower than Facebook/eBay (~5s per search)
- **Poshmark**: Requires Chrome/Chromium installed; no official API so relies on page scraping
- **Rate limiting**: Don't make too many requests too quickly

## License

MIT
