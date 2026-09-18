import assert from "node:assert/strict";
import test from "node:test";
import { buildRankerModel } from "./ranker-model.js";

// Hand-built LightGBM dump_model() shape: one real split + one bias leaf.
const MODEL_JSON = {
  objective: "binary sigmoid:1",
  tree_info: [
    {
      tree_structure: {
        split_feature: 0,
        threshold: 0.5,
        decision_type: "<=",
        default_left: true,
        left_child: { leaf_value: -1.0 },
        right_child: { leaf_value: 1.0 },
      },
    },
    { tree_structure: { leaf_value: 0.5 } },
  ],
} as never;

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

test("ranker evaluator: walks trees and applies the binary sigmoid", () => {
  const model = buildRankerModel(1, MODEL_JSON, ["f0", "f1"]);
  // f0=0.4 → left leaf (-1.0) + bias 0.5 = -0.5
  assert.ok(Math.abs(model.predict({ f0: 0.4 }) - sigmoid(-0.5)) < 1e-9);
  // f0=0.9 → right leaf (1.0) + bias 0.5 = 1.5
  assert.ok(Math.abs(model.predict({ f0: 0.9 }) - sigmoid(1.5)) < 1e-9);
  // Absent features default to 0 → 0 <= 0.5 → left branch.
  assert.ok(Math.abs(model.predict({}) - sigmoid(-0.5)) < 1e-9);
});

test("ranker evaluator: unknown feature names are ignored, not crashed on", () => {
  const model = buildRankerModel(2, MODEL_JSON, ["f0", "f1"]);
  const p = model.predict({ f0: 0.9, totally_new_feature: 42 });
  assert.ok(Math.abs(p - sigmoid(1.5)) < 1e-9);
});

test("ranker evaluator: rejects categorical splits at load (trainer contract)", () => {
  const categorical = {
    tree_info: [
      {
        tree_structure: {
          split_feature: 0,
          threshold: 1,
          decision_type: "==",
          default_left: true,
          left_child: { leaf_value: 0 },
          right_child: { leaf_value: 1 },
        },
      },
    ],
  } as never;
  assert.throws(() => buildRankerModel(3, categorical, ["f0"]), /decision_type/);
});

test("ranker evaluator: rejects empty models", () => {
  assert.throws(() => buildRankerModel(4, { tree_info: [] } as never, ["f0"]), /no trees/);
});

test("ranker evaluator: regression model returns RAW value (no sigmoid), carries kind + baseline", () => {
  const regressionJson = {
    objective: "regression",
    tree_info: [
      {
        tree_structure: {
          split_feature: 0,
          threshold: 0.5,
          decision_type: "<=",
          default_left: true,
          left_child: { leaf_value: -1.0 },
          right_child: { leaf_value: 1.0 },
        },
      },
      { tree_structure: { leaf_value: 0.5 } },
    ],
  } as never;
  const model = buildRankerModel(5, regressionJson, ["f0", "f1"], 0.51);
  assert.equal(model.kind, "regression");
  assert.equal(model.valueBaseline, 0.51);
  // f0=0.9 → right leaf (1.0) + bias 0.5 = 1.5, returned RAW (no sigmoid).
  assert.ok(Math.abs(model.predict({ f0: 0.9 }) - 1.5) < 1e-9);
  assert.ok(Math.abs(model.predict({ f0: 0.4 }) - -0.5) < 1e-9);
});

test("ranker evaluator: legacy binary model reports kind=binary, baseline 0", () => {
  const model = buildRankerModel(6, MODEL_JSON, ["f0", "f1"]);
  assert.equal(model.kind, "binary");
  assert.equal(model.valueBaseline, 0);
});
