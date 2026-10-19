// @vitest-environment node

import { describe, expect, it } from "vitest";
import { readRequestBody } from "@/lib/server/request-body";

function streamingRequest(chunks: Uint8Array[], onCancel = () => undefined) {
  return new Request("http://frontend.local/api/orders", {
    method: "POST",
    duplex: "half",
    body: new ReadableStream({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel: onCancel,
    }),
  } as RequestInit);
}

describe("bounded request body", () => {
  it("decodes UTF-8 even when a character spans chunks", async () => {
    const bytes = new TextEncoder().encode('{"name":"Khôi"}');
    const request = streamingRequest(
      [...bytes].map((byte) => Uint8Array.of(byte)),
    );
    expect(await readRequestBody(request, bytes.length)).toBe(
      '{"name":"Khôi"}',
    );
  });

  it("cancels an oversized chunked body without consuming the rest", async () => {
    let cancelled = false;
    const chunks = Array.from({ length: 100 }, () => new Uint8Array(1024));
    const request = streamingRequest(chunks, () => {
      cancelled = true;
    });
    await expect(readRequestBody(request, 2048)).rejects.toMatchObject({
      code: "BODY_TOO_LARGE",
    });
    expect(cancelled).toBe(true);
    expect(chunks.length).toBeGreaterThan(90);
  });

  it("rejects oversized Content-Length before reading and handles broken streams", async () => {
    const request = new Request("http://frontend.local", {
      method: "POST",
      body: "oversized",
      headers: { "content-length": "100" },
    });
    await expect(readRequestBody(request, 10)).rejects.toMatchObject({
      code: "BODY_TOO_LARGE",
    });
    const broken = new Request("http://frontend.local", {
      method: "POST",
      duplex: "half",
      body: new ReadableStream({
        start(controller) {
          controller.error(new Error("disconnected"));
        },
      }),
    } as RequestInit);
    await expect(readRequestBody(broken)).rejects.toMatchObject({
      code: "INVALID_BODY",
    });
  });
});
