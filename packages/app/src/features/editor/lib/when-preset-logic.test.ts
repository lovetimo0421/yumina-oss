import test from "node:test";
import assert from "node:assert/strict";
import { resolveWhenPreset, buildWhenForPreset } from "./when-preset-logic";
import type { WhenPresetLike } from "./when-preset-logic";

// Mirrors the two turn:complete presets from behaviors-section.tsx —
// "Every Turn" (bare) and "Every N turns" (turnCount marker field).
const everyTurn: WhenPresetLike = { id: "every-turn", eventType: "turn:complete" };
const turnN: WhenPresetLike = {
  id: "turn-n",
  eventType: "turn:complete",
  fields: [{ name: "turnCount", operator: "every", placeholder: "5" }],
};
const sessionStart: WhenPresetLike = { id: "session-start", eventType: "session:start" };
const presets = [everyTurn, sessionStart, turnN];

test("buildWhenForPreset seeds the turnCount marker for 'Every N turns'", () => {
  assert.deepEqual(buildWhenForPreset(turnN), {
    eventType: "turn:complete",
    match: { turnCount: { operator: "every", value: 5 } },
  });
});

test("buildWhenForPreset falls back to 2 when the placeholder is not a positive number", () => {
  const noPlaceholder: WhenPresetLike = {
    id: "x",
    eventType: "turn:complete",
    fields: [{ name: "turnCount", operator: "every" }],
  };
  assert.equal(buildWhenForPreset(noPlaceholder).match?.turnCount?.value, 2);
});

test("buildWhenForPreset produces a bare pattern for presets without marker fields", () => {
  assert.deepEqual(buildWhenForPreset(everyTurn), { eventType: "turn:complete" });
});

test("round-trip: the built pattern resolves back to the same preset", () => {
  // This is the regression: selecting "Every N turns" used to write a bare
  // turn:complete pattern that resolved back to "Every Turn" (and fired
  // every turn at runtime).
  assert.equal(resolveWhenPreset(presets, buildWhenForPreset(turnN))?.id, "turn-n");
  assert.equal(resolveWhenPreset(presets, buildWhenForPreset(everyTurn))?.id, "every-turn");
});

test("resolveWhenPreset maps a bare turn:complete pattern to 'Every Turn', never 'Every N turns'", () => {
  // Order-independence: even if the marker-field preset comes first.
  assert.equal(
    resolveWhenPreset([turnN, everyTurn], { eventType: "turn:complete" })?.id,
    "every-turn",
  );
});

test("resolveWhenPreset maps a pattern with a turnCount match to 'Every N turns'", () => {
  const when = {
    eventType: "turn:complete",
    match: { turnCount: { operator: "every" as const, value: 7 } },
  };
  assert.equal(resolveWhenPreset(presets, when)?.id, "turn-n");
});

test("resolveWhenPreset returns null for unknown event types", () => {
  assert.equal(resolveWhenPreset(presets, { eventType: "nope" }), null);
});
