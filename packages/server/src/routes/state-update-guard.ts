import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { playSessions, worlds } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import type { AppEnv } from "../lib/types.js";
import { isExtensionInstalled } from "../lib/extensions.js";
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

export function createStateGuardRoutes(deps: {
  authenticate: MiddlewareHandler<AppEnv>;
  installed: typeof isExtensionInstalled;
  resolveModel: typeof resolveGuardModel;
} = { authenticate: authMiddleware, installed: isExtensionInstalled, resolveModel: resolveGuardModel }) {
  const stateGuardRoutes = new Hono<AppEnv>();
  const capabilities = () => edition.info().features.officialModels ? {} : { officialModels: false };
  const path = "/:sessionId/state-update-guard";
  stateGuardRoutes.use(path, deps.authenticate);
  stateGuardRoutes.use(path, async (c, next) => {
    if (!await deps.installed(c.get("user").id, "state-update-guard")) {
      return c.json({ error: "Extension not installed" }, 403);
    }
    return next();
  });
  stateGuardRoutes.get(path, async (c) => {
    const [row] = await db.select({ enabled: playSessions.stateGuardEnabled, model: playSessions.stateGuardModel })
      .from(playSessions).where(and(eq(playSessions.id, c.req.param("sessionId")), eq(playSessions.userId, c.get("user").id)));
    return row ? c.json({ data: { ...row, ...capabilities() } }) : c.json({ error: "Session not found" }, 404);
  });
  stateGuardRoutes.patch(path, async (c) => {
    const body = stateGuardSettingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Invalid state update settings" }, 400);
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
    return updated ? c.json({ data: { enabled: updated.stateGuardEnabled, model: updated.stateGuardModel, ...capabilities() } }) : c.json({ error: "Session not found" }, 404);
  });
  return stateGuardRoutes;
}

export const stateGuardRoutes = createStateGuardRoutes();
