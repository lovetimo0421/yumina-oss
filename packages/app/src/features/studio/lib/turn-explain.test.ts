import assert from "node:assert/strict";
import test from "node:test";
import type { GameState, WorldDefinition } from "@yumina/engine";
import { explainTurn } from "./turn-explain";
import type { RuntimeRecord } from "./runtime-records";

const state = (vars: Record<string, unknown>, turnCount: number, ruleState?: Partial<GameState["ruleState"]>): GameState => ({
  variables: vars, turnCount,
  ruleState: { activeDirectives: [], disabledRules: [], fireCounts: {}, cooldowns: {}, ...ruleState },
} as unknown as GameState);

const world = {
  variables: [
    { id: "aff", name: "好感度", type: "number", defaultValue: 10, behaviorRules: "聊到书时会涨" },
    { id: "trust", name: "信任", type: "number", defaultValue: 0, aiAccess: "read" },
    { id: "mood", name: "心情", type: "string", defaultValue: "平静", precise: true, options: ["平静", "失落"] },
  ],
  reactions: [
    { id: "r80", name: "好感度 ≥ 80", when: { eventType: "turn:complete" }, conditions: [{ variableId: "aff", operator: "gte", value: 80 }], conditionLogic: "all", then: [], priority: 0, enabled: true },
    { id: "rcool", name: "离店", when: { eventType: "turn:complete" }, conditions: [], conditionLogic: "all", then: [], priority: 0, enabled: true, cooldownTurns: 3 },
  ],
  rules: [],
} as unknown as WorldDefinition;

const rec = (over: Partial<RuntimeRecord>): RuntimeRecord => ({
  id: crypto.randomUUID(), sessionId: "s", kind: "turn", at: "", turnCount: null, firedIds: [], injectedEntryIds: null,
  changes: [], trace: null, prompt: null, storyEvents: [], repaired: false, state: null, ...over,
});

test("explainTurn: names who moved each value and what held the rest", () => {
  const r1 = rec({ state: state({ aff: 13, trust: 0, mood: "平静" }, 1) });
  const r2 = rec({
    changes: [{ variableId: "aff", oldValue: 13, newValue: 16 }],
    trace: { sources: [{ kind: "ai" }], dropped: [{ variableId: "trust", reason: "read-only" }], rejected: [], aiWrote: ["aff"],
      judge: [{ variableId: "mood", chosen: "失落", confidence: 0.61, applied: false, reason: "below-threshold" }] },
    state: state({ aff: 16, trust: 0, mood: "平静" }, 2, { cooldowns: { rcool: 4 } }),
  });
  const out = explainTurn(world, r2, [r1]);
  assert.deepEqual(out.changed, [{ rootId: "aff", subPath: "", oldValue: 13, newValue: 16, delta: 3, source: { kind: "ai", repaired: false } }]);
  assert.deepEqual(out.held.map((h) => [h.rootId, h.reason.kind]), [["trust", "dropped"], ["mood", "judge"]]);
  const r80 = out.rules.find((r) => r.id === "r80")!;
  assert.equal(r80.status.kind, "unmet");
  assert.deepEqual(r80.progress, { variableId: "aff", current: 16, target: 80, remaining: 64, eta: 22 });
  assert.deepEqual(out.rules.find((r) => r.id === "rcool")!.status, { kind: "cooldown", turnsLeft: 2 });
});

test("explainTurn: attributes nothing when the server sent no trace", () => {
  const r = rec({ changes: [{ variableId: "aff", oldValue: 1, newValue: 2 }], state: state({ aff: 2 }, 1) });
  const out = explainTurn(world, r, []);
  assert.deepEqual(out.changed[0]!.source, { kind: "unknown" });
  assert.deepEqual(out.held, []);
});

test("explainTurn: tags rule-made changes with the rules that fired", () => {
  const r = rec({
    firedIds: ["rcool"],
    changes: [{ variableId: "trust", oldValue: 0, newValue: 1 }],
    trace: { sources: [{ kind: "rule", ids: ["rcool"] }], dropped: [], rejected: [], aiWrote: [], judge: [] },
    state: state({ aff: 10, trust: 1, mood: "平静" }, 3),
  });
  const out = explainTurn(world, r, []);
  assert.deepEqual(out.changed[0]!.source, { kind: "rule", ids: ["rcool"] });
  assert.equal(out.rules[0]!.id, "rcool");
  assert.equal(out.rules[0]!.status.kind, "fired");
  assert.equal(out.held.find((h) => h.rootId === "aff")!.reason.kind, "ai-silent");
});

test("explainTurn: a behaviour watching a line says how far the number still is", () => {
  const crossing = {
    ...world,
    reactions: [{ id: "soften", name: "戒备松动", when: { eventType: "state:crossed", match: { variableId: { value: "aff", operator: "eq" }, threshold: { value: 40, operator: "eq" }, direction: { value: "rises-above", operator: "eq" } } },
      conditions: [], conditionLogic: "all", then: [], priority: 0, enabled: true, maxFireCount: 1 }],
  } as unknown as WorldDefinition;
  const r1 = rec({ state: state({ aff: 15 }, 1) });
  const r2 = rec({ state: state({ aff: 17 }, 2) });
  const r3 = rec({ state: state({ aff: 21 }, 3) });
  const row = explainTurn(crossing, r3, [r1, r2]).rules.find((r) => r.id === "soften")!;
  assert.equal(row.status.kind, "unmet");
  assert.deepEqual(row.progress, { variableId: "aff", current: 21, target: 40, remaining: 19, eta: 7 });
  // Past the line it is no longer a matter of distance.
  const past = explainTurn(crossing, rec({ state: state({ aff: 45 }, 4) }), [r1, r2, r3]).rules.find((r) => r.id === "soften")!;
  assert.notEqual(past.status.kind, "unmet");
});
