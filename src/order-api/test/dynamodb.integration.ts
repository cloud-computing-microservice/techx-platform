import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDbOrderRepository } from "../src/dynamodb-order-repository.js";

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
const tableName = `techx-test-${randomUUID()}`;
let created = false;
function repository(index = 0) {
  return new DynamoDbOrderRepository({
    client: DynamoDBDocumentClient.from(clients[index]!),
    tableName,
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
