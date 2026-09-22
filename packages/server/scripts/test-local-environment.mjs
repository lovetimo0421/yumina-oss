import { createRequire } from "node:module";
import * as nodeModule from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.YUMINA_LOCAL_TEST !== "1" || process.env.DATABASE_URL !== "" || process.env.PGLITE_DATA_DIR !== "memory://") {
  throw new Error("Use scripts/test-local.mjs to start isolated server tests");
}

// env.ts normally reads ../../.env. Replace dotenv's loader before application
// modules evaluate so even credentials added in future cannot leak into tests.
const require = createRequire(import.meta.url);
require("dotenv").config = () => ({ parsed: {} });

// Observe loads without rewriting or replacing application modules. Avoid
// creating a database at shutdown for a test that never imported one.
const databaseUrl = new URL("../src/db/index.ts", import.meta.url).href;
let databaseLoaded = typeof nodeModule.registerHooks !== "function";
nodeModule.registerHooks?.({
  load(url, context, nextLoad) {
    if (url === databaseUrl) databaseLoaded = true;
    return nextLoad(url, context);
  },
});

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error(`Isolated tests refuse an unmocked external request to ${url.hostname}`);
  }
  return originalFetch(input, init);
};

// These integration suites historically relied on a pre-provisioned dev DB.
// Give each worker its own full, current schema before its test module loads.
// Other suites deliberately create minimal schemas to exercise migrations or
// missing-table behavior, so their empty databases must remain under test control.
// This list controls setup only: the launcher still discovers and runs all tests.
const fullSchemaTests = new Set([
  "src/routes/agent-image-batch.test.ts",
  "src/lib/generation/image-batch-bindings.test.ts",
  "src/lib/generation/image-batches.test.ts",
  "src/lib/achievements/achievements-engine.test.ts",
  "src/lib/achievements/referral-achievement-separation.test.ts",
  "src/lib/approve-review-publish-date.test.ts",
  "src/lib/message-edit.test.ts",
  "src/lib/notify.test.ts",
  "src/lib/pending-edit-variables.test.ts",
  "src/lib/plan-entitlement-replacement.test.ts",
  "src/lib/studio-conversations.test.ts",
  "src/lib/studio-credit-checkpoint.test.ts",
  "src/lib/studio-credit-loop.test.ts",
  "src/lib/credit-reservations.test.ts",
  "src/lib/world-aggregates.test.ts",
  "src/routes/sessions-revert-memory.test.ts",
  "src/routes/sessions-state-patch.test.ts",
  "src/routes/worlds-aggregation.test.ts",
  "src/routes/discovery-feed.test.ts",
  "src/routes/feed-dismiss-profile.test.ts",
  "src/lib/discovery-measurement.test.ts",
  "src/routes/discovery-attribution.test.ts",
]);
const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testFile = relative(serverRoot, process.argv[1] ?? "").replaceAll("\\", "/");
if (process.env.NODE_TEST_CONTEXT && fullSchemaTests.has(testFile)) {
  await import("./test-local-schema.mjs");
  if (["src/lib/discovery-measurement.test.ts", "src/routes/discovery-attribution.test.ts"].includes(testFile)) {
    const { readFile } = await import("node:fs/promises");
    const { db } = await import("../src/db/index.ts");
    await db.$client.exec(await readFile(new URL("./discovery-measurement.sql", import.meta.url), "utf8"));
  }
}

// Some pure tests import the application's DB transitively without ever
// querying it. Finish PGlite initialization and close it once all tests and
// their cleanup hooks have drained; an unfinished WASM startup can exit 99.
if (process.env.NODE_TEST_CONTEXT) process.once("beforeExit", async () => {
  if (!databaseLoaded || process.env.DATABASE_URL?.trim()) return;
  const { db } = await import("../src/db/index.ts");
  if (!db.$client.closed) await db.$client.close();
});
