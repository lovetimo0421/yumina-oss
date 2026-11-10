import assert from "node:assert/strict";
import test from "node:test";
import { blockHostMap, blockHostsMap, buildBoard, toGraph, type WorldDefinition, type WorldEntry } from "@yumina/engine";
import { canvasBlockHostMap, canvasBlockHostsMap, resolveCanvasBlockId, resolveSourceBlockId } from "./canvas-block-hosts";
import { STARTER_IDS, withStarterSlots } from "./starter-board";

const entry = (id: string, extra: Partial<WorldEntry> = {}): WorldEntry => ({ id, name: id, content: "", role: "custom", section: "system-presets", alwaysSend: true, keywords: [], conditions: [], conditionLogic: "all", enabled: true, position: 0, ...extra });
const world = (): WorldDefinition => ({ id: "card", name: "Card", description: "", author: "", version: "1", settings: {}, entries: [], variables: [], rules: [], reactions: [], components: [], customUI: [], audioTracks: [], worldbooks: [] });

test("real opening and setting edges target the stable canvas nodes after invitation replacement", () => {
  const draft = world();
  draft.variables = [{ id: "hp", name: "Health", type: "number", defaultValue: 10 }];
  draft.entries = [
    entry("opening", { role: "greeting", content: "Hello", initialVariables: { hp: 7 } }),
    entry("setting", { content: "Health: {{hp}}" }),
    entry("second", { content: "More setting" }),
  ];
  const graph = toGraph(draft, { foldPlainEntries: false });
  const original = buildBoard(graph);
  const blocks = withStarterSlots(original, true, true);
  const before = structuredClone({ graph, original, blocks });
  const single = canvasBlockHostMap(blocks, graph);
  const multiple = canvasBlockHostsMap(blocks, graph);
  assert.equal(single.get("greeting:opening")!.host, STARTER_IDS.opening);
  assert.equal(single.get("entry:setting")!.host, STARTER_IDS.setting);
  assert.equal(single.get("entry:second")!.host, STARTER_IDS.setting);
  for (const id of ["greeting:opening", "entry:setting", "entry:second"]) {
    assert.equal(single.get(id)!.shown, true);
    assert.deepEqual(multiple.get(id), [single.get(id)]);
  }
  const edges = graph.edges.filter(edge => ["greeting:opening", "entry:setting"].includes(edge.from) || ["greeting:opening", "entry:setting"].includes(edge.to));
  assert.ok(edges.length >= 2, "the actual projection includes opening seeds and the setting's variable read");
  for (const edge of edges) {
    for (const objectId of [edge.from, edge.to]) {
      const host = single.get(objectId);
      assert.ok(host, `${objectId} has a render host`);
      assert.ok(blocks.some(block => block.id === host.host), `${objectId} resolves to a rendered node`);
    }
  }
  assert.deepEqual({ graph, original, blocks }, before);
});

test("alias translation preserves folded and expanded lore visibility from the engine", () => {
  const draft = world();
  draft.entries = Array.from({ length: 4 }, (_, index) => entry(`setting-${index}`));
  const graph = toGraph(draft, { foldPlainEntries: false });
  const original = buildBoard(graph, { rowLimits: { lore: 1 } });
  const blocks = withStarterSlots(original, false, true);
  const source = blockHostMap(original, graph);
  const mapped = canvasBlockHostMap(blocks, graph);
  assert.ok([...source.values()].some(host => !host.shown));
  for (const item of draft.entries) {
    const id = `entry:${item.id}`;
    assert.equal(mapped.get(id)!.host, STARTER_IDS.setting);
    assert.equal(mapped.get(id)!.shown, source.get(id)!.shown);
  }
  const expanded = buildBoard(graph, { expanded: new Set([resolveSourceBlockId(STARTER_IDS.setting, blocks)]), rowLimits: { lore: 1 } });
  const expandedHosts = canvasBlockHostMap(withStarterSlots(expanded, false, true), graph);
  for (const item of draft.entries) assert.equal(expandedHosts.get(`entry:${item.id}`)!.shown, true);
});

test("shared module objects retain all engine hosts and local ownership", () => {
  const draft = world();
  draft.worldbooks = [
    { id: "mine", name: "Mine", activation: { mode: "always" }, order: 0 },
    { id: "sea", name: "Sea", activation: { mode: "always" }, order: 1 },
  ];
  draft.entries = [entry("shared"), entry("local", { worldbookId: "mine" }), entry("opening", { role: "greeting" })];
  draft.variables = [{ id: "hp", name: "Health", type: "number", defaultValue: 10 }];
  const graph = toGraph(draft, { foldPlainEntries: false });
  const original = buildBoard(graph);
  const blocks = withStarterSlots(original, false);
  assert.deepEqual(canvasBlockHostMap(blocks, graph), blockHostMap(original, graph));
  assert.deepEqual(canvasBlockHostsMap(blocks, graph), blockHostsMap(original, graph));
  assert.deepEqual(canvasBlockHostsMap(blocks, graph).get("entry:shared")!.map(host => host.ownerId), ["mine", "sea"]);
  assert.deepEqual(canvasBlockHostsMap(blocks, graph).get("entry:local")!.map(host => host.ownerId), ["mine"]);
});

test("block ids translate in both directions while object ids and empty invitations remain intact", () => {
  const draft = world();
  draft.entries = [entry("opening", { role: "greeting" }), entry("setting")];
  const graph = toGraph(draft, { foldPlainEntries: false });
  const blocks = withStarterSlots(buildBoard(graph), true, true);
  for (const block of blocks) {
    const sourceId = block.sourceBlockId ?? block.id;
    assert.equal(resolveSourceBlockId(block.id, blocks), sourceId);
    assert.equal(resolveCanvasBlockId(sourceId, blocks), block.id);
    assert.equal(resolveCanvasBlockId(block.id, blocks), block.id);
    assert.equal(resolveSourceBlockId(sourceId, blocks), sourceId);
  }
  for (const id of ["greeting:opening", "entry:setting", "block:missing"]) {
    assert.equal(resolveCanvasBlockId(id, blocks), id);
    assert.equal(resolveSourceBlockId(id, blocks), id);
  }
  const emptyGraph = toGraph(world(), { foldPlainEntries: false });
  const invitations = withStarterSlots(buildBoard(emptyGraph), true, true);
  assert.equal(resolveSourceBlockId(STARTER_IDS.setting, invitations), STARTER_IDS.setting);
  assert.equal(resolveCanvasBlockId(STARTER_IDS.opening, invitations), STARTER_IDS.opening);
  assert.equal(canvasBlockHostMap(invitations, emptyGraph).has(STARTER_IDS.opening), false);
});
