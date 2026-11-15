import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  DynamoDbOrderRepository,
  idempotencyPartitionKey,
} from "../src/dynamodb-order-repository.js";

const endpoint = process.env.DYNAMODB_TEST_ENDPOINT;
if (!endpoint || !/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) {
  throw new Error(
    "Integration tests require an isolated local endpoint; AWS endpoints are forbidden.",
  );
}
const options = {
  endpoint,
  region: "us-east-1",
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
  maxAttempts: 3,
};
const clients = [new DynamoDBClient(options), new DynamoDBClient(options)];
const docClients = clients.map((c) => DynamoDBDocumentClient.from(c));
const tableName = `techx-test-${randomUUID()}`;
let created = false;
function repository(index = 0, optionsOverride: Record<string, unknown> = {}) {
  return new DynamoDbOrderRepository({
    client: docClients[index]!,
    tableName,
    ...optionsOverride,
  });
}
const repositories = [repository(0), repository(1)];
const request = {
  items: [
    {
      productId: "test",
      quantity: 1,
      sku: "TEST",
      name: "Test",
      image: "/test.svg",
      unitPriceCents: 500,
      lineTotalCents: 500,
    },
  ],
  customer: { name: "Integration Test", email: "integration@example.com" },
  shippingAddress: {
    line1: "100 Test Street",
    city: "Seattle",
    region: "WA",
    postalCode: "98101",
    countryCode: "US" as const,
  },
  idempotencyKey: "",
  payloadHash: "same-payload",
};

before(async () => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await clients[0]!.send(
        new CreateTableCommand({
          TableName: tableName,
          AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
          KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
          BillingMode: "PAY_PER_REQUEST",
        }),
      );
      created = true;
      break;
    } catch (error) {
      if (attempt >= 30) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const result = await clients[0]!.send(
    new DescribeTableCommand({ TableName: tableName }),
  );
  assert.equal(result.Table?.TableStatus, "ACTIVE");
});
after(async () => {
  try {
    if (created)
      await clients[0]!.send(new DeleteTableCommand({ TableName: tableName }));
  } finally {
    for (const client of clients) client.destroy();
  }
});

test("two independent clients racing the same key commit one order and replay all others", async () => {
  const idempotencyKey = randomUUID();
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      repositories[index % 2]!.create({ ...request, idempotencyKey }),
    ),
  );
  assert.equal(new Set(results.map((result) => result.order.id)).size, 1);
  assert.equal(results.filter((result) => !result.idempotentReplay).length, 1);
  const restarted = repository(1);
  const lookup = await restarted.find(results[0]!.order.id);
  assert.deepEqual(lookup, results[0]!.order);
  assert.equal(
    (await restarted.lookupIdempotency(idempotencyKey, request.payloadHash))
      .kind,
    "hit",
  );
});

test("different payloads racing one key yield one winner and a conflict", async () => {
  const idempotencyKey = randomUUID();
  const results = await Promise.allSettled(
    repositories.map((repo, index) =>
      repo.create({
        ...request,
        idempotencyKey,
        payloadHash: `payload-${index}`,
      }),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected?.reason.name, "IdempotencyConflictError");
});

test("orders remain available after restarting Order API and expired data is handled correctly", async () => {
  let simulatedTime = 1_000_000;
  const shortTtlMs = 2_000;
  const repo = repository(0, {
    orderTtlMs: shortTtlMs,
    now: () => simulatedTime,
  });

  const idempotencyKey = randomUUID();
  const result = await repo.create({ ...request, idempotencyKey });
  const orderId = result.order.id;

  // Simulate Order API restart by instantiating a completely new repository
  const restartedRepo = repository(1, {
    orderTtlMs: shortTtlMs,
    now: () => simulatedTime,
  });
  const foundBeforeExpiry = await restartedRepo.find(orderId);
  assert.ok(
    foundBeforeExpiry,
    "Order should remain available after restarting Order API",
  );
  assert.equal(foundBeforeExpiry.id, orderId);

  // Advance time beyond TTL
  simulatedTime += shortTtlMs + 1_000;
  const expiredRepo = repository(0, {
    orderTtlMs: shortTtlMs,
    now: () => simulatedTime,
  });
  const foundAfterExpiry = await expiredRepo.find(orderId);
  assert.equal(
    foundAfterExpiry,
    undefined,
    "Expired order should return undefined",
  );
});

test("customer data is stored according to current protection rules in DynamoDB", async () => {
  const idempotencyKey = randomUUID();
  const rawEmail = "sensitive-customer@example.com";
  const rawStreet = "999 Confidential Blvd Suite 100";
  const testReq = {
    ...request,
    customer: { name: "Protected User", email: rawEmail },
    shippingAddress: {
      line1: rawStreet,
      city: "Portland",
      region: "OR",
      postalCode: "97201",
      countryCode: "US" as const,
    },
    idempotencyKey,
  };

  const repo = repository(0);
  const result = await repo.create(testReq);
  const orderId = result.order.id;

  // Directly fetch raw item from DynamoDB table
  const rawOrderResponse = await docClients[0]!.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: `ORDER#${orderId}` },
      ConsistentRead: true,
    }),
  );
  const rawItem = rawOrderResponse.Item;
  assert.ok(rawItem, "Order record must exist in DynamoDB");

  // Protection checks on persisted DynamoDB record
  const itemJson = JSON.stringify(rawItem);
  assert.equal(
    itemJson.includes(rawEmail),
    false,
    "Raw email must not be persisted in DynamoDB",
  );
  assert.equal(
    itemJson.includes(rawStreet),
    false,
    "Raw street address must not be persisted in DynamoDB",
  );
  assert.equal(
    itemJson.includes(idempotencyKey),
    false,
    "Raw idempotency key must not be persisted in order record",
  );

  // Verify masked email and coarse address are stored
  assert.equal(
    rawItem.order.customer.emailMasked,
    "se*****************@example.com",
  );
  assert.equal(rawItem.order.customer.name, "Protected User");
  assert.equal(rawItem.order.shippingAddress.city, "Portland");
  assert.equal(rawItem.order.shippingAddress.region, "OR");
  assert.equal(rawItem.order.shippingAddress.postalCode, "97201");
  assert.equal(rawItem.order.shippingAddress.line1, undefined);

  // Directly inspect raw idempotency item in DynamoDB
  const hashedPk = idempotencyPartitionKey(idempotencyKey);
  const rawIdempResponse = await docClients[0]!.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: hashedPk },
      ConsistentRead: true,
    }),
  );
  const rawIdempItem = rawIdempResponse.Item;
  assert.ok(rawIdempItem, "Hashed idempotency record must exist");
  assert.equal(rawIdempItem.orderId, orderId);
  assert.equal(
    JSON.stringify(rawIdempItem).includes(idempotencyKey),
    false,
    "Raw idempotency key must not be in idempotency item",
  );
});
