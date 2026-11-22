import { applyWorldChangesChecked, type ChangeConflict, type MissingChange, type WorldDefinition, type WorldEdit } from "@yumina/engine";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { injectServerTextWrite } from "./collab-text.js";

/**
 * The editor's change-set save, applied to the card's working copy.
 *
 * Refused (the editor merges and sends again) when an edit has nothing left
 * to land on — its row was deleted meanwhile — or when it would write over a
 * value someone else changed since this editor read it. Those used to be
 * dropped and overwritten without a word.
 *
 * The compiled frontend travels beside the change set (`rootCompiled`): it is
 * derived from the files, can be most of a card's size, and has no business
 * in the change set every other open editor is sent.
 */
export function applyChangeSetSave(
  working: unknown,
  changes: WorldEdit[],
  body: unknown,
): { ok: true; schema: Record<string, unknown> } | { ok: false; missing: MissingChange[]; conflicts: ChangeConflict[] } {
  const checked = applyWorldChangesChecked((working ?? {}) as unknown as WorldDefinition, changes);
  if (checked.missing.length > 0 || checked.conflicts.length > 0) {
    return { ok: false, missing: checked.missing.slice(0, 50), conflicts: checked.conflicts.slice(0, 50) };
  }
  let schema = checked.world as unknown as Record<string, unknown>;
  const compiled = body && typeof body === "object" ? (body as Record<string, unknown>).rootCompiled : undefined;
  const root = schema.rootComponent;
  if (isCompiled(compiled) && root && typeof root === "object" && !Array.isArray(root)) {
    schema = { ...schema, rootComponent: { ...(root as Record<string, unknown>), compiled } };
  }
  return { ok: true, schema };
}

function isCompiled(value: unknown): value is { code: string; filesHash: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.code === "string" && typeof v.filesHash === "string"
    && (v.compilerVersion === undefined || typeof v.compilerVersion === "number" || typeof v.compilerVersion === "string");
}

/**
 * After a save: carry what it changed in a field someone has open live into
 * that field's shared document. The fields the saving editor has open itself
 * (`textSynced`) are skipped: its text came from that document. Runs in the
 * background; the save is already done.
 */
export function foldSaveIntoLiveText(
  worldId: string,
  before: unknown,
  after: unknown,
  actorUserId: string,
  body: unknown,
): void {
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return;
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>).textSynced : undefined;
  const skip = new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string").slice(0, 500) : []);
  void injectServerTextWrite(worldId, before as Record<string, unknown>, after as Record<string, unknown>, { actorUserId, skip })
    .catch(() => { /* live text only */ });
}

/**
 * Run `announce` once a write made inside a transaction is visible: the
 * card's save token has reached `updatedAt`. Writers inside a caller's
 * transaction (the assistant, an outside AI, a restore) can't tell when it
 * commits, and telling open editors before then sent them to fetch a copy
 * that didn't have the change yet. A write that rolls back never reaches its
 * token, and is never announced.
 */
export function announceWhenCommitted(worldId: string, updatedAt: Date, announce: () => void, { timeoutMs = 120_000 } = {}): void {
  const target = updatedAt.getTime();
  const started = Date.now();
  let delay = 50;
  const check = async () => {
    try {
      const result = await db.execute(sql`SELECT updated_at FROM worlds WHERE id = ${worldId} LIMIT 1`);
      const at = (result.rows[0] as { updated_at?: string | Date | null } | undefined)?.updated_at;
      const time = at ? new Date(at).getTime() : NaN;
      if (Number.isFinite(time) && time >= target) { announce(); return; }
    } catch { /* try again */ }
    if (Date.now() - started > timeoutMs) return;
    delay = Math.min(1000, delay * 2);
    setTimeout(() => { void check(); }, delay).unref?.();
  };
  setTimeout(() => { void check(); }, 0).unref?.();
}
