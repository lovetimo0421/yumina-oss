import assert from "node:assert/strict";
import test from "node:test";
import {
  getExtensionDefinition,
  getExtensionKeyForCapability,
  getVisibleExtensions,
  isExtensionApiCompatible,
  SESSION_MEMORY_EXTENSION_KEY,
} from "../dist/index.js";

test("Discover lists State Update Guard alongside Session Memory", () => {
  const visible = getVisibleExtensions();
  for (const key of ["state-update-guard", SESSION_MEMORY_EXTENSION_KEY]) {
    assert.equal(visible.filter((extension) => extension.key === key).length, 1);
    assert.equal(isExtensionApiCompatible(getExtensionDefinition(key)), true);
  }
  assert.equal(visible.some((extension) => extension.key === "turn-counter"), false);
  assert.ok(getExtensionDefinition("turn-counter"), "dev-only detail lookup still works");
});

test("guard uses the same extension contract as memory without taking its capabilities", () => {
  const guard = getExtensionDefinition("state-update-guard");
  const memory = getExtensionDefinition(SESSION_MEMORY_EXTENSION_KEY);
  assert.equal(guard.clientEntry, "state-update-guard");
  assert.equal(guard.firstParty, memory.firstParty);
  assert.equal(guard.apiVersion, memory.apiVersion);
  assert.ok(guard.contributions.some((item) => item.point === "chat.composer.toolbar"));
  assert.deepEqual(guard.serverHooks, [{ capability: "state-update-guard", seam: "validateTurnOutput" }]);
  assert.equal(getExtensionKeyForCapability("state-update-guard"), guard.key);
  for (const capability of ["session-memory", "story-summary", "summaryception"]) {
    assert.equal(getExtensionKeyForCapability(capability), memory.key);
  }
});
