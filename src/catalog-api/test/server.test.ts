import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { createCatalogServer } from "../src/server.js";

const server = createCatalogServer({ logger: () => undefined });
let baseUrl = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

// ── Health and readiness ──────────────────────────────────────────────────────

test("health and readiness endpoints are available", async () => {
  const [health, readiness] = await Promise.all([
    fetch(`${baseUrl}/healthz`),
    fetch(`${baseUrl}/readyz`),
  ]);
  assert.equal(health.status, 200);
  assert.equal(readiness.status, 200);
});

test("healthz returns expected body", async () => {
  const response = await fetch(`${baseUrl}/healthz`);
  const body = (await response.json()) as { status: string; service: string };
  assert.equal(body.status, "ok");
  assert.equal(body.service, "catalog-api");
});

test("readyz returns expected body", async () => {
  const response = await fetch(`${baseUrl}/readyz`);
  const body = (await response.json()) as { status: string; service: string };
  assert.equal(body.status, "ready");
  assert.equal(body.service, "catalog-api");
});

test("healthz sets no-store cache header on error responses but public max-age on 200", async () => {
  // 200 product listing uses public, max-age=30
  const products = await fetch(`${baseUrl}/api/products`);
  assert.equal(products.headers.get("cache-control"), "public, max-age=30");
  // health always 200 — also public, max-age=30
  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.headers.get("cache-control"), "public, max-age=30");
  // 404 uses no-store
  const missing = await fetch(`${baseUrl}/api/products/does-not-exist`);
  assert.equal(missing.headers.get("cache-control"), "no-store");
});

// ── Product listing ───────────────────────────────────────────────────────────

test("lists products and propagates a request id", async () => {
  const response = await fetch(`${baseUrl}/api/products`, {
    headers: { "x-request-id": "catalog-test-request" },
  });
  const body = (await response.json()) as {
    products: Array<{ id: string }>;
    categories: Array<{ id: string; count: number }>;
  };
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-request-id"), "catalog-test-request");
  assert.equal(body.products.length, 24);
  assert.equal(
    body.categories.reduce((sum, category) => sum + category.count, 0),
    body.products.length,
  );
});

test("product list includes all three category groups with correct counts", async () => {
  const response = await fetch(`${baseUrl}/api/products`);
  const body = (await response.json()) as {
    categories: Array<{ id: string; count: number }>;
    products: Array<{ category: string }>;
  };
  assert.equal(response.status, 200);

  const categoryMap = Object.fromEntries(
    body.categories.map(({ id, count }) => [id, count]),
  );
  assert.equal(categoryMap["telescopes"], 8);
  assert.equal(categoryMap["binoculars"], 7);
  assert.equal(categoryMap["accessories"], 9);

  // counts must match the actual products array
  for (const { id, count } of body.categories) {
    const actual = body.products.filter((p) => p.category === id).length;
    assert.equal(actual, count, `category ${id} count mismatch`);
  }
});

test("product list response has correct shape for every product", async () => {
  const response = await fetch(`${baseUrl}/api/products`);
  const body = (await response.json()) as {
    products: Array<Record<string, unknown>>;
  };
  assert.equal(response.status, 200);

  for (const product of body.products) {
    assert.ok(
      typeof product["id"] === "string" && product["id"].length > 0,
      `product missing id`,
    );
    assert.ok(typeof product["name"] === "string", `product missing name`);
    assert.ok(
      typeof product["priceCents"] === "number" &&
        (product["priceCents"] as number) >= 1,
      `priceCents invalid`,
    );
    assert.ok(
      ["telescopes", "binoculars", "accessories"].includes(
        product["category"] as string,
      ),
      `invalid category`,
    );
    assert.ok(
      ["in_stock", "low_stock", "out_of_stock"].includes(
        product["availability"] as string,
      ),
      `invalid availability`,
    );
    assert.ok(
      typeof product["currency"] === "string" && product["currency"] === "USD",
      `currency must be USD`,
    );
    assert.ok(
      Array.isArray(product["images"]) &&
        (product["images"] as unknown[]).length >= 1,
      `product must have at least one image`,
    );
    assert.ok(
      Array.isArray(product["specifications"]) &&
        (product["specifications"] as unknown[]).length >= 3,
      `product must have at least three specifications`,
    );
  }
});

test("generates a request id when none is provided", async () => {
  const response = await fetch(`${baseUrl}/api/products`);
  const id = response.headers.get("x-request-id");
  assert.ok(id && id.length > 0, "response must carry a request id");
});

test("ignores x-request-id headers that are too long", async () => {
  const tooLong = "x".repeat(129);
  const response = await fetch(`${baseUrl}/api/products`, {
    headers: { "x-request-id": tooLong },
  });
  const responseId = response.headers.get("x-request-id");
  // Server must generate its own UUID (not echo the oversized header)
  assert.notEqual(responseId, tooLong);
  assert.ok(responseId && responseId.length > 0);
});

// ── Product detail ────────────────────────────────────────────────────────────

test("returns one product and a structured 404", async () => {
  const found = await fetch(`${baseUrl}/api/products/stellar-70-refractor`);
  const foundBody = (await found.json()) as { product: { id: string } };
  assert.equal(found.status, 200);
  assert.equal(foundBody.product.id, "stellar-70-refractor");

  const missing = await fetch(`${baseUrl}/api/products/missing`);
  const missingBody = (await missing.json()) as {
    error: { code: string; requestId: string };
  };
  assert.equal(missing.status, 404);
  assert.equal(missingBody.error.code, "PRODUCT_NOT_FOUND");
  assert.ok(missingBody.error.requestId);
});

test("product detail propagates request id", async () => {
  const response = await fetch(`${baseUrl}/api/products/stellar-70-refractor`, {
    headers: { "x-request-id": "detail-trace-id" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-request-id"), "detail-trace-id");
});

test("product detail 404 includes error envelope with requestId", async () => {
  const response = await fetch(`${baseUrl}/api/products/nonexistent-product`);
  const body = (await response.json()) as {
    error: { code: string; message: string; requestId: string };
  };
  assert.equal(response.status, 404);
  assert.equal(body.error.code, "PRODUCT_NOT_FOUND");
  assert.ok(
    typeof body.error.message === "string" && body.error.message.length > 0,
  );
  assert.ok(
    typeof body.error.requestId === "string" && body.error.requestId.length > 0,
  );
});

test("detail response has same shape as list item", async () => {
  const listResponse = await fetch(`${baseUrl}/api/products`);
  const listBody = (await listResponse.json()) as {
    products: Array<{ id: string }>;
  };
  const firstId = listBody.products[0]?.id;
  assert.ok(firstId);

  const detailResponse = await fetch(`${baseUrl}/api/products/${firstId}`);
  const detailBody = (await detailResponse.json()) as {
    product: { id: string };
  };
  assert.equal(detailResponse.status, 200);
  assert.equal(detailBody.product.id, firstId);
});

// ── Filtering / search helpers ────────────────────────────────────────────────

test("at least one featured product is present in the listing", async () => {
  const response = await fetch(`${baseUrl}/api/products`);
  const body = (await response.json()) as {
    products: Array<{ featured: boolean }>;
  };
  const featured = body.products.filter((p) => p.featured);
  assert.equal(
    featured.length,
    7,
    "seed must contain exactly 7 featured products",
  );
});

test("exactly one out-of-stock product is present", async () => {
  const response = await fetch(`${baseUrl}/api/products`);
  const body = (await response.json()) as {
    products: Array<{ availability: string }>;
  };
  const outOfStock = body.products.filter(
    (p) => p.availability === "out_of_stock",
  );
  assert.equal(
    outOfStock.length,
    1,
    "seed must contain exactly 1 out-of-stock product",
  );
});

test("low-stock products have inventoryQuantity 1-5", async () => {
  const response = await fetch(`${baseUrl}/api/products`);
  const body = (await response.json()) as {
    products: Array<{ availability: string; inventoryQuantity: number }>;
  };
  for (const product of body.products.filter(
    (p) => p.availability === "low_stock",
  )) {
    assert.ok(
      product.inventoryQuantity >= 1 && product.inventoryQuantity <= 5,
      `low_stock product inventoryQuantity=${product.inventoryQuantity} is out of range`,
    );
  }
});

test("out-of-stock product has inventoryQuantity 0", async () => {
  const response = await fetch(`${baseUrl}/api/products`);
  const body = (await response.json()) as {
    products: Array<{ availability: string; inventoryQuantity: number }>;
  };
  for (const product of body.products.filter(
    (p) => p.availability === "out_of_stock",
  )) {
    assert.equal(product.inventoryQuantity, 0);
  }
});

test("compareAtPriceCents is always greater than priceCents when present", async () => {
  const response = await fetch(`${baseUrl}/api/products`);
  const body = (await response.json()) as {
    products: Array<{ priceCents: number; compareAtPriceCents?: number }>;
  };
  for (const product of body.products) {
    if (product.compareAtPriceCents !== undefined) {
      assert.ok(
        product.compareAtPriceCents > product.priceCents,
        `compareAtPriceCents (${product.compareAtPriceCents}) must exceed priceCents (${product.priceCents})`,
      );
    }
  }
});

// ── Method validation ─────────────────────────────────────────────────────────

test("rejects unsupported methods", async () => {
  const response = await fetch(`${baseUrl}/api/products`, { method: "POST" });
  assert.equal(response.status, 405);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "METHOD_NOT_ALLOWED");
});

test("rejects PUT and DELETE on products routes", async () => {
  for (const method of ["PUT", "DELETE", "PATCH"]) {
    const response = await fetch(`${baseUrl}/api/products`, { method });
    assert.equal(response.status, 405, `${method} should return 405`);
  }
});

// ── Invalid input / edge cases ────────────────────────────────────────────────

test("malformed URL encoding returns 400 and leaves the server healthy", async () => {
  for (const id of ["%", "%ZZ", "%E0%A4%A"]) {
    const response = await fetch(`${baseUrl}/api/products/${id}`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "INVALID_PRODUCT_ID");
  }
  assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
});

test("unknown route returns 404 ROUTE_NOT_FOUND", async () => {
  const response = await fetch(`${baseUrl}/unknown-path`);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(response.status, 404);
  assert.equal(body.error.code, "ROUTE_NOT_FOUND");
});
