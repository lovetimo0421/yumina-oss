import { Hono } from "hono";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { MAX_VERSION_NOTE_LENGTH } from "@yumina/shared";
import { db, flagWrite, readOwn } from "../db/index.js";
import { user, worlds, worldPendingEdits } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { hasWorldDmShareGrant } from "../lib/dm-world-grant.js";
import { captureAutomaticVersion, lockVersionDraft, lockVersionWorld } from "../lib/world-version-history.js";
import type { AppEnv } from "../lib/types.js";

/**
 * Bringing changes made elsewhere back onto a card the caller owns, instead of
 * every import and every helper's copy landing as yet another project.
 *
 * The apply itself is NOT here: the client loads the card into the editor,
 * swaps in the incoming content and saves through the normal PATCH, so the
 * stale-draft guard and the published-card review hold both still apply.
 * These routes only answer "which of my cards is this?", hand the original
 * author a helper's copy to compare, and take the safety backup first.
 */
export const worldChangeRoutes = new Hono<AppEnv>();

const MAX_MATCHES = 20;

// GET /api/world-changes/import-matches?origin=<worldId>&schemaId=<schema.id>
//
// `origin` is the row id an export stamps into the file — exact. `schemaId` is
// the id inside the card's own definition, which forks and language variants
// share with their original, so it can name several of the caller's cards;
// the client lets them pick. Only the caller's own cards are ever matched:
// a file can't be pointed at someone else's card.
worldChangeRoutes.get("/import-matches", authMiddleware, async (c) => {
  const me = c.get("user").id;
  const origin = (c.req.query("origin") ?? "").trim().slice(0, 100);
  const schemaId = (c.req.query("schemaId") ?? "").trim().slice(0, 200);
  if (!origin && !schemaId) return c.json({ data: [] });

  const conds = [];
  if (origin) conds.push(eq(worlds.id, origin));
  if (schemaId) conds.push(sql`${worlds.schema}->>'id' = ${schemaId}`);

  const rdb = await readOwn(me);
  const rows = await rdb
    .select({
      id: worlds.id,
      name: worlds.name,
      status: worlds.status,
      isPublished: worlds.isPublished,
      thumbnailUrl: worlds.thumbnailUrl,
      language: worlds.language,
      updatedAt: worlds.updatedAt,
      sourceWorldId: worlds.sourceWorldId,
    })
    .from(worlds)
    .where(and(eq(worlds.creatorId, me), or(...conds), sql`coalesce(${worlds.status}, '') <> 'unpublished'`))
    .orderBy(desc(worlds.updatedAt))
    .limit(MAX_MATCHES);

  // Exact origin first, then the published card, then a card that isn't itself
  // a copy (the original over its "(1)"), then most recently touched.
  const data = rows
    .map(({ sourceWorldId, ...r }) => ({ ...r, exact: !!origin && r.id === origin, isCopy: !!sourceWorldId }))
    .sort((a, b) =>
      Number(b.exact) - Number(a.exact)
      || Number(b.status === "published") - Number(a.status === "published")
      || Number(a.isCopy) - Number(b.isCopy)
      || (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0))
    .map(({ isCopy: _isCopy, ...r }) => r);
  c.header("Cache-Control", "no-store");
  return c.json({ data });
});

// GET /api/world-changes/proposals/:forkId
//
// A helper copied the caller's card, changed it, and shared their copy back.
// Give the original author the full content of that copy so they can compare
// and apply it. Allowed only when ALL hold:
//  - the copy's recorded source is a card the caller owns;
//  - the copy belongs to someone else;
//  - its owner sent it to the caller over DM (the same derived grant that
//    lets a recipient copy a shared draft), or it is published anyway.
worldChangeRoutes.get("/proposals/:forkId", authMiddleware, async (c) => {
  const me = c.get("user").id;
  const forkId = c.req.param("forkId");
  const rdb = await readOwn(me);

  const [fork] = await rdb
    .select({
      id: worlds.id,
      name: worlds.name,
      creatorId: worlds.creatorId,
      creatorName: user.name,
      status: worlds.status,
      isPublished: worlds.isPublished,
      sourceWorldId: worlds.sourceWorldId,
      schema: worlds.schema,
      createdAt: worlds.createdAt,
      updatedAt: worlds.updatedAt,
    })
    .from(worlds)
    .leftJoin(user, eq(user.id, worlds.creatorId))
    .where(eq(worlds.id, forkId))
    .limit(1);
  if (!fork || !fork.sourceWorldId || fork.creatorId === me) return c.json({ error: "Not found" }, 404);

  const [target] = await rdb
    .select({ id: worlds.id, name: worlds.name, status: worlds.status, updatedAt: worlds.updatedAt, pendingUpdatedAt: worldPendingEdits.updatedAt })
    .from(worlds)
    .leftJoin(worldPendingEdits, eq(worldPendingEdits.worldId, worlds.id))
    .where(and(eq(worlds.id, fork.sourceWorldId), eq(worlds.creatorId, me)))
    .limit(1);
  if (!target) return c.json({ error: "Not found" }, 404);

  const forkStatus = fork.status ?? (fork.isPublished ? "published" : "draft");
  const allowed = forkStatus === "published"
    || (forkStatus === "draft" && (await hasWorldDmShareGrant(me, fork.id, fork.creatorId)));
  if (!allowed) return c.json({ error: "Not found" }, 404);

  // Did the author keep working on their card after the helper took the copy?
  // Then applying the copy wholesale would also undo that work — the client
  // says so before they confirm. The backup taken on apply covers it either way.
  const targetTouched = [target.updatedAt, target.pendingUpdatedAt]
    .filter((d): d is Date => d instanceof Date)
    .reduce((a, b) => (a > b ? a : b), new Date(0));
  const targetChangedSinceCopy = !!fork.createdAt && targetTouched > fork.createdAt;

  c.header("Cache-Control", "no-store");
  return c.json({
    data: {
      fork: { id: fork.id, name: fork.name, creatorName: fork.creatorName ?? "", createdAt: fork.createdAt, updatedAt: fork.updatedAt },
      target: { id: target.id, name: target.name, status: target.status },
      schema: fork.schema,
      targetChangedSinceCopy,
    },
  });
});

// POST /api/world-changes/backups/:worldId  { note?: string }
//
// Snapshot the card exactly as the server holds it (the held working copy for
// a published card) right before incoming changes are applied, so one click
// in version history undoes the apply. Automatic: it never takes one of the
// creator's ten named save slots.
worldChangeRoutes.post("/backups/:worldId", authMiddleware, async (c) => {
  const me = c.get("user").id;
  const worldId = c.req.param("worldId");
  const body = (await c.req.json().catch(() => ({}))) ?? {};
  const note = typeof body.note === "string" ? body.note.trim().slice(0, MAX_VERSION_NOTE_LENGTH) || null : null;

  const result = await db.transaction(async (tx) => {
    const world = await lockVersionWorld(tx, worldId, me);
    if (!world) return null;
    const draft = world.status === "published" ? await lockVersionDraft(tx, worldId) : null;
    return captureAutomaticVersion(tx, world, "incoming", draft ?? world, [], { note });
  });
  if (!result) return c.json({ error: "World not found" }, 404);
  flagWrite(me);
  return c.json({ data: { versionId: result } }, 201);
});
