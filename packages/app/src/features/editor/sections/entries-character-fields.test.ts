import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// A merge once kept both the character switch's fields and an older copy
// below it, so the video portrait, voice and LoRA tiles each showed twice.
test("the character entry renders each media field once", () => {
  const source = readFileSync(new URL("./entries.tsx", import.meta.url), "utf8");
  for (const field of ["EntryPortraitField", "EntryPortraitVideoField", "EntryLiveCharacterField", "VoiceField", "IllustrationLoraField"]) {
    const uses = source.match(new RegExp(`<${field}\\b`, "g")) ?? [];
    assert.equal(uses.length, 1, `${field} rendered ${uses.length} times`);
  }
});
