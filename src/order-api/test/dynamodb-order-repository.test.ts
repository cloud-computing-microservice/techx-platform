import assert from "node:assert/strict";
import { test } from "node:test";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  DynamoDbOrderRepository,
  idempotencyPartitionKey,
} from "../src/dynamodb-order-repository.js";

const item = {
  productId: "product-1",
  quantity: 1,
  sku: "TEST-001",
  name: "Product 1",
  image: "/products/test.svg",
  unitPriceCents: 500,
  lineTotalCents: 500,
};
const request = {
  items: [item],
  customer: { name: "Test Customer", email: "test@example.com" },
  shippingAddress: {
    line1: "100 Test Street",
    city: "Seattle",
    region: "WA",
    postalCode: "98101",
    countryCode: "US" as const,
  },
  idempotencyKey: "never-persist-this-key",
  payloadHash: "payload-hash",
};

type Command = { input: Record<string, unknown> };

function client(
  send: (command: Command) => Promise<{ Item?: Record<string, unknown> }>,
): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

test("hashes raw idempotency keys before persistence", () => {
  const pk = idempotencyPartitionKey(request.idempotencyKey);
  assert.match(pk, /^IDEMPOTENCY#[0-9a-f]{64}$/);
  assert.equal(pk.includes(request.idempotencyKey), false);
});

test("uses strong reads and enforces application TTL", async () => {
  const commands: Command[] = [];
  const repository = new DynamoDbOrderRepository({
    client: client(async (command) => {
      commands.push(command);
      return {
        Item: {
          pk: "ORDER#ord_expired",
          entityType: "ORDER",
          order: { id: "ord_expired" },
          ttlEpochSeconds: 9,
        },
      };
    }),
    tableName: "orders",
    now: () => 10_000,
  });
  assert.equal(await repository.find("ord_expired"), undefined);
  assert.equal(commands[0]?.input.ConsistentRead, true);
});

test("transacts order and hashed idempotency records without raw secrets", async () => {
  const commands: Command[] = [];
  const repository = new DynamoDbOrderRepository({
    client: client(async (command) => {
      commands.push(command);
      return {};
    }),
    tableName: "orders",
    orderTtlMs: 2_592_000_000,
    idempotencyTtlMs: 86_400_000,
    now: () => 1_000_000,
    randomId: () => "00000000-0000-0000-0000-000000000001",
    transactionToken: () => "11111111-1111-4111-8111-111111111111",
  });
  const result = await repository.create(request);
  assert.equal(result.idempotentReplay, false);
  assert.equal(result.order.id, "ord_00000000-0000-0000-0000-000000000001");
  assert.equal(
    commands[0]?.input.ClientRequestToken,
    "11111111-1111-4111-8111-111111111111",
  );
  const serialized = JSON.stringify(commands[0]?.input);
  assert.equal(serialized.includes(request.idempotencyKey), false);
  assert.match(serialized, /attribute_not_exists\(pk\)/);
  assert.match(serialized, /ttlEpochSeconds <= :now/);
  const transaction = commands[0]?.input.TransactItems as Array<{
    Put: { Item: { ttlEpochSeconds: number } };
  }>;
  assert.equal(transaction[0]?.Put.Item.ttlEpochSeconds, 2_593_000);
  assert.equal(transaction[1]?.Put.Item.ttlEpochSeconds, 87_400);
});

test("does not expire records before their millisecond expiry", async () => {
  const commands: Command[] = [];
  const repository = new DynamoDbOrderRepository({
    client: client(async (command) => {
      commands.push(command);
      if ("TransactItems" in command.input) return {};
      return {
        Item: {
          pk: "ORDER#ord_boundary",
          entityType: "ORDER",
          order: { id: "ord_boundary" },
          ttlEpochSeconds: 2,
        },
      };
    }),
    tableName: "orders",
    orderTtlMs: 1_000,
    idempotencyTtlMs: 1_000,
    now: () => 100,
    randomId: () => "boundary",
  });

  await repository.create(request);
  const transaction = commands[0]?.input.TransactItems as Array<{
    Put: { Item: { ttlEpochSeconds: number } };
  }>;
  assert.equal(transaction[0]?.Put.Item.ttlEpochSeconds, 2);
  assert.equal(transaction[1]?.Put.Item.ttlEpochSeconds, 2);
  assert.equal((await repository.find("ord_boundary"))?.id, "ord_boundary");
});

test("reconciles a concurrent winner as an idempotent replay", async () => {
  let calls = 0;
  const winner = {
    id: "ord_winner",
    items: [item],
    customer: { name: "Test Customer", emailMasked: "te**@example.com" },
    shippingAddress: {
      city: "Seattle",
      region: "WA",
      postalCode: "98101",
      countryCode: "US",
    },
    status: "confirmed",
    shippingMethod: "standard",
    estimatedDelivery: { from: "x", to: "y" },
    subtotalCents: 500,
    shippingCents: 999,
    totalCents: 1499,
    createdAt: "x",
    expiresAt: "y",
  };
  const repository = new DynamoDbOrderRepository({
    client: client(async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("cancelled");
        error.name = "TransactionCanceledException";
        throw error;
      }
      if (calls === 2)
        return {
          Item: {
            pk: idempotencyPartitionKey(request.idempotencyKey),
            entityType: "IDEMPOTENCY",
            payloadHash: request.payloadHash,
            orderId: winner.id,
            ttlEpochSeconds: 9999,
          },
        };
      return {
        Item: {
          pk: `ORDER#${winner.id}`,
          entityType: "ORDER",
          order: winner,
          ttlEpochSeconds: 9999,
        },
      };
    }),
    tableName: "orders",
    now: () => 1_000,
  });
  const result = await repository.create(request);
  assert.equal(result.idempotentReplay, true);
  assert.equal(result.order.id, winner.id);
});

test("retries a conditional UUID collision with a new transaction token", async () => {
  const commands: Command[] = [];
  let transactionCalls = 0;
  const ids = ["collision", "winner"];
  const tokens = ["token-1", "token-2"];
  const repository = new DynamoDbOrderRepository({
    client: client(async (command) => {
      commands.push(command);
      if ("TransactItems" in command.input) {
        transactionCalls += 1;
        if (transactionCalls === 1) {
          const error = new Error("conditional collision") as Error & {
            CancellationReasons?: Array<{ Code: string }>;
          };
          error.name = "TransactionCanceledException";
          error.CancellationReasons = [
            { Code: "ConditionalCheckFailed" },
            { Code: "None" },
          ];
          throw error;
        }
      }
      return {};
    }),
    tableName: "orders",
    now: () => 1_000,
    randomId: () => ids.shift() ?? "unexpected",
    transactionToken: () => tokens.shift() ?? "unexpected-token",
  });

  const result = await repository.create(request);
  assert.equal(result.order.id, "ord_winner");
  const transactions = commands.filter(
    (command) => "TransactItems" in command.input,
  );
  assert.deepEqual(
    transactions.map((command) => command.input.ClientRequestToken),
    ["token-1", "token-2"],
  );
});

test("does not classify cancellation without a conditional reason as a collision", async () => {
  const repository = new DynamoDbOrderRepository({
    client: client(async (command) => {
      if ("TransactItems" in command.input) {
        const error = new Error("transaction conflict") as Error & {
          CancellationReasons?: Array<{ Code: string }>;
        };
        error.name = "TransactionCanceledException";
        error.CancellationReasons = [{ Code: "TransactionConflict" }];
        throw error;
      }
      return {};
    }),
    tableName: "orders",
    now: () => 1_000,
  });

  await assert.rejects(repository.create(request), {
    name: "RepositoryUnavailableError",
  });
});

test("treats active idempotency pointing to a missing order as unavailable", async () => {
  let calls = 0;
  const repository = new DynamoDbOrderRepository({
    client: client(async () => {
      calls += 1;
      return calls === 1
        ? {
            Item: {
              pk: idempotencyPartitionKey(request.idempotencyKey),
              entityType: "IDEMPOTENCY",
              payloadHash: request.payloadHash,
              orderId: "ord_missing",
              ttlEpochSeconds: 9999,
            },
          }
        : {};
    }),
    tableName: "orders",
    now: () => 1_000,
  });
  await assert.rejects(
    repository.lookupIdempotency(request.idempotencyKey, request.payloadHash),
    { name: "RepositoryUnavailableError" },
  );
});
