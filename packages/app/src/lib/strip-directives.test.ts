import assert from "node:assert/strict";
import test from "node:test";
import { stripDirectives, stripDirectivesForSandbox } from "./strip-directives";

test("stripDirectives removes a completed speaker tag like any other directive", () => {
  assert.equal(stripDirectives("[speaker: Balder] The forge roars. [hp: -1]"), " The forge roars. ");
});

test("stripDirectivesForSandbox keeps the leading speaker tag and strips the rest", () => {
  assert.equal(
    stripDirectivesForSandbox("[speaker: Balder]  \nThe forge roars. [hp: -1]"),
    "[speaker: Balder]\nThe forge roars. ",
  );
  assert.equal(stripDirectivesForSandbox("[speaker: Mia Chen] Hi."), "[speaker: Mia Chen]\n Hi.");
});

test("stripDirectivesForSandbox holds a partial leading tag instead of leaking it", () => {
  for (const partial of ["[", "[s", "[spea", "[speaker", "[speaker:", "[speaker: Bal"]) {
    assert.equal(stripDirectivesForSandbox(partial), partial, partial);
  }
});

test("stripDirectivesForSandbox is the plain stripper when there is no tag", () => {
  assert.equal(stripDirectivesForSandbox("Plain prose. [gold: +5]"), "Plain prose. ");
  assert.equal(stripDirectivesForSandbox("Text first. [speaker: Mia]"), "Text first. ");
});
