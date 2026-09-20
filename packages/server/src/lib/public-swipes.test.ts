import test from "node:test";
import assert from "node:assert/strict";
import { publicSwipes } from "./public-swipes.js";

test("public replay swipes exclude private validation evidence and baseline", () => {
  const swipe = { content: "Story", stateSnapshot: { variables: { hp: 5 } }, stateValidation: { originalRaw: "private", usageLogIds: ["private"] }, generationState: { private: true } };
  assert.deepEqual(publicSwipes([swipe]), [{ content: "Story", stateSnapshot: { variables: { hp: 5 } } }]);
  assert.ok(swipe.stateValidation);
});

test("historical swipes and empty collections remain compatible", () => {
  assert.deepEqual(publicSwipes(null), []);
  assert.deepEqual(publicSwipes([{ content: "Old", stateValidation: undefined }]), [{ content: "Old" }]);
});
