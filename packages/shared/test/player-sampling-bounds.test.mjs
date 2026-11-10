import assert from "node:assert/strict";
import test from "node:test";
import { AI_GENERATION_DEFAULTS, clampPlayerSampling, PLAYER_SAMPLING_BOUNDS, resolveAiGenerationConfig } from "../dist/index.js";

// The reported word-salad account: every value the old slider allowed.
const reported = { temperature: 1.45, frequencyPenalty: 0.93, presencePenalty: 1.71 };

test("extreme penalties and temperature are pulled back into the player range", () => {
  assert.deepEqual(clampPlayerSampling({ temperature: 1.9, frequencyPenalty: 2, presencePenalty: 1.71 }),
    { temperature: 1.5, frequencyPenalty: 1, presencePenalty: 1 });
  assert.deepEqual(clampPlayerSampling(reported), { temperature: 1.45, frequencyPenalty: 0.93, presencePenalty: 1 });
});

test("negative penalties floor at zero", () => {
  assert.deepEqual(clampPlayerSampling({ frequencyPenalty: -2, presencePenalty: -0.4 }), { frequencyPenalty: 0, presencePenalty: 0 });
});

test("in-range values, other keys and unset values pass through untouched", () => {
  const input = { temperature: 0.8, frequencyPenalty: 0.3, topP: 0.9, topK: 40, repetitionPenalty: 1.2, presencePenalty: undefined };
  assert.deepEqual(clampPlayerSampling(input), input);
  assert.equal(clampPlayerSampling(undefined), undefined);
  assert.deepEqual(clampPlayerSampling({ temperature: Number.NaN }), { temperature: Number.NaN });
});

test("the clamp returns a copy and never mutates the stored preferences", () => {
  const stored = { presencePenalty: 1.71 };
  clampPlayerSampling(stored);
  assert.equal(stored.presencePenalty, 1.71);
});

test("resolving saved preferences clamps them but keeps the rest", () => {
  const resolved = resolveAiGenerationConfig({ ...reported, topP: 0.7, repetitionPenalty: 1.3 });
  assert.equal(resolved.presencePenalty, 1);
  assert.equal(resolved.frequencyPenalty, 0.93);
  assert.equal(resolved.temperature, 1.45);
  assert.equal(resolved.topP, 0.7);
  assert.equal(resolved.repetitionPenalty, 1.3);
});

test("the defaults sit inside the bounds", () => {
  for (const [key, { min, max }] of Object.entries(PLAYER_SAMPLING_BOUNDS)) {
    assert.ok(AI_GENERATION_DEFAULTS[key] >= min && AI_GENERATION_DEFAULTS[key] <= max, key);
  }
});
