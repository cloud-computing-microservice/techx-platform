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

test("requires the internal API key for order endpoints", async () => {
  const response = await fetch(
    `${orderBaseUrl}/api/orders/ord_00000000-0000-0000-0000-000000000000`,
  );
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(response.status, 401);
  assert.equal(body.error.code, "UNAUTHORIZED");
});

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
