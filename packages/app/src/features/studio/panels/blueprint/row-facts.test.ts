import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { AudioTrack, SceneImage, Variable } from "@yumina/engine";
import { cardMemoryRows, noteSnippet, rowFacts, type RowFactsDraft } from "./row-facts";

const t = (key: string, options?: Record<string, unknown>) => (options?.count !== undefined ? `${key}:${options.count}` : key);
const draft = (parts: Partial<{ variables: Variable[]; audio: AudioTrack[]; images: SceneImage[] }>): RowFactsDraft => ({
  variables: new Map((parts.variables ?? []).map((v) => [v.id, v])),
  audio: new Map((parts.audio ?? []).map((a) => [a.id, a])),
  images: new Map((parts.images ?? []).map((i) => [i.id, i])),
});

test("a note is the author's first sentence, cut to what a row holds", () => {
  assert.equal(noteSnippet(undefined), undefined);
  assert.equal(noteSnippet("   "), undefined);
  assert.equal(noteSnippet("玩家对她好就涨。凶她就掉。"), "玩家对她好就涨。");
  assert.equal(noteSnippet("Goes up when kind.\nGoes down when cruel."), "Goes up when kind.");
  assert.equal(noteSnippet("x".repeat(80)), `${"x".repeat(59)}…`);
});

test("a variable row is its name and value: no kind, tracking or rules on the board", () => {
  const plain: Variable = { id: "hp", name: "生命", type: "number", defaultValue: 100 };
  const tracked: Variable = { id: "love", name: "好感", type: "number", defaultValue: 0, precise: true, behaviorRules: "对她好就涨。凶她就掉。" };
  const d = draft({ variables: [plain, tracked] });
  assert.deepEqual(rowFacts({ id: "var:hp", kind: "variable" }, d, t), {});
  assert.deepEqual(rowFacts({ id: "var:love", kind: "variable" }, d, t), {});
  assert.deepEqual(rowFacts({ id: "var:missing", kind: "variable" }, d, t), {});
});

test("an audio row wears its kind and the cue that lets the AI play it, or says the AI will not", () => {
  const bgm: AudioTrack = { id: "a", name: "林间小调", type: "bgm", url: "x", aiNote: "闲聊的时候放" };
  const sfx: AudioTrack = { id: "b", name: "树枝", type: "sfx", url: "x" };
  const d = draft({ audio: [bgm, sfx] });
  assert.deepEqual(rowFacts({ id: "audio:a", kind: "audio" }, d, t), { tags: [{ text: "audio.trackTypes.bgm" }], note: "闲聊的时候放" });
  assert.deepEqual(rowFacts({ id: "audio:b", kind: "audio" }, d, t), { tags: [{ text: "audio.trackTypes.sfx" }], note: "blueprint.row.audioNoCue", noteQuiet: true });
});

test("a scene image row shows its cue, or says the AI will not show it on its own", () => {
  const auto: SceneImage = { id: "img1", name: "躲雨", url: "x", scene: "下雨了，两人躲到伞下。后来天晴。" };
  const manual: SceneImage = { id: "img2", name: "结局", url: "x", scene: "结局", allowAiControl: false };
  const noCue: SceneImage = { id: "img3", name: "空", url: "x", scene: "  " };
  const d = draft({ images: [auto, manual, noCue] });
  assert.deepEqual(rowFacts({ id: "image:img1", kind: "image" }, d, t), { note: "下雨了，两人躲到伞下。" });
  assert.deepEqual(rowFacts({ id: "image:img2", kind: "image" }, d, t), { note: "blueprint.row.imageManual", noteQuiet: true });
  assert.deepEqual(rowFacts({ id: "image:img3", kind: "image" }, d, t), { note: "blueprint.row.imageManual", noteQuiet: true }, "no sentence, no automatic showing");
  assert.deepEqual(rowFacts({ id: "entry:e", kind: "entry" }, d, t), {}, "other kinds wear nothing");
});

test("the card's memory block says what it remembers and how much it reads; a summary and a pinned note each get a row", () => {
  const plain = cardMemoryRows({ historyLimit: 0 }, t);
  assert.deepEqual(plain.map((row) => [row.key, row.icon, row.text]), [
    ["memory", "memory", "blueprint.ctx.row.memoryCardAlone"],
    ["history", "in", "blueprint.turnCtx.historyAll"],
  ]);
  const windowed = cardMemoryRows({ historyLimit: 20, summary: true, pinned: "Stay in second person." }, t);
  assert.equal(windowed[1].text, "blueprint.turnCtx.historyLimitCard:20");
  assert.equal(windowed[1].title, "entries.historyLimitHint");
  assert.deepEqual(windowed.slice(2).map((row) => row.key), ["summary", "pinned"]);
  assert.equal(windowed[3].title, "Stay in second person.", "the whole note on hover");
  assert.ok(windowed[3].text.startsWith("blueprint.ctx.row.pinnedRow"));
});

test("card memory on its defaults folds to one line; anything changed shows its rows", () => {
  const folded = cardMemoryRows({ historyLimit: 0 }, t, { folded: true });
  assert.deepEqual(folded.map((row) => row.text), ["blueprint.ctx.row.memoryCardAlone"]);
  assert.equal(cardMemoryRows({ historyLimit: 20 }, t, { folded: true }).length, 2);
  assert.equal(cardMemoryRows({ historyLimit: 0, summary: true }, t, { folded: true }).length, 3);
  assert.equal(cardMemoryRows({ historyLimit: 0, pinned: "  " }, t, { folded: true }).length, 1, "a blank note is no note");
});
