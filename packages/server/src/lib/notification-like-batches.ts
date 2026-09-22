import { sql, type SQL } from "drizzle-orm";

/** Record which grouped actions arrived since the previous inbox visit. */
export async function recordNotificationLikeVisit(
  executor: { execute(query: SQL): Promise<unknown> },
  userId: string,
  batchId: string,
): Promise<void> {
  // The predicate is rechecked by PostgreSQL after concurrent updates: a
  // second tab cannot move previously assigned likes into a later batch.
  await executor.execute(sql`
    UPDATE notifications
    SET payload = payload || jsonb_build_object(
      'activityBatchId', coalesce(
        payload->>'likeBatchId',
        CASE WHEN read THEN 'history' ELSE ${batchId}::text END
      )
    )
    WHERE user_id = ${userId}
      AND type IN (
        'new_favorite', 'bundle_like', 'thread_like', 'post_like',
        'new_follower', 'thread_reply', 'post_reply', 'new_comment', 'new_review_reply'
      )
      AND payload->>'activityBatchId' IS NULL
  `);
}
