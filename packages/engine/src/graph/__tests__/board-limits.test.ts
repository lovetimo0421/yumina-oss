import { describe, it, expect } from "vitest";
import { BLOCK_ROW_LIMIT, blockId, buildBoard } from "../board.js";
import type { CardGraph, GraphNode } from "../types.js";

const node = (id: string, kind: GraphNode["kind"], data: Record<string, unknown> = {}): GraphNode => ({
  id,
  kind,
  title: id,
  ports: [],
  data,
});
const graph = (nodes: GraphNode[]): CardGraph => ({ nodes, edges: [] });
const world = node("world:root", "world");

// A chip is a fraction of a row, so a board drawn as chips can show far more
// before it folds. The caller says how many; the default is unchanged.
describe("buildBoard row limits", () => {
  const many = Array.from({ length: 20 }, (_, i) => node(`var:v${i}`, "variable"));

  it("folds at the default limit when none is given", () => {
    const state = buildBoard(graph([world, ...many])).find((b) => b.id === blockId.state())!;
    expect(state.rows).toHaveLength(BLOCK_ROW_LIMIT.state);
    expect(state.hiddenCount).toBe(20 - BLOCK_ROW_LIMIT.state);
  });

  it("folds at the caller's limit instead", () => {
    const state = buildBoard(graph([world, ...many]), { rowLimits: { state: 16 } }).find((b) => b.id === blockId.state())!;
    expect(state.rows).toHaveLength(16);
    expect(state.hiddenCount).toBe(4);
  });

  it("a limit for one kind leaves the others at their defaults", () => {
    const entries = Array.from({ length: 9 }, (_, i) => node(`entry:e${i}`, "entry", { trigger: "always" }));
    const blocks = buildBoard(graph([world, ...many, ...entries]), { rowLimits: { state: 16 } });
    expect(blocks.find((b) => b.id === blockId.lore("always"))!.rows).toHaveLength(BLOCK_ROW_LIMIT.lore);
  });
});
