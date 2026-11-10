import { PUBLIC_ORIGIN } from "./env.js";
import { MCP_SCOPE } from "./mcp-oauth.js";

/**
 * Outside apps (desktop game mods, the future desktop app, hardware) that sign
 * a player in to Yumina with OAuth 2.1 (lib/auth.ts oauthProvider) and then
 * use the AI gateway (routes/ai-gateway.ts) as that player.
 *
 * A native app is a public client: Authorization Code + PKCE (S256) with a
 * loopback redirect (RFC 8252), `resource` = the AI gateway (RFC 8707) so its
 * access token is a short-lived JWT bound to that audience.
 */

/** Chat with Yumina's models, billed to the player's mushies. */
export const AI_CHAT_SCOPE = "ai:chat";
/** Read the player's balance and plan. */
export const WALLET_READ_SCOPE = "wallet:read";
/** Read and claim the player's daily and weekly quests. */
export const QUESTS_SCOPE = "quests";

/**
 * Scopes only a first-party app may hold: one Yumina registered itself (a row
 * seeded by SQL with `metadata.firstParty`, see scripts/2026-10-21-oauth-apps.sql).
 * Open (dynamic) client registration can never ask for these.
 */
export const FIRST_PARTY_APP_SCOPES = [AI_CHAT_SCOPE, WALLET_READ_SCOPE, QUESTS_SCOPE] as const;

/** What any client may register with through open registration (the card MCP). */
export const DYNAMIC_CLIENT_SCOPES = ["openid", "profile", "offline_access", MCP_SCOPE];

/** Every scope the authorization server knows. */
export const ALL_OAUTH_SCOPES = [...DYNAMIC_CLIENT_SCOPES, ...FIRST_PARTY_APP_SCOPES];

/** An app token for the gateway lives this long; the app refreshes it. */
export const APP_ACCESS_TOKEN_LIFETIME = "15m";

export const AI_GATEWAY_PATH = "/api/ai/v1";

/** The AI gateway's resource identifier (RFC 8707): its public URL. */
export function aiGatewayResourceUrl(): string {
  return `${PUBLIC_ORIGIN}${AI_GATEWAY_PATH}`;
}
