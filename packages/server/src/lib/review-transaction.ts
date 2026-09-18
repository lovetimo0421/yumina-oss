import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { LedgerDatabase } from "./transaction-hash.js";

export type ReviewContext = {
  database: LedgerDatabase;
  afterCommit: (work: () => Promise<void> | void) => void;
};
export class StaleReviewError extends Error {
  constructor() {
    super("This submission changed. Reload the preview before deciding.");
  }
}
export class BannedReviewError extends Error {
  constructor() {
    super("Author is banned. Unban first to publish their submission.");
  }
}
export interface ReviewRevision {
  id: string;
  revision: string;
}
export function reviewRevision(
  worldStamp: unknown,
  pendingStamp: unknown,
  status: unknown,
  pendingStatus: unknown,
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        worldStamp ?? null,
        pendingStamp ?? null,
        status ?? null,
        pendingStatus ?? null,
      ]),
    )
    .digest("hex");
}
export async function lockReview(
  database: LedgerDatabase,
  groupKey: string,
  expected?: ReviewRevision[],
) {
  await database.execute(sql`SET LOCAL lock_timeout='2s'`);
  await database.execute(
    sql`SELECT id FROM worlds WHERE coalesce(language_group_id,id)=${groupKey} ORDER BY id FOR UPDATE`,
  );
  await database.execute(
    sql`SELECT world_id FROM world_pending_edits WHERE group_key=${groupKey} ORDER BY world_id FOR UPDATE`,
  );
  const rows =
    await database.execute(sql`SELECT w.id,w.updated_at::text AS "worldStamp",p.updated_at::text AS "pendingStamp",w.status,p.status AS "pendingStatus"
    FROM worlds w LEFT JOIN world_pending_edits p ON p.world_id=w.id
    WHERE coalesce(w.language_group_id,w.id)=${groupKey} ORDER BY w.id`);
  if (expected) {
    const versions = new Map(expected.map((row) => [row.id, row.revision]));
    if (
      versions.size !== expected.length ||
      rows.rows.length !== versions.size ||
      rows.rows.some(
        (row) =>
          versions.get(String(row.id)) !==
          reviewRevision(
            row.worldStamp,
            row.pendingStamp,
            row.status,
            row.pendingStatus,
          ),
      )
    )
      throw new StaleReviewError();
  }
}

export async function runReviewDecision<T>(
  database: LedgerDatabase,
  groupKey: string,
  expected: ReviewRevision[] | undefined,
  approve: boolean,
  work: (context: ReviewContext) => Promise<T>,
): Promise<T> {
  const effects: Array<() => Promise<void> | void> = [];
  const result = await database.transaction(async (tx) => {
    await lockReview(tx, groupKey, expected);
    if (approve) {
      const authors = await tx.execute(
        sql`SELECT u.is_banned FROM "user" u WHERE u.id IN (SELECT creator_id FROM worlds WHERE coalesce(language_group_id,id)=${groupKey}) FOR SHARE`,
      );
      if (authors.rows.some((row) => row.is_banned))
        throw new BannedReviewError();
    }
    return work({
      database: tx,
      afterCommit: (effect) => {
        effects.push(effect);
      },
    });
  });
  for (const effect of effects)
    void Promise.resolve()
      .then(effect)
      .catch(() => {});
  return result;
}
