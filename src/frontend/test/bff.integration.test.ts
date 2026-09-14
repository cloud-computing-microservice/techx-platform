// @vitest-environment node

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { createCatalogServer } from "../../catalog-api/src/server.js";
import { CatalogClient } from "../../order-api/src/catalog-client.js";
import { FakeOrderRepository } from "../../order-api/src/order-store.js";
import { createOrderServer } from "../../order-api/src/server.js";
import { GET as getProducts } from "../app/api/products/route";
import { POST as createOrder } from "../app/api/orders/route";
import { GET as getOrder } from "../app/api/orders/[id]/route";
import { GET as getStoreConfig } from "../app/api/store-config/route";

const apiKey = "phase3-local-secret";
let catalogServer: Server;
let orderServer: Server;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

describe("frontend BFF with real local services", () => {
  beforeAll(async () => {
    catalogServer = createCatalogServer({ logger: () => undefined });
    const catalogUrl = await listen(catalogServer);
    orderServer = createOrderServer({
      apiKey,
      catalogClient: new CatalogClient({ baseUrl: catalogUrl, retries: 0 }),
      repository: new FakeOrderRepository(60_000, 60_000),
      orderTtlMs: 60_000,
      logger: () => undefined,
    });
    process.env.CATALOG_API_URL = catalogUrl;
    process.env.ORDER_API_URL = await listen(orderServer);
    process.env.ORDER_API_KEY = apiKey;
  });

  afterAll(async () => {
    await Promise.all([close(orderServer), close(catalogServer)]);
    delete process.env.CATALOG_API_URL;
    delete process.env.ORDER_API_URL;
    delete process.env.ORDER_API_KEY;
  });

  it("completes browse, multi-item create, idempotent replay, and lookup without exposing the API key", async () => {
    const productsResponse = await getProducts(
      new NextRequest("http://frontend.local/api/products"),
    );
    expect(productsResponse.status).toBe(200);
    const productsBody = (await productsResponse.json()) as {
      products: Array<{ id: string }>;
    };
    expect(productsBody.products.length).toBeGreaterThanOrEqual(2);

    const requestBody = JSON.stringify({
      items: [
        { productId: productsBody.products[0]?.id, quantity: 2 },
        { productId: productsBody.products[1]?.id, quantity: 1 },
      ],
      customer: {
        name: "Integration Customer",
        email: "integration@example.com",
      },
      shippingAddress: {
        line1: "100 Integration Street",
        city: "Seattle",
        region: "WA",
        postalCode: "98101",
        countryCode: "US",
      },
      shippingMethod: "standard",
    });
    const requestHeaders = {
      "content-type": "application/json",
      "idempotency-key": "phase3-integration-order",
      "x-forwarded-for": "198.51.100.30",
    };

    const createdResponse = await createOrder(
      new NextRequest("http://frontend.local/api/orders", {
        method: "POST",
        headers: requestHeaders,
        body: requestBody,
      }),
    );
    expect(createdResponse.status).toBe(201);
    const createdText = await createdResponse.text();
    expect(createdText).not.toContain(apiKey);
    const createdBody = JSON.parse(createdText) as {
      order: { id: string; items: unknown[] };
      idempotentReplay: boolean;
    };
    expect(createdBody.order.items).toHaveLength(2);
    expect(createdBody.idempotentReplay).toBe(false);

    const replayResponse = await createOrder(
      new NextRequest("http://frontend.local/api/orders", {
        method: "POST",
        headers: requestHeaders,
        body: requestBody,
      }),
    );
    expect(replayResponse.status).toBe(200);
    const replayBody = (await replayResponse.json()) as {
      order: { id: string };
      idempotentReplay: boolean;
    };
    expect(replayBody.order.id).toBe(createdBody.order.id);
    expect(replayBody.idempotentReplay).toBe(true);

    const lookupResponse = await getOrder(
      new NextRequest(
        `http://frontend.local/api/orders/${createdBody.order.id}`,
      ),
      { params: Promise.resolve({ id: createdBody.order.id }) },
    );
    expect(lookupResponse.status).toBe(200);
    expect(await lookupResponse.text()).not.toContain(apiKey);

    const configResponse = await getStoreConfig(
      new NextRequest("http://frontend.local/api/store-config"),
    );
    expect(configResponse.status).toBe(200);
    const configBody = (await configResponse.json()) as {
      config: { freeShippingThresholdCents: number };
    };
    expect(configBody.config.freeShippingThresholdCents).toBe(5_000);
  });

  it("returns 429 with Retry-After after the create-order burst limit", async () => {
    const headers = {
      "content-type": "application/json",
      "x-forwarded-for": "198.51.100.31",
    };
    let response: Response | undefined;
    for (let index = 0; index < 21; index += 1) {
      response = await createOrder(
        new NextRequest("http://frontend.local/api/orders", {
          method: "POST",
          headers: { ...headers, "idempotency-key": `phase3-rate-${index}` },
          body: JSON.stringify({
            items: [{ productId: "stellar-70-refractor", quantity: 1 }],
            customer: { name: "Rate Customer", email: "rate@example.com" },
            shippingAddress: {
              line1: "100 Rate Street",
              city: "Seattle",
              region: "WA",
              postalCode: "98101",
              countryCode: "US",
            },
            shippingMethod: "standard",
          }),
        }),
      );
    }
    expect(response?.status).toBe(429);
    expect(Number(response?.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("uses the stable CloudFront viewer IP when origin forwarding changes", async () => {
    let response: Response | undefined;
    for (let index = 0; index < 21; index += 1) {
      response = await createOrder(
        new NextRequest("http://frontend.local/api/orders", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `cloudfront-rate-${index}`,
            "x-forwarded-for": `10.42.3.${index + 1}`,
            "cloudfront-viewer-address": `203.0.113.77:${40_000 + index}`,
          },
          body: JSON.stringify({
            items: [{ productId: "stellar-70-refractor", quantity: 1 }],
            customer: {
              name: "CloudFront Customer",
              email: "cloudfront@example.com",
            },
            shippingAddress: {
              line1: "100 Edge Street",
              city: "Seattle",
              region: "WA",
              postalCode: "98101",
              countryCode: "US",
            },
            shippingMethod: "standard",
          }),
        }),
      );
    }
    expect(response?.status).toBe(429);
  });
});
