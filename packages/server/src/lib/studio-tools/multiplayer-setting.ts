/**
 * update_settings.multiplayer: the card's 联机 setting, checked before it is
 * written. The stored shape is the one `readMultiplayer` (@yumina/shared)
 * reads; this only refuses what the normaliser would silently drop or bend,
 * so the assistant hears about it instead of the creator finding out later.
 *
 * Only the keys passed change; the rest of the stored setting is kept, so
 * `{ maxSeats: 8 }` on a card already set up stays a one-key edit and turning
 * multiplayer off and on again keeps the roles and the rules file.
 */
import type { WorldDefinition } from "@yumina/engine";
import { MULTIPLAYER_DEFAULT_SEATS, MULTIPLAYER_MAX_SEATS, MULTIPLAYER_MIN_SEATS, normaliseMultiplayer } from "@yumina/shared";
import { catalogModelError, lookupCatalogModel } from "./model-catalog.js";

const MAX_ROLES = MULTIPLAYER_MAX_SEATS * 2;
const KEYS = new Set(["enabled", "mode", "minSeats", "maxSeats", "roles", "rolesRequired", "rulesFile", "ai", "aiModel"]);

export type MultiplayerArgOutcome =
  | { ok: true; value: Record<string, unknown>; notes: string[]; summary: string }
  | { ok: false; errors: string[] };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const cleanPath = (p: string) => p.trim().replace(/^\.?\//, "");
const slug = (name: string, i: number) => {
  const s = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s || `role-${i + 1}`;
};

function seatNumber(key: string, v: unknown, errors: string[], adjusted: string[]): number | undefined {
  if (v === undefined) return undefined;
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) { errors.push(`multiplayer.${key} must be a number from ${MULTIPLAYER_MIN_SEATS} to ${MULTIPLAYER_MAX_SEATS}`); return undefined; }
  const clamped = Math.min(MULTIPLAYER_MAX_SEATS, Math.max(MULTIPLAYER_MIN_SEATS, Math.round(n)));
  if (clamped !== n) adjusted.push(`${key} ${n} → ${clamped}`);
  return clamped;
}

/** Check `raw` (the tool argument) against the card and merge it into the stored setting. */
export function resolveMultiplayerArg(draft: WorldDefinition, raw: unknown): MultiplayerArgOutcome {
  const settings = (draft.settings ?? {}) as Record<string, unknown>;
  const stored = isObject(settings.multiplayer) ? settings.multiplayer : {};
  // null / false: off, keeping the rest for when it is turned back on.
  if (raw === null || raw === false) {
    return { ok: true, value: { ...stored, enabled: false }, notes: [], summary: "multiplayer off" };
  }
  if (raw === true) raw = { enabled: true };
  if (!isObject(raw)) return { ok: false, errors: ["multiplayer must be an object, e.g. { enabled: true, mode: \"story\", minSeats: 2, maxSeats: 6 }, or null to turn it off"] };

  const errors: string[] = [];
  const adjusted: string[] = [];
  const notes: string[] = [];
  const unknown = Object.keys(raw).filter((k) => !KEYS.has(k));
  if (unknown.length) errors.push(`multiplayer has no ${unknown.join(", ")} (keys: enabled, mode, minSeats, maxSeats, roles, rolesRequired, rulesFile, ai)`);

  const next: Record<string, unknown> = { ...stored };
  delete next.aiModel;

  // enabled: given, or kept, or on when this is the first setup.
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") errors.push("multiplayer.enabled must be true or false");
  const wasOn = stored.enabled === true || (stored.enabled === undefined && stored.mode === "rules");
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : (Object.keys(stored).length === 0 || wasOn);
  if (raw.enabled === undefined && Object.keys(stored).length > 0 && !wasOn) notes.push("multiplayer stays off: pass enabled: true to turn it on");
  next.enabled = enabled;

  if (raw.mode !== undefined && raw.mode !== "story" && raw.mode !== "rules") errors.push('multiplayer.mode must be "story" (friends share one story; the card\'s AI narrates each round) or "rules" (a rules file runs the game)');
  const mode = raw.mode === "rules" || raw.mode === "story" ? raw.mode : stored.mode === "rules" ? "rules" : "story";
  next.mode = mode;

  const min = seatNumber("minSeats", raw.minSeats, errors, adjusted);
  const max = seatNumber("maxSeats", raw.maxSeats, errors, adjusted);
  const storedMin = typeof stored.minSeats === "number" ? stored.minSeats : MULTIPLAYER_DEFAULT_SEATS.min;
  const storedMax = typeof stored.maxSeats === "number" ? stored.maxSeats : MULTIPLAYER_DEFAULT_SEATS.max;
  let minSeats = min ?? Math.min(MULTIPLAYER_MAX_SEATS, Math.max(MULTIPLAYER_MIN_SEATS, Math.round(storedMin)));
  let maxSeats = max ?? Math.min(MULTIPLAYER_MAX_SEATS, Math.max(MULTIPLAYER_MIN_SEATS, Math.round(storedMax)));
  if (minSeats > maxSeats) {
    if (min !== undefined && max !== undefined) errors.push(`multiplayer.minSeats (${minSeats}) is above maxSeats (${maxSeats})`);
    else if (min !== undefined) { adjusted.push(`maxSeats ${maxSeats} → ${minSeats}`); maxSeats = minSeats; }
    else { adjusted.push(`minSeats ${minSeats} → ${maxSeats}`); minSeats = maxSeats; }
  }
  next.minSeats = minSeats;
  next.maxSeats = maxSeats;

  // Roles (story mode): who a player can be. entryId links a 角色和世界 entry.
  if (raw.roles !== undefined) {
    if (mode === "rules" && Array.isArray(raw.roles) && raw.roles.length > 0) {
      errors.push("multiplayer.roles are for story mode; in rules mode the rules file decides who is who");
    } else if (!Array.isArray(raw.roles)) {
      errors.push("multiplayer.roles must be a list of { name, id?, entryId?, note? }");
    } else if (raw.roles.length > MAX_ROLES) {
      errors.push(`multiplayer.roles takes at most ${MAX_ROLES} roles`);
    } else {
      const entryIds = new Set((draft.entries ?? []).map((e) => e.id));
      const roles: Record<string, unknown>[] = [];
      const ids = new Set<string>();
      raw.roles.forEach((r, i) => {
        if (!isObject(r)) { errors.push(`multiplayer.roles[${i}] must be an object { name, id?, entryId?, note? }`); return; }
        const name = typeof r.name === "string" ? r.name.trim() : "";
        if (!name) { errors.push(`multiplayer.roles[${i}] needs a name`); return; }
        if (name.length > 40) { errors.push(`multiplayer.roles[${i}].name must be at most 40 characters`); return; }
        let id = typeof r.id === "string" && r.id.trim() ? r.id.trim().slice(0, 64) : slug(name, i);
        if (ids.has(id)) {
          if (typeof r.id === "string" && r.id.trim()) { errors.push(`multiplayer.roles has the id "${id}" twice`); return; }
          let n = 2;
          while (ids.has(`${id}-${n}`)) n++;
          id = `${id}-${n}`;
        }
        ids.add(id);
        const role: Record<string, unknown> = { id, name };
        if (r.entryId !== undefined && r.entryId !== null && r.entryId !== "") {
          if (typeof r.entryId !== "string" || !entryIds.has(r.entryId)) { errors.push(`multiplayer.roles[${i}].entryId "${String(r.entryId)}" is not an entry of this card`); return; }
          role.entryId = r.entryId;
        }
        if (typeof r.note === "string" && r.note.trim()) {
          if (r.note.trim().length > 200) { errors.push(`multiplayer.roles[${i}].note must be at most 200 characters`); return; }
          role.note = r.note.trim();
        }
        roles.push(role);
      });
      if (roles.length) next.roles = roles;
      else delete next.roles;
    }
  }
  if (raw.rolesRequired !== undefined) {
    if (typeof raw.rolesRequired !== "boolean") errors.push("multiplayer.rolesRequired must be true or false");
    else next.rolesRequired = raw.rolesRequired;
  }
  if (mode === "story" && next.rolesRequired === true && !(Array.isArray(next.roles) && next.roles.length)) {
    errors.push("multiplayer.rolesRequired needs at least one role in multiplayer.roles");
  }
  if (mode === "story" && Array.isArray(next.roles) && next.rolesRequired === true && next.roles.length < maxSeats) {
    notes.push(`picking a role is required but there are ${next.roles.length} roles for up to ${maxSeats} seats: a table fills at ${next.roles.length}`);
  }

  // Rules mode: the rules file must already be one of the interface files.
  if (raw.rulesFile !== undefined) {
    if (typeof raw.rulesFile !== "string" || !raw.rulesFile.trim()) errors.push("multiplayer.rulesFile must be a file path such as \"rules.js\"");
    else next.rulesFile = cleanPath(raw.rulesFile);
  } else if (typeof next.rulesFile === "string") {
    next.rulesFile = cleanPath(next.rulesFile);
  }
  if (mode === "rules" && enabled) {
    const files = draft.rootComponent?.files ?? {};
    const path = typeof next.rulesFile === "string" ? next.rulesFile : "";
    if (!path) {
      errors.push("rules mode needs a rules file: write it first as an interface file (write_custom_ui, e.g. rules.js; see load_skill(\"multiplayer\")), check it with check_rules, then pass multiplayer.rulesFile");
    } else if (typeof files[path] !== "string") {
      const js = Object.keys(files).filter((f) => /\.(m?js|cjs)$/.test(f));
      errors.push(`rules mode needs its rules file first: "${path}" is not one of the card's interface files${js.length ? ` (JS files: ${js.slice(0, 8).join(", ")})` : ""}. Write it with write_custom_ui, check it with check_rules, then set multiplayer`);
    }
  }

  // AI seats (rules mode): names and the model they play with.
  const aiRaw = raw.ai !== undefined ? raw.ai : raw.aiModel !== undefined ? { model: raw.aiModel } : undefined;
  if (aiRaw !== undefined) {
    if (aiRaw === null) delete next.ai;
    else if (!isObject(aiRaw)) errors.push("multiplayer.ai must be { names?: string[], model?: string }");
    else {
      const ai: Record<string, unknown> = isObject(stored.ai) ? { ...stored.ai } : {};
      if (aiRaw.names !== undefined) {
        if (!Array.isArray(aiRaw.names) || aiRaw.names.some((n) => typeof n !== "string")) errors.push("multiplayer.ai.names must be a list of names");
        else {
          const names = aiRaw.names.map((n) => (n as string).trim()).filter(Boolean);
          if (names.length > MULTIPLAYER_MAX_SEATS) errors.push(`multiplayer.ai.names takes at most ${MULTIPLAYER_MAX_SEATS} names`);
          else if (names.some((n) => n.length > 24)) errors.push("each multiplayer.ai.names entry must be at most 24 characters");
          else if (names.length) ai.names = names;
          else delete ai.names;
        }
      }
      if (aiRaw.model !== undefined) {
        const model = typeof aiRaw.model === "string" ? aiRaw.model.trim() : aiRaw.model;
        if (model === "" || model === null) delete ai.model;
        else if (typeof model !== "string") errors.push("multiplayer.ai.model must be a model id");
        else {
          const lookup = lookupCatalogModel(model);
          if (lookup.kind === "found") ai.model = lookup.model.id;
          else errors.push(catalogModelError("multiplayer.ai.model", model, lookup));
        }
      }
      if (Object.keys(ai).length) next.ai = ai;
      else delete next.ai;
    }
    if (mode === "story" && isObject(next.ai)) notes.push("ai (AI seat names and model) only applies in rules mode");
  }

  if (errors.length) return { ok: false, errors };
  if (adjusted.length) notes.unshift(`adjusted: ${adjusted.join(", ")}`);
  const read = normaliseMultiplayer(next);
  const summary = !read
    ? "multiplayer off"
    : read.mode === "story"
      ? `multiplayer on: story mode, ${read.minSeats}-${read.maxSeats} seats${read.roles.length ? `, ${read.roles.length} roles${read.rolesRequired ? " (picking one is required)" : ""}` : ""}`
      : `multiplayer on: rules mode (${read.rulesFile}), ${read.minSeats}-${read.maxSeats} seats${read.ai.model ? `, AI seats play on ${read.ai.model}` : ""}. Run check_rules after every change to the rules file`;
  return { ok: true, value: next, notes, summary };
}
