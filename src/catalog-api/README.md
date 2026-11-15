# @techx/catalog-api

Validated static product catalog HTTP API. The v2 seed contains 24 products with
explicit category, availability, inventory, pricing, specifications, tags, and
local image metadata. Startup fails fast when seed data is invalid.

## Responsibilities

- Serves the full product catalog from an in-process validated seed file.
- Exposes product listing with derived category facets.
- Exposes individual product detail lookup by slug ID.
- Propagates `x-request-id` for end-to-end request tracing.
- Sets `Cache-Control: public, max-age=30` on successful product responses.
- Rejects all non-GET requests with `405 Method Not Allowed`.
- Signals readiness via `/readyz` and liveness via `/healthz` (unauthenticated).
- Logs structured JSON to stdout: `timestamp`, `level`, `service`, `method`,
  `path`, `status`, `durationMs`, `requestId`.

## Code Structure

```
src/catalog-api/
├── data/
│   └── products.json          # Seed: 24 products (telescopes, binoculars, accessories)
├── src/
│   ├── catalog.ts             # validateProducts(), buildCategories()
│   ├── main.ts                # Entry point: reads CATALOG_PORT, starts server, handles SIGTERM/SIGINT
│   ├── server.ts              # createCatalogServer(): all route handling
│   └── types.ts               # Product, CatalogCategory, ErrorEnvelope TypeScript types
├── test/
│   ├── catalog.test.ts        # Unit: seed validation, category facets, duplicate/inconsistency detection
│   └── server.test.ts         # HTTP: health, list, detail, 404, 405, malformed URL encoding
├── Dockerfile
├── package.json
├── README.md
└── tsconfig.json
```

## Environment Variables

| Variable       | Required | Default | Description                              |
| -------------- | -------- | ------- | ---------------------------------------- |
| `CATALOG_PORT` | No       | `3001`  | TCP port the server listens on (1–65535) |

No secrets or external dependencies are required. The catalog is fully in-process.

## Startup Instructions

### Development (auto-reload)

```powershell
npm run dev -w @techx/catalog-api
```

### Production build and start

```powershell
npm run build -w @techx/catalog-api
npm run start -w @techx/catalog-api
```

### Docker Compose (full stack)

```powershell
# Copy and fill in ORDER_API_KEY (all other values have safe defaults)
Copy-Item .env.example .env
# Start all services
docker compose up --build
```

Catalog API starts on port `3001` and is immediately accessible at
`http://localhost:3001` (the frontend proxy routes `/api/products*` there).

## API Reference

All responses include:

- `Content-Type: application/json; charset=utf-8`
- `x-request-id` — echoes the incoming `x-request-id` header (8–128 chars) or
  assigns a generated UUID when the header is absent or invalid.
- `Cache-Control: public, max-age=30` on 200 product responses; `no-store` on errors.

### GET /healthz

Liveness probe. Always returns `200` even during graceful shutdown.
Used by Kubernetes liveness probes (unauthenticated).

**Response `200`:**

```json
{ "status": "ok", "service": "catalog-api" }
```

---

### GET /readyz

Readiness probe. Returns `200` while the server is active;
returns `503` after the server begins closing.
Used by Kubernetes readiness probes (unauthenticated).

**Response `200`:**

```json
{ "status": "ready", "service": "catalog-api" }
```

**Response `503`** (shutting down):

```json
{
  "error": {
    "code": "NOT_READY",
    "message": "Catalog API is shutting down.",
    "requestId": "..."
  }
}
```

---

### GET /api/products

Returns all 24 products and derived category facets.
The `categories` array is computed at startup — counts always match the seed.

**Response `200`:**

```json
{
  "products": [
    {
      "id": "stellar-70-refractor",
      "sku": "TEL-STL-70",
      "name": "Stellar 70 Refractor",
      "category": "telescopes",
      "shortDescription": "...",
      "description": "...",
      "priceCents": 14999,
      "compareAtPriceCents": 17999,
      "currency": "USD",
      "availability": "in_stock",
      "inventoryQuantity": 12,
      "featured": true,
      "tags": ["beginner", "refractor"],
      "specifications": [{ "label": "Aperture", "value": "70mm" }],
      "images": [
        {
          "src": "/products/stellar-70-refractor.svg",
          "alt": "Stellar 70 Refractor"
        }
      ]
    }
  ],
  "categories": [
    {
      "id": "telescopes",
      "label": "Telescopes",
      "description": "Explore the Moon, planets and deep-sky objects.",
      "count": 8
    },
    {
      "id": "binoculars",
      "label": "Binoculars",
      "description": "Portable optics for stargazing and daytime adventures.",
      "count": 7
    },
    {
      "id": "accessories",
      "label": "Accessories",
      "description": "Essential upgrades for clearer, more comfortable observing.",
      "count": 9
    }
  ]
}
```

**Product fields:**

| Field                 | Type                                                | Notes                                       |
| --------------------- | --------------------------------------------------- | ------------------------------------------- |
| `id`                  | string                                              | Lowercase slug, e.g. `stellar-70-refractor` |
| `sku`                 | string                                              | Unique stock-keeping unit                   |
| `name`                | string                                              | Display name (≤ 120 chars)                  |
| `category`            | `"telescopes"` \| `"binoculars"` \| `"accessories"` |                                             |
| `shortDescription`    | string                                              | ≤ 180 chars                                 |
| `description`         | string                                              | ≤ 800 chars                                 |
| `priceCents`          | integer                                             | Price in US cents (≥ 1)                     |
| `compareAtPriceCents` | integer?                                            | Only present when > `priceCents`            |
| `currency`            | `"USD"`                                             | Always USD                                  |
| `availability`        | `"in_stock"` \| `"low_stock"` \| `"out_of_stock"`   |                                             |
| `inventoryQuantity`   | integer 0–99                                        | 0 iff `out_of_stock`; ≤ 5 for `low_stock`   |
| `featured`            | boolean                                             |                                             |
| `tags`                | string[]                                            | 1–12 unique tags                            |
| `specifications`      | `{label,value}[]`                                   | ≥ 3 rows                                    |
| `images`              | `{src,alt}[]`                                       | 1–4 images; `src` starts with `/products/`  |

---

### GET /api/products/:id

Returns a single product by its slug ID.

**Response `200`:**

```json
{ "product": { ...same shape as list item... } }
```

**Response `400`** — invalid URL encoding:

```json
{
  "error": {
    "code": "INVALID_PRODUCT_ID",
    "message": "Product ID must use valid URL encoding.",
    "requestId": "..."
  }
}
```

**Response `404`** — product not found:

```json
{
  "error": {
    "code": "PRODUCT_NOT_FOUND",
    "message": "Product was not found.",
    "requestId": "..."
  }
}
```

---

### Error Response Shape

All error responses use this envelope:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description.",
    "requestId": "..."
  }
}
```

| Code                 | HTTP | Meaning                                  |
| -------------------- | ---- | ---------------------------------------- |
| `PRODUCT_NOT_FOUND`  | 404  | No product with the requested ID         |
| `INVALID_PRODUCT_ID` | 400  | Malformed URL encoding in product ID     |
| `METHOD_NOT_ALLOWED` | 405  | Non-GET request on any route             |
| `ROUTE_NOT_FOUND`    | 404  | Path not recognised                      |
| `NOT_READY`          | 503  | Server is shutting down (`/readyz` only) |

---

## Local Examples

Start Catalog API first:

```powershell
$env:CATALOG_PORT = "3001"
npm run dev -w @techx/catalog-api
```

### List all products

```powershell
Invoke-RestMethod http://localhost:3001/api/products | ConvertTo-Json -Depth 1
```

```bash
curl -s http://localhost:3001/api/products | jq '{total: (.products | length), categories: [.categories[] | {id,count}]}'
```

**Expected:**

```json
{
  "total": 24,
  "categories": [
    { "id": "telescopes", "count": 8 },
    { "id": "binoculars", "count": 7 },
    { "id": "accessories", "count": 9 }
  ]
}
```

---

### Get product detail

```bash
curl -s http://localhost:3001/api/products/stellar-70-refractor | jq .product.name
```

**Expected:** `"Stellar 70 Refractor"`

---

### Product not found

```bash
curl -s http://localhost:3001/api/products/does-not-exist
```

**Expected `404`:**

```json
{
  "error": {
    "code": "PRODUCT_NOT_FOUND",
    "message": "Product was not found.",
    "requestId": "..."
  }
}
```

---

### Request-ID propagation

```bash
curl -s -H "x-request-id: my-trace-123" http://localhost:3001/api/products | head -c 1
# Response header: x-request-id: my-trace-123
```

---

### Health check

```bash
curl -s http://localhost:3001/healthz
```

**Expected `200`:** `{"status":"ok","service":"catalog-api"}`

---

## Running Tests

```powershell
# Type-check
npm run check -w @techx/catalog-api

# Unit + HTTP tests
npm run test -w @techx/catalog-api
```

Tests use the built-in Node.js `node:test` runner with `tsx` for TypeScript.
No test database or network access is required — all tests are in-process.

### Test coverage

| File                   | What it covers                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test/catalog.test.ts` | Seed validation (24 products, 7 featured, 3 compare-at, 1 out-of-stock), category facets (8/7/9), duplicate ID detection, inconsistent inventory rejection                     |
| `test/server.test.ts`  | `/healthz` and `/readyz` availability, product list (24 items, request-ID echo, category sum), product detail (200 + 404), `405` for POST, `400` for malformed URL-encoded IDs |
