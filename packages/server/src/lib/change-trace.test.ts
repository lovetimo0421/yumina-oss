import test from "node:test";
import assert from "node:assert/strict";
import type { GameState, WorldDefinition } from "@yumina/engine";
import { buildChangeTrace, describeDroppedAiWrites } from "./change-trace.js";

const world = {
  variables: [
    { id: "aff", name: "好感度", type: "number", defaultValue: 0 },
    { id: "trust", name: "信任", type: "number", defaultValue: 0, aiAccess: "read" },
    { id: "mood", name: "心情", type: "string", defaultValue: "平静", precise: true, options: ["平静", "失落"] },
  ],
  continuity: { enabled: true },
} as unknown as WorldDefinition;
const state = { variables: { aff: 0, trust: 0, mood: "平静" }, turnCount: 1 } as unknown as GameState;

test("repair and derived formula writes have distinct provenance", () => {
  const trace = buildChangeTrace({
    world: { variables: [...world.variables, { id: "total", name: "Total", type: "number", defaultValue: 0, formula: "{aff} * 2" }] },
    aiAndJudge: [{ variableId: "aff", oldValue: 0, newValue: 3 }, { variableId: "total", oldValue: 0, newValue: 6 }],
    repairEffects: [{ variableId: "aff", operation: "add", value: 3 }],
    kept: [{ variableId: "好感度", operation: "add", value: 3 }],
    judgeEffects: [], rules: { changes: [], changeCauses: [] }, dropped: [], rejected: [], decisions: [],
  });
  assert.deepEqual(trace.sources, [{ kind: "ai", via: "repair" }, { kind: "settle", via: "formula" }]);
  assert.deepEqual(trace.aiWrote, ["aff"]);
});

test("change trace: each change names its writer, and refused writes their gate", () => {
  const dropped = describeDroppedAiWrites(world, state, [
    { variableId: "trust", operation: "add", value: 5 },
    { variableId: "mood", operation: "set", value: "失落" },
  ]);
  assert.deepEqual(dropped, [{ variableId: "trust", reason: "read-only" }, { variableId: "mood", reason: "judge" }]);

  const trace = buildChangeTrace({
    setupCount: 1,
    aiAndJudge: [{ variableId: "aff", oldValue: 0, newValue: 3 }, { variableId: "mood", oldValue: "平静", newValue: "失落" }],
    judgeEffects: [{ variableId: "mood", operation: "set", value: "失落" }],
    kept: [{ variableId: "aff", operation: "add", value: 3 }],
    rules: { changes: [{ variableId: "trust", oldValue: 0, newValue: 1 }, { variableId: "aff", oldValue: 3, newValue: 2 }], changeCauses: [["r1"], []] },
    dropped,
    rejected: [{ variableId: "aff" }, { variableId: "aff" }],
    decisions: [
      { key: "var__mood", kind: "string", chosen: "失落", confidence: 0.9, applied: true },
      { key: "bgm", kind: "bgm", chosen: null, confidence: 0.4, applied: false },
    ],
  });
  assert.deepEqual(trace.sources, [{ kind: "setup" }, { kind: "ai" }, { kind: "judge" }, { kind: "rule", ids: ["r1"] }, { kind: "settle" }]);
  assert.deepEqual(trace.rejected, ["aff"]);
  assert.deepEqual(trace.aiWrote, ["aff"]);
  assert.deepEqual(trace.judge, [{ variableId: "mood", chosen: "失落", confidence: 0.9, applied: true }]);
});

test("change trace: every question the judge was asked comes with its answer", () => {
  const trace = buildChangeTrace({
    aiAndJudge: [], judgeEffects: [], kept: [], rules: { changes: [], changeCauses: [] }, dropped: [], rejected: [],
    decisions: [
      { key: "var__mood", kind: "string", chosen: "失落", confidence: 0.86, applied: true },
      { key: "bgm", kind: "bgm", chosen: null, confidence: 0.4, applied: false, reason: "low-confidence" },
    ],
    questions: {
      var__mood: { type: "choice", instructions: "在 reply 结束时，变量「心情」应该是什么？", criteria: { 平静: "平静", 失落: "失落" } },
      bgm: { type: "choice", instructions: "该配哪首曲子？", criteria: { a: "雨夜", b: "保持当前曲目" } },
    },
  });
  assert.deepEqual(trace.asked.map((q) => [q.key, q.options, q.chosen, q.applied]), [
    ["var__mood", ["平静", "失落"], "失落", true],
    ["bgm", ["雨夜", "保持当前曲目"], null, false],
  ]);
  assert.match(trace.asked[0]!.question, /心情/);
});
