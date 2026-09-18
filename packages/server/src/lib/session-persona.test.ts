import assert from "node:assert/strict";
import { test } from "node:test";
import { captureSessionPersona, legacySessionPersona } from "./session-persona.js";

test("persona response snapshots only include public prompt fields", () => {
  const source = { id: "A", name: "Persona A", backstory: "Story", note: "PRIVATE" };
  const captured = captureSessionPersona(source);
  assert.equal(captured.persona?.id, "A");
  assert.equal(captured.persona?.backstory, "Story");
  assert.ok(!JSON.stringify(captured).includes("PRIVATE"));
  assert.deepEqual(captureSessionPersona(null), { persona: null });
});

test("legacy snapshot decoding never guesses IDs from ambiguous names", () => {
  assert.deepEqual(legacySessionPersona({}), { persona: null });
  assert.deepEqual(legacySessionPersona({ metadata: { personaActive: false, personaName: "Old" } }), { persona: null });
  const result = legacySessionPersona({ metadata: { personaActive: true, personaName: "Same name", personaBackstory: "Old story" } });
  assert.equal(result.persona?.name, "Same name");
  assert.equal(result.persona?.id, undefined);
});
