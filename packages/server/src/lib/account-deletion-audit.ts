import { sql, type SQL } from "drizzle-orm";

type SqlExecutor = {
  execute(query: SQL): Promise<unknown>;
};

/**
 * Keep operational audit rows while removing their live user identifier.
 * The keyed tombstone value supports audit correlation without making prior
 * content, submissions, or administrator actions an eligibility restriction.
 */
export async function anonymizeDeletedAccountAudit(
  executor: SqlExecutor,
  userId: string,
  deletedAuditIdentity: string,
): Promise<void> {
  await executor.execute(sql`
    UPDATE admin_actions action
    SET
      target_id = CASE
        WHEN action.target_type = 'user' AND action.target_id = ${userId}
          THEN ${deletedAuditIdentity}
        ELSE action.target_id
      END,
      metadata = (
        SELECT COALESCE(
          jsonb_object_agg(
            entry.key,
            CASE
              WHEN entry.key IN (
                'targetUserId', 'userId', 'recipientId', 'creatorId',
                'submitterId', 'ownerUserId', 'authorId', 'senderId'
              )
              AND entry.value = to_jsonb(${userId}::text)
                THEN to_jsonb(${deletedAuditIdentity}::text)
              ELSE entry.value
            END
          ),
          '{}'::jsonb
        )
        FROM jsonb_each(COALESCE(action.metadata, '{}'::jsonb)) entry
      ) || CASE
        WHEN action.admin_id = ${userId}
          THEN jsonb_build_object('deletedAdminIdentity', ${deletedAuditIdentity}::text)
        ELSE '{}'::jsonb
      END
    WHERE action.admin_id = ${userId}
      OR (action.target_type = 'user' AND action.target_id = ${userId})
      OR action.metadata->>'targetUserId' = ${userId}
      OR action.metadata->>'userId' = ${userId}
      OR action.metadata->>'recipientId' = ${userId}
      OR action.metadata->>'creatorId' = ${userId}
      OR action.metadata->>'submitterId' = ${userId}
      OR action.metadata->>'ownerUserId' = ${userId}
      OR action.metadata->>'authorId' = ${userId}
      OR action.metadata->>'senderId' = ${userId}
  `);
}
