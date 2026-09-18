import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { directMessages, directConversationParticipants } from "../db/schema.js";

/**
 * Does `viewerId` hold a DM share grant on `worldId`?
 *
 * True iff the world's own creator sent a `world-share` message naming that
 * world into a conversation the viewer participates in. This is how a creator
 * hands an UNPUBLISHED card to a friend: the grant is *derived* from the message
 * rather than stored, so there is no grant table to keep in sync — recalling the
 * message flips its content_type to 'recall' and the grant evaporates.
 *
 * Two properties this shape buys us, both load-bearing:
 *  - `senderId = creatorId` closes the self-grant hole. A user who learns a
 *    stranger's draft id cannot DM it to themselves to unlock it; only the
 *    creator's own send counts.
 *  - The grant is preview-scope only by convention of its callers — the read
 *    path admits it for `?preview=true` (cover/name/description) and for
 *    forking, never for the full multi-MB `schema` payload.
 *
 * Reads the primary: this is a read-before-write authorization guard, so it must
 * not race replica lag (a just-sent share has to unlock immediately).
 */
export async function hasWorldDmShareGrant(
  viewerId: string | null | undefined,
  worldId: string,
  creatorId: string | null | undefined,
): Promise<boolean> {
  if (!viewerId || !creatorId) return false;

  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(directMessages)
    .innerJoin(
      directConversationParticipants,
      eq(directConversationParticipants.conversationId, directMessages.conversationId),
    )
    .where(
      and(
        eq(directMessages.contentType, "world-share"),
        sql`${directMessages.metadata}->>'worldId' = ${worldId}`,
        eq(directMessages.senderId, creatorId),
        eq(directConversationParticipants.userId, viewerId),
      ),
    )
    .limit(1);

  return !!row;
}
