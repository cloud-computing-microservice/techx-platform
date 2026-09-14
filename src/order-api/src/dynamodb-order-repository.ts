import { createHash, randomUUID } from "node:crypto";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  buildOrder,
  IdempotencyConflictError,
  RepositoryUnavailableError,
  type CreateOrderRequest,
  type CreateOrderResult,
  type IdempotencyLookup,
  type OrderRepository,
} from "./order-store.js";
import type { Order } from "./types.js";

const ORDER_PREFIX = "ORDER#";
const IDEMPOTENCY_PREFIX = "IDEMPOTENCY#";
const UUID_COLLISION_RETRIES = 3;

interface OrderItemRecord {
  pk: string;
  entityType: "ORDER";
  order: Order;
  ttlEpochSeconds: number;
}

interface IdempotencyItemRecord {
  pk: string;
  entityType: "IDEMPOTENCY";
  payloadHash: string;
  orderId: string;
  ttlEpochSeconds: number;
}

export interface DynamoDbOrderRepositoryOptions {
  client: DynamoDBDocumentClient;
  tableName: string;
  orderTtlMs?: number;
  idempotencyTtlMs?: number;
  now?: () => number;
  randomId?: () => string;
  transactionToken?: () => string;
}

export function idempotencyPartitionKey(rawKey: string): string {
  return `${IDEMPOTENCY_PREFIX}${createHash("sha256").update(rawKey).digest("hex")}`;
}

function orderPartitionKey(orderId: string): string {
  return `${ORDER_PREFIX}${orderId}`;
}

function isConditionalFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as {
    name?: string;
    CancellationReasons?: Array<{ Code?: string }>;
  };
  return (
    record.name === "ConditionalCheckFailedException" ||
    (record.name === "TransactionCanceledException" &&
      record.CancellationReasons?.some(
        (reason) => reason.Code === "ConditionalCheckFailed",
      ) === true)
  );
}

function active<T extends { ttlEpochSeconds: number }>(
  item: T | undefined,
  nowEpochSeconds: number,
): T | undefined {
  return item && item.ttlEpochSeconds > nowEpochSeconds ? item : undefined;
}

export class DynamoDbOrderRepository implements OrderRepository {
  readonly orderTtlMs: number;
  readonly idempotencyTtlMs: number;
  readonly #client: DynamoDBDocumentClient;
  readonly #tableName: string;
  readonly #now: () => number;
  readonly #randomId: () => string;
  readonly #transactionToken: () => string;

  constructor(options: DynamoDbOrderRepositoryOptions) {
    this.#client = options.client;
    this.#tableName = options.tableName;
    this.orderTtlMs = options.orderTtlMs ?? 2_592_000_000;
    this.idempotencyTtlMs = options.idempotencyTtlMs ?? 86_400_000;
    this.#now = options.now ?? Date.now;
    this.#randomId = options.randomId ?? (() => randomUUID());
    this.#transactionToken = options.transactionToken ?? (() => randomUUID());
    if (!this.#tableName) throw new Error("DynamoDB table name is required.");
    if (!Number.isInteger(this.orderTtlMs) || this.orderTtlMs < 1_000)
      throw new Error("Order TTL must be at least one second.");
    if (
      !Number.isInteger(this.idempotencyTtlMs) ||
      this.idempotencyTtlMs < 1_000
    )
      throw new Error("Idempotency TTL must be at least one second.");
  }

  async find(id: string): Promise<Order | undefined> {
    try {
      const response = await this.#client.send(
        new GetCommand({
          TableName: this.#tableName,
          Key: { pk: orderPartitionKey(id) },
          ConsistentRead: true,
        }),
      );
      return active(
        response.Item as OrderItemRecord | undefined,
        Math.floor(this.#now() / 1_000),
      )?.order;
    } catch (error) {
      throw new RepositoryUnavailableError(undefined, { cause: error });
    }
  }

  async lookupIdempotency(
    key: string,
    payloadHash: string,
  ): Promise<IdempotencyLookup> {
    try {
      const idempotency = await this.#getActiveIdempotency(key);
      if (!idempotency) return { kind: "miss" };
      if (idempotency.payloadHash !== payloadHash) return { kind: "conflict" };
      const order = await this.#getActiveOrder(idempotency.orderId);
      if (!order) throw new RepositoryUnavailableError();
      return { kind: "hit", order };
    } catch (error) {
      if (error instanceof RepositoryUnavailableError) throw error;
      throw new RepositoryUnavailableError(undefined, { cause: error });
    }
  }

  async create(request: CreateOrderRequest): Promise<CreateOrderResult> {
    for (let attempt = 0; attempt < UUID_COLLISION_RETRIES; attempt += 1) {
      const result = await this.#createAttempt(request);
      if (result) return result;
    }
    throw new RepositoryUnavailableError(
      "Could not allocate a unique order id.",
    );
  }

  async #createAttempt(
    request: CreateOrderRequest,
  ): Promise<CreateOrderResult | undefined> {
    const nowMs = this.#now();
    const nowEpochSeconds = Math.floor(nowMs / 1_000);
    const orderId = `ord_${this.#randomId()}`;
    const order = buildOrder(
      request.items,
      request.customer,
      request.shippingAddress,
      this.orderTtlMs,
      nowMs,
      orderId,
    );
    const orderRecord: OrderItemRecord = {
      pk: orderPartitionKey(orderId),
      entityType: "ORDER",
      order,
      ttlEpochSeconds: Math.ceil((nowMs + this.orderTtlMs) / 1_000),
    };
    const idempotencyRecord: IdempotencyItemRecord = {
      pk: idempotencyPartitionKey(request.idempotencyKey),
      entityType: "IDEMPOTENCY",
      payloadHash: request.payloadHash,
      orderId,
      ttlEpochSeconds: Math.ceil((nowMs + this.idempotencyTtlMs) / 1_000),
    };

    try {
      await this.#client.send(
        new TransactWriteCommand({
          ClientRequestToken: this.#transactionToken(),
          TransactItems: [
            {
              Put: {
                TableName: this.#tableName,
                Item: orderRecord,
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              Put: {
                TableName: this.#tableName,
                Item: idempotencyRecord,
                ConditionExpression:
                  "attribute_not_exists(pk) OR ttlEpochSeconds <= :now",
                ExpressionAttributeValues: { ":now": nowEpochSeconds },
              },
            },
          ],
        }),
      );
      return { order, idempotentReplay: false };
    } catch (error) {
      const conditionalFailure = isConditionalFailure(error);
      const reconciled = await this.#reconcileCreate(request, orderId);
      if (reconciled) return reconciled;
      if (conditionalFailure) return undefined;
      throw new RepositoryUnavailableError(undefined, { cause: error });
    }
  }

  async #reconcileCreate(
    request: CreateOrderRequest,
    attemptedOrderId: string,
  ): Promise<CreateOrderResult | undefined> {
    try {
      const idempotency = await this.#getActiveIdempotency(
        request.idempotencyKey,
      );
      if (idempotency) {
        if (idempotency.payloadHash !== request.payloadHash)
          throw new IdempotencyConflictError();
        const order = await this.#getActiveOrder(idempotency.orderId);
        if (!order) throw new RepositoryUnavailableError();
        return {
          order,
          idempotentReplay: idempotency.orderId !== attemptedOrderId,
        };
      }
      await this.#getActiveOrder(attemptedOrderId);
      return undefined;
    } catch (error) {
      if (
        error instanceof IdempotencyConflictError ||
        error instanceof RepositoryUnavailableError
      )
        throw error;
      throw new RepositoryUnavailableError(undefined, { cause: error });
    }
  }

  async #getActiveOrder(id: string): Promise<Order | undefined> {
    const response = await this.#client.send(
      new GetCommand({
        TableName: this.#tableName,
        Key: { pk: orderPartitionKey(id) },
        ConsistentRead: true,
      }),
    );
    return active(
      response.Item as OrderItemRecord | undefined,
      Math.floor(this.#now() / 1_000),
    )?.order;
  }

  async #getActiveIdempotency(
    key: string,
  ): Promise<IdempotencyItemRecord | undefined> {
    const response = await this.#client.send(
      new GetCommand({
        TableName: this.#tableName,
        Key: { pk: idempotencyPartitionKey(key) },
        ConsistentRead: true,
      }),
    );
    return active(
      response.Item as IdempotencyItemRecord | undefined,
      Math.floor(this.#now() / 1_000),
    );
  }
}
