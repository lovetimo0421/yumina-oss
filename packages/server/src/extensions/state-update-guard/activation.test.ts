import "../../test/database-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { WorldDefinition } from "@yumina/engine";
import { GameStateManager } from "@yumina/engine";
import { db } from "../../db/index.js";
import { user, userExtensions } from "../../db/schema.js";
import { edition } from "../../edition/index.js";
import { registerStateUpdateGuard } from "./hooks.js";
import { isStateGuardActive, stateGuardDefaultApplies, worldHasAiWritableVariables } from "./activation.js";
import { __setInstalledLookupForTests, __setUninstalledLookupForTests, resolveTurnHooks, turnOutputInstructions } from "../../lib/extension-hooks.js";

const key = "state-update-guard";
const base = {
  id: "activation-fixture", version: "1.0.0", name: "Activation fixture", description: "", author: "unit",
  entries: [], rules: [], components: [], audioTracks: [], customUI: [], settings: { maxTokens: 4000, temperature: 1 },
} satisfies Omit<WorldDefinition, "variables">;
const stateful: WorldDefinition = { ...base, variables: [
  { id: "ui", name: "UI", type: "json", defaultValue: {}, aiAccess: "read" },
  { id: "hp", name: "Health", type: "number", defaultValue: 100 },
] };
const readOnly: WorldDefinition = { ...base, variables: [
  { id: "ui", name: "UI", type: "json", defaultValue: {}, aiAccess: "read" },
  { id: "hidden", name: "Hidden", type: "number", defaultValue: 0, aiAccess: "none" },
  { id: "internal", name: "Internal", type: "number", defaultValue: 0, internal: true },
] };
const noVariables: WorldDefinition = { ...base, variables: [] };

function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>) {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  return run().finally(() => {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  });
}

async function resolve(opts: { installed?: boolean; uninstalled?: boolean; world?: WorldDefinition; session?: Record<string, unknown> }) {
  __setInstalledLookupForTests(async () => new Set(opts.installed ? [key] : []));
  __setUninstalledLookupForTests(async () => new Set(opts.uninstalled ? [key] : []));
  try {
    return await resolveTurnHooks({ ownerUserId: "owner", sessionId: "chat", session: opts.session ?? {}, world: opts.world });
  } finally { __setInstalledLookupForTests(null); __setUninstalledLookupForTests(null); }
}

test("AI-writable detection matches the engine's internal/aiAccess reading", () => {
  assert.equal(worldHasAiWritableVariables(stateful), true);
  assert.equal(worldHasAiWritableVariables(readOnly), false);
  assert.equal(worldHasAiWritableVariables(noVariables), false);
  assert.equal(worldHasAiWritableVariables(undefined), false);
});

test("guard is on by default for never-installed players of cards with AI-writable variables", async (t) => {
  const info = edition.info();
  t.mock.method(edition, "info", () => ({ ...info, features: { ...info.features, officialModels: true } }));
  registerStateUpdateGuard();
  await withEnv({ STATE_UPDATE_GUARD_DEFAULT: undefined, STATE_UPDATE_GUARD_DISABLED: undefined }, async () => {
    const dispatch = await resolve({ world: stateful, session: { stateGuardEnabled: true, stateGuardModel: "official::paid/model" } });
    assert.ok(dispatch.activeExtensions.has(key));
    assert.ok(dispatch.defaultActivated?.has(key));
    assert.equal(dispatch.outputModels?.has(key), false, "default path never uses a saved correction model");
    assert.ok(turnOutputInstructions(dispatch, { world: stateful, state: new GameStateManager(stateful).getSnapshot() }).includes("yumina-state"));
    // Legacy sessions (no stateGuardEnabled on the row) are on too.
    assert.ok((await resolve({ world: stateful })).defaultActivated?.has(key));
  });
});

test("default stays off for opt-outs, stateless cards, missing world and the kill switches", async () => {
  registerStateUpdateGuard();
  await withEnv({ STATE_UPDATE_GUARD_DEFAULT: undefined, STATE_UPDATE_GUARD_DISABLED: undefined }, async () => {
    assert.equal((await resolve({ world: stateful, uninstalled: true })).activeExtensions.has(key), false, "explicit uninstall opts out");
    assert.equal((await resolve({ world: stateful, session: { stateGuardEnabled: false } })).activeExtensions.has(key), false, "per-chat switch opts out");
    assert.equal((await resolve({ world: readOnly })).activeExtensions.has(key), false);
    assert.equal((await resolve({ world: noVariables })).activeExtensions.has(key), false);
    assert.equal((await resolve({})).activeExtensions.has(key), false, "no world means no default");
  });
  for (const value of ["off", "OFF", " off "]) {
    await withEnv({ STATE_UPDATE_GUARD_DEFAULT: value }, async () => {
      assert.equal(stateGuardDefaultApplies(stateful), false);
      assert.equal((await resolve({ world: stateful })).activeExtensions.has(key), false);
    });
  }
  await withEnv({ STATE_UPDATE_GUARD_DISABLED: "true" }, async () => {
    assert.equal((await resolve({ world: stateful })).activeExtensions.has(key), false, "emergency switch must not fail default players' turns");
  });
});

test("default needs a platform key: editions without official models keep it off", async (t) => {
  registerStateUpdateGuard();
  const info = edition.info();
  t.mock.method(edition, "info", () => ({ ...info, features: { ...info.features, officialModels: false } }));
  assert.equal((await resolve({ world: stateful })).activeExtensions.has(key), false);
});

test("installed players are unchanged by the default and its kill switch", async () => {
  registerStateUpdateGuard();
  for (const env of [{ STATE_UPDATE_GUARD_DEFAULT: undefined }, { STATE_UPDATE_GUARD_DEFAULT: "off" }]) {
    await withEnv(env, async () => {
      for (const world of [stateful, readOnly, undefined]) {
        const dispatch = await resolve({ installed: true, world, session: { stateGuardModel: "official::chosen/model" } });
        assert.ok(dispatch.activeExtensions.has(key));
        assert.equal(dispatch.defaultActivated?.has(key), false);
        assert.equal(dispatch.outputModels?.get(key), "official::chosen/model");
      }
      assert.equal((await resolve({ installed: true, world: stateful, session: { stateGuardEnabled: false } })).activeExtensions.has(key), false);
    });
  }
});

test("mayCorrect re-check follows the same rule against real install rows", async (t) => {
  const info = edition.info();
  t.mock.method(edition, "info", () => ({ ...info, features: { ...info.features, officialModels: true } }));
  const fresh = `guard-default-${crypto.randomUUID()}`;
  const installed = `guard-installed-${crypto.randomUUID()}`;
  const removed = `guard-removed-${crypto.randomUUID()}`;
  await db.insert(user).values([fresh, installed, removed].map((id) => ({ id, name: id, email: `${id}@test.local` })));
  await db.insert(userExtensions).values([
    { userId: installed, extensionKey: key, status: "installed" },
    { userId: removed, extensionKey: key, status: "uninstalled", uninstalledAt: new Date() },
  ]);
  try {
    await withEnv({ STATE_UPDATE_GUARD_DEFAULT: undefined, STATE_UPDATE_GUARD_DISABLED: undefined }, async () => {
      assert.equal(await isStateGuardActive(fresh, stateful), true);
      assert.equal(await isStateGuardActive(fresh, readOnly), false);
      assert.equal(await isStateGuardActive(removed, stateful), false, "uninstall row is an opt-out");
      assert.equal(await isStateGuardActive(installed, readOnly), true);
    });
    await withEnv({ STATE_UPDATE_GUARD_DEFAULT: "off" }, async () => {
      assert.equal(await isStateGuardActive(fresh, stateful), false);
      assert.equal(await isStateGuardActive(installed, stateful), true);
    });
    await withEnv({ STATE_UPDATE_GUARD_DISABLED: "true" }, async () => {
      assert.equal(await isStateGuardActive(installed, stateful), false, "existing emergency behaviour preserved");
      assert.equal(await isStateGuardActive(fresh, stateful), false);
    });
  } finally { await db.delete(user).where(eq(user.id, fresh)); await db.delete(user).where(eq(user.id, installed)); await db.delete(user).where(eq(user.id, removed)); }
});
