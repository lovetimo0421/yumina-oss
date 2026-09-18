import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { resolveImageCdn } from "./cdn-url.js";

/**
 * Friendship on yumina is DERIVED, never requested: two users are friends when
 * each follows the other (the TikTok model, chosen over Steam-style explicit
 * requests in the 2026-09 friends design). This file is the single source of
 * that definition — invites, DM affordances and any future presence checks all
 * ask here, so "what counts as a friend" can never drift between features.
 *
 * Blocks are checked separately by callers (lib/blocks.ts): a block severs the
 * follow edges on creation, but legacy pairs may predate that rule, so
 * interaction gates pair areFriends() with getBlockStatus() rather than
 * trusting severance alone.
 */
export async function areFriends(userA: string, userB: string): Promise<boolean> {
  if (userA === userB) return false;
  const result = await db.execute(sql`
    SELECT count(*)::int AS edges FROM follows
    WHERE (follower_id = ${userA} AND following_id = ${userB})
       OR (follower_id = ${userB} AND following_id = ${userA})
  `);
  const edges = (result.rows[0] as { edges?: number } | undefined)?.edges ?? 0;
  return edges === 2;
}

export type FriendSummary = {
  id: string;
  name: string;
  image: string | null;
  alias: string | null;
};

/** Mutual follows with display info, for the friends list and the invite picker. */
export async function listFriends(userId: string, limit = 500): Promise<FriendSummary[]> {
  const result = await db.execute(sql`
    SELECT u.id, u.name, u.image, f1.alias
    FROM follows f1
    JOIN follows f2
      ON f2.follower_id = f1.following_id AND f2.following_id = f1.follower_id
    JOIN "user" u ON u.id = f1.following_id
    WHERE f1.follower_id = ${userId}
    ORDER BY lower(u.name) ASC
    LIMIT ${limit}
  `);
  return (result.rows as Array<{ id: string; name: string; image: string | null; alias: string | null }>).map(
    (row) => ({
      id: row.id,
      name: row.name,
      image: row.image ? resolveImageCdn(row.image) : null,
      alias: row.alias ?? null,
    }),
  );
}
