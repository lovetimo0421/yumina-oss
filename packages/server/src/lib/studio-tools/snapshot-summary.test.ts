import test from "node:test";
import assert from "node:assert/strict";
import { summarizeSnapshotTimeline } from "./snapshot-summary.js";

const W = (entries: unknown[]) => ({ entries, variables: [], rules: [], reactions: [], audioTracks: [] }) as any;

test("pairs each snapshot with the next newer state; newest pairs with current world", () => {
  // oldest -> newest
  const snaps = [
    { id: "s1", schemaData: W([]) },                                  // before adding e1
    { id: "s2", schemaData: W([{ id: "e1", name: "A" }]) },           // before adding e2
  ];
  const current = W([{ id: "e1", name: "A" }, { id: "e2", name: "B" }]);
  const out = summarizeSnapshotTimeline(snaps, current);

  // s2 (newest) vs current -> added e2
  assert.equal(out.find((r) => r.id === "s2")!.summary[0]!.op, "added");
  assert.equal(out.find((r) => r.id === "s2")!.summary[0]!.name, "B");
  // s1 vs s2 -> added e1
  assert.equal(out.find((r) => r.id === "s1")!.summary[0]!.name, "A");
});

test("oldest snapshot with no prior produces a summary against its successor only", () => {
  const out = summarizeSnapshotTimeline([{ id: "s1", schemaData: W([]) }], W([{ id: "e1", name: "A" }]));
  assert.equal(out.length, 1);
  assert.equal(out[0]!.summary[0]!.op, "added");
});

test("empty input returns empty array", () => {
  assert.deepEqual(summarizeSnapshotTimeline([], W([])), []);
});
