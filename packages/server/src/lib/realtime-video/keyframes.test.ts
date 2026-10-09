import assert from "node:assert/strict";
import test from "node:test";
import { keyframePrompt, silentShot } from "./keyframes.js";

test("a keyframe's prompt carries no spoken lines, so no subtitles get drawn", () => {
  const shot = "Medium shot: she gestures toward the chest and says softly: 「待っていたわ。」 She smiles. All dialogue is spoken in Japanese only. No subtitles, captions or on-screen text.";
  const quiet = silentShot(shot);
  assert.ok(!quiet.includes("待っていた"));
  assert.ok(!/dialogue|subtitle/i.test(quiet));
  assert.ok(quiet.includes("gestures toward the chest"));
  assert.ok(quiet.includes("She smiles."));
  assert.ok(keyframePrompt(shot, ["Mira"]).includes("Image 2 is Mira's face and hair."));
});
