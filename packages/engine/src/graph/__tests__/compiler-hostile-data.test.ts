import { describe, it, expect } from "vitest";
import { toGraph, applyGraphEdit } from "../compiler.js";
import type { Rule, Variable, WorldDefinition, WorldEntry } from "../../types/index.js";
import type { Reaction } from "../../events/types.js";

// The projection reads persisted JSON, not values the compiler type-checked.
// Cards in the wild carry effect shapes from other branches, older engine
// versions and imports — and the canvas is the Studio's main surface now, so
// a throw here is a white screen for whoever owns that card.

const variable = (over: Partial<Variable> & { id: string }): Variable => ({
  name: over.id, type: "number", defaultValue: 0, ...over,
});

/** A `random-pick` effect, as found on real dev-DB cards: no `path` at all. */
const unknownEffect = {
  type: "random-pick",
  into: "chosen",
  source: "list",
  candidates: ["a", "b"],
} as unknown as Reaction["then"][number];

function reaction(then: Reaction["then"]): Reaction {
  return {
    id: "r1", name: "pick someone", enabled: true, priority: 0,
    when: { eventType: "turn:complete" },
    conditions: [], conditionLogic: "all",
    then,
  };
}

describe("toGraph — hostile persisted data", () => {
  it("survives an effect type it has never heard of", () => {
    const world = {
      variables: [variable({ id: "hp" })],
      rules: [],
      reactions: [reaction([unknownEffect])],
    };
    expect(() => toGraph(world)).not.toThrow();
    const g = toGraph(world);
    expect(g.nodes.find((n) => n.id === "reaction:r1")).toBeDefined();
  });

  it("still projects the effects it does understand alongside an unknown one", () => {
    const g = toGraph({
      variables: [variable({ id: "hp" })],
      rules: [],
      reactions: [reaction([
        unknownEffect,
        { type: "set", path: "hp", value: 1, operation: "add" },
      ])],
    });
    expect(g.edges.some((e) => e.from === "reaction:r1" && e.to === "var:hp")).toBe(true);
  });

  it("survives a set effect whose path is missing", () => {
    const broken = { type: "set", value: 1 } as unknown as Reaction["then"][number];
    expect(() => toGraph({
      variables: [variable({ id: "hp" })], rules: [], reactions: [reaction([broken])],
    })).not.toThrow();
  });

  it("emits one node per duplicated variable id", () => {
    // Variable ids are user-editable and were historically duplicable
    // (2026-07-10 community report) — duplicate React keys break the canvas.
    const g = toGraph({
      variables: [variable({ id: "vows", name: "Vows" }), variable({ id: "vows", name: "Vows copy" })],
      rules: [],
    });
    expect(g.nodes.filter((n) => n.id === "var:vows")).toHaveLength(1);
  });

  it("emits one node per duplicated entry id", () => {
    const dup = (name: string): WorldEntry => ({
      id: "e1", name, content: "", role: "lore", alwaysSend: false,
      keywords: [], conditions: [{ variableId: "hp", operator: "gt", value: 1 }],
      conditionLogic: "all", enabled: true, position: 0, section: "system-presets",
    });
    const g = toGraph({ variables: [variable({ id: "hp" })], rules: [], entries: [dup("a"), dup("b")] });
    expect(g.nodes.filter((n) => n.id === "entry:e1")).toHaveLength(1);
  });

  it("never emits an edge pointing at a node that does not exist", () => {
    const g = toGraph({
      variables: [variable({ id: "hp" })],
      rules: [],
      reactions: [reaction([{ type: "set", path: "ghost_variable", value: 1 }])],
    });
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
  });
});

// 2026-09-06: a batch of generated cards shipped rules with no `trigger`. Every
// turn of those sessions failed, and opening one in the Studio threw out of
// `toGraph` during render — which took the whole page, and /app/worlds/:id/edit
// bounced right back into it, so the author could not reach their card at all.
describe("toGraph — rules whose shape this build cannot read", () => {
  const hp = variable({ id: "hp" });
  /** A Rules-1.0 rule: conditions and effects, no WHEN, no actions. */
  const legacyRule = {
    id: "r1", name: "legacy", priority: 0, enabled: true,
    conditions: [{ variableId: "hp", operator: "gte", value: 1 }],
    effects: [{ variableId: "hp", operation: "add", value: 1 }],
  } as unknown as Rule;

  it("draws a card whose rule has no trigger", () => {
    expect(() => toGraph({ variables: [hp], rules: [legacyRule] })).not.toThrow();
  });

  it("keeps the broken rule as a node instead of dropping it", () => {
    // Dropping it would read as "the editor ate my rule" — the author needs to
    // see the thing that is wrong in order to go fix it.
    const g = toGraph({ variables: [hp], rules: [legacyRule] });
    expect(g.nodes.find((n) => n.id === "rule:r1")).toBeDefined();
  });

  it("records which parts it could not read, so the canvas can say so", () => {
    const g = toGraph({ variables: [hp], rules: [legacyRule] });
    expect(g.nodes.find((n) => n.id === "rule:r1")?.data.shapeIssues).toEqual(["trigger", "actions"]);
  });

  it("leaves a well-formed rule unmarked", () => {
    const ok = {
      id: "r2", name: "fine", priority: 0, enabled: true, conditionLogic: "all",
      trigger: { type: "every-turn" }, conditions: [],
      actions: [{ type: "modify-variable", variableId: "hp", operation: "add", value: 1 }],
    } as unknown as Rule;
    const g = toGraph({ variables: [hp], rules: [ok] });
    expect(g.nodes.find((n) => n.id === "rule:r2")?.data.shapeIssues).toBeUndefined();
    expect(g.edges.some((e) => e.from === "rule:r2" && e.to === "var:hp")).toBe(true);
  });

  it("draws a card whose rules are not even an array", () => {
    expect(() => toGraph({ variables: [hp], rules: null as unknown as Rule[] })).not.toThrow();
  });

  it("skips a null sitting in the rules array", () => {
    const g = toGraph({ variables: [hp], rules: [null as unknown as Rule, legacyRule] });
    expect(g.nodes.filter((n) => n.kind === "rule")).toHaveLength(1);
  });

  it("survives an action that is not an object", () => {
    const r = { ...legacyRule, trigger: { type: "every-turn" }, actions: [null, "x"] } as unknown as Rule;
    expect(() => toGraph({ variables: [hp], rules: [r] })).not.toThrow();
  });

  it("lets the canvas be edited while a broken rule sits on it", () => {
    // Every patch clones every rule, so one unreadable rule must not make each
    // drag throw — otherwise the author cannot work around it either.
    expect(() => applyGraphEdit(
      { variables: [hp], rules: [legacyRule], entries: [] } as unknown as WorldDefinition,
      { op: "remove-edge", edgeId: "e:var:hp->rule:r1" },
    )).not.toThrow();
  });
});
