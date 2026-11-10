import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, not, or, type SQL, type SQLWrapper } from "drizzle-orm";
import { worlds } from "../db/schema.js";

// Hosting configures the policy. The local edition has no restrictions.
export interface WorldAudienceRule { worldId: string; creatorId: string }
let rules: readonly WorldAudienceRule[] = [];
const viewer = new AsyncLocalStorage<{ id?: string; isAdmin: boolean }>();

export function configureWorldAudience(value: readonly WorldAudienceRule[]) {
  rules = value.slice();
}

export function runWithWorldViewer<T>(id: string | undefined, operation: () => Promise<T>, isAdmin = false) {
  return viewer.run({ id, isAdmin }, operation);
}

export function currentWorldViewerId() { return viewer.getStore()?.id; }

export function hiddenWorldIds(viewerId = viewer.getStore()?.id, isAdmin = viewer.getStore()?.id === viewerId && viewer.getStore()?.isAdmin === true): string[] {
  return isAdmin ? [] : rules.filter(rule => rule.creatorId !== viewerId).map(rule => rule.worldId);
}

export function isWorldAudienceRestricted(worldId: string, creatorId: string) {
  return rules.some(rule => rule.worldId === worldId && rule.creatorId === creatorId);
}

export function worldAudienceCondition(creatorColumn: SQLWrapper, viewerId = viewer.getStore()?.id, worldColumn: SQLWrapper = worlds.id): SQL | undefined {
  const hidden = new Set(hiddenWorldIds(viewerId));
  const conditions = rules.filter(rule => hidden.has(rule.worldId))
    .map(rule => and(eq(worldColumn, rule.worldId), eq(creatorColumn, rule.creatorId))!);
  return conditions.length ? not(or(...conditions)!) : undefined;
}

const OMIT = Symbol("hidden world");
const WORLD_KEYS = new Set(["worldId", "world_id", "snapshotWorldId", "citedWorldId", "sessionId", "session_id", "checkpointId", "checkpoint_id", "shareId", "share_id"]);

/** Last-mile protection for denormalized citations, library rows and notifications. */
export function filterWorldAudience(value: unknown, hiddenWorldIds: ReadonlySet<string>): unknown {
  function visit(item: unknown): unknown {
    if (!item || typeof item !== "object") return item;
    if (Array.isArray(item)) return item.map(visit).filter(row => row !== OMIT);
    const row = item as Record<string, unknown>;
    if (typeof row.id === "string" && hiddenWorldIds.has(row.id)) return OMIT;
    for (const key of WORLD_KEYS) {
      if (typeof row[key] === "string" && hiddenWorldIds.has(row[key])) return OMIT;
    }
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(row)) {
      const filtered = visit(child);
      // A record whose embedded card/payload is hidden must disappear with it.
      if (filtered === OMIT && ["world", "payload", "citedWorld", "metadata", "message"].includes(key)) return OMIT;
      if (filtered !== OMIT) result[key] = filtered;
    }
    if (typeof row.featuredWorldId === "string" && hiddenWorldIds.has(row.featuredWorldId)) result.featuredWorldId = null;
    if (typeof row.sourceWorldId === "string" && hiddenWorldIds.has(row.sourceWorldId)) {
      for (const key of ["sourceWorldId", "sourceWorldName", "sourceCreatorId", "sourceCreatorName", "sourceWorldPublished"]) result[key] = null;
    }
    return result;
  }
  const filtered = visit(value);
  return filtered === OMIT ? undefined : filtered;
}
