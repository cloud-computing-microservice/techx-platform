import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CatalogClient } from "../src/catalog-client.js";
import {
  FakeOrderRepository,
  RepositoryUnavailableError,
} from "../src/order-store.js";
import { createOrderServer } from "../src/server.js";

const API_KEY = "test-demo-key";
let catalogServer: Server;
let orderServer: Server;
let orderBaseUrl = "";
let catalogMode: "normal" | "unavailable" = "normal";

const products = new Map([
  [
    "product-1",
    {
      id: "product-1",
      sku: "TEST-001",
      name: "Product 1",
      category: "accessories",
      shortDescription: "Product one",
      description: "One",
      priceCents: 500,
      currency: "USD",
      availability: "in_stock",
      inventoryQuantity: 8,
      featured: false,
      tags: ["test"],
      specifications: [{ label: "Type", value: "Test" }],
      images: [{ src: "/products/one.svg", alt: "Product one" }],
    },
  ],
  [
    "product-2",
    {
      id: "product-2",
      sku: "TEST-002",
      name: "Product 2",
      category: "accessories",
      shortDescription: "Product two",
      description: "Two",
      priceCents: 700,
      currency: "USD",
      availability: "in_stock",
      inventoryQuantity: 5,
      featured: false,
      tags: ["test"],
      specifications: [{ label: "Type", value: "Test" }],
      images: [{ src: "/products/two.svg", alt: "Product two" }],
    },
  ],
  [
    "product-3",
    {
      id: "product-3",
      sku: "TEST-003",
      name: "Unavailable Product",
      category: "accessories",
      shortDescription: "Unavailable test product",
      description: "Unavailable",
      priceCents: 900,
      currency: "USD",
      availability: "out_of_stock",
      inventoryQuantity: 0,
      featured: false,
      tags: ["test"],
      specifications: [{ label: "Type", value: "Test" }],
      images: [{ src: "/products/three.svg", alt: "Unavailable product" }],
    },
  ],
  [
    "product-low-stock",
    {
      id: "product-low-stock",
      sku: "TEST-004",
      name: "Low Stock Product",
      category: "accessories",
      shortDescription: "Only 2 left",
      description: "Low stock",
      priceCents: 300,
      currency: "USD",
      availability: "low_stock",
      inventoryQuantity: 2,
      featured: false,
      tags: ["test"],
      specifications: [{ label: "Type", value: "Test" }],
      images: [{ src: "/products/four.svg", alt: "Low stock" }],
    },
  ],
  // Product priced at exactly $50 (5000 cents) → free shipping threshold
  [
    "product-threshold",
    {
      id: "product-threshold",
      sku: "TEST-005",
      name: "Threshold Product",
      category: "telescopes",
      shortDescription: "Exactly at shipping threshold",
      description: "Threshold",
      priceCents: 5000,
      currency: "USD",
      availability: "in_stock",
      inventoryQuantity: 10,
      featured: false,
      tags: ["test"],
      specifications: [{ label: "Type", value: "Test" }],
      images: [{ src: "/products/five.svg", alt: "Threshold" }],
    },
  ],
]);

before(async () => {
  catalogServer = createServer((request, response) => {
    if (catalogMode === "unavailable") {
      response.statusCode = 503;
      response.end("{}");
      return;
    }
    const path = new URL(request.url ?? "/", "http://catalog.test").pathname;
    const match = path.match(/^\/api\/products\/([^/]+)$/);
    const product = match
      ? products.get(decodeURIComponent(match[1] ?? ""))
      : undefined;
    response.setHeader("content-type", "application/json");
    response.statusCode = product ? 200 : 404;
    response.end(
      JSON.stringify(
        product ? { product } : { error: { code: "PRODUCT_NOT_FOUND" } },
      ),
    );
  });
  await new Promise<void>((resolve) =>
    catalogServer.listen(0, "127.0.0.1", resolve),
  );
  const catalogAddress = catalogServer.address() as AddressInfo;

  orderServer = createOrderServer({
    apiKey: API_KEY,
    catalogClient: new CatalogClient({
      baseUrl: `http://127.0.0.1:${catalogAddress.port}`,
      timeoutMs: 250,
      retries: 0,
    }),
    repository: new FakeOrderRepository(60_000, 60_000),
    orderTtlMs: 60_000,
    logger: () => undefined,
  });
  await new Promise<void>((resolve) =>
    orderServer.listen(0, "127.0.0.1", resolve),
  );
  const orderAddress = orderServer.address() as AddressInfo;
  orderBaseUrl = `http://127.0.0.1:${orderAddress.port}`;
});

after(async () => {
  await Promise.all([
    new Promise<void>((resolve, reject) =>
      orderServer.close((error) => (error ? reject(error) : resolve())),
    ),
    new Promise<void>((resolve, reject) =>
      catalogServer.close((error) => (error ? reject(error) : resolve())),
    ),
  ]);
});

function orderRequest(body: unknown, key: string): Promise<Response> {
  return fetch(`${orderBaseUrl}/api/orders`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-techx-api-key": API_KEY,
      "idempotency-key": key,
    },
    body: JSON.stringify(body),
  });
}

function checkout(items: Array<{ productId: string; quantity: number }>) {
  return {
    items,
    customer: { name: "Test Customer", email: "test@example.com" },
    shippingAddress: {
      line1: "100 Test Street",
      city: "Seattle",
      region: "WA",
      postalCode: "98101",
      countryCode: "US",
    },
    shippingMethod: "standard",
  };
}

// ── Health and unauthenticated endpoints ──────────────────────────────────────

test("health endpoints do not require authentication", async () => {
  const [health, readiness, config] = await Promise.all([
    fetch(`${orderBaseUrl}/healthz`),
    fetch(`${orderBaseUrl}/readyz`),
    fetch(`${orderBaseUrl}/api/store-config`),
  ]);
  assert.equal(health.status, 200);
  assert.equal(readiness.status, 200);
  assert.equal(config.status, 200);
  const configBody = (await config.json()) as {
    config: { freeShippingThresholdCents: number; orderTtlSeconds: number };
  };
  assert.equal(configBody.config.freeShippingThresholdCents, 5_000);
  assert.equal(configBody.config.orderTtlSeconds, 60);
});

test("healthz returns expected body shape", async () => {
  const response = await fetch(`${orderBaseUrl}/healthz`);
  const body = (await response.json()) as { status: string; service: string };
  assert.equal(body.status, "ok");
  assert.equal(body.service, "order-api");
});

test("readyz returns expected body shape", async () => {
  const response = await fetch(`${orderBaseUrl}/readyz`);
  const body = (await response.json()) as { status: string; service: string };
  assert.equal(body.status, "ready");
  assert.equal(body.service, "order-api");
});

test("store-config exposes shipping and quantity constants", async () => {
  const response = await fetch(`${orderBaseUrl}/api/store-config`);
  const body = (await response.json()) as {
    config: {
      currency: string;
      freeShippingThresholdCents: number;
      standardShippingCents: number;
      maxQuantityPerItem: number;
      shippingMethods: Array<{ id: string }>;
    };
  };
  assert.equal(response.status, 200);
  assert.equal(body.config.currency, "USD");
  assert.equal(body.config.freeShippingThresholdCents, 5_000);
  assert.equal(body.config.standardShippingCents, 999);
  assert.equal(body.config.maxQuantityPerItem, 99);
  assert.equal(body.config.shippingMethods[0]?.id, "standard");
});

// ── Authentication ─────────────────────────────────────────────────────────────

test("requires the internal API key for order endpoints", async () => {
  const response = await fetch(
    `${orderBaseUrl}/api/orders/ord_00000000-0000-0000-0000-000000000000`,
  );
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(response.status, 401);
  assert.equal(body.error.code, "UNAUTHORIZED");
});

test("wrong API key returns 401", async () => {
  const response = await fetch(
    `${orderBaseUrl}/api/orders/ord_00000000-0000-0000-0000-000000000000`,
    { headers: { "x-techx-api-key": "wrong-key-here" } },
  );
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(response.status, 401);
  assert.equal(body.error.code, "UNAUTHORIZED");
});

test("missing API key on POST returns 401", async () => {
  const response = await fetch(`${orderBaseUrl}/api/orders`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "test-key-12345",
    },
    body: JSON.stringify(checkout([{ productId: "product-1", quantity: 1 }])),
  });
  assert.equal(response.status, 401);
});

// ── Order creation ─────────────────────────────────────────────────────────────

test("creates an atomic multi-item order and merges duplicate items", async () => {
  const response = await orderRequest(
    checkout([
      { productId: "product-2", quantity: 1 },
      { productId: "product-1", quantity: 2 },
      { productId: "product-1", quantity: 1 },
    ]),
    "create-order-key",
  );
  const body = (await response.json()) as {
    order: {
      id: string;
      items: Array<{ productId: string; quantity: number }>;
      subtotalCents: number;
      shippingCents: number;
      totalCents: number;
    };
  };
  assert.equal(response.status, 201);
  assert.equal(body.order.items.length, 2);
  assert.deepEqual(
    body.order.items.map(({ productId, quantity }) => ({
      productId,
      quantity,
    })),
    [
      { productId: "product-1", quantity: 3 },
      { productId: "product-2", quantity: 1 },
    ],
  );
  assert.equal(body.order.subtotalCents, 2_200);
  assert.equal(body.order.shippingCents, 999);
  assert.equal(body.order.totalCents, 3_199);

  const lookup = await fetch(`${orderBaseUrl}/api/orders/${body.order.id}`, {
    headers: { "x-techx-api-key": API_KEY },
  });
  assert.equal(lookup.status, 200);
});

test("order response includes confirmed status and estimated delivery", async () => {
  const response = await orderRequest(
    checkout([{ productId: "product-1", quantity: 1 }]),
    "confirmed-status-key",
  );
  const body = (await response.json()) as {
    order: {
      id: string;
      status: string;
      shippingMethod: string;
      estimatedDelivery: { from: string; to: string };
      createdAt: string;
      expiresAt: string;
    };
  };
  assert.equal(response.status, 201);
  assert.equal(body.order.status, "confirmed");
  assert.equal(body.order.shippingMethod, "standard");
  assert.ok(body.order.estimatedDelivery.from);
  assert.ok(body.order.estimatedDelivery.to);
  assert.ok(body.order.createdAt);
  assert.ok(body.order.expiresAt);
});

test("order id matches expected ord_ prefix pattern", async () => {
  const response = await orderRequest(
    checkout([{ productId: "product-1", quantity: 1 }]),
    "id-pattern-key",
  );
  const body = (await response.json()) as { order: { id: string } };
  assert.equal(response.status, 201);
  assert.match(body.order.id, /^ord_[0-9a-f-]+$/i);
});

test("customer email is masked and street address is not stored", async () => {
  const response = await orderRequest(
    {
      items: [{ productId: "product-1", quantity: 1 }],
      customer: { name: "Jane Doe", email: "jane@example.com" },
      shippingAddress: {
        line1: "123 Private Street",
        city: "Seattle",
        region: "WA",
        postalCode: "98101",
        countryCode: "US",
      },
      shippingMethod: "standard",
    },
    "privacy-check-key",
  );
  const body = (await response.json()) as {
    order: {
      customer: { name: string; emailMasked: string };
      shippingAddress: { city: string; region: string };
    };
  };
  assert.equal(response.status, 201);
  // Email masked: first 2 chars + asterisks + @domain
  assert.match(body.order.customer.emailMasked, /^ja\*+@example\.com$/);
  // Raw email never in response
  assert.equal(
    JSON.stringify(body).includes("jane@example.com"),
    false,
    "raw email must not appear in order response",
  );
  // Street address stripped
  assert.equal(
    JSON.stringify(body).includes("123 Private Street"),
    false,
    "street address must not appear in order response",
  );
  // City and region are retained
  assert.equal(body.order.shippingAddress.city, "Seattle");
  assert.equal(body.order.shippingAddress.region, "WA");
});

// ── Pricing / shipping calculations ───────────────────────────────────────────

test("shipping is 999 cents when subtotal is below 5000", async () => {
  // product-1 priceCents = 500 → subtotal = 500 < 5000 → shipping = 999
  const response = await orderRequest(
    checkout([{ productId: "product-1", quantity: 1 }]),
    "shipping-below-threshold-key",
  );
  const body = (await response.json()) as {
    order: { subtotalCents: number; shippingCents: number; totalCents: number };
  };
  assert.equal(response.status, 201);
  assert.equal(body.order.subtotalCents, 500);
  assert.equal(body.order.shippingCents, 999);
  assert.equal(body.order.totalCents, 1_499);
});

test("shipping is free when subtotal equals 5000 (threshold)", async () => {
  // product-threshold priceCents = 5000 → subtotal = 5000 >= 5000 → shipping = 0
  const response = await orderRequest(
    checkout([{ productId: "product-threshold", quantity: 1 }]),
    "shipping-at-threshold-key",
  );
  const body = (await response.json()) as {
    order: { subtotalCents: number; shippingCents: number; totalCents: number };
  };
  assert.equal(response.status, 201);
  assert.equal(body.order.subtotalCents, 5_000);
  assert.equal(body.order.shippingCents, 0);
  assert.equal(body.order.totalCents, 5_000);
});

test("shipping is free when subtotal exceeds 5000", async () => {
  // product-threshold (5000 cents) × 2 = 10000 → free shipping
  const response = await orderRequest(
    checkout([{ productId: "product-threshold", quantity: 2 }]),
    "shipping-above-threshold-key",
  );
  const body = (await response.json()) as {
    order: { subtotalCents: number; shippingCents: number; totalCents: number };
  };
  assert.equal(response.status, 201);
  assert.equal(body.order.subtotalCents, 10_000);
  assert.equal(body.order.shippingCents, 0);
  assert.equal(body.order.totalCents, 10_000);
});

test("multi-item total is correct: subtotal = sum of lineTotals", async () => {
  // product-1 (500) × 2 = 1000; product-2 (700) × 1 = 700 → subtotal = 1700
  const response = await orderRequest(
    checkout([
      { productId: "product-1", quantity: 2 },
      { productId: "product-2", quantity: 1 },
    ]),
    "multi-item-total-key",
  );
  const body = (await response.json()) as {
    order: {
      items: Array<{ lineTotalCents: number }>;
      subtotalCents: number;
      shippingCents: number;
      totalCents: number;
    };
  };
  assert.equal(response.status, 201);
  assert.equal(body.order.subtotalCents, 1_700);
  assert.equal(body.order.shippingCents, 999);
  assert.equal(body.order.totalCents, 2_699);
  const lineSum = body.order.items.reduce((s, i) => s + i.lineTotalCents, 0);
  assert.equal(lineSum, body.order.subtotalCents);
});

// ── Order lookup ──────────────────────────────────────────────────────────────

test("lookup returns the same order that was created", async () => {
  const createResponse = await orderRequest(
    checkout([{ productId: "product-1", quantity: 1 }]),
    "lookup-key-unique",
  );
  const createBody = (await createResponse.json()) as {
    order: { id: string; subtotalCents: number };
  };
  assert.equal(createResponse.status, 201);

  const lookupResponse = await fetch(
    `${orderBaseUrl}/api/orders/${createBody.order.id}`,
    { headers: { "x-techx-api-key": API_KEY } },
  );
  const lookupBody = (await lookupResponse.json()) as {
    order: { id: string; subtotalCents: number };
  };
  assert.equal(lookupResponse.status, 200);
  assert.equal(lookupBody.order.id, createBody.order.id);
  assert.equal(lookupBody.order.subtotalCents, createBody.order.subtotalCents);
});

test("lookup for non-existent order returns 404 ORDER_NOT_FOUND", async () => {
  const response = await fetch(
    `${orderBaseUrl}/api/orders/ord_00000000-0000-0000-0000-000000000000`,
    { headers: { "x-techx-api-key": API_KEY } },
  );
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(response.status, 404);
  assert.equal(body.error.code, "ORDER_NOT_FOUND");
});

// ── Idempotency ───────────────────────────────────────────────────────────────

test("replays the same idempotent request and rejects a conflicting payload", async () => {
  const payload = checkout([{ productId: "product-1", quantity: 1 }]);
  const first = await orderRequest(payload, "same-order-key");
  const firstBody = (await first.json()) as { order: { id: string } };
  const replay = await orderRequest(payload, "same-order-key");
  const replayBody = (await replay.json()) as {
    order: { id: string };
    idempotentReplay: boolean;
  };
  assert.equal(replay.status, 200);
  assert.equal(replayBody.order.id, firstBody.order.id);
  assert.equal(replayBody.idempotentReplay, true);

  const conflict = await orderRequest(
    checkout([{ productId: "product-2", quantity: 1 }]),
    "same-order-key",
  );
  const conflictBody = (await conflict.json()) as { error: { code: string } };
  assert.equal(conflict.status, 409);
  assert.equal(conflictBody.error.code, "IDEMPOTENCY_CONFLICT");
});

test("concurrent requests with the same key produce exactly one order", async () => {
  const payload = checkout([{ productId: "product-1", quantity: 1 }]);
  const key = "concurrent-key-unique";
  const responses = await Promise.all(
    Array.from({ length: 5 }, () => orderRequest(payload, key)),
  );
  const bodies = await Promise.all(
    responses.map(async (r) => {
      const b = (await r.json()) as {
        order: { id: string };
        idempotentReplay?: boolean;
      };
      return { status: r.status, id: b.order.id, replay: b.idempotentReplay };
    }),
  );
  const ids = new Set(bodies.map((b) => b.id));
  assert.equal(
    ids.size,
    1,
    "all concurrent requests must converge on one order ID",
  );
  const created = bodies.filter((b) => b.status === 201);
  assert.equal(created.length, 1, "exactly one request must result in 201");
  const replays = bodies.filter((b) => b.status === 200 && b.replay === true);
  assert.equal(replays.length, 4, "remaining requests must be 200 replays");
});

test("missing idempotency key returns 400 INVALID_IDEMPOTENCY_KEY", async () => {
  const response = await fetch(`${orderBaseUrl}/api/orders`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-techx-api-key": API_KEY,
      // idempotency-key intentionally omitted
    },
    body: JSON.stringify(checkout([{ productId: "product-1", quantity: 1 }])),
  });
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(response.status, 400);
  assert.equal(body.error.code, "INVALID_IDEMPOTENCY_KEY");
});

test("idempotency key shorter than 8 characters is rejected", async () => {
  const response = await fetch(`${orderBaseUrl}/api/orders`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-techx-api-key": API_KEY,
      "idempotency-key": "short",
    },
    body: JSON.stringify(checkout([{ productId: "product-1", quantity: 1 }])),
  });
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(response.status, 400);
  assert.equal(body.error.code, "INVALID_IDEMPOTENCY_KEY");
});

// ── Invalid request / input validation ───────────────────────────────────────

test("rejects malformed input and unknown products without creating a partial order", async () => {
  const malformed = await orderRequest(
    checkout([{ productId: "product-1", quantity: 0 }]),
    "invalid-quantity-key",
  );
  assert.equal(malformed.status, 400);

  const unknown = await orderRequest(
    checkout([
      { productId: "product-1", quantity: 1 },
      { productId: "missing", quantity: 1 },
    ]),
    "unknown-product-key",
  );
  const unknownBody = (await unknown.json()) as { error: { code: string } };
  assert.equal(unknown.status, 400);
  assert.equal(unknownBody.error.code, "INVALID_PRODUCT");

  const retryWithValidPayload = await orderRequest(
    checkout([{ productId: "product-1", quantity: 1 }]),
    "unknown-product-key",
  );
  assert.equal(retryWithValidPayload.status, 201);
});

test("rejects request with no items", async () => {
  const response = await orderRequest(checkout([]), "no-items-key");
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(response.status, 400);
  assert.equal(body.error.code, "INVALID_ITEMS");
});

test("rejects quantity greater than 99", async () => {
  const response = await orderRequest(
    checkout([{ productId: "product-1", quantity: 100 }]),
    "quantity-over-99-key",
  );
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(response.status, 400);
  assert.equal(body.error.code, "INVALID_QUANTITY");
});

test("rejects duplicate product lines where merged quantity > 99", async () => {
  const response = await orderRequest(
    checkout([
      { productId: "product-1", quantity: 50 },
      { productId: "product-1", quantity: 50 },
    ]),
    "merged-over-99-key",
  );
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(response.status, 400);
  assert.equal(body.error.code, "INVALID_QUANTITY");
});

test("rejects non-json content-type", async () => {
  const response = await fetch(`${orderBaseUrl}/api/orders`, {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      "x-techx-api-key": API_KEY,
      "idempotency-key": "content-type-key12",
    },
    body: "not json",
  });
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(response.status, 400);
  assert.equal(body.error.code, "INVALID_CONTENT_TYPE");
});

test("rejects non-US country code", async () => {
  const response = await orderRequest(
    {
      items: [{ productId: "product-1", quantity: 1 }],
      customer: { name: "Test", email: "t@example.com" },
      shippingAddress: {
        line1: "1 Street",
        city: "London",
        region: "England",
        postalCode: "12345",
        countryCode: "GB",
      },
      shippingMethod: "standard",
    },
    "non-us-country-key",
  );
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(response.status, 400);
  assert.equal(body.error.code, "INVALID_SHIPPING_ADDRESS");
});

test("rejects invalid postal code format", async () => {
  const response = await orderRequest(
    {
      items: [{ productId: "product-1", quantity: 1 }],
      customer: { name: "Test", email: "t@example.com" },
      shippingAddress: {
        line1: "1 Street",
        city: "Seattle",
        region: "WA",
        postalCode: "ABCDE",
        countryCode: "US",
      },
      shippingMethod: "standard",
    },
    "invalid-postal-key",
  );
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(response.status, 400);
  assert.equal(body.error.code, "INVALID_SHIPPING_ADDRESS");
});

test("rejects unsupported shipping method", async () => {
  const response = await orderRequest(
    {
      items: [{ productId: "product-1", quantity: 1 }],
      customer: { name: "Test", email: "t@example.com" },
      shippingAddress: {
        line1: "1 Street",
        city: "Seattle",
        region: "WA",
        postalCode: "98101",
        countryCode: "US",
      },
      shippingMethod: "express",
    },
    "express-shipping-key",
  );
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(response.status, 400);
  assert.equal(body.error.code, "INVALID_SHIPPING_METHOD");
});

test("rejects invalid customer email", async () => {
  const response = await orderRequest(
    {
      items: [{ productId: "product-1", quantity: 1 }],
      customer: { name: "Test", email: "not-an-email" },
      shippingAddress: {
        line1: "1 Street",
        city: "Seattle",
        region: "WA",
        postalCode: "98101",
        countryCode: "US",
      },
      shippingMethod: "standard",
    },
    "invalid-email-key",
  );
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(response.status, 400);
  assert.equal(body.error.code, "INVALID_CUSTOMER");
});

// ── Inventory / stock checks ──────────────────────────────────────────────────

test("rejects invalid customer/address data and enforces catalog inventory", async () => {
  const invalidCustomer = checkout([{ productId: "product-1", quantity: 1 }]);
  invalidCustomer.customer.email = "not-an-email";
  const customerResponse = await orderRequest(
    invalidCustomer,
    "invalid-customer-key",
  );
  const customerBody = (await customerResponse.json()) as {
    error: { code: string };
  };
  assert.equal(customerResponse.status, 400);
  assert.equal(customerBody.error.code, "INVALID_CUSTOMER");

  const unavailable = await orderRequest(
    checkout([{ productId: "product-3", quantity: 1 }]),
    "unavailable-product-key",
  );
  const unavailableBody = (await unavailable.json()) as {
    error: { code: string };
  };
  assert.equal(unavailable.status, 409);
  assert.equal(unavailableBody.error.code, "PRODUCT_OUT_OF_STOCK");

  const insufficient = await orderRequest(
    checkout([{ productId: "product-2", quantity: 6 }]),
    "insufficient-inventory-key",
  );
  const insufficientBody = (await insufficient.json()) as {
    error: { code: string };
  };
  assert.equal(insufficient.status, 409);
  assert.equal(insufficientBody.error.code, "INSUFFICIENT_INVENTORY");
});

test("ordering exactly the available quantity succeeds", async () => {
  // product-2 inventoryQuantity = 5
  const response = await orderRequest(
    checkout([{ productId: "product-2", quantity: 5 }]),
    "exact-inventory-key",
  );
  assert.equal(response.status, 201);
});

test("ordering one above available quantity returns INSUFFICIENT_INVENTORY", async () => {
  // product-low-stock inventoryQuantity = 2
  const response = await orderRequest(
    checkout([{ productId: "product-low-stock", quantity: 3 }]),
    "over-inventory-key",
  );
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(response.status, 409);
  assert.equal(body.error.code, "INSUFFICIENT_INVENTORY");
});

// ── Catalog unavailability ────────────────────────────────────────────────────

test("returns 503 when Catalog is unavailable", async () => {
  catalogMode = "unavailable";
  try {
    const response = await orderRequest(
      checkout([{ productId: "product-1", quantity: 1 }]),
      "catalog-down-key",
    );
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(response.status, 503);
    assert.equal(body.error.code, "CATALOG_UNAVAILABLE");
  } finally {
    catalogMode = "normal";
  }
});

// ── Repository unavailability ─────────────────────────────────────────────────

test("maps repository unavailability to 503", async () => {
  const unavailableServer = createOrderServer({
    apiKey: API_KEY,
    catalogClient: new CatalogClient({ baseUrl: "http://127.0.0.1:1" }),
    repository: {
      find: async () => {
        throw new RepositoryUnavailableError();
      },
      lookupIdempotency: async () => {
        throw new RepositoryUnavailableError();
      },
      create: async () => {
        throw new RepositoryUnavailableError();
      },
    },
    orderTtlMs: 60_000,
    logger: () => undefined,
  });
  await new Promise<void>((resolve) =>
    unavailableServer.listen(0, "127.0.0.1", resolve),
  );
  try {
    const address = unavailableServer.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/orders/ord_00000000-0000-0000-0000-000000000000`,
      { headers: { "x-techx-api-key": API_KEY } },
    );
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(response.status, 503);
    assert.equal(body.error.code, "ORDER_REPOSITORY_UNAVAILABLE");
  } finally {
    await new Promise<void>((resolve, reject) =>
      unavailableServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

// ── Method validation ─────────────────────────────────────────────────────────

test("PUT on /api/orders returns 405", async () => {
  const response = await fetch(`${orderBaseUrl}/api/orders`, {
    method: "PUT",
    headers: { "x-techx-api-key": API_KEY },
  });
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(response.status, 405);
  assert.equal(body.error.code, "METHOD_NOT_ALLOWED");
});

// ── Request-ID propagation ────────────────────────────────────────────────────

test("propagates request ids without logging secrets", async () => {
  const response = await fetch(
    `${orderBaseUrl}/api/orders/ord_00000000-0000-0000-0000-000000000000`,
    {
      headers: {
        "x-techx-api-key": API_KEY,
        "x-request-id": "order-request-id",
      },
    },
  );
  const body = (await response.json()) as { error: { requestId: string } };
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("x-request-id"), "order-request-id");
  assert.equal(body.error.requestId, "order-request-id");
});

test("all responses carry no-store cache control", async () => {
  const response = await fetch(
    `${orderBaseUrl}/api/orders/ord_00000000-0000-0000-0000-000000000000`,
    { headers: { "x-techx-api-key": API_KEY } },
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
});
