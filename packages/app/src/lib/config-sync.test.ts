import test from "node:test";
import assert from "node:assert/strict";
import { MAX_PINNED_MODELS, DEFAULT_PINNED_MODELS, DEFAULT_POOL, SHIPPED_DEFAULT_PINNED_MODELS, SHIPPED_DEFAULT_POOLS } from "@yumina/shared";

/**
 * Regressions for "I pinned a model, refreshed, and the star was gone".
 *
 * Two independent causes, both here:
 *  1. A pin that hits the cap used to be a silent no-op — the caller had no way
 *     to tell the user why nothing happened.
 *  2. A pushed edit that never reached the server (offline, 429 from the
 *     profile-updates limiter, request cancelled on unload) was dropped on the
 *     floor, and the next syncFromServer overwrote the local value with the
 *     server's stale blob.
 */

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
  keepalive: boolean;
}

const memory = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, String(v)),
  removeItem: (k: string) => void memory.delete(k),
  clear: () => memory.clear(),
  key: () => null,
  length: 0,
};

const calls: FetchCall[] = [];
let putOk = true;
let remoteConfig: Record<string, unknown> = {};

(globalThis as unknown as { fetch: unknown }).fetch = async (
  url: unknown,
  init?: { method?: string; body?: string; keepalive?: boolean },
) => {
  const method = init?.method ?? "GET";
  calls.push({
    url: String(url),
    method,
    body: init?.body ? JSON.parse(init.body) : undefined,
    keepalive: init?.keepalive === true,
  });
  if (method === "PUT") {
    return { ok: putOk, status: putOk ? 200 : 429, json: async () => ({}) };
  }
  return { ok: true, status: 200, json: async () => ({ data: remoteConfig }) };
};

const { useConfigStore, migrateConfig, adoptConfigFromOtherTab } = await import("../stores/config");

async function reset() {
  putOk = true;
  remoteConfig = {};
  // Drain anything a previous test left queued — an unconfirmed edit is sticky
  // by design, so it has to be flushed successfully before the next case.
  await useConfigStore.getState().flushPendingPush();
  calls.length = 0;
  useConfigStore.setState({ pinnedModels: [], pinnedPrivateModels: [] });
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Longer than the store's 800ms push debounce. */
const PUSH_SETTLE_MS = 1000;

test("pinModel reports refusal when the list is full instead of doing nothing", async () => {
  await reset();
  const full = Array.from({ length: MAX_PINNED_MODELS }, (_, i) => `custom/model-${i}`);
  useConfigStore.setState({ pinnedPrivateModels: full });

  const accepted = useConfigStore.getState().pinModel("custom/one-too-many", "private");

  assert.equal(accepted, false, "pin past the cap must report failure, not silently succeed");
  assert.deepEqual(useConfigStore.getState().pinnedPrivateModels, full);
});

test("pinModel accepts a pin below the cap and reports success", async () => {
  await reset();
  const accepted = useConfigStore.getState().pinModel("custom/grok-4-1-fast", "private");
  assert.equal(accepted, true);
  assert.deepEqual(useConfigStore.getState().pinnedPrivateModels, ["custom/grok-4-1-fast"]);
});

test("the config push is keepalive so an unload flush is not cancelled", async () => {
  await reset();
  useConfigStore.getState().pinModel("custom/keepalive-check", "private");
  await useConfigStore.getState().flushPendingPush();

  const put = calls.find((c) => c.method === "PUT");
  assert.ok(put, "pinning must push to the server");
  assert.equal(put.keepalive, true, "without keepalive the browser cancels the push on refresh");
});

test("a rejected push is retried instead of being silently dropped", async () => {
  await reset();
  putOk = false;
  useConfigStore.getState().pinModel("custom/retry-me", "private");

  await tick(PUSH_SETTLE_MS);
  const firstAttempt = calls.filter((c) => c.method === "PUT").length;
  assert.equal(firstAttempt, 1, "first push attempt should have fired");

  putOk = true;
  await tick(PUSH_SETTLE_MS * 2);

  const puts = calls.filter((c) => c.method === "PUT");
  assert.ok(puts.length >= 2, "a failed push must be retried");
  assert.deepEqual(
    puts[puts.length - 1]!.body,
    { pinnedPrivateModels: ["custom/retry-me"] },
    "the retry must carry the same edit",
  );
});

test("syncFromServer does not revert an edit the server has not confirmed", async () => {
  await reset();
  putOk = false;
  // Server still holds the pre-pin blob, exactly like a reload after a push
  // that never landed.
  remoteConfig = { pinnedPrivateModels: ["custom/from-the-old-blob"] };

  useConfigStore.getState().pinModel("custom/my-byok-model", "private");
  await tick(PUSH_SETTLE_MS);

  await useConfigStore.getState().syncFromServer();

  assert.deepEqual(
    useConfigStore.getState().pinnedPrivateModels,
    ["custom/my-byok-model"],
    "a stale server snapshot must not overwrite an unconfirmed local pin",
  );
});

test("syncFromServer still applies server values for untouched keys", async () => {
  await reset();
  remoteConfig = {
    pinnedModels: [DEFAULT_PINNED_MODELS[0]],
    pinnedPrivateModels: ["custom/from-another-device"],
    maxTokens: 9001,
  };

  await useConfigStore.getState().syncFromServer();

  const state = useConfigStore.getState();
  assert.deepEqual(state.pinnedModels, [DEFAULT_PINNED_MODELS[0]]);
  assert.deepEqual(state.pinnedPrivateModels, ["custom/from-another-device"]);
  assert.equal(state.maxTokens, 9001);
});

/**
 * Regressions for "I can't click the star on my own API's models any more".
 *
 * Stars only exist in the BYOK picker — OfficialView renders none. But every
 * account is seeded with DEFAULT_PINNED_MODELS, official ids that the BYOK
 * picker cannot render (models.find misses, so they are filtered out) and yet
 * still counted against the 8-pin cap. Most of the slots were spent on rows the
 * user could not see, let alone unpin.
 */

test("official default pins do not consume BYOK pin slots", async () => {
  await reset();
  useConfigStore.setState({ pinnedModels: [...DEFAULT_PINNED_MODELS], pinnedPrivateModels: [] });

  const results = Array.from({ length: MAX_PINNED_MODELS }, (_, i) =>
    useConfigStore.getState().pinModel(`custom/model-${i}`, "private"),
  );

  assert.deepEqual(
    results,
    Array(MAX_PINNED_MODELS).fill(true),
    "seeded official ids must not eat slots in a picker that cannot show them",
  );
  assert.equal(useConfigStore.getState().pinnedPrivateModels.length, MAX_PINNED_MODELS);
});

test("pinning in one scope leaves the other scope alone", async () => {
  await reset();
  useConfigStore.setState({ pinnedModels: ["google/gemini-3-flash-preview"] });

  useConfigStore.getState().pinModel("custom/my-model", "private");
  assert.deepEqual(useConfigStore.getState().pinnedModels, ["google/gemini-3-flash-preview"]);

  useConfigStore.getState().unpinModel("custom/my-model", "private");
  assert.deepEqual(useConfigStore.getState().pinnedPrivateModels, []);
  assert.deepEqual(useConfigStore.getState().pinnedModels, ["google/gemini-3-flash-preview"]);
});

test("the BYOK list enforces its own cap", async () => {
  await reset();
  const full = Array.from({ length: MAX_PINNED_MODELS }, (_, i) => `custom/model-${i}`);
  useConfigStore.setState({ pinnedPrivateModels: full, pinnedModels: [] });

  assert.equal(useConfigStore.getState().pinModel("custom/one-too-many", "private"), false);
});

test("BYOK pins are pushed under their own key", async () => {
  await reset();
  useConfigStore.getState().pinModel("custom/push-me", "private");
  await useConfigStore.getState().flushPendingPush();

  const put = calls.find((c) => c.method === "PUT");
  assert.deepEqual(put?.body, { pinnedPrivateModels: ["custom/push-me"] });
});

test("a device with no local state recovers BYOK pins from the server blob", async () => {
  await reset();
  // Fresh browser: nothing local to migrate. The shared server blob still holds
  // the pre-split list, so the split has to be derivable from it too — otherwise
  // whichever device loads first seeds an empty list over everyone's pins.
  remoteConfig = {
    pinnedModels: [...DEFAULT_PINNED_MODELS, "custom/my-model-a", "custom/my-model-b"],
  };

  await useConfigStore.getState().syncFromServer();

  assert.deepEqual(
    useConfigStore.getState().pinnedPrivateModels,
    ["custom/my-model-a", "custom/my-model-b"],
    "BYOK pins must survive the split on a device that never held the old state",
  );
});

test("migration moves existing BYOK pins into the BYOK list", async () => {
  const legacy = {
    pinnedModels: [...DEFAULT_PINNED_MODELS, "custom/deepseek-v4-flash", "custom/gpt-5.5"],
  };

  const migrated = migrateConfig({ ...legacy }, 10) as Record<string, unknown>;

  assert.deepEqual(
    migrated.pinnedPrivateModels,
    ["custom/deepseek-v4-flash", "custom/gpt-5.5"],
    "pins the BYOK picker was actually showing must survive the split",
  );
  assert.deepEqual(
    migrated.pinnedModels,
    [...DEFAULT_PINNED_MODELS],
    "official ids stay in the official list",
  );
});

/**
 * Most accounts never touch their pins or pool, so what the server holds is the
 * default of whichever release they signed up under: on 2026-11-15, 4,409 accounts
 * with mix mode on still drew 40% of their turns from DeepSeek V3.2 through the
 * pre-September pool. An untouched default follows today's; an edited one stays.
 */
test("an untouched shipped pin row and pool move to today's default", async () => {
  await reset();
  remoteConfig = {
    pinnedModels: [...SHIPPED_DEFAULT_PINNED_MODELS[1]!],
    modelPool: SHIPPED_DEFAULT_POOLS[1]!.map((e) => ({ weight: e.weight, modelId: e.modelId })),
    mixMode: true,
  };

  await useConfigStore.getState().syncFromServer();

  const state = useConfigStore.getState();
  assert.deepEqual(state.pinnedModels, [...DEFAULT_PINNED_MODELS]);
  assert.deepEqual(state.modelPool.map((e) => [e.modelId, e.weight]), DEFAULT_POOL.map((e) => [e.modelId, e.weight]));
  assert.equal(state.mixMode, true);
  const put = calls.find((c) => c.method === "PUT");
  assert.ok(put, "the upgraded values are written back to the server");
  assert.deepEqual((put.body as { pinnedModels: string[] }).pinnedModels, [...DEFAULT_PINNED_MODELS]);
});

test("an edited pin row or pool is the owner's and is left alone", async () => {
  await reset();
  const pins = [...SHIPPED_DEFAULT_PINNED_MODELS[0]!].reverse();
  const pool = SHIPPED_DEFAULT_POOLS[0]!.map((e, i) => ({ ...e, weight: i === 0 ? e.weight + 5 : e.weight - (i === 1 ? 5 : 0) }));
  remoteConfig = { pinnedModels: pins, pinnedPrivateModels: [], modelPool: pool };

  await useConfigStore.getState().syncFromServer();

  const state = useConfigStore.getState();
  assert.deepEqual(state.pinnedModels, pins);
  assert.deepEqual(state.modelPool.map((e) => [e.modelId, e.weight]), pool.map((e) => [e.modelId, e.weight]));
});

test("the persist migration upgrades an untouched local default too", () => {
  const migrated = migrateConfig({
    pinnedModels: [...SHIPPED_DEFAULT_PINNED_MODELS[0]!],
    modelPool: SHIPPED_DEFAULT_POOLS[0]!.map((e) => ({ ...e })),
  }, 11);
  assert.deepEqual(migrated.pinnedModels, [...DEFAULT_PINNED_MODELS]);
  assert.deepEqual((migrated.modelPool as { modelId: string }[]).map((e) => e.modelId), DEFAULT_POOL.map((e) => e.modelId));
});

// Soleria, 2026-11-20: thinking switched off on PC kept thinking; the phone was
// fine. Each tab kept the settings it loaded, so a change made in one tab never
// reached a chat already open in another.
test("a settings change saved by another tab reaches this one", async () => {
  await reset();
  useConfigStore.setState({ reasoningEffort: "low", streaming: true });
  const otherTab = JSON.stringify({ state: { ...useConfigStore.getState(), reasoningEffort: "none" }, version: 12 });

  assert.equal(adoptConfigFromOtherTab(otherTab), true);
  assert.equal(useConfigStore.getState().reasoningEffort, "none");
  assert.equal(adoptConfigFromOtherTab(otherTab), false, "nothing new, nothing written: tabs do not echo each other");
  assert.equal(calls.filter((c) => c.method === "PUT").length, 0, "only the tab that made the change pushes it");
});

test("another tab's copy never overrides an edit this tab is still pushing, BYOK pins, or a newer build", async () => {
  await reset();
  putOk = false;
  useConfigStore.getState().setConfig("reasoningEffort", "high");
  useConfigStore.setState({ pinnedPrivateModels: ["custom/mine"] });
  const base = useConfigStore.getState();

  adoptConfigFromOtherTab(JSON.stringify({ state: { ...base, reasoningEffort: "none", pinnedPrivateModels: ["custom/theirs"], temperature: 0.4 }, version: 12 }));
  assert.equal(useConfigStore.getState().reasoningEffort, "high");
  assert.deepEqual(useConfigStore.getState().pinnedPrivateModels, ["custom/mine"]);
  assert.equal(useConfigStore.getState().temperature, 0.4);

  assert.equal(adoptConfigFromOtherTab(JSON.stringify({ state: { ...base, temperature: 1.7 }, version: 99 })), false);
  for (const junk of [null, "", "not json", JSON.stringify({ state: [] })]) assert.equal(adoptConfigFromOtherTab(junk), false);
  putOk = true;
});
