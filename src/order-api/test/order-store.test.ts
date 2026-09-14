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
