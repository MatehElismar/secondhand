# REST API Reference

A self-hosted HTTP front-end over the marketplace abstraction. It talks to the
same marketplace registry the MCP server uses, so no scraping or search logic is
duplicated.

```
REST API  ->  Marketplace abstraction  ->  Facebook / eBay / Depop / Poshmark
MCP       ->  Marketplace abstraction  ->  Facebook / eBay / Depop / Poshmark
```

- **Base URL:** `http://localhost:PORT` (default `PORT=3000`)
- **Auth:** none (it runs on your own machine; gate it behind a proxy/network rules if exposed)
- **Interactive docs:** `GET /docs` (Swagger UI)
- **Raw OpenAPI spec:** `GET /docs/json` — a static snapshot lives at [`./openapi.json`](./openapi.json)

## Running it

```bash
npm install
npm run api          # builds then starts on :3000
```

| Env var | Default | Description |
|---------|---------|-------------|
| `PORT` | `3000` | Listen port |
| `API_PORT` | — | Alias for `PORT` |
| `HOST` | `0.0.0.0` | Bind address |
| `LOG_LEVEL` | `info` | Fastify log level |

Marketplace selection and credentials come from the same env vars the MCP server
uses (`MARKETPLACES`, `EBAY_CLIENT_ID`/`SECRET`, `SMARTPROXY_URL`,
`PUPPETEER_EXECUTABLE_PATH`) — see [../README.md](../README.md).

### Optional Facebook session (unlocks the real feed + pagination)

Facebook returns a **gated/empty** search feed to unauthenticated callers (so the
adapter falls back to one logged-out HTML page of ~24 results). To get the real
feed and paginate past 24, provide a logged-in session:

| Env var | Description |
|---------|-------------|
| `FB_COOKIE` | The `cookie:` header of a logged-in `/api/graphql` request |
| `FB_DTSG` / `FB_LSD` | `fb_dtsg` / `lsd` form fields from that request |
| `FB_USER` / `FB_JAZOEST` | `__user` / `jazoest` (optional) |

Keep these local/secret (`.env` is gitignored). With a session, a keyword search
paginates via Facebook's cursor API up to a bounded number of pages (~240).

**Capture them with one login:** run `npm run fb:session` — it opens a dedicated
Chrome window, you log in once, and it writes the `FB_*` values into `.env`
(cookies via `page.cookies()`, incl. HttpOnly, plus `fb_dtsg`/`lsd` from a
`/api/graphql` request). The profile persists in `.fb-session/` (gitignored), so
you don't log in again.

**Running with `.env`:** the `npm run api` script loads `.env` automatically
(`node --env-file-if-exists=.env dist/api.js`).

When a next page comes back gated/errored (an HTML page), pagination stops and
the results already collected are returned (partial success) instead of failing
the whole search.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/docs` | Swagger UI |
| `GET` | `/docs/json` | OpenAPI 3.0 document |
| `GET` | `/health` | Status + which marketplaces are registered |
| `GET` | `/v1/locations/resolve` | Resolve a place name to coordinates |
| `POST` | `/v1/search` | Search live listings |
| `GET` | `/v1/listings/:marketplace/:id` | Full details for one listing |

---

### `GET /health`

Reports that the API is up and lists the currently-registered marketplaces.
eBay appears only when `EBAY_CLIENT_ID`/`EBAY_CLIENT_SECRET` are set; Depop and
Poshmark only when Chrome/Chromium is found.

```bash
curl -s http://localhost:3000/health
```

```json
{
  "status": "ok",
  "server": "secondhand-mcp",
  "marketplaces": [
    { "name": "facebook", "displayName": "Facebook Marketplace", "requiresAuth": false },
    { "name": "depop",    "displayName": "Depop", "requiresAuth": false },
    { "name": "poshmark", "displayName": "Poshmark", "requiresAuth": false }
  ]
}
```

### `GET /v1/locations/resolve`

Resolves a human-readable place to latitude/longitude using the marketplace's own
`getLocation()`. For Facebook the coordinates come from Facebook's location search
(not a hard-coded table). The `input` is echoed back verbatim, so you can tell
exactly what was resolved.

**Query params**

| Name | Required | Description |
|------|----------|-------------|
| `marketplace` | no | default `facebook` |
| `location` | yes | e.g. `Santo Domingo, Dominican Republic` |

```bash
curl -s "http://localhost:3000/v1/locations/resolve?marketplace=facebook&location=Santo%20Domingo%2C%20Dominican%20Republic"
```

```json
{
  "input": "Santo Domingo, Dominican Republic",
  "name": "Ciudad",
  "latitude": 18.4727,
  "longitude": -69.8946
}
```

**Status codes:** `200` resolved · `400` missing `location` · `404` unknown
marketplace or location not found · `501` marketplace has no location support.

### `POST /v1/search`

Searches a marketplace. The response includes a `search` object carrying the
*resolved* location the adapter actually searched with, plus the normalized
`listings`. `minPrice`/`maxPrice` are **major units** of the target marketplace's own
currency (DOP for the Dominican Republic), so `300` means `DOP 300`, not `DOP 3.00`.
Adapters scale the value to whatever unit their API expects — Facebook's GraphQL
bounds are centavos — so callers never supply minor units.

**Request body**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `marketplace` | string | no | `facebook` (default) · `ebay` · `depop` · `poshmark` |
| `query` | string | **yes** | search terms, e.g. `iphone 15` |
| `location` | string | no | place to search around (Facebook) |
| `radius` / `radiusMiles` | number | no | radius in miles (Facebook) |
| `minPrice` / `maxPrice` | number | no | non-negative, **major units** of the marketplace currency (`300` = DOP 300) |
| `limit` | number | no | max results |
| `offset` | number | no | pagination (eBay) |
| `showSold` | boolean | no | include sold items |
| `sort` | string | no | Depop/Poshmark sort |
| `condition` | string | no | item condition |
| `category` | string | no | product category |
| `brand` | string | no | brand (Poshmark) |
| `department` | string | no | Women/Men/Kids (Poshmark) |
| `sizes` | string[] | no | sizes (Depop/Poshmark) |
| `colors` | string[] | no | colors (Depop/Poshmark) |

```bash
curl -s -X POST http://localhost:3000/v1/search \
  -H 'Content-Type: application/json' \
  -d '{
    "marketplace": "facebook",
    "query": "iphone 15",
    "location": "Santo Domingo, Dominican Republic",
    "radiusMiles": 25,
    "minPrice": 300,
    "maxPrice": 600,
    "limit": 25
  }'
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
      "images": ["https://…"],
      "marketplace": "facebook",
      "scrapedAt": "2026-09-08T16:05:15.310Z"
    }
  ],
  "totalFound": 10
}
```

A failed marketplace returns `success: false` with an `error` string (and an empty
`listings` array) rather than a 5xx, so callers can read the reason.

### `GET /v1/listings/:marketplace/:id`

Full details for one listing id from a search result: description, every photo,
location, seller and delivery options. e.g. `POST /v1/search` then
`GET /v1/listings/facebook/1388212513435917`.

```bash
curl -s http://localhost:3000/v1/listings/facebook/1589159836094134
```

```json
{
  "marketplace": "facebook",
  "id": "1589159836094134",
  "description": "Covers 14/15/16 plus …",
  "images": ["https://…"],
  "location": "Santo Domingo, Distrito Nacional",
  "locationCoords": { "latitude": 18.4707, "longitude": -69.8895 },
  "deliveryTypes": ["IN_PERSON", "SHIPPING_OFFSITE"],
  "isShippingOffered": true,
  "url": "https://www.facebook.com/marketplace/item/1589159836094134"
}
```

**Status codes:** `404` unknown marketplace / listing not found · `501`
marketplace has no listing-details support.

## Data model

`Listing` (search results):

```ts
{
  id: string; title: string; price: string; priceNumeric?: number;
  currency?: string; location?: string; description?: string; url: string;
  images?: string[]; seller?: string; condition?: string;
  marketplace: string; scrapedAt: string;
}
```

`ListingDetails` (`/v1/listings/:mp/:id`):

```ts
{
  id: string; description?: string; images: string[]; location?: string;
  locationCoords?: { latitude: number; longitude: number }; seller?: string;
  deliveryTypes?: string[]; isShippingOffered?: boolean; url: string;
}
```

`LocationCoordinates` (resolve):

```ts
{ input: string; name?: string; latitude?: number; longitude?: number }
```

## Notes & limitations

- **Currency is the seller's**: Facebook returns prices in the local currency
  (e.g. `DOP`) as the seller entered them. Price filters are applied by the
  marketplace in that currency, not in USD.
- **Price filter unit is major units**: `minPrice`/`maxPrice` are whole units of that
  currency (`300` = `DOP 300`). The Facebook adapter multiplies them by 100 because
  Facebook's GraphQL `filter_price_lower_bound`/`filter_price_upper_bound` are in
  centavos; an absent bound stays open (`0` floor, `214748364700` ceiling). eBay uses
  major units natively and is not scaled.
- **Facebook result cap**: a single keyword search is paginated in 24-item pages
  via Facebook's cursor-based `SearchContentPaginationQuery`, up to a bounded
  number of pages (~240 listings). If Facebook returns its *gated* response (0
  items but "has next page"), the adapter falls back to reading the server-side
  search page (single page, ~24 items) — this is the normal behavior when the IP
  is rate-limited; a residential proxy (`SMARTPROXY_URL`) reduces it.
- **Facebook location resolution is non-deterministic** for non-US places. It is
  based on Facebook's check-in-ranked location search, so the same query can
  resolve differently between calls (the API surfaces the exact value it used).
  US city lookups are deterministic via an offline table.
- **Seller name** appears when Facebook's response includes it; some listings omit it.
