import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// These are source boundary regressions, not a mocked browser/store runtime.
// Importing chat.ts here would initialize authentication/browser dependencies.
const storeSource = readFileSync(new URL("../../stores/chat.ts", import.meta.url), "utf8");
const sseSource = readFileSync(new URL("../../lib/sse.ts", import.meta.url), "utf8");

test("both play surfaces expose saved settings and the sandbox reuses Memory's model picker", () => {
  const host = readFileSync(new URL("./state-guard-host.tsx", import.meta.url), "utf8");
  const sandbox = readFileSync(new URL("../../../sandbox/extensions/state-update-guard/client.tsx", import.meta.url), "utf8");
  assert.match(host, /StateGuardSettingsPanel/);
  assert.match(sandbox, /StateGuardSettingsPanel/);
  assert.match(sandbox, /import \{ ModelPickerModal, ModelTrigger \} from "\.\.\/\.\.\/chat\/model-picker-modal"/);
  assert.match(sandbox, /renderModel=\{.*<ModelTrigger/);
  assert.match(sandbox, /<StateGuardHistory/);
  assert.match(host, /<StateGuardHistory/);
  assert.doesNotMatch(sandbox, /<StateGuardDetails/);
  assert.doesNotMatch(host, /<StateGuardDetails/);
  assert.match(sandbox, /onSelectModel=\{/);
  assert.doesNotMatch(sandbox, /api\.setModel\(/, "correction picker must not change story model");
  assert.match(sandbox, /onClick=\{onClose\}/, "Close stays distinct from disabling");
  assert.doesNotMatch(sandbox, /if \(event\.key === "Tab"\) \{ event\.preventDefault\(\); closeButton/,
    "Tab must reach the new controls instead of always returning to Close");
});

test("guard failures cannot trigger another Mix narrative attempt", () => {
  const noRetryCodes = /const MIX_NO_RETRY_CODES = new Set\(\[([\s\S]*?)\]\);/.exec(storeSource)?.[1];
  assert.ok(noRetryCodes, "Mix no-retry policy must remain explicit");
  assert.match(noRetryCodes, /["']STATE_VALIDATION["']/);
  assert.match(storeSource, /!MIX_NO_RETRY_CODES\.has\(errorCode\s*\?\?\s*["']["']\)/,
    "Mix retry gate must actually consult the policy");
});

test("the SSE dispatcher routes state-validation audits to the typed callback", () => {
  assert.match(sseSource, /onStateValidation\?\s*:\s*\(audit:\s*import\(["']@yumina\/shared["']\)\.StateValidationAudit\)/);
  assert.match(sseSource, /case ["']state-validation["']:\s*options\.callbacks\.onStateValidation\?\.\(parsed\);\s*break;/);
});

test("send, regenerate and continue each attach incoming audits to their message target", () => {
  const callbacks = [...storeSource.matchAll(/onStateValidation:\s*\(audit\)\s*=>\s*\{([\s\S]*?)\n\s*\},/g)];
  assert.equal(callbacks.length, 3, "all three generation paths must consume progress and terminal audit frames");
  for (const callback of callbacks) {
    assert.match(callback[1]!, /message\.id\s*===\s*audit\.targetMessageId/);
    assert.match(callback[1]!, /stateValidation:\s*audit/);
  }
});
