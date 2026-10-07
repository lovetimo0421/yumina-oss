import assert from "node:assert/strict";
import { test } from "node:test";
import { blueprintAccessFor } from "./studio.js";

test("blueprintAccessFor lets everyone in when the switch is unset or 'all'", () => {
  assert.equal(blueprintAccessFor("user", undefined), true);
  assert.equal(blueprintAccessFor(undefined, "all"), true);
  assert.equal(blueprintAccessFor("admin", " ALL "), true);
});

test("blueprintAccessFor narrows to admins", () => {
  assert.equal(blueprintAccessFor("admin", "admins"), true);
  assert.equal(blueprintAccessFor("user", "admins"), false);
  assert.equal(blueprintAccessFor(undefined, "admins"), false);
});

test("blueprintAccessFor closes the door with 'off', admins included", () => {
  assert.equal(blueprintAccessFor("admin", "off"), false);
  assert.equal(blueprintAccessFor("user", "OFF"), false);
});
