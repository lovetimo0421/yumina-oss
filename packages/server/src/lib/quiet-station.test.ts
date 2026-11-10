import test from "node:test";
import assert from "node:assert/strict";
import type { GameState, WorldDefinition } from "@yumina/engine";
import { buildQuietPrompt, calledSpeaker, dueQuietSpeaker, quietSpeakers, worldHasQuietStations } from "./quiet-station.js";

const world = {
  name: "灰岸",
  variables: [
    { id: "loc", name: "位置", type: "string", defaultValue: "主世界" },
    { id: "rust", name: "侵蚀度", type: "number", defaultValue: 0 },
  ],
  entries: [
    { id: "e1", name: "矿壁", content: "矿壁在渗锈水。", worldbookId: "wall", enabled: true, keywords: [], conditions: [], conditionLogic: "all", section: "system-presets", role: "system", alwaysSend: true, position: 0 },
  ],
  worldbooks: [
    { id: "mine", name: "副本A", order: 0, activation: { mode: "conditions", conditions: [{ variableId: "loc", operator: "eq", value: "副本A" }] } },
    {
      id: "wall", name: "矿壁", order: 1,
      activation: { mode: "conditions", conditions: [{ variableId: "loc", operator: "eq", value: "副本A" }] },
      station: { kind: "worker", trigger: { on: "quiet", seconds: 45 }, task: "玩家在矿里待着不动时，让侵蚀度涨一点并提一句。" },
    },
    { id: "clerk", name: "记录官", order: 2, activation: { mode: "always" }, station: { kind: "worker", trigger: { on: "turns", every: 3 }, task: "记一笔" } },
  ],
} as unknown as WorldDefinition;
const at = (loc: string) => ({ variables: { loc, rust: 0 }, turnCount: 3, metadata: {} }) as unknown as GameState;

test("quiet stations: only active ones with a task are in the room", () => {
  assert.equal(worldHasQuietStations(world), true);
  assert.deepEqual(quietSpeakers(world, at("主世界")).map((s) => s.book.id), []);
  assert.deepEqual(quietSpeakers(world, at("副本A")).map((s) => s.book.id), ["wall"]);
});

test("quiet stations: due only after N quiet seconds since the later of the last message and its own last turn", () => {
  const speakers = quietSpeakers(world, at("副本A"));
  const now = 1_000_000;
  assert.equal(dueQuietSpeaker({ speakers, lastRuns: {}, lastMessageAt: now - 30_000, now }), null, "30s is not 45s");
  assert.equal(dueQuietSpeaker({ speakers, lastRuns: {}, lastMessageAt: now - 50_000, now })?.speaker.book.id, "wall");
  assert.equal(
    dueQuietSpeaker({ speakers, lastRuns: { wall: new Date(now - 10_000).toISOString() }, lastMessageAt: now - 120_000, now }),
    null,
    "it just had its turn",
  );
});

test("quiet stations: the prompt carries its own entries, its job and a way to stay silent", () => {
  const speaker = quietSpeakers(world, at("副本A"))[0]!;
  const prompt = buildQuietPrompt({ world, state: at("副本A"), speaker, history: [{ role: "user", content: "我下到矿里" }], quietSeconds: 47 });
  const system = String(prompt[0]!.content);
  assert.match(system, /矿壁在渗锈水/);
  assert.match(system, /侵蚀度涨一点/);
  assert.match(system, /\[silent\]/);
  assert.match(system, /47 seconds/);
});

test("quiet stations: lines about the prompt are not narration", async () => {
  const { stripStageNotes } = await import("./quiet-station.js");
  assert.equal(stripStageNotes("[20 seconds have passed. Nothing has happened.]"), "");
  assert.equal(stripStageNotes("（30秒过去了）\n矿壁又渗出一层锈水。"), "矿壁又渗出一层锈水。");
  assert.equal(stripStageNotes("assistant\n\n锈水漫过脚背。"), "锈水漫过脚背。");
  assert.equal(stripStageNotes("[侵蚀度: add 4]\n锈水漫过脚背。"), "[侵蚀度: add 4]\n锈水漫过脚背。", "directives are left for the parser");
});

test("a UI-based AI runs when the player's screen calls it — by id or name — and only while its place is in play", () => {
  const called = {
    ...world,
    worldbooks: [
      ...(world.worldbooks ?? []),
      { id: "phone", name: "手机", order: 3, host: "card", activation: { mode: "always" }, station: { kind: "worker", trigger: { on: "ui" }, task: "回一条短信。" } },
      { id: "radio", name: "电台", order: 4, host: "mine", activation: { mode: "always" }, station: { kind: "worker", trigger: { on: "ui" }, task: "播一段。" } },
      { id: "mute", name: "哑巴", order: 5, host: "card", activation: { mode: "always" }, station: { kind: "worker", trigger: { on: "ui" } } },
    ],
  } as unknown as WorldDefinition;
  assert.equal(calledSpeaker(called, at("主世界"), "phone")?.book.id, "phone");
  assert.equal(calledSpeaker(called, at("主世界"), "手机")?.called, true, "by name too");
  assert.equal(calledSpeaker(called, at("主世界"), "radio"), null, "its scenario is not on");
  assert.equal(calledSpeaker(called, at("副本A"), "radio")?.book.id, "radio");
  assert.equal(calledSpeaker(called, at("主世界"), "mute"), null, "no job, nothing to do");
  assert.equal(calledSpeaker(called, at("副本A"), "wall"), null, "a quiet station is not called");
  const prompt = buildQuietPrompt({ world: called, state: at("主世界"), speaker: calledSpeaker(called, at("主世界"), "phone")!, history: [], quietSeconds: 0 });
  assert.match(String(prompt[0]!.content), /called on you/);
  assert.doesNotMatch(String(prompt[0]!.content), /nothing has happened for/);
});
