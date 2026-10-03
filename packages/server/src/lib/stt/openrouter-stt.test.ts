import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTranscriptPunctuation } from "./openrouter-stt.js";

test("Chinese transcripts get full-width punctuation", () => {
  assert.equal(
    normalizeTranscriptPunctuation("我是预言家,昨晚我验了三号,他是狼人,今天全票出三号。"),
    "我是预言家，昨晚我验了三号，他是狼人，今天全票出三号。",
  );
  assert.equal(normalizeTranscriptPunctuation("你是谁? 快说!"), "你是谁？快说！");
  assert.equal(normalizeTranscriptPunctuation("好吧."), "好吧。");
});

test("numbers inside Chinese keep their separators", () => {
  assert.equal(normalizeTranscriptPunctuation("我有3,000块,12:30见"), "我有3,000块，12:30见");
});

test("Latin transcripts are left alone", () => {
  assert.equal(normalizeTranscriptPunctuation(" I'm the seer, vote three! "), "I'm the seer, vote three!");
});
