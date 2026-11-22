import assert from "node:assert/strict";
import test from "node:test";
import { faceOf, showFace } from "../../../sandbox/chat/live-stage";
import { resolveSpeaker } from "../../../sandbox/chat/speaker";
import type { RigControls } from "../../../sandbox/building-blocks/rig-character";

function recorder() {
  const calls: string[] = [];
  const ctl: RigControls = {
    cue: (id, opts) => { calls.push(`cue ${id}${opts ? ` ${JSON.stringify(opts)}` : ""}`); },
    talk: () => {}, stopTalking: () => {},
    setMood: (m) => { calls.push(`mood ${m}`); },
    hold: () => {}, blink: () => {},
  };
  return { ctl, calls };
}

test("the face a reply names: the leading tag, after the speaker tag, or on a line at the end", () => {
  assert.equal(faceOf("[face: happy]\nHi."), "happy");
  assert.equal(faceOf("[speaker: Yuki]\n[face: 坏笑]\nHi."), "坏笑");
  assert.equal(faceOf("Hi.\n[face: sad]"), "sad");
  assert.equal(faceOf("Hi."), null);
});

test("a face is kept for the reply and leaves her in its mood; a nod plays once; calm only rests", () => {
  let r = recorder();
  showFace(r.ctl, "angry");
  assert.deepEqual(r.calls, ["mood annoyed", `cue angry {"seconds":6,"strength":0.85}`]);
  r = recorder();
  showFace(r.ctl, "nod");
  assert.deepEqual(r.calls, ["mood calm", "cue nod"]);
  r = recorder();
  showFace(r.ctl, "calm");
  assert.deepEqual(r.calls, ["mood calm"]);
  r = recorder();
  showFace(r.ctl, "坏笑");
  assert.deepEqual(r.calls, ["mood calm", `cue 坏笑 {"seconds":6,"strength":0.85}`], "the creator's own expression, by its name");
});

test("of two characters, the line's speaker is the one with the live character when the tag names her", () => {
  const entries = [
    { name: "Yuki", role: "character", enabled: true, portrait: null, portraitLive: "@rig:9aaac23e-0000-4000-8000-000000000001" },
    { name: "Mia", role: "character", enabled: true, portrait: "https://cdn/mia.png" },
  ];
  assert.equal(resolveSpeaker(entries, "[speaker: Yuki]\n[face: shy]\nHi.")?.name, "Yuki");
  assert.equal(resolveSpeaker(entries, "Yuki: Hi there.")?.name, "Yuki", "a live character counts as a face for the prose heuristics");
});

test("on a narrow screen the strip folds; a wide screen keeps her beside the chat either way", async () => {
  const { stageMode } = await import("../../../sandbox/chat/live-stage-layout");
  assert.equal(stageMode(390, false), "top");
  assert.equal(stageMode(390, true), "folded");
  assert.equal(stageMode(1280, true), "side", "the fold is a phone thing; desktop is unchanged");
});

test("the fold is remembered per card, shown by default, and never breaks on storage that throws", async () => {
  const { readFolded, writeFolded, FOLD_KEY } = await import("../../../sandbox/chat/live-stage");
  const kept = new Map<string, string>();
  const storage = {
    get: async (k: string) => kept.get(k) ?? null,
    set: async (k: string, v: string) => { kept.set(k, v); },
    remove: async (k: string) => { kept.delete(k); },
  };
  assert.equal(await readFolded(storage), false, "shown until the player folds it");
  await writeFolded(storage, true);
  assert.equal(kept.get(FOLD_KEY), "1");
  assert.equal(await readFolded(storage), true);
  await writeFolded(storage, false);
  assert.equal(await readFolded(storage), false);
  const broken = { get: async () => { throw new Error("blocked"); }, set: async () => { throw new Error("blocked"); }, remove: async () => { throw new Error("blocked"); } };
  assert.equal(await readFolded(broken), false);
  await writeFolded(broken, true);
  assert.equal(await readFolded(undefined), false);
});
