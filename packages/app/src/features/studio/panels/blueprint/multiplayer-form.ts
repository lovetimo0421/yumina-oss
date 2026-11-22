import {
  MULTIPLAYER_DEFAULT_SEATS,
  MULTIPLAYER_MAX_SEATS,
  MULTIPLAYER_MIN_SEATS,
  normaliseMultiplayer,
  type MultiplayerMode,
  type MultiplayerRole,
} from "@yumina/shared";
import type { WorldMultiplayerSettings } from "@yumina/engine";

/**
 * settings.multiplayer as the card settings edit it.
 *
 * The readers (`readMultiplayer`) answer "is it on, and how": off is null,
 * rules mode has no roles, story mode no rules file. The form needs more than
 * that: turned off, or switched between modes, nothing the author set may be
 * lost, so they get it back by switching again. So the form reads every half
 * whatever the mode, and writes them all back.
 */
export interface MultiplayerForm {
  enabled: boolean;
  mode: MultiplayerMode;
  minSeats: number;
  maxSeats: number;
  roles: MultiplayerRole[];
  rolesRequired: boolean;
  rulesFile: string | null;
  aiNames: string[];
  aiModel: string | null;
}

export const MAX_ROLES = MULTIPLAYER_MAX_SEATS * 2;
export const MAX_AI_NAMES = MULTIPLAYER_MAX_SEATS;
const ROLE_NAME_MAX = 40;
const ROLE_NOTE_MAX = 200;
const AI_NAME_MAX = 24;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function multiplayerForm(raw: unknown): MultiplayerForm {
  const r = isObject(raw) ? raw : {};
  // Each half read as if it were the mode in use, so neither is dropped.
  const story = normaliseMultiplayer({ ...r, enabled: true, mode: "story" })!;
  const rules = normaliseMultiplayer({ ...r, enabled: true, mode: "rules" })!;
  return {
    enabled: normaliseMultiplayer(r) !== null,
    mode: r.mode === "rules" ? "rules" : "story",
    minSeats: story.minSeats,
    maxSeats: story.maxSeats,
    roles: story.roles,
    rolesRequired: r.rolesRequired === true,
    rulesFile: rules.rulesFile,
    aiNames: rules.ai.names,
    aiModel: rules.ai.model,
  };
}

/** Nothing set beyond what a card that never touched it has. */
function untouched(form: MultiplayerForm): boolean {
  return form.mode === "story"
    && form.minSeats === MULTIPLAYER_DEFAULT_SEATS.min
    && form.maxSeats === MULTIPLAYER_DEFAULT_SEATS.max
    && form.roles.length === 0
    && !form.rolesRequired
    && !form.rulesFile
    && form.aiNames.length === 0
    && !form.aiModel;
}

/**
 * What goes back into settings.multiplayer. Keys the form does not know (the
 * Krew sea's `roomId`) are kept; the older `aiModel` moves to `ai.model`.
 * Off with nothing set is no setting at all.
 */
export function multiplayerSetting(form: MultiplayerForm, raw?: unknown): WorldMultiplayerSettings | undefined {
  const { enabled: _e, mode: _m, minSeats: _min, maxSeats: _max, roles: _r, rolesRequired: _rr, rulesFile: _f, ai: _ai, aiModel: _legacy, ...rest } = isObject(raw) ? raw : {};
  if (!form.enabled && untouched(form) && Object.keys(rest).length === 0) return undefined;
  const seats = clampSeatRange(form.minSeats, form.maxSeats, "min");
  const ai = {
    ...(form.aiNames.length ? { names: form.aiNames } : {}),
    ...(form.aiModel ? { model: form.aiModel } : {}),
  };
  return {
    ...rest,
    enabled: form.enabled,
    mode: form.mode,
    minSeats: seats.min,
    maxSeats: seats.max,
    ...(form.roles.length ? { roles: form.roles } : {}),
    ...(form.rolesRequired && form.roles.length ? { rolesRequired: true } : {}),
    ...(form.rulesFile ? { rulesFile: form.rulesFile } : {}),
    ...(Object.keys(ai).length ? { ai } : {}),
  };
}

const clampSeat = (n: number) => Math.min(MULTIPLAYER_MAX_SEATS, Math.max(MULTIPLAYER_MIN_SEATS, Math.round(Number.isFinite(n) ? n : MULTIPLAYER_MIN_SEATS)));

/** Seats within 2..12, the one being moved pushing the other along. */
export function clampSeatRange(min: number, max: number, moved: "min" | "max"): { min: number; max: number } {
  const a = clampSeat(min);
  const b = clampSeat(max);
  if (a <= b) return { min: a, max: b };
  return moved === "min" ? { min: a, max: a } : { min: b, max: b };
}

/** "2–6", or "4" when the range is one number. */
export function seatRange(min: number, max: number): string {
  return min === max ? String(min) : `${min}–${max}`;
}

/** The rules file a card would mean: rules.js when it has one. */
export function defaultRulesFile(files: Record<string, string> | undefined): string | null {
  if (!files) return null;
  if (typeof files["rules.js"] === "string") return "rules.js";
  return null;
}

/** Interface files that can be a rules file: plain JavaScript (the table
 *  runs it as is, in QuickJS). rules.js first. */
export function rulesFileChoices(files: Record<string, string> | undefined): string[] {
  if (!files) return [];
  return Object.keys(files)
    .filter((f) => /\.(m?js|cjs)$/i.test(f) && !f.startsWith("_bundles/"))
    .sort((a, b) => (a === "rules.js" ? -1 : b === "rules.js" ? 1 : a.localeCompare(b)));
}

// ── Roles ────────────────────────────────────────────────────────────────

function roleIdFor(base: string, taken: ReadonlySet<string>): string {
  const slug = base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const stem = slug || "role";
  if (!taken.has(stem)) return stem;
  for (let n = 2; ; n++) if (!taken.has(`${stem}-${n}`)) return `${stem}-${n}`;
}

/** A role added by name, or from a 角色和世界 entry (once per entry). */
export function addRole(roles: readonly MultiplayerRole[], input: { name: string; entryId?: string }): MultiplayerRole[] {
  const name = input.name.trim().slice(0, ROLE_NAME_MAX);
  if (!name || roles.length >= MAX_ROLES) return [...roles];
  if (input.entryId && roles.some((r) => r.entryId === input.entryId)) return [...roles];
  const id = roleIdFor(input.entryId ? `entry-${input.entryId}` : "role", new Set(roles.map((r) => r.id)));
  return [...roles, { id, name, ...(input.entryId ? { entryId: input.entryId } : {}) }];
}

/** Rename or re-note a role. A name cleared away keeps the old one; a note
 *  cleared away is gone. */
export function updateRole(roles: readonly MultiplayerRole[], id: string, patch: { name?: string; note?: string; image?: string | null }): MultiplayerRole[] {
  return roles.map((r) => {
    if (r.id !== id) return r;
    const name = patch.name === undefined ? r.name : patch.name.trim().slice(0, ROLE_NAME_MAX) || r.name;
    const note = patch.note === undefined ? r.note : patch.note.trim().slice(0, ROLE_NOTE_MAX) || undefined;
    // A picture cleared away falls back to the linked character's portrait.
    const image = patch.image === undefined ? r.image : patch.image?.trim() || undefined;
    const { note: _old, image: _oldImage, ...base } = r;
    return { ...base, name, ...(note ? { note } : {}), ...(image ? { image } : {}) };
  });
}

export function moveRole(roles: readonly MultiplayerRole[], id: string, by: -1 | 1): MultiplayerRole[] {
  const i = roles.findIndex((r) => r.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= roles.length) return [...roles];
  const next = [...roles];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

export function removeRole(roles: readonly MultiplayerRole[], id: string): MultiplayerRole[] {
  return roles.filter((r) => r.id !== id);
}

/** Entries a role can be taken from: the card's characters, or when it names
 *  none, what it always sends (角色和世界). */
export function roleSourceEntries<E extends { id: string; name?: string; role?: string; enabled?: boolean }>(
  entries: readonly E[],
  alwaysSent: (entry: E) => boolean,
): E[] {
  const named = entries.filter((e) => e.enabled !== false && !!e.name?.trim());
  const characters = named.filter((e) => e.role === "character");
  if (characters.length) return characters;
  return named.filter((e) => e.role !== "greeting" && e.role !== "example" && alwaysSent(e));
}

// ── AI seat names ────────────────────────────────────────────────────────

export function addAiName(names: readonly string[], raw: string): string[] {
  const name = raw.trim().slice(0, AI_NAME_MAX);
  if (!name || names.includes(name) || names.length >= MAX_AI_NAMES) return [...names];
  return [...names, name];
}

export function removeAiName(names: readonly string[], name: string): string[] {
  return names.filter((n) => n !== name);
}
