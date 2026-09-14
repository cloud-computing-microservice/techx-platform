import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { CatalogClient } from "./catalog-client.js";
import { DynamoDbOrderRepository } from "./dynamodb-order-repository.js";
import { createOrderServer } from "./server.js";

function integerEnv(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw))
    throw new Error(`${name} must be an integer >= ${minimum}.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new Error(`${name} must be an integer >= ${minimum}.`);
  return value;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const port = integerEnv("ORDER_PORT", 3002, 1);
if (port > 65_535) throw new Error("ORDER_PORT must be a valid TCP port.");
const apiKey = process.env.ORDER_API_KEY ?? "";
const catalogApiUrl = process.env.CATALOG_API_URL ?? "http://localhost:3001";
const tableName = requiredEnv("ORDER_TABLE_NAME");
const region = requiredEnv("AWS_REGION");
const orderTtlMs = integerEnv("ORDER_STORE_TTL_MS", 2_592_000_000, 1_000);
const idempotencyTtlMs = integerEnv(
  "ORDER_IDEMPOTENCY_TTL_MS",
  86_400_000,
  1_000,
);
const localMode = process.env.ORDER_LOCAL_MODE === "true";
const endpoint = process.env.DYNAMODB_ENDPOINT?.trim();
const environment = process.env.DEPLOYMENT_ENVIRONMENT ?? process.env.NODE_ENV;
if (endpoint && !localMode)
  throw new Error(
    "DYNAMODB_ENDPOINT is allowed only when ORDER_LOCAL_MODE=true.",
  );
if (endpoint && environment === "staging")
  throw new Error("Staging must not use a custom DynamoDB endpoint.");

const dynamoClient = new DynamoDBClient({
  region,
  ...(endpoint ? { endpoint } : {}),
  maxAttempts: integerEnv("DYNAMODB_MAX_ATTEMPTS", 3, 1),
  requestHandler: new NodeHttpHandler({
    connectionTimeout: integerEnv("DYNAMODB_CONNECT_TIMEOUT_MS", 500, 1),
    requestTimeout: integerEnv("DYNAMODB_REQUEST_TIMEOUT_MS", 1_500, 1),
  }),
});
const repository = new DynamoDbOrderRepository({
  client: DynamoDBDocumentClient.from(dynamoClient, {
    marshallOptions: { removeUndefinedValues: true },
  }),
  tableName,
  orderTtlMs,
  idempotencyTtlMs,
});

const server = createOrderServer({
  apiKey,
  catalogClient: new CatalogClient({ baseUrl: catalogApiUrl }),
  repository,
  orderTtlMs,
});

server.listen(port, "0.0.0.0", () => {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "info",
      service: "order-api",
      message: "listening",
      port,
    }),
  );
});

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "info",
      service: "order-api",
      message: "shutdown-started",
      signal,
    }),
  );
  server.close((error) => {
    dynamoClient.destroy();
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
  setTimeout(() => process.exit(1), 8_000).unref();
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
