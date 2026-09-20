import test from "node:test";
import assert from "node:assert/strict";
import { GameStateManager, type WorldDefinition } from "@yumina/engine";
import type { TurnOutputContext } from "./extension-hooks.js";

// Set inert connection settings BEFORE dynamic imports. These are pure tests:
// no query executes and no developer/production credentials are consulted.
process.env.DATABASE_URL = "postgres://unit@127.0.0.1:1/unit";
process.env.DATABASE_READ_URL = "";
process.env.REDIS_URL = "";
process.env.POSTHOG_API_KEY = "";
process.env.BETTER_AUTH_SECRET = "state-guard-unit-test";
const { guardPrompt, regenerationBaseline, TurnOutputAttempt, appendTurnStateChanges } = await import("./turn-output-validation.js");
const { registerExtensionHooks, validateTurnOutput, resolveTurnHooks, __setInstalledLookupForTests } = await import("./extension-hooks.js");
const key = "state-update-guard";
const world: WorldDefinition = {
  id: "guard-fixture", version: "1.0.0", name: "Guard fixture", description: "", author: "unit",
  entries: [], rules: [], components: [], audioTracks: [], customUI: [], settings: { maxTokens: 4000, temperature: 1 },
  variables: [{ id: "hp", name: "health", type: "number", defaultValue: 100 }, { id: "ui", name: "ui", type: "json", defaultValue: { panel: "open" } }],
};
const makeState = () => new GameStateManager(world).getSnapshot();
const installed = { activeExtensions: new Map([[key, new Set<string>()]]) };
const absent = { activeExtensions: new Map<string, Set<string>>() };

test("send then continue then regenerate replaces both segments without accumulated effects", () => {
  const before = makeState();
  const sent = [{ variableId: "hp", oldValue: 100, newValue: 90 }];
  const continued = [{ variableId: "hp", oldValue: 90, newValue: 80 }];
  const ledger = appendTurnStateChanges(sent, continued);
  assert.equal((ledger as unknown as unknown[]).length, 2);
  const current = makeState(); current.variables.hp = 80;
  const baseline = regenerationBaseline(world, current, { activeSwipeIndex: 0, swipes: [{ generationState: before }], stateChanges: ledger });
  assert.equal(baseline.variables.hp, 100);
  const engine = new GameStateManager(world, baseline);
  engine.applyEffects([{ variableId: "hp", operation: "subtract", value: 10 }]);
  assert.equal(engine.get("hp"), 90);
  assert.deepEqual(appendTurnStateChanges(ledger, []), ledger);
});

test("uninstalled extension leaves parser result unchanged and reserves no tokens", async () => {
  let calls = 0;
  registerExtensionHooks(key, { turnOutputInstructions: () => "contract", validateTurnOutput: async () => { calls++; throw new Error("must not call"); } });
  const parsed = { cleanText: "Legacy prose", effects: [], audioEffects: [] };
  const result = await validateTurnOutput(absent, { parsed } as unknown as TurnOutputContext);
  assert.equal(result.parsed, parsed);
  assert.equal(calls, 0);
  assert.deepEqual(guardPrompt(absent), { content: "", reserve: 0 });
  assert.equal(guardPrompt(installed).content, "contract");
  assert.ok(guardPrompt(installed).reserve > 64);
});

test("installed validator is awaited before returning the replacement effects", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const parsed = { cleanText: "Original", effects: [], audioEffects: [] };
  const replacement = { ...parsed, cleanText: "Validated" };
  registerExtensionHooks(key, { validateTurnOutput: async () => { await gate; return { parsed: replacement }; } });
  let completed = false;
  const result = validateTurnOutput(installed, { parsed } as unknown as TurnOutputContext).then((value) => { completed = true; return value; });
  await Promise.resolve();
  assert.equal(completed, false);
  release();
  assert.equal((await result).parsed, replacement);
});

test("validator exceptions propagate rather than falling back to unchecked effects", async () => {
  const failure = new Error("invalid state batch");
  registerExtensionHooks(key, { validateTurnOutput: async () => { throw failure; } });
  await assert.rejects(validateTurnOutput(installed, { parsed: { cleanText: "Draft", effects: [], audioEffects: [] } } as unknown as TurnOutputContext), (error) => error === failure);
});

test("installed lookup gates the awaited seam even without capabilities", async () => {
  registerExtensionHooks(key, { validateTurnOutput: async (ctx) => ({ parsed: ctx.parsed }) });
  __setInstalledLookupForTests(async () => new Set([key]));
  try {
    const found = await resolveTurnHooks({ ownerUserId: "owner", sessionId: "session", session: {} });
    assert.ok(found.activeExtensions.has(key));
    __setInstalledLookupForTests(async () => new Set());
    assert.equal((await resolveTurnHooks({ ownerUserId: "owner", sessionId: "session", session: {} })).activeExtensions.size, 0);
  } finally { __setInstalledLookupForTests(null); }
});

test("regeneration reverses old turn effects without restoring unrelated saved UI values", () => {
  const current = makeState(); current.variables.hp = 40;
  const before = makeState(); before.variables.hp = 90;
  const selected = makeState(); selected.variables.hp = 70;
  current.variables.ui = { panel: "new selection" };
  const baseline = regenerationBaseline(world, current, { activeSwipeIndex: 1, swipes: [{ generationState: before }, { generationState: selected }], stateChanges: [{ variableId: "hp", oldValue: 70, newValue: 40 }] });
  assert.equal(baseline.variables.hp, 70);
  (baseline.variables.ui as { panel: string }).panel = "closed";
  assert.deepEqual(selected.variables.ui, { panel: "open" });
  assert.deepEqual(current.variables.ui, { panel: "new selection" });
  assert.equal(current.variables.hp, 40);
});

test("historical regeneration reverses repeated recorded deltas, preserving unrelated UI values", () => {
  const current = makeState(); current.variables.hp = 30; current.variables.ui = { panel: "closed" };
  const baseline = regenerationBaseline(world, current, { activeSwipeIndex: null, swipes: [], stateChanges: [{ variableId: "hp", oldValue: 100, newValue: 50 }, { variableId: "hp", oldValue: 50, newValue: 30 }] });
  assert.equal(baseline.variables.hp, 100);
  assert.deepEqual(baseline.variables.ui, { panel: "closed" });
  assert.equal(current.variables.hp, 30);
});

test("regeneration preserves current UI edits that superseded an old AI change", () => {
  const current = makeState(); current.variables.hp = 80;
  const baseline = regenerationBaseline(world, current, { activeSwipeIndex: 0, swipes: null, stateChanges: [{ variableId: "hp", oldValue: 100, newValue: 50 }, null] });
  assert.equal(baseline.variables.hp, 80);
});

test("regeneration preserves character-creation seeds in the saved pre-AI baseline", () => {
  const current = makeState(); current.variables.hp = 20;
  const seeded = makeState(); seeded.variables.hp = 20;
  const baseline = regenerationBaseline(world, current, { activeSwipeIndex: 0, swipes: [{ generationState: seeded }], stateChanges: [{ variableId: "hp", oldValue: 100, newValue: 20 }] });
  assert.equal(baseline.variables.hp, 20);
});

test("uninstalled attempt performs no database work and passes legacy effects through", async () => {
  const attempt = new TurnOutputAttempt({ dispatch: absent, userId: "unit", sessionId: "unit", targetId: "unit", path: "send", world, baseline: makeState(), model: "unit", apiKeyTier: "unit", startedAt: Date.now(), worldVersion: null, pendingVersion: null, worldId: world.id, checkPending: false, signal: new AbortController().signal });
  assert.equal(attempt.enabled, false);
  await attempt.begin();
  const parsed = { cleanText: "Legacy", effects: [], audioEffects: [] };
  const result = await attempt.validate({ parsed } as unknown as Parameters<typeof attempt.validate>[0], async () => { throw new Error("unexpected progress"); });
  assert.equal(result.parsed, parsed);
  await attempt.checkCommit(null as never, null, makeState());
  await attempt.finish(new AbortController().signal);
});

test("narrative usage audit link is stable and deduplicated per attempt", () => {
  const args = { dispatch: installed, userId: "unit", sessionId: "unit", targetId: "unit", path: "send" as const, world, baseline: makeState(), model: "unit", apiKeyTier: "unit", startedAt: Date.now(), worldVersion: null, pendingVersion: null, worldId: world.id, checkPending: false, signal: new AbortController().signal };
  const attempt = new TurnOutputAttempt(args);
  const usageId = attempt.trackNarrativeUsage();
  assert.equal(attempt.trackNarrativeUsage(), usageId);
  assert.deepEqual(attempt.audit.usageLogIds, [usageId]);
  assert.notEqual(new TurnOutputAttempt(args).trackNarrativeUsage(), usageId);
});

test("uninstalled turn can use a stable usage id without generating a guard audit", () => {
  const attempt = new TurnOutputAttempt({ dispatch: absent, userId: "unit", sessionId: "unit", targetId: "unit", path: "send", world, baseline: makeState(), model: "unit", apiKeyTier: "unit", startedAt: Date.now(), worldVersion: null, pendingVersion: null, worldId: world.id, checkPending: false, signal: new AbortController().signal });
  assert.equal(attempt.trackNarrativeUsage(), attempt.trackNarrativeUsage());
  assert.deepEqual(attempt.audit.usageLogIds, []);
});

test("guard audit records detached per-call AI and rule deltas with bounded previews", () => {
  const args = { dispatch: installed, userId: "unit", sessionId: "unit", targetId: "unit", path: "continue" as const, world, baseline: makeState(), model: "unit", apiKeyTier: "unit", startedAt: Date.now(), worldVersion: null, pendingVersion: null, worldId: world.id, checkPending: false, signal: new AbortController().signal };
  const attempt = new TurnOutputAttempt(args);
  const inventory = { items: ["bottle"] };
  attempt.recordChanges([{ variableId: "hp", oldValue: 100, newValue: 90 }, { variableId: "ui", oldValue: {}, newValue: inventory }], [{ variableId: "hp", oldValue: 90, newValue: 92 }]);
  inventory.items.push("later");
  assert.deepEqual(attempt.audit.changes, [
    { variableId: "hp", oldValue: 100, newValue: 90, source: "ai" },
    { variableId: "ui", oldValue: {}, newValue: { items: ["bottle"] }, source: "ai" },
    { variableId: "hp", oldValue: 90, newValue: 92, source: "rule" },
  ]);
  assert.notEqual(attempt.audit.committed, true, "computing deltas is not a transaction commit");
  attempt.recordChanges([], []);
  assert.deepEqual(attempt.audit.changes, [], "empty no-op is distinct from missing legacy details");
  attempt.recordChanges(Array.from({ length: 200 }, () => ({ variableId: "ui", oldValue: "x".repeat(5000), newValue: "y".repeat(5000) })), []);
  assert.equal(attempt.audit.changesTruncated, true);
  assert.match(JSON.stringify(attempt.audit.changes), /"truncated":true/);
  assert.ok(JSON.stringify(attempt.audit.changes).length < 52_000);
});
