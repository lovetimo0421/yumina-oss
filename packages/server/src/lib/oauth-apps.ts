import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { oauthClient } from "../db/schema.js";

/**
 * What Yumina knows about an OAuth client beyond what the provider plugin
 * uses: whether it is a first-party app (a row seeded by SQL with
 * `metadata.firstParty`, scripts/2026-10-21-oauth-apps.sql) and the label its
 * mushie charges carry. Open registration cannot write `metadata` (the
 * plugin's register schema has no such field) and the client CRUD endpoints
 * are disabled (lib/auth.ts), so only SQL can make a client first-party.
 */
export interface OAuthAppClient {
  clientId: string;
  name: string;
  firstParty: boolean;
  /** Prefix of every ledger line this app's calls write. */
  ledgerLabel: string;
  disabled: boolean;
  scopes: string[];
}

export function parseAppMetadata(metadata: unknown): { firstParty: boolean; ledgerLabel: string | null } {
  let value: unknown = metadata;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { value = null; }
  }
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const label = typeof record.ledgerLabel === "string" ? record.ledgerLabel.trim().slice(0, 60) : "";
  return { firstParty: record.firstParty === true, ledgerLabel: label || null };
}

export function toAppClient(row: {
  clientId: string; name: string | null; metadata: unknown; disabled: boolean | null; scopes: string[] | null;
}): OAuthAppClient {
  const meta = parseAppMetadata(row.metadata);
  const name = row.name?.trim() || "App";
  return {
    clientId: row.clientId,
    name,
    firstParty: meta.firstParty,
    ledgerLabel: meta.ledgerLabel ?? name,
    disabled: row.disabled === true,
    scopes: row.scopes ?? [],
  };
}

// Client rows are configuration: a minute of staleness is fine, and the
// gateway reads one on every call.
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; client: OAuthAppClient | null }>();

export async function getOAuthAppClient(clientId: string): Promise<OAuthAppClient | null> {
  const hit = cache.get(clientId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.client;
  const [row] = await db.select({
    clientId: oauthClient.clientId, name: oauthClient.name, metadata: oauthClient.metadata,
    disabled: oauthClient.disabled, scopes: oauthClient.scopes,
  }).from(oauthClient).where(eq(oauthClient.clientId, clientId)).limit(1);
  const client = row ? toAppClient(row) : null;
  if (cache.size > 5_000) cache.clear();
  cache.set(clientId, { at: Date.now(), client });
  return client;
}
