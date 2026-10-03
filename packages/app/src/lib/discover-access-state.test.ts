import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOSED_DISCOVER_ACCESS, currentDiscoverAccess, parseDiscoverAccess } from "./discover-access-state";

test("preview fails closed for missing, invalid, and coerced access flags", () => {
  for (const input of [null, {}, {data:{}}, {data:{enabled:"true",publicEnabled:false}}]) {
    assert.deepEqual(parseDiscoverAccess(input), CLOSED_DISCOVER_ACCESS);
  }
  assert.deepEqual(parseDiscoverAccess({data:{enabled:true,publicEnabled:false}}), {enabled:true,publicEnabled:false});
});
test("an admin response cannot enable preview after an account switch or sign out", () => {
  const access = {enabled:true,publicEnabled:false};
  assert.equal(currentDiscoverAccess("admin", "admin", access), access);
  assert.deepEqual(currentDiscoverAccess("guest", "admin", access), CLOSED_DISCOVER_ACCESS);
  assert.deepEqual(currentDiscoverAccess("member", "admin", access), CLOSED_DISCOVER_ACCESS);
});
