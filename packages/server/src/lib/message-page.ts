import { and, desc, eq, getTableColumns, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import type { DrizzleDB } from "../db/index.js";
import { messages } from "../db/schema.js";

export const MESSAGE_PAGE_BYTES = 8 * 1024 * 1024;

// Rewind and regeneration read these from storage. Bulk chat transport only
// needs swipe text/metadata; the message snapshot still renders historical UI.
export const displaySwipes = sql<typeof messages.$inferSelect.swipes>`CASE
  WHEN jsonb_typeof(${messages.swipes}) = 'array' THEN COALESCE((
    SELECT jsonb_agg(s.value - 'stateSnapshot' - 'generationState' ORDER BY s.ordinality)
    FROM jsonb_array_elements(${messages.swipes}) WITH ORDINALITY AS s(value, ordinality)
  ), '[]'::jsonb)
  ELSE '[]'::jsonb END`;

const displayColumns = {
  ...getTableColumns(messages), swipes: displaySwipes,
  createdAt: sql<string | null>`to_char(${messages.createdAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
};
const displayJson = sql`jsonb_build_object(${sql.join(
  Object.entries(displayColumns).flatMap(([name, column]) => [sql`${name}::text`, sql`${column}`]),
  sql`, `,
)})`;

export function messagePageCursor(sessionId: string, before: Date | string, beforeId?: string): SQL {
  const iso = typeof before === "string" ? before : before.toISOString();
  const fallback = sql`(${iso}::timestamptz AT TIME ZONE 'UTC')`;
  if (!beforeId) return lt(messages.createdAt, fallback);
  // PostgreSQL timestamps have microseconds; JS Dates lose that precision.
  // Resolve a real cursor row's exact time to avoid skipping same-ms turns.
  const timestamp = sql`COALESCE((SELECT created_at FROM messages
    WHERE session_id = ${sessionId} AND id = ${beforeId}), ${fallback})`;
  return or(lt(messages.createdAt, timestamp), and(eq(messages.createdAt, timestamp), lt(messages.id, beforeId)))!;
}

export async function loadMessagePage(
  reader: Pick<DrizzleDB, "execute" | "select">,
  sessionId: string,
  limit: number,
  cursor?: SQL,
  byteBudget = MESSAGE_PAGE_BYTES,
) {
  const condition = and(eq(messages.sessionId, sessionId), cursor)!;
  // Size and choose IDs in PostgreSQL before transferring JSON to Node. A row
  // cap alone cannot bound a page containing multi-megabyte state snapshots.
  // Always include one row so even an oversized individual turn is pageable.
  const selection = await reader.execute<{ id: string; candidate_count: number }>(sql`
    WITH candidates AS MATERIALIZED (
      SELECT ${messages.id} AS id, ${messages.createdAt} AS created_at,
        octet_length((${displayJson})::text) + 256 AS bytes
      FROM ${messages}
      WHERE ${condition}
      ORDER BY ${messages.createdAt} DESC, ${messages.id} DESC
      LIMIT ${limit + 1}
    ), ranked AS (
      SELECT id, created_at,
        row_number() OVER (ORDER BY created_at DESC, id DESC) AS position,
        sum(bytes) OVER (ORDER BY created_at DESC, id DESC) AS page_bytes
      FROM candidates
    )
    SELECT id, (SELECT count(*)::int FROM candidates) AS candidate_count
    FROM ranked
    WHERE position <= ${limit} AND (page_bytes <= ${byteBudget} OR position = 1)
    ORDER BY created_at DESC, id DESC
  `);
  const ids = selection.rows.map((row) => row.id);
  if (!ids.length) return { messages: [], hasMore: false };
  const rows = await reader.select(displayColumns)
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), inArray(messages.id, ids)))
    .orderBy(desc(messages.createdAt), desc(messages.id));
  return {
    messages: rows.reverse(),
    hasMore: selection.rows[0]!.candidate_count > rows.length,
  };
}
