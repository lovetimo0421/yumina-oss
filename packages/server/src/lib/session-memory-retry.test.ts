import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ─── Session-memory retry budget (Q5, 2026-06-10) ──────────────────────────
// Verified behavior: each new turn ALREADY retries a failed memory update
// (new sourceHash defeats the dedupe guard) — transient blips self-heal.
// What Q5 adds is the missing CAP: after 3 consecutive failures the per-turn
// auto-retry stops, so a persistently-broken config can't burn a failed LLM
// call every turn forever. These pins keep the three legs of the counter
// (increment-on-fail, reset-on-success, reset-on-manual-regenerate) plus the
// guard itself from being refactored away independently.

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "session-memory.ts"), "utf8");

test("failure path increments the consecutive-failure counter", () => {
  const failedBlock = src.slice(src.indexOf("async function markSessionMemoryJobFailed"));
  assert.match(
    failedBlock.slice(0, 1200),
    /sessionMemoryRetryCount: sql`\$\{playSessions\.sessionMemoryRetryCount\} \+ 1`/,
    "markSessionMemoryJobFailed must increment sessionMemoryRetryCount",
  );
});

test("success and manual-regenerate paths reset the counter", () => {
  const persistBlock = src.slice(src.indexOf("const updated = await tx"));
  assert.match(persistBlock.slice(0, 800), /sessionMemoryRetryCount: 0/, "persist success must reset the counter");
  const updatingBlock = src.slice(src.indexOf("async function markSessionMemoryJobUpdating"));
  assert.match(updatingBlock.slice(0, 900), /sessionMemoryRetryCount: 0/, "manual regenerate must reset the counter");
});

test("per-turn path stops auto-retrying after the cap", () => {
  assert.match(src, /SESSION_MEMORY_MAX_CONSECUTIVE_FAILURES = 3/, "cap constant missing or changed silently");
  const incrementalBlock = src.slice(src.indexOf("async function updateSessionMemoryIncrementally"));
  assert.match(
    incrementalBlock.slice(0, 1600),
    /sessionMemoryStatus === "failed"[\s\S]{0,200}SESSION_MEMORY_MAX_CONSECUTIVE_FAILURES/,
    "incremental path must guard on failed status + cap before spending an LLM call",
  );
});
