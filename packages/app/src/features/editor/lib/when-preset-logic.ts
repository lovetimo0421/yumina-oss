import type { EventPattern } from "@yumina/engine";

/**
 * Structural subset of the behaviors editor's WhenPreset that the pure
 * preset-resolution logic needs (kept UI-free so it can be unit tested).
 */
export interface WhenPresetLike {
  id: string;
  eventType: string;
  fields?: Array<{ name: string; operator?: string; placeholder?: string; type?: string; options?: Array<{ value: string; label: string }> }>;
}

/**
 * The values of a saved `when` pattern as the creator reads them.
 *
 * A "variable changed" trigger stores the variable's id, which is a UUID —
 * the behaviours list used to print it verbatim. A variable reads as its
 * name, a picked option as its label, anything else as typed.
 */
export function describeWhenValues(
  preset: WhenPresetLike,
  match: EventPattern["match"],
  variables: ReadonlyArray<{ id: string; name: string }>,
): string[] {
  return Object.entries(match ?? {}).flatMap(([key, m]) => {
    const raw = m?.value;
    if (raw === undefined || raw === null || raw === "") return [];
    const field = preset.fields?.find((f) => f.name === key);
    if (field?.type === "variable" || key === "variableId") {
      const v = variables.find((x) => x.id === String(raw));
      return [v?.name?.trim() || String(raw)];
    }
    if (field?.type === "select") {
      return [field.options?.find((o) => o.value === String(raw))?.label ?? String(raw)];
    }
    return [String(raw)];
  });
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
