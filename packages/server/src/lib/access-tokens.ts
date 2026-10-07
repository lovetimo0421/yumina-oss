import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { worldAccessTokens } from "../db/schema.js";

/**
 * World access tokens: what a creator pastes into Claude Code / Codex / Cursor
 * so an outside AI can work on ONE card. `ymn_` + 32 random bytes, shown once;
 * only its SHA-256 is stored, so a leaked database leaks no usable token.
 */

const PREFIX = "ymn_";
/** A card token stops working this long after it was made. */
export const TOKEN_LIFETIME_DAYS = 90;
const LIFETIME_MS = TOKEN_LIFETIME_DAYS * 24 * 3600_000;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export interface AccessTokenInfo {
  id: string;
  name: string;
  prefix: string;
  createdAt: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

const info = (row: typeof worldAccessTokens.$inferSelect): AccessTokenInfo => ({
  id: row.id,
  name: row.name,
  prefix: row.tokenPrefix,
  createdAt: row.createdAt?.toISOString() ?? null,
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  expiresAt: row.createdAt ? new Date(row.createdAt.getTime() + LIFETIME_MS).toISOString() : null,
});

export async function createAccessToken(args: { userId: string; worldId: string; name: string }): Promise<{ token: string; info: AccessTokenInfo }> {
  const token = PREFIX + randomBytes(32).toString("base64url");
  const [row] = await db.insert(worldAccessTokens).values({
    userId: args.userId,
    worldId: args.worldId,
    name: args.name.trim().slice(0, 60) || "AI",
    tokenHash: hash(token),
    tokenPrefix: token.slice(0, PREFIX.length + 6),
  }).returning();
  return { token, info: info(row!) };
}

export async function listAccessTokens(userId: string, worldId: string): Promise<AccessTokenInfo[]> {
  const rows = await db.select().from(worldAccessTokens)
    .where(and(eq(worldAccessTokens.userId, userId), eq(worldAccessTokens.worldId, worldId), isNull(worldAccessTokens.revokedAt)))
    .orderBy(desc(worldAccessTokens.createdAt));
  return rows.map(info);
}

export async function revokeAccessToken(userId: string, id: string): Promise<boolean> {
  const rows = await db.update(worldAccessTokens).set({ revokedAt: new Date() })
    .where(and(eq(worldAccessTokens.id, id), eq(worldAccessTokens.userId, userId), isNull(worldAccessTokens.revokedAt)))
    .returning();
  return rows.length > 0;
}

export interface TokenAuth { tokenId: string; userId: string; worldId: string; name: string }

const lastTouched = new Map<string, number>();

/** The live token behind an `Authorization: Bearer ymn_…` header, or null. */
export async function verifyAccessToken(header: string | undefined): Promise<TokenAuth | null> {
  const token = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token || !token.startsWith(PREFIX)) return null;
  const [row] = await db.select().from(worldAccessTokens)
    .where(and(eq(worldAccessTokens.tokenHash, hash(token)), isNull(worldAccessTokens.revokedAt)))
    .limit(1);
  if (!row) return null;
  if (row.createdAt && Date.now() - row.createdAt.getTime() > LIFETIME_MS) return null;
  // "Last used" is for the creator's list, not an audit log: once a minute.
  const now = Date.now();
  if ((lastTouched.get(row.id) ?? 0) < now - 60_000) {
    lastTouched.set(row.id, now);
    void db.update(worldAccessTokens).set({ lastUsedAt: new Date(now) }).where(eq(worldAccessTokens.id, row.id)).catch(() => {});
  }
  return { tokenId: row.id, userId: row.userId, worldId: row.worldId, name: row.name };
}
