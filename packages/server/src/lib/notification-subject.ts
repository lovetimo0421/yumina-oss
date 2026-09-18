import type { NotificationType } from "./notify.js";

export type NotificationSubjectType = "post" | "thread" | "world" | "bundle";

export interface NotificationSubject {
  type: NotificationSubjectType;
  id: string;
}

export const MUTABLE_NOTIFICATION_TYPES = [
  "new_favorite",
  "new_review",
  "new_comment",
  "new_review_reply",
  "followed_user_published",
  "world_update",
  "thread_reply",
  "post_reply",
  "thread_like",
  "post_like",
  "bundle_like",
  "creator_community_post",
] as const satisfies readonly NotificationType[];

const SUBJECT_MUTABLE_TYPES = new Set<NotificationType>(MUTABLE_NOTIFICATION_TYPES);

const MUTED_NOTIFICATION_SUBJECTS_KEY = "mutedNotificationSubjects";

export function notificationSubjectKey(subject: NotificationSubject): string {
  return `${subject.type}:${subject.id}`;
}

/**
 * Return the content entity whose routine activity can be muted. System,
 * moderation, safety and transaction notifications intentionally return null
 * even when their payload happens to carry a world/thread id.
 */
export function notificationSubjectFor(
  type: NotificationType,
  payload: Record<string, unknown>,
): NotificationSubject | null {
  if (!SUBJECT_MUTABLE_TYPES.has(type)) return null;

  if (type === "post_reply") {
    const parentPostId = typeof payload.parentPostId === "string" ? payload.parentPostId : "";
    if (parentPostId) return { type: "post", id: parentPostId };
  }

  if (type === "post_like") {
    const postId = typeof payload.postId === "string" ? payload.postId : "";
    if (postId) return { type: "post", id: postId };
  }

  const threadId = typeof payload.threadId === "string" ? payload.threadId : "";
  if (threadId) return { type: "thread", id: threadId };

  const bundleId = typeof payload.bundleId === "string" ? payload.bundleId : "";
  if (bundleId) return { type: "bundle", id: bundleId };

  const worldId = typeof payload.worldId === "string" ? payload.worldId : "";
  if (worldId) return { type: "world", id: worldId };

  return null;
}

export function mutedNotificationSubjectKeys(preferences: unknown): Set<string> {
  if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) {
    return new Set();
  }
  const raw = (preferences as Record<string, unknown>)[MUTED_NOTIFICATION_SUBJECTS_KEY];
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((value): value is string => typeof value === "string" && value.length <= 300));
}

export function isNotificationSubjectMuted(
  preferences: unknown,
  subject: NotificationSubject | null,
): boolean {
  return !!subject && mutedNotificationSubjectKeys(preferences).has(notificationSubjectKey(subject));
}
