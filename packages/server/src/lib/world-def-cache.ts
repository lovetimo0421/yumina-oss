import { eq } from "drizzle-orm";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { worlds } from "../db/schema.js";
import { getPendingEdit } from "./pending-edit.js";
import { viewerSeesWorkingCopy } from "./working-copy.js";

/**
 * Parsed world definitions for the session write paths (state patch,
 * execute-action). Same design as the message route's cache: keyed by the
 * world's `updatedAt` version stamp, which is re-read cheaply on every call, so
 * the cache can never serve a stale schema and needs no invalidation. Before
 * this, every state save ran `SELECT * FROM worlds` — a multi-MB JSONB detoast
 * plus a full migrate — about a million times a week for a schema that changes
 * a few times a day.
 *
 * Deliberately a separate instance from routes/messages.ts (which also keeps a
 * viewer-scoped pending-edit cache); at ≤200 entries each the duplication is
 * cheap and keeps the send path untouched.
 */
const CACHE_MAX = 200;
const cache = new Map<string, { worldDef: WorldDefinition; updatedAt: number }>();

function getCached(worldId: string, updatedAt: Date | null): WorldDefinition | null {
  if (!updatedAt) return null;
  const entry = cache.get(worldId);
  if (!entry || entry.updatedAt !== updatedAt.getTime()) return null;
  return entry.worldDef;
}

function setCached(worldId: string, updatedAt: Date | null, worldDef: WorldDefinition): void {
  if (!updatedAt) return;
  if (cache.size >= CACHE_MAX && !cache.has(worldId)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(worldId, { worldDef, updatedAt: updatedAt.getTime() });
}

/**
 * The world definition a viewer's session should be normalised against. A
 * creator playing their own published world gets their held working copy
 * (never cached — it is theirs alone and rare); everyone else gets the live
 * schema from the version-stamped cache. Null when the world is gone.
 */
export async function loadSessionWorldDef(worldId: string, viewerId: string): Promise<WorldDefinition | null> {
  const [meta] = await db
    .select({ id: worlds.id, status: worlds.status, creatorId: worlds.creatorId, updatedAt: worlds.updatedAt })
    .from(worlds)
    .where(eq(worlds.id, worldId))
    .limit(1);
  if (!meta) return null;

  if (viewerSeesWorkingCopy(meta.status, meta.creatorId, viewerId)) {
    const pending = await getPendingEdit(meta.id);
    if (pending?.schema) return migrateWorldDefinition(pending.schema as unknown as WorldDefinition);
  }

  const cached = getCached(meta.id, meta.updatedAt);
  if (cached) return cached;

  const [row] = await db.select({ schema: worlds.schema }).from(worlds).where(eq(worlds.id, meta.id)).limit(1);
  if (!row) return null;
  const worldDef = migrateWorldDefinition(row.schema as unknown as WorldDefinition);
  setCached(meta.id, meta.updatedAt, worldDef);
  return worldDef;
}
