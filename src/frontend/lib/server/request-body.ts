export class RequestBodyError extends Error {
  constructor(
    readonly code: "BODY_TOO_LARGE" | "INVALID_BODY",
    message: string,
  ) {
    super(message);
    this.name = "RequestBodyError";
  }
}

/** Bound memory while reading, even when Content-Length is missing or false. */
export async function readRequestBody(
  request: Request,
  maximumBytes = 16 * 1024,
): Promise<string> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > maximumBytes) {
    await request.body?.cancel().catch(() => undefined);
    throw new RequestBodyError("BODY_TOO_LARGE", "Request body is too large.");
  }
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RequestBodyError(
          "BODY_TOO_LARGE",
          "Request body is too large.",
        );
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError(
      "INVALID_BODY",
      "Request body could not be read.",
    );
  } finally {
    reader.releaseLock();
  }
}
