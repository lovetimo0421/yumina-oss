import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { cardLeaderboardEntries, cardLeaderboards, worlds } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { slidingWindowCheck } from "../middleware/rate-limit.js";
import { listFriends } from "../lib/friends.js";
import { resolveImageCdn } from "../lib/cdn-url.js";

/**
 * A card's own high-score boards, the way Steam does leaderboards: the card
 * names a board and submits scores from its own interface; the platform keeps
 * each player's best, ranks them, and hands back slices (top, around me,
 * friends). How a board looks is the card's business.
 *
 *   POST /api/leaderboards/:worldId/:board   { score, details?, order? }
 *   GET  /api/leaderboards/:worldId/:board?range=top|around|friends&limit=10
 */
export const leaderboardRoutes = new Hono<{ Variables: { user: { id: string } } }>();
leaderboardRoutes.use("*", authMiddleware);

export const LEADERBOARD_MAX_BOARDS = 20;
const SCORE_LIMIT = 1e15;
const DETAILS_MAX_CHARS = 500;
const SUBMITS_PER_MINUTE = 30;
const LIST_MAX = 50;

/** A board's name: 1–40 characters, no control characters. */
export function cleanBoardName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return name && [...name].length <= 40 ? name : null;
}

/** The board's owner: the card's language group, so every language version shares one board. */
async function cardKeyFor(worldId: string, userId: string): Promise<string | null> {
  const [w] = await db
    .select({ id: worlds.id, group: worlds.languageGroupId, status: worlds.status, isPublished: worlds.isPublished, creatorId: worlds.creatorId })
    .from(worlds)
    .where(eq(worlds.id, worldId))
    .limit(1);
  if (!w) return null;
  const playable = w.status === "published" || w.isPublished === true || w.creatorId === userId;
  return playable ? w.group ?? w.id : null;
}

type Row = { userId: string; name: string | null; image: string | null; score: number; details: unknown; rank: number };

function present(rows: readonly Row[], meId: string) {
  return rows.map((r) => ({
    rank: Number(r.rank),
    name: r.name ?? "",
    image: r.image ? resolveImageCdn(r.image) : null,
    score: Number(r.score),
    details: r.details ?? null,
    me: r.userId === meId,
  }));
}

/** Every entry on the board with its rank (ties share one), best first. */
const ranked = (cardKey: string, board: string, ascending: boolean) => sql`
  SELECT e.user_id AS "userId", u.name AS "name", u.image AS "image", e.score AS "score", e.details AS "details",
         rank() OVER (ORDER BY ${ascending ? sql`e.score ASC` : sql`e.score DESC`}) AS "rank", e.updated_at
  FROM card_leaderboard_entries e
  JOIN "user" u ON u.id = e.user_id
  WHERE e.card_key = ${cardKey} AND e.board = ${board}`;

leaderboardRoutes.post("/:worldId/:board", async (c) => {
  const me = c.get("user").id;
  const board = cleanBoardName(decodeURIComponent(c.req.param("board")));
  if (!board) return c.json({ error: "Board names are 1 to 40 characters", code: "bad-board" }, 400);
  const body = (await c.req.json().catch(() => null)) as { score?: unknown; details?: unknown; order?: unknown } | null;
  const score = typeof body?.score === "number" ? body.score : Number.NaN;
  if (!Number.isFinite(score) || Math.abs(score) > SCORE_LIMIT) return c.json({ error: "The score must be a number", code: "bad-score" }, 400);
  let details: unknown = null;
  if (body?.details !== undefined && body.details !== null) {
    const text = JSON.stringify(body.details);
    if (!text || text.length > DETAILS_MAX_CHARS) return c.json({ error: `Details must be JSON under ${DETAILS_MAX_CHARS} characters`, code: "bad-details" }, 400);
    details = JSON.parse(text);
  }
  const cardKey = await cardKeyFor(c.req.param("worldId"), me);
  if (!cardKey) return c.json({ error: "Card not found", code: "not-found" }, 404);
  const limited = await slidingWindowCheck(`leaderboard:${me}`, SUBMITS_PER_MINUTE, 60_000);
  if (limited) return c.json({ error: "Too many scores at once", code: "rate-limited" }, 429);

  // The board's order is set by its first score and never changes.
  let [meta] = await db.select().from(cardLeaderboards).where(and(eq(cardLeaderboards.cardKey, cardKey), eq(cardLeaderboards.board, board))).limit(1);
  if (!meta) {
    const boards = Number(((await db.execute(sql`SELECT count(*)::int AS boards FROM card_leaderboards WHERE card_key = ${cardKey}`)).rows[0] as { boards?: number } | undefined)?.boards ?? 0);
    if (boards >= LEADERBOARD_MAX_BOARDS) return c.json({ error: `A card has at most ${LEADERBOARD_MAX_BOARDS} boards`, code: "too-many-boards" }, 409);
    await db.insert(cardLeaderboards).values({ cardKey, board, ascending: body?.order === "asc" }).onConflictDoNothing();
    [meta] = await db.select().from(cardLeaderboards).where(and(eq(cardLeaderboards.cardKey, cardKey), eq(cardLeaderboards.board, board))).limit(1);
  }
  const ascending = meta!.ascending;

  const [prev] = await db
    .select({ score: cardLeaderboardEntries.score })
    .from(cardLeaderboardEntries)
    .where(and(eq(cardLeaderboardEntries.cardKey, cardKey), eq(cardLeaderboardEntries.board, board), eq(cardLeaderboardEntries.userId, me)))
    .limit(1);
  const better = !prev || (ascending ? score < prev.score : score > prev.score);
  if (better) {
    await db
      .insert(cardLeaderboardEntries)
      .values({ cardKey, board, userId: me, score, details, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [cardLeaderboardEntries.cardKey, cardLeaderboardEntries.board, cardLeaderboardEntries.userId],
        set: { score, details, updatedAt: new Date() },
        where: ascending ? sql`${cardLeaderboardEntries.score} > ${score}` : sql`${cardLeaderboardEntries.score} < ${score}`,
      });
  }
  const best = better ? score : prev!.score;
  const result = await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM card_leaderboard_entries WHERE card_key = ${cardKey} AND board = ${board}
        AND ${ascending ? sql`score < ${best}` : sql`score > ${best}`}) + 1 AS rank,
      (SELECT count(*)::int FROM card_leaderboard_entries WHERE card_key = ${cardKey} AND board = ${board}) AS total`);
  const row = result.rows[0] as { rank: number; total: number };
  return c.json({ data: { best, improved: better, rank: Number(row.rank), total: Number(row.total), order: ascending ? "asc" : "desc" } });
});

leaderboardRoutes.get("/:worldId/:board", async (c) => {
  const me = c.get("user").id;
  const board = cleanBoardName(decodeURIComponent(c.req.param("board")));
  if (!board) return c.json({ error: "Board names are 1 to 40 characters", code: "bad-board" }, 400);
  const cardKey = await cardKeyFor(c.req.param("worldId"), me);
  if (!cardKey) return c.json({ error: "Card not found", code: "not-found" }, 404);
  const range = c.req.query("range") === "around" ? "around" : c.req.query("range") === "friends" ? "friends" : "top";
  const limit = Math.max(1, Math.min(LIST_MAX, Number(c.req.query("limit")) || 10));
  const [meta] = await db.select().from(cardLeaderboards).where(and(eq(cardLeaderboards.cardKey, cardKey), eq(cardLeaderboards.board, board))).limit(1);
  if (!meta) return c.json({ data: { order: "desc", total: 0, entries: [], me: null } });
  const base = ranked(cardKey, board, meta.ascending);

  const meRow = ((await db.execute(sql`SELECT "rank", "score" FROM (${base}) t WHERE "userId" = ${me}`)).rows[0] ?? null) as { rank: number; score: number } | null;
  const total = Number(((await db.execute(sql`SELECT count(*)::int AS n FROM card_leaderboard_entries WHERE card_key = ${cardKey} AND board = ${board}`)).rows[0] as { n: number }).n);

  let rows: Row[];
  if (range === "friends") {
    const ids = [me, ...(await listFriends(me)).map((f) => f.id)];
    rows = (await db.execute(sql`SELECT * FROM (${base}) t WHERE "userId" IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) ORDER BY "rank", updated_at LIMIT ${limit}`)).rows as Row[];
  } else if (range === "around" && meRow) {
    const offset = Math.max(0, Number(meRow.rank) - 1 - Math.floor(limit / 2));
    rows = (await db.execute(sql`SELECT * FROM (${base}) t ORDER BY "rank", updated_at OFFSET ${offset} LIMIT ${limit}`)).rows as Row[];
  } else {
    rows = (await db.execute(sql`SELECT * FROM (${base}) t ORDER BY "rank", updated_at LIMIT ${limit}`)).rows as Row[];
  }
  return c.json({
    data: {
      order: meta.ascending ? "asc" : "desc",
      total,
      entries: present(rows, me),
      me: meRow ? { rank: Number(meRow.rank), score: Number(meRow.score) } : null,
    },
  });
});
