import { sql } from "drizzle-orm";
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
