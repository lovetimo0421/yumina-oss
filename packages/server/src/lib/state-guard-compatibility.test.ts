import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { GameStateManager, ResponseParser, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { creditTransactions, creditWallets, usageLogs } from "../db/schema.js";
import { registerStateUpdateGuard } from "../extensions/state-update-guard/hooks.js";
import { __setInstalledLookupForTests, resolveTurnHooks, type TurnOutputContext } from "./extension-hooks.js";
import { guardPrompt, TurnOutputAttempt } from "./turn-output-validation.js";

// These tests deliberately use the real registration/resolver/attempt/validator.
// A preassembled empty dispatch would miss an entitlement regression that enables
// the Guard for everybody. All database state is isolated by test-local.mjs.
const key = "state-update-guard";
const paths = ["send", "regenerate", "continue"] as const;
const baseWorld: WorldDefinition = {
  id: "guard-compatibility", version: "1.0.0", name: "Legacy card", description: "", author: "test",
  entries: [], rules: [], components: [], audioTracks: [], customUI: [],
  settings: { maxTokens: 4000, temperature: 1 },
  variables: [{ id: "hp", name: "health", type: "number", defaultValue: 100 }],
};
registerStateUpdateGuard();

const forbiddenDatabase = new Proxy({}, {
  get(_target, property) { throw new Error(`Unexpected Guard database access: ${String(property)}`); },
}) as ConstructorParameters<typeof TurnOutputAttempt>[1];

function providerTrap() {
  let calls = 0;
  const provider: TurnOutputContext["provider"] = {
    async *generateStream() { calls++; throw new Error("Guard correction must not be requested"); },
    async listModels() { calls++; throw new Error("Guard models must not be queried"); },
  };
  return { provider, calls: () => calls };
}

async function billingSnapshot() {
  return {
    wallets: await db.select().from(creditWallets),
    transactions: await db.select().from(creditTransactions),
    usage: await db.select().from(usageLogs),
  };
}

for (const path of paths) {
  for (const mode of ["not-installed", "uninstalled-with-saved-settings", "installed-but-off"] as const) {
    for (const disabled of [false, true]) {
      test(`${path}: ${mode} bypasses Guard even with kill switch ${disabled}`, async () => {
        const previous = process.env.STATE_UPDATE_GUARD_DISABLED;
        process.env.STATE_UPDATE_GUARD_DISABLED = String(disabled);
        __setInstalledLookupForTests(async () => new Set(mode === "installed-but-off" ? [key] : []));
        try {
          const dispatch = await resolveTurnHooks({ ownerUserId: "legacy-owner", sessionId: "legacy-chat", session: {
            stateGuardEnabled: mode !== "installed-but-off",
            stateGuardModel: "official::deliberately-unavailable-correction-model",
          } });
          assert.equal(dispatch.activeExtensions.has(key), false);
          assert.equal(dispatch.outputModels?.has(key) ?? false, false);
          assert.deepEqual(guardPrompt(dispatch), { content: "", reserve: 0 });
          const beforeBilling = await billingSnapshot();
          const state = new GameStateManager(baseWorld).getSnapshot();
          const signal = new AbortController().signal;
          const attempt = new TurnOutputAttempt({ dispatch, path, world: baseWorld, baseline: state,
            userId: "legacy-owner", sessionId: "legacy-chat", targetId: "legacy-message", worldId: baseWorld.id,
            model: "legacy-story-model", apiKeyTier: "byok", startedAt: Date.now(),
            worldVersion: null, pendingVersion: null, checkPending: false, signal,
          }, forbiddenDatabase);
          const trap = providerTrap();
          const raw = "The character gets hurt. [hp: subtract 5]";
          const parsed = new ResponseParser().parse(raw);
          assert.equal(parsed.effects.length, 1, "fixture must exercise a real legacy update without a receipt");
          await attempt.begin();
          const result = await attempt.validate({ world: baseWorld, state, raw, parsed, provider: trap.provider,
            model: "legacy-story-model", maxContext: 32000, signal, history: [],
          }, async () => { throw new Error("Guard progress must not run"); });
          assert.equal(result.parsed, parsed, "legacy parser result must pass through, not be reparsed or rejected");
          const game = new GameStateManager(baseWorld, state);
          const changes = game.applyEffects(result.parsed.effects);
          assert.equal(game.get("hp"), 95);
          attempt.recordChanges(changes, []);
          await attempt.prepareStoryCharge({ model: "legacy-story-model", promptTokens: 1000, completionTokens: 100 });
          await attempt.checkCommit(null as never, state, game.getSnapshot());
          attempt.markCommitted();
          await attempt.progress();
          await attempt.finish(signal);
          assert.equal(attempt.enabled, false);
          assert.equal(attempt.started, false);
          assert.equal(attempt.storyCharge, undefined, "normal story billing must retain ownership of its charge");
          assert.equal(attempt.correctionBalance, undefined);
          assert.deepEqual(attempt.audit.usageLogIds, []);
          assert.deepEqual(attempt.audit.changes, []);
          assert.equal(trap.calls(), 0);
          assert.deepEqual(await billingSnapshot(), beforeBilling, "bypass must not create a wallet, usage, or debit");
        } finally {
          __setInstalledLookupForTests(null);
          if (previous === undefined) delete process.env.STATE_UPDATE_GUARD_DISABLED;
          else process.env.STATE_UPDATE_GUARD_DISABLED = previous;
        }
      });
    }
  }
}

const unwritableCards: Array<{ name: string; variables: WorldDefinition["variables"]; runtimeDisabled?: boolean }> = [
  { name: "narrative-only", variables: [] },
  { name: "read-only", variables: [{ ...baseWorld.variables[0]!, aiAccess: "read" }] },
  { name: "AI-hidden", variables: [{ ...baseWorld.variables[0]!, aiAccess: "none" }] },
  { name: "internal", variables: [{ ...baseWorld.variables[0]!, internal: true }] },
  { name: "disabled", variables: [{ ...baseWorld.variables[0]!, enabled: false }] },
  { name: "runtime-disabled", variables: baseWorld.variables, runtimeDisabled: true },
  { name: "inactive-greeting", variables: [{ ...baseWorld.variables[0]!, activation: { mode: "greeting", greetingIds: ["another-greeting"] } }] },
];

for (const path of paths) {
  for (const card of unwritableCards) {
    test(`${path}: enabled Guard accepts ${card.name} card without receipt or correction charge`, async () => {
      __setInstalledLookupForTests(async () => new Set([key]));
      try {
        const dispatch = await resolveTurnHooks({ ownerUserId: "installed-owner", sessionId: "installed-chat", session: {
          stateGuardEnabled: true, stateGuardModel: "official::unavailable-model-must-not-be-resolved",
        } });
        assert.equal(dispatch.activeExtensions.has(key), true, "test must exercise the enabled real Guard");
        const world = { ...baseWorld, variables: card.variables };
        const state = new GameStateManager(world).getSnapshot();
        if (card.runtimeDisabled) state.ruleState = { ...state.ruleState!, toggledVariables: { hp: false } };
        const before = structuredClone(state);
        const beforeBilling = await billingSnapshot();
        for (const raw of ["The stranger waits.", '{"narrative":"The stranger waits.","stateChanges":[]}']) {
          const signal = new AbortController().signal;
          const attempt = new TurnOutputAttempt({ dispatch, path, world, baseline: state,
            userId: "installed-owner", sessionId: "installed-chat", targetId: "installed-message", worldId: world.id,
            model: "story-model", apiKeyTier: "byok", startedAt: Date.now(),
            worldVersion: null, pendingVersion: null, checkPending: false, signal,
          }, forbiddenDatabase);
          const trap = providerTrap();
          // begin/commit persist an enabled audit in ordinary gameplay; this test
          // isolates validation and pricing, which must need no DB or provider.
          const result = await attempt.validate({ world, state, raw, parsed: new ResponseParser().parse(raw),
            provider: trap.provider, model: "story-model", maxContext: 32000, signal, history: [],
          }, async () => { throw new Error("No repair progress should be emitted"); });
          assert.equal(result.audit?.outcome, "not-required");
          assert.equal(result.parsed.cleanText, "The stranger waits.");
          assert.deepEqual(result.parsed.effects, []);
          assert.equal(attempt.audit.correctionCount, 0);
          assert.equal(attempt.audit.correctionModel, undefined);
          await attempt.prepareStoryCharge({ model: "story-model", promptTokens: 1000, completionTokens: 100 });
          attempt.markCommitted();
          assert.equal(attempt.storyCharge, undefined);
          assert.equal(attempt.correctionBalance, undefined);
          assert.equal(trap.calls(), 0);
        }
        assert.deepEqual(state, before);
        assert.deepEqual(await billingSnapshot(), beforeBilling);
      } finally { __setInstalledLookupForTests(null); }
    });
  }
}
