import { eq, sql } from "drizzle-orm";
import { readOwn, type Database } from "../db/index.js";
import { userBlocks } from "../db/schema.js";

export const BLOCKED_ERROR = {
  code: "blocked_by_target",
  error: "你已被拉黑 :(",
} as const;

export type BlockStatus = {
  blocked: boolean;
  direction: "blocker" | "blocked" | null;
};

export async function getBlockStatus(userA: string, userB: string): Promise<BlockStatus> {
  const rd = await readOwn(userA);
  const rows = await rd
    .select({ blockerId: userBlocks.blockerId })
    .from(userBlocks)
    .where(
      sql`(${userBlocks.blockerId} = ${userA} AND ${userBlocks.blockedId} = ${userB})
       OR (${userBlocks.blockerId} = ${userB} AND ${userBlocks.blockedId} = ${userA})`
    );

  if (rows.length === 0) return { blocked: false, direction: null };
  return {
    blocked: true,
    direction: rows[0]!.blockerId === userA ? "blocker" : "blocked",
  };
}

/** Both directions of a block hide profiles and creator-owned content. */
export async function listMutuallyBlockedUserIds(viewerId: string, database?: Database): Promise<string[]> {
  const rd = database ?? await readOwn(viewerId);
  const rows = await rd.select({
    blockerId: userBlocks.blockerId,
    blockedId: userBlocks.blockedId,
  }).from(userBlocks).where(sql`
    ${userBlocks.blockerId} = ${viewerId} OR ${userBlocks.blockedId} = ${viewerId}
  `);
  return [...new Set(rows.map((row) => row.blockerId === viewerId ? row.blockedId : row.blockerId))];
}


export async function listBlockedUsersForHiding(viewerId: string): Promise<{
  hideWorldCreatorIds: string[];
  hiddenByCreatorIds: string[];
  hideActivityUserIds: string[];
}> {
  const rd = await readOwn(viewerId);
  const [outgoing, incoming] = await Promise.all([
    rd
      .select({
        blockedId: userBlocks.blockedId,
        hideBlockedActivity: userBlocks.hideBlockedActivity,
      })
      .from(userBlocks)
      .where(eq(userBlocks.blockerId, viewerId)),
    rd
      .select({
        blockerId: userBlocks.blockerId,
      })
      .from(userBlocks)
      .where(eq(userBlocks.blockedId, viewerId)),
  ]);

  return {
    hideWorldCreatorIds: outgoing.map((row) => row.blockedId),
    hiddenByCreatorIds: incoming.map((row) => row.blockerId),
    hideActivityUserIds: outgoing.filter((row) => row.hideBlockedActivity).map((row) => row.blockedId),
  };
}

export function blockedJson() {
  return { ...BLOCKED_ERROR };
}
