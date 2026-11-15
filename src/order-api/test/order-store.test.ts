import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeOrderRepository } from "../src/order-store.js";

const item = {
  productId: "product-1",
  quantity: 1,
  sku: "TEST-001",
  name: "Product 1",
  image: "/products/test.svg",
  unitPriceCents: 500,
  lineTotalCents: 500,
};
const customer = { name: "Test Customer", email: "test@example.com" };
const shippingAddress = {
  line1: "100 Test Street",
  city: "Seattle",
  region: "WA",
  postalCode: "98101",
  countryCode: "US" as const,
};

async function create(
  repository: FakeOrderRepository,
  items = [item],
  idempotencyKey = "idem-key",
  payloadHash = "hash",
) {
  return repository.create({
    items,
    customer,
    shippingAddress,
    idempotencyKey,
    payloadHash,
  });
}

// ── TTL / expiry ──────────────────────────────────────────────────────────────

test("expires orders and idempotency records independently", async () => {
  let now = 1_000;
  const repository = new FakeOrderRepository(1_000, 2_000, () => now);
  const { order } = await create(repository);
  assert.equal((await repository.find(order.id))?.id, order.id);
  now = 2_001;
  assert.equal(await repository.find(order.id), undefined);
  await assert.rejects(repository.lookupIdempotency("idem-key", "hash"), {
    name: "RepositoryUnavailableError",
  });
  now = 3_001;
  assert.equal(
    (await repository.lookupIdempotency("idem-key", "hash")).kind,
    "miss",
  );
});

test("order is accessible before TTL elapses and gone immediately after", async () => {
  let now = 0;
  const orderTtlMs = 1_000;
  const repository = new FakeOrderRepository(orderTtlMs, 10_000, () => now);
  const { order } = await create(
    repository,
    [item],
    "ttl-boundary-key",
    "ttl-hash",
  );

  // Just before expiry
  now = orderTtlMs - 1;
  assert.ok(
    await repository.find(order.id),
    "order should still be accessible just before TTL",
  );

  // At and after expiry
  now = orderTtlMs;
  assert.equal(
    await repository.find(order.id),
    undefined,
    "order should be expired at TTL",
  );
});

// ── Replay and conflict ───────────────────────────────────────────────────────

test("returns replay and conflict behavior asynchronously", async () => {
  const repository = new FakeOrderRepository(60_000, 60_000);
  const first = await create(repository);
  const replay = await create(repository);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.order.id, first.order.id);
  await assert.rejects(
    create(repository, [item], "idem-key", "different-hash"),
    { name: "IdempotencyConflictError" },
  );
});

test("first create returns idempotentReplay: false", async () => {
  const repository = new FakeOrderRepository(60_000, 60_000);
  const { idempotentReplay } = await create(
    repository,
    [item],
    "first-create-key",
    "hash-a",
  );
  assert.equal(idempotentReplay, false);
});

test("lookupIdempotency returns hit for existing key with matching hash", async () => {
  const repository = new FakeOrderRepository(60_000, 60_000);
  const { order } = await create(
    repository,
    [item],
    "lookup-key",
    "lookup-hash",
  );
  const result = await repository.lookupIdempotency(
    "lookup-key",
    "lookup-hash",
  );
  assert.equal(result.kind, "hit");
  if (result.kind === "hit") {
    assert.equal(result.order.id, order.id);
  }
});

test("lookupIdempotency returns miss for unknown key", async () => {
  const repository = new FakeOrderRepository(60_000, 60_000);
  const result = await repository.lookupIdempotency("unknown-key", "some-hash");
  assert.equal(result.kind, "miss");
});

test("lookupIdempotency returns conflict for mismatched hash", async () => {
  const repository = new FakeOrderRepository(60_000, 60_000);
  await create(repository, [item], "conflict-key", "original-hash");
  const result = await repository.lookupIdempotency(
    "conflict-key",
    "different-hash",
  );
  assert.equal(result.kind, "conflict");
});

// ── Pricing, data masking, estimated delivery ─────────────────────────────────

test("locks shipping totals and stores only coarse private data", async () => {
  const repository = new FakeOrderRepository(60_000, 60_000, () =>
    Date.UTC(2026, 7, 7, 12),
  );
  const { order } = await create(repository);
  assert.equal(order.subtotalCents, 500);
  assert.equal(order.shippingCents, 999);
  assert.equal(order.totalCents, 1_499);
  assert.deepEqual(order.customer, {
    name: "Test Customer",
    emailMasked: "te**@example.com",
  });
  assert.deepEqual(order.shippingAddress, {
    city: "Seattle",
    region: "WA",
    postalCode: "98101",
    countryCode: "US",
  });
  assert.equal(order.estimatedDelivery.from, "2026-08-12T12:00:00.000Z");
  assert.equal(order.estimatedDelivery.to, "2026-08-14T12:00:00.000Z");
  assert.equal(JSON.stringify(order).includes("100 Test Street"), false);
  assert.equal(JSON.stringify(order).includes("test@example.com"), false);
});

test("free shipping applies when subtotal equals threshold (5000 cents)", async () => {
  const thresholdItem = {
    productId: "product-threshold",
    quantity: 1,
    sku: "THRESH-001",
    name: "Threshold Product",
    image: "/products/thresh.svg",
    unitPriceCents: 5_000,
    lineTotalCents: 5_000,
  };
  const repository = new FakeOrderRepository(60_000, 60_000);
  const { order } = await create(
    repository,
    [thresholdItem],
    "free-ship-key",
    "free-hash",
  );
  assert.equal(order.subtotalCents, 5_000);
  assert.equal(order.shippingCents, 0);
  assert.equal(order.totalCents, 5_000);
});

test("shipping is 999 when subtotal is below threshold", async () => {
  const cheapItem = {
    productId: "cheap",
    quantity: 1,
    sku: "CHEAP-001",
    name: "Cheap",
    image: "/products/cheap.svg",
    unitPriceCents: 4_999,
    lineTotalCents: 4_999,
  };
  const repository = new FakeOrderRepository(60_000, 60_000);
  const { order } = await create(
    repository,
    [cheapItem],
    "paid-ship-key",
    "paid-hash",
  );
  assert.equal(order.subtotalCents, 4_999);
  assert.equal(order.shippingCents, 999);
  assert.equal(order.totalCents, 5_998);
});

test("email masking keeps first two chars and masks the rest", async () => {
  const repository = new FakeOrderRepository(60_000, 60_000);
  const { order } = await create(
    repository,
    [item],
    "email-mask-key",
    "email-mask-hash",
  );
  // "test@example.com" → "te**@example.com"
  assert.match(order.customer.emailMasked, /^te\*+@example\.com$/);
  assert.equal(order.customer.emailMasked.includes("test@"), false);
});

test("order id uses ord_ prefix", async () => {
  const repository = new FakeOrderRepository(60_000, 60_000);
  const { order } = await create(
    repository,
    [item],
    "prefix-key",
    "prefix-hash",
  );
  assert.match(order.id, /^ord_[0-9a-f-]+$/i);
});

test("order status is always confirmed", async () => {
  const repository = new FakeOrderRepository(60_000, 60_000);
  const { order } = await create(
    repository,
    [item],
    "status-key",
    "status-hash",
  );
  assert.equal(order.status, "confirmed");
});

test("order expiresAt is createdAt + TTL", async () => {
  const orderTtlMs = 86_400_000; // 1 day
  const fixedNow = Date.UTC(2026, 0, 1, 0, 0, 0);
  const repository = new FakeOrderRepository(
    orderTtlMs,
    60_000,
    () => fixedNow,
  );
  const { order } = await create(
    repository,
    [item],
    "expires-key",
    "expires-hash",
  );
  const created = new Date(order.createdAt).getTime();
  const expires = new Date(order.expiresAt).getTime();
  assert.equal(expires - created, orderTtlMs);
});

test("multi-item order calculates subtotal as sum of line totals", async () => {
  const items = [
    {
      ...item,
      productId: "p1",
      quantity: 2,
      unitPriceCents: 300,
      lineTotalCents: 600,
    },
    {
      ...item,
      productId: "p2",
      quantity: 1,
      unitPriceCents: 200,
      lineTotalCents: 200,
    },
  ];
  const repository = new FakeOrderRepository(60_000, 60_000);
  const { order } = await create(
    repository,
    items,
    "multi-item-key",
    "multi-hash",
  );
  assert.equal(order.subtotalCents, 800);
  assert.equal(order.shippingCents, 999);
  assert.equal(order.totalCents, 1_799);
});

// ── Repository find ───────────────────────────────────────────────────────────

test("find returns undefined for unknown order id", async () => {
  const repository = new FakeOrderRepository(60_000, 60_000);
  const result = await repository.find("ord_nonexistent");
  assert.equal(result, undefined);
});

test("find returns the order by its id", async () => {
  const repository = new FakeOrderRepository(60_000, 60_000);
  const { order } = await create(
    repository,
    [item],
    "find-by-id-key",
    "find-hash",
  );
  const found = await repository.find(order.id);
  assert.ok(found);
  assert.equal(found.id, order.id);
});
