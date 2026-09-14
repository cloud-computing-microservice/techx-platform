import { randomUUID } from "node:crypto";
import { addBusinessDays, maskEmail, shippingCentsFor } from "./commerce.js";
import type {
  CustomerInput,
  Order,
  OrderItem,
  ShippingAddressInput,
} from "./types.js";

export type IdempotencyLookup =
  { kind: "miss" } | { kind: "conflict" } | { kind: "hit"; order: Order };

export interface CreateOrderRequest {
  items: OrderItem[];
  customer: CustomerInput;
  shippingAddress: ShippingAddressInput;
  idempotencyKey: string;
  payloadHash: string;
}

export interface CreateOrderResult {
  order: Order;
  idempotentReplay: boolean;
}

export interface OrderRepository {
  find(id: string): Promise<Order | undefined>;
  lookupIdempotency(
    key: string,
    payloadHash: string,
  ): Promise<IdempotencyLookup>;
  create(request: CreateOrderRequest): Promise<CreateOrderResult>;
}

export class RepositoryUnavailableError extends Error {
  constructor(
    message = "Order repository is unavailable.",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RepositoryUnavailableError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency-Key was reused with a different payload.");
    this.name = "IdempotencyConflictError";
  }
}

export function buildOrder(
  items: OrderItem[],
  customer: CustomerInput,
  shippingAddress: ShippingAddressInput,
  orderTtlMs: number,
  createdAtMs: number,
  id = `ord_${randomUUID()}`,
): Order {
  const expiresAtMs = createdAtMs + orderTtlMs;
  const subtotalCents = items.reduce(
    (sum, item) => sum + item.lineTotalCents,
    0,
  );
  const shippingCents = shippingCentsFor(subtotalCents);
  return {
    id,
    items,
    customer: { name: customer.name, emailMasked: maskEmail(customer.email) },
    shippingAddress: {
      city: shippingAddress.city,
      region: shippingAddress.region,
      postalCode: shippingAddress.postalCode,
      countryCode: shippingAddress.countryCode,
    },
    status: "confirmed",
    shippingMethod: "standard",
    estimatedDelivery: {
      from: addBusinessDays(createdAtMs, 3).toISOString(),
      to: addBusinessDays(createdAtMs, 5).toISOString(),
    },
    subtotalCents,
    shippingCents,
    totalCents: subtotalCents + shippingCents,
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

interface StoredOrder {
  order: Order;
  expiresAtMs: number;
}

interface IdempotencyRecord {
  payloadHash: string;
  orderId: string;
  expiresAtMs: number;
}

/** Async fake for tests. Production startup always injects DynamoDbOrderRepository. */
export class FakeOrderRepository implements OrderRepository {
  readonly #orders = new Map<string, StoredOrder>();
  readonly #idempotency = new Map<string, IdempotencyRecord>();

  constructor(
    readonly orderTtlMs: number,
    readonly idempotencyTtlMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(orderTtlMs) || orderTtlMs < 1_000)
      throw new Error("Order TTL must be at least one second.");
    if (!Number.isInteger(idempotencyTtlMs) || idempotencyTtlMs < 1_000)
      throw new Error("Idempotency TTL must be at least one second.");
  }

  async find(id: string): Promise<Order | undefined> {
    this.#prune();
    return this.#orders.get(id)?.order;
  }

  async lookupIdempotency(
    key: string,
    payloadHash: string,
  ): Promise<IdempotencyLookup> {
    this.#prune();
    const record = this.#idempotency.get(key);
    if (!record) return { kind: "miss" };
    if (record.payloadHash !== payloadHash) return { kind: "conflict" };
    const order = this.#orders.get(record.orderId)?.order;
    if (!order) throw new RepositoryUnavailableError();
    return { kind: "hit", order };
  }

  async create(request: CreateOrderRequest): Promise<CreateOrderResult> {
    this.#prune();
    const existing = this.#idempotency.get(request.idempotencyKey);
    if (existing) {
      if (existing.payloadHash !== request.payloadHash)
        throw new IdempotencyConflictError();
      const order = this.#orders.get(existing.orderId)?.order;
      if (!order) throw new RepositoryUnavailableError();
      return { order, idempotentReplay: true };
    }

    const createdAtMs = this.now();
    const order = buildOrder(
      request.items,
      request.customer,
      request.shippingAddress,
      this.orderTtlMs,
      createdAtMs,
    );
    this.#orders.set(order.id, {
      order,
      expiresAtMs: createdAtMs + this.orderTtlMs,
    });
    this.#idempotency.set(request.idempotencyKey, {
      payloadHash: request.payloadHash,
      orderId: order.id,
      expiresAtMs: createdAtMs + this.idempotencyTtlMs,
    });
    return { order, idempotentReplay: false };
  }

  #prune(): void {
    const now = this.now();
    for (const [id, record] of this.#orders) {
      if (record.expiresAtMs <= now) this.#orders.delete(id);
    }
    for (const [key, record] of this.#idempotency) {
      if (record.expiresAtMs <= now) this.#idempotency.delete(key);
    }
  }
}
