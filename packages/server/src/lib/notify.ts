import { and, eq, inArray, sql } from "drizzle-orm";
import { db, isNotificationActorSchemaReady } from "../db/index.js";
import { notifications, user } from "../db/schema.js";
import { publishRoomEvent } from "./room-manager.js";
import {
  isNotificationSubjectMuted,
  notificationSubjectFor,
} from "./notification-subject.js";
export {
  isNotificationSubjectMuted,
  MUTABLE_NOTIFICATION_TYPES,
  mutedNotificationSubjectKeys,
  notificationSubjectFor,
  notificationSubjectKey,
} from "./notification-subject.js";
export type {
  NotificationSubject,
  NotificationSubjectType,
} from "./notification-subject.js";

/**
 * All notification types the system emits.
 * User preferences use these keys to opt out.
 */
export type NotificationType =
  | "new_favorite"
  | "new_follower"
  | "new_friend"
  | "friend_invite"
  | "new_review"
  | "new_comment"
  | "new_review_reply"
  | "followed_user_published"
  | "world_update"
  | "world_unpublished"
  | "world_republished"
  | "world_moderation_action"
  | "room_invite"
  | "thread_reply"
  | "post_reply"
  | "thread_like"
  | "post_like"
  | "bundle_like"
  | "thread_deleted_by_admin"
  | "thread_deleted_by_cited_owner"
  | "post_deleted_by_mod"
  | "thread_moved_by_admin"
  | "thread_rewarded"
  | "wechat_renewal_reminder"
  | "event_submission_reviewed"
  | "event_submission_pending"
  | "social_event_initial_reviewed"
  | "social_event_announcement"
  | "social_event_final_data_reminder"
  | "social_event_settled"
  | "tip_received"
  | "mushie_gift_received"
  | "world_submitted_for_review"
  | "world_review_approved"
  | "world_review_rejected"
  | "new_review_pending"
  | "achievement_earned"
  | "referral_milestone"
  | "creator_community_post"
  | "generation_completed"
  | "generation_failed"
  | "platform_announcement";

const TYPE_TO_GROUP: Partial<Record<NotificationType, string>> = {
  new_favorite: "engagement",
  new_review: "engagement",
  new_review_reply: "engagement",
  bundle_like: "engagement",
  tip_received: "engagement",
  mushie_gift_received: "engagement",
  referral_milestone: "engagement",
  new_follower: "social",
  new_friend: "social",
  friend_invite: "social",
  followed_user_published: "social",
  creator_community_post: "social",
  world_update: "library",
  world_unpublished: "library",
  world_republished: "library",
  world_submitted_for_review: "library",
  world_review_approved: "library",
  thread_reply: "community",
  post_reply: "community",
  thread_like: "community",
  post_like: "community",
  thread_rewarded: "community",
  room_invite: "community",
};

/**
 * Insert a notification only if the recipient hasn't opted out.
 * Types not in any group (moderation, system) always go through.
 */
/** Fan-out cap for live pings: past this the recipients pick it up on the next poll. */
const LIVE_PING_MAX_RECIPIENTS = 500;

/**
 * Nudge the recipient's open tabs over their SSE room so the bell badge (and an
 * open panel) refresh now instead of on the next 60s poll. Fire-and-forget: the
 * notification row is already committed, so a failed ping costs nothing.
 */
function pingRecipients(userIds: string[], type: NotificationType): void {
  if (userIds.length === 0 || userIds.length > LIVE_PING_MAX_RECIPIENTS) return;
  for (const uid of userIds) {
    publishRoomEvent(`user:${uid}`, "notification", { type }).catch(() => {});
  }
}

export async function notify(
  userId: string,
  type: NotificationType,
  payload: Record<string, unknown>,
  options?: { actorUserId?: string | null; dedupeKey?: string | null },
): Promise<boolean> {
  if (!(await notificationAllowed(userId, type, payload))) return false;

  const actorUserId = options?.actorUserId ?? inferActorUserId(payload);
  const insert = db.insert(notifications).values({
    userId,
    type,
    payload,
    dedupeKey: options?.dedupeKey ?? null,
    ...(isNotificationActorSchemaReady() ? { actorUserId } : {}),
  });
  if (options?.dedupeKey) {
    const created = await insert
      .onConflictDoNothing()
      .returning();
    if (created.length > 0) pingRecipients([userId], type);
    return created.length > 0;
  } else {
    await insert;
    pingRecipients([userId], type);
    return true;
  }
}

async function notificationAllowed(
  userId: string,
  type: NotificationType,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const group = TYPE_TO_GROUP[type];
  const subject = notificationSubjectFor(type, payload);
  if (!group && !subject) return true;

  const [row] = await db
    .select({ preferences: user.preferences })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  const prefs = (row?.preferences ?? {}) as Record<string, unknown>;
  const notifPrefs = (prefs.notificationPreferences ?? {}) as Record<string, boolean>;
  if (group && notifPrefs[group] === false) return false;
  return !isNotificationSubjectMuted(prefs, subject);
}

export interface WorldReviewNotificationPayload extends Record<string, unknown> {
  worldId: string;
  worldGroupId: string;
  worldName: string;
  reviewerName: string;
  reviewerUserId: string;
  ratingEventId: string;
  rating: number;
  commentContent?: string;
  reviewId?: string;
}

export type WorldReviewNotificationResult =
  | "created"
  | "completed"
  | "already_complete"
  | "suppressed";

const WORLD_REVIEW_MERGE_WINDOW_MS = 30 * 60 * 1000;
const REVIEW_NOTIFICATION_EXCERPT_LENGTH = 500;

export function worldRatingNotificationEventId(id: string, updatedAt: Date): string {
  return `${id}:${updatedAt.toISOString()}`;
}

export function recentWorldRatingNotification(
  row: { id: string; rating: number; updatedAt: Date | null | undefined },
  now = Date.now(),
): { rating: number; ratingEventId: string } | null {
  if (!row.updatedAt) return null;
  const age = now - row.updatedAt.getTime();
  if (age < 0 || age > WORLD_REVIEW_MERGE_WINDOW_MS) return null;
  return {
    rating: row.rating,
    ratingEventId: worldRatingNotificationEventId(row.id, row.updatedAt),
  };
}

export function reviewNotificationExcerpt(content: string): string {
  const characters = [...content.trim()];
  if (characters.length <= REVIEW_NOTIFICATION_EXCERPT_LENGTH) return characters.join("");
  return `${characters.slice(0, REVIEW_NOTIFICATION_EXCERPT_LENGTH - 1).join("").trimEnd()}…`;
}

/**
 * Create or complete one review notification for a player's card evaluation.
 *
 * Rating and comment writes are separate API calls, but creators should see
 * one notification. The second write merges into a recent incomplete payload,
 * marks it unread again, and floats it to the top. Independent later comments
 * remain separate events while still using the same notification type.
 */
export async function notifyWorldReview(
  userId: string,
  payload: WorldReviewNotificationPayload,
): Promise<WorldReviewNotificationResult> {
  if (!(await notificationAllowed(userId, "new_review", payload))) return "suppressed";

  const actorUserId = payload.reviewerUserId;
  const actorColumnReady = isNotificationActorSchemaReady();
  const actorAssignment = actorColumnReady
    ? sql`actor_user_id = ${actorUserId},`
    : sql``;
  const actorPredicate = actorColumnReady
    ? sql`actor_user_id = ${actorUserId}`
    : sql`payload->>'reviewerUserId' = ${actorUserId}`;
  const encodedPayload = JSON.stringify(payload);
  const lockKey = `review-notification:${userId}:${actorUserId}:${payload.ratingEventId}`;
  const providesComment = Boolean(payload.commentContent?.trim());
  const incompleteRatingPredicate = providesComment
    ? sql`nullif(btrim(payload->>'commentContent'), '') IS NULL
          AND (
            payload->>'ratingEventId' = ${payload.ratingEventId}
            OR (
              payload->>'ratingEventId' IS NULL
              AND created_at >= now() - interval '30 minutes'
              AND (
                coalesce(payload->>'worldGroupId', payload->>'worldId') = ${payload.worldGroupId}
                OR payload->>'worldId' = ${payload.worldId}
                OR payload->>'worldId' IN (
                  SELECT w.id
                  FROM worlds w
                  WHERE w.language_group_id = ${payload.worldGroupId}
                )
              )
            )
          )`
    : sql`false`;

  return db.transaction(async (tx) => {
    // Rating and comment requests can overlap. Serialize this exact
    // recipient/player/card tuple so both requests cannot observe "no row"
    // and insert duplicates before either commit becomes visible.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

    const refreshed = await tx.execute(sql`
      UPDATE notifications
      SET ${actorAssignment}
          payload = payload || ${encodedPayload}::jsonb,
          read = false,
          created_at = now()
      WHERE id = (
        SELECT id
        FROM notifications
        WHERE user_id = ${userId}
          AND type = 'new_review'
          AND (${actorPredicate})
          AND (${incompleteRatingPredicate})
        ORDER BY created_at DESC
        LIMIT 1
      )
      RETURNING id
    `);

    if (refreshed.rows.length > 0) return "completed";

    const existing = await tx.execute(sql`
      SELECT id
      FROM notifications
      WHERE user_id = ${userId}
        AND type = 'new_review'
        AND (${actorPredicate})
        AND payload->>'ratingEventId' = ${payload.ratingEventId}
      LIMIT 1
    `);
    if (existing.rows.length > 0) return "already_complete";

    await tx.insert(notifications).values({
      userId,
      type: "new_review",
      payload,
      ...(actorColumnReady ? { actorUserId } : {}),
    });
    return "created";
  });
}

/** Remove deleted comment text while preserving any rating half of the event. */
export async function removeWorldReviewCommentNotification(reviewId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      DELETE FROM notifications
      WHERE type IN ('new_review', 'new_comment')
        AND payload->>'reviewId' = ${reviewId}
        AND payload->>'rating' IS NULL
    `);
    await tx.execute(sql`
      UPDATE notifications
      SET payload = payload - 'commentContent' - 'reviewId'
      WHERE type = 'new_review'
        AND payload->>'reviewId' = ${reviewId}
    `);
  });
}

const ACTOR_USER_ID_KEYS = [
  "followerUserId",
  "likerUserId",
  "fanUserId",
  "reviewerUserId",
  "replierUserId",
  "creatorUserId",
  "senderUserId",
  "creatorId",
  "ownerUserId",
  "authorUserId",
  "submitterId",
  "submitterUserId",
  "adminUserId",
  "moderatorUserId",
] as const;

function inferActorUserId(payload: Record<string, unknown>): string | null {
  for (const key of ACTOR_USER_ID_KEYS) {
    const value = payload[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

/**
 * Batch-insert notifications for many users, filtering out those who opted out.
 * Used for broadcast-style notifications (world updates, publishes, etc.).
 */
export async function notifyMany(
  userIds: string[],
  type: NotificationType,
  payload: Record<string, unknown>,
  options?: { actorUserId?: string | null; dedupeKey?: string | null },
): Promise<void> {
  if (userIds.length === 0) return;

  let allowedIds = userIds;

  const group = TYPE_TO_GROUP[type];
  const subject = notificationSubjectFor(type, payload);
  if (group || subject) {
    const rows = await db
      .select({ id: user.id, preferences: user.preferences })
      .from(user)
      .where(
        userIds.length === 1
          ? eq(user.id, userIds[0]!)
          : inArray(user.id, userIds),
      );

    allowedIds = rows.filter((row) => {
      const prefs = (row.preferences ?? {}) as Record<string, unknown>;
      const notifPrefs = (prefs.notificationPreferences ?? {}) as Record<string, boolean>;
      if (group && notifPrefs[group] === false) return false;
      return !isNotificationSubjectMuted(prefs, subject);
    }).map((row) => row.id);

    if (allowedIds.length === 0) return;
  }

  const actorUserId = options?.actorUserId ?? inferActorUserId(payload);
  const actorColumnReady = isNotificationActorSchemaReady();
  const insert = db.insert(notifications).values(
    allowedIds.map((uid) => ({
      userId: uid,
      type,
      payload,
      dedupeKey: options?.dedupeKey ?? null,
      ...(actorColumnReady ? { actorUserId } : {}),
    })),
  );
  // A dedupe key makes the fan-out idempotent per recipient (unique on user+type+key).
  if (options?.dedupeKey) await insert.onConflictDoNothing();
  else await insert;
  pingRecipients(allowedIds, type);
}

/**
 * Fan a notification out to EVERY user on the platform (minus banned/suspended
 * accounts and an optional excluded user, typically the author).
 *
 * Deliberately a single server-side INSERT … SELECT rather than notifyMany():
 * materializing every user id in memory and binding it as parameters would
 * blow past Postgres's 65,535 bound-parameter ceiling at platform scale.
 * gen_random_uuid() stands in for the JS-side $defaultFn id, and read/created_at
 * fall back to their DB defaults. Intentionally not group-muted — these are
 * admin platform announcements that must always deliver (hence
 * `platform_announcement` is absent from TYPE_TO_GROUP).
 */
export async function notifyAllUsers(
  type: NotificationType,
  payload: Record<string, unknown>,
  options?: { actorUserId?: string | null; excludeUserId?: string },
): Promise<void> {
  const actorUserId = options?.actorUserId ?? inferActorUserId(payload);
  const actorColumn = isNotificationActorSchemaReady()
    ? sql`, actor_user_id`
    : sql``;
  const actorValue = isNotificationActorSchemaReady()
    ? sql`, ${actorUserId}`
    : sql``;
  const excludePredicate = options?.excludeUserId
    ? sql`AND u.id <> ${options.excludeUserId}`
    : sql``;

  await db.execute(sql`
    INSERT INTO notifications (id, user_id, type, payload${actorColumn})
    SELECT gen_random_uuid()::text, u.id, ${type}, ${JSON.stringify(payload)}::jsonb${actorValue}
    FROM "user" u
    WHERE u.is_banned = false
      AND u.is_suspended = false
      ${excludePredicate}
  `);
}

/**
 * Insert-or-refresh a per-group notification, coalescing on
 * (userId, type, payload->>'groupKey', read=false).
 *
 * Used for admin review-pending pings: an author who edits and re-submits the
 * same card many times would otherwise mint a fresh notification per resubmit
 * per admin, flooding every admin's bell with rows that all point at the same
 * queue entry. Instead, if an admin already has a notification for this group
 * (read OR unread), we refresh it in place (flip back to unread + bump
 * createdAt so it floats to the top, refresh worldName/thumbnail/author in case
 * they changed, increment `resubmitCount`) rather than adding a new row. A new
 * row is created only for admins who have NO row for this group at all — i.e.
 * the group was already approved/rejected (clearGroupNotifications deleted it)
 * and this is a fresh edit cycle. Matching read rows too is what prevents the
 * duplicate "等待审核" pings an admin saw after reading the prior ping for a
 * still-pending card.
 *
 * Writes the notifications table directly, bypassing the group-mute check in
 * notify()/notifyMany() — these are operational admin pings that must always be
 * delivered (which is also why `new_review_pending` is intentionally absent from
 * TYPE_TO_GROUP).
 */
export async function notifyCoalescedByGroup(
  userIds: string[],
  type: NotificationType,
  groupKey: string,
  payload: Record<string, unknown>,
  options?: { actorUserId?: string | null },
): Promise<void> {
  if (userIds.length === 0) return;

  const actorUserId = options?.actorUserId ?? inferActorUserId(payload);
  const actorColumnReady = isNotificationActorSchemaReady();
  const actorAssignment = actorColumnReady
    ? sql`actor_user_id = ${actorUserId},`
    : sql``;

  // ① Refresh the existing notification for this (admin, type, group),
  //    regardless of its read state. We match read AND unread rows on purpose:
  //    once an admin has read/clicked the prior ping (to open the card) the
  //    group is still pending — clearGroupNotifications only deletes on
  //    approve/reject — so a resubmit must fold into that read row, not mint a
  //    duplicate. The refresh flips it back to unread + floats it to the top so
  //    the admin sees the card was resubmitted.
  //    `payload` on the RHS of SET refers to the pre-update value, so the
  //    resubmit counter reads the old count and bumps it.
  const refreshed = await db.execute(sql`
    UPDATE notifications
    SET ${actorAssignment}
        payload = ${JSON.stringify(payload)}::jsonb
                || jsonb_build_object(
                     'resubmitCount',
                     coalesce((payload->>'resubmitCount')::int, 1) + 1
                   ),
        read = false,
        created_at = now()
    WHERE type = ${type}
      AND payload->>'groupKey' = ${groupKey}
      AND user_id IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})
    RETURNING user_id
  `);

  const refreshedIds = new Set(
    (refreshed.rows as Array<{ user_id: string }>).map((r) => r.user_id),
  );

  // ② First-time recipients (no unread one to fold into) get a fresh row.
  const fresh = userIds.filter((id) => !refreshedIds.has(id));
  if (fresh.length > 0) {
    await db.insert(notifications).values(
      fresh.map((uid) => ({
        userId: uid,
        type,
        payload: { ...payload, resubmitCount: 1 },
        ...(actorColumnReady ? { actorUserId } : {}),
      })),
    );
  }
}

/**
 * Delete every notification (read or unread) of `type` whose payload groupKey
 * matches — used to clear stale review-pending pings once a card group has been
 * approved or rejected, so admins' bells don't keep a "waiting" entry for work
 * that's already been actioned.
 */
export async function clearGroupNotifications(
  type: NotificationType,
  groupKey: string,
): Promise<void> {
  await db
    .delete(notifications)
    .where(
      and(
        eq(notifications.type, type),
        sql`${notifications.payload}->>'groupKey' = ${groupKey}`,
      ),
    );
}
