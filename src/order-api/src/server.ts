import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { CatalogUnavailableError } from "./catalog-client.js";
import type { CatalogClient } from "./catalog-client.js";
import {
  IdempotencyConflictError,
  RepositoryUnavailableError,
  type CreateOrderResult,
  type OrderRepository,
} from "./order-store.js";
import {
  MAX_ORDER_LINES,
  MAX_QUANTITY_PER_ITEM,
  storeConfig,
} from "./commerce.js";
import type {
  CreateOrderInput,
  CustomerInput,
  ErrorEnvelope,
  OrderItem,
  OrderItemInput,
  ShippingAddressInput,
} from "./types.js";

const MAX_BODY_BYTES = 16 * 1024;

type Logger = (record: Record<string, unknown>) => void;

export interface OrderServerOptions {
  apiKey: string;
  catalogClient: CatalogClient;
  repository: OrderRepository;
  orderTtlMs: number;
  logger?: Logger;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function requestIdFrom(request: IncomingMessage): string {
  const candidate = request.headers["x-request-id"];
  return typeof candidate === "string" &&
    candidate.length > 0 &&
    candidate.length <= 128
    ? candidate
    : randomUUID();
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  requestId: string,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-request-id", requestId);
  response.end(JSON.stringify(body));
}

function sendError(
  response: ServerResponse,
  error: HttpError,
  requestId: string,
): void {
  const body: ErrorEnvelope = {
    error: { code: error.code, message: error.message, requestId },
  };
  sendJson(response, error.status, body, requestId);
}

function normalizePath(url: string | undefined): string {
  try {
    return new URL(url ?? "/", "http://order.local").pathname;
  } catch {
    return "/";
  }
}

function hasValidApiKey(request: IncomingMessage, expected: string): boolean {
  const provided = request.headers["x-techx-api-key"];
  if (typeof provided !== "string") return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !contentType.toLowerCase().startsWith("application/json")
  ) {
    throw new HttpError(
      400,
      "INVALID_CONTENT_TYPE",
      "Content-Type must be application/json.",
    );
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES)
      throw new HttpError(400, "BODY_TOO_LARGE", "Request body is too large.");
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(
      400,
      "INVALID_JSON",
      "Request body must be valid JSON.",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): boolean {
  const keys = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function normalizedText(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== "string") {
    throw new HttpError(400, "INVALID_ORDER", `${field} must be text.`);
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new HttpError(
      400,
      "INVALID_ORDER",
      `${field} must contain ${minimum} to ${maximum} characters.`,
    );
  }
  return normalized;
}

function parseItems(items: unknown): OrderItemInput[] {
  if (
    !Array.isArray(items) ||
    items.length < 1 ||
    items.length > MAX_ORDER_LINES
  ) {
    throw new HttpError(
      400,
      "INVALID_ITEMS",
      `Items must contain between 1 and ${MAX_ORDER_LINES} rows.`,
    );
  }

  const merged = new Map<string, number>();
  for (const rawItem of items) {
    if (!isRecord(rawItem) || !exactKeys(rawItem, ["productId", "quantity"])) {
      throw new HttpError(
        400,
        "INVALID_ITEM",
        "Each item must contain productId and quantity only.",
      );
    }
    const productId = normalizedText(rawItem.productId, "productId", 1, 100);
    const quantity = rawItem.quantity;
    if (
      !Number.isInteger(quantity) ||
      (quantity as number) < 1 ||
      (quantity as number) > MAX_QUANTITY_PER_ITEM
    ) {
      throw new HttpError(
        400,
        "INVALID_QUANTITY",
        `quantity must be an integer between 1 and ${MAX_QUANTITY_PER_ITEM}.`,
      );
    }
    const combined = (merged.get(productId) ?? 0) + (quantity as number);
    if (combined > MAX_QUANTITY_PER_ITEM) {
      throw new HttpError(
        400,
        "INVALID_QUANTITY",
        `Combined quantity cannot exceed ${MAX_QUANTITY_PER_ITEM}.`,
      );
    }
    merged.set(productId, combined);
  }

  return [...merged.entries()]
    .map(([productId, quantity]) => ({ productId, quantity }))
    .sort((left, right) => left.productId.localeCompare(right.productId));
}

function parseOrder(body: unknown): CreateOrderInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "INVALID_ORDER", "Order body must be an object.");
  }
  const record = body as Record<string, unknown>;
  if (
    !exactKeys(record, [
      "customer",
      "items",
      "shippingAddress",
      "shippingMethod",
    ])
  ) {
    throw new HttpError(
      400,
      "INVALID_ORDER",
      "Order body contains missing or unsupported fields.",
    );
  }

  if (
    !isRecord(record.customer) ||
    !exactKeys(record.customer, ["email", "name"])
  ) {
    throw new HttpError(
      400,
      "INVALID_CUSTOMER",
      "Customer must contain name and email only.",
    );
  }
  const customer: CustomerInput = {
    name: normalizedText(record.customer.name, "customer.name", 2, 80),
    email: normalizedText(
      record.customer.email,
      "customer.email",
      5,
      120,
    ).toLowerCase(),
  };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) {
    throw new HttpError(400, "INVALID_CUSTOMER", "Customer email is invalid.");
  }

  if (
    !isRecord(record.shippingAddress) ||
    !exactKeys(
      record.shippingAddress,
      ["city", "countryCode", "line1", "postalCode", "region"],
      ["line2"],
    )
  ) {
    throw new HttpError(
      400,
      "INVALID_SHIPPING_ADDRESS",
      "Shipping address contains missing or unsupported fields.",
    );
  }
  if (record.shippingAddress.countryCode !== "US") {
    throw new HttpError(
      400,
      "INVALID_SHIPPING_ADDRESS",
      "Only US shipping addresses are supported.",
    );
  }
  const line2 =
    record.shippingAddress.line2 === undefined ||
    record.shippingAddress.line2 === ""
      ? undefined
      : normalizedText(
          record.shippingAddress.line2,
          "shippingAddress.line2",
          1,
          120,
        );
  const shippingAddress: ShippingAddressInput = {
    line1: normalizedText(
      record.shippingAddress.line1,
      "shippingAddress.line1",
      3,
      120,
    ),
    ...(line2 === undefined ? {} : { line2 }),
    city: normalizedText(
      record.shippingAddress.city,
      "shippingAddress.city",
      2,
      80,
    ),
    region: normalizedText(
      record.shippingAddress.region,
      "shippingAddress.region",
      2,
      40,
    ).toUpperCase(),
    postalCode: normalizedText(
      record.shippingAddress.postalCode,
      "shippingAddress.postalCode",
      5,
      10,
    ),
    countryCode: "US",
  };
  if (!/^\d{5}(?:-\d{4})?$/.test(shippingAddress.postalCode)) {
    throw new HttpError(
      400,
      "INVALID_SHIPPING_ADDRESS",
      "US postal code must use 12345 or 12345-6789 format.",
    );
  }
  if (record.shippingMethod !== "standard") {
    throw new HttpError(
      400,
      "INVALID_SHIPPING_METHOD",
      "Only standard delivery is available.",
    );
  }

  return {
    items: parseItems(record.items),
    customer,
    shippingAddress,
    shippingMethod: "standard",
  };
}

function payloadHash(order: CreateOrderInput): string {
  return createHash("sha256").update(JSON.stringify(order)).digest("hex");
}

function validateIdempotencyKey(request: IncomingMessage): string {
  const key = request.headers["idempotency-key"];
  if (typeof key !== "string" || key.trim().length < 8 || key.length > 128) {
    throw new HttpError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must contain 8 to 128 characters.",
    );
  }
  return key;
}

export function createOrderServer(options: OrderServerOptions): Server {
  if (options.apiKey.length < 8)
    throw new Error("ORDER_API_KEY must contain at least 8 characters.");
  if (!Number.isInteger(options.orderTtlMs) || options.orderTtlMs < 1_000)
    throw new Error("Order TTL must be at least one second.");
  const logger =
    options.logger ?? ((record) => console.log(JSON.stringify(record)));
  const repository = options.repository;
  let ready = true;

  async function createOrder(
    input: CreateOrderInput,
    key: string,
    hash: string,
    requestId: string,
  ): Promise<CreateOrderResult> {
    const products = await Promise.all(
      input.items.map(async (item) => {
        const product = await options.catalogClient.getProduct(
          item.productId,
          requestId,
        );
        if (!product)
          throw new HttpError(
            400,
            "INVALID_PRODUCT",
            `Product ${item.productId} does not exist.`,
          );
        if (product.availability === "out_of_stock") {
          throw new HttpError(
            409,
            "PRODUCT_OUT_OF_STOCK",
            `${product.name} is currently out of stock.`,
          );
        }
        if (item.quantity > product.inventoryQuantity) {
          throw new HttpError(
            409,
            "INSUFFICIENT_INVENTORY",
            `Only ${product.inventoryQuantity} units of ${product.name} are available.`,
          );
        }
        return { item, product };
      }),
    );
    const orderItems: OrderItem[] = products.map(({ item, product }) => ({
      productId: item.productId,
      quantity: item.quantity,
      sku: product.sku,
      name: product.name,
      image: product.images[0]?.src ?? "",
      unitPriceCents: product.priceCents,
      lineTotalCents: product.priceCents * item.quantity,
    }));
    return repository.create({
      items: orderItems,
      customer: input.customer,
      shippingAddress: input.shippingAddress,
      idempotencyKey: key,
      payloadHash: hash,
    });
  }

  const server = createServer(
    {
      requestTimeout: 8_000,
      headersTimeout: 7_000,
      keepAliveTimeout: 5_000,
    },
    async (request, response) => {
      const startedAt = performance.now();
      const requestId = requestIdFrom(request);
      const path = normalizePath(request.url);

      response.once("finish", () => {
        logger({
          timestamp: new Date().toISOString(),
          level: "info",
          service: "order-api",
          method: request.method,
          path,
          status: response.statusCode,
          durationMs: Math.round(performance.now() - startedAt),
          requestId,
        });
      });

      try {
        if (request.method === "GET" && path === "/healthz") {
          sendJson(
            response,
            200,
            { status: "ok", service: "order-api" },
            requestId,
          );
          return;
        }
        if (request.method === "GET" && path === "/readyz") {
          if (!ready)
            throw new HttpError(
              503,
              "NOT_READY",
              "Order API is shutting down.",
            );
          sendJson(
            response,
            200,
            { status: "ready", service: "order-api" },
            requestId,
          );
          return;
        }

        if (request.method === "GET" && path === "/api/store-config") {
          sendJson(
            response,
            200,
            { config: storeConfig(options.orderTtlMs) },
            requestId,
          );
          return;
        }

        if (!hasValidApiKey(request, options.apiKey)) {
          throw new HttpError(
            401,
            "UNAUTHORIZED",
            "A valid X-TechX-Api-Key header is required.",
          );
        }

        if (request.method === "POST" && path === "/api/orders") {
          const key = validateIdempotencyKey(request);
          const input = parseOrder(await readJsonBody(request));
          const hash = payloadHash(input);
          const stored = await repository.lookupIdempotency(key, hash);
          if (stored.kind === "conflict")
            throw new HttpError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "Idempotency-Key was reused with a different payload.",
            );
          if (stored.kind === "hit") {
            sendJson(
              response,
              200,
              { order: stored.order, idempotentReplay: true },
              requestId,
            );
            return;
          }

          const created = await createOrder(input, key, hash, requestId);
          sendJson(
            response,
            created.idempotentReplay ? 200 : 201,
            created,
            requestId,
          );
          return;
        }

        const orderMatch = path.match(/^\/api\/orders\/(ord_[0-9a-f-]+)$/i);
        if (request.method === "GET" && orderMatch) {
          const order = await repository.find(orderMatch[1] ?? "");
          if (!order)
            throw new HttpError(
              404,
              "ORDER_NOT_FOUND",
              "Order was not found or has expired.",
            );
          sendJson(response, 200, { order }, requestId);
          return;
        }

        if (path === "/api/orders" || path.startsWith("/api/orders/")) {
          throw new HttpError(
            405,
            "METHOD_NOT_ALLOWED",
            "Method is not supported for this resource.",
          );
        }
        throw new HttpError(404, "ROUTE_NOT_FOUND", "Route was not found.");
      } catch (error) {
        if (error instanceof HttpError) {
          sendError(response, error, requestId);
        } else if (error instanceof CatalogUnavailableError) {
          sendError(
            response,
            new HttpError(
              503,
              "CATALOG_UNAVAILABLE",
              "Catalog dependency is unavailable.",
            ),
            requestId,
          );
        } else if (error instanceof IdempotencyConflictError) {
          sendError(
            response,
            new HttpError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "Idempotency-Key was reused with a different payload.",
            ),
            requestId,
          );
        } else if (error instanceof RepositoryUnavailableError) {
          sendError(
            response,
            new HttpError(
              503,
              "ORDER_REPOSITORY_UNAVAILABLE",
              "Order persistence is unavailable.",
            ),
            requestId,
          );
        } else {
          logger({
            timestamp: new Date().toISOString(),
            level: "error",
            service: "order-api",
            requestId,
            message: "unhandled-request-error",
          });
          sendError(
            response,
            new HttpError(
              500,
              "INTERNAL_ERROR",
              "An unexpected error occurred.",
            ),
            requestId,
          );
        }
      }
    },
  );

  server.on("close", () => {
    ready = false;
  });
  return server;
}
