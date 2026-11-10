import test from "node:test";
import assert from "node:assert/strict";
import type { WorldDefinition } from "@yumina/engine";
import { storySamplingParams } from "./station-sampling.js";
import { resolveSessionCompletionSettings } from "./completion-session-context.js";

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

// Values a player could save before the sliders were narrowed; the reported
// word-salad account had exactly temperature 1.45 / presence 1.71.
const extreme = { temperature: 1.9, frequencyPenalty: 1.6, presencePenalty: 1.71, topP: 0.9 };

test("the story call clamps the player's stored extremes at request time", () => {
  assert.deepEqual(storySamplingParams(undefined, extreme, clamp),
    { temperature: 1.5, frequencyPenalty: 1, presencePenalty: 1, topP: 0.9 });
  assert.deepEqual(storySamplingParams(undefined, { frequencyPenalty: -2 }, clamp),
    { temperature: 1, frequencyPenalty: 0 });
});

test("in-range player sampling is sent unchanged", () => {
  const sane = { temperature: 0.8, frequencyPenalty: 0.4, presencePenalty: 0.2, topK: 40, minP: 0.05 };
  assert.deepEqual(storySamplingParams(undefined, sane, clamp), sane);
});

test("an author-locked card keeps its own (author-clamped) values", () => {
  const settings = { samplingPolicy: "author", temperature: 0.6, presencePenalty: -0.5 } as WorldDefinition["settings"];
  assert.deepEqual(storySamplingParams(settings, extreme, clamp),
    { temperature: 0.6, presencePenalty: -0.5, frequencyPenalty: 1, topP: 0.9 });
});

test("a card's side call clamps the player's overrides the same way", () => {
  const world = { settings: {} } as unknown as WorldDefinition;
  const resolved = resolveSessionCompletionSettings({ overrides: { ...extreme, repetitionPenalty: 1.2 } }, world);
  assert.equal(resolved.temperature, 1.5);
  assert.equal(resolved.frequencyPenalty, 1);
  assert.equal(resolved.presencePenalty, 1);
  assert.equal(resolved.topP, 0.9);
  assert.equal(resolved.repetitionPenalty, 1.2);
});
