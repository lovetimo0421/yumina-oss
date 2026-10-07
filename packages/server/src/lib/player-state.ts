import { and, eq, sql } from "drizzle-orm";
import type { WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { playerWorldState } from "../db/schema.js";

/**
 * 跨存档保留: values a player keeps across every playthrough of a card.
 *
 * 126 published card interfaces kept these in the browser (clears, unlocked
 * endings, collected CGs) because variables reset with each new chat — and a
 * browser forgets on another device. Variables marked `persist: "player"`
 * live here, one row per player and card; a new session starts from them.
 */

/** The card's variables that persist, by id. */
export function persistentVariableIds(world: Pick<WorldDefinition, "variables">): Set<string> {
  return new Set((world.variables ?? []).filter((v) => v.persist === "player").map((v) => v.id));
}

/** What this player has saved for this card, only for variables that still persist. */
export async function loadPlayerValues(userId: string, worldId: string, world: Pick<WorldDefinition, "variables">): Promise<Record<string, unknown>> {
  const keep = persistentVariableIds(world);
  if (keep.size === 0) return {};
  const [row] = await db
    .select({ values: playerWorldState.values })
    .from(playerWorldState)
    .where(and(eq(playerWorldState.userId, userId), eq(playerWorldState.worldId, worldId)))
    .limit(1)
    .catch(() => []);
  const values = (row?.values ?? {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(values).filter(([id]) => keep.has(id)));
}

/** Merge these values in (only variables that persist); returns what was kept. */
export async function savePlayerValues(userId: string, worldId: string, world: Pick<WorldDefinition, "variables">, values: Record<string, unknown>): Promise<Record<string, unknown>> {
  const keep = persistentVariableIds(world);
  const picked = Object.fromEntries(Object.entries(values).filter(([id, v]) => keep.has(id) && v !== undefined));
  if (Object.keys(picked).length === 0) return {};
  const json = JSON.stringify(picked);
  if (json.length > 64_000) return {};
  await db
    .insert(playerWorldState)
    .values({ userId, worldId, values: picked })
    .onConflictDoUpdate({
      target: [playerWorldState.userId, playerWorldState.worldId],
      set: { values: sql`${playerWorldState.values} || ${json}::jsonb`, updatedAt: new Date() },
    });
  return picked;
}
