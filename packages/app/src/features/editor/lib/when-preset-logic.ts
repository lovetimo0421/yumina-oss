import type { EventPattern } from "@yumina/engine";

/**
 * Structural subset of the behaviors editor's WhenPreset that the pure
 * preset-resolution logic needs (kept UI-free so it can be unit tested).
 */
export interface WhenPresetLike {
  id: string;
  eventType: string;
  fields?: Array<{ name: string; operator?: string; placeholder?: string }>;
}

/**
 * Fields whose operator is "every" are what distinguish a preset from a
 * sibling sharing the same eventType (e.g. "Every N turns" vs "Every Turn",
 * both `turn:complete`). We call these marker fields.
 */
function markerFields(preset: WhenPresetLike) {
  return (preset.fields ?? []).filter((f) => f.operator === "every");
}

/**
 * Resolve which preset a saved `when` pattern belongs to.
 *
 * Presets can share an eventType, so the pattern's match keys disambiguate:
 * a `turn:complete` pattern with a `turnCount` match is "Every N turns";
 * without it, it's "Every Turn".
 */
export function resolveWhenPreset<T extends WhenPresetLike>(
  presets: T[],
  when: EventPattern,
): T | null {
  const candidates = presets.filter((p) => p.eventType === when.eventType);
  if (candidates.length <= 1) return candidates[0] ?? null;

  const matchKeys = Object.keys(when.match ?? {});
  if (matchKeys.length === 0) {
    // No match fields — this is the bare variant (e.g. "Every Turn"), never
    // a preset that requires a marker field to mean anything.
    return candidates.find((p) => markerFields(p).length === 0) ?? candidates[0]!;
  }
  return (
    candidates.find((p) => p.fields?.some((f) => matchKeys.includes(f.name))) ??
    candidates[0]!
  );
}

/**
 * Build the `when` pattern for a freshly selected preset.
 *
 * Marker fields are seeded immediately with a sane default (the field's
 * placeholder). Without this, selecting "Every N turns" wrote a bare
 * `{ eventType: "turn:complete" }`, which resolveWhenPreset reads back as
 * "Every Turn" — the picker snapped back, the N input never appeared, and the
 * saved behavior silently fired every turn (community bug report).
 */
export function buildWhenForPreset(preset: WhenPresetLike): EventPattern {
  const match: NonNullable<EventPattern["match"]> = {};
  for (const f of markerFields(preset)) {
    const fallback = Number(f.placeholder);
    match[f.name] = {
      operator: "every",
      value: Number.isFinite(fallback) && fallback > 0 ? fallback : 2,
    };
  }
  return Object.keys(match).length > 0
    ? { eventType: preset.eventType, match }
    : { eventType: preset.eventType };
}
