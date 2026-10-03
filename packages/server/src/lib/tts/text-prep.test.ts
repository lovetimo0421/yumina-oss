import { strict as assert } from "node:assert";
import { test } from "node:test";
import { prepareTtsText, extractDialogue, stripMarkupForTts, truncateAtBoundary } from "./text-prep.js";

test("full mode strips roleplay asterisks but keeps the narration", () => {
  const out = prepareTtsText("*她低下头* “我不是故意的。” 她的声音很轻。", "full");
  assert.equal(out, "她低下头 “我不是故意的。” 她的声音很轻。");
});

test("dialogue mode keeps only quoted spans, in order", () => {
  const out = prepareTtsText('*He waves.* "Hello there." She replies: “你好。” 「よろしく」', "dialogue");
  assert.equal(out, "Hello there.\n你好。\nよろしく");
});

test("dialogue mode falls back to full text when nothing is quoted", () => {
  const out = prepareTtsText("*She just stares in silence.*", "dialogue");
  assert.equal(out, "She just stares in silence.");
});

test("markdown, code fences, html and urls are stripped", () => {
  const raw = "# Title\n\n```js\nconsole.log(1)\n```\n**bold** and <b>html</b> at https://example.com/x ok";
  const out = stripMarkupForTts(raw);
  assert.ok(!out.includes("#"));
  assert.ok(!out.includes("console"));
  assert.ok(!out.includes("<b>"));
  assert.ok(!out.includes("http"));
  assert.ok(out.includes("bold"));
  assert.ok(out.includes("html"));
});

test("fish emotion tags survive cleanup", () => {
  const out = prepareTtsText("[whisper] 小声点，别吵醒她。", "full");
  assert.equal(out, "[whisper] 小声点，别吵醒她。");
});

test("engine directives (colon brackets) are stripped, emotion tags kept", () => {
  const out = prepareTtsText("[hp: -10] 他倒下了。 [whisper] 嘘。 [mood: set sad]", "full");
  assert.equal(out, "他倒下了。 [whisper] 嘘。");
});

test("truncation lands on a sentence boundary", () => {
  const text = "第一句。第二句。第三句超出预算了".repeat(1);
  const out = truncateAtBoundary(text, 8);
  assert.equal(out, "第一句。第二句。");
});

test("extractDialogue handles curly and corner quotes together", () => {
  assert.deepEqual(extractDialogue("“甲” 无关 「乙」 『丙』"), ["甲", "乙", "丙"]);
});

test("empty and markup-only input prepares to empty string", () => {
  assert.equal(prepareTtsText("```\ncode\n```", "full"), "");
  assert.equal(prepareTtsText("", "full"), "");
});

test("nested quotes extract once, as the outer span", () => {
  assert.equal(prepareTtsText("「他说『来』就来」她皱眉。", "dialogue"), "他说『来』就来");
});

test("guillemets and raya lines count as dialogue", () => {
  const out = prepareTtsText("«Buenos días» dijo.\n—No lo sé —dijo María—. Pero es tarde.", "dialogue");
  assert.equal(out, "Buenos días\nNo lo sé . Pero es tarde.");
});

test("an unterminated quote is salvaged instead of silenced", () => {
  assert.equal(prepareTtsText("他低声说：「今晚别走", "dialogue"), "今晚别走");
});

test("multiline directives are stripped whole", () => {
  const raw = '他敲门。[game_state: set "night: 1\nphase: knock"] 门开了。';
  assert.equal(prepareTtsText(raw, "full"), "他敲门。 门开了。");
});

test("orphan directive fragments from a mid-directive slice cut are stripped", () => {
  assert.equal(prepareTtsText('他敲门。[game_state: set "night', "full"), "他敲门。");
  assert.equal(prepareTtsText('phase: knock"] 门开了。', "full"), "门开了。");
});
