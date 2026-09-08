# MCP Server Reference

The MCP (Model Context Protocol) server exposes secondhand marketplace search as
tools that any MCP client (Claude Desktop, Claude Code, Cursor, opencode, custom
clients) can call. It runs as a **stdio** server on the host.

```
MCP (stdio)  ->  Marketplace abstraction  ->  Facebook / eBay / Depop / Poshmark
REST         ->  Marketplace abstraction  ->  Facebook / eBay / Depop / Poshmark
```

Both interfaces share the exact same adapter registry and types.

**Run it (from a build):**

```bash
npm run build
npm start        # == node dist/index.js  (stdio)
```

`npm run dev` uses ts-node and is not currently usable under Node ≥ 22 with this
ESM setup (see Development in [../README.md](../README.md)); use the build.

## Connecting a client

The server speaks MCP over stdio. Clients declare it as a local command.

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "secondhand": {
      "command": "npx",
      "args": ["-y", "secondhand-mcp"],
      "env": { "EBAY_CLIENT_ID": "…", "EBAY_CLIENT_SECRET": "…" }
    }
  }
}
```

**Claude Code** (`~/.claude/.mcp.json`): same shape as above.

**opencode** (`opencode.json`):

```json
{
  "mcp": {
    "secondhand": {
      "type": "local",
      "command": ["node", "/absolute/path/to/secondhand-mcp/dist/index.js"],
      "enabled": true,
      "environment": { "EBAY_MARKETPLACE_ID": "EBAY_US" }
    }
  }
}
```

## Tools

The server exposes exactly five tools.

### `search_marketplace`

Search live listings on one marketplace (or `all`). Read-only.

| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `query` | **yes** | | search terms |
| `marketplace` | no | `facebook` | `facebook`, `ebay`, `depop`, `poshmark`, `all` |
| `location` | no | `san francisco` | "City, ST" or city + country (Facebook) |
| `radiusMiles` | no | `25` | up to 500 (Facebook) |
| `minPrice` / `maxPrice` | no | | applied in the marketplace's currency |
| `limit` | no | `20` | max results |
| `offset` | no | `0` | pagination (eBay) |
| `showSold` | no | `false` | include sold items (Facebook) |
| `includeImages` | no | `false` | compatibility no-op — URLs now always returned |
| `sort` | no | `relevance` | Depop/Poshmark |
| `condition` | no | | eBay/Depop/Poshmark |
| `category` | no | | Depop/Poshmark |
| `brand` | no | | Poshmark |
| `department` | no | | Poshmark |
| `sizes` | no | | Depop/Poshmark |
| `colors` | no | | Depop/Poshmark |

Result (single marketplace) includes the seller name and image URLs when present:

```
🔍 Found 10 listings for "iphone" on facebook
📍 Location: Santo Domingo, Dominican Republic

**DOP500** - Caja IPhone 15 Pro Max Titanium 512gb
   📍 Santo Domingo, Dominican Republic
   👤 Seller: Emmanuel Tovar
   🆔 1388212513435917
   🖼️ Images: https://…
```

### `get_listing_details`

Full detail for one listing id: description, every photo, location, seller,
delivery options.

| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `listingId` | **yes** | | from search results |
| `marketplace` | no | `facebook` | |
| `imageMode` | no | `urls` | `urls` (CDN URLs) or `inline` (base64 blocks) |
| `includeImages` | no | `false` | deprecated alias for `imageMode: "inline"` |
| `imageSize` | no | `full`/`standard` | `thumb` · `standard` · `full` (eBay) |
| `maxImages` | no | all | cap photo count |

### `list_marketplaces`

No arguments. Lists each registered marketplace with its display name, whether it
needs credentials, and whether it is currently reachable.

### `search` / `fetch` (deep-research contract)

A convenience pair following the ChatGPT Deep Research tool contract (exact names,
a single string argument each):

- `search(query)` — searches every enabled marketplace at once → `{ results }`,
  where each id is `marketplace:listingId`.
- `fetch(id)` — returns full details for that id (`marketplace:listingId`) →
  `{ id, title, text, url, metadata }`.

## Example (raw MCP over stdio)

Any client can emit JSON-RPC over stdio. `initialize`, then call a tool:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"demo","version":"1.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_marketplace","arguments":{"query":"iphone","marketplace":"facebook","location":"Santo Domingo, Dominican Republic"}}}' \
  | node dist/index.js
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `MARKETPLACES` | Comma-separated enabled set: `facebook,ebay,depop,poshmark`. Unset = all usable |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` | eBay Browse API credentials |
| `EBAY_MARKETPLACE_ID` | Regional site, e.g. `EBAY_US` (default) |
| `SMARTPROXY_URL` | Optional residential proxy URL for Facebook |
| `PUPPETEER_EXECUTABLE_PATH` | Chrome path for Depop/Poshmark (auto-detected otherwise) |

Marketplaces that cannot run on the machine are omitted automatically: eBay needs
keys; Depop and Poshmark need Chrome/Chromium.

## Notes & limitations

- **Read-only**: the server can read listings but cannot message sellers, make
  offers, or buy. Never claim an item was purchased or reserved.
- **Facebook** may rate-limit repeated searches from one IP; results are cached for
  90 seconds per query/location/price/location combo.
- **eBay** searches nationally (not location-based); requires API keys.
- **Depop/Poshmark** need Chrome and are slower (~5s/search). No official API.
- Empty results usually mean the query was too narrow — widen terms or drop a
  price bound before concluding nothing exists.
