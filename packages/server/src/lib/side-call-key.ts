/**
 * Whose OpenRouter key a platform side call (Jev judge, TTS casting/emotion,
 * per-turn image tagging) runs on.
 *
 * A player in OpenRouter BYOK mode pays for these on their own key. Any
 * failure on that key (rejected, no access to the endpoint, out of balance)
 * falls back to the platform key for that one call — the side call is never
 * worth failing a turn over. A key that was refused for an endpoint is
 * remembered for a few minutes, so a key without access doesn't cost a
 * failed round-trip on every turn.
 *
 * Pure in-memory state, no DB: callers resolve the key themselves.
 */
import { createHash } from "node:crypto";
import type { ApiKeyTier } from "./resolve-provider.js";

export type SideCallKeySource = "byok" | "platform";

/** The player's own OpenRouter key, for one side call. */
export interface PlayerSideKey {
  userId: string;
  apiKey: string;
}

/** Which endpoint family a refusal applies to: a key can lack the alpha
 *  decisions endpoint and still be fine for chat completions. */
export type SideCallScope = "decisions" | "chat";

export const PLAYER_KEY_DENY_TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 5000;
const denied = new Map<string, number>();

function denyKey(key: PlayerSideKey, scope: SideCallScope): string {
  // The key's hash is part of the entry, so a player who swaps in a new key
  // is tried again at once.
  const fp = createHash("sha256").update(key.apiKey).digest("hex").slice(0, 16);
  return `${scope}:${key.userId}:${fp}`;
}

export function playerKeyDenied(key: PlayerSideKey, scope: SideCallScope, now = Date.now()): boolean {
  const k = denyKey(key, scope);
  const until = denied.get(k);
  if (until === undefined) return false;
  if (until > now) return true;
  denied.delete(k);
  return false;
}

export function markPlayerKeyDenied(key: PlayerSideKey, scope: SideCallScope, now = Date.now()): void {
  const k = denyKey(key, scope);
  denied.delete(k);
  denied.set(k, now + PLAYER_KEY_DENY_TTL_MS);
  while (denied.size > MAX_ENTRIES) denied.delete(denied.keys().next().value!);
}

/** Test hook. */
export function resetPlayerKeyDenials(): void {
  denied.clear();
}

/** HTTP statuses that say "this key can't make this call" (as opposed to a
 *  transient upstream problem): worth remembering for the deny window. */
export function isKeyRefusalStatus(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status === 404;
}

/** usage_logs tier for a side call: the player's key, or the platform's
 *  (logged as "regular", free by design). */
export function sideCallTier(source: SideCallKeySource): ApiKeyTier {
  return source === "byok" ? "byok" : "regular";
}

/** The player's key may only ever go to OpenRouter. */
export function isOpenRouterUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "openrouter.ai" || u.hostname.endsWith(".openrouter.ai"));
  } catch {
    return false;
  }
}
