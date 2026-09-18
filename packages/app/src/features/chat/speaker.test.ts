import assert from "node:assert/strict";
import test from "node:test";
import {
  displayCharacterName,
  resolveSpeaker,
  stripLeadingSpeakerTag,
} from "../../../sandbox/chat/speaker";

const mia = { name: "Mia", role: "character", enabled: true, portrait: "https://cdn/mia.png" };
const balder = { name: "人物：Balder", role: "character", enabled: true, portrait: "https://cdn/balder.png" };
const rex = { name: "Rex", role: "character", enabled: true, portrait: null };
const lore = { name: "Mia", role: "lore", enabled: true, portrait: "https://cdn/x.png" };

test("displayCharacterName strips a short author-side label before a colon", () => {
  assert.equal(displayCharacterName("人物：Balder"), "Balder");
  assert.equal(displayCharacterName("NPC: Mia"), "Mia");
  assert.equal(displayCharacterName("  Mia "), "Mia");
  assert.equal(displayCharacterName("The Long Winded Narrator Voice: Mia"), "The Long Winded Narrator Voice: Mia");
});

test("the speaker tag wins outright and is stripped from the text", () => {
  assert.deepEqual(resolveSpeaker([mia, balder], "[speaker: Balder]\nMia sighs. Balder grins."), {
    name: "Balder",
    portrait: "https://cdn/balder.png",
  });
  assert.equal(stripLeadingSpeakerTag("[speaker: Balder]\nMia sighs."), "Mia sighs.");
  assert.equal(stripLeadingSpeakerTag("Mia sighs."), "Mia sighs.");
});

test("a narrator tag means no face even when names appear", () => {
  assert.equal(resolveSpeaker([mia, balder], "[speaker: narrator] Mia and Balder enter."), null);
  assert.equal(resolveSpeaker([mia], "[speaker: Narrator] Mia enters."), null);
});

test("a tagged character without a portrait still gets their name", () => {
  assert.deepEqual(resolveSpeaker([mia, rex], "[speaker: Rex] Grr."), { name: "Rex", portrait: null });
});

test("the tag matches the label-stripped name and is case-insensitive", () => {
  assert.equal(resolveSpeaker([mia, balder], "[speaker: balder] ...")?.name, "Balder");
  assert.equal(resolveSpeaker([mia, balder], "[speaker: 人物：Balder] ...")?.name, "Balder");
});

test("an unknown tagged name falls back to the prose", () => {
  assert.equal(resolveSpeaker([mia, balder], "[speaker: Ghost] Mia: hello")?.name, "Mia");
});

test("no character entries, or none with a portrait, means no face", () => {
  assert.equal(resolveSpeaker([lore], "Mia waves."), null);
  assert.equal(resolveSpeaker([rex], "Rex waves."), null);
  assert.equal(resolveSpeaker([], "hi"), null);
  assert.equal(resolveSpeaker(undefined, "hi"), null);
});

test("a one-character world is that character's voice on every line", () => {
  assert.deepEqual(resolveSpeaker([mia, lore], "The rain kept falling."), {
    name: "Mia",
    portrait: "https://cdn/mia.png",
  });
});

test("several characters but only one portrait is NOT a one-character world", () => {
  // Rex exists without a portrait: this is a multi-character card, so an
  // unnamed narration line must not wear Mia's face.
  assert.equal(resolveSpeaker([mia, rex], "The rain kept falling."), null);
  assert.equal(resolveSpeaker([mia, rex], "Mia: it's cold.")?.name, "Mia");
});

test("disabled entries are ignored", () => {
  assert.equal(resolveSpeaker([{ ...mia, enabled: false }, lore], "Mia"), null);
});

test("multi-character: a line-start marker names the speaker", () => {
  assert.equal(resolveSpeaker([mia, balder], "Balder: Mia, get down!")?.name, "Balder");
  assert.equal(resolveSpeaker([mia, balder], "【Balder】Mia, get down!")?.name, "Balder");
  assert.equal(resolveSpeaker([mia, balder], "**Mia**: Balder, stop.")?.name, "Mia");
  assert.equal(resolveSpeaker([mia, balder], "Balder： 小心。")?.name, "Balder");
});

test("multi-character: without a marker, only the first sentence counts", () => {
  assert.equal(resolveSpeaker([mia, balder], "Balder grins at her. Mia sighs.")?.name, "Balder");
  assert.equal(resolveSpeaker([mia, balder], "The door creaks open. Mia looks up.")?.name, undefined);
  assert.equal(resolveSpeaker([mia, balder], "The door creaks open."), null);
});

test("multi-character: prefers the longer name on a tied position", () => {
  const miaBelle = { ...mia, name: "Miabelle", portrait: "https://cdn/mb.png" };
  assert.equal(resolveSpeaker([mia, miaBelle], "Miabelle laughs.")?.name, "Miabelle");
});
