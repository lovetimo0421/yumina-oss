import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Worldbook } from "@yumina/engine";
import { moduleActivationBadge } from "./module-badge";

const book = (activation: Worldbook["activation"], enabled?: boolean): Worldbook =>
  ({ id: "m", name: "m", entries: [], activation, ...(enabled === false ? { enabled } : {}) }) as unknown as Worldbook;
const varName = (id: string) => ({ loc: "位置" })[id] ?? id;

test("a switched-off module says so before anything else", () => {
  assert.deepEqual(moduleActivationBadge(book({ mode: "conditions", conditions: [], conditionLogic: "all" }, false), varName), { kind: "disabled" });
});

test("a condition badge reads as the condition, by variable name", () => {
  const b = book({ mode: "conditions", conditions: [{ variableId: "loc", operator: "eq", value: "副本A" }], conditionLogic: "all" });
  assert.deepEqual(moduleActivationBadge(b, varName), { kind: "conditions", detail: "位置 = 副本A" });
});

test("keywords show the first three words; openings show how many", () => {
  assert.deepEqual(
    moduleActivationBadge(book({ mode: "keywords", keywords: ["a", "b", "c", "d"], exclusive: true }), varName),
    { kind: "keywords", detail: "a · b · c" },
  );
  assert.deepEqual(moduleActivationBadge(book({ mode: "greeting", greetingIds: ["g1", "g2"] }), varName), { kind: "greeting", count: 2 });
});

test("an unconfigured rule carries no detail, so the label alone is shown", () => {
  assert.deepEqual(moduleActivationBadge(book({ mode: "conditions", conditions: [], conditionLogic: "all" }), varName), { kind: "conditions" });
  assert.deepEqual(moduleActivationBadge(book({ mode: "always" }), varName), { kind: "always" });
  assert.deepEqual(moduleActivationBadge(book({ mode: "manual" }), varName), { kind: "manual" });
});
