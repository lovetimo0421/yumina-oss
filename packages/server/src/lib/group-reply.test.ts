import test from "node:test";
import assert from "node:assert/strict";
import { computeActiveWorldbookIds, replyRoom, type GameState, type WorldDefinition } from "@yumina/engine";
import { buildGroupReplyPrompt, nextVoice, readVoiceAnswer, stripOwnName, voiceTag } from "./group-reply.js";

// A bookshop card: the narrator, a cat living on the card, and a dungeon in
// the attic where a guide and a ghost answer instead of the narrator.
const entry = (id: string, content: string, worldbookId?: string, alwaysSend = true) => ({
  id, name: id, content, worldbookId, enabled: true, keywords: [], conditions: [], conditionLogic: "all",
  section: "system-presets", role: "system", alwaysSend, position: 0,
});
const world = {
  name: "旧书店",
  variables: [{ id: "loc", name: "位置", type: "string", defaultValue: "书店" }],
  entries: [
    entry("w", "一家开在雨巷里的旧书店。"),
    entry("attic-lore", "阁楼里堆满了没人要的旧书。", "attic"),
    entry("cat-self", "你是店里的橘猫，嘴很毒。", "cat"),
    entry("guide-self", "你是阁楼的引路人。", "guide"),
    entry("ghost-self", "你是阁楼里的书灵。", "ghost"),
  ],
  worldbooks: [
    { id: "attic", name: "阁楼", order: 1, activation: { mode: "conditions", conditions: [{ variableId: "loc", operator: "eq", value: "阁楼" }] } },
    { id: "cat", name: "店猫", order: 0, host: "card", activation: { mode: "always" }, station: { kind: "narrator" } },
    { id: "guide", name: "引路人", order: 1, host: "attic", activation: { mode: "always" }, station: { kind: "narrator" } },
    { id: "ghost", name: "书灵", order: 2, host: "attic", activation: { mode: "always" }, station: { kind: "narrator" } },
  ],
} as unknown as WorldDefinition;
const at = (loc: string) => ({ variables: { loc }, turnCount: 1, metadata: {} }) as unknown as GameState;
const row = (role: string, voice: string | null = null, status = "complete") => ({ id: `${role}-${voice}`, role, content: "…", status, voice });

test("group reply: in the shop the narrator answers first, then the cat", () => {
  assert.equal(nextVoice({ world, state: at("书店"), turn: [row("assistant")] })?.id, "cat");
  assert.equal(nextVoice({ world, state: at("书店"), turn: [row("assistant"), row("assistant", "cat")] }), null);
});

test("group reply: in the attic the guide answers first, then the ghost", () => {
  assert.equal(nextVoice({ world, state: at("阁楼"), turn: [row("assistant")] })?.id, "ghost");
});

test("group reply: nobody follows an answer that has not landed", () => {
  assert.equal(nextVoice({ world, state: at("书店"), turn: [] }), null);
  assert.equal(nextVoice({ world, state: at("书店"), turn: [row("assistant", null, "failed")] }), null);
  assert.equal(nextVoice({ world, state: at("书店"), turn: [row("assistant", null, "streaming")] }), null);
});

test("group reply: a voice reads the story, the place and itself — never another voice's own entries", () => {
  const state = at("阁楼");
  const books = world.worldbooks ?? [];
  const room = replyRoom(books, computeActiveWorldbookIds(books, state));
  const ghost = books.find((b) => b.id === "ghost")!;
  const prompt = buildGroupReplyPrompt({
    world, state, voice: ghost, room,
    history: [{ role: "user", content: "有人吗？" }, { role: "assistant", content: "这边走。" }],
  });
  const system = String(prompt[0]!.content);
  assert.match(system, /旧书店/);
  assert.match(system, /阁楼里堆满/);
  assert.match(system, /书灵/);
  assert.doesNotMatch(system, /引路人。/);
  assert.doesNotMatch(system, /橘猫/);
  // The guide's line carries its name, so the ghost does not answer for it.
  assert.equal(prompt[2]!.content, "引路人: 这边走。");
  assert.equal(prompt[prompt.length - 1]!.role, "user");
});

test("group reply: card lore a behaviour switched on reaches the voice; lore switched off does not", () => {
  const standby = { ...entry("secret", "店主其实是猫变的。", undefined, false), enabled: false };
  const card = { ...world, entries: [...world.entries, standby] } as unknown as WorldDefinition;
  const books = card.worldbooks ?? [];
  const base = at("阁楼");
  const room = replyRoom(books, computeActiveWorldbookIds(books, base));
  const ghost = books.find((b) => b.id === "ghost")!;
  const promptFor = (toggledEntries: Record<string, boolean>) => String(buildGroupReplyPrompt({
    world: card, state: { ...base, ruleState: { toggledEntries } } as unknown as GameState, voice: ghost, room,
    history: [{ role: "user", content: "有人吗？" }],
  })[0]!.content);
  assert.doesNotMatch(promptFor({}), /猫变的/);
  assert.match(promptFor({ secret: true }), /猫变的/);
  assert.doesNotMatch(promptFor({ w: false }), /雨巷/);
});

test("group reply: 回复处理 applies to a later voice — its status block is taken out and written", () => {
  const card = {
    ...world,
    variables: [...(world.variables ?? []), { id: "favor", name: "好感", type: "number", defaultValue: 30 }],
    replyRules: [{ id: "status", match: { tag: "状态" }, hide: true, to: [{ kind: "fields" }] }],
  } as unknown as WorldDefinition;
  const out = readVoiceAnswer(card, ["书灵: 「你又来了。」", "<状态>好感: 33</状态>"].join("\n"), "书灵", null);
  assert.equal(out.says, "「你又来了。」");
  assert.doesNotMatch(out.says, /状态/);
  assert.ok(out.parsed.effects.some((e) => (e as { variableId?: string }).variableId === "favor"));
});

test("group reply: the speaker tag goes only over an AI that lives somewhere", () => {
  assert.equal(voiceTag(world, "cat"), "[speaker: 店猫]\n");
  assert.equal(voiceTag(world, "attic"), "");
  assert.equal(voiceTag(world, null), "");
});

test("group reply: a reply that opens with its own name loses it", () => {
  assert.equal(stripOwnName("店猫：喵。", "店猫"), "喵。");
  assert.equal(stripOwnName("**店猫**: 喵。", "店猫"), "喵。");
  assert.equal(stripOwnName("[speaker: 店猫]\n喵。", "店猫"), "喵。");
  assert.equal(stripOwnName("喵。", "店猫"), "喵。");
});
