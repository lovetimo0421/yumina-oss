import test from "node:test";
import assert from "node:assert/strict";
import type { Effect, WorldDefinition } from "@yumina/engine";
import { liveSceneMessage, normalizeLiveScene, takeStoryEvents } from "./live-scene.js";

const world = { variables: [{ id: "suspicion", name: "怀疑度", type: "number", defaultValue: 0 }] } as unknown as WorldDefinition;

test("live scene: an object becomes readable lines, events keep their name and when", () => {
  const scene = normalizeLiveScene({
    scene: { 房间: "厨房", 在镜头里: false, 最后看见: { 位置: "厨房门口", 秒前: 41 } },
    events: [{ name: "派警察进门", when: "玩家离开镜头太久" }, { name: "" }, "bad"],
  })!;
  assert.match(scene.text, /房间: 厨房/);
  assert.match(scene.text, /在镜头里: false/);
  assert.match(scene.text, /位置: 厨房门口/);
  assert.deepEqual(scene.events, [{ name: "派警察进门", when: "玩家离开镜头太久" }]);
  const block = liveSceneMessage(scene).content;
  assert.match(block, /\[event: 派警察进门\] — 玩家离开镜头太久/);
});

test("live scene: nothing usable is no scene", () => {
  assert.equal(normalizeLiveScene(null), null);
  assert.equal(normalizeLiveScene({ scene: "  " }), null);
  assert.equal(normalizeLiveScene("a string alone"), null);
});

test("live scene: offered events come out of the effects, other writes stay", () => {
  const scene = normalizeLiveScene({ events: [{ name: "派警察进门" }] });
  const effects: Effect[] = [
    { variableId: "event", operation: "set", value: "派警察进门" },
    { variableId: "suspicion", operation: "add", value: 10 },
    { variableId: "event", operation: "set", value: "放烟花" },
  ];
  assert.deepEqual(takeStoryEvents(effects, world, scene), ["派警察进门"]);
  assert.deepEqual(effects.map((e) => e.variableId), ["suspicion"], "an event the game did not offer is dropped, not written");
});

test("live scene: a card with a real `event` variable keeps its writes", () => {
  const own = { variables: [{ id: "event", name: "事件", type: "string", defaultValue: "" }] } as unknown as WorldDefinition;
  const effects: Effect[] = [{ variableId: "event", operation: "set", value: "派警察进门" }];
  assert.deepEqual(takeStoryEvents(effects, own, normalizeLiveScene({ events: [{ name: "派警察进门" }] })), []);
  assert.equal(effects.length, 1);
});
