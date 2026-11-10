import assert from "node:assert/strict";
import { test } from "node:test";
import { toGraph, worldDefinitionSchema } from "@yumina/engine";
import { getUnmappedSearchPanel, getWorldSearchNode, indexWorldContent, searchWorldContent } from "./world-search";

const world = worldDefinitionSchema.parse({
  id: "test", name: "灰岸", description: "", author: "", settings: {},
  entries: Array.from({ length: 12 }, (_, index) => ({
    id: `lore-${index}`, name: index === 0 ? "锈渊矿坑" : `守卫 ${index}`,
    content: "巷道里积着锈红色的水。", role: "custom", section: "system-presets", worldbookId: index < 6 ? "mine" : "tower",
  })),
  variables: [{ id: "corrosion", name: "侵蚀度", type: "number", defaultValue: 0, worldbookId: "mine" }],
  worldbooks: [{ id: "mine", name: "矿坑", activation: { mode: "always" } }, { id: "tower", name: "迷雾塔", activation: { mode: "always" } }],
});

test("finds authored prose, including matches beyond the former eight-result limit", () => {
  const results = searchWorldContent(indexWorldContent(world), "锈红色");
  assert.equal(results.length, 12);
  assert.equal(results[0]?.id, "entry:lore-0");
  assert.match(results[0]!.excerpt, /锈红色的水/);
});

test("combines module context with text and resolves variable IDs", () => {
  const index = indexWorldContent(world);
  assert.equal(searchWorldContent(index, "矿坑 锈红色").length, 6);
  assert.equal(searchWorldContent(index, "corrosion")[0]?.title, "侵蚀度");
  assert.equal(searchWorldContent(index, "corrosion")[0]?.scope, "矿坑");
  assert.deepEqual(searchWorldContent(index, ""), []);
  assert.deepEqual(searchWorldContent(index, "矿坑 不存在"), []);
});

test("legacy rules remain searchable by name and authored directives", () => {
  const legacy = worldDefinitionSchema.parse({ ...world, rules: [{ id: "old-rule", name: "旧版潮汐", trigger: { type: "session-start" }, conditions: [], conditionLogic: "all", actions: [{ type: "inject-directive", directiveId: "tide", content: "潮水淹没西门" }], priority: 0, enabled: true, worldbookId: "mine" }] });
  const result = searchWorldContent(indexWorldContent(legacy), "淹没西门")[0]!;
  assert.equal(result.id, "rule:old-rule");
  const nodes = new Map(toGraph(legacy).nodes.map(node => [node.id, node]));
  assert.equal(getWorldSearchNode(result, nodes)?.id, "rule:old-rule");
  assert.equal(getUnmappedSearchPanel(result.id, nodes), null);
});

test("an unwired audio track is on the board and search lands on its row", () => {
  // Every track the card has is a graph node now (it used to take a behaviour
  // naming it), so a search hit goes to the row rather than to the audio panel.
  const card = worldDefinitionSchema.parse({ ...world, audioTracks: [{ id: "rain", name: "雨巷环境音", type: "bgm", url: "https://example.invalid/rain.mp3" }] });
  const result = searchWorldContent(indexWorldContent(card), "雨巷")[0]!;
  const nodes = new Map(toGraph(card).nodes.map(node => [node.id, node]));
  assert.equal(nodes.has("audio:rain"), true, "a track need not be wired to a behavior to be on the board");
  assert.equal(getWorldSearchNode(result, nodes)?.title, "雨巷环境音");
  assert.equal(getUnmappedSearchPanel(result.id, nodes), null);
});

test("a behaviour's result shows what it says, not its JSON", () => {
  const withBehavior = {
    ...world,
    reactions: [{
      id: "r1", name: "侵蚀过半", when: { eventType: "turn:complete" }, conditions: [], conditionLogic: "all" as const,
      then: [{ type: "set" as const, path: "@prompt.context", value: "{{corrosion}} 已经过半，矿工开始咳血", operation: "set" as const }],
      priority: 0, enabled: true,
    }],
  };
  const [hit] = searchWorldContent(indexWorldContent(withBehavior), "咳血");
  assert.equal(hit?.id, "reaction:r1");
  assert.doesNotMatch(hit!.excerpt, /@prompt|"value"|\{"/);
  assert.match(hit!.excerpt, /侵蚀度 已经过半/);
});
