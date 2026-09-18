/**
 * Phase 2.5: simplified/traditional Chinese normalization for hub search.
 *
 * Postgres sees 壺 (U+58FA traditional) and 壶 (U+58F6 simplified) as
 * distinct code points — no FTS config, no trigram threshold, no
 * collation tricks bridge them. The accepted fix is to normalize both
 * the stored text and the user's query to a single canonical form
 * before the database sees them.
 *
 * We use OpenCC via opencc-js (pure JS, no native deps — works in
 * serverless, Railway, Bun). The converter is stateless aside from its
 * compiled dictionary, so we instantiate once at module load.
 *
 * Canonical form: simplified Chinese. This is an arbitrary choice; the
 * only hard requirement is that writes and queries agree. Simplified is
 * more common in the Yumina catalog (per the Phase 2 audit, zh worlds
 * outnumber zh-TW/zh-HK by a wide margin), so fewer characters need to
 * move through the converter on hot paths.
 *
 * Callers:
 *   - `packages/server/src/routes/worlds.ts` publish/update handlers
 *     normalize the searchable text columns and write the result into
 *     `worlds.search_doc_normalized` (a tsvector maintained app-side,
 *     since OpenCC can't run inside Postgres).
 *   - `packages/server/src/lib/recommendations.ts` normalizes the
 *     user's query before OR-ing against both tsvectors.
 *   - `scripts/backfill-search-normalized.ts` does a one-time pass to
 *     populate the column for rows that existed before this phase.
 */

import { Converter } from "opencc-js";

/** Traditional → simplified (Taiwan/HK variants → PRC simplified). */
const toSimplified = Converter({ from: "tw", to: "cn" });

/**
 * Convert any CJK content in `text` to its simplified form. Latin,
 * numeric, and already-simplified content passes through unchanged.
 *
 * Safe to call on null/undefined/empty — returns empty string so callers
 * can concatenate without branching.
 */
export function normalizeForSearch(text: string | null | undefined): string {
  if (!text) return "";
  return toSimplified(text);
}

/**
 * Convenience: assemble the same concatenation used by the tsvector
 * trigger (name + description + extendedDescription), all normalized.
 *
 * Kept here so the write path and backfill script can't drift — both
 * call this one function.
 */
export function buildNormalizedSearchText(fields: {
  name: string | null | undefined;
  description: string | null | undefined;
  extendedDescription: string | null | undefined;
}): string {
  return [
    normalizeForSearch(fields.name),
    normalizeForSearch(fields.description),
    normalizeForSearch(fields.extendedDescription),
  ]
    .filter(Boolean)
    .join(" ");
}

import type { DrizzleDB } from "../db/index.js";
import { sql, eq } from "drizzle-orm";
import { worlds } from "../db/schema.js";

/**
 * Post-write hook: recompute `search_doc_normalized` for one world by
 * id. Call this after any INSERT/UPDATE on worlds that might have
 * touched name, description, or extendedDescription. Cheap (single
 * SELECT + single UPDATE), synchronous, fire-and-forget-safe.
 *
 * Intentionally tolerant of missing ids (returns silently) so callers
 * can wrap it in `.catch(() => {})` without cluttering the write path.
 *
 * Stores a plain text concatenation (not a tsvector) because the
 * `simple` FTS config tokenizes CJK content by whitespace, which turns
 * `壺中の毒` into one atomic token — unsearchable by a one-character
 * query. ILIKE substring match against the raw normalized text handles
 * this correctly, and pg_trgm indexes keep lookups fast.
 */
export async function syncSearchDocNormalized(
  db: DrizzleDB,
  worldId: string,
): Promise<void> {
  const rows = await db
    .select({
      name: worlds.name,
      description: worlds.description,
      extendedDescription: worlds.extendedDescription,
    })
    .from(worlds)
    .where(eq(worlds.id, worldId))
    .limit(1);

  const row = rows[0];
  if (!row) return;

  const normalized = buildNormalizedSearchText(row);

  await db.execute(sql`
    UPDATE worlds
    SET search_doc_normalized = ${normalized}
    WHERE id = ${worldId}
  `);
}
