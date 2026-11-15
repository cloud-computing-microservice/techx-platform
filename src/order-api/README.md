# @techx/order-api

Authenticated, idempotent order HTTP API backed by DynamoDB. Owns pricing
totals, shipping configuration, inventory enforcement, masked customer data,
confirmation status, and estimated demo delivery dates.

## Responsibilities

- Authenticates every order endpoint with a shared `X-TechX-Api-Key` header
  compared using `timingSafeEqual` to prevent timing attacks.
- Accepts `POST /api/orders` to create new orders idempotently.
- Serves `GET /api/orders/:id` to retrieve a previously created order.
- Exposes `GET /api/store-config` (unauthenticated) for shipping/quantity/TTL
  constants consumed by the frontend.
- Validates order items, customer, and shipping address before calling Catalog API.
- Fetches each product from Catalog API with up to 2 retries and enforces
  availability and inventory constraints.
- Calculates `subtotalCents`, `shippingCents`, and `totalCents` from catalog
  price snapshots (never frontend-supplied prices).
- Hashes raw idempotency keys with SHA-256 before storing in DynamoDB.
- Uses a DynamoDB `TransactWriteCommand` to atomically commit order + idempotency
  records, preventing duplicate orders under concurrent requests.
- Masks customer `email` and strips street address before persisting.
- Applies application-level TTL checks in addition to DynamoDB TTL enforcement.
- Logs structured JSON to stdout: `timestamp`, `level`, `service`, `method`,
  `path`, `status`, `durationMs`, `requestId`.

## Code Structure

```
src/order-api/
├── src/
│   ├── catalog-client.ts              # CatalogClient: HTTP client for Catalog API (retries, timeout)
│   ├── commerce.ts                    # Pricing constants, shippingCentsFor(), storeConfig(), maskEmail(), addBusinessDays()
│   ├── dynamodb-order-repository.ts   # DynamoDbOrderRepository: production DynamoDB implementation
│   ├── main.ts                        # Entry point: reads env vars, wires dependencies, starts server
│   ├── order-store.ts                 # OrderRepository interface, FakeOrderRepository (tests), buildOrder()
│   ├── server.ts                      # createOrderServer(): all route handling, request parsing, auth
│   └── types.ts                       # TypeScript types: Product, Order, OrderItem, StoreConfig, etc.
├── test/
│   ├── dynamodb-order-repository.test.ts  # Unit: DynamoDB command shape, TTL enforcement, idempotency hashing, concurrency
│   ├── dynamodb.integration.ts            # Integration: runs against real DynamoDB Local (needs DYNAMODB_TEST_ENDPOINT)
│   ├── order-store.test.ts                # Unit: FakeOrderRepository — TTL expiry, replay, conflict, pricing, data masking
│   └── server.test.ts                     # HTTP: auth, order create/lookup, idempotency, inventory, pricing, catalog 503
├── Dockerfile
├── package.json
├── README.md
└── tsconfig.json
```

## Environment Variables

| Variable                              | Required        | Default                 | Description                                                                       |
| ------------------------------------- | --------------- | ----------------------- | --------------------------------------------------------------------------------- |
| `ORDER_PORT`                          | No              | `3002`                  | TCP port the server listens on                                                    |
| `CATALOG_API_URL`                     | No              | `http://localhost:3001` | Base URL of Catalog API                                                           |
| `ORDER_API_KEY`                       | Yes (≥ 8 chars) | —                       | Shared secret; sent in `X-TechX-Api-Key` by callers                               |
| `ORDER_TABLE_NAME`                    | Yes             | —                       | DynamoDB table name                                                               |
| `AWS_REGION`                          | Yes             | —                       | AWS region for DynamoDB client                                                    |
| `ORDER_STORE_TTL_MS`                  | No              | `2592000000` (30 days)  | Order record TTL in milliseconds                                                  |
| `ORDER_IDEMPOTENCY_TTL_MS`            | No              | `86400000` (24 hours)   | Idempotency record TTL in milliseconds                                            |
| `ORDER_LOCAL_MODE`                    | No              | —                       | Set `true` to allow `DYNAMODB_ENDPOINT` override                                  |
| `DYNAMODB_ENDPOINT`                   | No              | —                       | Custom DynamoDB endpoint; only valid when `ORDER_LOCAL_MODE=true` and not staging |
| `DYNAMODB_MAX_ATTEMPTS`               | No              | `3`                     | DynamoDB SDK retry attempts                                                       |
| `DYNAMODB_CONNECT_TIMEOUT_MS`         | No              | `500`                   | DynamoDB connection timeout in ms                                                 |
| `DYNAMODB_REQUEST_TIMEOUT_MS`         | No              | `1500`                  | DynamoDB request timeout in ms                                                    |
| `DEPLOYMENT_ENVIRONMENT` / `NODE_ENV` | No              | —                       | Set to `staging` to block custom DynamoDB endpoints                               |

> **Security:** `DYNAMODB_ENDPOINT` is rejected unless `ORDER_LOCAL_MODE=true`.
> When `DEPLOYMENT_ENVIRONMENT=staging` (or `NODE_ENV=staging`), custom endpoints
> are always blocked regardless of `ORDER_LOCAL_MODE`.

## DynamoDB Local Setup

### Docker (recommended for local dev)

```powershell
# Full stack via Docker Compose (recommended)
Copy-Item .env.example .env
# Edit .env: set ORDER_API_KEY to any random string >= 8 chars
docker compose up --build
```

Compose starts DynamoDB Local with persistent volume (`dynamodb-data`), runs
`scripts/bootstrap-dynamodb.sh` to create the table and enable TTL, then starts
Catalog API and Order API in dependency order.

### Manual Docker Compose (Order API only)

```powershell
# 1. Start DynamoDB Local
docker run -d --name techx-dynamodb -p 8000:8000 amazon/dynamodb-local:2.6.1 `
  -jar DynamoDBLocal.jar -sharedDb -dbPath /data

# 2. Create the table (run once per container)
$env:AWS_ACCESS_KEY_ID = "local"
$env:AWS_SECRET_ACCESS_KEY = "local"
$env:AWS_DEFAULT_REGION = "us-east-1"
aws dynamodb create-table `
  --endpoint-url http://localhost:8000 `
  --table-name techx-orders-local `
  --attribute-definitions AttributeName=pk,AttributeType=S `
  --key-schema AttributeName=pk,KeyType=HASH `
  --billing-mode PAY_PER_REQUEST

# 3. Enable TTL
aws dynamodb update-time-to-live `
  --endpoint-url http://localhost:8000 `
  --table-name techx-orders-local `
  --time-to-live-specification Enabled=true,AttributeName=ttlEpochSeconds
```

### DynamoDB Table Schema

| Attribute         | Type              | Role                                                                          |
| ----------------- | ----------------- | ----------------------------------------------------------------------------- |
| `pk`              | String (hash key) | `ORDER#ord_<uuid>` for orders; `IDEMPOTENCY#sha256(<rawKey>)` for idempotency |
| `entityType`      | String            | `"ORDER"` or `"IDEMPOTENCY"`                                                  |
| `order`           | Map               | Full `Order` object (for `ORDER` records)                                     |
| `payloadHash`     | String            | SHA-256 of canonical request payload (for `IDEMPOTENCY` records)              |
| `orderId`         | String            | References the linked `ORDER` record (for `IDEMPOTENCY` records)              |
| `ttlEpochSeconds` | Number            | Unix epoch seconds; DynamoDB TTL attribute                                    |

Writes use `TransactWriteCommand` with `attribute_not_exists(pk)` condition on
the order record and `attribute_not_exists(pk) OR ttlEpochSeconds <= :now` on
the idempotency record. This guarantees atomicity under concurrent requests.

## Startup Instructions

### Development (auto-reload)

```powershell
# Set required environment variables
$env:ORDER_API_KEY        = "local-demo-key"
$env:ORDER_TABLE_NAME     = "techx-orders-local"
$env:AWS_REGION           = "us-east-1"
$env:AWS_ACCESS_KEY_ID    = "local"
$env:AWS_SECRET_ACCESS_KEY = "local"
$env:ORDER_LOCAL_MODE     = "true"
$env:DYNAMODB_ENDPOINT    = "http://localhost:8000"
$env:CATALOG_API_URL      = "http://localhost:3001"

npm run dev -w @techx/order-api
```

### Production build and start

```powershell
npm run build -w @techx/order-api
npm run start -w @techx/order-api
```

## Pricing Logic

All prices are taken from the Catalog API at order-creation time. No
client-supplied prices are accepted.

```
subtotalCents = Σ (product.priceCents × item.quantity)
shippingCents = 999   if subtotalCents < 5000
              = 0     if subtotalCents ≥ 5000   (free shipping)
totalCents    = subtotalCents + shippingCents
```

| Constant                                   | Value               |
| ------------------------------------------ | ------------------- |
| Free shipping threshold                    | 5000 cents ($50.00) |
| Standard shipping fee                      | 999 cents ($9.99)   |
| Max quantity per item (per line or merged) | 99                  |
| Max order lines (before merge)             | 20                  |

Duplicate `productId` entries within a single request are **merged** before
validation. After merging, the combined quantity must still be ≤ 99.

## Idempotency

Order creation requires the `Idempotency-Key` header (8–128 characters).
The raw key is **never stored**; a SHA-256 hash of it is used as the DynamoDB
partition key (`IDEMPOTENCY#<sha256hex>`).

| Scenario                      | HTTP Status                | Body                                 |
| ----------------------------- | -------------------------- | ------------------------------------ |
| New request                   | 201                        | `{ order, idempotentReplay: false }` |
| Same key + same payload       | 200                        | `{ order, idempotentReplay: true }`  |
| Same key + different payload  | 409 `IDEMPOTENCY_CONFLICT` | Error envelope                       |
| Concurrent identical requests | 200 or 201                 | Both return the same `order.id`      |

The DynamoDB transaction serialises concurrent writes: exactly one `Create`
succeeds and all others reconcile to the winner's order via idempotency lookup.

Idempotency records expire after `ORDER_IDEMPOTENCY_TTL_MS` (default 24 hours).
Order records expire after `ORDER_STORE_TTL_MS` (default 30 days).

## Data Retention and Customer Data Protection

The Order API stores only the following customer fields in DynamoDB:

| Input field                   | Stored as                                             |
| ----------------------------- | ----------------------------------------------------- |
| `customer.name`               | `customer.name` (verbatim)                            |
| `customer.email`              | `customer.emailMasked` — first 2 chars + `***@domain` |
| `shippingAddress.line1`       | **not stored**                                        |
| `shippingAddress.line2`       | **not stored**                                        |
| `shippingAddress.city`        | `shippingAddress.city`                                |
| `shippingAddress.region`      | `shippingAddress.region` (uppercased)                 |
| `shippingAddress.postalCode`  | `shippingAddress.postalCode`                          |
| `shippingAddress.countryCode` | `shippingAddress.countryCode` (`"US"`)                |

Full email and street lines are **validated in-flight but never persisted**. No
payment credentials are accepted or stored at any point.

Order records are retained for 30 days (configurable via `ORDER_STORE_TTL_MS`).
Both DynamoDB TTL and an application-level `active()` check enforce expiry;
records where `ttlEpochSeconds ≤ now` are treated as missing even before
DynamoDB cleans them up.

## API Reference

All responses include:

- `Content-Type: application/json; charset=utf-8`
- `Cache-Control: no-store`
- `x-request-id` — echoes `x-request-id` header (if valid) or assigns a UUID.

### GET /healthz

Liveness probe. Always `200`, even during graceful shutdown (unauthenticated).

**Response `200`:**

```json
{ "status": "ok", "service": "order-api" }
```

---

### GET /readyz

Readiness probe. Returns `503` after the server begins closing (unauthenticated).

**Response `200`:**

```json
{ "status": "ready", "service": "order-api" }
```

**Response `503`:**

```json
{
  "error": {
    "code": "NOT_READY",
    "message": "Order API is shutting down.",
    "requestId": "..."
  }
}
```

---

### GET /api/store-config

Returns shipping and quantity constants for the frontend. **Unauthenticated.**

**Response `200`:**

```json
{
  "config": {
    "currency": "USD",
    "freeShippingThresholdCents": 5000,
    "standardShippingCents": 999,
    "maxQuantityPerItem": 99,
    "orderTtlSeconds": 2592000,
    "shippingMethods": [
      {
        "id": "standard",
        "label": "Standard delivery",
        "description": "Estimated in 3–5 business days"
      }
    ]
  }
}
```

---

### POST /api/orders

Creates a new order. Requires `X-TechX-Api-Key` and `Idempotency-Key` headers.

**Request headers:**

| Header            | Required | Description                      |
| ----------------- | -------- | -------------------------------- |
| `X-TechX-Api-Key` | Yes      | Shared secret (`ORDER_API_KEY`)  |
| `Idempotency-Key` | Yes      | 8–128 character unique key       |
| `Content-Type`    | Yes      | Must be `application/json`       |
| `x-request-id`    | No       | Traced through logs and response |

**Request body:**

```json
{
  "items": [{ "productId": "stellar-70-refractor", "quantity": 1 }],
  "customer": {
    "name": "Jane Doe",
    "email": "jane@example.com"
  },
  "shippingAddress": {
    "line1": "123 Main Street",
    "line2": "Apt 4B",
    "city": "Seattle",
    "region": "WA",
    "postalCode": "98101",
    "countryCode": "US"
  },
  "shippingMethod": "standard"
}
```

> `line2` is optional. `countryCode` must be `"US"`. `shippingMethod` must be
> `"standard"`. `postalCode` must match `12345` or `12345-6789` format.

**Response `201`** (new order created):

```json
{
  "order": {
    "id": "ord_550e8400-e29b-41d4-a716-446655440000",
    "items": [
      {
        "productId": "stellar-70-refractor",
        "quantity": 1,
        "sku": "TEL-STL-70",
        "name": "Stellar 70 Refractor",
        "image": "/products/stellar-70-refractor.svg",
        "unitPriceCents": 14999,
        "lineTotalCents": 14999
      }
    ],
    "customer": {
      "name": "Jane Doe",
      "emailMasked": "ja**@example.com"
    },
    "shippingAddress": {
      "city": "Seattle",
      "region": "WA",
      "postalCode": "98101",
      "countryCode": "US"
    },
    "status": "confirmed",
    "shippingMethod": "standard",
    "estimatedDelivery": {
      "from": "2026-11-19T00:00:00.000Z",
      "to": "2026-11-21T00:00:00.000Z"
    },
    "subtotalCents": 14999,
    "shippingCents": 0,
    "totalCents": 14999,
    "createdAt": "2026-11-15T10:00:00.000Z",
    "expiresAt": "2026-12-15T10:00:00.000Z"
  }
}
```

**Response `200`** (idempotent replay):

```json
{
  "order": { "...same as above..." },
  "idempotentReplay": true
}
```

---

### GET /api/orders/:id

Looks up an existing order by its ID. Requires `X-TechX-Api-Key`.
Order IDs match `/^ord_[0-9a-f-]+$/i`.

**Request headers:**

| Header            | Required | Description                      |
| ----------------- | -------- | -------------------------------- |
| `X-TechX-Api-Key` | Yes      | Shared secret                    |
| `x-request-id`    | No       | Traced through logs and response |

**Response `200`:**

```json
{ "order": { "...same shape as POST response..." } }
```

**Response `404`:**

```json
{
  "error": {
    "code": "ORDER_NOT_FOUND",
    "message": "Order was not found or has expired.",
    "requestId": "..."
  }
}
```

---

### Error Codes Reference

| Code                           | HTTP | Trigger                                                |
| ------------------------------ | ---- | ------------------------------------------------------ |
| `UNAUTHORIZED`                 | 401  | Missing or invalid `X-TechX-Api-Key`                   |
| `INVALID_CONTENT_TYPE`         | 400  | `Content-Type` is not `application/json`               |
| `BODY_TOO_LARGE`               | 400  | Request body > 16 KB                                   |
| `INVALID_JSON`                 | 400  | Body is not valid JSON                                 |
| `INVALID_ORDER`                | 400  | Missing/extra fields in order body                     |
| `INVALID_ITEMS`                | 400  | Items array is empty or > 20 entries                   |
| `INVALID_ITEM`                 | 400  | Item has wrong shape                                   |
| `INVALID_QUANTITY`             | 400  | Quantity < 1, > 99, or merged total > 99               |
| `INVALID_CUSTOMER`             | 400  | Bad name, invalid email format                         |
| `INVALID_SHIPPING_ADDRESS`     | 400  | Missing fields, non-US country, bad postal code format |
| `INVALID_SHIPPING_METHOD`      | 400  | Anything other than `"standard"`                       |
| `INVALID_IDEMPOTENCY_KEY`      | 400  | Key < 8 or > 128 characters                            |
| `INVALID_PRODUCT`              | 400  | Product ID not found in Catalog                        |
| `PRODUCT_OUT_OF_STOCK`         | 409  | Product availability is `out_of_stock`                 |
| `INSUFFICIENT_INVENTORY`       | 409  | Requested quantity > `inventoryQuantity`               |
| `IDEMPOTENCY_CONFLICT`         | 409  | Same key reused with a different payload               |
| `ORDER_NOT_FOUND`              | 404  | Order ID not found or expired                          |
| `METHOD_NOT_ALLOWED`           | 405  | Unsupported HTTP method on `/api/orders`               |
| `ROUTE_NOT_FOUND`              | 404  | Path not recognised                                    |
| `CATALOG_UNAVAILABLE`          | 503  | Catalog API returned a non-404 error or timed out      |
| `ORDER_REPOSITORY_UNAVAILABLE` | 503  | DynamoDB error                                         |
| `INTERNAL_ERROR`               | 500  | Unexpected error                                       |

---

## Local Examples

### Setup environment

```powershell
$env:ORDER_API_KEY         = "local-demo-key"
$env:ORDER_TABLE_NAME      = "techx-orders-local"
$env:AWS_REGION            = "us-east-1"
$env:AWS_ACCESS_KEY_ID     = "local"
$env:AWS_SECRET_ACCESS_KEY = "local"
$env:ORDER_LOCAL_MODE      = "true"
$env:DYNAMODB_ENDPOINT     = "http://localhost:8000"
$env:CATALOG_API_URL       = "http://localhost:3001"
```

Start services (DynamoDB Local must already be running and table created):

```powershell
# Terminal 1 — Catalog API
npm run dev -w @techx/catalog-api

# Terminal 2 — Order API
npm run dev -w @techx/order-api
```

---

### Create an order (subtotal < $50 → shipping $9.99)

```powershell
$IDEM_KEY = [System.Guid]::NewGuid().ToString()
$body = @{
  items           = @(@{ productId = "trail-8x42-binoculars"; quantity = 1 })
  customer        = @{ name = "Local Test"; email = "test@example.com" }
  shippingAddress = @{
    line1       = "100 Test St"
    city        = "Seattle"
    region      = "WA"
    postalCode  = "98101"
    countryCode = "US"
  }
  shippingMethod = "standard"
} | ConvertTo-Json -Depth 6

$response = Invoke-RestMethod -Method Post `
  -Uri "http://localhost:3002/api/orders" `
  -Headers @{ "X-TechX-Api-Key" = "local-demo-key"; "Idempotency-Key" = $IDEM_KEY } `
  -ContentType "application/json" -Body $body
$response.order | Select-Object id, subtotalCents, shippingCents, totalCents
```

```bash
IDEM_KEY=$(uuidgen)
curl -s -X POST http://localhost:3002/api/orders \
  -H "X-TechX-Api-Key: local-demo-key" \
  -H "Idempotency-Key: $IDEM_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "items": [{"productId":"trail-8x42-binoculars","quantity":1}],
    "customer": {"name":"Local Test","email":"test@example.com"},
    "shippingAddress": {"line1":"100 Test St","city":"Seattle","region":"WA","postalCode":"98101","countryCode":"US"},
    "shippingMethod":"standard"
  }' | jq '{id:.order.id, subtotal:.order.subtotalCents, shipping:.order.shippingCents, total:.order.totalCents}'
```

**Expected `201`:**

```json
{ "id": "ord_...", "subtotal": <priceCents>, "shipping": 999, "total": <subtotal+999> }
```

---

### Idempotent replay (same key, same body → 200 + idempotentReplay)

```bash
# Repeat the same curl above with the same $IDEM_KEY
# Expected 200: {"order":{...},"idempotentReplay":true}
```

---

### Idempotency conflict (same key, different body → 409)

```bash
curl -s -X POST http://localhost:3002/api/orders \
  -H "X-TechX-Api-Key: local-demo-key" \
  -H "Idempotency-Key: $IDEM_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "items": [{"productId":"trail-8x42-binoculars","quantity":2}],
    "customer": {"name":"Local Test","email":"test@example.com"},
    "shippingAddress": {"line1":"100 Test St","city":"Seattle","region":"WA","postalCode":"98101","countryCode":"US"},
    "shippingMethod":"standard"
  }'
```

**Expected `409`:**

```json
{ "error": { "code": "IDEMPOTENCY_CONFLICT", ... } }
```

---

### Order lookup

```bash
ORDER_ID="ord_<id-from-create-response>"
curl -s http://localhost:3002/api/orders/$ORDER_ID \
  -H "X-TechX-Api-Key: local-demo-key" | jq .order.status
```

**Expected `200`:** `"confirmed"`

---

### Missing API key → 401

```bash
curl -s http://localhost:3002/api/orders/ord_00000000-0000-0000-0000-000000000000
```

**Expected `401`:**

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "A valid X-TechX-Api-Key header is required.",
    "requestId": "..."
  }
}
```

---

### Out-of-stock product → 409

```bash
# Find the out-of-stock product ID from the catalog first:
OUT_OF_STOCK=$(curl -s http://localhost:3001/api/products | jq -r '.products[] | select(.availability=="out_of_stock") | .id' | head -1)
curl -s -X POST http://localhost:3002/api/orders \
  -H "X-TechX-Api-Key: local-demo-key" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d "{\"items\":[{\"productId\":\"$OUT_OF_STOCK\",\"quantity\":1}],\"customer\":{\"name\":\"Test\",\"email\":\"t@example.com\"},\"shippingAddress\":{\"line1\":\"1 St\",\"city\":\"Seattle\",\"region\":\"WA\",\"postalCode\":\"98101\",\"countryCode\":\"US\"},\"shippingMethod\":\"standard\"}"
```

**Expected `409`:** `{"error":{"code":"PRODUCT_OUT_OF_STOCK",...}}`

---

### Store config (no auth)

```bash
curl -s http://localhost:3002/api/store-config | jq .config
```

---

## Running Tests

```powershell
# Type-check
npm run check -w @techx/order-api

# Unit + HTTP tests (no DynamoDB required)
npm run test -w @techx/order-api

# DynamoDB Local integration tests
# Option A: use the helper script (auto-starts and removes an isolated container)
.\scripts\test-dynamodb.ps1

# Option B: manual (DynamoDB Local already running on a free port)
$env:DYNAMODB_TEST_ENDPOINT = "http://127.0.0.1:8000"
npm run test:dynamodb -w @techx/order-api
```

> `test:dynamodb` requires `DYNAMODB_TEST_ENDPOINT` to be set to a
> `http://127.0.0.1:<port>` URL. AWS endpoints are forbidden by the test guard.
> The test creates its own random-named table and deletes it on teardown.

### Test coverage

| File                                     | What it covers                                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test/server.test.ts`                    | Auth (401), store-config (unauthenticated), order create (201 + pricing + merge), idempotent replay (200), conflict (409), invalid input (400), unknown product (400), out-of-stock (409), insufficient inventory (409), Catalog 503 → 503, request-ID propagation, repository unavailable → 503 |
| `test/order-store.test.ts`               | FakeOrderRepository: order + idempotency TTL expiry, replay, conflict, pricing math, emailMasked format, street address not stored, estimated delivery dates                                                                                                                                     |
| `test/dynamodb-order-repository.test.ts` | Idempotency key hashed (never stored raw), strong reads (`ConsistentRead: true`), TTL ceiling, DynamoDB transaction shape, concurrent winner reconciliation, UUID collision retry, non-conditional cancellation → 503, active idempotency pointing to missing order → 503                        |
| `test/dynamodb.integration.ts`           | 12 concurrent requests on the same key → 1 order created; different payloads racing one key → conflict; order survives a new repository instance (simulates restart)                                                                                                                             |
