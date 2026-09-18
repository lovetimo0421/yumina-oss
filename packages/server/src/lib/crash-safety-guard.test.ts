import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ─── Crash-safety guard ─────────────────────────────────────────────────────
// Guards the 2026-06-09 reliability fixes (R1). node-postgres emits 'error' on
// the POOL for idle clients dropped by Neon (maintenance restarts, network
// blips). An unlistened 'error' event throws, and without process-level
// handlers that single event kills the instance and every in-flight SSE
// stream on it. These assertions pin the listeners so a refactor can't
// silently remove them.

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, ".."); // packages/server/src

test("both pg pools register 'error' listeners (idle-client errors must not crash the process)", () => {
  const dbIndex = readFileSync(join(srcRoot, "db", "index.ts"), "utf8");
  assert.match(dbIndex, /pool\.on\("error"/, "primary pool is missing its 'error' listener");
  assert.match(dbIndex, /readPool\.on\("error"/, "read pool is missing its 'error' listener");
});

test("process-level last-resort handlers are registered in index.ts", () => {
  const serverIndex = readFileSync(join(srcRoot, "index.ts"), "utf8");
  assert.match(serverIndex, /process\.on\("unhandledRejection"/, "unhandledRejection handler missing");
  assert.match(serverIndex, /process\.on\("uncaughtException"/, "uncaughtException handler missing");
  // The crash report must survive the crash: the exception handler has to
  // flush posthog's in-memory event batch before exiting.
  const uncaughtBlock = serverIndex.slice(serverIndex.indexOf('process.on("uncaughtException"'));
  assert.match(uncaughtBlock.slice(0, 800), /posthog\.shutdown\(\)/, "uncaughtException handler must flush posthog before exit");
});

test("captureServerError never throws, even for non-Error values", async () => {
  const { captureServerError } = await import("./posthog.js");
  assert.doesNotThrow(() => captureServerError("test-scope", new Error("boom")));
  assert.doesNotThrow(() => captureServerError("test-scope", "string failure"));
  assert.doesNotThrow(() => captureServerError("test-scope", undefined, { extra: 1 }));
});
