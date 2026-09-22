import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { clientDom, largeDiscoveryReceipt, loadClientModule } from "./feed-beacon.test-helpers";

test("mutation references use the original card and legacy origins are omitted", () => {
  const path = new URL("./discovery-attribution.ts", import.meta.url);
  assert.ok(existsSync(path), "discovery attribution helper must exist");
  const module = loadClientModule<typeof import("./discovery-attribution")>(path);
  assert.deepEqual(module.discoveryAttribution({ worldId: "original", attributionToken: "signed", surface: "recommended", feedRequestId: "p", position: 0 }), { token: "signed", worldId: "original" });
  assert.equal(module.discoveryAttribution(null), undefined);
  assert.equal(module.discoveryAttribution({ surface: "recommended", feedRequestId: "legacy", position: 0 }), undefined);
});

test("guest handoffs are exact-target, single-use, expire, and cannot grow without bound", t => {
  const path = new URL("./discovery-attribution.ts", import.meta.url);
  assert.ok(existsSync(path), "bounded guest handoff must exist");
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const env = clientDom();
  try {
    const module = loadClientModule<typeof import("./discovery-attribution")>(path);
    const origin = { worldId: "original", attributionToken: "signed", surface: "recommended", feedRequestId: "p", position: 0 };
    module.rememberDiscoveryHandoff("chosen-translation", origin);
    origin.attributionToken = "mutated";
    assert.equal(module.consumeDiscoveryHandoff("unrelated"), null);
    assert.deepEqual(module.discoveryAttribution(module.consumeDiscoveryHandoff("chosen-translation")), { token: "signed", worldId: "original" });
    assert.equal(module.consumeDiscoveryHandoff("chosen-translation"), null);
    module.rememberDiscoveryHandoff("expired", origin);
    t.mock.timers.tick(30 * 60_000 + 1);
    assert.equal(module.consumeDiscoveryHandoff("expired"), null);
    for (let i = 0; i < 100; i++) module.rememberDiscoveryHandoff(`w${i}`, origin);
    assert.equal(module.consumeDiscoveryHandoff("w0"), null);
    assert.ok(module.consumeDiscoveryHandoff("w99"));
    assert.ok(env.dom.window.sessionStorage.getItem("yumina.discovery-handoff.v1")!.length < 80_000);
    module.rememberDiscoveryHandoff("bad", { ...origin, surface: "x".repeat(100_000) });
    assert.ok(env.dom.window.sessionStorage.getItem("yumina.discovery-handoff.v1")!.length < 80_000, "invalid metadata cannot exceed storage bounds");
    env.dom.window.sessionStorage.setItem("yumina.discovery-handoff.v1", "bad-json");
    assert.equal(module.consumeDiscoveryHandoff("anything"), null);
    Object.defineProperty(env.dom.window, "sessionStorage", { get() { throw new Error("storage blocked"); } });
    assert.doesNotThrow(() => module.rememberDiscoveryHandoff("blocked", origin));
    assert.equal(module.consumeDiscoveryHandoff("blocked"), null);
  } finally { env.restore(); }
});

test("a signed ~12 KB receipt survives handoff and mutation attribution within the unchanged storage cap", () => {
  const env = clientDom();
  try {
    const module = loadClientModule<typeof import("./discovery-attribution")>(new URL("./discovery-attribution.ts", import.meta.url));
    const { token, receipt } = largeDiscoveryReceipt();
    assert.ok(token.length >= 11_000 && token.length <= 14_000, `fixture should be ~12 KB, got ${token.length}`);
    const origin = { worldId: receipt.entries[0].worldId, attributionToken: token, surface: "recommended", feedRequestId: receipt.feedRequestId, position: receipt.entries[0].position };
    module.rememberDiscoveryHandoff("translation", origin);
    const restored = module.consumeDiscoveryHandoff("translation");
    assert.ok(restored, "a valid receipt over 8 KiB must survive the handoff");
    assert.deepEqual(restored, origin);
    assert.deepEqual(module.discoveryAttribution(restored), { token, worldId: origin.worldId });
    for (let i = 0; i < 8; i++) module.rememberDiscoveryHandoff(`translation-${i}`, origin);
    const stored = env.dom.window.sessionStorage.getItem("yumina.discovery-handoff.v1")!;
    assert.ok(stored.length <= 80_000);
    assert.ok(JSON.parse(stored).length < 8, "large receipts evict oldest entries to respect the storage budget");
    assert.equal(module.consumeDiscoveryHandoff("translation-0"), null);
    assert.deepEqual(module.consumeDiscoveryHandoff("translation-7"), origin);
  } finally { env.restore(); }
});

test("handoff accepts 24,000 token characters and nonnegative safe positions, rejecting either bound's overflow", () => {
  const env = clientDom();
  try {
    const module = loadClientModule<typeof import("./discovery-attribution")>(new URL("./discovery-attribution.ts", import.meta.url));
    const origin = { worldId: "original", attributionToken: "t".repeat(24_000), surface: "recommended", feedRequestId: "page", position: Number.MAX_SAFE_INTEGER };
    module.rememberDiscoveryHandoff("unsafe-position", { ...origin, attributionToken: "signed", position: Number.MAX_SAFE_INTEGER + 1 });
    assert.equal(module.consumeDiscoveryHandoff("unsafe-position"), null);
    module.rememberDiscoveryHandoff("at-limit", origin);
    const restored = module.consumeDiscoveryHandoff("at-limit");
    assert.ok(restored, "the server's maximum-size receipt must fit");
    assert.equal(restored.attributionToken, origin.attributionToken);
    assert.equal(restored.position, Number.MAX_SAFE_INTEGER);
    module.rememberDiscoveryHandoff("over-limit", { ...origin, attributionToken: origin.attributionToken + "t" });
    assert.equal(module.consumeDiscoveryHandoff("over-limit"), null);
  } finally { env.restore(); }
});
