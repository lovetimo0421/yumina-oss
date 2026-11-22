import { test } from "node:test";
import assert from "node:assert/strict";
import { STT_FALLBACK_MODEL, STT_MODEL, normalizeTranscriptPunctuation, transcribeAudio, vocabularyPhrases } from "./openrouter-stt.js";

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

test("a vocabulary hint splits on list marks, never on spaces", () => {
  assert.deepEqual(vocabularyPhrases("牧濑红莉栖、冈部伦太郎, Amadeus；Steins Gate\n秋叶原,  , 秋叶原"), ["牧濑红莉栖", "冈部伦太郎", "Amadeus", "Steins Gate", "秋叶原"]);
  assert.deepEqual(vocabularyPhrases(undefined), []);
});

function stubFetch(answers: Array<{ status: number; body: unknown }>) {
  const calls: Array<Record<string, any>> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    calls.push(JSON.parse(init.body));
    const a = answers.shift()!;
    return new Response(JSON.stringify(a.body), { status: a.status });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const clip = { audio: new Uint8Array([1, 2, 3]), filename: "clip.wav", language: "zh", prompt: "红莉栖, Amadeus" };

test("WAV goes to MAI-Transcribe with the vocabulary as a phrase list", async () => {
  const f = stubFetch([{ status: 200, body: { text: "红莉栖，你好", usage: { cost: 0.0001 } } }]);
  try {
    const r = await transcribeAudio("k", { ...clip, mimeType: "audio/wav" });
    assert.equal(r.model, STT_MODEL);
    assert.equal(r.text, "红莉栖，你好");
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.input_audio.format, "wav");
    assert.deepEqual(f.calls[0]!.provider.options.azure.phraseList.phrases, ["红莉栖", "Amadeus"]);
  } finally { f.restore(); }
});

test("a MAI error falls back to gpt-transcribe with the vocabulary as a prompt", async () => {
  const f = stubFetch([{ status: 400, body: { error: "bad" } }, { status: 200, body: { text: "红莉栖" } }]);
  try {
    const r = await transcribeAudio("k", { ...clip, mimeType: "audio/wav" });
    assert.equal(r.model, STT_FALLBACK_MODEL);
    assert.equal(f.calls[1]!.model, STT_FALLBACK_MODEL);
    assert.match(f.calls[1]!.provider.options.openai.prompt, /红莉栖, Amadeus/);
  } finally { f.restore(); }
});

test("webm from an older app skips MAI, which refuses it", async () => {
  const f = stubFetch([{ status: 200, body: { text: "你好" } }]);
  try {
    const r = await transcribeAudio("k", { ...clip, prompt: undefined, mimeType: "audio/webm", filename: "clip.webm" });
    assert.equal(r.model, STT_FALLBACK_MODEL);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.input_audio.format, "webm");
    assert.equal(f.calls[0]!.provider, undefined);
  } finally { f.restore(); }
});

test("a MAI timeout is not retried on the fallback", async () => {
  const real = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async () => { n++; const e = new Error("aborted"); e.name = "AbortError"; throw e; }) as typeof fetch;
  try {
    await assert.rejects(transcribeAudio("k", { ...clip, mimeType: "audio/wav" }), (e: { status?: number }) => e.status === 504);
    assert.equal(n, 1);
  } finally { globalThis.fetch = real; }
});
