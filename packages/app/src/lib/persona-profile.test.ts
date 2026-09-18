import assert from "node:assert/strict";
import test from "node:test";
import { readPersonaProfile } from "./persona-profile";

const persona = { id: "B", name: "Robin", appearance: "red coat", personality: "curious", backstory: "teacher", note: "PRIVATE", userId: "owner", avatarUrl: "private-avatar" };
const legacyState = { metadata: { personaActive: true, personaName: "Legacy A", personaAppearance: "blue coat", personaPersonality: "quiet", personaBackstory: "farmer" } };
test("import follows the manager's saved session selection, excluding private fields", () => {
  const result = readPersonaProfile("session", { id: "session", sessionPersona: { persona }, state: legacyState, globalPersona: { name: "Global A" } });
  assert.deepEqual(result, { name: "Robin", appearance: "red coat", personality: "curious", backstory: "teacher" });
});
test("manager's No Persona overrides legacy metadata and global defaults", () => {
  assert.equal(readPersonaProfile("session", { id: "session", sessionPersona: { persona: null }, state: legacyState, globalPersona: persona }), null);
});
test("manager selection refresh changes the next import but never earlier copies", () => {
  const session = { id: "session", sessionPersona: { persona: { ...persona } } };
  const first = readPersonaProfile("session", session);
  session.sessionPersona.persona.name = "New selection";
  const second = readPersonaProfile("session", session);
  assert.equal(first?.name, "Robin"); assert.equal(second?.name, "New selection");
});
test("late calls cannot read another session after navigation", () => {
  assert.equal(readPersonaProfile("old-session", { id: "new-session", sessionPersona: { persona } }), null);
  assert.equal(readPersonaProfile("", { id: "", sessionPersona: { persona } }), null);
  assert.equal(readPersonaProfile("session", null), null);
});
test("legacy session metadata preserves identity without adopting the account", () => {
  assert.deepEqual(readPersonaProfile("session", { id: "session", state: legacyState }), {
    name: "Legacy A", appearance: "blue coat", personality: "quiet", backstory: "farmer",
  });
  assert.equal(readPersonaProfile("session", { id: "session", state: { metadata: { ...legacyState.metadata, personaActive: false } }, currentUser: { name: "Account" } }), null);
});
test("missing optional fields are empty; malformed explicit bindings never fall back", () => {
  assert.deepEqual(readPersonaProfile("session", { id: "session", sessionPersona: { persona: { name: "Only name" } } }), { name: "Only name", appearance: "", personality: "", backstory: "" });
  for (const binding of [{}, { persona: [] }, { persona: 5 }]) {
    assert.throws(() => readPersonaProfile("session", { id: "session", sessionPersona: binding, state: legacyState }), /Invalid session Persona/);
  }
});
