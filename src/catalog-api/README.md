# Catalog API

Validated static product catalog HTTP API. The v2 seed contains 24 products with
explicit category, availability, inventory, pricing, specifications, tags, and
local image metadata. Startup fails fast when seed data is invalid.

```powershell
npm run dev -w @techx/catalog-api
npm run test -w @techx/catalog-api
```

Endpoints: `GET /healthz`, `GET /readyz`, `GET /api/products`, and
`GET /api/products/{id}`. The list response includes derived category facets so
frontend components never hard-code category counts.
