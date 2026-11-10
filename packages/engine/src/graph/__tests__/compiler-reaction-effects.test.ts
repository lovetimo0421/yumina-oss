import { describe, it, expect } from "vitest";
import { toGraph, applyGraphEdit } from "../compiler.js";
import type { WorldDefinition, WorldEntry, Variable } from "../../types/index.js";
import type { Reaction } from "../../events/types.js";

// Reaction system effects the canvas must not hide: @prompt.entry toggles,
// @audio plays/stops, and emit→listener chains.

function entry(overrides: Partial<WorldEntry> & { id: string }): WorldEntry {
  return {
    name: overrides.id, content: "", role: "lore", alwaysSend: false,
    keywords: [], conditions: [], conditionLogic: "all", enabled: true,
    position: 0, section: "system-presets",
    ...overrides,
  };
}

function reaction(overrides: Partial<Reaction> & { id: string; then: Reaction["then"] }): Reaction {
  return {
    name: overrides.id, when: { eventType: "turn:complete" },
    conditions: [], conditionLogic: "all", priority: 0, enabled: true,
    ...overrides,
  };
}

const hp: Variable = { id: "hp", name: "hp", type: "number", defaultValue: 100 };

const RT = reaction({
  id: "RT",
  then: [
    { type: "set", path: "@prompt.entry.E1", value: false },
    { type: "set", path: "@prompt.entry.E1", value: "nope" }, // non-boolean: inert engine-side
  ],
});
const RA = reaction({
  id: "RA",
  then: [
    { type: "set", path: "@audio.bgm", value: "storm" },
    { type: "set", path: "@audio.stop", value: "storm" },
  ],
});
const RE = reaction({ id: "RE", when: { eventType: "message:user" }, then: [{ type: "emit", event: { type: "boss:phase2" } }] });
const RL = reaction({ id: "RL", when: { eventType: "boss:phase2" }, then: [] });
const RW = reaction({ id: "RW", when: { eventType: "boss:*" }, then: [] });
const RG = reaction({
  id: "RG",
  then: [{ type: "set", path: "@vars.enabled.hp", value: false }],
});

function makeWorld(): WorldDefinition {
  return {
    variables: [hp],
    rules: [],
    reactions: [RT, RA, RE, RL, RW, RG],
    entries: [entry({ id: "E1" }), entry({ id: "E2" })],
    worldbooks: [],
  } as unknown as WorldDefinition;
}

describe("toGraph — reaction system effects", () => {
  const graph = toGraph(makeWorld());
  const node = (id: string) => graph.nodes.find((n) => n.id === id);
  const edgesFromTo = (from: string, to: string) =>
    graph.edges.filter((e) => e.from === from && e.to === to);

  it("projects @prompt.entry toggles as reaction→entry edges and materializes the target", () => {
    expect(node("entry:E1")).toBeDefined();
    const es = edgesFromTo("reaction:RT", "entry:E1");
    expect(es).toHaveLength(1); // the non-boolean toggle draws nothing
    expect(es[0]).toMatchObject({ fromPort: "effect", toPort: "gate", label: "lock" });
    expect(es[0]!.id).toBe("e:reaction:RT->entry:E1:0");
  });

  it("keeps a toggled entry out of the core-entries fold", () => {
    const fold = node("core-entries");
    expect(fold?.data.count).toBe(1); // only E2 folds
  });

  it("projects @audio effects as reaction→audio edges with play/stop labels", () => {
    expect(node("audio:storm")).toBeDefined();
    const es = edgesFromTo("reaction:RA", "audio:storm");
    expect(es.map((e) => e.label).sort()).toEqual(["bgm", "stop"]);
    expect(es.map((e) => e.id).sort()).toEqual([
      "e:reaction:RA->audio:storm:0",
      "e:reaction:RA->audio:storm:1",
    ]);
  });

  it("projects emit→listener chains as reaction→reaction edges (exact and wildcard)", () => {
    const toRL = edgesFromTo("reaction:RE", "reaction:RL");
    expect(toRL).toHaveLength(1);
    expect(toRL[0]).toMatchObject({ fromPort: "effect", toPort: "trigger", label: "boss:phase2" });
    expect(edgesFromTo("reaction:RE", "reaction:RW")).toHaveLength(1);
  });

  it("suppresses the synthetic event-source node for chain-fed listeners", () => {
    expect(node("evt:boss:phase2")).toBeUndefined();
    expect(graph.edges.filter((e) => e.from.startsWith("evt:") && e.to === "reaction:RL")).toHaveLength(0);
    // the emitter itself still triggers from its real event source
    expect(graph.edges.filter((e) => e.from === "evt:message:user" && e.to === "reaction:RE")).toHaveLength(1);
  });
});

describe("applyGraphEdit — reaction effect edges", () => {
  it("add-edge reaction→entry appends an unlock toggle effect", () => {
    const out = applyGraphEdit(makeWorld(), {
      op: "add-edge",
      edge: { id: "", from: "reaction:RT", fromPort: "effect", to: "entry:E2", toPort: "gate" },
    });
    const r = out.reactions!.find((x) => x.id === "RT")!;
    expect(r.then.at(-1)).toEqual({ type: "set", path: "@prompt.entry.E2", value: true });
  });

  it("remove-edge reaction→entry removes the exact toggle effect", () => {
    const out = applyGraphEdit(makeWorld(), { op: "remove-edge", edgeId: "e:reaction:RT->entry:E1:0" });
    const r = out.reactions!.find((x) => x.id === "RT")!;
    expect(r.then).toHaveLength(1);
    expect(r.then[0]!.type === "set" && r.then[0]!.value).toBe("nope");
  });

  it("remove-edge reaction→entry with a stale index is a no-op", () => {
    const out = applyGraphEdit(makeWorld(), { op: "remove-edge", edgeId: "e:reaction:RA->entry:E1:0" });
    expect(out.reactions!.find((x) => x.id === "RA")!.then).toHaveLength(2);
  });

  it("remove-edge reaction→audio removes the exact audio effect", () => {
    const out = applyGraphEdit(makeWorld(), { op: "remove-edge", edgeId: "e:reaction:RA->audio:storm:1" });
    const r = out.reactions!.find((x) => x.id === "RA")!;
    expect(r.then).toHaveLength(1);
    expect(r.then[0]).toMatchObject({ path: "@audio.bgm" });
  });

  it("remove-edge deletes a @vars.enabled toggle edge (prefix-normalized guard)", () => {
    const out = applyGraphEdit(makeWorld(), { op: "remove-edge", edgeId: "e:reaction:RG->var:hp:0" });
    expect(out.reactions!.find((x) => x.id === "RG")!.then).toHaveLength(0);
  });
});
