import { and, eq, sql } from "drizzle-orm";
import { messages } from "../db/schema.js";

/** Edit the selected version atomically, without replacing concurrently added swipes. */
export function messageContentUpdate(content: string) {
  return {
    content,
    swipes: sql`CASE
      WHEN jsonb_typeof(${messages.swipes}) = 'array'
        AND COALESCE(${messages.activeSwipeIndex}, 0) >= 0
        AND COALESCE(${messages.activeSwipeIndex}, 0) < jsonb_array_length(${messages.swipes})
      THEN jsonb_set(${messages.swipes},
        ARRAY[COALESCE(${messages.activeSwipeIndex}, 0)::text, 'content'],
        to_jsonb(${content}::text), true)
      ELSE ${messages.swipes}
    END`,
  };
}

/**
 * Row filter for an edit. With `expectedSwipeIndex` the write only lands while
 * that variant is still the active one — the edit box was seeded from it, so
 * writing into any other variant would overwrite text the player never saw
 * in the box (swipe-then-edit race, launch QA 2026-09-25).
 */
export function messageEditWhere(messageId: string, expectedSwipeIndex?: number) {
  return expectedSwipeIndex === undefined
    ? eq(messages.id, messageId)
    : and(eq(messages.id, messageId), sql`COALESCE(${messages.activeSwipeIndex}, 0) = ${expectedSwipeIndex}`);
}
