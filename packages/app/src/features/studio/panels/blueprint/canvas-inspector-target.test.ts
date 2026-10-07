import assert from "node:assert/strict";
import test from "node:test";
import { blockId, buildBoard, toGraph, type WorldDefinition } from "@yumina/engine";
import { resolveCanvasInspectorNode } from "./canvas-inspector-target";

test("memory blocks route to their real module without adding or changing graph entities", () => {
  const world: WorldDefinition = { id: "card", name: "Card", description: "", author: "", version: "1", settings: {}, entries: [], variables: [], rules: [], reactions: [], components: [], customUI: [], audioTracks: [], worldbooks: [
    { id: "a:scene", name: "A", order: 0, activation: { mode: "always" }, station: { kind: "narrator", memoryPool: "pool", inputs: [{ kind: "transcript", from: "b", limit: 7, as: "lore" }] } },
    { id: "b", name: "B", order: 1, activation: { mode: "always" } },
  ] };
  const original = structuredClone(world);
  const graph = toGraph(world);
  const memory = buildBoard(graph).filter(block => block.kind === "context");
  assert.equal(memory.length, 2, "plain modules also retain their memory entry point");
  for (const block of memory) {
    assert.equal(block.id, blockId.context(block.ownerId));
    const resolved = resolveCanvasInspectorNode(block.id, graph.nodes);
    assert.equal(resolved?.section, "memory");
    assert.equal(resolved?.node, graph.nodes.find(node => node.id === `module:${block.ownerId}`));
    assert.equal(graph.nodes.some(node => node.id === block.id), false, "a memory block is presentation only");
  }
  assert.equal(resolveCanvasInspectorNode("module:a:scene", graph.nodes)?.section, undefined);
  assert.equal(resolveCanvasInspectorNode(blockId.context("removed"), graph.nodes), null);
  assert.equal(resolveCanvasInspectorNode(blockId.context("b"), graph.nodes.filter(node => node.id !== "module:b")), null);
  assert.ok(graph.edges.some(edge => edge.from === "module:b" && edge.to === "module:a:scene"), "context wires keep canonical module endpoints");
  assert.deepEqual(world, original);
});
