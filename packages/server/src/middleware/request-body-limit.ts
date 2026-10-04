import type { MiddlewareHandler } from "hono";
import { MAX_REQUEST_BODY_BYTES, MAX_WORLD_SAVE_BODY_BYTES } from "@yumina/shared";

export function requestBodyLimitBytes(method: string, path: string): number {
  const worldSave = (method === "POST" && /^\/api\/worlds\/?$/.test(path))
    || (method === "PATCH" && /^\/api\/worlds\/[^/]+\/?$/.test(path));
  return worldSave ? MAX_WORLD_SAVE_BODY_BYTES : MAX_REQUEST_BODY_BYTES;
}

/** Bound actual bytes before route handlers parse JSON, including requests
 * without Content-Length. Direct-to-S3 uploads do not pass through this. */
export const requestBodyLimit: MiddlewareHandler = async (c, next) => {
  // Preserve the existing Stripe raw-body exemption.
  if (c.req.path.startsWith("/api/stripe/webhook")) return next();
  const limit = requestBodyLimitBytes(c.req.method, c.req.path);
  const reject = () => c.json({ error: `Request body too large (max ${limit / 1024 / 1024} MB)` }, 413);
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > limit) return reject();
  if (!c.req.raw.body) return next();

  const reader = c.req.raw.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        void reader.cancel().catch(() => {});
        return reject();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // Rebuild the consumed body so existing JSON/text/form readers see it intact.
  c.req.raw = new Request(c.req.raw, { body });
  return next();
};
