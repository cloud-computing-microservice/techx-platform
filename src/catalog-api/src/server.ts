import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import productsJson from "../data/products.json" with { type: "json" };
import { buildCategories, validateProducts } from "./catalog.js";
import type { ErrorEnvelope } from "./types.js";

const products = validateProducts(productsJson);
const categories = Object.freeze(buildCategories(products));
const productsById = new Map(products.map((product) => [product.id, product]));

type LogRecord = Record<string, unknown>;
type Logger = (record: LogRecord) => void;

export interface CatalogServerOptions {
  logger?: Logger;
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
  response.setHeader(
    "cache-control",
    status === 200 ? "public, max-age=30" : "no-store",
  );
  response.setHeader("x-request-id", requestId);
  response.end(JSON.stringify(body));
}

function sendError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
  requestId: string,
): void {
  const body: ErrorEnvelope = { error: { code, message, requestId } };
  sendJson(response, status, body, requestId);
}

function normalizePath(url: string | undefined): string {
  try {
    return new URL(url ?? "/", "http://catalog.local").pathname;
  } catch {
    return "/";
  }
}

export function createCatalogServer(
  options: CatalogServerOptions = {},
): Server {
  const logger =
    options.logger ?? ((record) => console.log(JSON.stringify(record)));
  let ready = true;

  const server = createServer(
    {
      requestTimeout: 6_000,
      headersTimeout: 5_000,
      keepAliveTimeout: 5_000,
    },
    (request, response) => {
      const startedAt = performance.now();
      const requestId = requestIdFrom(request);
      const path = normalizePath(request.url);

      response.once("finish", () => {
        logger({
          timestamp: new Date().toISOString(),
          level: "info",
          service: "catalog-api",
          method: request.method,
          path,
          status: response.statusCode,
          durationMs: Math.round(performance.now() - startedAt),
          requestId,
        });
      });

      if (request.method !== "GET") {
        sendError(
          response,
          405,
          "METHOD_NOT_ALLOWED",
          "Only GET is supported for this resource.",
          requestId,
        );
        return;
      }

      if (path === "/healthz") {
        sendJson(
          response,
          200,
          { status: "ok", service: "catalog-api" },
          requestId,
        );
        return;
      }

      if (path === "/readyz") {
        if (ready) {
          sendJson(
            response,
            200,
            { status: "ready", service: "catalog-api" },
            requestId,
          );
        } else {
          sendError(
            response,
            503,
            "NOT_READY",
            "Catalog API is shutting down.",
            requestId,
          );
        }
        return;
      }

      if (path === "/api/products") {
        sendJson(response, 200, { products, categories }, requestId);
        return;
      }

      const productMatch = path.match(/^\/api\/products\/([^/]+)$/);
      if (productMatch) {
        let id: string;
        try {
          id = decodeURIComponent(productMatch[1] ?? "");
        } catch {
          sendError(
            response,
            400,
            "INVALID_PRODUCT_ID",
            "Product ID must use valid URL encoding.",
            requestId,
          );
          return;
        }
        const product = productsById.get(id);
        if (!product) {
          sendError(
            response,
            404,
            "PRODUCT_NOT_FOUND",
            "Product was not found.",
            requestId,
          );
          return;
        }
        sendJson(response, 200, { product }, requestId);
        return;
      }

      sendError(
        response,
        404,
        "ROUTE_NOT_FOUND",
        "Route was not found.",
        requestId,
      );
    },
  );

  server.on("close", () => {
    ready = false;
  });

  return server;
}
