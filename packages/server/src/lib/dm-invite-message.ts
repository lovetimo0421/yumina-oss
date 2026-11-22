import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db, flagWrite } from "../db/index.js";
import {
  directConversationParticipants,
  directConversations,
  directMessageReadCursors,
  directMessages,
} from "../db/schema.js";
import { getBlockStatus } from "./blocks.js";
import { resolveImageCdn } from "./cdn-url.js";
import { publishRoomEvent } from "./room-manager.js";
import { sanitizeContent } from "./sanitize.js";

/**
 * An invite is delivered as a direct message from the friend who sent it: it
 * lands in the 1:1 conversation with them, moves that conversation to the top
 * and counts as unread, like anything else they say.
 *
 * It is a message the platform writes on the sender's behalf, so:
 *  - only the server may write this content type (the send route refuses it);
 *  - it is left out of the "3 messages before they reply" count in both
 *    directions, and is not stopped by that gate or by "Allow DMs" (invites
 *    go to friends only, who already agreed to hear from each other);
 *  - a block in either direction still stops it.
 */
export const DM_INVITE_CONTENT_TYPE = "invite";

export interface InviteMessageInput {
  from: { id: string; name: string | null; image?: string | null };
  toUserId: string;
  invite: {
    id: string;
    kind: "game" | "room";
    worldId: string | null;
    worldName: string | null;
    thumbnailUrl?: string | null;
    joinUrl: string;
    roomCode?: string | null;
    expiresAt: Date;
  };
}

export interface InviteMessageResult {
  conversationId: string;
  messageId: string;
}

/** The two-person conversation between these users, if they have one. */
async function findDirectConversation(userAId: string, userBId: string): Promise<string | undefined> {
  const rows = await db.execute(sql`
    SELECT c.id
    FROM direct_conversations c
    JOIN direct_conversation_participants p1 ON p1.conversation_id = c.id
    JOIN direct_conversation_participants p2 ON p2.conversation_id = c.id
    WHERE p1.user_id = ${userAId}
      AND p2.user_id = ${userBId}
      AND (
        SELECT COUNT(DISTINCT p3.user_id)
        FROM direct_conversation_participants p3
        WHERE p3.conversation_id = c.id
      ) = 2
    LIMIT 1
  `);
  return (rows as unknown as { rows?: { id: string }[] }).rows?.[0]?.id;
}

/**
 * Writes the invite into the pair's conversation (opening one if they have
 * none) and pushes it to an open thread. Returns null when a block stands
 * between them. Reads and writes the primary: the row must be there for the
 * recipient's very next list or unread-count read.
 */
export async function postInviteMessage(input: InviteMessageInput): Promise<InviteMessageResult | null> {
  const { from, toUserId, invite } = input;
  if (from.id === toUserId) return null;
  if ((await getBlockStatus(from.id, toUserId)).blocked) return null;

  const metadata = {
    inviteId: invite.id,
    kind: invite.kind,
    worldId: invite.worldId,
    worldName: invite.worldName,
    thumbnailUrl: invite.thumbnailUrl ? resolveImageCdn(invite.thumbnailUrl) : null,
    joinUrl: invite.joinUrl,
    roomCode: invite.roomCode ?? null,
    expiresAt: invite.expiresAt.toISOString(),
  };
  // What a client that does not know the card yet (or a reply quote) falls back to.
  const content = sanitizeContent((invite.worldName ?? "").trim()) || "Invite";

  const existingId = await findDirectConversation(from.id, toUserId);
  const result = await db.transaction(async (tx) => {
    let conversationId = existingId;
    if (!conversationId) {
      conversationId = crypto.randomUUID();
      await tx.insert(directConversations).values({ id: conversationId, createdById: from.id });
      await tx.insert(directConversationParticipants).values([
        { conversationId, userId: from.id },
        { conversationId, userId: toUserId },
      ]);
      // The recipient's cursor starts in the past so this first message is unread.
      await tx.insert(directMessageReadCursors).values([
        { conversationId, userId: from.id },
        { conversationId, userId: toUserId, lastReadAt: new Date(0) },
      ]);
    } else {
      await tx.execute(sql`SELECT id FROM direct_conversations WHERE id = ${conversationId} FOR UPDATE`);
    }

    // From here on this is what POST /conversations/:id/messages does for any message.
    const [message] = await tx
      .insert(directMessages)
      .values({
        conversationId,
        senderId: from.id,
        content,
        contentType: DM_INVITE_CONTENT_TYPE,
        metadata,
        // One message per invite, even if the caller is retried.
        clientId: `invite:${invite.id}`,
      })
      .returning();

    await tx
      .update(directConversations)
      .set({ updatedAt: new Date() })
      .where(eq(directConversations.id, conversationId));

    // A new message brings the thread back for someone who removed it from their inbox.
    await tx
      .update(directConversationParticipants)
      .set({ leftAt: null })
      .where(and(
        eq(directConversationParticipants.conversationId, conversationId),
        isNotNull(directConversationParticipants.leftAt),
      ));

    await tx
      .update(directMessageReadCursors)
      .set({ lastReadAt: new Date() })
      .where(and(
        eq(directMessageReadCursors.conversationId, conversationId),
        eq(directMessageReadCursors.userId, from.id),
      ));

    return { conversationId, message: message! };
  });

  const { conversationId, message } = result;
  await publishRoomEvent(`dm:${conversationId}`, "new_message", {
    id: message.id,
    conversationId,
    senderId: from.id,
    senderName: from.name,
    senderImage: resolveImageCdn(from.image ?? null),
    content: message.content,
    contentType: message.contentType,
    metadata: message.metadata ?? null,
    clientId: message.clientId ?? null,
    replyToMessageId: null,
    replyTo: null,
    editedAt: null,
    createdAt: message.createdAt instanceof Date ? message.createdAt.toISOString() : message.createdAt,
    // To both sides: the sender's own open thread did not post this itself
    // (the invite route did), so nothing else would put the card there.
  }).catch(() => {});
  flagWrite(from.id);

  return { conversationId, messageId: message.id };
}
