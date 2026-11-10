import { describe, it, expect } from "vitest";
import { toGraph } from "../compiler.js";
import { blockHostMap, buildBoard } from "../board.js";
import type { Variable, WorldDefinition, Worldbook } from "../../types/index.js";
import type { Reaction } from "../../events/types.js";

/**
 * An event source lives in the frame of the behaviour it fires.
 *
 * It is not an object the creator made — it has no content beyond "this fires
 * that" — so it never becomes a row. It exists to anchor one wire. When it was
 * pinned to the card while the only behaviour listening for it sat inside a
 * module, the card built no behaviours block, the source had nowhere to
 * anchor, and the board dropped the wire in silence: the creator saw a
 * behaviour with nothing triggering it.
 */

const reaction = (overrides: Partial<Reaction> & { id: string }): Reaction => ({
  name: overrides.id,
  when: { eventType: "session:start" },
  conditions: [],
  conditionLogic: "all",
  priority: 0,
  enabled: true,
  then: [{ type: "set", path: "hp", value: 2 }],
  ...overrides,
});

const book = (id: string): Worldbook => ({
  id, name: id, order: 0, activation: { mode: "always" },
});

const hp: Variable = { id: "hp", name: "hp", type: "number", defaultValue: 1 };

const world = (reactions: Reaction[], worldbooks: Worldbook[]): WorldDefinition =>
  ({
    id: "w", name: "w", description: "",
    worldbooks, variables: [hp], reactions,
    lorebook: { entries: [] }, firstMessages: [],
  }) as unknown as WorldDefinition;

/** Wires the board would refuse to draw, because an end has no host block. */
function droppedWires(w: WorldDefinition): string[] {
  const graph = toGraph(w, { foldPlainEntries: false });
  const hosts = blockHostMap(buildBoard(graph), graph);
  return graph.edges
    .filter((e) => !hosts.get(e.from) || !hosts.get(e.to))
    .map((e) => `${e.from}->${e.to}`);
}

describe("event source ownership", () => {
  it("follows a behaviour into its module, so the trigger wire survives", () => {
    const w = world([reaction({ id: "r1", worldbookId: "m1" })], [book("m1")]);
    const graph = toGraph(w, { foldPlainEntries: false });
    const evt = graph.nodes.find((n) => n.kind === "event");

    expect(evt?.parentId).toBe("module:m1");
    expect(droppedWires(w)).toEqual([]);
  });

  it("stays on the card when listeners disagree about where they live", () => {
    // A card-level listener guarantees a card-level behaviours block exists,
    // which is the only host that can serve both ends.
    const w = world(
      [reaction({ id: "r1", worldbookId: "m1" }), reaction({ id: "r2" })],
      [book("m1")],
    );
    const graph = toGraph(w, { foldPlainEntries: false });
    const evt = graph.nodes.find((n) => n.kind === "event");

    expect(evt?.parentId).toBeUndefined();
    expect(droppedWires(w)).toEqual([]);
  });

  it("keeps two modules' sources apart rather than sharing one node", () => {
    const w = world(
      [
        reaction({ id: "r1", worldbookId: "m1" }),
        reaction({ id: "r2", worldbookId: "m2", when: { eventType: "turn:complete" } }),
      ],
      [book("m1"), book("m2")],
    );
    const graph = toGraph(w, { foldPlainEntries: false });
    const owners = graph.nodes
      .filter((n) => n.kind === "event")
      .map((n) => [n.id, n.parentId] as const)
      .sort();

    expect(owners).toEqual([
      ["evt:session:start", "module:m1"],
      ["evt:turn:complete", "module:m2"],
    ]);
    expect(droppedWires(w)).toEqual([]);
  });

  it("treats a module that does not exist as the card, never as a ghost frame", () => {
    const w = world([reaction({ id: "r1", worldbookId: "gone" })], []);
    const graph = toGraph(w, { foldPlainEntries: false });

    expect(graph.nodes.find((n) => n.kind === "event")?.parentId).toBeUndefined();
    expect(droppedWires(w)).toEqual([]);
  });
});
