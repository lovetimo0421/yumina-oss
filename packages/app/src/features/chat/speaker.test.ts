import assert from "node:assert/strict";
import test from "node:test";
import {
  aiFrameIds,
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
    video: null,
    voice: null,
  });
  assert.equal(stripLeadingSpeakerTag("[speaker: Balder]\nMia sighs."), "Mia sighs.");
  assert.equal(stripLeadingSpeakerTag("Mia sighs."), "Mia sighs.");
});

test("a narrator tag means no face even when names appear", () => {
  assert.equal(resolveSpeaker([mia, balder], "[speaker: narrator] Mia and Balder enter."), null);
  assert.equal(resolveSpeaker([mia], "[speaker: Narrator] Mia enters."), null);
});

test("a tagged character without a portrait still gets their name", () => {
  assert.deepEqual(resolveSpeaker([mia, rex], "[speaker: Rex] Grr."), { name: "Rex", portrait: null, video: null, voice: null });
});

test("the tag matches the label-stripped name and is case-insensitive", () => {
  assert.equal(resolveSpeaker([mia, balder], "[speaker: balder] ...")?.name, "Balder");
  assert.equal(resolveSpeaker([mia, balder], "[speaker: 人物：Balder] ...")?.name, "Balder");
});

test("an unknown tagged name falls back to the prose", () => {
  assert.equal(resolveSpeaker([mia, balder], "[speaker: Ghost] Mia: hello")?.name, "Mia");
});

test("no character entries means no speaker", () => {
  assert.equal(resolveSpeaker([lore], "Mia waves."), null);
  assert.equal(resolveSpeaker([], "hi"), null);
  assert.equal(resolveSpeaker(undefined, "hi"), null);
});

test("a lone character without a portrait still names every line", () => {
  // Was null, so a newcomer's card labelled all of its character's replies 「旁白」.
  assert.deepEqual(resolveSpeaker([rex], "The rain kept falling."), { name: "Rex", portrait: null, video: null, voice: null });
});

test("a lone character still carrying the template's name is not a name to show", () => {
  for (const name of ["角色", "Character", "キャラクター", "Personaje"]) {
    assert.equal(resolveSpeaker([{ ...rex, name }], "她抬起头。"), null, name);
    assert.equal(resolveSpeaker([{ ...mia, name }], "她抬起头。"), null, `${name} with a portrait`);
  }
});

test("several characters without portraits stay narration unless tagged", () => {
  assert.equal(resolveSpeaker([rex, { ...rex, name: "Ivy" }], "Rex waves."), null);
});

test("a one-character world is that character's voice on every line", () => {
  assert.deepEqual(resolveSpeaker([mia, lore], "The rain kept falling."), {
    name: "Mia",
    portrait: "https://cdn/mia.png",
    video: null,
    voice: null,
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

test("a character's authored voice rides along with the face", () => {
  const voiced = { ...mia, voice: "faccba1a8ac54016bcfc02761285e67f" };
  assert.deepEqual(resolveSpeaker([voiced, balder], "[speaker: Mia] Hi."), {
    name: "Mia",
    portrait: "https://cdn/mia.png",
    video: null,
    voice: "faccba1a8ac54016bcfc02761285e67f",
  });
});

test("a moving portrait is a face too, and its clips ride along", () => {
  const clips = { idle: "https://cdn/ink-idle.mp4", speaking: "https://cdn/ink-talk.mp4" };
  const ink = { name: "Ink", role: "character", enabled: true, portrait: null, portraitVideo: clips };
  // Untagged prose: only characters with a face are candidates, and a clip counts.
  assert.deepEqual(resolveSpeaker([ink, rex], "Ink: hello."), { name: "Ink", portrait: null, video: clips, voice: null });
  assert.deepEqual(resolveSpeaker([{ ...mia, portraitVideo: clips }, balder], "[speaker: Mia] Hi."),
    { name: "Mia", portrait: "https://cdn/mia.png", video: clips, voice: null });
});

test("a character in an AI's own frame speaks only through its tag", () => {
  const shen = { name: "沈霏", role: "character", enabled: true, portrait: "https://cdn/shen.png", worldbookId: "upstairs" };
  const frames = aiFrameIds([{ id: "upstairs", station: { kind: "narrator" } }, { id: "hall" }]);
  assert.deepEqual([...frames], ["upstairs"]);
  // A one-character card keeps its character as the voice of every other line.
  assert.equal(resolveSpeaker([mia, shen], "The rain keeps on.", frames)?.name, "Mia");
  assert.equal(resolveSpeaker([mia, shen], "[speaker: 沈霏]\n她抬起头。", frames)?.name, "沈霏");
  // A card whose only character is an AI's narrates untagged lines itself.
  assert.equal(resolveSpeaker([shen], "雨还在下。", frames), null);
});

test("an AI of a group chat answers under its own name, with its character's face when it has one", () => {
  const voices = [
    { id: "cat", name: "店猫", host: "card", station: { kind: "narrator" } },
    { id: "attic", name: "阁楼", station: { kind: "narrator" } },
  ];
  assert.deepEqual(resolveSpeaker([], "[speaker: 店猫]\n喵。", undefined, voices), { name: "店猫", portrait: null, video: null, voice: null });
  const tabby = { name: "橘子", role: "character", enabled: true, portrait: "https://cdn/tabby.png", worldbookId: "cat" };
  assert.equal(resolveSpeaker([tabby], "[speaker: 店猫]\n喵。", undefined, voices)?.portrait, "https://cdn/tabby.png");
  // A situation that is its own AI narrates; its name is not a speaker.
  assert.equal(resolveSpeaker([], "[speaker: 阁楼]\n灰尘落下。", undefined, voices), null);
});
