import { test } from "node:test";
import assert from "node:assert/strict";
import { castingChoices, detectSpeakerNames, mergeSegments, poolFor, resolveAssignments, splitRuns } from "./cast.js";
import { TTS_VOICES, readTtsVoicePool, sanitizeTtsVoicePool } from "@yumina/shared";

test("splitRuns separates narration from quoted dialogue and reassembles exactly", () => {
  const text = "天亮了。法官：「现在从 5 号开始发言。」老猎户拍桌子：「3 号得说清楚！」\n绣娘低着头。";
  const runs = splitRuns(text, false);
  assert.equal(runs.map((r) => r.text).join(""), text);
  assert.deepEqual(runs.map((r) => r.kind), ["narration", "dialogue", "narration", "dialogue", "narration"]);
  assert.equal(runs[1]!.text, "「现在从 5 号开始发言。」");
});

test("splitRuns: an unclosed quote is still dialogue; dialogue-only text is one run per line", () => {
  assert.deepEqual(splitRuns("他说：「等等", false).map((r) => r.kind), ["narration", "dialogue"]);
  const runs = splitRuns("第一句\n第二句", true);
  assert.deepEqual(runs.map((r) => r.text), ["第一句\n", "第二句"]);
  assert.ok(runs.every((r) => r.kind === "dialogue"));
});

test("detectSpeakerNames finds the names the prose attributes lines to", () => {
  const names = detectSpeakerNames("法官：「开始。」\n【铁匠】我没杀人。\n老猎户拍着桌子大声说：「他撒谎！」她笑道：「好啊。」");
  assert.deepEqual(names, ["法官", "铁匠", "老猎户"]);
  assert.deepEqual(detectSpeakerNames("\"Stay,\" Mia whispered."), ["Mia"]);
  const werewolf = [
    "天亮了。昨晚，4 号倒在了井边。",
    "法官：「现在从 5 号开始发言。」",
    "老猎户拍着桌子站起来：「3 号一大早就在井边转悠，他得说清楚！」",
    "铁匠冷笑一声：「我在铺子里打了一夜铁，整条街都听得见。」",
    "绣娘低着头，小声说：「……我觉得 6 号太稳了。」",
    "角落里的卖花女突然开口：「我昨晚看见一个人影。」",
  ].join("\n");
  assert.deepEqual(detectSpeakerNames(werewolf), ["法官", "铁匠", "老猎户", "绣娘", "卖花女"]);
});

test("resolveAssignments gives different speakers different voices while any are left", () => {
  const out = resolveAssignments(
    [
      { name: "铁匠", probabilities: { deep: 0.9, steady: 0.1 } },
      { name: "老猎户", probabilities: { deep: 0.6, young: 0.3 } },
    ],
    ["deep", "steady", "young"],
  );
  assert.deepEqual(out, { 铁匠: "deep", 老猎户: "young" });
  // No answer at all still yields a stable voice from the pool.
  const a = resolveAssignments([{ name: "X", probabilities: {} }], ["v1", "v2"]);
  const b = resolveAssignments([{ name: "X", probabilities: {} }], ["v1", "v2"]);
  assert.deepEqual(a, b);
});

test("mergeSegments joins consecutive runs in one voice and drops empty ones", () => {
  const segs = mergeSegments([
    { voice: "n", plain: "天亮了。", spoken: "天亮了。" },
    { voice: "n", plain: "\n", spoken: "\n" },
    { voice: "a", plain: "「好。」", spoken: "[happy]「好。」" },
    { voice: "n", plain: "  ", spoken: "  " },
  ]);
  assert.deepEqual(segs, [
    { voice: "n", plain: "天亮了。\n", spoken: "天亮了。\n" },
    { voice: "a", plain: "「好。」", spoken: "[happy]「好。」" },
  ]);
});

test("the voice pool follows the card language, else the text", () => {
  assert.ok(poolFor("zh-Hant", "").length >= 10);
  assert.ok(poolFor(null, "先輩！見てください").every((v) => v.id.length === 32));
  assert.notDeepEqual(poolFor(null, "hello"), poolFor(null, "你好"));
});

// ── The player's voice pool ─────────────────────────────────────────
const zhIds = TTS_VOICES.filter((v) => v.lang === "zh").map((v): string => v.id);
const enIds = TTS_VOICES.filter((v) => v.lang === "en").map((v): string => v.id);
const ids = (pool: Array<{ id: string }>) => pool.map((v) => v.id);

test("the pool is the player's selection in the card language", () => {
  const selection = [zhIds[2]!, enIds[0]!, zhIds[7]!];
  assert.deepEqual(ids(poolFor("zh", "", selection)), [zhIds[2], zhIds[7]]);
  assert.deepEqual(ids(poolFor("en", "", selection)), [enIds[0]]);
});

test("nothing selected, or nothing in the card language, means every voice of it", () => {
  assert.deepEqual(ids(poolFor("zh", "", [])), zhIds);
  assert.deepEqual(ids(poolFor("zh", "", [enIds[0]!, enIds[1]!])), zhIds);
  assert.deepEqual(ids(poolFor(null, "你好", [enIds[0]!])), zhIds);
});

test("a custom voice id the player added is usable in any card language", () => {
  const custom = "0123456789abcdef0123456789abcdef";
  assert.deepEqual(ids(poolFor("ja", "", [custom, enIds[0]!])), [custom]);
});

test("more speakers than selected voices share the selection, never step outside it", () => {
  const pool = poolFor("zh", "", [zhIds[0]!, zhIds[1]!]);
  // Both taken by earlier speakers, three new speakers need a voice.
  const choices = castingChoices(pool, new Set([zhIds[0]!, zhIds[1]!]), undefined, 3);
  assert.deepEqual(ids(choices), [zhIds[0], zhIds[1]]);
  const cast = resolveAssignments(["甲", "乙", "丙"].map((name) => ({ name, probabilities: {} })), ids(choices));
  assert.equal(Object.keys(cast).length, 3);
  for (const v of Object.values(cast)) assert.ok([zhIds[0], zhIds[1]].includes(v));
  // A one-voice pool that also narrates still casts inside itself.
  assert.deepEqual(ids(castingChoices(poolFor("zh", "", [zhIds[0]!]), new Set([zhIds[0]!]), zhIds[0], 2)), [zhIds[0]]);
});

test("unused selected voices go first", () => {
  const pool = poolFor("zh", "", [zhIds[0]!, zhIds[1]!, zhIds[2]!]);
  assert.deepEqual(ids(castingChoices(pool, new Set([zhIds[0]!]), undefined, 2)), [zhIds[1], zhIds[2]]);
});

test("the stored pool: validated, and an old single voice reads as a pool of one", () => {
  assert.deepEqual(readTtsVoicePool({}), []);
  assert.deepEqual(readTtsVoicePool({ ttsVoice: "" }), []);
  assert.deepEqual(readTtsVoicePool({ ttsVoice: zhIds[2] }), [zhIds[2]]);
  assert.deepEqual(readTtsVoicePool({ ttsVoice: zhIds[2], ttsVoicePool: [] }), []);
  assert.deepEqual(sanitizeTtsVoicePool([zhIds[0], "nope", zhIds[0], 7, zhIds[1]!.toUpperCase()]), [zhIds[0], zhIds[1]]);
  assert.deepEqual(sanitizeTtsVoicePool("x"), []);
});
