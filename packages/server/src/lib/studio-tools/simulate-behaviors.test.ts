import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorldDefinition } from "@yumina/engine";
import { executeSimulateBehaviors } from "./simulate-behaviors.js";

function world(): WorldDefinition {
  return {
    id: "w", version: "19.0.0", name: "Sim", description: "", author: "t",
    entries: [], rules: [], components: [], audioTracks: [], customUI: [],
    settings: { maxTokens: 4000, temperature: 1, playerName: "User" },
    variables: [
      { id: "hp", name: "体力", type: "number", defaultValue: 5, min: 0, max: 10 },
      { id: "status", name: "状态", type: "string", defaultValue: "ok" },
      { id: "bag", name: "背包", type: "json", defaultValue: { coins: 0 } },
    ],
    reactions: [
      { id: "rest", name: "休息", enabled: true, priority: 0, conditions: [], conditionLogic: "all",
        when: { eventType: "action:fired", match: { actionId: { operator: "eq", value: "rest" } } },
        then: [{ type: "set", path: "hp", operation: "add", value: 5 }, { type: "emit", event: { type: "ui:notification", message: "睡了一觉", style: "info" } }] },
      { id: "full", name: "满血", enabled: true, priority: 0, conditionLogic: "all",
        when: { eventType: "state:changed", match: { variableId: { operator: "eq", value: "hp" } } },
        conditions: [{ variableId: "hp", operator: "gte", value: 10 }],
        then: [{ type: "set", path: "status", operation: "set", value: "rested" }] },
      { id: "tired", name: "累了", enabled: true, priority: 0, conditions: [], conditionLogic: "all",
        when: { eventType: "turn:complete" },
        then: [{ type: "set", path: "hp", operation: "subtract", value: 1 }] },
    ],
  } as unknown as WorldDefinition;
}

test("an action fires its behavior and the chain that follows, with causes", () => {
  const r = executeSimulateBehaviors(world(), { steps: [{ action: "rest" }] });
  assert.equal(r.error, undefined);
  const step = r.steps[0]!;
  assert.deepEqual(step.fired.map((f) => f.name).sort(), ["休息", "满血"]);
  assert.deepEqual(step.changes.map((c) => [c.variable, c.from, c.to, c.by]), [["hp", 5, 10, ["休息"]], ["status", "ok", "rested", ["满血"]]]);
  assert.deepEqual(step.notifications, ["睡了一觉"]);
  assert.deepEqual(r.final, { hp: 10, status: "rested" });
  assert.match(r.limits, /no model was called/);
});

test("turns, AI-set values, starting values and dot-paths", () => {
  const r = executeSimulateBehaviors(world(), { start: { hp: 2, "bag.coins": 7 }, steps: [{ turn: true, ai_sets: { hp: 10 } }, { turn: true }] });
  assert.deepEqual(r.steps[0]!.changes[0], { variable: "hp", from: 2, to: 10, by: ["AI (given)"] });
  assert.ok(r.steps[0]!.fired.some((f) => f.id === "full"));
  assert.equal(r.steps[1]!.event, "turn 2");
  assert.equal(r.final.hp, 8);
  assert.deepEqual(r.final.bag, { coins: 7 });
});

test("says when nothing listens, nothing fired, or a value names no variable", () => {
  const r = executeSimulateBehaviors(world(), { start: { mana: 3 }, steps: [{ action: "fly" }, { set: { status: "x" } }, { bogus: 1 }] });
  assert.match(r.steps[0]!.note!, /No behavior listens for action "fly" \(listened: rest\)/);
  assert.equal(r.steps[1]!.note, "Nothing fired.");
  assert.equal(r.steps[2]!.event, "unreadable step");
  assert.ok(r.warnings.some((w) => /No variable "mana"/.test(w)));
});

test("refuses an empty run and caps the step count", () => {
  assert.ok(executeSimulateBehaviors(world(), { steps: [] }).error);
  const many = executeSimulateBehaviors(world(), { steps: Array.from({ length: 14 }, () => ({ turn: true })) });
  assert.equal(many.steps.length, 10);
  assert.ok(many.warnings.some((w) => /first 10/.test(w)));
});

test("the run never touches the card itself", () => {
  const w = world();
  const before = JSON.stringify(w);
  executeSimulateBehaviors(w, { start: { hp: 9 }, steps: [{ action: "rest" }, { turn: true }] });
  assert.equal(JSON.stringify(w), before);
});
