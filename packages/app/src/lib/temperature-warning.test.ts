import assert from "node:assert/strict";
import test from "node:test";
import { temperatureMayGarble } from "./temperature-warning";

test("the garble warning starts strictly above 1", () => {
  assert.equal(temperatureMayGarble(0.7), false);
  assert.equal(temperatureMayGarble(1), false);
  assert.equal(temperatureMayGarble(1.01), true);
  assert.equal(temperatureMayGarble(1.5), true);
});

test("an unset or broken temperature never warns", () => {
  assert.equal(temperatureMayGarble(undefined), false);
  assert.equal(temperatureMayGarble(null), false);
  assert.equal(temperatureMayGarble(Number.NaN), false);
});
