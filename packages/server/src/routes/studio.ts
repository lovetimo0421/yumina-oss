import { Hono } from "hono";
import { eq, and, desc, asc, inArray } from "drizzle-orm";
import { diffWorldSchemas } from "@yumina/engine";
import type { WorldDefinition } from "@yumina/engine";
import { db, readOwn } from "../db/index.js";
import { worlds, studioConversations, worldSnapshots, playSessions } from "../db/schema.js";
import { summarizeSnapshotTimeline } from "../lib/studio-tools/snapshot-summary.js";
import { authMiddleware } from "../middleware/auth.js";
import type { AppEnv } from "../lib/types.js";
import { readTemplateContent, readTemplateMeta } from "../lib/studio-tools/index.js";
import { getTemplateCatalogSummary } from "../lib/studio-skills/index.js";
import { isS3Configured, generateUploadUrl, getObjectBuffer, deleteObject } from "../lib/s3.js";
import { resolveImageCdn } from "../lib/cdn-url.js";
import {
  deleteStudioConversationForWorld,
  loadStudioConversationForDisplay,
  updateStudioConversationForWorld,
} from "../lib/studio-conversations.js";
import { restoreStudioSnapshot } from "../lib/world-versioning.js";
import { SourceLimitError, addSource, listSources, removeSource, sourceIncomingPrefix } from "../lib/studio-sources.js";
import { BIBLE_SUFFIX, readDigestStatus, stopDigests } from "../lib/studio-source-digest.js";

const studioRoutes = new Hono<AppEnv>();

studioRoutes.use("/*", authMiddleware);

// POST /api/studio/upload-url — get presigned URL for studio chat file attachment
const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

studioRoutes.post("/upload-url", async (c) => {
  if (!isS3Configured()) {
    return c.json({ error: "File storage not configured" }, 503);
  }

  const currentUser = c.get("user");
  const body = await c.req.json<{
    filename: string;
    contentType: string;
    fileSize: number;
  }>();

  if (!ALLOWED_IMAGE_TYPES.includes(body.contentType)) {
    return c.json({ error: `Unsupported file type. Allowed: ${ALLOWED_IMAGE_TYPES.join(", ")}` }, 400);
  }

  if (body.fileSize > MAX_FILE_SIZE) {
    return c.json({ error: `File too large. Maximum size: ${MAX_FILE_SIZE / 1024 / 1024}MB` }, 400);
  }

  const ext = body.filename.split(".").pop() ?? "png";
  const key = `studio-chat/${currentUser.id}/${crypto.randomUUID()}.${ext}`;

  const uploadUrl = await generateUploadUrl(key, body.contentType);

  return c.json({
    data: {
      uploadUrl,
      key,
    },
  });
});

// POST /api/studio/download-url — get presigned download URL for a studio chat attachment
studioRoutes.post("/download-url", async (c) => {
  if (!isS3Configured()) {
    return c.json({ error: "File storage not configured" }, 503);
  }

  const currentUser = c.get("user");
  const body = await c.req.json<{ key: string }>();

  // Validate ownership: only allow keys belonging to this user's studio-chat prefix
  if (!body.key.startsWith(`studio-chat/${currentUser.id}/`)) {
    return c.json({ error: "Invalid asset key" }, 403);
  }

  const url = resolveImageCdn(body.key) ?? body.key;

  return c.json({ data: { url } });
});

// NOTE: /api/studio/playtest (lightweight LLM proxy for ephemeral playtest) was
// deleted when Studio playtest was unified with the real-play pipeline. Playtest
// now creates a real session (with name=__playtest__ sentinel to hide it from
// the session list) and uses /api/messages exactly like a normal chat — this
// eliminates the drift that caused missing BGM / persona / audio-effects in
// playtest. See packages/app/src/features/studio/panels/playtest-panel.tsx.

// ── Access ──

/** Who may open the blueprint. `BLUEPRINT_ACCESS` = `all` (default) | `admins`
 *  | `off`. The blueprint is an experimental entry inside the classic editor;
 *  this is the switch that narrows or closes it without a deploy. */
export function blueprintAccessFor(role: string | undefined, setting = process.env.BLUEPRINT_ACCESS): boolean {
  const mode = (setting ?? "all").trim().toLowerCase();
  if (mode === "off") return false;
  if (mode === "admins") return role === "admin";
  return true;
}

// GET /api/studio/access — may this account open the blueprint?
studioRoutes.get("/access", (c) => {
  const user = c.get("user");
  return c.json({ data: { blueprint: blueprintAccessFor(user.role) } });
});

// ── Template API ──

// GET /api/studio/templates — List all available templates
studioRoutes.get("/templates/list", async (c) => {
  const summary = getTemplateCatalogSummary();
  return c.json({ data: { summary } });
});

// GET /api/studio/templates/:id — Get template metadata + content
studioRoutes.get("/templates/:templateId", async (c) => {
  const templateId = c.req.param("templateId");

  const meta = readTemplateMeta(templateId);
  if (!meta) {
    return c.json({ error: `Template not found: ${templateId}` }, 404);
  }

  const content = readTemplateContent(templateId);

  return c.json({
    data: {
      id: templateId,
      meta,
      content,
    },
  });
});

// ── Conversation Persistence ──

// GET /api/studio/:worldId/conversations — List conversations
studioRoutes.get("/:worldId/conversations", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");

  const rows = await db
    .select({
      id: studioConversations.id,
      title: studioConversations.title,
      createdAt: studioConversations.createdAt,
      updatedAt: studioConversations.updatedAt,
    })
    .from(studioConversations)
    .where(
      and(
        eq(studioConversations.worldId, worldId),
        eq(studioConversations.userId, currentUser.id)
      )
    )
    .orderBy(desc(studioConversations.updatedAt));

  return c.json({ data: rows });
});

/**
 * GET /api/studio/:worldId/station-activity — what the card's stations have
 * actually done, from the creator's most recent session on it.
 *
 * Without this the whole feature is invisible after it runs: a creator sets up
 * a chronicler, plays, comes back, and has no way to tell whether it wrote
 * anything, wrote nothing, or was never woken. The failure mode of a
 * background AI is silence, and silence needs a place to be read.
 *
 * Their OWN latest session only — this is a debugging window onto the
 * creator's own play, not a view of anyone else's.
 */
studioRoutes.get("/:worldId/station-activity", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");

  const readDb = await readOwn(currentUser.id);
  const [session] = await readDb
    .select({
      id: playSessions.id,
      updatedAt: playSessions.updatedAt,
      runMemories: playSessions.runMemories,
    })
    .from(playSessions)
    .where(and(eq(playSessions.worldId, worldId), eq(playSessions.userId, currentUser.id)))
    .orderBy(desc(playSessions.updatedAt))
    .limit(1);

  if (!session) return c.json({ data: { sessionId: null, at: null, runs: [], workers: [] } });

  const memories = (session.runMemories ?? {}) as {
    open?: Record<string, { fromAt: string; runIndex: number }>;
    closed?: Array<{ bookId: string; runIndex: number; closedAt: string; summary?: string; summaryStatus: string }>;
    workers?: Array<{ bookId: string; index: number; at: string; text?: string; status: string; cause?: string }>;
  };

  // Newest first, and capped: this is a glance, not an archive browser.
  const runs = [...(memories.closed ?? [])].slice(-20).reverse();
  const workers = [...(memories.workers ?? [])].slice(-20).reverse();
  // A run only reaches `closed` when the module lets go, and a keyword module
  // holds the floor until something else takes it. Reading `closed` alone told
  // an author who had just watched their station narrate that nothing from it
  // had run at all - the exact silence this panel exists to break.
  const open = Object.entries(memories.open ?? {})
    .filter(([, run]) => run && typeof run.fromAt === "string")
    .map(([bookId, run]) => ({ bookId, runIndex: run.runIndex, fromAt: run.fromAt }));

  return c.json({
    data: { sessionId: session.id, at: session.updatedAt, open, runs, workers },
  });
});

// POST /api/studio/:worldId/conversations — Create a new conversation
studioRoutes.post("/:worldId/conversations", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const body = await c.req.json<{ title?: string }>().catch(() => ({}));

  // Verify ownership — a conversation may only be opened on the caller's own world.
  const worldRows = await db
    .select({ id: worlds.id })
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id)));
  if (worldRows.length === 0) return c.json({ error: "World not found" }, 404);

  const [row] = await db
    .insert(studioConversations)
    .values({
      worldId,
      userId: currentUser.id,
      title: (body as { title?: string }).title ?? "New Conversation",
      messages: [],
    })
    .returning();

  return c.json({ data: row });
});

// GET /api/studio/:worldId/conversations/:id — Get a conversation with messages
studioRoutes.get("/:worldId/conversations/:convId", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const convId = c.req.param("convId");

  const conversation = await loadStudioConversationForDisplay({
    userId: currentUser.id,
    worldId,
    conversationId: convId,
  });

  if (!conversation) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  return c.json({ data: conversation });
});

// PATCH /api/studio/:worldId/conversations/:id — Update (save messages)
studioRoutes.patch("/:worldId/conversations/:convId", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const convId = c.req.param("convId");
  const body = await c.req.json<{
    title?: string;
    messages?: Array<Record<string, unknown>>;
  }>();

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.title !== undefined) updates.title = body.title;
  if (body.messages !== undefined) updates.messages = body.messages;

  const patched = await updateStudioConversationForWorld({
    userId: currentUser.id,
    worldId,
    conversationId: convId,
    updates,
  });

  if (!patched) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  return c.json({ ok: true });
});

// DELETE /api/studio/:worldId/conversations/:id — Delete a conversation
studioRoutes.delete("/:worldId/conversations/:convId", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const convId = c.req.param("convId");

  const deleted = await deleteStudioConversationForWorld({
    userId: currentUser.id,
    worldId,
    conversationId: convId,
  });

  if (!deleted) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  return c.json({ ok: true });
});

// ── Source texts (a fan-work's novel, kept beside the card) ──
// See lib/studio-sources.ts. The assistant reads them with search_source /
// read_source; the creator only uploads, lists and removes.

const MAX_SOURCE_BYTES = 40 * 1024 * 1024;

async function ownsWorld(userId: string, worldId: string): Promise<boolean> {
  const rd = await readOwn(userId);
  const [row] = await rd
    .select({ id: worlds.id })
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, userId)))
    .limit(1);
  return Boolean(row);
}

const publicSource = (s: { id: string; name: string; chars: number; chapters: unknown[]; createdAt: string }) =>
  ({ id: s.id, name: s.name, chars: s.chars, chapters: s.chapters.length, createdAt: s.createdAt });

// GET /api/studio/:worldId/sources
studioRoutes.get("/:worldId/sources", async (c) => {
  const userId = c.get("user").id;
  const worldId = c.req.param("worldId");
  if (!(await ownsWorld(userId, worldId))) return c.json({ error: "World not found" }, 404);
  const sources = await listSources(userId, worldId);
  // A digest in progress rides along, so the chip shows it after a reload too.
  // One that has not moved for 10 minutes died with its server; it is not shown.
  const rows = await Promise.all(sources.map(async (s) => {
    const status = s.name.endsWith(BIBLE_SUFFIX) ? null : await readDigestStatus(userId, worldId, s.id);
    const live = status && !status.finished && !status.error && Date.now() - Date.parse(status.updatedAt) < 10 * 60_000;
    return { ...publicSource(s), ...(live ? { digest: { phase: status.phase, done: status.done, total: status.total } } : {}) };
  }));
  return c.json({ data: rows });
});

// A book is bigger than the API's body limit, so it goes straight to storage
// (like every other upload) and the server picks it up from there.
// POST /api/studio/:worldId/sources/upload-url  { size } → { uploadUrl, key }
studioRoutes.post("/:worldId/sources/upload-url", async (c) => {
  const userId = c.get("user").id;
  const worldId = c.req.param("worldId");
  if (!(await ownsWorld(userId, worldId))) return c.json({ error: "World not found" }, 404);
  const body = await c.req.json<{ size?: number }>().catch(() => ({} as { size?: number }));
  if (Number(body.size) > MAX_SOURCE_BYTES) return c.json({ error: "File too large (40 MB at most)." }, 413);
  const key = `${sourceIncomingPrefix(userId, worldId)}${crypto.randomUUID()}.txt`;
  return c.json({ data: { uploadUrl: await generateUploadUrl(key, "text/plain"), key } });
});

// POST /api/studio/:worldId/sources  { key, name } — the uploaded file becomes a source
studioRoutes.post("/:worldId/sources", async (c) => {
  const userId = c.get("user").id;
  const worldId = c.req.param("worldId");
  if (!(await ownsWorld(userId, worldId))) return c.json({ error: "World not found" }, 404);
  const body = await c.req.json<{ key?: string; name?: string }>().catch(() => ({} as { key?: string; name?: string }));
  if (typeof body.key !== "string" || !body.key.startsWith(sourceIncomingPrefix(userId, worldId))) {
    return c.json({ error: "Invalid upload key" }, 403);
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array((await getObjectBuffer(body.key, { maxBytes: MAX_SOURCE_BYTES })).buffer);
  } catch {
    return c.json({ error: "The upload did not arrive, or it is over 40 MB." }, 400);
  }
  try {
    if (bytes.byteLength === 0) return c.json({ error: "Empty file." }, 400);
    const meta = await addSource(userId, worldId, body.name ?? "source.txt", bytes);
    return c.json({ data: publicSource(meta) });
  } catch (error) {
    if (error instanceof SourceLimitError) return c.json({ error: error.message }, 400);
    throw error;
  } finally {
    await deleteObject(body.key).catch(() => {});
  }
});

// DELETE /api/studio/:worldId/sources/:sourceId
studioRoutes.delete("/:worldId/sources/:sourceId", async (c) => {
  const userId = c.get("user").id;
  const worldId = c.req.param("worldId");
  if (!(await ownsWorld(userId, worldId))) return c.json({ error: "World not found" }, 404);
  stopDigests({ userId, worldId, sourceId: c.req.param("sourceId") });
  const removed = await removeSource(userId, worldId, c.req.param("sourceId"));
  return removed ? c.json({ ok: true }) : c.json({ error: "Source not found" }, 404);
});

// ── World Snapshots (revert support) ──

// GET /api/studio/:worldId/snapshots — list recent snapshots
studioRoutes.get("/:worldId/snapshots", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");

  // Verify ownership
  const worldRows = await db
    .select({ id: worlds.id })
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id)));
  if (worldRows.length === 0) return c.json({ error: "World not found" }, 404);

  // Optional filter: ?agentRunId=xxx returns the earliest snapshot for that run (for undo)
  const filterRunId = c.req.query("agentRunId");
  const includeSchema = c.req.query("includeSchema") === "true" && !!filterRunId;
  const conditions = [eq(worldSnapshots.worldId, worldId)];
  if (filterRunId) conditions.push(eq(worldSnapshots.agentRunId, filterRunId));

  const snapshots = await db
    .select({
      id: worldSnapshots.id,
      label: worldSnapshots.label,
      agentRunId: worldSnapshots.agentRunId,
      createdAt: worldSnapshots.createdAt,
      ...(includeSchema ? { schemaData: worldSnapshots.schemaData } : {}),
    })
    .from(worldSnapshots)
    .where(and(...conditions))
    .orderBy(filterRunId ? worldSnapshots.createdAt : desc(worldSnapshots.createdAt))
    .limit(filterRunId ? 1 : 20);

  // Attach per-row change summaries for the dialog timeline (unfiltered list
  // only). The agentRunId-filtered query powers the undo path and stays bare.
  if (!filterRunId && snapshots.length > 0) {
    const ids = snapshots.map((s) => s.id);
    const withSchema = await db
      .select({ id: worldSnapshots.id, schemaData: worldSnapshots.schemaData })
      .from(worldSnapshots)
      .where(and(eq(worldSnapshots.worldId, worldId), inArray(worldSnapshots.id, ids)))
      .orderBy(asc(worldSnapshots.createdAt), asc(worldSnapshots.id)); // oldest -> newest, id tiebreak
    const cur = await db.select({ schema: worlds.schema }).from(worlds).where(eq(worlds.id, worldId));
    const summaries = summarizeSnapshotTimeline(
      withSchema.map((s) => ({ id: s.id, schemaData: s.schemaData })),
      cur[0]?.schema ?? {},
    );
    const byId = new Map(summaries.map((s) => [s.id, s.summary]));
    return c.json({ data: snapshots.map((s) => ({ ...s, summary: byId.get(s.id) ?? [] })) });
  }

  return c.json({ data: snapshots });
});

// POST /api/studio/:worldId/rollback/:snapshotId — restore a snapshot
studioRoutes.post("/:worldId/rollback/:snapshotId", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const snapshotId = c.req.param("snapshotId");

  // Verify ownership
  const result = await restoreStudioSnapshot({ worldId, creatorId: currentUser.id, snapshotId });
  if (result.kind === "worldNotFound") return c.json({ error: "World not found" }, 404);
  if (result.kind === "snapshotNotFound") return c.json({ error: "Snapshot not found" }, 404);
  const { held, reasons } = result;

  return c.json({ ok: true, restoredSnapshotId: snapshotId, held, reasons });
});

// GET /api/studio/:worldId/snapshots/:snapshotId/diff?against=auto|current
studioRoutes.get("/:worldId/snapshots/:snapshotId/diff", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const snapshotId = c.req.param("snapshotId");
  const against = c.req.query("against") === "current" ? "current" : "auto";

  const worldRows = await db
    .select({ id: worlds.id, schema: worlds.schema })
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id)));
  if (worldRows.length === 0) return c.json({ error: "World not found" }, 404);

  const snap = await db
    .select({ id: worldSnapshots.id, schemaData: worldSnapshots.schemaData, createdAt: worldSnapshots.createdAt })
    .from(worldSnapshots)
    .where(and(eq(worldSnapshots.id, snapshotId), eq(worldSnapshots.worldId, worldId)));
  if (snap.length === 0) return c.json({ error: "Snapshot not found" }, 404);

  const prev = snap[0]!.schemaData as unknown as WorldDefinition;
  let next: WorldDefinition;
  if (against === "current") {
    next = (worldRows[0]!.schema ?? {}) as unknown as WorldDefinition;
  } else {
    // "next newer state" — MUST match the list endpoint's summarizeSnapshotTimeline
    // pairing exactly, or the expanded diff disagrees with the row's chips. Use the
    // same (createdAt, id) ordering and pick the neighbor by array position; createdAt
    // alone is not unique (an agent turn inserts several snapshots with the same now()).
    const ordered = await db
      .select({ id: worldSnapshots.id, schemaData: worldSnapshots.schemaData })
      .from(worldSnapshots)
      .where(eq(worldSnapshots.worldId, worldId))
      .orderBy(asc(worldSnapshots.createdAt), asc(worldSnapshots.id));
    const idx = ordered.findIndex((s) => s.id === snapshotId);
    const nextState = idx >= 0 && idx + 1 < ordered.length ? ordered[idx + 1]!.schemaData : worldRows[0]!.schema;
    next = (nextState ?? {}) as unknown as WorldDefinition;
  }

  return c.json({ data: diffWorldSchemas(prev, next, { detail: true }) });
});

// DELETE /api/studio/:worldId/snapshots/:snapshotId — delete one restore point
studioRoutes.delete("/:worldId/snapshots/:snapshotId", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const snapshotId = c.req.param("snapshotId");
  const owned = await db.select({ id: worlds.id }).from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id)));
  if (owned.length === 0) return c.json({ error: "World not found" }, 404);
  await db.delete(worldSnapshots).where(and(eq(worldSnapshots.id, snapshotId), eq(worldSnapshots.worldId, worldId)));
  return c.json({ ok: true });
});

// DELETE /api/studio/:worldId/snapshots — clear all restore points for this world
studioRoutes.delete("/:worldId/snapshots", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const owned = await db.select({ id: worlds.id }).from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id)));
  if (owned.length === 0) return c.json({ error: "World not found" }, 404);
  await db.delete(worldSnapshots).where(eq(worldSnapshots.worldId, worldId));
  return c.json({ ok: true });
});

export { studioRoutes };
