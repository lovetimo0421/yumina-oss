import { and, eq, isNull, lte, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { storyRoomMembers, storyRooms } from "../db/schema.js";
import { slidingWindowCheck } from "../middleware/rate-limit.js";
import { publishRoomEvent } from "./room-manager.js";
import { findOpenRoomForSession, overSpendCap, roomSpend, storyRoomChannel } from "./story-rooms.js";

/** A member's presses on the card's screen, per minute. */
const MEMBER_WRITES_PER_MINUTE = 60;

export type StateWriter =
  | { kind: "owner" }
  /** A member of the session's open room; `overCap` = the host's spend limit is used up. */
  | { kind: "member"; overCap: boolean }
  | { kind: "rate-limited"; retryAfter: number };

/**
 * A card's own screen changing the shared game in a story room: the host
 * owns the session, and the members of its open room (not muted) may move
 * its variables too, a button or a choice on the card's UI, never anything
 * else. Background work a member's press would start is billed to the host,
 * so it stops at the host's spend limit like the rounds do.
 */
export async function sessionStateWriter(
  session: { userId: string },
  sessionId: string,
  userId: string,
): Promise<StateWriter | null> {
  if (session.userId === userId) return { kind: "owner" };
  const [row] = await db
    .select({ id: storyRooms.id, sessionId: storyRooms.sessionId, createdAt: storyRooms.createdAt, spendCap: storyRooms.spendCap })
    .from(storyRooms)
    .innerJoin(storyRoomMembers, eq(storyRoomMembers.roomId, storyRooms.id))
    .where(and(
      eq(storyRooms.sessionId, sessionId),
      eq(storyRooms.status, "open"),
      eq(storyRoomMembers.userId, userId),
      isNull(storyRoomMembers.leftAt),
      isNull(storyRoomMembers.kickedAt),
      // A muted player cannot move the game either.
      or(isNull(storyRoomMembers.mutedUntil), lte(storyRoomMembers.mutedUntil, new Date())),
    ))
    .limit(1)
    .catch(() => []);
  if (!row) return null;
  const limited = await slidingWindowCheck(`rl:story-room-state:${userId}`, MEMBER_WRITES_PER_MINUTE, 60_000);
  if (limited) return { kind: "rate-limited", retryAfter: limited.retryAfter };
  // Fails closed: a spend that cannot be read counts as over the limit.
  const overCap = row.spendCap != null && overSpendCap(await roomSpend(row).catch(() => Number.POSITIVE_INFINITY), row.spendCap);
  return { kind: "member", overCap };
}

/** Tells the session's open room (if any) the variables as they now stand. Never throws. */
export async function publishRoomState(sessionId: string, variables: unknown, byUserId: string): Promise<void> {
  if (!variables || typeof variables !== "object") return;
  try {
    const room = await findOpenRoomForSession(sessionId);
    if (room) await publishRoomEvent(storyRoomChannel(room.id), "state", { variables, by: byUserId });
  } catch {
    /* the room learns it with the next reply */
  }
}
