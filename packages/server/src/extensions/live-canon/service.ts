import { and, asc, eq } from "drizzle-orm";
import {
  GameStateManager,
  migrateWorldDefinition,
  resolveLiveCanonOverlay,
  type GameState,
  type LiveCanonOverlay,
  type Variable,
  type WorldDefinition,
  type WorldEntry,
} from "@yumina/engine";
import {
  LIVE_CANON_EXTENSION_KEY,
  type LiveCanonEditableEntryDTO,
  type LiveCanonPayload,
  type LiveCanonSessionEntryDTO,
  type LiveCanonVariableDTO,
} from "@yumina/shared";
import { db } from "../../db/index.js";
import { playSessions, sessionLoreEntries, worlds } from "../../db/schema.js";
import { isExtensionInstalled } from "../../lib/extensions.js";
import { resolveSessionWorldSchema } from "../../lib/pending-edit.js";

export const LIVE_CANON_DISABLED_MESSAGE =
  "The author has disabled session lore editing. You can keep playing, but Lore Shift cannot change this story's state or lore.";
export const LIVE_CANON_MAX_ROWS = 100;
export const LIVE_CANON_MAX_CONTENT = 4_000;
export const LIVE_CANON_MAX_TOTAL_CONTENT = 50_000;

/** Session lore is plain text, never a second prompt/template language. */
export function isSafeLiveCanonContent(content: string): boolean {
  return !(/\{\{|\}\}|\[\s*var\s*:|<\s*\/?\s*yumina-/i.test(content));
}

export class LiveCanonError extends Error {
  constructor(
    public readonly code:
      | "AUTHOR_DISABLED_LIVE_CANON"
      | "EXTENSION_NOT_INSTALLED"
      | "LIVE_CANON_NOT_FOUND"
      | "LIVE_CANON_FORBIDDEN"
      | "LIVE_CANON_LIMIT"
      | "LIVE_CANON_CONFLICT",
    public readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export interface LiveCanonContext {
  sessionId: string;
  userId: string;
  worldId: string;
  worldCreatorId: string;
  allowAdditions: boolean;
  state: Record<string, unknown>;
  worldDef: WorldDefinition;
}

function primitiveVariable(variable: Variable): variable is Variable & {
  type: "number" | "string" | "boolean";
  defaultValue: number | string | boolean;
} {
  return variable.type === "number" || variable.type === "string" || variable.type === "boolean";
}

export function canEditLiveCanonVariable(variable: Variable, isWorldOwner: boolean): boolean {
  if (variable.internal || !primitiveVariable(variable)) return false;
  return isWorldOwner || variable.liveCanonEditable === true;
}

export function canEditLiveCanonEntry(entry: WorldEntry): boolean {
  return (
    entry.sessionEditPolicy === "content"
    && (entry.role === "lore" || entry.role === "plot" || entry.role === "custom")
  );
}

/**
 * Cheap gate first: disabled cards do not fetch or migrate the schema and the
 * author-disabled reason intentionally wins over global install state.
 */
export async function loadLiveCanonContext(
  sessionId: string,
  userId: string,
): Promise<LiveCanonContext> {
  const [meta] = await db
    .select({
      sessionId: playSessions.id,
      worldId: worlds.id,
      worldCreatorId: worlds.creatorId,
      allowLiveCanon: worlds.allowLiveCanon,
      allowAdditions: worlds.allowLiveCanonAdditions,
    })
    .from(playSessions)
    .innerJoin(worlds, eq(playSessions.worldId, worlds.id))
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, userId)))
    .limit(1);

  if (!meta) throw new LiveCanonError("LIVE_CANON_NOT_FOUND", 404, "Session not found");
  if (!meta.allowLiveCanon) {
    throw new LiveCanonError("AUTHOR_DISABLED_LIVE_CANON", 403, LIVE_CANON_DISABLED_MESSAGE);
  }
  if (!(await isExtensionInstalled(userId, LIVE_CANON_EXTENSION_KEY))) {
    throw new LiveCanonError("EXTENSION_NOT_INSTALLED", 403, "Lore Shift is not installed");
  }

  const [[world], [session]] = await Promise.all([
    db.select().from(worlds).where(eq(worlds.id, meta.worldId)).limit(1),
    db.select({ state: playSessions.state }).from(playSessions).where(and(
      eq(playSessions.id, sessionId),
      eq(playSessions.userId, userId),
    )).limit(1),
  ]);
  if (!world || !session) throw new LiveCanonError("LIVE_CANON_NOT_FOUND", 404, "Session or world not found");
  const schema = await resolveSessionWorldSchema(world, userId);
  const worldDef = migrateWorldDefinition(schema as WorldDefinition);

  return {
    sessionId: meta.sessionId,
    userId,
    worldId: meta.worldId,
    worldCreatorId: meta.worldCreatorId,
    allowAdditions: meta.allowAdditions,
    state: session.state,
    worldDef,
  };
}

export async function assertLiveCanonWriteStillAllowed(
  sessionId: string,
  userId: string,
): Promise<void> {
  const [row] = await db
    .select({ allowLiveCanon: worlds.allowLiveCanon })
    .from(playSessions)
    .innerJoin(worlds, eq(playSessions.worldId, worlds.id))
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, userId)))
    .limit(1);
  if (!row) throw new LiveCanonError("LIVE_CANON_NOT_FOUND", 404, "Session not found");
  if (!row.allowLiveCanon) {
    throw new LiveCanonError("AUTHOR_DISABLED_LIVE_CANON", 403, LIVE_CANON_DISABLED_MESSAGE);
  }
}

export async function buildLiveCanonPayload(ctx: LiveCanonContext): Promise<LiveCanonPayload> {
  const rows = await db
    .select()
    .from(sessionLoreEntries)
    .where(eq(sessionLoreEntries.sessionId, ctx.sessionId))
    .orderBy(asc(sessionLoreEntries.createdAt));
  const isWorldOwner = ctx.worldCreatorId === ctx.userId;
  const values = ((ctx.state as Partial<GameState>).variables ?? {}) as Record<string, unknown>;

  const variables: LiveCanonVariableDTO[] = ctx.worldDef.variables
    .filter((variable) => canEditLiveCanonVariable(variable, isWorldOwner))
    .map((variable) => ({
      id: variable.id,
      name: variable.name,
      type: variable.type as "number" | "string" | "boolean",
      value: (values[variable.id] ?? variable.defaultValue) as number | string | boolean,
      ...(variable.min !== undefined ? { min: variable.min } : {}),
      ...(variable.max !== undefined ? { max: variable.max } : {}),
    }));

  const overrides = new Map(
    rows
      .filter((row) => row.kind === "override" && row.baseEntryId)
      .map((row) => [row.baseEntryId!, row]),
  );
  const editableEntries: LiveCanonEditableEntryDTO[] = ctx.worldDef.entries
    .filter(canEditLiveCanonEntry)
    .slice(0, LIVE_CANON_MAX_ROWS)
    .map((entry) => {
      const override = overrides.get(entry.id);
      return {
        id: entry.id,
        name: entry.name,
        content: entry.content,
        overrideId: override?.id ?? null,
        overrideContent: override?.content ?? null,
      };
    });
  const sessionEntries: LiveCanonSessionEntryDTO[] = rows
    .filter((row) => row.kind === "created")
    .map((row) => ({
      id: row.id,
      name: row.name ?? "Session lore",
      content: row.content,
      enabled: row.enabled,
      alwaysSend: row.alwaysSend,
      keywords: row.keywords,
      matchWholeWords: row.matchWholeWords,
    }));

  return { additionsAllowed: ctx.allowAdditions, variables, editableEntries, sessionEntries };
}

export function applyLiveCanonStateUpdates(
  ctx: LiveCanonContext,
  currentState: Record<string, unknown>,
  updates: Record<string, number | string | boolean>,
): GameState {
  const isWorldOwner = ctx.worldCreatorId === ctx.userId;
  const byId = new Map(ctx.worldDef.variables.map((variable) => [variable.id, variable]));
  const manager = new GameStateManager(ctx.worldDef, currentState as unknown as GameState);

  for (const [id, value] of Object.entries(updates)) {
    const variable = byId.get(id);
    if (!variable || !canEditLiveCanonVariable(variable, isWorldOwner)) {
      throw new LiveCanonError("LIVE_CANON_FORBIDDEN", 403, `Variable ${id} is not editable through Lore Shift`);
    }
    if (typeof value !== variable.type) {
      throw new LiveCanonError("LIVE_CANON_FORBIDDEN", 400, `Variable ${id} has the wrong value type`);
    }
    if (typeof value === "string" && value.trim().length > 500) {
      throw new LiveCanonError("LIVE_CANON_LIMIT", 400, `Variable ${id} is too long`);
    }
    manager.set(id, typeof value === "string" ? value.trim() : value);
  }
  return manager.getSnapshot();
}

export async function assertLoreCapacity(
  sessionId: string,
  replacement?: { id?: string; content: string },
): Promise<void> {
  const rows = await db
    .select({ id: sessionLoreEntries.id, content: sessionLoreEntries.content })
    .from(sessionLoreEntries)
    .where(eq(sessionLoreEntries.sessionId, sessionId));
  assertLoreCapacityForRows(rows, replacement);
}

export function assertLoreCapacityForRows(
  rows: Array<{ id: string; content: string }>,
  replacement?: { id?: string; content: string },
): void {
  const isNew = !replacement?.id || !rows.some((row) => row.id === replacement.id);
  if (isNew && rows.length >= LIVE_CANON_MAX_ROWS) {
    throw new LiveCanonError("LIVE_CANON_LIMIT", 400, `Lore Shift supports at most ${LIVE_CANON_MAX_ROWS} session lore entries`);
  }
  const total = rows.reduce(
    (sum, row) => sum + (row.id === replacement?.id ? 0 : row.content.length),
    replacement?.content.length ?? 0,
  );
  if (total > LIVE_CANON_MAX_TOTAL_CONTENT) {
    throw new LiveCanonError("LIVE_CANON_LIMIT", 400, "Lore Shift session lore is too large");
  }
}

/** Re-check the DB gate and resolve only bounded, currently authorized rows. */
export async function resolveLiveCanonWorldForTurn(
  worldDef: WorldDefinition,
  sessionId: string,
  userId: string,
): Promise<WorldDefinition> {
  const [availability] = await db
    .select({
      allowLiveCanon: worlds.allowLiveCanon,
      allowAdditions: worlds.allowLiveCanonAdditions,
    })
    .from(playSessions)
    .innerJoin(worlds, eq(playSessions.worldId, worlds.id))
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, userId)))
    .limit(1);
  if (!availability?.allowLiveCanon) return worldDef;

  const rows = await db
    .select()
    .from(sessionLoreEntries)
    .where(eq(sessionLoreEntries.sessionId, sessionId))
    .orderBy(asc(sessionLoreEntries.createdAt))
    .limit(LIVE_CANON_MAX_ROWS);
  let used = 0;
  const bounded = rows.filter((row) => {
    if (row.content.length > LIVE_CANON_MAX_CONTENT) return false;
    used += row.content.length;
    return used <= LIVE_CANON_MAX_TOTAL_CONTENT;
  });
  const overlay: LiveCanonOverlay = {
    basePatches: bounded
      .filter((row) => row.kind === "override" && row.baseEntryId)
      .map((row) => ({ baseEntryId: row.baseEntryId!, content: row.content })),
    createdEntries: availability.allowAdditions
      ? bounded.filter((row) => row.kind === "created").map((row) => ({
          id: row.id,
          name: row.name ?? "Session lore",
          content: row.content,
          enabled: row.enabled,
          alwaysSend: row.alwaysSend,
          keywords: row.keywords,
          matchWholeWords: row.matchWholeWords,
        }))
      : [],
  };
  return resolveLiveCanonOverlay(worldDef, overlay);
}
