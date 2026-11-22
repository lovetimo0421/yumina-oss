import assert from "node:assert/strict";
import test from "node:test";
import { passageIn, tidyPassage } from "./passage.js";

test("a passage selected on screen is found in the stored reply despite markdown, quotes and line breaks", () => {
  const reply = "She *slowly* turns.\n\n\"Stay,\" she says — **quietly**.\nThe rain keeps falling.";
  const at = passageIn(reply, "slowly turns. “Stay,” she says — quietly.");
  assert.ok(at);
  assert.equal(reply.slice(at.start, at.end), "slowly* turns.\n\n\"Stay,\" she says — **quietly");
  assert.ok(passageIn("她推开门走进来。\n「你回来了。」", "走进来。 「你回来了"));
});

test("a passage that isn't in the reply, or has no words, is not found", () => {
  assert.equal(passageIn("She smiles at you from the doorway.", "a naked woman on a bed"), null);
  assert.equal(passageIn("She smiles.", "  …  "), null);
  assert.equal(passageIn("She smiles.", "s"), null);
});

test("the selection's spacing is collapsed", () => {
  assert.equal(tidyPassage("  She smiles\n\n at   you. "), "She smiles at you.");
});
