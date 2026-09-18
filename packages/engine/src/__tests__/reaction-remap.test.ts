import { describe, it, expect } from "vitest";
import { remapReactionReferences } from "../reactions/remap.js";
import type { Reaction } from "../events/types.js";
import type { ReactionIdRemap } from "../reactions/remap.js";

// Destination world renamed `hp`→`hp_2` and `loot`→`loot_2` (name collisions),
// gave every entry/behavior a fresh uuid, and left `gold` untouched.
const remap: ReactionIdRemap = {
  variableId: (id) => ({ hp: "hp_2", loot: "loot_2", npcs: "npcs_2" })[id] ?? id,
  entryId: (id) => (id === "entry-old" ? "entry-new" : id),
  reactionId: (id) => (id === "beh-old" ? "beh-new" : id),
};

const base: Reaction = {
  id: "r1",
  name: "test",
  when: { eventType: "state:changed" },
  conditions: [],
  conditionLogic: "all",
  then: [],
  priority: 0,
  enabled: true,
};

describe("remapReactionReferences", () => {
  it("rewrites the watched variable in a state:changed pattern", () => {
    const out = remapReactionReferences(
      { ...base, when: { eventType: "state:changed", match: { variableId: { operator: "eq", value: "hp" } } } },
      remap,
    );
    expect(out.when.match?.variableId?.value).toBe("hp_2");
  });

  it("rewrites condition variables", () => {
    const out = remapReactionReferences(
      { ...base, conditions: [{ variableId: "hp", operator: "lt", value: 10 }] },
      remap,
    );
    expect(out.conditions[0]!.variableId).toBe("hp_2");
  });

  it("rewrites a plain effect target", () => {
    const out = remapReactionReferences(
      { ...base, then: [{ type: "set", path: "hp", value: 5, operation: "add" }] },
      remap,
    );
    expect((out.then[0] as { path: string }).path).toBe("hp_2");
  });

  it("rewrites only the ROOT of a dot-path into a JSON variable", () => {
    const out = remapReactionReferences(
      { ...base, then: [{ type: "set", path: "npcs.aria.affinity", value: 3, operation: "add" }] },
      remap,
    );
    expect((out.then[0] as { path: string }).path).toBe("npcs_2.aria.affinity");
  });

  it("rewrites the entry id inside a toggle-entry path", () => {
    const out = remapReactionReferences(
      { ...base, then: [{ type: "set", path: "@prompt.entry.entry-old", value: true, operation: "set" }] },
      remap,
    );
    expect((out.then[0] as { path: string }).path).toBe("@prompt.entry.entry-new");
  });

  it("rewrites the behavior id inside a toggle-behavior path", () => {
    const out = remapReactionReferences(
      { ...base, then: [{ type: "set", path: "@rules.disabled.beh-old", value: true, operation: "set" }] },
      remap,
    );
    expect((out.then[0] as { path: string }).path).toBe("@rules.disabled.beh-new");
  });

  it("leaves id-free system paths alone", () => {
    const out = remapReactionReferences(
      { ...base, then: [{ type: "set", path: "@ui.notification", value: "hi", operation: "set" }] },
      remap,
    );
    expect((out.then[0] as { path: string }).path).toBe("@ui.notification");
  });

  it("rewrites a variable operand (valueRef)", () => {
    const out = remapReactionReferences(
      { ...base, then: [{ type: "set", path: "gold", value: 0, operation: "subtract", valueRef: "hp" }] },
      remap,
    );
    expect((out.then[0] as { valueRef: string }).valueRef).toBe("hp_2");
  });

  it("rewrites candidatesVar/historyVar on a random list source", () => {
    const out = remapReactionReferences(
      {
        ...base,
        then: [{
          type: "set", path: "gold", value: 0, operation: "set",
          valueRandom: { kind: "list", candidatesVar: "loot", historyVar: "hp", cooldown: 2 },
        }],
      },
      remap,
    );
    const spec = (out.then[0] as { valueRandom: { candidatesVar: string; historyVar: string; cooldown: number } }).valueRandom;
    expect(spec.candidatesVar).toBe("loot_2");
    expect(spec.historyVar).toBe("hp_2");
    expect(spec.cooldown).toBe(2); // untouched fields survive
  });

  it("leaves unmapped ids and emit payloads untouched", () => {
    const out = remapReactionReferences(
      {
        ...base,
        then: [
          { type: "set", path: "gold", value: 1, operation: "add" },
          { type: "emit", event: { type: "ui:notification", message: "hp" } },
        ],
      },
      remap,
    );
    expect((out.then[0] as { path: string }).path).toBe("gold");
    expect(out.then[1]).toEqual({ type: "emit", event: { type: "ui:notification", message: "hp" } });
  });

  it("does not touch the reaction's own id — the caller allocates it", () => {
    expect(remapReactionReferences(base, remap).id).toBe("r1");
  });
});
