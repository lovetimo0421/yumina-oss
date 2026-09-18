import { Hono } from "hono";
import { eq, and, desc, asc, inArray } from "drizzle-orm";
import { diffWorldSchemas } from "@yumina/engine";
import type { WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { worlds, studioConversations, worldSnapshots } from "../db/schema.js";
import { summarizeSnapshotTimeline } from "../lib/studio-tools/snapshot-summary.js";
import { authMiddleware } from "../middleware/auth.js";
import type { AppEnv } from "../lib/types.js";
import { readTemplateContent, readTemplateMeta } from "../lib/studio-tools/index.js";
import { getTemplateCatalogSummary } from "../lib/studio-skills/index.js";
import { isS3Configured, generateUploadUrl } from "../lib/s3.js";
import { resolveImageCdn } from "../lib/cdn-url.js";
import {
  deleteStudioConversationForWorld,
  loadStudioConversationForDisplay,
  updateStudioConversationForWorld,
} from "../lib/studio-conversations.js";
import { writeStudioWorldSchema } from "../lib/pending-edit.js";

const studioRoutes = new Hono<AppEnv>();

studioRoutes.use("/*", authMiddleware);

// Auto-backup written before each rollback so the rollback itself is reversible.
// Only the most recent one is kept — older backups are pruned at rollback time.
const BEFORE_ROLLBACK_LABEL = "Before rollback";

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

// POST /api/studio/:worldId/conversations — Create a new conversation
studioRoutes.post("/:worldId/conversations", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");
  const body = await c.req.json<{ title?: string }>().catch(() => ({}));

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
  const worldRows = await db
    .select({ id: worlds.id })
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, currentUser.id)));
  if (worldRows.length === 0) return c.json({ error: "World not found" }, 404);

  // Load snapshot
  const snapRows = await db
    .select({ schemaData: worldSnapshots.schemaData })
    .from(worldSnapshots)
    .where(
      and(
        eq(worldSnapshots.id, snapshotId),
        eq(worldSnapshots.worldId, worldId),
      )
    );
  if (snapRows.length === 0) return c.json({ error: "Snapshot not found" }, 404);

  // Capture CURRENT live state before rollback (so the rollback is itself
  // revertible) — but only persist the backup if the rollback actually changes
  // the live row (see below).
  const currentWorld = await db
    .select({ schema: worlds.schema })
    .from(worlds)
    .where(eq(worlds.id, worldId));

  // Apply the rollback through the SAME material-edit gate as a manual/Studio
  // save: on a PUBLISHED world a material rollback (entries/frontend) is parked
  // in world_pending_edits and re-reviewed — it does NOT silently go live —
  // while a non-material rollback (or any non-published world) writes through.
  // This closes the bypass where a rollback rewrote published content unreviewed.
  const { held, reasons } = await writeStudioWorldSchema({
    worldId,
    creatorId: currentUser.id,
    schema: snapRows[0]!.schemaData as Record<string, unknown>,
  });

  // The "before rollback" backup only makes sense when the live row actually
  // changed. When the rollback is held for review, live is untouched, so a
  // backup would just duplicate the current state and clutter the timeline.
  if (!held && currentWorld.length > 0) {
    // Keep only the latest auto-backup: prune older ones before inserting the new.
    await db
      .delete(worldSnapshots)
      .where(and(eq(worldSnapshots.worldId, worldId), eq(worldSnapshots.label, BEFORE_ROLLBACK_LABEL)));
    await db.insert(worldSnapshots).values({
      worldId,
      userId: currentUser.id,
      schemaData: currentWorld[0]!.schema as Record<string, unknown>,
      label: BEFORE_ROLLBACK_LABEL,
    });
  }

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
