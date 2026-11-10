import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.js";
import { disconnectAi, listConnectedAis } from "../lib/connected-ais.js";
import { getOAuthAppClient } from "../lib/oauth-apps.js";
import type { AppEnv } from "../lib/types.js";

/**
 * /api/connected-apps — the apps and outside AIs signed in to this account
 * through Yumina's OAuth server (Settings → Account → Connected apps), and the
 * facts the consent page needs about one asking.
 *
 * A disconnect drops the consent, revokes the app's refresh tokens (so it
 * cannot mint new access tokens) and its stored access tokens; the card MCP
 * and the AI gateway also check the consent on every call, so a JWT access
 * token already handed out stops working at once (lib/connected-ais.ts).
 */
export const connectedAppsRoutes = new Hono<AppEnv>();
connectedAppsRoutes.use("/*", authMiddleware);

connectedAppsRoutes.get("/", async (c) => {
  return c.json({ data: await listConnectedAis(c.get("user").id) });
});

connectedAppsRoutes.delete("/:clientId", async (c) => {
  const ok = await disconnectAi(c.get("user").id, c.req.param("clientId"));
  return ok ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
});

// For /oauth/consent: the app's name, and whether Yumina registered it itself
// (anyone can register a client under any name through open registration).
connectedAppsRoutes.get("/clients/:clientId", async (c) => {
  const client = await getOAuthAppClient(c.req.param("clientId"));
  if (!client || client.disabled) return c.json({ error: "Not found" }, 404);
  return c.json({ data: { clientId: client.clientId, name: client.name, firstParty: client.firstParty, scopes: client.scopes } });
});
