import assert from "node:assert/strict";
import test from "node:test";
import { aiDecisionRequestSchema, parseAiDecisionResponse } from "../dist/index.js";

test("choice decisions accept eight questions with sixty-four choices each", () => {
  const criteria = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`option_${index}`, `Description ${index}`]));
  const questions = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`question_${index}`, { type: "choice", instructions: "Choose", criteria }]));
  assert.equal(aiDecisionRequestSchema.safeParse({ state: { nested: [{ safe: true, number: 1, empty: null }] }, questions }).success, true);
});

test("all provider numbers must be finite probabilities and confidence is never filled in", () => {
  const questions = { action: { type: "choice", instructions: "Choose", criteria: { wait: "Wait", bow: "Bow" } } };
  const answer = { choice: "wait", probabilities: { wait: 0.75, bow: 0.25 }, confidence: 0.75 };
  assert.deepEqual(parseAiDecisionResponse({ answers: { action: answer }, providerDebug: "omit" }, questions), { answers: { action: answer } });
  for (const invalid of [NaN, Infinity, -Infinity, -0.1, 1.1, "0.75", null, undefined]) {
    assert.equal(parseAiDecisionResponse({ answers: { action: { ...answer, confidence: invalid } } }, questions), null);
    assert.equal(parseAiDecisionResponse({ answers: { action: { ...answer, probabilities: { wait: invalid, bow: 0.25 } } } }, questions), null);
  }
  assert.equal(parseAiDecisionResponse({ answers: { action: answer, unknown: answer } }, questions), null);
  assert.equal(parseAiDecisionResponse({ answers: {} }, questions), null);
  assert.equal(parseAiDecisionResponse({ answers: { action: { ...answer, choice: "toString" } } }, questions), null);
});

test("decision observations reject cycles and non-JSON values before serialization", () => {
  const questions = { action: { type: "choice", instructions: "Choose", criteria: { wait: "Wait" } } };
  const cyclic = {}; cyclic.self = cyclic;
  for (const value of [cyclic, NaN, Infinity, new Date(), () => {}, 1n, undefined]) {
    assert.equal(aiDecisionRequestSchema.safeParse({ state: { value }, questions }).success, false);
  }
});
