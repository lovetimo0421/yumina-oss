import { describe, it, expect } from "vitest";
import { toGraph } from "../compiler.js";
import type { Worldbook, WorldDefinition } from "../../types/index.js";

/**
 * The projection must not put words in the creator's language on the canvas.
 *
 * It shipped labelling every station wire in Chinese — 记忆·亲历, 产出,
 * 关闭时唤醒 — so an English, Spanish or Japanese creator's board was written
 * in a language they may not read. The engine is framework-agnostic and has no
 * i18n; a wire it names itself has to arrive as a key the app resolves.
 *
 * The rule is narrow on purpose. A label that is the creator's OWN data (an
 * operation, a channel name, a value) is not translatable and belongs in
 * `label`; only wires the projection names go through `labelKey`.
 */
const world = (worldbooks: Worldbook[]): WorldDefinition =>
  ({
    id: "w", name: "W", description: "", entries: [], variables: [], reactions: [],
    worldbooks,
  }) as unknown as WorldDefinition;

const dungeon: Worldbook = { id: "d1", name: "Dungeon", order: 0, activation: { mode: "always" } };
const chronicler: Worldbook = {
  id: "chr",
  name: "Chronicler",
  order: 1,
  activation: { mode: "always" },
  station: {
    kind: "worker",
    inputs: [
      { kind: "memory", from: "d1", as: "history" },
      { kind: "transcript", from: "d1", as: "lore", limit: 8 },
    ],
    trigger: { on: "module-closed", from: "d1" },
  },
} as unknown as Worldbook;
const next: Worldbook = {
  id: "d2",
  name: "Next dungeon",
  order: 2,
  activation: { mode: "always" },
  station: { kind: "narrator", inputs: [{ kind: "worker", from: "chr", as: "lore" }] },
} as unknown as Worldbook;

describe("the projection speaks no human language", () => {
  const graph = toGraph(world([dungeon, chronicler, next]));
  const wires = graph.edges.filter((e) => e.from.startsWith("module:") && e.to.startsWith("module:"));

  it("draws a wire for every context input and for the trigger", () => {
    expect(wires).toHaveLength(4);
  });

  it("names those wires with keys, never with prose", () => {
    for (const e of wires) {
      expect(e.labelKey, `${e.id} must carry a key`).toBeTruthy();
      expect(e.label, `${e.id} must not carry prose`).toBeUndefined();
    }
    expect(wires.map((e) => e.labelKey).sort()).toEqual([
      "contextWire.memory.history",
      "contextWire.transcript.lore",
      "contextWire.wakeOnClose",
      "contextWire.worker.lore",
    ]);
  });

  it("puts no CJK anywhere in the graph", () => {
    // The whole projection, not just the wires: a label, a node title or a
    // port name in one language is the same bug wherever it hides.
    const cjk = /[぀-ヿ一-鿿]/;
    const offenders = JSON.stringify(graph)
      .split(/[",]/)
      .filter((s) => cjk.test(s));
    expect(offenders).toEqual([]);
  });
});
