import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Worldbook } from "@yumina/engine";
import { moduleSceneState } from "./scene-state";

/**
 * The frontend block previews the interface "as module X": it forces the
 * preview variables into the state that opens X. Only an `eq` condition
 * names such a state; everything else has no single value to force.
 */

const book = (activation: Worldbook["activation"]): Worldbook => ({ id: "m", name: "M", order: 0, activation });

test("reads the variables a conditions module needs to be on", () => {
  assert.deepEqual(
    moduleSceneState(
      book({
        mode: "conditions",
        conditionLogic: "all",
        conditions: [
          { variableId: "location", operator: "eq", value: "副本A" },
          { variableId: "unlocked", operator: "eq", value: true },
        ],
      }),
    ),
    { location: "副本A", unlocked: true },
  );
});

test("ignores the conditions it cannot force and keeps the ones it can", () => {
  assert.deepEqual(
    moduleSceneState(
      book({
        mode: "conditions",
        conditionLogic: "all",
        conditions: [
          { variableId: "floor", operator: "gte", value: 3 },
          { variableId: "location", operator: "eq", value: "副本C" },
        ],
      }),
    ),
    { location: "副本C" },
  );
});

test("has no state for a module nothing in the variables opens", () => {
  assert.equal(moduleSceneState(book({ mode: "always" })), null);
  assert.equal(moduleSceneState(book({ mode: "manual" })), null);
  assert.equal(moduleSceneState(book({ mode: "keywords", keywords: ["mine"], exclusive: true })), null);
  assert.equal(
    moduleSceneState(book({ mode: "conditions", conditionLogic: "all", conditions: [{ variableId: "hp", operator: "lt", value: 10 }] })),
    null,
  );
  assert.equal(moduleSceneState(book({ mode: "conditions", conditionLogic: "all", conditions: [] })), null);
});

test("does not force a comparison against another variable", () => {
  assert.equal(
    moduleSceneState(
      book({
        mode: "conditions",
        conditionLogic: "all",
        conditions: [{ variableId: "a", operator: "eq", value: 1, valueRef: "b" }],
      }),
    ),
    null,
  );
});
