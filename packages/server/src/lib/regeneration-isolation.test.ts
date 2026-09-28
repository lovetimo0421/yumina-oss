import { test } from "node:test";
import assert from "node:assert/strict";
import type { WorldDefinition } from "@yumina/engine";
import { normalizeGameState } from "./game-state.js";
import { generationBaseline, messageGenerationState, regenerationState, reconcileRegenerationState } from "./regeneration-state.js";

const world = { id: "isolation", variables: [
  { id: "affection", name: "Affection", type: "number", defaultValue: 10 },
  { id: "character", name: "Character", type: "json", defaultValue: { hp: 100, panelOpen: false } },
], entries: [], rules: [] } as unknown as WorldDefinition;
const json = (value: unknown) => value as Record<string, unknown>;
const initial = () => normalizeGameState(world, { turnCount: 1 });

test("four alternative replies use the same complete starting variables and keep independent results", () => {
  const before = initial();
  const variants = [3, -2, 8, 0].map(delta => {
    const result = structuredClone(before);
    result.variables.affection = 10 + delta;
    return { generationState: structuredClone(before), stateSnapshot: result };
  });
  for (const variant of variants) {
    const live = structuredClone(variant.stateSnapshot);
    live.variables.character = { hp: 1, panelOpen: true };
    const base = regenerationState(world, live, { generationState: json(variant.generationState), stateSnapshot: json(variant.stateSnapshot) });
    assert.deepEqual(base.variables, before.variables);
  }
  assert.deepEqual(variants.map(v => v.stateSnapshot.variables.affection), [13, 8, 18, 10]);
});

test("changing a sibling JSON field does not preserve the discarded reply's numerical result", () => {
  const before = initial();
  const after = structuredClone(before);
  after.variables.character = { hp: 70, panelOpen: false };
  const live = structuredClone(after);
  live.variables.character = { hp: 70, panelOpen: true };
  assert.deepEqual(regenerationState(world, live, { generationState: json(before), stateSnapshot: json(after) }).variables.character,
    { hp: 100, panelOpen: false });
});

test("a concurrent write cannot mutate the stored pre-reply baseline", () => {
  const before = initial();
  const live = structuredClone(before);
  live.variables.character = { hp: 1, panelOpen: true };
  const saved = generationBaseline(world, live, before, before, before);
  assert.deepEqual(saved.variables, before.variables);
  (saved.variables.character as Record<string, unknown>).hp = 50;
  assert.equal((before.variables.character as Record<string, unknown>).hp, 100);
});

test("a replacement cannot adopt concurrent variables even if its result equals the previous reply", () => {
  const before = initial();
  const previous = structuredClone(before);
  previous.variables.affection = 13;
  const live = structuredClone(previous);
  live.variables.affection = 99;
  live.variables.character = { hp: 1, panelOpen: true };
  const result = reconcileRegenerationState(world, live, previous, previous);
  assert.deepEqual(result.variables, previous.variables);
});

test("selecting a legacy drifted alternative never replaces the message's earliest saved baseline", () => {
  const before = initial();
  const drifted = structuredClone(before);
  drifted.variables.affection = 13;
  const stored = messageGenerationState([{ generationState: json(before) }, { generationState: json(drifted) }]);
  assert.deepEqual(stored, before);
  assert.equal(messageGenerationState(null), undefined);
  assert.deepEqual(messageGenerationState([{}, { generationState: json(before) }]), before);
});
