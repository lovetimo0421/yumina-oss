import assert from "node:assert/strict";
import test from "node:test";
import { computeActiveWorldbookIds, type Worldbook } from "@yumina/engine";
import { liveRuntimeState, withRuntimeState } from "./runtime-state";
import { appendRuntimeRecord } from "./runtime-records";

test("a zero-variable session retains real greeting, keyword and manual module gates", () => {
  const worldbooks: Worldbook[] = [
    { id: "opening", name: "Opening", order: 0, activation: { mode: "greeting", greetingIds: ["start-b"] } },
    { id: "keyword", name: "Keyword", order: 1, activation: { mode: "keywords", keywords: ["door"] } },
    { id: "manual", name: "Manual", order: 2, activation: { mode: "manual" } },
  ];
  const snapshot = { worldId: "schema", variables: {}, activeGreetingId: "start-b", turnCount: 7,
    metadata: { activeLoreSlots: ["secret"] }, ruleState: { toggledWorldbooks: { keyword: true, manual: false } } };
  const session = { id: "play", worldId: "server", state: snapshot };
  const state = liveRuntimeState(session, ["schema", "server"], {});
  assert.ok(state);
  assert.equal(state.turnCount, 7);
  assert.deepEqual(state.metadata, snapshot.metadata);
  assert.deepEqual([...computeActiveWorldbookIds(worldbooks, state)], ["opening", "keyword"]);
  assert.equal(liveRuntimeState(session, ["other-card"], {}), null);
});

test("rewinds replace gates rather than resurrecting removed metadata or opening state", () => {
  const session = { id: "play", state: { variables: { hp: 1 }, activeGreetingId: "b", metadata: { activeLoreSlots: ["secret"] }, ruleState: { toggledWorldbooks: { secret: true } } } };
  const restored = { variables: { hp: 10 }, turnCount: 0, metadata: {} };
  assert.deepEqual(withRuntimeState(session, "play", restored)?.state, restored);
  assert.equal(withRuntimeState(session, "other", restored), session);
  assert.equal(withRuntimeState(session, "play", { hp: 10 }), session);
});

test("records separate missing evidence from zero triggers, never infer changes, and stay scoped", () => {
  const unknown = appendRuntimeRecord([], "play", "play", "turn", { state: { variables: { hp: 7 } } });
  assert.equal(unknown[0]?.firedIds, null);
  assert.deepEqual(unknown[0]?.changes, []);
  const actual = appendRuntimeRecord(unknown, "play", "play", "action", {
    firedIds: ["heal", "heal"], changes: [{ variableId: "hp", oldValue: 7, newValue: 9 }], state: { turnCount: 3 },
  }, "heal");
  assert.deepEqual(actual[1]?.firedIds, ["heal"]);
  assert.deepEqual(actual[1]?.changes, [{ variableId: "hp", oldValue: 7, newValue: 9 }]);
  assert.equal(appendRuntimeRecord(actual, "play", "other", "turn", { firedIds: [] }), actual);
  const empty = appendRuntimeRecord(actual, "play", "play", "turn", { firedIds: [] });
  assert.deepEqual(empty[2]?.firedIds, []);
  let bounded = empty;
  for (let i = 0; i < 45; i++) bounded = appendRuntimeRecord(bounded, "play", "play", "restore", {});
  assert.equal(bounded.length, 40);
});
