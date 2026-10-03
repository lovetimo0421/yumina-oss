import assert from "node:assert/strict";
import test from "node:test";
import { TTS_VOICES, readTtsCustomVoices, sanitizeTtsCustomVoices, ttsCustomVoiceLabel } from "../dist/index.js";

const A = "d9d28586aaaabbbbccccddddeeeeffff";
const B = "0123456789abcdef0123456789abcdef";

test("custom voices keep their names; bad ids, catalog ids and duplicates drop", () => {
  assert.deepEqual(sanitizeTtsCustomVoices([
    { id: A.toUpperCase(), name: "  Rin   (calm) " },
    { id: A, name: "dup" },
    { id: "nope", name: "x" },
    { id: TTS_VOICES[0].id, name: "catalog" },
    B,
  ]), [{ id: A, name: "Rin (calm)" }, { id: B, name: "" }]);
});

test("unticking a custom voice from the pool keeps it in the list", () => {
  const prefs = { ttsCustomVoices: [{ id: A, name: "Rin" }], ttsVoicePool: [] };
  assert.deepEqual(readTtsCustomVoices(prefs), [{ id: A, name: "Rin" }]);
});

test("custom ids already in the pool from before the list existed still show", () => {
  assert.deepEqual(readTtsCustomVoices({ ttsVoicePool: [TTS_VOICES[0].id, B] }), [{ id: B, name: "" }]);
});

test("unnamed voices read as the id's first 8 characters", () => {
  assert.equal(ttsCustomVoiceLabel({ id: A, name: "" }), "d9d28586…");
  assert.equal(ttsCustomVoiceLabel({ id: A, name: "Rin" }), "Rin");
});
