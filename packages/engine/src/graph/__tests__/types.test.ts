import { describe, it, expect } from "vitest";
import type { CardGraph, GraphPatch } from "../types.js";

describe("graph types", () => {
  it("constructs a minimal CardGraph", () => {
    const g: CardGraph = {
      nodes: [{ id: "var:hp", kind: "variable", title: "hp", ports: [], data: { variableId: "hp" } }],
      edges: [],
    };
    expect(g.nodes[0]!.kind).toBe("variable");
  });

  it("constructs an add-edge patch", () => {
    const p: GraphPatch = {
      op: "add-edge",
      edge: { id: "e1", from: "rule:r1", fromPort: "effect", to: "var:hp", toPort: "write", label: "+1" },
    };
    expect(p.op).toBe("add-edge");
  });
});
