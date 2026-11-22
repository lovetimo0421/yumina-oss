import { Hono, type Context, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { eq, inArray, and } from "drizzle-orm";
import type { Database } from "../db/index.js";
import type { AppEnv } from "../lib/types.js";
import { contentTranslations } from "../db/schema.js";
import { createWorldFeedbackService, type FeedbackActor } from "../lib/world-feedback.js";
import { resolveImageCdn } from "../lib/cdn-url.js";
import { detectLang } from "../lib/detect-lang.js";

type Service = ReturnType<typeof createWorldFeedbackService>;
export function createWorldFeedbackRoutes(database: Database, service: Service, deps: {
  auth: MiddlewareHandler<AppEnv>; optionalAuth: MiddlewareHandler<AppEnv>;
  write: MiddlewareHandler<AppEnv>[];
  hiddenUsers: (actorId: string) => Promise<string[]>;
  changed: (actor: FeedbackActor, worldId: string, authorId?: string) => Promise<void>;
  playtimes?: (worldId: string, userIds: string[]) => Promise<Record<string, number>>;
  published?: (actorId: string, worldId: string, postId: string, type: "review" | "review_reply", content: string | null, kind: "review" | "discussion") => Promise<void>;
  notify: (userId: string, payload: Record<string, unknown>) => Promise<void>;
}) {
  const routes = new Hono<AppEnv>();
  async function body(c: Context<AppEnv>) {
    const value = await c.req.json().catch(() => null);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new HTTPException(400, { res: Response.json({ error: "Expected a JSON object" }, { status: 400 }) });
    return value;
  }
  const offset = (value?: string) => /^\d+$/.test(value ?? "0") ? Math.min(Number(value ?? 0), 100000) : 0;
  async function translated<T extends { id: string; content: string | null; userImage: string | null; deletedAt?: Date | null }>(rows: T[], sourceType: string) {
    const ids = rows.filter(r => !r.deletedAt && r.content).map(r => r.id);
    const translations = ids.length ? await database.select().from(contentTranslations)
      .where(and(inArray(contentTranslations.sourceId, ids), eq(contentTranslations.sourceType, sourceType))) : [];
    const byId = new Map<string, Record<string, string | null>>();
    for (const row of translations) byId.set(row.sourceId, { ...byId.get(row.sourceId), [`translatedContent_${row.targetLang}`]: row.translatedContent });
    return rows.map(row => ({ ...row, content: row.deletedAt ? null : row.content,
      userImage: resolveImageCdn(row.userImage), lang: detectLang(row.content ?? ""),
      ...(row.deletedAt ? {} : byId.get(row.id)),
    }));
  }
  async function notify(actor: FeedbackActor, worldId: string, recipients: string[], payload: Record<string, unknown>) {
    const world = await service.world(worldId, actor);
    await Promise.allSettled([...new Set(recipients)].filter(id => id !== actor.id).map(id => deps.notify(id, {
      worldId, worldName: world.name, authorUserId: actor.id, ...payload,
    })));
  }
  routes.get("/:id/reviews", deps.optionalAuth, async c => {
    const actor = c.get("user");
    const rows = await service.list(c.req.param("id")!, "review", actor, offset(c.req.query("offset")), actor ? await deps.hiddenUsers(actor.id) : [], c.req.query("postId"));
    c.header("Cache-Control", "private, no-store");
    const times = deps.playtimes && rows.length ? await deps.playtimes(c.req.param("id")!, [...new Set(rows.map(row => row.userId))]) : {};
    return c.json({ data: await translated(rows.map(row => ({ ...row, playtimeSeconds: times[row.userId] ?? 0 })), "review"), hasMore: rows.length === 30 });
  });
  routes.get("/:id/reviews/mine", deps.auth, async c => {
    c.header("Cache-Control", "private, no-store");
    return c.json({ data: await service.ownReview(c.req.param("id")!, c.get("user")) });
  });
  routes.get("/:id/discussions", deps.optionalAuth, async c => {
    const actor = c.get("user");
    const rows = await service.list(c.req.param("id")!, "discussion", actor, offset(c.req.query("offset")), actor ? await deps.hiddenUsers(actor.id) : [], c.req.query("postId"));
    c.header("Cache-Control", "private, no-store");
    return c.json({ data: await translated(rows, "review"), hasMore: rows.length === 30 });
  });
  routes.get("/:id/feedback/:postId/location", deps.optionalAuth, async c =>
    c.json({ data: await service.location(c.req.param("id")!, c.req.param("postId")!, c.get("user"), c.req.query("replyId")) }));
  for (const path of ["/:id/reviews", "/:id/rating"]) {
    routes.on(path.endsWith("rating") ? "PUT" : "POST", path, deps.auth, ...deps.write, async c => {
      const actor = c.get("user"); const worldId = c.req.param("id")!;
      const row = await service.saveReview(worldId, actor, await body(c));
      await deps.changed(actor, worldId, actor.id);
      void deps.published?.(actor.id, worldId, row.id, "review", row.content, "review").catch(console.error);
      const world = await service.world(worldId, actor);
      await notify(actor, worldId, [world.creatorId], { postId: row.id, kind: "review", action: "review" });
      return c.json({ data: { id: row.id, rating: row.rating, content: row.content } }, 201);
    });
  }
  routes.post("/:id/discussions", deps.auth, ...deps.write, async c => {
    const actor = c.get("user"); const worldId = c.req.param("id")!;
    const row = await service.createDiscussion(worldId, actor, await body(c));
    await deps.changed(actor, worldId);
    void deps.published?.(actor.id, worldId, row.id, "review", row.content, "discussion").catch(console.error);
    const world = await service.world(worldId, actor);
    await notify(actor, worldId, [world.creatorId], { postId: row.id, kind: "discussion", action: "discussion" });
    return c.json({ data: { id: row.id } }, 201);
  });
  routes.post("/:id/reviews/:postId/discussion", deps.auth, ...deps.write, async c => {
    const row = await service.discuss(c.req.param("id")!, c.req.param("postId")!, c.get("user"));
    return c.json({ data: { id: row.id } });
  });
  for (const path of ["/:id/reviews/:postId", "/:id/discussions/:postId"]) {
    routes.delete(path, deps.auth, async c => {
      const actor = c.get("user"); const worldId = c.req.param("id")!;
      const body = await c.req.json().catch(() => ({}));
      const row = await service.remove(worldId, c.req.param("postId")!, actor, body.reason);
      await deps.changed(actor, worldId, row.userId);
      return c.json({ data: { deleted: true } });
    });
  }
  // Retired controls cannot bypass the new permissions through an old client.
  routes.delete("/:id/reviews/:postId/by-creator", deps.auth, c => c.json({ error: "Creators cannot hide posts" }, 403));
  routes.delete("/:id/reviews", deps.auth, c => c.json({ error: "Delete your review using its post ID" }, 409));
  routes.post("/:id/feedback/:postId/move", deps.auth, ...deps.write, async c => {
    const actor = c.get("user"); const worldId = c.req.param("id")!; const input = await body(c);
    // Never accept an admin-supplied rating, even alongside a valid destination.
    if (input.rating !== undefined) return c.json({ error: "Only the author can supply a rating" }, 400);
    const row = await service.move(worldId, c.req.param("postId")!, actor, input.destination, input.reason);
    await deps.changed(actor, worldId, row.userId);
    if (row.kind === "review") void deps.published?.(row.userId, worldId, row.id, "review", row.content, "review").catch(console.error);
    await notify(actor, worldId, [row.userId], { postId: row.id, kind: row.kind, action: "moved", reason: input.reason });
    return c.json({ data: { id: row.id, kind: row.kind } });
  });
  routes.patch("/:id/discussions/:postId", deps.auth, ...deps.write, async c => {
    const actor = c.get("user"), worldId = c.req.param("id")!;
    await service.editDiscussion(worldId, c.req.param("postId")!, actor, await body(c));
    await deps.changed(actor, worldId);
    return c.json({ data: { saved: true } });
  });
  for (const collection of ["reviews", "discussions"]) {
  routes.get(`/:id/${collection}/:postId/replies`, deps.optionalAuth, async c => {
    const actor = c.get("user");
    const hidden = actor ? await deps.hiddenUsers(actor.id) : [];
    const rows = await service.replies(c.req.param("id")!, c.req.param("postId")!, actor, offset(c.req.query("offset")), hidden, c.req.query("replyId"));
    c.header("Cache-Control", "private, no-store");
    return c.json({ data: await translated(rows, "review_reply"), hasMore: rows.length === 20 });
  });
  routes.post(`/:id/${collection}/:postId/replies`, deps.auth, ...deps.write, async c => {
    const actor = c.get("user"); const worldId = c.req.param("id")!; const id = c.req.param("postId")!;
    const result = await service.reply(worldId, id, actor, await body(c));
    await deps.changed(actor, worldId);
    void deps.published?.(actor.id, worldId, result.reply.id, "review_reply", result.reply.content, result.kind).catch(console.error);
    await notify(actor, worldId, result.recipients, { postId: result.postId, replyId: result.reply.id, kind: result.kind, action: "reply" });
    return c.json({ data: { id: result.reply.id } }, 201);
  });
  routes.delete(`/:id/${collection}/:postId/replies/:replyId`, deps.auth, async c => {
    const actor = c.get("user"); const worldId = c.req.param("id")!;
    const body = await c.req.json().catch(() => ({}));
    await service.removeReply(worldId, c.req.param("postId")!, c.req.param("replyId"), actor, body.reason);
    await deps.changed(actor, worldId);
    return c.json({ data: { deleted: true } });
  });
  routes.patch(`/:id/${collection}/:postId/replies/:replyId`, deps.auth, ...deps.write, async c => {
    const actor = c.get("user"), worldId = c.req.param("id")!;
    await service.editReply(worldId, c.req.param("postId")!, c.req.param("replyId"), actor, await body(c));
    await deps.changed(actor, worldId);
    return c.json({ data: { saved: true } });
  });
  }
  return routes;
}
