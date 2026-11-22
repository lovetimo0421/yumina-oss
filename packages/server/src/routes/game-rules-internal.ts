// game-rt → API, for rules rooms (`rules:<CODE>` tables). Not for browsers:
// every request is HMAC-signed with GAME_TICKET_SECRET by the game server
// (lib/game-internal-auth.ts holds the contract).
//   GET  /api/internal/rules-source/:worldId[?have=<version>]  the card's rules file
//   POST /api/internal/rules-ai                                 one AI seat move, billed to the host
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createInternalVerifier } from "../lib/game-internal-auth.js";
import { loadRulesSource, playRulesSeat, rulesAiInputSchema, type RulesAiInput, type RulesAiOutcome, type RulesSourcePayload } from "../lib/rules-room.js";

export interface GameRulesInternalDeps {
  secret: () => string;
  loadSource: (worldId: string) => Promise<RulesSourcePayload | { error: string }>;
  playSeat: (input: RulesAiInput, signal: AbortSignal) => Promise<RulesAiOutcome>;
  now?: () => number;
}

const defaultDeps: GameRulesInternalDeps = {
  secret: () => process.env.GAME_TICKET_SECRET ?? (process.env.NODE_ENV === "production" ? "" : "dev-secret"),
  loadSource: (worldId) => loadRulesSource(worldId),
  playSeat: playRulesSeat,
};

export function createGameRulesInternalRoutes(deps: GameRulesInternalDeps = defaultDeps) {
  const routes = new Hono();
  const verify = createInternalVerifier(deps.now);

  routes.use("*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "payload-too-large" }, 413) }));
  routes.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const secret = deps.secret();
    if (!secret) return c.json({ error: "game-not-configured" }, 503);
    const body = c.req.method === "GET" ? "" : await c.req.text();
    const result = verify({
      secret, method: c.req.method, path: c.req.path, body,
      ts: c.req.header("x-yumina-ts"), nonce: c.req.header("x-yumina-nonce"), sig: c.req.header("x-yumina-sig"),
    });
    if (result !== "ok") return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  routes.get("/rules-source/:worldId", async (c) => {
    const worldId = c.req.param("worldId");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(worldId)) return c.json({ error: "bad-world" }, 400);
    const found = await deps.loadSource(worldId);
    if ("error" in found) return c.json({ error: found.error }, 404);
    if (c.req.query("have") === found.version) return c.body(null, 304);
    return c.json({ data: found });
  });

  routes.post("/rules-ai", async (c) => {
    let raw: unknown;
    try { raw = JSON.parse(await c.req.text()); } catch { return c.json({ error: "bad-request" }, 400); }
    const parsed = rulesAiInputSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: "bad-request" }, 400);
    const out = await deps.playSeat(parsed.data, c.req.raw.signal);
    if ("error" in out) return c.json({ error: out.error }, out.status);
    return c.json({ data: { action: out.action } });
  });

  return routes;
}

export default createGameRulesInternalRoutes;
