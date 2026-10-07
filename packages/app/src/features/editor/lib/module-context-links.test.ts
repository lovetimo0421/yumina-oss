import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Worldbook } from "@yumina/engine";
import { contextBadgeFor } from "./module-context";

/**
 * Reading and being read are one edge seen from two ends.
 *
 * The asymmetry these tests pin down is the entire point of modules: inside
 * dungeon A the AI has only A's messages, and inside B it has B's AND A's.
 * Before this, that fact lived only on B — stand on A and nothing told you
 * anyone was reading you, so the one thing a creator needs to verify was the
 * one thing the studio would not show.
 */

const narrator = (id: string, name: string, inputs: unknown[] = []): Worldbook =>
  ({
    id,
    name,
    entries: [],
    activation: { mode: "always" },
    station: { kind: "narrator", onClose: "archive", inputs },
  }) as unknown as Worldbook;

const plain = (id: string, name: string): Worldbook =>
  ({ id, name, entries: [], activation: { mode: "always" } }) as unknown as Worldbook;

test("a one-way wire shows as `in` on the reader and `out` on the source", () => {
  const a = narrator("a", "Dungeon A");
  const b = narrator("b", "Dungeon B", [{ kind: "transcript", from: "a", limit: 10 }]);
  const books = [a, b];

  const onB = contextBadgeFor(b, books);
  assert.equal(onB.links.length, 1);
  assert.equal(onB.links[0]!.dir, "in");
  assert.equal(onB.links[0]!.otherName, "Dungeon A");
  assert.deepEqual(onB.links[0]!.reads.map((f) => f.kind), ["transcript"]);
  assert.equal(onB.links[0]!.reads[0]!.limit, 10);

  // The half that did not exist: A can see that B is drinking from it.
  const onA = contextBadgeFor(a, books);
  assert.equal(onA.links.length, 1);
  assert.equal(onA.links[0]!.dir, "out");
  assert.equal(onA.links[0]!.otherName, "Dungeon B");
  assert.equal(onA.links[0]!.reads.length, 0);
  assert.deepEqual(onA.links[0]!.gives.map((f) => f.kind), ["transcript"]);
});

test("both ends declaring a wire is 互通 — one link, not two", () => {
  const a = narrator("a", "A", [{ kind: "memory", from: "b" }]);
  const b = narrator("b", "B", [{ kind: "transcript", from: "a", limit: 4 }]);
  const books = [a, b];

  for (const [book, readKind, giveKind] of [
    [a, "memory", "transcript"],
    [b, "transcript", "memory"],
  ] as const) {
    const badge = contextBadgeFor(book, books);
    assert.equal(badge.links.length, 1, "one link, seen from both ends");
    assert.equal(badge.links[0]!.dir, "both");
    assert.deepEqual(badge.links[0]!.reads.map((f) => f.kind), [readKind]);
    assert.deepEqual(badge.links[0]!.gives.map((f) => f.kind), [giveKind]);
  }
});

test("a chain is named as not arriving: A -> B -> C leaves C without A", () => {
  const a = narrator("a", "A");
  const b = narrator("b", "B", [{ kind: "transcript", from: "a" }]);
  const c = narrator("c", "C", [{ kind: "memory", from: "b" }]);
  const badge = contextBadgeFor(c, [a, b, c]);

  assert.deepEqual(badge.links.map((l) => [l.otherName, l.dir]), [["B", "in"]]);
  assert.deepEqual(badge.indirect, [{ viaName: "B", sourceName: "A" }]);
});

test("a chain the creator already short-circuited is not reported as a trap", () => {
  const a = narrator("a", "A");
  const b = narrator("b", "B", [{ kind: "transcript", from: "a" }]);
  const c = narrator("c", "C", [
    { kind: "memory", from: "b" },
    { kind: "memory", from: "a" },
  ]);
  const badge = contextBadgeFor(c, [a, b, c]);
  assert.deepEqual(badge.indirect, [], "C reads A directly, so nothing is missing");
});

test("mutual wires are not reported as an unreachable chain", () => {
  const a = narrator("a", "A", [{ kind: "memory", from: "b" }]);
  const b = narrator("b", "B", [{ kind: "memory", from: "a" }]);
  assert.deepEqual(contextBadgeFor(a, [a, b]).indirect, []);
  assert.deepEqual(contextBadgeFor(b, [a, b]).indirect, []);
});

test("a plain module has no context of its own, and no station has no wires", () => {
  const p = plain("p", "Just content");
  const n = narrator("n", "Narrator", [{ kind: "variables", from: "core" }]);
  assert.equal(contextBadgeFor(p, [p, n]).role, "plain");
  assert.deepEqual(contextBadgeFor(p, [p, n]).links, []);

  const onN = contextBadgeFor(n, [p, n]);
  assert.equal(onN.role, "narrator");
  assert.equal(onN.ownRun, "archive");
  assert.deepEqual(onN.links.map((l) => [l.otherId, l.dir]), [["core", "in"]]);
});

test("a wire pointing at a deleted module is marked, not dropped silently", () => {
  const b = narrator("b", "B", [{ kind: "memory", from: "gone" }]);
  // `resolveInputs` drops unknown sources, so the wire is simply absent —
  // pin that, because a badge claiming a source that no longer exists would
  // be worse than one that shows nothing.
  assert.deepEqual(contextBadgeFor(b, [b]).links, []);
});

test("a worker has wires too — its whole job is reading another module", () => {
  const a = narrator("a", "Dungeon");
  const w = {
    id: "w",
    name: "Chronicler",
    entries: [],
    activation: { mode: "always" },
    station: { kind: "worker", inputs: [{ kind: "transcript", from: "a", limit: 30 }] },
  } as unknown as Worldbook;
  const badge = contextBadgeFor(w, [a, w]);
  assert.equal(badge.role, "worker");
  assert.equal(badge.ownRun, null, "a worker has no run of its own to seal");
  assert.deepEqual(badge.links.map((l) => [l.otherName, l.dir]), [["Dungeon", "in"]]);
});

test("mutual links sort ahead of one-way ones", () => {
  const a = narrator("a", "Zed", [{ kind: "memory", from: "b" }]);
  const b = narrator("b", "Alpha", [{ kind: "memory", from: "a" }]);
  const c = narrator("c", "Beta", [{ kind: "memory", from: "a" }]);
  const badge = contextBadgeFor(a, [a, b, c]);
  assert.deepEqual(badge.links.map((l) => [l.otherName, l.dir]), [
    ["Alpha", "both"],
    ["Beta", "out"],
  ]);
});
