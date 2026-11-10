import { Hono, type Context } from "hono";
import {
  McpServer,
  OAuthError,
  OAuthErrorCode,
  createMcpHandler,
  fromJsonSchema,
  originValidationResponse,
  requireBearerAuth,
  type AuthInfo,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";
import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { oauthClient } from "../db/schema.js";
import { verifyAccessToken, type TokenAuth } from "../lib/access-tokens.js";
import { ACCOUNT_OPS, runAccountOp } from "../lib/account-ops.js";
import { hasConsent, noteAiCall } from "../lib/connected-ais.js";
import { auth } from "../lib/auth.js";
import { LEGACY_MCP_PATH, MCP_PATH, MCP_PATHS, MCP_SCOPE, mcpResourceMetadataUrl, mcpResourceUrl, type McpPath } from "../lib/mcp-oauth.js";
import { WORLD_OPS, runWorldOp, worldOpKind } from "../lib/world-ops.js";

/**
 * /api/agent/v1 — a card, for an AI that is not ours.
 *
 * A creator makes a token in the Studio (one card per token) and hands it to
 * Claude Code, Codex or Cursor. The token reaches exactly the tools the Studio
 * assistant uses (lib/world-ops.ts), as REST:
 *
 *   GET  /api/agent/v1            the card's directory + the tool list
 *   POST /api/agent/v1/tools/:op  run one op with a JSON body of arguments
 *
 * and as a remote MCP server, served by the official MCP SDK
 * (@modelcontextprotocol/server): Streamable HTTP, stateless, answering both
 * the current protocol and 2025-era clients that open with `initialize`:
 *
 *   claude mcp add --transport http yumina <origin>/mcp \
 *     --header "Authorization: Bearer ymn_…"
 *
 * The MCP endpoint also takes OAuth access tokens (lib/auth.ts oauthProvider):
 * a client given only the URL is challenged, signs the creator in, and works
 * on any of the creator's cards, naming one with `card_id` on each call.
 *
 * Mounted before the cookie-auth "/api/*" routers: a token is the only auth.
 */

type Env = { Variables: { tokenAuth: TokenAuth } };
export const agentApiRoutes = new Hono<Env>();

const INSTRUCTIONS =
  "You are working on one Yumina card (an interactive-fiction game). Call get_world first, and load_skill('core') once before your first write: Yumina's rules for planning, writing and checking a card. " +
  "Entries are lore the AI reads; variables are the state; situations (worldbooks) are parts of the card that switch on, each with its own AI or none. " +
  "get_world's stickyNotes are the creator's sticky notes from the canvas, each with what it is stuck to: read them as the creator's own instructions about those parts. " +
  "A situation whose station.kind is 'custom', or a behavior with custom: true, is a slot the creator declared for you to implement in code; its sticky note says what, and get_world's CUSTOM SLOTS says how. " +
  "Before writing interface code or behaviors, load_skill('tsx') / load_skill('rules'). " +
  "After a batch of writes, validate_world, then playtest with a few player moves and read what changed. " +
  "The creator sees every write appear in their open editor. Never publish; that stays with the creator.";

// A light per-token limit: an agent in a loop should not take the server with it.
const windowCounts = new Map<string, { at: number; n: number }>();
function overLimit(tokenId: string): boolean {
  const now = Date.now();
  const w = windowCounts.get(tokenId);
  if (!w || now - w.at > 60_000) { windowCounts.set(tokenId, { at: now, n: 1 }); return false; }
  w.n += 1;
  return w.n > 240;
}

agentApiRoutes.use("/*", async (c, next) => {
  // /mcp authenticates through the MCP SDK (the standard Bearer challenge).
  if (c.req.path.endsWith("/mcp")) return next();
  const auth = await verifyAccessToken(c.req.header("authorization"));
  if (!auth) {
    return c.json({
      error: "A Yumina card token is required: Authorization: Bearer ymn_… — make one in the Studio (⋮ → Let an outside AI work on this card).",
    }, 401);
  }
  if (overLimit(auth.tokenId)) return c.json({ error: "Too many requests for this token; wait a minute." }, 429);
  c.set("tokenAuth", auth);
  await next();
});

const toolList = () => WORLD_OPS.map((t) => ({ name: t.function.name, description: t.function.description, inputSchema: t.function.parameters }));

agentApiRoutes.get("/", async (c) => {
  const auth = c.get("tokenAuth");
  const world = await runWorldOp({ userId: auth.userId, worldId: auth.worldId, name: "get_world", args: {}, actor: auth.name });
  return c.json({ instructions: INSTRUCTIONS, world: world.result ?? null, tools: toolList() });
});

agentApiRoutes.get("/tools", (c) => c.json({ tools: toolList() }));

agentApiRoutes.post("/tools/:op", async (c) => {
  const auth = c.get("tokenAuth");
  const body = await c.req.json().catch(() => ({}));
  const r = await runWorldOp({ userId: auth.userId, worldId: auth.worldId, name: c.req.param("op"), args: body, actor: auth.name });
  return c.json(r, r.ok ? 200 : 400);
});

// ── MCP (official SDK) ──

const ANNOTATIONS: Record<ReturnType<typeof worldOpKind>, ToolAnnotations> = {
  read: { readOnlyHint: true, openWorldHint: false },
  write: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  delete: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  run: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};
const RESULT_CAP = 200_000;

const ACCOUNT_INSTRUCTIONS =
  "You are signed in as a Yumina creator; you can work on any of their cards (interactive-fiction games). " +
  "Call list_my_cards first and ask which card if it is not clear, or create_card for a new one; then pass that id as card_id to every other tool, starting with get_world. " +
  "Before your first write in a conversation, load_skill('core') once: Yumina's rules for planning, writing and checking a card. " +
  "Entries are lore the AI reads; variables are the state; situations (worldbooks) are parts of the card that switch on, each with its own AI or none. " +
  "get_world's stickyNotes are the creator's sticky notes from the canvas, each with what it is stuck to: read them as the creator's own instructions about those parts. " +
  "A situation whose station.kind is 'custom', or a behavior with custom: true, is a slot the creator declared for you to implement in code; its sticky note says what, and get_world's CUSTOM SLOTS says how. " +
  "Before writing interface code or behaviors, load_skill('tsx') / load_skill('rules'). " +
  "After a batch of writes, validate_world, then playtest with a few player moves and read what changed. " +
  "The creator sees every write appear in their open editor. Never publish; that stays with the creator.";

/** Who is calling: a card token (one card) or a signed-in creator (OAuth). */
type Caller =
  | { kind: "card"; card: TokenAuth }
  | { kind: "account"; userId: string; clientId: string; actor: string; limitKey: string };

const CARD_ID = { type: "string", description: "The card to work on: an id from list_my_cards or create_card." };

/** The same tool, with a required card_id for account callers. */
function withCardId(parameters: Record<string, unknown>): Record<string, unknown> {
  const properties = { card_id: CARD_ID, ...((parameters.properties as Record<string, unknown>) ?? {}) };
  const required = ["card_id", ...(((parameters.required as string[]) ?? []).filter((r) => r !== "card_id"))];
  return { ...parameters, type: "object", properties, required };
}

function toolResult(r: { ok: boolean; result?: unknown; error?: string; image?: { data: string; mimeType: string } }) {
  const text = r.ok ? (typeof r.result === "string" ? r.result : JSON.stringify(r.result, null, 1)) : (r.error ?? "Failed");
  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> =
    [{ type: "text", text: text.length > RESULT_CAP ? text.slice(0, RESULT_CAP) + "\n…(truncated)" : text }];
  if (r.ok && r.image) content.push({ type: "image", data: r.image.data, mimeType: r.image.mimeType });
  return { content, isError: !r.ok };
}

const schemaOf = (parameters: unknown) => fromJsonSchema(parameters as Parameters<typeof fromJsonSchema>[0]);

/** A fresh MCP server per request (stateless), bound to the caller. */
function buildServer(caller: Caller): McpServer {
  const account = caller.kind === "account";
  const server = new McpServer({ name: "yumina", version: "1.0.0" }, { instructions: account ? ACCOUNT_INSTRUCTIONS : INSTRUCTIONS });
  if (account) {
    for (const tool of ACCOUNT_OPS) {
      const name = tool.function.name;
      server.registerTool(name, {
        description: tool.function.description,
        inputSchema: schemaOf(tool.function.parameters),
        annotations: name === "list_my_cards" ? ANNOTATIONS.read : { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      }, async (args) => {
        noteAiCall(caller.userId, caller.clientId, name);
        return toolResult(await runAccountOp({ userId: caller.userId, name, input: (args ?? {}) as Record<string, unknown> }));
      });
    }
  }
  for (const tool of WORLD_OPS) {
    const name = tool.function.name;
    server.registerTool(name, {
      description: tool.function.description,
      inputSchema: schemaOf(account ? withCardId(tool.function.parameters as Record<string, unknown>) : tool.function.parameters),
      annotations: ANNOTATIONS[worldOpKind(name)],
    }, async (args) => {
      const input = { ...((args ?? {}) as Record<string, unknown>) };
      if (caller.kind === "card") {
        return toolResult(await runWorldOp({ userId: caller.card.userId, worldId: caller.card.worldId, name, args: input, actor: caller.card.name }));
      }
      noteAiCall(caller.userId, caller.clientId, name);
      const worldId = typeof input.card_id === "string" ? input.card_id : "";
      delete input.card_id;
      if (!worldId) return toolResult({ ok: false, error: "Pass card_id: call list_my_cards to find it." });
      return toolResult(await runWorldOp({ userId: caller.userId, worldId, name, args: input, actor: caller.actor }));
    });
  }
  return server;
}

const mcpHandler = createMcpHandler(({ authInfo }) => buildServer(authInfo?.extra?.caller as Caller), { responseMode: "json" });

// Given our auth instance, the resource client finds the issuer and JWKS
// itself; its parameter type is the generic Auth, which our configured
// instance's narrower options don't satisfy structurally.
const resourceClient = oauthProviderResourceClient(auth as unknown as Parameters<typeof oauthProviderResourceClient>[0] & object).getActions();
const clientNames = new Map<string, string>();

// Our own signing keys (Better Auth jwt plugin, /api/auth/jwks), read from
// this process rather than through the public domain; jose caches the set.
const LOCAL_JWKS_URL = `http://127.0.0.1:${process.env.PORT ?? 3000}/api/auth/jwks`;

/** The name a signed-in AI registered with ("Claude", "Codex"…), for the editor. */
async function clientName(clientId: string | undefined): Promise<string> {
  if (!clientId) return "AI";
  const known = clientNames.get(clientId);
  if (known) return known;
  const [row] = await db.select({ name: oauthClient.name }).from(oauthClient).where(eq(oauthClient.clientId, clientId)).limit(1);
  const name = row?.name?.trim() || "AI";
  clientNames.set(clientId, name);
  return name;
}

// Two kinds of bearer: a card token (ymn_…, never expires on its own — the SDK
// wants an expiry, so each request gets a short one) or an OAuth access token
// issued by our authorization server for this resource.
// One gate per address (/mcp, and the first /api/agent/v1/mcp): each names its
// own resource in the challenge. A token minted for either address is good at both.
const bearerGate = (path: McpPath) => requireBearerAuth({
  resourceMetadataUrl: mcpResourceMetadataUrl(path),
  verifier: {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      if (token.startsWith("ymn_")) {
        const card = await verifyAccessToken(`Bearer ${token}`);
        if (!card) throw new OAuthError(OAuthErrorCode.InvalidToken, "This card token was revoked or never existed.");
        const caller: Caller = { kind: "card", card };
        return { token, clientId: card.tokenId, scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 3600, extra: { caller } };
      }
      let payload: Awaited<ReturnType<typeof resourceClient.verifyAccessToken>>;
      try {
        payload = await resourceClient.verifyAccessToken(token, { verifyOptions: { audience: MCP_PATHS.map((p) => mcpResourceUrl(p)) }, scopes: [MCP_SCOPE], jwksUrl: LOCAL_JWKS_URL });
      } catch (error) {
        console.warn("[agent-api] OAuth token rejected:", error instanceof Error ? error.message : error);
        throw new OAuthError(OAuthErrorCode.InvalidToken, "Sign in to Yumina again.");
      }
      const userId = typeof payload.sub === "string" ? payload.sub : "";
      if (!userId) throw new OAuthError(OAuthErrorCode.InvalidToken, "This token is not for a Yumina account.");
      const clientId = typeof payload.azp === "string" ? payload.azp : typeof payload.client_id === "string" ? payload.client_id : undefined;
      // A creator who disconnected this AI ends its access now, not at expiry.
      if (!clientId || !(await hasConsent(userId, clientId))) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "This AI was disconnected from Yumina; sign in again to reconnect.");
      }
      const caller: Caller = { kind: "account", userId, clientId, actor: await clientName(clientId), limitKey: `oauth:${userId}:${clientId}` };
      const scopes = typeof payload.scope === "string" ? payload.scope.split(" ") : [];
      return { token, clientId: clientId ?? "unknown", scopes, expiresAt: typeof payload.exp === "number" ? payload.exp : undefined, resource: new URL(mcpResourceUrl(path)), extra: { caller } };
    },
  },
});

/**
 * Discovery documents an MCP client reads after the 401 challenge, mounted at
 * the site root (RFC 9728 / RFC 8414 path insertion): what the MCP resource
 * is and which authorization server issues its tokens, and that server's own
 * metadata (Better Auth serves it under /api/auth; clients look at the root).
 */
export const mcpDiscoveryRoutes = new Hono();
for (const path of MCP_PATHS) {
  mcpDiscoveryRoutes.get(`/.well-known/oauth-protected-resource${path}`, async (c) =>
    c.json(await resourceClient.getProtectedResourceMetadata({ resource: mcpResourceUrl(path), scopes_supported: [MCP_SCOPE] }, { silenceWarnings: { oidcScopes: true } })),
  );
}
const authServerMetadata = oauthProviderAuthServerMetadata(auth);
const openIdMetadata = oauthProviderOpenIdConfigMetadata(auth);
// The issuer is the site origin, so clients ask at the root; the /api/auth
// insertion form is there too for clients that start from the auth base URL.
// Open registration takes public clients only (PKCE, no secret): the plugin
// refuses a confidential client that registers without a session. Its metadata
// still lists the secret methods, so a client that reads it (Claude) registers
// as confidential and gets a 401 — say what registration actually accepts.
async function publicClientsOnly(c: Context, res: Response): Promise<Response> {
  if (!res.ok) return res;
  const body = (await res.json()) as Record<string, unknown>;
  return c.json({ ...body, token_endpoint_auth_methods_supported: ["none"] });
}
for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/api/auth"]) {
  mcpDiscoveryRoutes.get(path, async (c) => publicClientsOnly(c, await authServerMetadata(c.req.raw)));
}
for (const path of ["/.well-known/openid-configuration", "/.well-known/openid-configuration/api/auth"]) {
  mcpDiscoveryRoutes.get(path, async (c) => publicClientsOnly(c, await openIdMetadata(c.req.raw)));
}

// A browser page may call only from our own sites; non-browser clients send no Origin.
const ALLOWED_ORIGINS = ["yumina.io", "www.yumina.io", "localhost", "127.0.0.1"];

const gates = { [MCP_PATH]: bearerGate(MCP_PATH), [LEGACY_MCP_PATH]: bearerGate(LEGACY_MCP_PATH) } as Record<McpPath, ReturnType<typeof bearerGate>>;

async function serveMcp(c: Context, path: McpPath): Promise<Response> {
  const rejected = originValidationResponse(c.req.raw, ALLOWED_ORIGINS);
  if (rejected) return rejected;
  const auth = await gates[path](c.req.raw);
  // Not `instanceof Response`: @hono/node-server swaps the global Response
  // class, so the SDK's challenge fails that check.
  if (!("token" in auth)) return auth;
  const caller = auth.extra?.caller as Caller;
  if (overLimit(caller.kind === "card" ? caller.card.tokenId : caller.limitKey)) {
    return c.json({ error: "Too many requests; wait a minute." }, 429);
  }
  return mcpHandler.fetch(c.req.raw, { authInfo: auth });
}

agentApiRoutes.all("/mcp", (c) => serveMcp(c, LEGACY_MCP_PATH));
mcpDiscoveryRoutes.all(MCP_PATH, (c) => serveMcp(c, MCP_PATH));
