import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  adminActions,
  user,
  worlds,
  worldReviewSubmissions,
} from "../db/schema.js";
import { notify } from "./notify.js";
import { embedAndStoreWorld } from "./embeddings.js";
import { notifyFollowersOfPublish } from "../routes/worlds.js";
import { onWorldPublished } from "./achievements/engine.js";
import { captureAutomaticVersion } from "./world-version-history.js";
import type { ReviewContext } from './review-transaction.js';

export interface ApproveResult {
  approved: boolean;
  reason?: "nothing_to_approve" | "author_banned";
  groupKey: string;
  variantCount: number;
}

interface ApproveOptions {
  /** Admin user id, or null for auto-approval / skip-review auto-publish. */
  reviewerId: string | null;
  /**
   * "manual"     — an admin approved from the moderation queue.
   * "auto"       — the (currently unused) auto-approve timer.
   * "skipReview" — the creator has the admin-granted trusted-creator flag, so
   *                their submission auto-publishes without ever queuing.
   * Drives the adminActions actionType + the "auto-approved" notification flavor.
   */
  source: "manual" | "auto" | "skipReview";
  /**
   * When set, approve ONLY these variant ids within the group; any other
   * pending_review siblings are left for a human. Omit = approve the whole
   * group (manual admin approve / auto-timer). The skipReview auto-publish
   * passes the ids it just submitted so it never sweeps a sibling that was
   * already queued before the creator was trusted (future-only invariant).
   */
  onlyWorldIds?: string[];
  context?: ReviewContext;
}

/**
 * Shared approve flow used by both manual admin approve (admin-moderation.ts)
 * and the 1-hour auto-approve timer (lib/auto-approve.ts).
 *
 * - Idempotent: if no variants are still pending_review when we arrive (e.g.
 *   another approver / auto-timer beat us to it), returns approved=false
 *   without writing audit or notifying.
 * - Refuses to approve if the author is currently banned (an admin who
 *   bans someone mid-flight should not see their work auto-publish).
 */
export async function approveGroup(
  groupKey: string,
  opts: ApproveOptions,
): Promise<ApproveResult> {
  const database=opts.context?.database??db;
  // Optional variant scoping (skipReview future-only). null = whole group.
  const scopeIds = opts.onlyWorldIds && opts.onlyWorldIds.length > 0 ? opts.onlyWorldIds : null;
  const variants = await database
    .select({
      id: worlds.id,
      creatorId: worlds.creatorId,
      name: worlds.name,
      thumbnailUrl: worlds.thumbnailUrl,
      description: worlds.description,
      tags: worlds.tags,
      announcement: worlds.announcement,
      schema: worlds.schema,
      languageGroupId: worlds.languageGroupId,
    })
    .from(worlds)
    .where(and(
      sql`coalesce(${worlds.languageGroupId}, ${worlds.id}) = ${groupKey}`,
      eq(worlds.status, "pending_review"),
      scopeIds ? inArray(worlds.id, scopeIds) : undefined,
    ));

  if (variants.length === 0) {
    return { approved: false, reason: "nothing_to_approve", groupKey, variantCount: 0 };
  }

  const variantIds = variants.map((v) => v.id);
  const creatorId = variants[0]!.creatorId;

  const [creatorRow] = await database
    .select({ name: user.name, isBanned: user.isBanned })
    .from(user)
    .where(eq(user.id, creatorId))
    .limit(1);

  if (creatorRow?.isBanned) {
    return { approved: false, reason: "author_banned", groupKey, variantCount: variants.length };
  }

  const creatorName = creatorRow?.name ?? "Someone";
  const now = new Date();

  // Race window: between the variants SELECT above and the UPDATE below,
  // another caller (e.g. manual admin approve while the timer is mid-flight)
  // may have already flipped status to 'published'. The WHERE clause filters
  // on status='pending_review' so the second writer just UPDATEs zero rows.
  // We use .returning() so we can detect that and bail without re-writing
  // an extra audit row.
  const actualUpdates = await database.transaction(async (tx) => {
    const updated = await tx
      .update(worlds)
      .set({
        status: "published",
        isPublished: true,
        reviewStatus: "approved",
        reviewedBy: opts.reviewerId, // null for auto
        reviewedAt: now,
        // First-publish stamp = the moment this审核 approval lands. COALESCE
        // normally preserves a genuine earlier publish date, BUT the legacy
        // published_at backfill (db/index.ts) set published_at = created_at for
        // cards that were is_published before the review system, i.e. cards that
        // were never actually published-via-review. That placeholder collapses
        // the 十年磨一剑 gap (published_at − created_at) to 0, so a creator who
        // held a draft for weeks before this real publish never earns it. Treat
        // a published_at that still equals created_at as "no real publish yet"
        // and stamp the actual approval time, so the gap reflects
        // create → first real publish (created_at can never genuinely equal the
        // approval instant — creation, submit, and admin approval take real time).
        publishedAt: sql`CASE WHEN ${worlds.publishedAt} IS NULL OR ${worlds.publishedAt} = ${worlds.createdAt} THEN ${now} ELSE ${worlds.publishedAt} END`,
        rejectionReason: null,
        rejectionDetail: null,
        moderationNote: null,
        moderationAction: null,
        updatedAt: now,
      })
      .where(and(
        inArray(worlds.id, variantIds),
        eq(worlds.status, "pending_review"),
      ))
      .returning();

    if (updated.length === 0) {
      // Lost the race. Roll back the transaction (nothing to commit anyway).
      return [];
    }

    // Snapshot exactly what this transaction made public, including edits
    // saved after the earlier variants read. Only this path grants live provenance.
    for (const world of updated) await captureAutomaticVersion(tx, world, "live", world);

    await tx
      .update(worldReviewSubmissions)
      .set({
        decision: "approved",
        decidedBy: opts.reviewerId,
        decidedAt: now,
      })
      .where(and(
        eq(worldReviewSubmissions.groupKey, groupKey),
        eq(worldReviewSubmissions.decision, "pending"),
        // First-publish submissions only — held-edit submissions are decided by
        // commitPendingEditsForGroup (admin-moderation.ts), not this flow.
        eq(worldReviewSubmissions.submissionType, "initial"),
        // Match the variant scoping so a backlogged sibling's submission is not
        // marked decided while its world row stays pending_review.
        scopeIds ? inArray(worldReviewSubmissions.worldId, scopeIds) : undefined,
      ));

    await tx.insert(adminActions).values({
      adminId: opts.reviewerId, // schema allows NULL for system actions
      actionType:
        opts.source === "auto"
          ? "auto_approve_world_review"
          : opts.source === "skipReview"
            ? "skip_review_auto_publish_world"
            : "approve_world_review",
      targetType: "world_review_group",
      targetId: groupKey,
      metadata: {
        variantCount: variants.length,
        variantIds,
        creatorId,
        worldNames: variants.map((v) => v.name),
        source: opts.source,
      },
    });

    return updated;
  });

  if (actualUpdates.length === 0) {
    return { approved: false, reason: "nothing_to_approve", groupKey, variantCount: 0 };
  }

  // Post-commit side effects (do not roll back if they fail).
  const afterCommit=()=>{
  notify(creatorId, "world_review_approved", {
    groupKey,
    primaryWorldId: variants[0]!.id,
    worldName: variants[0]!.name,
    thumbnailUrl: variants[0]!.thumbnailUrl,
    variantCount: variants.length,
    // Both auto-timer and skip-review publish without a human reviewer — flavor
    // the creator's notification as auto-approved in either case.
    autoApproved: opts.source !== "manual",
  }).catch(() => {});

  // Embed only rows this transaction actually published, using RETURNING
  // content rather than the earlier moderation-queue snapshot.
  for (const v of actualUpdates) {
    embedAndStoreWorld({
      worldId: v.id,
      name: v.name,
      description: v.description,
      tags: v.tags,
      announcement: v.announcement,
      schema: v.schema,
    }).catch(() => {});
  }

  notifyFollowersOfPublish(
    creatorId,
    creatorName,
    variants[0]!.id,
    variants[0]!.name,
    variants[0]!.thumbnailUrl,
  );

  // Achievement engine: publishedAt was stamped in the approval transaction;
  // the creator's publish achievements (初入造梦 / 多语筑梦 / 十年磨一剑).
  onWorldPublished(creatorId).catch(() => {});
  };
  if(opts.context)opts.context.afterCommit(afterCommit);else afterCommit();

  return { approved: true, groupKey, variantCount: variants.length };
}
