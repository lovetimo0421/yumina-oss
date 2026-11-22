import { and, eq, sql } from "drizzle-orm";
import type { DrizzleDB } from "../db/index.js";
import { messages, playSessions } from "../db/schema.js";

/** Longest query a player can search for; longer input is cut, not refused. */
export const MESSAGE_SEARCH_QUERY_MAX = 200;
export const MESSAGE_SEARCH_LIMIT_DEFAULT = 50;
export const MESSAGE_SEARCH_LIMIT_MAX = 100;
/** Characters of context kept on each side of the hit. */
const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 120;
/** The slice of a message the database hands back around a hit: wider than
 *  the snippet, so whitespace folding in JS still leaves enough context on
 *  both sides. `lead` characters before the hit, `span` in all. */
export function excerptWindow(query: string) {
  return { lead: SNIPPET_BEFORE * 3, span: SNIPPET_BEFORE * 3 + query.length + SNIPPET_AFTER * 2 };
}

/** One row of an excerpt query (see searchSessionMessages) as a hit. */
export function hitFromExcerptRow(row: {
  id: string; role: MessageSearchHit["role"]; created_iso: string; position: number | string;
  excerpt: string; excerpt_start: number | string; content_length: number | string;
}, query: string): MessageSearchHit {
  const excerptStart = Number(row.excerpt_start);
  const clippedBefore = excerptStart > 1;
  const clippedAfter = excerptStart - 1 + row.excerpt.length < Number(row.content_length);
  return {
    id: row.id,
    role: row.role,
    createdAt: row.created_iso,
    position: Number(row.position),
    ...snippetAround(row.excerpt, query, clippedBefore, clippedAfter),
  };
}

export interface MessageSearchHit {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  /** 1-based position in the whole session, oldest first: the number the chat shows. */
  position: number;
  snippet: string;
  /** The snippet starts / ends inside the message. */
  clippedStart: boolean;
  clippedEnd: boolean;
}

export interface MessageSearchResult {
  hits: MessageSearchHit[];
  /** More messages match than `limit`; the newest `limit` are returned. */
  hasMore: boolean;
}

/** `%`, `_` and the escape character itself match literally (ILIKE … ESCAPE '\'). */
export function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function normalizeSearchQuery(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, MESSAGE_SEARCH_QUERY_MAX);
}

/** Cut a readable snippet around the first case-insensitive hit. `window` is a
 *  slice of the message already centred on the hit by the database. */
export function snippetAround(window: string, query: string, clippedBefore: boolean, clippedAfter: boolean) {
  const flat = window.replace(/\s+/g, " ");
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) {
    const snippet = flat.slice(0, SNIPPET_BEFORE + SNIPPET_AFTER).trim();
    return { snippet, clippedStart: clippedBefore, clippedEnd: clippedAfter || flat.length > snippet.length };
  }
  let start = Math.max(0, at - SNIPPET_BEFORE);
  // Start on a word, not halfway through one, where the text has spaces.
  if (start > 0 && flat[start - 1] !== " ") {
    const space = flat.indexOf(" ", start);
    if (space >= 0 && space < at) start = space + 1;
  }
  const end = Math.min(flat.length, at + query.length + SNIPPET_AFTER);
  return {
    snippet: flat.slice(start, end).trim(),
    clippedStart: clippedBefore || start > 0,
    clippedEnd: clippedAfter || end < flat.length,
  };
}

/**
 * Keyword search over one play session's messages, newest first; page older
 * hits with `beforePosition` = the last hit's position. Returns null
 * when the session does not exist or is not `userId`'s — the caller answers 404
 * either way so a probe cannot tell the two apart.
 */
export async function searchSessionMessages(
  reader: Pick<DrizzleDB, "execute" | "select">,
  options: {
    sessionId: string; userId: string; query: string; limit?: number;
    /** Only messages older than this session position: the next page of hits. */
    beforePosition?: number;
  },
): Promise<MessageSearchResult | null> {
  const { sessionId, userId } = options;
  const owned = await reader
    .select({ id: playSessions.id })
    .from(playSessions)
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, userId)))
    .limit(1);
  if (owned.length === 0) return null;

  const query = normalizeSearchQuery(options.query);
  if (!query) return { hits: [], hasMore: false };
  const limit = Math.max(1, Math.min(MESSAGE_SEARCH_LIMIT_MAX, Math.floor(options.limit ?? MESSAGE_SEARCH_LIMIT_DEFAULT)));
  const pattern = `%${escapeLikePattern(query)}%`;
  const before = options.beforePosition !== undefined && Number.isFinite(options.beforePosition) && options.beforePosition > 0
    ? Math.floor(options.beforePosition) : null;
  const { lead, span } = excerptWindow(query);

  const rows = await reader.execute<{
    id: string; role: MessageSearchHit["role"]; created_iso: string; position: number | string;
    excerpt: string; excerpt_start: number | string; content_length: number | string;
  }>(sql`
    WITH ranked AS (
      SELECT ${messages.id} AS id, ${messages.role} AS role, ${messages.createdAt} AS created_at,
        ${messages.content} AS content,
        row_number() OVER (ORDER BY ${messages.createdAt}, ${messages.id}) AS position
      FROM ${messages}
      WHERE ${messages.sessionId} = ${sessionId}
    ), hits AS (
      SELECT id, role, created_at, content, position,
        GREATEST(1, strpos(lower(content), lower(${query})) - ${lead}) AS excerpt_start
      FROM ranked
      WHERE content ILIKE ${pattern} ESCAPE '\\'
        ${before !== null ? sql`AND position < ${before}` : sql``}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit + 1}
    )
    SELECT id, role,
      to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_iso,
      position, excerpt_start,
      substr(content, excerpt_start::int, ${span}) AS excerpt,
      char_length(content) AS content_length
    FROM hits
    ORDER BY hits.created_at DESC, hits.id DESC
  `);

  const all = rows.rows;
  const hits = all.slice(0, limit).map((row) => hitFromExcerptRow(row, query));
  return { hits, hasMore: all.length > limit };
}
