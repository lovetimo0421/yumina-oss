import assert from "node:assert/strict";
import test from "node:test";
import {
  extractDialogueTexts,
  extractDialogueSpans,
  scanDialogueState,
  findStreamCut,
} from "../dist/index.js";

// ── Extraction ──────────────────────────────────────────────────────

test("mixed quote styles extract in order of appearance", () => {
  assert.deepEqual(extractDialogueTexts("“甲” 无关 「乙」 『丙』"), ["甲", "乙", "丙"]);
});

test("straight, curly and corner quotes together", () => {
  assert.deepEqual(
    extractDialogueTexts('He waves. "Hello there." She replies: “你好。” 「よろしく」'),
    ["Hello there.", "你好。", "よろしく"],
  );
});

test("nested quotes stay inside the outer span — no double extraction", () => {
  assert.deepEqual(extractDialogueTexts("「他说『来』就来」"), ["他说『来』就来"]);
});

test("guillemets extract as dialogue", () => {
  assert.deepEqual(extractDialogueTexts("«Buenos días» dijo con calma."), ["Buenos días"]);
});

test("Spanish raya line: odd segments are speech, attribution dropped", () => {
  assert.deepEqual(
    extractDialogueTexts("—No lo sé —dijo María—. Pero es tarde."),
    ["No lo sé . Pero es tarde."],
  );
});

test("a CJK scene-break double dash is not a raya line", () => {
  assert.deepEqual(extractDialogueTexts("——三年后，城已空。"), []);
});

test("an unterminated quote at end of text is salvaged, not dropped", () => {
  assert.deepEqual(extractDialogueTexts("他低声说：「今晚别走"), ["今晚别走"]);
});

test("paragraph-continuation re-opens close the previous span", () => {
  assert.deepEqual(
    extractDialogueTexts("“part one “part two”"),
    ["part one", "part two"],
  );
});

test("a paragraph break heals an open corner quote", () => {
  assert.deepEqual(
    extractDialogueTexts("「第一段的话\n\n「第二段的话」"),
    ["第一段的话", "第二段的话"],
  );
});

test("a straight quote never survives a newline (salvaged at the break)", () => {
  assert.deepEqual(extractDialogueTexts('"unterminated\nplain narration'), ["unterminated"]);
});

test("carry state: a slice starting mid-quote extracts its leading run", () => {
  const { spans, endState } = extractDialogueSpans("今晚别走。」他转身。", {
    initialState: { open: "」" },
  });
  assert.deepEqual(spans.map((s) => s.text), ["今晚别走。"]);
  assert.equal(endState.open, null);
});

test("scanDialogueState reports an open quote across a cut", () => {
  assert.equal(scanDialogueState("他说：「今晚").open, "」");
  assert.equal(scanDialogueState("他说：「今晚」").open, null);
});

// ── Stream cutting ──────────────────────────────────────────────────

test("a sentence end inside a quote is not a clean cut", () => {
  const text = "「今晚。别走」他说。";
  const cut = findStreamCut(text, { minChars: 1 });
  assert.equal(cut.clean?.end, text.length); // only after the closing 。
});

test("sentence punctuation right before a closer cuts AFTER the closer", () => {
  const text = "「今晚别走。」他说";
  const cut = findStreamCut(text, { minChars: 1 });
  assert.equal(cut.clean?.end, 7); // …。」| 他说
  assert.equal(cut.raw?.end, 6); // raw stops at 。, still inside the quote
  assert.equal(cut.raw?.state.open, "」");
});

test("minChars suppresses too-small clean cuts", () => {
  const cut = findStreamCut("好。", { minChars: 10 });
  assert.equal(cut.clean, null);
});

test("latin periods cut at the last sentence end", () => {
  const text = "He left. She stayed.";
  const cut = findStreamCut(text, { minChars: 5 });
  assert.equal(cut.clean?.end, text.length);
});

test("decimals do not create cuts", () => {
  const cut = findStreamCut("Pi is 3.14159 and counting", { minChars: 1 });
  assert.equal(cut.clean, null);
});

test("abbreviations do not create cuts", () => {
  const text = "Mr. Smith came.";
  const cut = findStreamCut(text, { minChars: 1 });
  assert.equal(cut.clean?.end, text.length); // not after "Mr."
});

test("a period inside a straight quote cuts after the closing quote", () => {
  const text = 'She said "Stop here."';
  const cut = findStreamCut(text, { minChars: 1 });
  assert.equal(cut.clean?.end, text.length);
});

test("a runaway open quote yields no clean cut but a raw cut with carry state", () => {
  const text = "「" + "呃".repeat(700) + "。";
  const cut = findStreamCut(text, { minChars: 1 });
  assert.equal(cut.clean, null);
  assert.equal(cut.raw?.end, text.length);
  assert.equal(cut.raw?.state.open, "」");
});

// ── Engine directives ([…] spans) ───────────────────────────────────

test("no clean cut inside a multiline engine directive", () => {
  const text = '完整句。[game_state: set "night: 1\nphase: knock\nlist:';
  const cut = findStreamCut(text, { minChars: 1 });
  assert.equal(cut.clean?.end, 4); // only after 完整句。 — never inside the [
  assert.equal(cut.raw?.state.bracket, true);
});

test("a closed directive does not block the following sentence cut", () => {
  const text = "[hp: -10] 他倒下了。";
  const cut = findStreamCut(text, { minChars: 1 });
  assert.equal(cut.clean?.end, text.length);
});

test("quotes inside a directive are not dialogue and do not poison the scan", () => {
  const text = '[game_state: set "flag"] 旁白。「真正的对白。」';
  assert.deepEqual(extractDialogueTexts(text), ["真正的对白。"]);
});

test("bracket carry state skips a directive tail in the next slice", () => {
  const { spans } = extractDialogueSpans('night: 1"] 「你来了。」', {
    initialState: { open: null, bracket: true },
  });
  assert.deepEqual(spans.map((s) => s.text), ["你来了。"]);
});
