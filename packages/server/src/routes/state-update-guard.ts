import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { playSessions, worlds } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import type { AppEnv } from "../lib/types.js";
import { getUninstalledExtensions, isExtensionInstalled } from "../lib/extensions.js";
import { loadSessionWorldDef } from "../lib/world-def-cache.js";
import { STATE_GUARD_KEY, stateGuardDefaultApplies } from "../extensions/state-update-guard/activation.js";
import { MODEL_ID_PATTERN, applyModelRedirect } from "../lib/llm/model-redirects.js";
import { resolveGuardModel } from "../extensions/state-update-guard/model.js";
import { parseStateGuardModel, stateGuardModelSelection } from "@yumina/shared";
import { edition } from "../edition/index.js";

export const stateGuardSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  model: z.string().trim().max(180).refine((value) => {
    const { model } = parseStateGuardModel(value);
    return Boolean(model && MODEL_ID_PATTERN.test(model) && !model.includes("::"));
  }).transform((value) => {
    const selection = parseStateGuardModel(value);
    const model = applyModelRedirect(selection.model!);
    return selection.provider ? stateGuardModelSelection(model, selection.provider) : model;
  }).nullable().optional(),
}).strict().refine((value) => value.enabled !== undefined || value.model !== undefined);

type GuardRouteDeps = {
  authenticate: MiddlewareHandler<AppEnv>;
  installed: typeof isExtensionInstalled;
  resolveModel: typeof resolveGuardModel;
  /** Explicit uninstalls: the default's opt-out. */
  uninstalled?: typeof getUninstalledExtensions;
  loadWorld?: typeof loadSessionWorldDef;
};

export function createStateGuardRoutes(deps: GuardRouteDeps = { authenticate: authMiddleware, installed: isExtensionInstalled, resolveModel: resolveGuardModel }) {
  const stateGuardRoutes = new Hono<AppEnv>();
  const uninstalled = deps.uninstalled ?? getUninstalledExtensions;
  const loadWorld = deps.loadWorld ?? loadSessionWorldDef;
  const capabilities = () => edition.info().features.officialModels ? {} : { officialModels: false };
  const path = "/:sessionId/state-update-guard";
  const forbidden = (c: Context<AppEnv>) => c.json({ error: "Extension not installed" }, 403);
  /** Installed players manage everything. Never-installed players of a card
   * the guard is on by default for may only switch it off/on per chat. */
  const access = async (c: Context<AppEnv>): Promise<"installed" | "default" | null> => {
    const userId = c.get("user").id;
    if (await deps.installed(userId, STATE_GUARD_KEY)) return "installed";
    if ((await uninstalled(userId)).has(STATE_GUARD_KEY)) return null;
    const [session] = await db.select({ worldId: playSessions.worldId }).from(playSessions)
      .where(and(eq(playSessions.id, c.req.param("sessionId")!), eq(playSessions.userId, userId)));
    if (!session?.worldId) return null;
    // An unreadable card simply has no default; never a 500 on the settings panel.
    const world = await loadWorld(session.worldId, userId).catch(() => null);
    return stateGuardDefaultApplies(world ?? undefined) ? "default" : null;
  };
  stateGuardRoutes.use(path, deps.authenticate);
  stateGuardRoutes.get(path, async (c) => {
    const mode = await access(c);
    if (!mode) return forbidden(c);
    const [row] = await db.select({ enabled: playSessions.stateGuardEnabled, model: playSessions.stateGuardModel })
      .from(playSessions).where(and(eq(playSessions.id, c.req.param("sessionId")), eq(playSessions.userId, c.get("user").id)));
    return row ? c.json({ data: { ...row, ...capabilities(), ...(mode === "default" ? { byDefault: true } : {}) } }) : c.json({ error: "Session not found" }, 404);
  });
  stateGuardRoutes.patch(path, async (c) => {
    const mode = await access(c);
    if (!mode) return forbidden(c);
    const body = stateGuardSettingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Invalid state update settings" }, 400);
    // The correction model (and its billing) is an installed-extension setting.
    if (mode === "default" && body.data.model !== undefined) return forbidden(c);
    const userId = c.get("user").id;
    const scope = and(eq(playSessions.id, c.req.param("sessionId")), eq(playSessions.userId, userId));
    const [row] = await db.select({ creatorId: worlds.creatorId, allowCustomApi: worlds.allowCustomApi })
      .from(playSessions).innerJoin(worlds, eq(playSessions.worldId, worlds.id)).where(scope);
    if (!row) return c.json({ error: "Session not found" }, 404);
    if (body.data.model) {
      try { await deps.resolveModel(userId, body.data.model, !row.allowCustomApi && row.creatorId !== userId); }
      catch { return c.json({ error: "Correction model unavailable. Check your plan, AI Provider connection, and this card's private-provider permissions." }, 400); }
    }
    // Independent columns: never overwrite game state or another setting. Changes
    // apply to the next turn; an already-running guarded turn retains its checks.
    const [updated] = await db.update(playSessions).set({
      ...(body.data.enabled !== undefined ? { stateGuardEnabled: body.data.enabled } : {}),
      ...(body.data.model !== undefined ? { stateGuardModel: body.data.model } : {}),
    }).where(scope).returning();
    return updated ? c.json({ data: { enabled: updated.stateGuardEnabled, model: updated.stateGuardModel, ...capabilities(), ...(mode === "default" ? { byDefault: true } : {}) } }) : c.json({ error: "Session not found" }, 404);
  });
  return stateGuardRoutes;
}

export const stateGuardRoutes = createStateGuardRoutes();
