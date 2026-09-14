# Order API

Authenticated, idempotent order HTTP API backed by DynamoDB. It owns pricing
totals, shipping configuration, inventory enforcement, masked customer data,
confirmation status, and estimated demo delivery dates.

```powershell
$env:ORDER_API_KEY='local-demo-key'
$env:CATALOG_API_URL='http://localhost:3001'
$env:ORDER_TABLE_NAME='techx-orders-local'
$env:AWS_REGION='us-east-1'
$env:AWS_ACCESS_KEY_ID='local'
$env:AWS_SECRET_ACCESS_KEY='local'
$env:ORDER_LOCAL_MODE='true'
$env:DYNAMODB_ENDPOINT='http://localhost:8000'
npm run dev -w @techx/order-api
npm run test -w @techx/order-api
```

The default retention is 30 days for orders (`ORDER_STORE_TTL_MS=2592000000`)
and 24 hours for idempotency records (`ORDER_IDEMPOTENCY_TTL_MS=86400000`).
`DYNAMODB_ENDPOINT` is rejected unless `ORDER_LOCAL_MODE=true`, and staging
always rejects a custom endpoint. Docker Compose starts persistent DynamoDB
Local storage and idempotently creates the table before Order API starts.

`GET /api/store-config` is unauthenticated and exposes the frontend-safe shipping,
quantity, and TTL contract. Order create/lookup endpoints require the demo key;
create also requires an idempotency key. No payment credential is accepted or
stored. Full email and street address are validated for the request but are not
retained in the persisted order. Raw idempotency keys are SHA-256 hashed before
DynamoDB access and are never stored.
