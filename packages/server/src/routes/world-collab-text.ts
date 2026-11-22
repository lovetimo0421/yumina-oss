/**
 * Typing together in Studio's text fields, under /api/world-collab:
 *
 *   POST /worlds/:worldId/text/open    { field, gen?, sv? }  → the field's shared document
 *   POST /worlds/:worldId/text/update  { field, gen, update, clientId }
 *   POST /worlds/:worldId/text/caret   { clientId, field | null, anchor?, head? }
 *
 * Everyone who may open the card may open a field (viewers watch it being
 * typed); only its editors may change it. Updates and carets come several
 * times a second while someone types, so access is remembered for a few
 * seconds instead of being looked up every time. See lib/collab-text.
 */
import { Hono } from "hono";
import * as Y from "yjs";
import { parseTextFieldKey } from "@yumina/engine";
import { authMiddleware } from "../middleware/auth.js";
import { canEdit, getWorldAccess } from "../lib/world-collaborators.js";
import { publishWorldEvent } from "../lib/world-events.js";
import {
  appendTextUpdate, broadcastTextUpdate, MAX_TEXT_UPDATE_BYTES, openTextDoc, TextFieldGone,
} from "../lib/collab-text.js";
import type { AppEnv } from "../lib/types.js";

export const worldCollabTextRoutes = new Hono<AppEnv>();
worldCollabTextRoutes.use("/worlds/:worldId/text/*", authMiddleware);

const ACCESS_MS = 5_000;
const access = new Map<string, { until: number; edit: boolean } | { until: number; none: true }>();

/** null: no access at all; otherwise whether they may write. */
async function textAccess(userId: string, worldId: string): Promise<{ edit: boolean } | null> {
  const key = `${userId}|${worldId}`;
  const now = Date.now();
  const hit = access.get(key);
  if (hit && hit.until > now) return "none" in hit ? null : { edit: hit.edit };
  const found = await getWorldAccess(userId, worldId);
  if (access.size > 20_000) access.clear();
  access.set(key, found ? { until: now + ACCESS_MS, edit: canEdit(found) } : { until: now + ACCESS_MS, none: true });
  return found ? { edit: canEdit(found) } : null;
}

const b64 = (v: unknown, maxBytes: number): Uint8Array | null => {
  if (typeof v !== "string" || !v || v.length > Math.ceil(maxBytes / 3) * 4 + 4) return null;
  try { return new Uint8Array(Buffer.from(v, "base64")); } catch { return null; }
};
const toB64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

worldCollabTextRoutes.post("/worlds/:worldId/text/open", async (c) => {
  const me = c.get("user");
  const worldId = c.req.param("worldId");
  if (!(await textAccess(me.id, worldId))) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json().catch(() => null) as { field?: unknown; gen?: unknown; sv?: unknown } | null;
  const field = typeof body?.field === "string" && parseTextFieldKey(body.field) ? body.field : null;
  if (!field) return c.json({ error: "Bad field", code: "BAD_FIELD" }, 400);
  const sv = typeof body?.gen === "string" ? b64(body.sv, 64 * 1024) : null;
  try {
    const doc = await openTextDoc(worldId, field, sv && typeof body?.gen === "string" ? { gen: body.gen, sv } : undefined);
    c.header("Cache-Control", "no-store");
    return c.json({ data: { gen: doc.gen, update: toB64(doc.update), fresh: doc.fresh, sv: toB64(doc.sv) } });
  } catch (error) {
    if (error instanceof TextFieldGone) return c.json({ error: "No such field", code: "TEXT_GONE" }, 404);
    throw error;
  }
});

/** Per tab: updates beyond this rate are refused (the tab sends them again merged). */
const UPDATE_MIN_GAP_MS = 25;
const lastUpdate = new Map<string, number>();

worldCollabTextRoutes.post("/worlds/:worldId/text/update", async (c) => {
  const me = c.get("user");
  const worldId = c.req.param("worldId");
  const allowed = await textAccess(me.id, worldId);
  if (!allowed) return c.json({ error: "Not found" }, 404);
  if (!allowed.edit) return c.json({ error: "Read only", code: "READ_ONLY" }, 403);
  const body = await c.req.json().catch(() => null) as { field?: unknown; gen?: unknown; update?: unknown; clientId?: unknown } | null;
  const field = typeof body?.field === "string" && parseTextFieldKey(body.field) ? body.field : null;
  const gen = typeof body?.gen === "string" && body.gen.length <= 64 ? body.gen : null;
  const clientId = typeof body?.clientId === "string" ? body.clientId.slice(0, 64) : "";
  const update = b64(body?.update, MAX_TEXT_UPDATE_BYTES);
  if (!field || !gen || !clientId || !update) return c.json({ error: "Bad update", code: "BAD_UPDATE" }, 400);
  const now = Date.now();
  if (now - (lastUpdate.get(clientId) ?? 0) < UPDATE_MIN_GAP_MS) return c.json({ error: "Slow down", code: "TEXT_BUSY" }, 429);
  if (lastUpdate.size > 20_000) lastUpdate.clear();
  lastUpdate.set(clientId, now);
  // A malformed update would poison the document for everyone.
  try { Y.decodeUpdate(update); } catch { return c.json({ error: "Bad update", code: "BAD_UPDATE" }, 400); }
  if (!(await appendTextUpdate(worldId, field, gen, update))) {
    return c.json({ error: "This field's live copy was reset", code: "TEXT_RESET" }, 409);
  }
  broadcastTextUpdate(worldId, { field, gen, update, clientId, userId: me.id });
  return c.body(null, 204);
});

const CARET_MIN_GAP_MS = 60;
const lastCaret = new Map<string, number>();

worldCollabTextRoutes.post("/worlds/:worldId/text/caret", async (c) => {
  const me = c.get("user");
  const worldId = c.req.param("worldId");
  if (!(await textAccess(me.id, worldId))) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json().catch(() => null) as { clientId?: unknown; field?: unknown; anchor?: unknown; head?: unknown } | null;
  const clientId = typeof body?.clientId === "string" ? body.clientId.slice(0, 64) : "";
  if (!clientId) return c.json({ error: "clientId required" }, 400);
  const field = body?.field === null ? null : typeof body?.field === "string" && parseTextFieldKey(body.field) ? body.field : undefined;
  if (field === undefined) return c.json({ error: "Bad field" }, 400);
  const now = Date.now();
  // Leaving a field always goes through; moving within one is thinned.
  if (field !== null && now - (lastCaret.get(clientId) ?? 0) < CARET_MIN_GAP_MS) return c.body(null, 204);
  if (lastCaret.size > 20_000) lastCaret.clear();
  lastCaret.set(clientId, now);
  const pos = (v: unknown) => (typeof v === "string" && v.length <= 512 ? v : undefined);
  publishWorldEvent(worldId, {
    kind: "caret", userId: me.id, name: me.name, clientId, field,
    ...(field !== null && pos(body?.anchor) ? { anchor: pos(body?.anchor) } : {}),
    ...(field !== null && pos(body?.head) ? { head: pos(body?.head) } : {}),
    at: new Date(now).toISOString(),
  });
  return c.body(null, 204);
});
