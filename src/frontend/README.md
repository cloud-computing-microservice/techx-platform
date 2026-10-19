# Frontend

Next.js storefront and server-side BFF.

```powershell
$env:CATALOG_API_URL='http://localhost:3001'
$env:ORDER_API_URL='http://localhost:3002'
$env:ORDER_API_KEY='local-demo-key'
npm run dev -w @techx/frontend
```

The browser calls only same-origin `/api/*` routes. `ORDER_API_KEY` is read only by server route handlers and must never use a `NEXT_PUBLIC_` prefix.

The storefront uses Product v2 and Order v2 contracts. Catalog, facets, hero
product, price, promotion, availability, inventory, shipping, status, ETA, and
TTL are API/config driven. Routes, navigation, UI copy, presentation mappings,
and design tokens have centralized owners; production components do not embed
product fixtures or business-rule magic values. Checkout never requests card
details and clearly identifies itself as a non-transactional demo.

The BFF applies dependency timeouts and GET retries, forwards request IDs,
rate-limits order creation to 20 attempts per client per minute, and bounds
request bodies to 16 KiB while streaming. The limiter retains at most 10,000
client buckets per process. Orders persist in DynamoDB for 30 days by default;
idempotency records last 24 hours. The frontend stores no database credentials.

Local checks:

```powershell
npm run check -w @techx/frontend
npm run test -w @techx/frontend
npm run build -w @techx/frontend
./scripts/ui-hardcode-audit.ps1
```
