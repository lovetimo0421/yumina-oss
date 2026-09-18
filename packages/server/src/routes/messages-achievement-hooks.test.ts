import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Regression guard for the 2026-06-10 session-memory refactor (b0c7ece3), which
// silently deleted the achievement-engine hook calls from the message-send route.
// That dropped `onMessageSent`, so message-based achievement progress stopped
// updating. The
// SSE streaming handler is too deep to exercise in a unit test, so we assert the
// wiring is present at the source level: if a future refactor removes these
// calls again, this test fails loudly instead of failing silently in prod.

const src = readFileSync(
  fileURLToPath(new URL("./messages.ts", import.meta.url)),
  "utf8",
);

test("messages route imports the achievement-engine hooks", () => {
  assert.match(
    src,
    /import\s*\{[^}]*\bonMessageSent\b[^}]*\bonUsageLogged\b[^}]*\bonRegenerate\b[^}]*\}\s*from\s*["']\.\.\/lib\/achievements\/engine\.js["']/,
    "messages.ts must import onMessageSent/onUsageLogged/onRegenerate from the achievement engine",
  );
});

test("send path fires onMessageSent + onUsageLogged", () => {
  // The message hook carries the session + world so the per-message metrics
  // update incrementally instead of rescanning the player's whole history.
  assert.match(
    src,
    /onMessageSent\(currentUser\.id,\s*\{\s*sessionId,\s*worldId:\s*context\.session\.worldId\s*\}\)/,
    "send path must call onMessageSent with the session + world context",
  );
  // The usage hook carries the logged row's model + key tier so the model-family
  // counters can move in O(1) instead of rescanning usage_logs per turn.
  assert.match(
    src,
    /onUsageLogged\(currentUser\.id,\s*\{\s*model:\s*actualModel,\s*apiKeyTier:\s*resolved\.apiKeyTier\s*\}\)/,
    "send/regenerate path must call onUsageLogged with the usage row's model + apiKeyTier",
  );
});

test("regenerate path fires onRegenerate with the new swipe count", () => {
  assert.match(
    src,
    /onRegenerate\(currentUser\.id,\s*updatedSwipes\.length\)/,
    "regenerate path must call onRegenerate with the updated swipe count (drives the O(1) incremental bump)",
  );
});
