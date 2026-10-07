import test from "node:test";
import assert from "node:assert/strict";
import { resolvePlaytestIssue, type PlaytestIssue } from "./playtest-recovery-state";

const ready = { sessionId: "play", activeSessionId: "play", streaming: false, hasModel: true, privateCatalogEmpty: false, failure: null, error: null };
test("playtest recovery distinguishes server rejections and never guesses from wallet balance", () => {
  assert.equal(resolvePlaytestIssue(ready), null);
  assert.equal(resolvePlaytestIssue({ ...ready, hasModel: false }), "model");
  assert.equal(resolvePlaytestIssue({ ...ready, privateCatalogEmpty: true }), "provider");
  const cases: [string, PlaytestIssue][] = [["NO_CREDITS", "credits"], ["MODEL_NOT_ALLOWED", "modelAccess"], ["RATE_LIMITED", "busy"],
    ["CONCURRENT_LIMIT", "busy"], ["MESSAGE_TOO_LONG", "tooLong"], ["SUSPENDED", "access"], ["PROTECTED_WORLD", "access"],
    ["CONNECTION_UNCERTAIN", "connection"], ["GENERATION_FAILED", "request"]];
  for (const [code, expected] of cases) assert.equal(resolvePlaytestIssue({ ...ready, failure: { sessionId: "play", code } }), expected);
  assert.equal(resolvePlaytestIssue({ ...ready, failure: { sessionId: "play", code: "NO_CREDITS", balance: 4 } }), "promptCost");
});
test("recovery ignores another conversation and in-flight generations", () => {
  const failure = { sessionId: "play", code: "NO_CREDITS" };
  assert.equal(resolvePlaytestIssue({ ...ready, failure, streaming: true }), null);
  assert.equal(resolvePlaytestIssue({ ...ready, failure, activeSessionId: "other" }), null);
  assert.equal(resolvePlaytestIssue({ ...ready, failure: { ...failure, sessionId: "old" }, error: "old error" }), null);
});
