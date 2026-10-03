import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolveCardVoice } from "./tts-card-voice";

const MIKA = "faccba1a8ac54016bcfc02761285e67f";
const NARRATOR = "6910bc3ba4284e31b49be252faf3601b";

const world = {
  entries: [
    { name: "Mika", role: "character", enabled: true, portrait: "@asset:x", voice: MIKA },
    { name: "Ren", role: "character", enabled: true, portrait: "@asset:y" },
  ],
  settings: { narratorVoice: NARRATOR },
};

test("the tagged speaker's own voice wins", () => {
  assert.equal(resolveCardVoice(world, "[speaker: Mika] She looked up."), MIKA);
});

test("a speaking character without a voice reads in the narrator's", () => {
  assert.equal(resolveCardVoice(world, "[speaker: Ren] He said nothing."), NARRATOR);
});

test("narration reads in the narrator's voice", () => {
  assert.equal(resolveCardVoice(world, "[speaker: narrator] Rain on the roof."), NARRATOR);
});

test("a card that set no voices leaves the player's choice in force", () => {
  assert.equal(resolveCardVoice({ entries: world.entries.map(e => ({ ...e, voice: undefined })), settings: {} }, "[speaker: Mika] Hi."), undefined);
  assert.equal(resolveCardVoice(null, "anything"), undefined);
});

test("a voice that is not a reference id is not sent", () => {
  assert.equal(resolveCardVoice({ entries: [], settings: { narratorVoice: "bob" } }, "text"), undefined);
});
