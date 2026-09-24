/**
 * The player's browser side of the local-bridge.
 *
 * Three endpoints, all plain HTTP on purpose — yumina.io sits behind the
 * Cloudflare proxy, and a long-lived SSE stream travels through it where a
 * WebSocket would have needed the same DNS-only carve-out we gave rt.yumina.io.
 *
 *   POST /announce   what models this machine has (also refreshes the TTL)
 *   GET  /poll       SSE; each `job` event is one turn to run locally
 *   POST /report     tokens flowing back — chunk / done / error
 *
 * `/report` is deliberately separate from `/poll` rather than duplex: browsers
 * can't stream a request body reliably, and a POST per batch (~150ms of tokens)
 * is a handful of requests per second for one player.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { authMiddleware } from "../middleware/auth.js";
import type { AppEnv } from "../lib/types.js";
import {
  addConnection,
  setAdvertisedModels,
  submitEvent,
  type AdvertisedModel,
} from "../lib/local-bridge/registry.js";

const localBridgeRoutes = new Hono<AppEnv>();

localBridgeRoutes.use("/*", authMiddleware);

/** Guard rails on what a browser may claim about itself. */
const MAX_ADVERTISED_MODELS = 200;
const MAX_MODEL_ID = 200;
/** One batch of tokens. Generous for a slow reader, far below a prompt-sized body. */
const MAX_DELTA_CHARS = 64_000;

function sanitizeModels(input: unknown): AdvertisedModel[] {
  if (!Array.isArray(input)) return [];
  const out: AdvertisedModel[] = [];
  for (const raw of input.slice(0, MAX_ADVERTISED_MODELS)) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    if (!id || id.length > MAX_MODEL_ID) continue;
    const ctx = typeof rec.contextLength === "number" && Number.isFinite(rec.contextLength)
      ? Math.max(1024, Math.min(1_048_576, Math.floor(rec.contextLength)))
      : undefined;
    out.push({
      id,
      ...(typeof rec.name === "string" && rec.name.length <= MAX_MODEL_ID && { name: rec.name }),
      ...(ctx !== undefined && { contextLength: ctx }),
    });
  }
  return out;
}

localBridgeRoutes.post("/announce", async (c) => {
  const currentUser = c.get("user");
  const body = await c.req.json<{ models?: unknown }>().catch(() => ({ models: [] }));
  const models = sanitizeModels(body.models);
  setAdvertisedModels(currentUser.id, models);
  return c.json({ ok: true, count: models.length });
});

localBridgeRoutes.get("/poll", async (c) => {
  const currentUser = c.get("user");

  return streamSSE(c, async (stream) => {
    let disposed = false;
    const dispose = addConnection(currentUser.id, (job) => {
      // Fire-and-forget: writeSSE rejects only when the socket is already gone,
      // and addConnection's caller marks the connection dead on throw.
      void stream.writeSSE({ event: "job", data: JSON.stringify(job) }).catch(() => {
        /* socket closed — the disposer below runs on abort */
      });
    });

    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      dispose();
    };
    stream.onAbort(cleanup);

    await stream.writeSSE({ event: "ready", data: JSON.stringify({ ok: true }) });

    // Keepalive. Idle proxies drop a silent stream well before a player's next
    // turn arrives, and a dropped poll means their local model looks offline.
    try {
      while (!disposed) {
        await stream.sleep(20_000);
        if (disposed) break;
        await stream.writeSSE({ event: "ping", data: "{}" });
      }
    } catch {
      /* client went away */
    } finally {
      cleanup();
    }
  });
});

localBridgeRoutes.post("/report", async (c) => {
  const body = await c.req.json<{
    requestId?: string;
    kind?: string;
    delta?: string;
    message?: string;
    stopReason?: string;
    usage?: { promptTokens?: number; completionTokens?: number };
  }>().catch(() => null);

  if (!body?.requestId || typeof body.requestId !== "string") {
    return c.json({ error: "requestId is required" }, 400);
  }

  // A requestId is an unguessable UUID minted server-side and handed only to
  // this user's poll connection, so holding one is the authorization. We still
  // require a session (route-level authMiddleware) so an unauthenticated caller
  // can't probe ids at all.
  if (body.kind === "chunk") {
    const delta = typeof body.delta === "string" ? body.delta : "";
    if (delta.length > MAX_DELTA_CHARS) {
      return c.json({ error: "delta too large" }, 413);
    }
    if (delta.length > 0) submitEvent({ kind: "chunk", requestId: body.requestId, delta });
    return c.json({ ok: true });
  }

  if (body.kind === "done") {
    submitEvent({
      kind: "done",
      requestId: body.requestId,
      ...(typeof body.stopReason === 'string' && { stopReason: body.stopReason.slice(0, 64) }),
      ...(body.usage && {
        usage: {
          promptTokens: Math.max(0, Math.floor(body.usage.promptTokens ?? 0)),
          completionTokens: Math.max(0, Math.floor(body.usage.completionTokens ?? 0)),
        },
      }),
    });
    return c.json({ ok: true });
  }

  if (body.kind === "error") {
    const message = typeof body.message === "string" && body.message.trim().length > 0
      ? body.message.slice(0, 500)
      : "Your local model reported an error.";
    submitEvent({ kind: "error", requestId: body.requestId, message });
    return c.json({ ok: true });
  }

  return c.json({ error: "kind must be chunk, done, or error" }, 400);
});

export default localBridgeRoutes;
