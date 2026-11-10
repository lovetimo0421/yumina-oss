import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { GameStateManager, ResponseParser, isAiWritable, type WorldDefinition } from "@yumina/engine";
import { registerStateUpdateGuard } from "../extensions/state-update-guard/hooks.js";
import { STATE_GUARD_INSTRUCTIONS } from "../extensions/state-update-guard/validate.js";
import { __setInstalledLookupForTests, registerExtensionHooks, resolveTurnHooks, validateTurnOutput, type TurnOutputContext } from "./extension-hooks.js";
import { guardPrompt } from "./turn-output-validation.js";

const key = "state-update-guard";
const world: WorldDefinition = {
  id: "conditional-prompt", version: "1.0.0", name: "Conditional card", description: "", author: "test",
  entries: [], rules: [], components: [], audioTracks: [], customUI: [],
  settings: { maxTokens: 4000, temperature: 1 },
  variables: [
    { id: "encounter", name: "encounter", type: "boolean", defaultValue: true, aiAccess: "none" },
    { id: "hp", name: "health", type: "number", defaultValue: 100,
      activation: { mode: "conditions", conditions: [{ variableId: "encounter", operator: "eq", value: false }], conditionLogic: "all" } },
  ],
};
registerStateUpdateGuard();

function context(raw: string, state: TurnOutputContext["state"], path: "send" | "regenerate" | "continue") {
  let calls = 0;
  const ctx: TurnOutputContext = {
    world, state, raw, parsed: new ResponseParser().parse(raw), model: "fixture/story", maxContext: 32000,
    signal: new AbortController().signal, history: [], mayCorrect: async () => true,
    audit: { version: 1, attemptId: "fixture", path, outcome: "validating", diagnostics: [], parsedCount: 0,
      repaired: false, correctionCount: 0, model: "fixture/story", apiKeyTier: "byok",
      startedAt: new Date().toISOString(), baselineFingerprint: "fixture", usageLogIds: [] },
    progress: async () => {}, recordUsage: async () => "fixture-usage",
    provider: {
      async *generateStream() {
        calls++;
        yield { type: "text", content: JSON.stringify({ narrative: "", status: "none", stateChanges: [],
          review: world.variables.filter(v => isAiWritable(v, state)).map(v => ({ variableId: v.id, reason: "No injury occurs." })) }) };
        yield { type: "done", content: "", stopReason: "stop" };
      },
      async listModels() { throw new Error("Unexpected provider lookup"); },
    },
  };
  return { ctx, calls: () => calls };
}

for (const path of ["send", "regenerate", "continue"] as const) {
  for (const active of [false, true]) {
    for (const structured of [false, true]) {
      test(`${path}: ${active ? "one" : "zero"} conditionally writable variable, ${structured ? "structured" : "text"} output`, async () => {
        __setInstalledLookupForTests(async () => new Set([key]));
        try {
          const dispatch = await resolveTurnHooks({ ownerUserId: "unit", sessionId: "unit", session: { stateGuardEnabled: true } });
          const state = new GameStateManager(world).getSnapshot();
          state.variables.encounter = !active;
          assert.equal(world.variables.filter(v => isAiWritable(v, state)).length, active ? 1 : 0);
          const before = structuredClone(state);
          const prompt = guardPrompt(dispatch, { world, state });
          if (active) {
            assert.equal(prompt.content, STATE_GUARD_INSTRUCTIONS);
            assert.ok(prompt.reserve > 64);
          } else assert.deepEqual(prompt, { content: "", reserve: 0 });
          assert.ok(dispatch.activeExtensions.has(key), "prompt omission must leave validation enabled");
          const raw = structured
            ? JSON.stringify({ narrative: "The stranger waits.", ...(active ? { status: "none" } : {}), stateChanges: [] })
            : "The stranger waits." + (active ? '\n<yumina-state version="1" status="none" />' : "");
          const f = context(raw, state, path);
          const result = await validateTurnOutput(dispatch, f.ctx);
          assert.equal(result.parsed.cleanText, "The stranger waits.");
          assert.deepEqual(result.parsed.effects, []);
          assert.equal(result.audit?.outcome, active ? "explicit-none" : "not-required");
          assert.equal(f.calls(), 0);
          assert.deepEqual(state, before);
        } finally { __setInstalledLookupForTests(null); }
      });
    }
  }

  for (const structured of [false, true]) {
    test(`${path}: omitted prompt still validates and corrects rogue ${structured ? "structured" : "text"} write`, async () => {
      __setInstalledLookupForTests(async () => new Set([key]));
      try {
        const dispatch = await resolveTurnHooks({ ownerUserId: "unit", sessionId: "unit", session: {} });
        const state = new GameStateManager(world).getSnapshot();
        assert.deepEqual(guardPrompt(dispatch, { world, state }), { content: "", reserve: 0 });
        const raw = structured
          ? JSON.stringify({ narrative: "The stranger waits.", status: "updated", stateChanges: [{ variableId: "hp", operation: "set", value: 0 }] })
          : 'The stranger waits. [hp: set 0]\n<yumina-state version="1" status="updated" count="1" />';
        const f = context(raw, state, path);
        const result = await validateTurnOutput(dispatch, f.ctx);
        assert.equal(f.calls(), 1, "inactive write must still reach the actual correction runtime");
        assert.ok(result.audit?.diagnostics.includes("not_writable"));
        assert.equal(result.audit?.correctionCount, 1);
        assert.deepEqual(result.parsed.effects, []);
        assert.equal(result.parsed.cleanText, "The stranger waits.");
        assert.equal(state.variables.hp, 100);
      } finally { __setInstalledLookupForTests(null); }
    });
  }
}

test("conditional activation changes the next prompt without reinstalling Guard", async () => {
  __setInstalledLookupForTests(async () => new Set([key]));
  try {
    const dispatch = await resolveTurnHooks({ ownerUserId: "unit", sessionId: "unit", session: {} });
    const state = new GameStateManager(world).getSnapshot();
    assert.equal(guardPrompt(dispatch, { world, state }).content, "");
    state.variables.encounter = false;
    assert.equal(guardPrompt(dispatch, { world, state }).content, STATE_GUARD_INSTRUCTIONS);
    state.ruleState = { ...state.ruleState!, toggledVariables: { hp: false } };
    assert.deepEqual(guardPrompt(dispatch, { world, state }), { content: "", reserve: 0 });
  } finally { __setInstalledLookupForTests(null); }
});

test("Guard prompt omission preserves other extension instructions and original dispatch", () => {
  registerExtensionHooks("turn-counter", { turnOutputInstructions: () => "Keep the counter contract." });
  const dispatch = { activeExtensions: new Map([[key, new Set<string>()], ["turn-counter", new Set<string>()]]) };
  const state = new GameStateManager(world).getSnapshot();
  assert.equal(guardPrompt(dispatch, { world, state }).content, "Keep the counter contract.");
  assert.deepEqual([...dispatch.activeExtensions.keys()], [key, "turn-counter"]);
  assert.ok(guardPrompt(dispatch, { world, state }).reserve > 64);
});
