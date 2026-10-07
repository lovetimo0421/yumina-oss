import { describe, it, expect } from "vitest";
import { diffGraphs } from "../graph-diff.js";
import type { CardGraph, GraphNode, GraphEdge } from "../types.js";

const n = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({
  id, kind: "variable", title: id, ports: [], data: {}, ...over,
});
const e = (id: string, from: string, to: string, over: Partial<GraphEdge> = {}): GraphEdge => ({
  id, from, fromPort: "read", to, toPort: "write", ...over,
});
const g = (nodes: GraphNode[], edges: GraphEdge[] = []): CardGraph => ({ nodes, edges });

describe("diffGraphs", () => {
  it("reports nothing for an unchanged graph", () => {
    const graph = g([n("var:a")], [e("x", "var:a", "var:a")]);
    const d = diffGraphs(graph, g([n("var:a")], [e("x", "var:a", "var:a")]));
    expect(d.isEmpty).toBe(true);
    expect(d).toMatchObject({ addedNodes: [], changedNodes: [], addedEdges: [] });
    expect(d.removedNodes).toEqual([]);
    expect(d.removedEdges).toEqual([]);
    expect(graph.nodes).toHaveLength(1); // inputs untouched
  });

  it("names what was added", () => {
    const d = diffGraphs(g([n("var:a")]), g([n("var:a"), n("var:b")], [e("x", "var:a", "var:b")]));
    expect(d.addedNodes).toEqual(["var:b"]);
    expect(d.addedEdges).toEqual(["x"]);
    expect(d.isEmpty).toBe(false);
  });

  it("keeps removed objects whole so they can be shown as ghosts", () => {
    const gone = n("var:b", { title: "Doomed" });
    const d = diffGraphs(g([n("var:a"), gone], [e("x", "var:a", "var:b")]), g([n("var:a")]));
    expect(d.removedNodes.map((x) => x.title)).toEqual(["Doomed"]);
    expect(d.removedEdges.map((x) => x.id)).toEqual(["x"]);
  });

  it("does not call a folded group changed when its members were only added", () => {
    const fold = (count: number) => n("core-entries", { kind: "entry", title: "Core entries", data: { count, drillTarget: "lorebook" } });
    const d = diffGraphs(g([fold(15)]), g([fold(17), n("entry:a", { kind: "entry" }), n("entry:b", { kind: "entry" })]));
    expect(d.addedNodes).toEqual(["entry:a", "entry:b"]);
    expect(d.changedNodes).toEqual([]);
  });

  it("catches a rename", () => {
    const d = diffGraphs(g([n("var:a", { title: "Old" })]), g([n("var:a", { title: "New" })]));
    expect(d.changedNodes).toEqual(["var:a"]);
  });

  it("catches a data change regardless of key order", () => {
    const before = g([n("var:a", { data: { variableId: "a", readByUi: true } })]);
    const same = g([n("var:a", { data: { readByUi: true, variableId: "a" } })]);
    expect(diffGraphs(before, same).isEmpty).toBe(true);

    const after = g([n("var:a", { data: { variableId: "a" } })]);
    expect(diffGraphs(before, after).changedNodes).toEqual(["var:a"]);
  });

  it("counts a move into a module as a change", () => {
    const d = diffGraphs(g([n("var:a")]), g([n("var:a", { parentId: "module:B" })]));
    expect(d.changedNodes).toEqual(["var:a"]);
  });

  it("counts a port change as a change", () => {
    const before = g([n("frontend", { ports: [] })]);
    const after = g([n("frontend", { ports: [{ id: "read:a", type: "state", direction: "in" }] })]);
    expect(diffGraphs(before, after).changedNodes).toEqual(["frontend"]);
  });

  it("ignores a pure edge-label rewrite on an id that stayed", () => {
    // Edge identity is the id; the label rides along and the canvas re-reads it.
    const d = diffGraphs(g([], [e("x", "a", "b", { label: "≤ 5" })]), g([], [e("x", "a", "b", { label: "≤ 9" })]));
    expect(d.addedEdges).toEqual([]);
    expect(d.removedEdges).toEqual([]);
  });

  it("totals the change count for a summary line", () => {
    const d = diffGraphs(
      g([n("var:a"), n("var:b")], [e("x", "var:a", "var:b")]),
      g([n("var:a", { title: "renamed" }), n("var:c")]),
    );
    expect(d.addedNodes).toEqual(["var:c"]);
    expect(d.removedNodes.map((x) => x.id)).toEqual(["var:b"]);
    expect(d.changedNodes).toEqual(["var:a"]);
    expect(d.removedEdges.map((x) => x.id)).toEqual(["x"]);
    expect(d.total).toBe(4);
  });
});
