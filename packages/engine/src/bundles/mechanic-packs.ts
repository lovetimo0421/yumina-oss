import type { Reaction, ReactionEffect } from "../events/types.js";
import type { Variable, WorldEntry, YuminaBundle } from "../types/index.js";
import { packStrings, type PackStrings } from "./mechanic-pack-strings.js";
import { withPreciseTrackingDefault } from "../state/variable-activation.js";

/**
 * Mechanic packs — a working set of variables, behaviours and lore, installed
 * in one click.
 *
 * They are ordinary `YuminaBundle`s, so installing one runs the same importer
 * a community bundle does: id remapping, name-conflict handling, an entry in
 * `installedBundles` with its own colour on the canvas, and a working uninstall.
 * Nothing here is a parallel mechanism.
 *
 * What they are FOR: a new creator's card ships with zero variables and zero
 * behaviours, because the blank form in front of them asks for a variable name
 * before it will show them what a variable is. A pack answers that by handing
 * them a working one they can read and edit — and unlike the prompt-only
 * presets other platforms ship, these are real engine state, so they keep
 * working when the player switches models.
 */

export const MECHANIC_PACK_IDS = ["affection", "survival", "events", "panel"] as const;
export type MechanicPackId = (typeof MECHANIC_PACK_IDS)[number];

/** What a pack adds, for the picker. Counted from the built bundle rather than
 *  written by hand so the card can never promise four behaviours and install
 *  three. */
export interface MechanicPackSummary {
  id: MechanicPackId;
  name: string;
  description: string;
  gives: string;
  variables: number;
  behaviors: number;
  entries: number;
  /** False for the prompt-only pack. The picker says so, because "the engine
   *  guarantees this" and "the model usually complies" are different promises
   *  and an author deserves to know which one they are buying. */
  deterministic: boolean;
}

// Ids are namespaced per pack and per install-time uniqueness is handled by the
// importer, so these stay readable rather than random.
const vid = (pack: string, key: string) => `pack_${pack}_${key}`;
const rid = (pack: string, key: string) => `pack_${pack}_r_${key}`;
const eid = (pack: string, key: string) => `pack_${pack}_e_${key}`;

function meter(
  pack: string,
  key: string,
  name: string,
  defaultValue: number,
  behaviorRules?: string,
): Variable {
  // Precise tracking on, like every variable made new: a meter a pack adds
  // should move with the story, not wait on the narrator to write a directive.
  return withPreciseTrackingDefault({
    id: vid(pack, key),
    name,
    type: "number",
    defaultValue,
    min: 0,
    max: 100,
    ...(behaviorRules ? { behaviorRules } : {}),
  });
}

function loreEntry(pack: string, key: string, name: string, content: string, position: number): WorldEntry {
  return {
    id: eid(pack, key),
    name,
    content,
    role: "lore",
    // Always-on: a pack's rules are only worth installing if the AI reads them
    // every turn. A keyword-gated rulebook explains the numbers exactly when
    // the player happens to say the magic word, which is never.
    alwaysSend: true,
    keywords: [],
    conditions: [],
    conditionLogic: "all",
    // A pack's rulebook belongs with the card's own lore, which is where
    // system-presets puts it: always sent, above the transcript.
    section: "system-presets",
    enabled: true,
    position,
  };
}

/** "Tell the AI this, once, for this turn." Compiles to the same
 *  `@prompt.directive.*` write the behaviour editor's "Tell the AI" produces,
 *  so an author who opens it sees a normal effect, not pack magic. */
function tellAi(id: string, content: string): ReactionEffect {
  return {
    type: "set",
    path: `@prompt.directive.${id}`,
    value: { content, position: "auto", persistent: false, duration: 1 } as unknown as Record<string, unknown>,
    operation: "set",
  };
}

function reaction(over: Partial<Reaction> & Pick<Reaction, "id" | "name" | "when" | "then">): Reaction {
  return {
    conditions: [],
    conditionLogic: "all",
    priority: 0,
    enabled: true,
    ...over,
  };
}

function buildAffection(s: PackStrings): YuminaBundle | null {
  const a = s.affection;
  if (!a) return null;
  const pack = "affection";
  const affectionId = vid(pack, "affection");
  const trustId = vid(pack, "trust");

  return baseBundle(s, {
    variables: [
      meter(pack, "affection", a.varAffection, 20, a.affectionRules),
      meter(pack, "trust", a.varTrust, 10, a.trustRules),
    ],
    reactions: [
      reaction({
        id: rid(pack, "warm"),
        name: a.onWarm,
        when: { eventType: "message:user", match: { content: { operator: "contains", value: a.warmWords.join(",") } } },
        then: [{ type: "set", path: affectionId, value: 3, operation: "add" }],
      }),
      reaction({
        id: rid(pack, "cold"),
        name: a.onCold,
        when: { eventType: "message:user", match: { content: { operator: "contains", value: a.coldWords.join(",") } } },
        then: [{ type: "set", path: affectionId, value: 2, operation: "subtract" }],
      }),
      reaction({
        id: rid(pack, "time"),
        name: a.onTime,
        when: { eventType: "turn:complete", match: { turnCount: { operator: "every", value: 10 } } },
        then: [{ type: "set", path: trustId, value: 1, operation: "add" }],
      }),
      reaction({
        id: rid(pack, "threshold"),
        name: a.onThreshold,
        // Crossing, not "is above": a threshold that re-fires every turn while
        // the number stays high turns one story beat into nagging.
        when: { eventType: "state:crossed", match: { variableId: { operator: "eq", value: affectionId }, direction: { operator: "eq", value: "above" }, threshold: { operator: "eq", value: 60 } } },
        then: [tellAi(rid(pack, "threshold"), a.thresholdDirective)],
        maxFireCount: 1,
      }),
    ],
    entries: [loreEntry(pack, "stages", a.stagesTitle, a.stagesContent, 0)],
  });
}

function buildSurvival(s: PackStrings): YuminaBundle | null {
  const v = s.survival;
  if (!v) return null;
  const pack = "survival";
  const hunger = vid(pack, "hunger");
  const thirst = vid(pack, "thirst");
  const stamina = vid(pack, "stamina");

  return baseBundle(s, {
    variables: [
      meter(pack, "hunger", v.varHunger, 70, v.hungerRules),
      meter(pack, "thirst", v.varThirst, 70),
      meter(pack, "stamina", v.varStamina, 80),
      meter(pack, "warmth", v.varWarmth, 70),
    ],
    reactions: [
      reaction({
        id: rid(pack, "tick"),
        name: v.tickName,
        when: { eventType: "turn:complete" },
        then: [
          { type: "set", path: hunger, value: 2, operation: "subtract" },
          { type: "set", path: thirst, value: 3, operation: "subtract" },
          { type: "set", path: stamina, value: 1, operation: "subtract" },
        ],
      }),
      reaction({
        id: rid(pack, "low"),
        name: v.lowName,
        when: { eventType: "turn:complete" },
        // Any of the three, so one behaviour covers the whole set rather than
        // three near-identical copies the author has to keep in sync.
        conditions: [
          { variableId: hunger, operator: "lt", value: 20 },
          { variableId: thirst, operator: "lt", value: 20 },
          { variableId: stamina, operator: "lt", value: 20 },
        ],
        conditionLogic: "any",
        then: [tellAi(rid(pack, "low"), v.lowDirective)],
        cooldownTurns: 3,
      }),
      reaction({
        id: rid(pack, "critical"),
        name: v.criticalName,
        when: { eventType: "turn:complete" },
        conditions: [
          { variableId: hunger, operator: "lte", value: 0 },
          { variableId: thirst, operator: "lte", value: 0 },
          { variableId: stamina, operator: "lte", value: 0 },
        ],
        conditionLogic: "any",
        then: [tellAi(rid(pack, "critical"), v.criticalDirective)],
        priority: 10,
        cooldownTurns: 2,
      }),
    ],
    entries: [loreEntry(pack, "rules", v.rulesTitle, v.rulesContent, 0)],
  });
}

function buildEvents(s: PackStrings): YuminaBundle | null {
  const e = s.events;
  if (!e) return null;
  const pack = "events";

  return baseBundle(s, {
    variables: [],
    reactions: [
      reaction({
        id: rid(pack, "weather"),
        name: e.weatherName,
        when: { eventType: "turn:complete" },
        then: [tellAi(rid(pack, "weather"), e.weatherDirective)],
        chance: 5,
        cooldownTurns: 6,
      }),
      reaction({
        id: rid(pack, "passerby"),
        name: e.passerbyName,
        when: { eventType: "turn:complete" },
        then: [tellAi(rid(pack, "passerby"), e.passerbyDirective)],
        chance: 12,
        cooldownTurns: 4,
      }),
      reaction({
        id: rid(pack, "beat"),
        name: e.beatName,
        when: { eventType: "turn:complete", match: { turnCount: { operator: "every", value: 8 } } },
        then: [tellAi(rid(pack, "beat"), e.beatDirective)],
      }),
    ],
    entries: [loreEntry(pack, "note", e.noteTitle, e.noteContent, 0)],
  });
}

function buildPanel(s: PackStrings): YuminaBundle | null {
  const p = s.panel;
  if (!p) return null;
  const pack = "panel";

  return baseBundle(s, {
    variables: [],
    reactions: [
      reaction({
        id: rid(pack, "panel"),
        name: p.behaviorName,
        when: { eventType: "turn:complete" },
        // Persistent: the shape has to be in front of the model on every turn,
        // not just the one where it fired.
        then: [{
          type: "set",
          path: `@prompt.directive.${rid(pack, "panel")}`,
          value: { content: p.directive, position: "auto", persistent: true } as unknown as Record<string, unknown>,
          operation: "set",
        }],
        maxFireCount: 1,
      }),
    ],
    entries: [],
  });
}

function baseBundle(
  s: PackStrings,
  content: { variables: Variable[]; reactions: Reaction[]; entries: WorldEntry[] },
): YuminaBundle {
  return {
    bundleVersion: "3.0.0",
    name: s.name,
    description: s.description,
    tags: [],
    createdAt: new Date(0).toISOString(),
    entries: content.entries,
    variables: content.variables,
    // Behaviours ride in `reactions` only. A bundle that filled both arrays
    // would fire every behaviour twice — the runtime evaluates both.
    rules: [],
    reactions: content.reactions,
    audioTracks: [],
  };
}

const BUILDERS: Record<MechanicPackId, (s: PackStrings) => YuminaBundle | null> = {
  affection: buildAffection,
  survival: buildSurvival,
  events: buildEvents,
  panel: buildPanel,
};

/** The installable bundle for one pack, in the author's language. */
export function mechanicPack(id: MechanicPackId, language?: string): YuminaBundle | null {
  return BUILDERS[id](packStrings(id, language));
}

/** Everything the picker needs, counted off the real bundles. */
export function mechanicPackSummaries(language?: string): MechanicPackSummary[] {
  return MECHANIC_PACK_IDS.flatMap((id) => {
    const bundle = mechanicPack(id, language);
    if (!bundle) return [];
    const strings = packStrings(id, language);
    return [{
      id,
      name: bundle.name,
      description: bundle.description,
      gives: strings.gives,
      variables: bundle.variables.length,
      behaviors: bundle.reactions?.length ?? 0,
      entries: bundle.entries.length,
      deterministic: bundle.variables.length > 0,
    }];
  });
}
