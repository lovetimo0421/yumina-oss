import { strict as assert } from "node:assert";
import { test } from "node:test";
import { wirePairs, type WireEnd } from "./wires";

/**
 * One object, several hosts: the card's own entry is a row in every module's
 * frame. A wire touching it has to pick which instance to land on, and the
 * answer is "the one in the frame where the other end lives" — a wire between
 * two shared objects is true in every module, so it is drawn in every module.
 */

const at = (host: string, ownerId?: string, shown = true): WireEnd => ({ host, shown, ...(ownerId ? { ownerId } : {}) });

test("two single-homed ends make one pair", () => {
  const pairs = wirePairs([at("block:m:a:state", "a")], [at("block:m:a:lore:always", "a")]);
  assert.deepEqual(
    pairs.map((p) => [p.from.host, p.to.host]),
    [["block:m:a:state", "block:m:a:lore:always"]],
  );
});

test("a shared end lands in the frame of the end that has only one home", () => {
  const shared = [at("block:m:a:state", "a"), at("block:m:b:state", "b")];
  const own = [at("block:m:b:lore:always", "b")];
  assert.deepEqual(
    wirePairs(shared, own).map((p) => [p.from.host, p.to.host]),
    [["block:m:b:state", "block:m:b:lore:always"]],
  );
  assert.deepEqual(
    wirePairs(own, shared).map((p) => [p.from.host, p.to.host]),
    [["block:m:b:lore:always", "block:m:b:state"]],
  );
});

test("two shared ends are drawn once per frame they share", () => {
  const v = [at("block:m:a:state", "a"), at("block:m:b:state", "b")];
  const e = [at("block:m:a:lore:always", "a"), at("block:m:b:lore:always", "b")];
  assert.deepEqual(
    wirePairs(v, e).map((p) => [p.frame, p.from.host, p.to.host]),
    [
      ["a", "block:m:a:state", "block:m:a:lore:always"],
      ["b", "block:m:b:state", "block:m:b:lore:always"],
    ],
  );
});

test("a shared variable that opens a module wires from that module's own copy", () => {
  const v = [at("block:m:a:state", "a"), at("block:m:b:state", "b")];
  const gate = [at("module:b", "b")];
  assert.deepEqual(
    wirePairs(v, gate).map((p) => [p.from.host, p.to.host]),
    [["block:m:b:state", "module:b"]],
  );
});

test("ends with no frame in common fall back to the first instance of each", () => {
  // The card's interface (in the strip, no frame) reading a shared variable.
  const v = [at("block:m:a:state", "a"), at("block:m:b:state", "b")];
  const ui = [at("block:frontend")];
  assert.deepEqual(
    wirePairs(v, ui).map((p) => [p.from.host, p.to.host]),
    [["block:m:a:state", "block:frontend"]],
  );
});

test("an end with no host at all yields no pair — the wire is dropped, not guessed", () => {
  assert.deepEqual(wirePairs(undefined, [at("block:m:a:state", "a")]), []);
  assert.deepEqual(wirePairs([], [at("block:m:a:state", "a")]), []);
});
