import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { FixedWindowRateLimiter } from "@/lib/server/rate-limit";
import { configurationError, proxyJson } from "@/lib/server/proxy";
import { readRequestBody, RequestBodyError } from "@/lib/server/request-body";

const limiter = new FixedWindowRateLimiter(20, 60_000);

function clientKey(request: NextRequest): string {
  const cloudFrontViewer = request.headers.get("cloudfront-viewer-address");
  if (cloudFrontViewer?.trim()) {
    const address = cloudFrontViewer.trim();
    const match = address.match(/^\[?(.+?)\]?:\d+$/);
    return match?.[1] || address;
  }
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "unknown-client";
}

export async function POST(request: NextRequest) {
  const baseUrl = process.env.ORDER_API_URL;
  const apiKey = process.env.ORDER_API_KEY;
  if (!baseUrl || !apiKey || apiKey.length < 8)
    return configurationError("Order API configuration is incomplete.");

  const rate = limiter.consume(clientKey(request));
  if (!rate.allowed) {
    const requestId = request.headers.get("x-request-id") || randomUUID();
    return NextResponse.json(
      {
        error: {
          code: "RATE_LIMITED",
          message: "Too many order attempts. Please wait and try again.",
          requestId,
        },
      },
      {
        status: 429,
        headers: {
          "retry-after": String(rate.retryAfterSeconds),
          "x-request-id": requestId,
          "cache-control": "no-store",
        },
      },
    );
  }

  const contentType = request.headers.get("content-type");
  if (!contentType?.toLowerCase().startsWith("application/json")) {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_CONTENT_TYPE",
          message: "Content-Type must be application/json.",
          requestId: randomUUID(),
        },
      },
      { status: 400 },
    );
  }

  let body: string;
  try {
    body = await readRequestBody(request);
  } catch (error) {
    if (!(error instanceof RequestBodyError)) throw error;
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          requestId: randomUUID(),
        },
      },
      { status: 400 },
    );
  }

  return proxyJson(`${baseUrl.replace(/\/$/, "")}/api/orders`, {
    requestId: request.headers.get("x-request-id"),
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-techx-api-key": apiKey,
        "idempotency-key":
          request.headers.get("idempotency-key") ?? randomUUID(),
      },
      body,
    },
  });
}
