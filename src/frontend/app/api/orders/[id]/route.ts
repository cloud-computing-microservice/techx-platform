import type { NextRequest } from "next/server";
import { configurationError, proxyJson } from "@/lib/server/proxy";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const baseUrl = process.env.ORDER_API_URL;
  const apiKey = process.env.ORDER_API_KEY;
  if (!baseUrl || !apiKey || apiKey.length < 8)
    return configurationError("Order API configuration is incomplete.");
  const { id } = await context.params;
  return proxyJson(
    `${baseUrl.replace(/\/$/, "")}/api/orders/${encodeURIComponent(id)}`,
    {
      requestId: request.headers.get("x-request-id"),
      init: { headers: { "x-techx-api-key": apiKey } },
    },
  );
}
