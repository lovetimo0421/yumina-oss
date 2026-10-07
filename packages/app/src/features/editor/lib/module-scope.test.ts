import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  inModuleScope,
  moduleIdOfScope,
  normalizeModuleScope,
  scopeForModule,
  scopeToEntriesProp,
} from "./module-scope";

/**
 * One filter, three pages. The lorebook, variables and behaviours pages all
 * narrow to "the card's shared objects" or "one module's own", and the module
 * page hands them that filter when it jumps to an object — so the scope has
 * to mean exactly the same thing everywhere.
 */

test("a module scope is spelled so a module id can never collide with 'all' or 'core'", () => {
  assert.equal(scopeForModule("all"), "mod:all");
  assert.equal(moduleIdOfScope("mod:all"), "all");
  assert.equal(moduleIdOfScope("all"), null);
  assert.equal(moduleIdOfScope("core"), null);
});

test("'all' admits everything, 'core' only the card's own, a module only its own", () => {
  assert.equal(inModuleScope("all", undefined), true);
  assert.equal(inModuleScope("all", "a"), true);
  assert.equal(inModuleScope("core", undefined), true);
  assert.equal(inModuleScope("core", "a"), false);
  assert.equal(inModuleScope("mod:a", "a"), true);
  assert.equal(inModuleScope("mod:a", "b"), false);
  assert.equal(inModuleScope("mod:a", undefined), false);
});

test("the entries page speaks in its own dialect: undefined = all, null = core, id = module", () => {
  assert.equal(scopeToEntriesProp("all"), undefined);
  assert.equal(scopeToEntriesProp("core"), null);
  assert.equal(scopeToEntriesProp("mod:a"), "a");
  // The bindings view is not an entries filter at all.
  assert.equal(scopeToEntriesProp("bindings"), undefined);
});

test("a scope pointing at a module that no longer exists falls back to 'all'", () => {
  const books = [{ id: "a" }, { id: "b" }];
  assert.equal(normalizeModuleScope("mod:a", books), "mod:a");
  assert.equal(normalizeModuleScope("mod:gone", books), "all");
  assert.equal(normalizeModuleScope("core", books), "core");
  // With no modules there is nothing to be shared with, so 'core' is 'all'.
  assert.equal(normalizeModuleScope("core", []), "all");
  assert.equal(normalizeModuleScope("bindings", []), "bindings");
});
