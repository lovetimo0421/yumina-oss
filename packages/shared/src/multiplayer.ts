/**
 * A card's multiplayer setting (settings.multiplayer), normalised.
 * Off unless the author turned it on. Two modes:
 *  - "story": friends share one session; the card's AI narrates merged rounds.
 *  - "rules": the card's own rules file runs on game-rt; empty seats can be AI.
 * Older rules cards stored `{ mode: "rules", rulesFile, minSeats, maxSeats, aiModel }`
 * without `enabled`; those count as on. A bare `{ roomId }` (the Krew sea) is not
 * this feature.
 */
export const MULTIPLAYER_MIN_SEATS = 2;
export const MULTIPLAYER_MAX_SEATS = 12;
export const MULTIPLAYER_DEFAULT_SEATS = { min: 2, max: 6 } as const;

export type MultiplayerMode = "story" | "rules";

export interface MultiplayerRole {
  id: string;
  name: string;
  /** A 角色和世界 entry this role plays, when the author linked one. */
  entryId?: string;
  note?: string;
  /** The role's picture (`@asset:` ref or URL); a linked character's portrait otherwise. */
  image?: string;
}

export interface MultiplayerSettings {
  enabled: boolean;
  mode: MultiplayerMode;
  minSeats: number;
  maxSeats: number;
  roles: MultiplayerRole[];
  rolesRequired: boolean;
  rulesFile: string | null;
  ai: { names: string[]; model: string | null };
}

const clampSeats = (n: unknown, fallback: number) => {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : fallback;
  return Math.min(MULTIPLAYER_MAX_SEATS, Math.max(MULTIPLAYER_MIN_SEATS, v));
};
const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** Normalise whatever is stored at settings.multiplayer. Returns null when off. */
export function readMultiplayer(world: { settings?: unknown } | { schema?: { settings?: unknown } | null } | null | undefined): MultiplayerSettings | null {
  const settings = (world && "schema" in world ? world.schema?.settings : (world as { settings?: unknown } | null | undefined)?.settings) as
    | { multiplayer?: unknown }
    | undefined;
  return normaliseMultiplayer(settings?.multiplayer);
}

export function normaliseMultiplayer(raw: unknown): MultiplayerSettings | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  const legacyRules = m.enabled === undefined && m.mode === "rules";
  if (m.enabled !== true && !legacyRules) return null;
  const mode: MultiplayerMode = m.mode === "rules" ? "rules" : "story";
  const min = clampSeats(m.minSeats, MULTIPLAYER_DEFAULT_SEATS.min);
  const max = Math.max(min, clampSeats(m.maxSeats, MULTIPLAYER_DEFAULT_SEATS.max));
  const roles: MultiplayerRole[] = [];
  const seen = new Set<string>();
  if (Array.isArray(m.roles)) {
    for (const r of m.roles.slice(0, MULTIPLAYER_MAX_SEATS * 2)) {
      if (!r || typeof r !== "object") continue;
      const id = str((r as { id?: unknown }).id, 64);
      const name = str((r as { name?: unknown }).name, 40);
      if (!id || !name || seen.has(id)) continue;
      seen.add(id);
      const entryId = str((r as { entryId?: unknown }).entryId, 64);
      const note = str((r as { note?: unknown }).note, 200);
      const image = str((r as { image?: unknown }).image, 500);
      roles.push({ id, name, ...(entryId ? { entryId } : {}), ...(note ? { note } : {}), ...(image ? { image } : {}) });
    }
  }
  const ai = (m.ai && typeof m.ai === "object" ? m.ai : {}) as { names?: unknown; model?: unknown };
  const names = Array.isArray(ai.names) ? ai.names.map((n) => str(n, 24)).filter((n): n is string => !!n).slice(0, MULTIPLAYER_MAX_SEATS) : [];
  return {
    enabled: true,
    mode,
    minSeats: min,
    maxSeats: max,
    roles: mode === "story" ? roles : [],
    rolesRequired: mode === "story" && roles.length > 0 && m.rolesRequired === true,
    rulesFile: mode === "rules" ? str(m.rulesFile, 200) : null,
    ai: { names, model: str(ai.model, 120) ?? str(m.aiModel, 120) },
  };
}
