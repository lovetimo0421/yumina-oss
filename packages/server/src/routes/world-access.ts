import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { streamSSE } from "hono/streaming";
import { readOwn } from "../db/index.js";
import { worlds } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { createAccessToken, listAccessTokens, revokeAccessToken } from "../lib/access-tokens.js";
import { subscribeWorldEvents } from "../lib/world-events.js";
import { getWorldAccess } from "../lib/world-collaborators.js";
import { disconnectAi, listConnectedAis } from "../lib/connected-ais.js";
import { MCP_SCOPE } from "../lib/mcp-oauth.js";
import type { AppEnv } from "../lib/types.js";

/**
 * The creator's side of outside-AI access, under /api/studio/:worldId:
 * make / list / revoke a card's tokens, and a live stream of what outside
 * AIs change while the card is open (the editor reloads and the block glows).
 */
export const worldAccessRoutes = new Hono<AppEnv>();
worldAccessRoutes.use("/*", authMiddleware);

async function ownsWorld(userId: string, worldId: string): Promise<boolean> {
  const [row] = await (await readOwn(userId)).select({ id: worlds.id }).from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, userId))).limit(1);
  return !!row;
}

// The AIs signed in to this account (OAuth) for the card MCP, across all
// cards. Apps on the AI gateway (game mods) are listed in Settings instead.
worldAccessRoutes.get("/connected-ais", async (c) => {
  const user = c.get("user");
  return c.json({ data: (await listConnectedAis(user.id)).filter((ai) => ai.scopes.includes(MCP_SCOPE)) });
});

worldAccessRoutes.delete("/connected-ais/:clientId", async (c) => {
  const user = c.get("user");
  const ok = await disconnectAi(user.id, c.req.param("clientId"));
  return ok ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
});

// Account tokens: for an AI that cannot sign in (DeepSeek), on all cards.
worldAccessRoutes.get("/access-tokens", async (c) => {
  const user = c.get("user");
  return c.json({ data: await listAccessTokens(user.id, null) });
});

worldAccessRoutes.post("/access-tokens", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ name?: string }>().catch(() => ({} as { name?: string }));
  const made = await createAccessToken({ userId: user.id, worldId: null, name: body.name ?? "AI" });
  return c.json({ data: { token: made.token, ...made.info } });
});

worldAccessRoutes.delete("/access-tokens/:id", async (c) => {
  const user = c.get("user");
  const ok = await revokeAccessToken(user.id, c.req.param("id"));
  return ok ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
});

worldAccessRoutes.get("/:worldId/access-tokens", async (c) => {
  const user = c.get("user");
  const worldId = c.req.param("worldId");
  if (!(await ownsWorld(user.id, worldId))) return c.json({ error: "Not found" }, 404);
  return c.json({ data: await listAccessTokens(user.id, worldId) });
});

worldAccessRoutes.post("/:worldId/access-tokens", async (c) => {
  const user = c.get("user");
  const worldId = c.req.param("worldId");
  if (!(await ownsWorld(user.id, worldId))) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json<{ name?: string }>().catch(() => ({} as { name?: string }));
  const made = await createAccessToken({ userId: user.id, worldId, name: body.name ?? "Claude Code" });
  return c.json({ data: { token: made.token, ...made.info } });
});

worldAccessRoutes.delete("/:worldId/access-tokens/:id", async (c) => {
  const user = c.get("user");
  const ok = await revokeAccessToken(user.id, c.req.param("id"));
  return ok ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
});

worldAccessRoutes.get("/:worldId/live", async (c) => {
  const user = c.get("user");
  const worldId = c.req.param("worldId");
  // The creator and everyone they invited (viewers too: they watch it change).
  if (!(await getWorldAccess(user.id, worldId))) return c.json({ error: "Not found" }, 404);
  return streamSSE(c, async (stream) => {
    let open = true;
    const unsubscribe = subscribeWorldEvents(worldId, (event) => {
      if (!open) return;
      void stream.writeSSE({ event: event.kind, data: JSON.stringify(event) }).catch(() => {});
      // Removed from the card: stop streaming it to them.
      if (event.kind === "access-changed" && (event.userId === user.id || event.userId === "*")) {
        void getWorldAccess(user.id, worldId).then((access) => {
          if (!access) { open = false; unsubscribe(); void stream.close(); }
        }).catch(() => {});
      }
    });
    stream.onAbort(() => { open = false; unsubscribe(); });
    // Proxies close quiet connections; a comment every 25s keeps it. Access is
    // re-read on the same beat, so a removal whose access-changed message was
    // lost (a Redis hiccup between replicas) still closes the stream.
    while (open) {
      await stream.sleep(25_000);
      if (!open) break;
      const still = await getWorldAccess(user.id, worldId).then((a) => a !== null, () => true);
      if (!still) {
        // Same as hearing it live: the editor re-reads its access and shuts.
        await stream.writeSSE({ event: "access-changed", data: JSON.stringify({ kind: "access-changed", userId: user.id, at: new Date().toISOString() }) }).catch(() => {});
        open = false;
        break;
      }
      await stream.writeSSE({ event: "ping", data: "" }).catch(() => { open = false; });
    }
    unsubscribe();
  });
});
