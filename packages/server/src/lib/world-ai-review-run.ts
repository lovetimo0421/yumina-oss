/**
 * Runs the card AI first look on a review group and applies it (卡片 AI 初审).
 *
 * Submit → the models look at every edition waiting in the group → if they
 * agree with everything the author set, the group goes live the way an admin
 * approve would; otherwise it stays in the queue with the reasons, and only
 * then are admins pinged. Any failure leaves the group for a person.
 *
 * A sweep picks up groups a restart interrupted or that predate this.
 */
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { adminActions, worldReviewSubmissions, worlds } from "../db/schema.js";
import { env } from "./env.js";
import { approveGroup } from "./approve-review.js";
import { commitPendingEditsForGroup } from "./pending-edit.js";
import { clearGroupNotifications } from "./notify.js";
import { runExclusive } from "./leader.js";
import { reviewRevision, runReviewDecision, StaleReviewError, type ReviewRevision } from "./review-transaction.js";
import {
  authorSettings, cardTextFromSchema, isFinishedReview, loadCoverJpeg, reviewWorld,
  type ReviewPrecedent, type WorldAiReason, type WorldAiReview, type WorldReviewInput,
} from "./world-ai-review.js";
import { collectInnerImages, coverKey, explicitWordInCard } from "./world-ai-review-media.js";
import { cardFullText, keywordPassages, minorWordInCard } from "./world-ai-review-core.js";
import { coversSideBySide } from "./world-ai-review-image.js";
import {
  chooseReviewScope, nothingToRead, summarizeChanges, updateReviewInput,
  type ChangeSummary, type ReviewSide, type UpdateChanges,
} from "./world-ai-review-diff.js";

/** Off with WORLD_AI_REVIEW=0 (everything then waits for a person, as before). */
export function worldAiReviewEnabled(): boolean {
  return process.env.WORLD_AI_REVIEW !== "0" && !!env.YUMINA_OPENROUTER_KEY;
}

const MAX_EDITIONS = 4;
const CLAIM_STALE_MINUTES = 10;

interface Edition extends ReviewSide {
  id: string;
  creatorId: string;
  revision: string;
  /** The live card, when this is a held edit to a published card. */
  live: ReviewSide | null;
  /** A review approved this card before (an admin's or the AI's). */
  approved: boolean;
}

function reviewSide(value: unknown): ReviewSide | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  return {
    name: String(r.name ?? ""), description: (r.description as string | null) ?? null, tags: r.tags,
    ageRating: String(r.ageRating ?? "all"), targetAudience: String(r.targetAudience ?? "all"),
    blurCover: (r.blurCover as boolean | null) ?? null, thumbnailUrl: (r.thumbnailUrl as string | null) ?? null,
    galleryImages: Array.isArray(r.galleryImages) ? (r.galleryImages as unknown[]).map(String) : [],
    schema: r.schema,
  };
}

export { coverKey };

/** What players would get if this group were approved now: the held edit's
 *  values where one is pending, the world's own otherwise. */
async function loadEditions(groupKey: string, worldIds: string[]): Promise<{ editions: Edition[]; revisions: ReviewRevision[] }> {
  const rows = await db.execute(sql`
    SELECT w.id, w.creator_id AS "creatorId",
      -- A held edit carries its own name, text, tags, gallery, audience and blur
      -- (versionMetadata); approval applies those, so those are what is judged.
      CASE WHEN p.status='pending' AND p.metadata ? 'name' THEN p.metadata->>'name' ELSE w.name END AS name,
      CASE WHEN p.status='pending' AND p.metadata ? 'description' THEN p.metadata->>'description' ELSE w.description END AS description,
      CASE WHEN p.status='pending' AND p.metadata ? 'tags' THEN p.metadata->'tags' ELSE w.tags END AS tags,
      CASE WHEN p.status='pending' THEN coalesce(p.age_rating,w.age_rating) ELSE w.age_rating END AS "ageRating",
      CASE WHEN p.status='pending' AND p.metadata ? 'targetAudience' THEN p.metadata->>'targetAudience' ELSE w.target_audience END AS "targetAudience",
      CASE WHEN p.status='pending' AND p.metadata ? 'blurCover' THEN (p.metadata->>'blurCover')::boolean ELSE w.blur_cover END AS "blurCover",
      CASE WHEN p.status='pending' THEN coalesce(p.thumbnail_url,w.thumbnail_url) ELSE w.thumbnail_url END AS "thumbnailUrl",
      CASE WHEN p.status='pending' THEN p.schema ELSE w.schema END AS schema,
      CASE WHEN p.status='pending' AND p.metadata ? 'galleryImages' THEN p.metadata->'galleryImages' ELSE w.gallery_images END AS "galleryImages",
      w.updated_at::text AS "worldStamp", p.updated_at::text AS "pendingStamp", w.status, p.status AS "pendingStatus",
      -- What players have now, for an update judged on its changes.
      CASE WHEN p.status='pending' AND w.status='published' AND w.is_published THEN jsonb_build_object(
        'name', w.name, 'description', w.description, 'tags', w.tags, 'ageRating', w.age_rating,
        'targetAudience', w.target_audience, 'blurCover', w.blur_cover, 'thumbnailUrl', w.thumbnail_url,
        'galleryImages', w.gallery_images, 'schema', w.schema) END AS live,
      EXISTS (SELECT 1 FROM world_review_submissions a WHERE a.world_id = w.id AND a.decision = 'approved') AS approved
    FROM worlds w LEFT JOIN world_pending_edits p ON p.world_id = w.id
    WHERE coalesce(w.language_group_id, w.id) = ${groupKey}
    ORDER BY w.id`);
  // The decision locks every edition of the group (live siblings too), so the
  // revisions it checks cover them all; only the waiting ones are reviewed.
  const all = (rows.rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id), creatorId: String(r.creatorId), name: String(r.name ?? ""),
    description: (r.description as string | null) ?? null, tags: r.tags,
    ageRating: String(r.ageRating ?? "all"), targetAudience: String(r.targetAudience ?? "all"),
    blurCover: (r.blurCover as boolean | null) ?? null, thumbnailUrl: (r.thumbnailUrl as string | null) ?? null,
    galleryImages: Array.isArray(r.galleryImages) ? (r.galleryImages as unknown[]).map(String) : [],
    schema: r.schema, revision: reviewRevision(r.worldStamp, r.pendingStamp, r.status, r.pendingStatus),
    live: reviewSide(r.live), approved: r.approved === true,
  }));
  return {
    editions: all.filter((e) => worldIds.includes(e.id)),
    revisions: all.map((e) => ({ id: e.id, revision: e.revision })),
  };
}

/**
 * A person's earlier decision on this group that the AI should follow: the
 * latest approval by an admin (not the author, not the AI) whose AI notes
 * carried a flag the admin left as it was, where that setting is still what
 * the author has now. 11/08: Addanc's URPG went to a person on every update
 * for the same "could be Limitless" note an admin had already waved through.
 */
async function loadPrecedent(groupKey: string, editions: Edition[]): Promise<ReviewPrecedent> {
  // The latest admin decision on the group, whatever it was: a later
  // rejection voids an earlier approval. Precedents expire after 60 days.
  // Settings are compared with the live row, which is what that approval
  // (and anything approved since) left in place.
  const rows = await db.execute(sql`
    SELECT s.decision, s.ai_review AS ai, w.age_rating AS "ageRating", w.target_audience AS "targetAudience",
      w.blur_cover AS "blurCover", w.thumbnail_url AS "thumbnailUrl", w.schema->>'landscapeCover' AS "landscapeCover",
      (w.status = 'published' AND w.is_published) AS "live"
    FROM world_review_submissions s
    JOIN worlds w ON w.id = s.world_id
    LEFT JOIN "user" u ON u.id = s.decided_by
    WHERE s.group_key = ${groupKey} AND s.decided_at > now() - interval '60 days'
      -- Any rejection counts, whoever made it; an approval counts only from an
      -- admin who is not the author (the AI's own approvals are no precedent).
      AND (s.decision = 'rejected'
        OR (s.decision = 'approved' AND s.decided_by IS NOT NULL AND s.decided_by <> w.creator_id AND u.role = 'admin'))
    ORDER BY s.decided_at DESC LIMIT 1`);
  const prior = rows.rows[0] as { live: boolean; decision: string; ai: unknown; ageRating: string; targetAudience: string; blurCover: boolean | null; thumbnailUrl: string | null; landscapeCover: string | null } | undefined;
  // A card taken down since is no precedent.
  if (!prior || prior.decision !== "approved" || !prior.live || !isFinishedReview(prior.ai)) return {};
  const landscapeOf = (e: Edition) => {
    const v = (e.schema as { landscapeCover?: unknown } | null)?.landscapeCover;
    return typeof v === "string" && v ? v : null;
  };
  const flagged = new Set(prior.ai.reasons);
  const now = editions;
  const answered = prior.ai.models.filter((m) => m.answer);
  return {
    limitlessShare: answered.length ? answered.filter((m) => m.answer!.contentMode === "limitless").length / answered.length : 0,
    keepLimited: flagged.has("should_be_limitless") && prior.ageRating === "all" && now.every((e) => e.ageRating === "all"),
    keepAudience: flagged.has("audience_mismatch") && now.every((e) => e.targetAudience === prior.targetAudience),
    keepClearCover: flagged.has("cover_needs_blur") && prior.blurCover !== true
      // Both covers (portrait and desktop) exactly as the admin saw them.
      && now.every((e) => e.blurCover !== true && e.thumbnailUrl === prior.thumbnailUrl && landscapeOf(e) === (prior.landscapeCover || null)),
  };
}

/**
 * An update to an approved card is judged on what changed (Jason, 11/12);
 * a new card, or an update that changes what the whole card is held to
 * (world-ai-review-diff.ts), on the whole card.
 */
async function reviewEdition(e: Edition, editions: number, precedent: ReviewPrecedent = {}): Promise<WorldAiReview> {
  const scope = chooseReviewScope(e.live, e, e.approved);
  return scope.mode === "changes"
    ? reviewChanges(e, e.live!, scope.changes, editions, precedent)
    : reviewWholeCard(e, editions, precedent);
}

/** The portrait cover, with the desktop (16:9) cover beside it when there is one. */
async function loadCovers(e: Edition): Promise<{ cover: Buffer | null; coverError?: string; landscapeRef: string | null }> {
  let cover: Buffer | null = null;
  let coverError: string | undefined;
  if (e.thumbnailUrl) {
    try { cover = await loadCoverJpeg(await coverKey(e.thumbnailUrl, e.creatorId)); }
    catch (error) { coverError = error instanceof Error ? error.message.slice(0, 160) : String(error); }
  }
  // The desktop (16:9) cover is shown on listings too: judged with the portrait one.
  const landscapeRef = typeof (e.schema as { landscapeCover?: unknown } | null)?.landscapeCover === "string"
    ? (e.schema as { landscapeCover: string }).landscapeCover : null;
  if (landscapeRef && landscapeRef !== e.thumbnailUrl) {
    try {
      const landscape = await loadCoverJpeg(await coverKey(landscapeRef, e.creatorId));
      cover = cover ? await coversSideBySide(cover, landscape) : landscape;
    } catch (error) { coverError = `desktop cover: ${error instanceof Error ? error.message.slice(0, 140) : String(error)}`; }
  }
  return { cover, coverError, landscapeRef };
}

async function reviewChanges(e: Edition, live: ReviewSide, changes: UpdateChanges, editions: number, precedent: ReviewPrecedent): Promise<WorldAiReview> {
  // The cover only when it (or its blur) changed; pictures only the live card doesn't have.
  const covers = changes.coverChanged ? await loadCovers(e) : { cover: null, coverError: undefined };
  const landscapeRef = typeof (e.schema as { landscapeCover?: unknown } | null)?.landscapeCover === "string"
    ? (e.schema as { landscapeCover: string }).landscapeCover : null;
  const inner = await collectInnerImages({
    schema: e.schema, gallery: e.galleryImages, coverRef: e.thumbnailUrl, ownerId: e.creatorId,
    excludeRefs: landscapeRef ? [landscapeRef] : [],
    known: { schema: live.schema, gallery: live.galleryImages },
  });
  const summary = summarizeChanges(changes, inner.seen + inner.unseen);
  const author = authorSettings(e);
  // Nothing a model would judge (lore removed, keywords or variables tuned):
  // the update clears without asking. Pictures the models could not see are
  // noted, never blocking, as in the whole-card look.
  if (nothingToRead(changes) && inner.grids.length === 0) {
    return {
      outcome: "approved", reasons: [], author, models: [],
      suggested: { contentMode: author.contentMode, audience: null, coverBlur: author.coverBlur },
      scope: "changes", changes: summary, at: new Date().toISOString(),
    };
  }
  const input = updateReviewInput(e, changes, {
    cover: covers.cover, coverError: covers.coverError, innerImages: inner.grids, unseenImages: inner.unseen,
  });
  const review = await reviewWorld(input, e.creatorId, { editions, precedent });
  if (covers.coverError) review.models = [...review.models, { model: "cover", error: covers.coverError }];
  return { ...review, scope: "changes", changes: summary };
}

async function reviewWholeCard(e: Edition, editions: number, precedent: ReviewPrecedent): Promise<WorldAiReview> {
  const { cover, coverError, landscapeRef } = await loadCovers(e);
  const inner = await collectInnerImages({
    schema: e.schema, gallery: e.galleryImages, coverRef: e.thumbnailUrl, ownerId: e.creatorId,
    excludeRefs: landscapeRef ? [landscapeRef] : [],
  });
  const input: WorldReviewInput = {
    name: e.name, description: e.description ?? "", tags: Array.isArray(e.tags) ? e.tags.map(String) : [],
    ageRating: e.ageRating, targetAudience: e.targetAudience, blurCover: e.blurCover,
    contentText: cardTextFromSchema(e.schema), cover, coverError,
    innerImages: inner.grids, unseenImages: inner.unseen,
    explicitWord: explicitWordInCard(e.name, e.description ?? "", e.schema),
    minorWord: minorWordInCard(e.name, e.description ?? "", e.schema),
    passages: keywordPassages(cardFullText(e.name, e.description ?? "", e.schema)),
  };
  const review = await reviewWorld(input, e.creatorId, { editions, precedent });
  if (coverError) review.models = [...review.models, { model: "cover", error: coverError }];
  return review;
}

class SiblingArrivedError extends Error {
  constructor() { super("Another edition was submitted while this one was being checked."); }
}
export const LOCK_RETRY_MS = 3000;
export function isLockTimeout(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } } | null;
  if (!e) return false;
  return e.code === "55P03" || e.cause?.code === "55P03"
    || /lock timeout/i.test(String(e.message ?? "")) || /lock timeout/i.test(String(e.cause?.message ?? ""));
}

function failedReview(message: string, reasons: WorldAiReason[] = ["ai_failed"]): WorldAiReview {
  return {
    outcome: "human", reasons,
    suggested: { contentMode: "limited", audience: null, coverBlur: false },
    author: { contentMode: "limited", audience: "all", coverBlur: false },
    models: [{ model: "system", error: message.slice(0, 300) }],
    at: new Date().toISOString(),
  };
}

/**
 * Check one group. Returns what happened, for logs and tests. `onHuman` runs
 * when the group stays for a person (the admin ping). `force` re-checks a
 * group that already has a verdict and `notesOnly` keeps it in the queue
 * (the admin's "ask the AI again").
 */
export async function runWorldAiReview(
  groupKey: string,
  opts: { force?: boolean; notesOnly?: boolean; onHuman?: () => Promise<void> | void; review?: typeof reviewEdition } = {},
): Promise<"approved" | "human" | "noted" | "skipped"> {
  // Claim the group's waiting submissions so two servers never both check it.
  const claimed = await db.update(worldReviewSubmissions)
    .set({ aiReview: { running: new Date().toISOString() } })
    .where(and(
      eq(worldReviewSubmissions.groupKey, groupKey),
      eq(worldReviewSubmissions.decision, "pending"),
      isNull(worldReviewSubmissions.ignoredAt),
      opts.force
        ? sql`NOT (coalesce(${worldReviewSubmissions.aiReview}, '{}'::jsonb) ? 'running' AND (${worldReviewSubmissions.aiReview}->>'running')::timestamptz > now() - make_interval(mins => ${CLAIM_STALE_MINUTES}))`
        : sql`(${worldReviewSubmissions.aiReview} IS NULL OR (${worldReviewSubmissions.aiReview} ? 'running' AND (${worldReviewSubmissions.aiReview}->>'running')::timestamptz < now() - make_interval(mins => ${CLAIM_STALE_MINUTES})))`,
    ))
    .returning();
  if (claimed.length === 0) return "skipped";
  const claimedIds = claimed.map((c) => c.id);
  const save = (review: WorldAiReview) => db.update(worldReviewSubmissions).set({ aiReview: review })
    .where(and(inArray(worldReviewSubmissions.id, claimedIds), eq(worldReviewSubmissions.decision, "pending")));
  const toHuman = async (review: WorldAiReview) => {
    await save(review);
    await opts.onHuman?.();
    return "human" as const;
  };
  // Hand our rows back unchecked; the sweep checks the whole group together a
  // few minutes later. For two editions submitted seconds apart (11/12, Aegis
  // Academy: the second one's submit collided with the first one's approval,
  // and both then waited hours for a person).
  const release = async () => {
    await db.update(worldReviewSubmissions).set({ aiReview: null }).where(and(
      inArray(worldReviewSubmissions.id, claimedIds), eq(worldReviewSubmissions.decision, "pending"),
      sql`${worldReviewSubmissions.aiReview} ? 'running'`));
    return "skipped" as const;
  };

  try {
    // Other waiting rows of the group we didn't claim: parked by an admin, or
    // already waiting for a person, keeps ours with them; one being checked
    // right now means we step back and let the sweep take the group whole.
    const waiting = await db.select({ id: worldReviewSubmissions.id, ignoredAt: worldReviewSubmissions.ignoredAt, aiReview: worldReviewSubmissions.aiReview })
      .from(worldReviewSubmissions)
      .where(and(eq(worldReviewSubmissions.groupKey, groupKey), eq(worldReviewSubmissions.decision, "pending")));
    const others = waiting.filter((w) => !claimedIds.includes(w.id));
    if (others.some((w) => w.ignoredAt)) return toHuman(failedReview("Part of this group is parked."));
    if (others.some((w) => w.aiReview && !("running" in (w.aiReview as object)))) {
      return toHuman(failedReview("Another edition of this card is waiting for a person."));
    }
    if (others.length) {
      return opts.force ? toHuman(failedReview("Another edition of this card is being checked right now.")) : release();
    }
    const worldIds = [...new Set(claimed.map((c) => c.worldId).filter((id): id is string => !!id))];
    if (worldIds.length === 0) return toHuman(failedReview("The card was deleted."));
    if (worldIds.length > MAX_EDITIONS) return toHuman(failedReview(`${worldIds.length} editions at once.`, ["many_editions"]));

    for (let attempt = 0; attempt < 2; attempt++) {
      const { editions, revisions } = await loadEditions(groupKey, worldIds);
      if (editions.length === 0) return toHuman(failedReview("The card was deleted."));
      const precedent = await loadPrecedent(groupKey, editions);
      const reviews = await Promise.all(editions.map((e) => (opts.review ?? reviewEdition)(e, editions.length, precedent)));
      // One edition's flag holds the whole group: its editions go live together,
      // and a setting the AI fixes on one edition is fixed on all (settings are
      // shared across a language group, as an admin edit syncs them).
      const applied = Object.assign({}, ...reviews.map((r) => r.applied ?? {})) as NonNullable<WorldAiReview["applied"]>;
      const audiences = new Set(reviews.flatMap((r) => (r.applied?.audience ? [r.applied.audience] : [])));
      const merged: WorldAiReview = reviews.length === 1 ? reviews[0]! : {
        ...reviews[0]!,
        // Two editions asking for different audiences is a question for a person.
        outcome: reviews.every((r) => r.outcome === "approved") && audiences.size <= 1 ? "approved" : "human",
        reasons: [...new Set(reviews.flatMap((r) => r.reasons))],
        models: reviews.flatMap((r, i) => r.models.map((m) => ({ ...m, model: `${editions[i]!.name.slice(0, 40)} · ${m.model}` }))),
        ...(Object.keys(applied).length ? { applied } : {}),
        settled: reviews.flatMap((r) => r.settled ?? []),
        // "Only the changes" holds for the group only when it held for every edition.
        ...(reviews.every((r) => r.scope === "changes") ? {
          scope: "changes" as const,
          changes: reviews.reduce<ChangeSummary>((sum, r) => ({
            entries: sum.entries + (r.changes?.entries ?? 0), files: sum.files + (r.changes?.files ?? 0),
            pictures: sum.pictures + (r.changes?.pictures ?? 0), cover: sum.cover || !!r.changes?.cover,
            description: sum.description || !!r.changes?.description,
          }), { entries: 0, files: 0, pictures: 0, cover: false, description: false }),
        } : { scope: undefined, changes: undefined }),
      };
      // An admin asking again while looking at the card gets fresh notes, never a publish.
      if (opts.notesOnly) { await save(merged); return "noted"; }
      if (merged.outcome !== "approved") return toHuman(merged);

      try {
        // Exactly what an admin approve does, pinned to what the AI saw: if the
        // author saved in the meantime, look again rather than publish unseen work.
        await runReviewDecision(db, groupKey, revisions, true, async (context) => {
          // Under the group lock: an edition submitted since we looked was not
          // reviewed, and approving the group would publish it unseen.
          const late = await context.database.select({ id: worldReviewSubmissions.id }).from(worldReviewSubmissions)
            .where(and(eq(worldReviewSubmissions.groupKey, groupKey), eq(worldReviewSubmissions.decision, "pending"),
              notInArray(worldReviewSubmissions.id, claimedIds)))
            .limit(1);
          if (late.length) throw new SiblingArrivedError();
          await context.database.update(worldReviewSubmissions).set({ aiReview: merged })
            .where(inArray(worldReviewSubmissions.id, claimedIds));
          const edit = await commitPendingEditsForGroup(groupKey, editions[0]!.creatorId, undefined, undefined, context);
          // The AI's own fixes, after the held edit lands (it carries its own
          // rating/blur/audience) and before the group goes live.
          const fix = merged.applied;
          if (fix && Object.keys(fix).length) {
            const groupIds = revisions.map((r) => r.id);
            await context.database.update(worlds).set({
              updatedAt: new Date(),
              ...(fix.contentMode === "limitless" ? { ageRating: "sensitive", isNsfw: true } : {}),
              ...(fix.coverBlur ? { blurCover: true } : {}),
              ...(fix.audience ? { targetAudience: fix.audience, tags: sql`worlds_tags_with_audience(${worlds.tags}, ${fix.audience}::text)` } : {}),
            }).where(inArray(worlds.id, groupIds));
            await context.database.insert(adminActions).values({
              adminId: null, actionType: "ai_apply_world_settings", targetType: "world_review_group", targetId: groupKey,
              metadata: { creatorId: editions[0]!.creatorId, worldIds: groupIds, applied: fix, author: merged.author, source: "ai" },
            });
          }
          const result = await approveGroup(groupKey, { reviewerId: null, source: "ai", context });
          if (!edit.handled && !result.approved) throw new Error(result.reason === "author_banned" ? "Author is banned." : result.reason === "game_path_not_allowed" ? "The card opens a game page that is not ours." : "Nothing to approve.");
          if (edit.handled) {
            // commitPendingEditsForGroup logs approve_world_edit under the author; say who really decided.
            await context.database.insert(adminActions).values({
              adminId: null, actionType: "ai_approve_world_edit", targetType: "world_review_group", targetId: groupKey,
              metadata: { creatorId: editions[0]!.creatorId, worldIds: editions.map((e) => e.id), source: "ai" },
            });
          }
          return { edit, result };
        });
      } catch (error) {
        if (error instanceof SiblingArrivedError) return release();
        if (error instanceof StaleReviewError && attempt === 0) continue;
        // The group's rows were busy past the 2s lock wait (the author saving or
        // submitting the other edition): wait a moment and look again.
        if (isLockTimeout(error) && attempt === 0) {
          await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
          continue;
        }
        return toHuman({ ...merged, outcome: "human", reasons: ["ai_failed"], models: [...merged.models, { model: "system", error: error instanceof Error ? error.message.slice(0, 200) : String(error) }] });
      }
      clearGroupNotifications("new_review_pending", groupKey).catch(() => {});
      return "approved";
    }
    return toHuman(failedReview("The card kept changing while it was being checked."));
  } catch (error) {
    console.error(`[world-ai-review] ${groupKey}:`, error instanceof Error ? error.message : error);
    return toHuman(failedReview(error instanceof Error ? error.message : String(error)));
  }
}

/** Fire-and-forget after a submission. Without the AI, the ping goes out now. */
export function queueWorldAiReview(groupKey: string, pingAdmins: () => Promise<void>): void {
  if (!worldAiReviewEnabled()) { pingAdmins().catch(() => {}); return; }
  void runWorldAiReview(groupKey, { onHuman: () => pingAdmins().catch(() => {}) }).catch((error) => {
    console.error("[world-ai-review] queue:", error instanceof Error ? error.message : error);
    pingAdmins().catch(() => {});
  });
}

/** Groups never checked (a restart mid-check, or waiting since before the AI). */
export async function sweepWorldAiReviews(limit = 10): Promise<number> {
  if (!worldAiReviewEnabled()) return 0;
  const rows = await db.execute(sql`
    SELECT group_key AS "groupKey" FROM world_review_submissions
    WHERE decision = 'pending' AND ignored_at IS NULL
      AND submitted_at < now() - interval '3 minutes'
      -- Only what the queue shows: rows whose group no longer matches a card
      -- (an old submission of a card that later joined a language group) are skipped.
      AND EXISTS (SELECT 1 FROM worlds w WHERE coalesce(w.language_group_id, w.id) = world_review_submissions.group_key)
      AND (ai_review IS NULL OR (ai_review ? 'running' AND (ai_review->>'running')::timestamptz < now() - make_interval(mins => ${CLAIM_STALE_MINUTES})))
    GROUP BY group_key ORDER BY min(submitted_at) LIMIT ${limit}`);
  let n = 0;
  for (const r of rows.rows as Array<{ groupKey: string }>) {
    // Admins were already pinged when these were submitted (or will see them in the queue).
    await runWorldAiReview(r.groupKey).catch(() => {});
    n++;
  }
  return n;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;
export function startWorldAiReviewSweep(): void {
  if (sweepTimer) return;
  const run = () => {
    void runExclusive("world-ai-review-sweep", 9 * 60, async () => {
      await sweepWorldAiReviews();
      const { sweepBundleAiReviews } = await import("./bundle-ai-review.js");
      await sweepBundleAiReviews();
    }).catch((error) =>
      console.error("[world-ai-review] sweep failed:", error instanceof Error ? error.message : error));
  };
  setTimeout(run, 2 * 60_000).unref();
  sweepTimer = setInterval(run, 10 * 60_000);
  sweepTimer.unref();
}
export function stopWorldAiReviewSweep(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

