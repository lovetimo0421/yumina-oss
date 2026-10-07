import { and, eq, isNull } from "drizzle-orm";
import { db, readOwn } from "../db/index.js";
import { oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken } from "../db/schema.js";
import { redis } from "./redis.js";

/**
 * The outside AIs a creator has signed in to Yumina (OAuth consents), and
 * taking one back. Better Auth's own delete-consent only drops the consent
 * row; a disconnect here also revokes that AI's refresh tokens and stored
 * access tokens, and the card MCP checks the consent on every call (see
 * hasConsent), so a disconnect takes effect at once rather than when the
 * last access token expires.
 */

export interface ConnectedAi {
  clientId: string; name: string; connectedAt: Date | null; lastUsedAt: Date | null;
  /** The AI's latest tool call, so the "Connect your AI" wizard can confirm the first message arrived. */
  lastCallAt: string | null; lastTool: string | null;
}

// Last tool call per creator and AI. Replicas share it through Redis (the
// call and the creator's open wizard often land on different ones); without
// Redis (dev) it stays in-process.
interface LastCall { at: string; tool: string }
const lastCalls = new Map<string, LastCall>();
const lastCallKey = (userId: string, clientId: string) => `ai-last-call:${userId}:${clientId}`;

export function noteAiCall(userId: string, clientId: string, tool: string): void {
  const key = lastCallKey(userId, clientId);
  const value: LastCall = { at: new Date().toISOString(), tool };
  lastCalls.set(key, value);
  redis?.set(key, JSON.stringify(value), "EX", 30 * 24 * 3600).catch(() => {});
}

async function lastCallOf(userId: string, clientId: string): Promise<LastCall | null> {
  const key = lastCallKey(userId, clientId);
  if (redis) {
    try {
      const raw = await redis.get(key);
      if (raw) return JSON.parse(raw) as LastCall;
    } catch { /* fall back to this replica's own */ }
  }
  return lastCalls.get(key) ?? null;
}

export async function listConnectedAis(userId: string): Promise<ConnectedAi[]> {
  const rows = await (await readOwn(userId))
    .select({ clientId: oauthConsent.clientId, name: oauthClient.name, createdAt: oauthConsent.createdAt, updatedAt: oauthConsent.updatedAt })
    .from(oauthConsent)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .where(eq(oauthConsent.userId, userId));
  const lastUsed = new Map<string, Date>();
  const tokens = await (await readOwn(userId))
    .select({ clientId: oauthAccessToken.clientId, createdAt: oauthAccessToken.createdAt })
    .from(oauthAccessToken)
    .where(eq(oauthAccessToken.userId, userId));
  for (const t of tokens) {
    if (!t.createdAt) continue;
    const prev = lastUsed.get(t.clientId);
    if (!prev || prev < t.createdAt) lastUsed.set(t.clientId, t.createdAt);
  }
  return Promise.all(rows.map(async (r) => {
    const call = await lastCallOf(userId, r.clientId);
    return {
      clientId: r.clientId, name: r.name?.trim() || "AI", connectedAt: r.createdAt,
      lastUsedAt: lastUsed.get(r.clientId) ?? r.updatedAt, lastCallAt: call?.at ?? null, lastTool: call?.tool ?? null,
    };
  }));
}

export async function disconnectAi(userId: string, clientId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const removed = await tx.delete(oauthConsent)
      .where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)))
      .returning();
    await tx.update(oauthRefreshToken).set({ revoked: new Date() })
      .where(and(eq(oauthRefreshToken.userId, userId), eq(oauthRefreshToken.clientId, clientId), isNull(oauthRefreshToken.revoked)));
    await tx.delete(oauthAccessToken)
      .where(and(eq(oauthAccessToken.userId, userId), eq(oauthAccessToken.clientId, clientId)));
    consentCache.delete(`${userId}:${clientId}`);
    return removed.length > 0;
  });
}

// The MCP endpoint asks on every call; a short cache keeps that off the DB
// for an agent making many calls, and a disconnect clears its entry.
const consentCache = new Map<string, { ok: boolean; at: number }>();

export async function hasConsent(userId: string, clientId: string): Promise<boolean> {
  const key = `${userId}:${clientId}`;
  const hit = consentCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.ok;
  const [row] = await (await readOwn(userId)).select({ id: oauthConsent.id }).from(oauthConsent)
    .where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId))).limit(1);
  consentCache.set(key, { ok: !!row, at: Date.now() });
  return !!row;
}
