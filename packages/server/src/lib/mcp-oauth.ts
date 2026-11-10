import { PUBLIC_ORIGIN } from "./env.js";

/**
 * The card MCP as an OAuth-protected resource.
 *
 * An outside AI that signs in (instead of pasting a card token) receives an
 * access token for this resource with this scope; it can then work on any of
 * the creator's own cards, naming the card on each call.
 */
export const MCP_SCOPE = "cards";

/** The address creators paste: short, and permanent once published. */
export const MCP_PATH = "/mcp";
/** The first address (testing only, before /mcp); still served so nothing breaks. */
export const LEGACY_MCP_PATH = "/api/agent/v1/mcp";
export const MCP_PATHS = [MCP_PATH, LEGACY_MCP_PATH] as const;
export type McpPath = (typeof MCP_PATHS)[number];

/** The MCP endpoint's resource identifier (RFC 8707): its public URL. */
export function mcpResourceUrl(path: McpPath = MCP_PATH): string {
  return `${PUBLIC_ORIGIN}${path}`;
}

/** Where clients find the resource's metadata (RFC 9728 path insertion). */
export function mcpResourceMetadataUrl(path: McpPath = MCP_PATH): string {
  return `${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource${path}`;
}
