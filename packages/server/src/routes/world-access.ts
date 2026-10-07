import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { streamSSE } from "hono/streaming";
import { readOwn } from "../db/index.js";
import { worlds } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { createAccessToken, listAccessTokens, revokeAccessToken } from "../lib/access-tokens.js";
import { subscribeWorldEvents } from "../lib/world-events.js";
import { disconnectAi, listConnectedAis } from "../lib/connected-ais.js";
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

// The AIs signed in to this account (OAuth), across all cards.
worldAccessRoutes.get("/connected-ais", async (c) => {
  const user = c.get("user");
  return c.json({ data: await listConnectedAis(user.id) });
});

worldAccessRoutes.delete("/connected-ais/:clientId", async (c) => {
  const user = c.get("user");
  const ok = await disconnectAi(user.id, c.req.param("clientId"));
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
  if (!(await ownsWorld(user.id, worldId))) return c.json({ error: "Not found" }, 404);
  return streamSSE(c, async (stream) => {
    let open = true;
    const unsubscribe = subscribeWorldEvents(worldId, (event) => {
      if (open) void stream.writeSSE({ event: event.kind, data: JSON.stringify(event) }).catch(() => {});
    });
    stream.onAbort(() => { open = false; unsubscribe(); });
    // Proxies close quiet connections; a comment every 25s keeps it.
    while (open) {
      await stream.sleep(25_000);
      if (open) await stream.writeSSE({ event: "ping", data: "" }).catch(() => { open = false; });
    }
    unsubscribe();
  });
});
