import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readMusicSsePayload } from "./openrouter-music.js";

test("audio slices, format and cost are read off the stream", () => {
  const a = readMusicSsePayload(JSON.stringify({ choices: [{ delta: { audio: { data: "AAEC", format: "mp3" } } }] }));
  assert.deepEqual(a.audioBase64, ["AAEC"]);
  assert.equal(a.format, "mp3");
  assert.equal(a.error, null);
  const b = readMusicSsePayload(JSON.stringify({ choices: [{ delta: { content: "<instrumental>" } }], usage: { cost: 0.04 } }));
  assert.deepEqual(b.audioBase64, []);
  assert.equal(b.costUsd, 0.04);
});

test("a provider error in the stream is surfaced, and noise is ignored", () => {
  assert.equal(readMusicSsePayload(JSON.stringify({ error: { message: "Audio output requires stream: true", code: 400 } })).error, "Audio output requires stream: true");
  assert.deepEqual(readMusicSsePayload("[DONE]").audioBase64, []);
  assert.deepEqual(readMusicSsePayload("not json").audioBase64, []);
  assert.deepEqual(readMusicSsePayload("").audioBase64, []);
});
