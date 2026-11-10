import { describe, it, expect } from "vitest";
import { filterEntriesByActiveWorldbooks, isMemberActive, UNPLACED_WORLDBOOK_ID } from "../worldbook.js";
import { toGraph } from "../../graph/compiler.js";
import { blockId, buildBoard } from "../../graph/board.js";
import type { GameState, Worldbook, WorldDefinition, WorldEntry } from "../../types/index.js";

// Added from the canvas with nothing selected, or dragged out of every frame:
// the object stands outside, faded, and is in play nowhere until it is
// dragged onto the card or into a situation.

const state = {
  worldId: "w", variables: {}, turnCount: 0, flags: {}, history: [],
  ruleState: { activeDirectives: [], cooldowns: {}, fireCounts: {}, prevVars: {}, toggledEntries: {}, toggledWorldbooks: {} },
} as unknown as GameState;
const entry = (id: string, worldbookId?: string): WorldEntry =>
  ({ id, name: id, content: id, role: "custom", alwaysSend: true, enabled: true, keywords: [], conditions: [], conditionLogic: "all", position: 0, section: "system-presets", ...(worldbookId ? { worldbookId } : {}) }) as unknown as WorldEntry;
const book: Worldbook = { id: "a", name: "A", order: 0, activation: { mode: "always" } };

describe("outside every frame", () => {
  it("is never in play, with or without situations on the card", () => {
    expect(isMemberActive(UNPLACED_WORLDBOOK_ID, [], state)).toBe(false);
    expect(isMemberActive(UNPLACED_WORLDBOOK_ID, [book], state)).toBe(false);
    expect(isMemberActive(undefined, [book], state)).toBe(true);
  });

  it("is left out of what the AI reads", () => {
    const all = [entry("card"), entry("outside", UNPLACED_WORLDBOOK_ID), entry("inA", "a")];
    expect(filterEntriesByActiveWorldbooks(all, undefined, state).map((e) => e.id)).toEqual(["card", "inA"]);
    expect(filterEntriesByActiveWorldbooks(all, [book], state).map((e) => e.id)).toEqual(["card", "inA"]);
  });

  it("is drawn on the canvas by itself, outside every frame", () => {
    const world = { id: "w", name: "W", entries: [entry("outside", UNPLACED_WORLDBOOK_ID)], variables: [], rules: [], reactions: [], worldbooks: [book], settings: {} } as unknown as WorldDefinition;
    const graph = toGraph(world);
    expect(graph.nodes.find((n) => n.id === "entry:outside")?.parentId).toBe(`module:${UNPLACED_WORLDBOOK_ID}`);
    const blocks = buildBoard(graph, { cardFrame: true });
    const loose = blocks.find((b) => b.id === blockId.loose("entry:outside"));
    expect(loose?.loose).toBe(true);
    expect(blocks.some((b) => b.ownerId === UNPLACED_WORLDBOOK_ID && !b.loose)).toBe(false);
  });
});
