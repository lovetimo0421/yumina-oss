import { eq, sql } from "drizzle-orm";
import { readOwn } from "../db/index.js";
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
        hideBlockedWorlds: userBlocks.hideBlockedWorlds,
        hideBlockedActivity: userBlocks.hideBlockedActivity,
      })
      .from(userBlocks)
      .where(eq(userBlocks.blockerId, viewerId)),
    rd
      .select({
        blockerId: userBlocks.blockerId,
        hideOwnWorlds: userBlocks.hideOwnWorlds,
      })
      .from(userBlocks)
      .where(eq(userBlocks.blockedId, viewerId)),
  ]);

  return {
    hideWorldCreatorIds: outgoing.filter((row) => row.hideBlockedWorlds).map((row) => row.blockedId),
    hiddenByCreatorIds: incoming.filter((row) => row.hideOwnWorlds).map((row) => row.blockerId),
    hideActivityUserIds: outgoing.filter((row) => row.hideBlockedActivity).map((row) => row.blockedId),
  };
}

export function blockedJson() {
  return { ...BLOCKED_ERROR };
}
