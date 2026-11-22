// The save picker (app: components/session-picker-modal.tsx) — the player's
// saves of one card, or of every language version of it. Two reads beyond the
// plain list: a subtitle that tells unnamed saves apart, and a keyword search
// over the text of every message in those saves.

import { sql, type SQL } from "drizzle-orm";
import type { DrizzleDB } from "../db/index.js";
import {
  escapeLikePattern,
  excerptWindow,
  hitFromExcerptRow,
  normalizeSearchQuery,
  type MessageSearchHit,
} from "./message-search.js";

/** Hits shown per save before "more" (which pages the per-save search). */
export const SAVE_SEARCH_SNIPPETS = 3;
/** Saves that come back with snippets; the rest carry only their hit count and
 *  load snippets when opened. Bounds the second query to 150 rows. */
export const SAVE_SEARCH_SNIPPET_SESSIONS = 50;
const SUBTITLE_MAX = 90;

export interface SavePickerScope {
  userId: string;
  worldId?: string;
  languageGroupId?: string;
  /** The account only sees all-ages cards; the list hides the others' saves. */
  limitedContentOnly?: boolean;
}

export interface SaveSearchMatch {
  sessionId: string;
  hitCount: number;
  /** Newest first; empty for saves past SAVE_SEARCH_SNIPPET_SESSIONS. */
  hits: MessageSearchHit[];
}

/** The same saves GET /api/sessions lists for this scope: the player's own,
 *  no Studio playtests, one card or one language group. Null when the scope
 *  names no card — a search never runs over every save the player has. */
function scopeCondition(scope: SavePickerScope): SQL | null {
  if (!scope.worldId && !scope.languageGroupId) return null;
  return sql`ps.user_id = ${scope.userId} AND ps.ephemeral = false
    ${scope.worldId ? sql`AND ps.world_id = ${scope.worldId}` : sql``}
    ${scope.languageGroupId ? sql`AND w.language_group_id = ${scope.languageGroupId}` : sql``}
    ${scope.limitedContentOnly ? sql`AND w.age_rating = 'all' AND w.is_nsfw = false` : sql``}`;
}

/**
 * Keyword search over every message of the player's saves in `scope`. Every
 * matching save comes back with its hit count (so "select all matching" sees
 * them all), ordered like the list's default (most recently played first); the
 * first SAVE_SEARCH_SNIPPET_SESSIONS also carry their newest hits with a
 * snippet and the message's place in the save (the #N the chat shows).
 */
export async function searchSaves(
  reader: Pick<DrizzleDB, "execute">,
  scope: SavePickerScope,
  rawQuery: unknown,
): Promise<SaveSearchMatch[]> {
  const where = scopeCondition(scope);
  const query = normalizeSearchQuery(rawQuery);
  if (!where || !query) return [];
  const pattern = `%${escapeLikePattern(query)}%`;

  // Pass 1: which saves match and how often, plus the ids of each save's newest
  // hits. Reads message text once; returns at most 3 rows per matching save.
  const matched = await reader.execute<{ session_id: string; hit_count: number | string; id: string }>(sql`
    WITH owned AS MATERIALIZED (
      SELECT ps.id, ps.updated_at
      FROM play_sessions ps JOIN worlds w ON w.id = ps.world_id
      WHERE ${where}
    ), hits AS (
      SELECT m.session_id, m.id,
        row_number() OVER (PARTITION BY m.session_id ORDER BY m.created_at DESC, m.id DESC) AS rn,
        count(*) OVER (PARTITION BY m.session_id) AS hit_count
      FROM messages m
      WHERE m.session_id IN (SELECT id FROM owned)
        AND m.content ILIKE ${pattern} ESCAPE '\\'
    )
    SELECT h.session_id, h.hit_count, h.id
    FROM hits h JOIN owned o ON o.id = h.session_id
    WHERE h.rn <= ${SAVE_SEARCH_SNIPPETS}
    ORDER BY o.updated_at DESC NULLS LAST, h.session_id, h.rn
  `);

  const order: SaveSearchMatch[] = [];
  const bySession = new Map<string, SaveSearchMatch>();
  const hitIds: string[] = [];
  for (const row of matched.rows) {
    let match = bySession.get(row.session_id);
    if (!match) {
      match = { sessionId: row.session_id, hitCount: Number(row.hit_count), hits: [] };
      bySession.set(row.session_id, match);
      order.push(match);
    }
    if (order.length <= SAVE_SEARCH_SNIPPET_SESSIONS) hitIds.push(row.id);
  }
  if (hitIds.length === 0) return order;

  // Pass 2: snippets and positions for at most 150 messages, by primary key.
  // Position = 1 + rows before it in (created_at, id) order — the numbering of
  // the chat and of the in-story search (message-page.ts, message-search.ts).
  const sessionIds = order.slice(0, SAVE_SEARCH_SNIPPET_SESSIONS).map((match) => match.sessionId);
  const { lead, span } = excerptWindow(query);
  const detail = await reader.execute<{
    id: string; session_id: string; role: MessageSearchHit["role"]; created_iso: string;
    position: number | string; excerpt: string; excerpt_start: number | string; content_length: number | string;
  }>(sql`
    SELECT x.id, x.session_id, x.role, x.created_iso, x.position, x.excerpt_start,
      substr(x.content, x.excerpt_start::int, ${span}) AS excerpt,
      char_length(x.content) AS content_length
    FROM (
      SELECT m.id, m.session_id, m.role, m.content,
        to_char(m.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_iso,
        GREATEST(1, strpos(lower(m.content), lower(${query})) - ${lead}) AS excerpt_start,
        1 + (SELECT count(*) FROM messages p
          WHERE p.session_id = m.session_id AND p.created_at <= m.created_at
            AND (p.created_at < m.created_at OR p.id < m.id)) AS position
      FROM messages m
      WHERE m.id IN (${sql.join(hitIds.map((id) => sql`${id}`), sql`, `)})
        AND m.session_id IN (${sql.join(sessionIds.map((id) => sql`${id}`), sql`, `)})
    ) x
  `);
  const hitsById = new Map(detail.rows.map((row) => [row.id, { sessionId: row.session_id, hit: hitFromExcerptRow(row, query) }]));
  for (const id of hitIds) {
    const found = hitsById.get(id);
    if (found) bySession.get(found.sessionId)?.hits.push(found.hit);
  }
  return order;
}

/** The first line of a recap that says something: the story summary opens
 *  with fixed "## Story So Far" style headings (session-compaction.ts). */
export function firstRecapLine(summary: string | null | undefined): string | null {
  if (!summary) return null;
  for (const raw of summary.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^#{1,6}\s/.test(line) || /^[-*_]{3,}$/.test(line)) continue;
    const text = line.replace(/^(?:[-*+>]\s+|\d+[.)]\s+)/, "").replace(/\*\*|__/g, "").replace(/\s+/g, " ").trim();
    if (text) return clip(text);
  }
  return null;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SUBTITLE_MAX ? `${flat.slice(0, SUBTITLE_MAX).trimEnd()}…` : flat;
}

/**
 * A line that tells an unnamed save apart: the first line of its recap, else
 * the opening of the player's first message. One query for the whole list —
 * a LATERAL probe per save on messages(session_id, created_at) that stops at
 * the first player message, and only for saves with no recap.
 */
export async function loadSaveSubtitles(
  reader: Pick<DrizzleDB, "execute">,
  userId: string,
  sessionIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (sessionIds.length === 0) return out;
  const rows = await reader.execute<{ id: string; recap_head: string | null; opening: string | null }>(sql`
    SELECT s.id, left(s.summary, 600) AS recap_head, f.opening
    FROM play_sessions s
    LEFT JOIN LATERAL (
      SELECT left(m.content, 240) AS opening
      FROM messages m
      WHERE m.session_id = s.id AND m.role = 'user'
        AND (s.summary IS NULL OR btrim(s.summary) = '')
      ORDER BY m.created_at, m.id
      LIMIT 1
    ) f ON true
    WHERE s.user_id = ${userId}
      AND s.id IN (${sql.join(sessionIds.map((id) => sql`${id}`), sql`, `)})
  `);
  for (const row of rows.rows) {
    const line = firstRecapLine(row.recap_head) ?? (row.opening?.trim() ? clip(row.opening) : null);
    if (line) out.set(row.id, line);
  }
  return out;
}
