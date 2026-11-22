import test from "node:test";
import assert from "node:assert/strict";
import { TTS_VOICES } from "@yumina/shared";
import { listSpeakerVoices } from "./tts-speakers";

const [a, b, c] = [TTS_VOICES[0]!.id, TTS_VOICES[1]!.id, TTS_VOICES[2]!.id];

test("the narrator comes first, then the card's characters, then voices casting handed out", () => {
  const world = { settings: { narratorVoice: a }, entries: [{ name: "Alice", role: "character", voice: b }, { name: "lore", role: "lore" }] };
  assert.deepEqual(listSpeakerVoices(world, { Bob: c }, {}), [
    { name: "narrator", voice: a, source: "card" },
    { name: "Alice", voice: b, source: "card" },
    { name: "Bob", voice: c, source: "auto" },
  ]);
});

test("a voice the player picked wins, and a bad id is ignored", () => {
  const world = { entries: [{ name: "Alice", role: "character", voice: b }] };
  const list = listSpeakerVoices(world, {}, { Alice: c, narrator: "not-a-voice" });
  assert.deepEqual(list[0], { name: "narrator", voice: null, source: "auto" });
  assert.deepEqual(list[1], { name: "Alice", voice: c, source: "player" });
});
