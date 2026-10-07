import test from "node:test";
import assert from "node:assert/strict";
import type { AiOutputField, GameState, WorldDefinition } from "@yumina/engine";
import { buildAiCallPrompt, extractJson, findCalledAi, randomFields, routeFields, validateFields } from "./ai-call.js";

const world = {
  name: "雨夜书店",
  variables: [
    { id: "favor", name: "好感度", type: "number", defaultValue: 0 },
    { id: "bag", name: "背包", type: "json", defaultValue: [] },
  ],
  entries: [
    { id: "lore", name: "世界", content: "海边小城，常年下雨。", enabled: true, alwaysSend: true, role: "system" },
    { id: "me", name: "沈霏", content: "沈霏，十九岁，说话快。", enabled: true, alwaysSend: true, role: "system", worldbookId: "phone" },
  ],
  worldbooks: [
    {
      id: "phone", name: "手机", order: 0, host: "card", activation: { mode: "always" },
      station: {
        kind: "worker", name: "沈霏私信", trigger: { on: "ui" }, task: "用沈霏的口吻回私信。",
        sees: { variables: ["favor"], history: 4, ownThread: true },
        pieces: [
          { conditions: [{ variableId: "favor", operator: "gte", value: 60 }], text: "语气更亲近，会主动约见面。" },
          { conditions: [{ variableId: "favor", operator: "lt", value: 0 }], text: "很冷淡。" },
        ],
        output: [
          { name: "text", type: "text", to: { kind: "say" } },
          { name: "mood", type: "choice", options: ["开心", "生气", "冷淡"], to: { kind: "event" } },
          { name: "delta", type: "number", min: -5, max: 5, to: { kind: "variable", variableId: "favor", op: "add" } },
          { name: "gift", type: "list", options: ["伞", "热茶"], to: { kind: "variable", variableId: "bag", op: "push" } },
        ],
        say: "私信",
      },
    },
    { id: "attic", name: "阁楼", order: 1, activation: { mode: "keywords", keywords: ["阁楼"] } },
    { id: "ghost", name: "幽灵", order: 2, host: "attic", activation: { mode: "always" }, station: { kind: "worker", trigger: { on: "ui" }, task: "吓人" } },
  ],
} as unknown as WorldDefinition;
const state = { variables: { favor: 72, bag: [] }, turnCount: 3, metadata: {} } as unknown as GameState;
const fields = (world.worldbooks![0]!.station!.output ?? []) as AiOutputField[];

test("a call finds the AI by station name, situation name or id — only while its place is in play", () => {
  assert.equal(findCalledAi(world, state, "沈霏私信")?.id, "phone");
  assert.equal(findCalledAi(world, state, "手机")?.id, "phone");
  assert.equal(findCalledAi(world, state, "phone")?.id, "phone");
  assert.equal(findCalledAi(world, state, "幽灵"), null, "the attic is shut");
  assert.equal(findCalledAi(world, state, "阁楼"), null, "a place with no AI is not an AI");
});

test("the prompt carries what it sees, only the pieces that hold, its thread, and the JSON it must answer", () => {
  const book = world.worldbooks![0]!;
  const prompt = buildAiCallPrompt({
    world, state, book, station: book.station!, input: "在吗？",
    history: [{ role: "user", content: "我推门进去。" }, { role: "assistant", content: "门铃响了。" }],
    thread: [{ in: "你好", out: "{\"text\":\"嗯？\"}" }],
  });
  const system = String(prompt[0]!.content);
  assert.match(system, /沈霏私信/);
  assert.match(system, /海边小城/);
  assert.match(system, /沈霏，十九岁/);
  assert.match(system, /好感度: 72/);
  assert.match(system, /Player: 我推门进去。/);
  assert.match(system, /语气更亲近/);
  assert.doesNotMatch(system, /很冷淡/);
  assert.match(system, /"mood": one of: "开心", "生气", "冷淡"/);
  assert.match(system, /"delta": number between -5 and 5/);
  assert.deepEqual(prompt.slice(1).map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(prompt[prompt.length - 1]!.content, "在吗？");
});

test("an answer is found inside fences and words, checked, clamped and filtered", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('好的：{"a":2} 就这样'), { a: 2 });
  assert.equal(extractJson("不是 JSON"), undefined);
  const good = validateFields(fields, { text: "在呀", mood: "开心", delta: 9, gift: ["伞", "金条"] });
  assert.deepEqual(good, { ok: true, fields: { text: "在呀", mood: "开心", delta: 5, gift: ["伞"] } });
  assert.equal(validateFields(fields, { text: "在呀", mood: "狂喜", delta: 1, gift: [] }).ok, false, "a choice outside its options fails");
  assert.equal(validateFields(fields, { text: "在呀", delta: 1, gift: [] }).ok, false, "a missing field fails");
});

test("each field goes where it is routed", () => {
  const routed = routeFields(fields, { text: "在呀", mood: "开心", delta: 3, gift: ["伞", "热茶"] });
  assert.equal(routed.say, "在呀");
  assert.deepEqual(routed.events, ["开心"]);
  assert.deepEqual(routed.effects, [
    { variableId: "favor", operation: "add", value: 3 },
    { variableId: "bag", operation: "push", value: "伞" },
    { variableId: "bag", operation: "push", value: "热茶" },
  ]);
});

test("an AI that must move still moves: a random legal option when every try failed", () => {
  const out = randomFields([
    { name: "move", type: "choice", options: ["出牌", "质疑", "跳过"] },
    { name: "bet", type: "number", min: 1, max: 9 },
    { name: "cards", type: "list" },
    { name: "line", type: "text", to: { kind: "say" } },
  ], "……");
  assert.ok(["出牌", "质疑", "跳过"].includes(String(out.move)));
  assert.deepEqual({ bet: out.bet, cards: out.cards, line: out.line }, { bet: 1, cards: [], line: "……" });
});
