import { and, asc, desc, eq, getTableColumns, inArray, isNull, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Database } from "../db/index.js";
import { adminActions, contentTranslations, follows, reviews, reviewReplies, user, worldRatings, worlds } from "../db/schema.js";
import { checkLowRating } from "./world-rating-rules.js";
import { sanitizeContent } from "./sanitize.js";

export type FeedbackActor = { id: string; role?: string; limitedContentOnly?: boolean };
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Reader = Database | Transaction;
export type FeedbackKind = "review" | "discussion";
const fail = (status: 400 | 403 | 404 | 409, message: string): never => { throw new HTTPException(status, { res: Response.json({ error: message }, { status }) }); };
const clientIdValue = (value: unknown) => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) fail(400, "Invalid submission ID");
  return value as string;
};
const ratingValue = (value: unknown) => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5) fail(400, "A review requires a rating from 1 to 5");
  return value as number;
};
const textValue = (value: unknown, max: number, required = false) => {
  const text = sanitizeContent(typeof value === "string" ? value.trim() : "");
  if ((required && !text) || text.length > max) fail(400, `Content must be ${required ? "1" : "0"}–${max} characters`);
  return text || null;
};

// A public translation must never reveal an unlisted, private, unpublished or
// followers-only sibling. Use this same scope for posts and their rating totals.
export function feedbackWorldIds(worldId: string, actor?: FeedbackActor) {
  return sql`SELECT fw.id FROM worlds fw WHERE
    (fw.id = ${worldId} OR (fw.visibility <> 'unlisted' AND fw.language_group_id IS NOT NULL
      AND fw.language_group_id = (SELECT language_group_id FROM worlds WHERE id = ${worldId})))
    AND (fw.creator_id = ${actor?.id ?? ""} OR ${actor?.role === "admin"} OR
      (fw.status = 'published' AND (fw.visibility IN ('public','unlisted') OR
        (fw.visibility = 'followers' AND EXISTS (SELECT 1 FROM follows f
          WHERE f.follower_id = ${actor?.id ?? ""} AND f.following_id = fw.creator_id)))))
    AND (${!!actor && !actor.limitedContentOnly} OR COALESCE(fw.age_rating,'all') = 'all')`;
}

export const reviewPreviewText = sql<string | null>`CASE
  WHEN ${reviews.content} ~ '[^[:space:]]' THEN ${reviews.content}
  ELSE (SELECT u->>'content' FROM jsonb_array_elements(${reviews.reviewUpdates}) WITH ORDINALITY AS entry(u, position)
    WHERE u->>'content' ~ '[^[:space:]]' ORDER BY position LIMIT 1)
END`;

// Votes count toward the summary even when they have no written feedback.
export const visibleFeedbackPost = sql<boolean>`(
  ${reviews.kind} <> 'review'
  OR (${reviewPreviewText}) IS NOT NULL
  OR EXISTS (SELECT 1 FROM review_replies rr WHERE rr.review_id = ${reviews.id} AND rr.deleted_at IS NULL)
)`;

export function createWorldFeedbackService(database: Database, dependencies: {
  hasPlayed: (actorId: string, worldId: string, gamePath: string | null) => Promise<boolean>;
  playtime?: (actorId: string, worldId: string, gamePath: string | null) => Promise<number>;
  isBlocked: (actorId: string, otherId: string) => Promise<boolean>;
}) {
  async function world(rd: Reader, worldId: string, actor?: FeedbackActor) {
    const [w] = await rd.select({ id: worlds.id, creatorId: worlds.creatorId, languageGroupId: worlds.languageGroupId,
      status: worlds.status, visibility: worlds.visibility, ageRating: worlds.ageRating,
      allowReviews: worlds.allowReviews, gamePath: worlds.gamePath, name: worlds.name }).from(worlds).where(eq(worlds.id, worldId));
    if (!w) return fail(404, "World not found");
    if ((!actor || actor.limitedContentOnly) && (w.ageRating ?? "all") !== "all") return fail(404, "World not found");
    const privileged = actor?.id === w.creatorId || actor?.role === "admin";
    if (!privileged && w.status !== "published") return fail(404, "World not found");
    if (!privileged && w.visibility !== "public" && w.visibility !== "unlisted") {
      if (w.visibility !== "followers" || !actor) return fail(404, "World not found");
      const [follow] = await rd.select({ id: follows.id }).from(follows).where(and(eq(follows.followerId, actor.id), eq(follows.followingId, w.creatorId))).limit(1);
      if (!follow) return fail(404, "World not found");
    }
    return w;
  }
  const scope = (worldId: string, actor?: FeedbackActor) => sql`${reviews.worldId} IN (${feedbackWorldIds(worldId, actor)})`;
  async function entry(rd: Reader, worldId: string, id: string, actor?: FeedbackActor) {
    await world(rd, worldId, actor);
    const [row] = await rd.select().from(reviews).where(and(eq(reviews.id, id), scope(worldId, actor))).limit(1);
    if (!row) return fail(404, "Post not found");
    await world(rd, row.worldId, actor);
    return row;
  }
  async function interact(actor: FeedbackActor, ...ids: string[]) {
    for (const id of new Set(ids)) if (id !== actor.id && await dependencies.isBlocked(actor.id, id)) fail(403, "Interaction unavailable between these accounts");
  }
  async function locked<T>(worldId: string, actor: FeedbackActor, fn: (tx: Transaction) => Promise<T>) {
    return database.transaction(async tx => {
      const w = await world(tx, worldId, actor);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`world-feedback:${w.languageGroupId ?? w.id}`}))`);
      return fn(tx);
    });
  }
  async function refreshRatingTotals(tx: Transaction, ids: ReturnType<typeof feedbackWorldIds>) {
    await tx.execute(sql`UPDATE worlds w SET review_count = (SELECT count(*)::int FROM world_ratings r WHERE r.world_id = w.id),
      average_rating = (SELECT COALESCE(avg(r.rating), 0)::real FROM world_ratings r WHERE r.world_id = w.id) WHERE w.id IN (${ids})`);
  }
  async function updateTarget(rd: Reader, worldId: string, actor: FeedbackActor) {
    const [row] = await rd.select({ ...getTableColumns(reviews), listed: visibleFeedbackPost }).from(reviews).where(and(scope(worldId, actor), eq(reviews.userId, actor.id),
      eq(reviews.kind, "review"), sql`${reviews.rating} IS NOT NULL`, isNull(reviews.deletedAt), isNull(reviews.supersededByReviewId)))
      .orderBy(sql`CASE WHEN NOT ${reviews.legacyFeedback} AND ${reviews.id} NOT LIKE 'feedback-vote-v4-%' THEN 0
        WHEN ${reviews.content} IS NOT NULL THEN 1 ELSE 2 END`, desc(reviews.updatedAt), desc(reviews.createdAt), desc(reviews.id)).limit(1);
    return row;
  }
  async function removeActiveVote(tx: Transaction, row: typeof reviews.$inferSelect) {
    // Historical stars are snapshots, not vote owners. Never reconstruct a
    // withdrawn vote from another historical comment after deletion or a move.
    if (row.legacyFeedback) return;
    await tx.delete(worldRatings).where(and(eq(worldRatings.userId, row.userId), eq(worldRatings.worldId, row.worldId)));
    await refreshRatingTotals(tx, sql`SELECT id FROM worlds WHERE id = ${row.worldId}`);
  }
  async function audit(tx: Transaction, actor: FeedbackActor, id: string, action: string, reason: string, metadata = {}) {
    await tx.insert(adminActions).values({ adminId: actor.id, actionType: action, targetType: "world_feedback", targetId: id, metadata: { reason, ...metadata } });
  }
  async function commentOwner(rd: Reader, worldId: string, id: string, actor?: FeedbackActor) {
    let row = await entry(rd, worldId, id, actor);
    if (row.linkedReviewId) row = await entry(rd, worldId, row.linkedReviewId, actor);
    if (row.supersededByReviewId) row = await entry(rd, worldId, row.supersededByReviewId, actor);
    return row;
  }
  function editable(createdAt: Date | null) {
    if (!createdAt || Date.now() - createdAt.getTime() >= 180_000) fail(409, "The 3-minute editing window has ended");
  }
  async function rateable(tx: Transaction, row: { userId: string; worldId: string }, rating: number, reasons: unknown, content: string | null, existing: string | null) {
    const w = await world(tx, row.worldId, { id: row.userId });
    if (w.creatorId === row.userId) fail(403, "Creators cannot rate their own world");
    if (!w.allowReviews) fail(403, "Reviews are closed for this world");
    if (!await dependencies.hasPlayed(row.userId, row.worldId, w.gamePath)) fail(403, "Play this card before rating it");
    const low = checkLowRating({ rating, reasons, content, existingLowReason: existing });
    if (!low.ok) return fail(400, low.error);
    return low.lowReason;
  }
  return {
    world: (worldId: string, actor?: FeedbackActor) => world(database, worldId, actor),
    async list(worldId: string, kind: FeedbackKind, actor?: FeedbackActor, offset = 0, hiddenUserIds: string[] = [], postId?: string) {
      await world(database, worldId, actor);
      const accessible = scope(worldId, actor);
      const ownTarget = actor && kind === "review" ? await updateTarget(database, worldId, actor) : undefined;
      const rows = await database.select({ id: reviews.id, worldId: reviews.worldId, userId: reviews.userId, rating: reviews.rating,
        playtimeAtReviewSeconds: reviews.playtimeAtReviewSeconds, legacyFeedback: reviews.legacyFeedback,
        reason: reviews.reason, content: reviews.content, title: reviews.title, reviewUpdates: reviews.reviewUpdates, kind: reviews.kind, linkedReviewId: reviews.linkedReviewId,
        deletedAt: reviews.deletedAt, createdAt: reviews.createdAt, updatedAt: reviews.updatedAt, replyCount: reviews.replyCount,
        movedAt: reviews.movedAt, movedFrom: reviews.movedFrom, moveReason: reviews.moveReason,
        ratingRequested: reviews.ratingRequested, archivedRating: reviews.archivedRating,
        userName: user.name, userImage: user.image, userUsername: user.username,
      }).from(reviews).innerJoin(user, eq(reviews.userId, user.id)).where(and(eq(reviews.kind, kind), visibleFeedbackPost,
        isNull(reviews.linkedReviewId), isNull(reviews.supersededByReviewId),
        sql`(${reviews.deletedAt} IS NULL OR EXISTS (SELECT 1 FROM review_replies rr WHERE rr.review_id=${reviews.id}))`,
        postId ? eq(reviews.id, postId) : sql`TRUE`,
        hiddenUserIds.length ? sql`${reviews.userId} NOT IN (${sql.join(hiddenUserIds.map(id => sql`${id}`), sql`, `)})` : sql`TRUE`,
        // Never leak a private/unpublished sibling's posts through a public variant.
        accessible
      )).orderBy(desc(reviews.createdAt), desc(reviews.id)).limit(30).offset(offset);
      const sourceIds = rows.flatMap(row => row.linkedReviewId ? [row.linkedReviewId] : []);
      const sourceFields = { id: reviews.id, kind: reviews.kind, deletedAt: reviews.deletedAt, content: reviews.content, userId: reviews.userId, supersededByReviewId: reviews.supersededByReviewId };
      const originals = sourceIds.length ? await database.select(sourceFields)
        .from(reviews).where(and(inArray(reviews.id, sourceIds), accessible)) : [];
      const canonicalIds = originals.flatMap(row => row.supersededByReviewId ? [row.supersededByReviewId] : []);
      const canonical = canonicalIds.length ? await database.select(sourceFields).from(reviews).where(and(inArray(reviews.id, canonicalIds), accessible)) : [];
      const canonicalById = new Map(canonical.map(row => [row.id, row]));
      const sources = new Map(originals.map(row => [row.id, row.supersededByReviewId ? canonicalById.get(row.supersededByReviewId) : row]));
      return rows.map(({ archivedRating, ...row }) => {
        const original = row.linkedReviewId ? sources.get(row.linkedReviewId) : undefined;
        const source = original ? { id: original.id, kind: original.kind, deleted: !!original.deletedAt,
          content: original.deletedAt || hiddenUserIds.includes(original.userId) ? null : original.content } : null;
        return { ...row, discussionUpdates: !row.deletedAt && kind === "discussion" ? row.reviewUpdates.map(({ id, content, createdAt }) => ({ id, content, createdAt })) : [], reviewUpdates: row.deletedAt || kind !== "review" ? [] : row.reviewUpdates, title: row.deletedAt ? null : row.title, rating: row.deletedAt ? null : row.rating, content: row.deletedAt ? null : row.content, reason: kind === "review" ? row.reason : null,
          source, canUpdate: ownTarget?.id === row.id, canMoveToReview: actor?.role === "admin" && (archivedRating !== null || row.legacyFeedback) && row.movedFrom === "review" && !row.linkedReviewId && !row.deletedAt };
      });
    },
    async location(worldId: string, id: string, actor?: FeedbackActor, replyId?: string) {
      const row = await commentOwner(database, worldId, id, actor);
      if (replyId) {
        const [reply] = await database.select().from(reviewReplies).where(eq(reviewReplies.id, replyId));
        if (reply && reply.reviewId === row.id) return { id: row.id, kind: row.kind };
      }
      return { id: row.id, kind: row.kind };
    },
    async ownReview(worldId: string, actor: FeedbackActor) {
      await world(database, worldId, actor);
      const row = await updateTarget(database, worldId, actor);
      return row ? { id: row.id, content: row.content, rating: row.rating, reason: row.reason, legacyFeedback: row.legacyFeedback, listed: row.listed, canUpdate: true } : null;
    },
    saveReview(worldId: string, actor: FeedbackActor, input: { clientId?: unknown; rating?: unknown; content?: unknown; reasons?: unknown }) {
      const clientId = clientIdValue(input.clientId);
      const rating = ratingValue(input.rating);
      const content = textValue(input.content, 5000);
      return locked(worldId, actor, async tx => {
        const w = await world(tx, worldId, actor);
        await interact(actor, w.creatorId);
        const previous = await updateTarget(tx, worldId, actor);
        if (clientId && (previous?.id === clientId || previous?.reviewUpdates.some(update => update.id === clientId))) return previous!;
        const reason = await rateable(tx, { userId: actor.id, worldId }, rating, input.reasons, content, previous?.reason ?? null);
        const playtimeAtReviewSeconds = previous ? previous.playtimeAtReviewSeconds
          : dependencies.playtime ? Math.max(0, Math.floor(await dependencies.playtime(actor.id, worldId, w.gamePath))) : null;
        const now = new Date();
        if (previous && !previous.legacyFeedback && !content && previous.rating === rating && previous.reason === reason) return previous;
        const values = { rating, reason, legacyFeedback: false, playtimeAtReviewSeconds, updatedAt: now,
          ...(previous ? { reviewUpdates: [...previous.reviewUpdates.map((update, index) => ({ ...update,
            // Older updates did not snapshot reasons. Keep the last known tags with
            // that update before appending another one; don't invent earlier tags.
            reasonBefore: update.reasonBefore ?? null,
            reasonAfter: update.reasonAfter !== undefined ? update.reasonAfter : index === previous.reviewUpdates.length - 1 ? previous.reason : null,
          })), { id: clientId ?? crypto.randomUUID(), content, createdAt: now.toISOString(), ratingBefore: previous.rating!, ratingAfter: rating,
            reasonBefore: previous.reason, reasonAfter: reason }] } : { content }) };
        // Only an explicit new rating consolidates historical standalone votes.
        // Preserve other owner rows as readable history before activating this one.
        await tx.update(reviews).set({ legacyFeedback: true }).where(and(scope(worldId, actor), eq(reviews.userId, actor.id),
          eq(reviews.kind, "review"), eq(reviews.legacyFeedback, false), previous ? sql`${reviews.id} <> ${previous.id}` : sql`TRUE`));
        const [saved] = previous
          ? await tx.update(reviews).set(values).where(eq(reviews.id, previous.id)).returning()
          : await tx.insert(reviews).values({ ...values, ...(clientId ? { id: clientId } : {}), worldId, userId: actor.id, kind: "review" }).returning();
        if (!previous) await tx.delete(contentTranslations).where(and(eq(contentTranslations.sourceId, saved!.id), eq(contentTranslations.sourceType, "review")));
        const group = feedbackWorldIds(worldId, actor);
        await tx.delete(worldRatings).where(and(eq(worldRatings.userId, actor.id), sql`${worldRatings.worldId} IN (${group})`));
        await tx.insert(worldRatings).values({ userId: actor.id, worldId: saved!.worldId, rating, lowReason: reason });
        await refreshRatingTotals(tx, group);
        return saved!;
      });
    },
    createDiscussion(worldId: string, actor: FeedbackActor, input: { clientId?: unknown; title?: unknown; content?: unknown; rating?: unknown }) {
      if (input.rating != null) fail(400, "Discussions cannot have a rating");
      const content = textValue(input.content, 5000, true);
      const title = textValue(input.title, 120, true);
      const clientId = clientIdValue(input.clientId);
      return locked(worldId, actor, async tx => {
        const w = await world(tx, worldId, actor); await interact(actor, w.creatorId);
        if (clientId) {
          const [existing] = await tx.select().from(reviews).where(eq(reviews.id, clientId));
          if (existing) {
            if (existing.userId !== actor.id || existing.worldId !== worldId || existing.kind !== "discussion") fail(409, "Submission ID is already in use");
            return existing;
          }
        }
        const [row] = await tx.insert(reviews).values({ ...(clientId ? { id: clientId } : {}), worldId, userId: actor.id, title, content, kind: "discussion", rating: null }).returning();
        return row!;
      });
    },
    discuss(worldId: string, id: string, actor: FeedbackActor) {
      return locked(worldId, actor, async tx => {
        const row = await entry(tx, worldId, id, actor);
        if (row.kind !== "review" || row.deletedAt || row.supersededByReviewId) fail(409, "This review is no longer available");
        const w = await world(tx, row.worldId, actor); await interact(actor, w.creatorId, row.userId);
        return row;
      });
    },
    remove(worldId: string, id: string, actor: FeedbackActor, rawReason?: unknown) {
      return locked(worldId, actor, async tx => {
        const row = await entry(tx, worldId, id, actor);
        if (row.userId !== actor.id && actor.role !== "admin") fail(403, "You can only delete your own posts");
        const reason = actor.id !== row.userId ? textValue(rawReason, 500, true)! : "Author deleted post";
        if (row.deletedAt) return row;

        await tx.update(reviews).set({ content: null, title: null, reviewUpdates: [], reason: null, archivedRating: null, ratingRequested: false, deletedAt: new Date() }).where(eq(reviews.id, id));
        await tx.delete(contentTranslations).where(and(eq(contentTranslations.sourceId, id), eq(contentTranslations.sourceType, "review")));
        await tx.execute(sql`UPDATE notifications SET payload = payload - 'commentContent' - 'reviewContent' WHERE type IN ('new_review','new_comment') AND payload->>'reviewId' = ${id}`);
        const replies = await tx.select({ id: reviewReplies.id, userId: reviewReplies.userId }).from(reviewReplies).where(eq(reviewReplies.reviewId, id));
        if (!replies.some(reply => reply.userId !== row.userId)) {
          if (replies.length) {
            const ids = replies.map(reply => reply.id);
            await tx.delete(contentTranslations).where(and(eq(contentTranslations.sourceType, "review_reply"), inArray(contentTranslations.sourceId, ids)));
            await tx.execute(sql`DELETE FROM notifications WHERE type='new_review_reply' AND payload->>'replyId' IN (${sql.join(ids.map(value => sql`${value}`), sql`, `)})`);
            await tx.delete(reviewReplies).where(eq(reviewReplies.reviewId, id));
          }
          await tx.delete(reviews).where(eq(reviews.linkedReviewId, id));
          await tx.delete(reviews).where(eq(reviews.id, id));
        }
        if (row.kind === "review") await removeActiveVote(tx, row);
        if (actor.role === "admin") await audit(tx, actor, id, "feedback_deleted", reason);
        return row;
      });
    },
    move(worldId: string, id: string, actor: FeedbackActor, destination: unknown, rawReason: unknown) {
      if (actor.role !== "admin") fail(403, "Only admins can move posts");
      if (destination !== "review" && destination !== "discussion") fail(400, "Invalid destination");
      const reason = textValue(rawReason, 500, true)!;
      return locked(worldId, actor, async tx => {
        const row = await entry(tx, worldId, id, actor);
        if (row.deletedAt || row.linkedReviewId || row.supersededByReviewId) fail(409, "Deleted posts and linked conversation containers cannot be moved");
        if (row.kind === destination) return row;
        if (destination === "review") {
          if ((!row.legacyFeedback && row.archivedRating === null) || row.movedFrom !== "review") fail(409, "Only a previously rated review can be moved back to Reviews");
          const [existing] = await tx.select({ id: reviews.id }).from(reviews).where(and(scope(worldId, actor), eq(reviews.legacyFeedback, false), eq(reviews.userId, row.userId), eq(reviews.kind, "review"), isNull(reviews.deletedAt), isNull(reviews.supersededByReviewId))).limit(1);
          if (existing && !row.legacyFeedback) fail(409, "The author already has a review; it will not be overwritten");
          const w = await world(tx, row.worldId, actor);
          if (!w.allowReviews || w.creatorId === row.userId) fail(403, "This author cannot review this world");

        }
        const playtimeAtReviewSeconds = destination === "review" && row.movedFrom !== "review" && row.playtimeAtReviewSeconds === null && dependencies.playtime
          ? Math.max(0, Math.floor(await dependencies.playtime(row.userId, row.worldId, (await world(tx, row.worldId, actor)).gamePath)))
          : row.playtimeAtReviewSeconds;
        const [moved] = await tx.update(reviews).set({ playtimeAtReviewSeconds, kind: destination as FeedbackKind,
          rating: destination === "review" ? row.archivedRating : null,
          archivedRating: destination === "discussion" ? row.rating : null,
          movedAt: new Date(), movedFrom: row.kind, moveReason: reason, updatedAt: new Date(), ratingRequested: false,
        }).where(eq(reviews.id, id)).returning();
        if (!row.legacyFeedback) {
          if (destination === "discussion") await removeActiveVote(tx, row);
          else {
            await tx.insert(worldRatings).values({ userId: row.userId, worldId: row.worldId, rating: row.archivedRating!, lowReason: row.reason });
            await refreshRatingTotals(tx, sql`SELECT id FROM worlds WHERE id = ${row.worldId}`);
          }
        }
        await audit(tx, actor, id, "feedback_moved", reason, { from: row.kind, to: destination });
        return moved!;
      });
    },
    async replies(worldId: string, id: string, actor?: FeedbackActor, offset = 0, hiddenUserIds: string[] = [], replyId?: string) {
      const row = await commentOwner(database, worldId, id, actor);
      id = row.id;
      return database.select({ id: reviewReplies.id, userId: reviewReplies.userId, content: reviewReplies.content,
        deletedAt: reviewReplies.deletedAt, replyToReplyId: reviewReplies.replyToReplyId, createdAt: reviewReplies.createdAt, updatedAt: reviewReplies.updatedAt,
        userName: user.name, userImage: user.image, userUsername: user.username,
        replyToUserName: sql<string | null>`(SELECT u.name FROM review_replies p JOIN "user" u ON u.id = p.user_id WHERE p.id = ${reviewReplies.replyToReplyId})`,
      }).from(reviewReplies).innerJoin(user, eq(reviewReplies.userId, user.id)).where(and(eq(reviewReplies.reviewId, id),
        hiddenUserIds.length ? sql`${reviewReplies.userId} NOT IN (${sql.join(hiddenUserIds.map(value => sql`${value}`), sql`, `)})` : sql`TRUE`,
        replyId ? eq(reviewReplies.id, replyId) : sql`TRUE`)).orderBy(asc(reviewReplies.createdAt), asc(reviewReplies.id)).limit(20).offset(offset);
    },
    reply(worldId: string, id: string, actor: FeedbackActor, input: { clientId?: unknown; content?: unknown; replyToReplyId?: unknown }) {
      const content = textValue(input.content, 2000, true)!;
      const clientId = clientIdValue(input.clientId);
      return locked(worldId, actor, async tx => {
        const row = await commentOwner(tx, worldId, id, actor);
        id = row.id;
        if (clientId) {
          const [existing] = await tx.select().from(reviewReplies).where(eq(reviewReplies.id, clientId));
          if (existing) {
            if (existing.userId !== actor.id || existing.reviewId !== row.id) fail(409, "Submission ID is already in use");
            return { reply: existing, kind: row.kind, postId: row.id, recipients: [] };
          }
        }
        const w = await world(tx, row.worldId, actor);
        const recipients = [w.creatorId, row.userId];
        const parentId = typeof input.replyToReplyId === "string" ? input.replyToReplyId : null;
        if (parentId) {
          const [parent] = await tx.select().from(reviewReplies).where(and(eq(reviewReplies.id, parentId), eq(reviewReplies.reviewId, id)));
          if (!parent || parent.deletedAt) fail(400, "Reply target is not available in this discussion");
          recipients.push(parent!.userId);
        }
        await interact(actor, ...recipients);
        const [reply] = await tx.insert(reviewReplies).values({ ...(clientId ? { id: clientId } : {}), reviewId: id, userId: actor.id, content, replyToReplyId: parentId }).returning();
        await tx.update(reviews).set({ replyCount: sql`${reviews.replyCount} + 1` }).where(eq(reviews.id, id));
        return { reply: reply!, kind: row.kind, postId: row.id, recipients: [...new Set(recipients)].filter(recipient => recipient !== actor.id) };
      });
    },
    editDiscussion(worldId: string, id: string, actor: FeedbackActor, input: { title?: unknown; content?: unknown; rating?: unknown }) {
      if (input.rating !== undefined) fail(400, "Discussions cannot have a rating");
      const title = textValue(input.title, 120, true), content = textValue(input.content, 5000, true);
      return locked(worldId, actor, async tx => {
        const row = await entry(tx, worldId, id, actor);
        if (row.userId !== actor.id) fail(403, "You can only edit your own posts");
        if (row.kind !== "discussion" || row.deletedAt || row.linkedReviewId) fail(409, "This post cannot be edited");
        editable(row.createdAt);
        await interact(actor, (await world(tx, row.worldId, actor)).creatorId);
        await tx.update(reviews).set({ title, content, updatedAt: new Date() }).where(eq(reviews.id, id));
        await tx.delete(contentTranslations).where(and(eq(contentTranslations.sourceId, id), eq(contentTranslations.sourceType, "review")));
      });
    },
    editReply(worldId: string, id: string, replyId: string, actor: FeedbackActor, input: { content?: unknown }) {
      const content = textValue(input.content, 2000, true)!;
      return locked(worldId, actor, async tx => {
        const row = await commentOwner(tx, worldId, id, actor);
        const [reply] = await tx.select().from(reviewReplies).where(and(eq(reviewReplies.id, replyId), eq(reviewReplies.reviewId, row.id)));
        if (!reply || reply.deletedAt) return fail(404, "Reply not found");
        if (reply.userId !== actor.id) fail(403, "You can only edit your own comments");
        editable(reply.createdAt);
        await interact(actor, row.userId, (await world(tx, row.worldId, actor)).creatorId);
        await tx.update(reviewReplies).set({ content, updatedAt: new Date() }).where(eq(reviewReplies.id, replyId));
        await tx.delete(contentTranslations).where(and(eq(contentTranslations.sourceId, replyId), eq(contentTranslations.sourceType, "review_reply")));
      });
    },
    removeReply(worldId: string, id: string, replyId: string, actor: FeedbackActor, rawReason?: unknown) {
      return locked(worldId, actor, async tx => {
        const row = await commentOwner(tx, worldId, id, actor);
        id = row.id;
        const [reply] = await tx.select().from(reviewReplies).where(and(eq(reviewReplies.id, replyId), eq(reviewReplies.reviewId, id)));
        if (!reply) return fail(404, "Reply not found");
        if (reply.userId !== actor.id && actor.role !== "admin") fail(403, "You can only delete your own replies");
        const reason = reply.userId !== actor.id ? textValue(rawReason, 500, true)! : "Author deleted reply";
        if (reply.deletedAt) return;
        const [child] = await tx.select({ id: reviewReplies.id }).from(reviewReplies).where(eq(reviewReplies.replyToReplyId, replyId)).limit(1);
        if (child) await tx.update(reviewReplies).set({ content: "", deletedAt: new Date() }).where(eq(reviewReplies.id, replyId));
        else await tx.delete(reviewReplies).where(eq(reviewReplies.id, replyId));
        await tx.delete(contentTranslations).where(and(eq(contentTranslations.sourceId, replyId), eq(contentTranslations.sourceType, "review_reply")));
        await tx.execute(sql`UPDATE notifications SET payload = payload - 'replyContent' WHERE type = 'new_review_reply' AND payload->>'replyId' = ${replyId}`);
        await tx.update(reviews).set({ replyCount: sql`GREATEST(${reviews.replyCount} - 1, 0)` }).where(eq(reviews.id, id));
        if (actor.role === "admin") await audit(tx, actor, replyId, "feedback_reply_deleted", reason);
      });
    },
  };
}
