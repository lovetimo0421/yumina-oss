import type { Reaction, ReactionEffect, EventPattern } from "../events/types.js";

/**
 * Rewrites for every kind of id a Reaction can point at. Each mapper returns
 * the id to use in the destination world, or the id unchanged when it has no
 * mapping (references outside the copied set stay as-is).
 */
export interface ReactionIdRemap {
  variableId: (id: string) => string;
  entryId: (id: string) => string;
  /** Behavior ids, targeted by the toggle-behavior effect (`@rules.disabled.<id>`). */
  reactionId: (id: string) => string;
}

/**
 * An effect path is either system state or a game variable:
 *   `@prompt.entry.<entryId>`     → toggle an entry
 *   `@rules.disabled.<behavior>`  → toggle a behavior
 *   `@…` (anything else)          → system state with no embedded id
 *   `hp`, `npcs.aria.affinity`    → a variable; a dot-path's ROOT is the id
 */
function remapEffectPath(path: string, remap: ReactionIdRemap): string {
  if (path.startsWith("@prompt.entry.")) {
    return `@prompt.entry.${remap.entryId(path.slice("@prompt.entry.".length))}`;
  }
  if (path.startsWith("@rules.disabled.")) {
    return `@rules.disabled.${remap.reactionId(path.slice("@rules.disabled.".length))}`;
  }
  if (path.startsWith("@")) return path;
  const [root = "", ...rest] = path.split(".");
  return [remap.variableId(root), ...rest].join(".");
}

function remapEffect(effect: ReactionEffect, remap: ReactionIdRemap): ReactionEffect {
  // `emit` effects carry an opaque event payload — no variable/entry ids to rewrite.
  if (effect.type !== "set") return effect;

  const random =
    effect.valueRandom?.kind === "list"
      ? {
          ...effect.valueRandom,
          ...(effect.valueRandom.candidatesVar
            ? { candidatesVar: remap.variableId(effect.valueRandom.candidatesVar) }
            : {}),
          ...(effect.valueRandom.historyVar
            ? { historyVar: remap.variableId(effect.valueRandom.historyVar) }
            : {}),
        }
      : effect.valueRandom;

  return {
    ...effect,
    path: remapEffectPath(effect.path, remap),
    ...(effect.valueRef ? { valueRef: remap.variableId(effect.valueRef) } : {}),
    ...(random ? { valueRandom: random } : {}),
  };
}

/** `state:changed`/`state:crossed` patterns filter on the watched variable's id. */
function remapEventPattern(when: EventPattern, remap: ReactionIdRemap): EventPattern {
  const watched = when.match?.variableId;
  return {
    ...when,
    ...(when._legacyTrigger?.variableId ? { _legacyTrigger: {
      ...when._legacyTrigger,
      variableId: remap.variableId(when._legacyTrigger.variableId),
    } } : {}),
    ...(watched && typeof watched.value === "string" ? { match: {
      ...when.match,
      variableId: { ...watched, value: remap.variableId(watched.value) },
    } } : {}),
  };
}

/**
 * Rewrite every id a Reaction references so it keeps working after being copied
 * into another world (bundle import), where variables/entries/behaviors may have
 * been given fresh ids to avoid collisions.
 *
 * Rewrites references only — the reaction's OWN `id` is the caller's to set,
 * since only the caller knows the destination's id allocation.
 */
export function remapReactionReferences(reaction: Reaction, remap: ReactionIdRemap): Reaction {
  return {
    ...reaction,
    when: remapEventPattern(reaction.when, remap),
    conditions: (reaction.conditions ?? []).map((c) => ({
      ...c,
      variableId: remap.variableId(c.variableId),
    })),
    then: (reaction.then ?? []).map((e) => remapEffect(e, remap)),
  };
}
