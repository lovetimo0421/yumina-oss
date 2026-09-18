import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ─── Boot-path DDL pins (2026-06-11 deploy failure) ─────────────────────────
// Both replicas crashed at startup when the ensure* DDL suite ran before the
// port bind: even a no-op ALTER TABLE needs an ACCESS EXCLUSIVE lock it cannot
// get while the previous deployment is still serving the same tables, the
// role-level lock_timeout turned the wait into a throw, and the healthcheck
// never saw a port. These pins keep DDL out of the main startup path.

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "index.ts"), "utf8");
const startIdx = src.indexOf("async function start()");
const startBody = src.slice(startIdx, src.indexOf("\nstart();", startIdx));

test("start() never awaits ensure* DDL directly", () => {
  assert.ok(startIdx >= 0, "start() missing");
  assert.doesNotMatch(startBody, /await ensure/, "DDL must not run in the boot path — see scheduleSchemaSelfHeal");
});

test("the heal is scheduled only after the port is bound", () => {
  const serveIdx = startBody.indexOf("serve(");
  const healIdx = startBody.indexOf("scheduleSchemaSelfHeal()");
  assert.ok(serveIdx >= 0, "serve() call missing from start()");
  assert.ok(healIdx > serveIdx, "scheduleSchemaSelfHeal() must come after serve() so healthchecks pass first");
});

test("PGlite (embedded, empty-start) still heals synchronously before serving", () => {
  assert.match(
    startBody,
    // An empty embedded database first gets its schema (db/bootstrap-pglite.ts),
    // then the self-heal suite runs synchronously before the port is bound.
    /if \(!env\.DATABASE_URL\) \{[\s\S]*?await bootstrapPgliteSchema\(\);\s*await runSchemaSelfHealOnce\(\);/,
    "the embedded-DB path must create its tables before the first request",
  );
});

test("the ensure suite lives in runSchemaSelfHealOnce and is retried, never fatal", () => {
  const healOnce = src.slice(src.indexOf("async function runSchemaSelfHealOnce"));
  assert.match(healOnce.slice(0, 1200), /await ensureTables\(\);/);
  const scheduler = src.slice(src.indexOf("function scheduleSchemaSelfHeal"));
  assert.match(scheduler.slice(0, 1600), /captureServerError\("startupSelfHeal"/, "final failure must be telemetered, not thrown");
  assert.match(scheduler.slice(0, 1600), /\.unref\(\)/, "retry timers must not keep a draining process alive");
});
