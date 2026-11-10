import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import * as schema from "../db/schema.js";

// Explicitly imported only by integration tests that need the application's
// complete schema. Tests with their own reduced schema must not import this.
if (process.env.YUMINA_LOCAL_TEST !== "1" || process.env.DATABASE_URL !== "" || process.env.PGLITE_DATA_DIR !== "memory://") {
  throw new Error("Database integration tests require scripts/test-local.mjs");
}

// Complete setup before the importing test module registers any hooks. Several
// older suites register their own root-level before() and query immediately.
const { db, ensureMessagesSwipeCount, ensureWorldsSchemaDerived } = await import("../db/index.js");
if (!(db.$client instanceof PGlite)) throw new Error("Expected an isolated PGlite database");
// The isolated launcher already provisions the full schema for the suites on
// its fullSchemaTests list (scripts/test-local-environment.mjs). Creating it a
// second time fails on the first CREATE TABLE, so build only what is missing.
const provisioned = await db.$client.query<{ exists: boolean }>(
  "SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'account') AS exists",
);
if (!provisioned.rows[0]?.exists) {
  const empty = generateDrizzleJson({});
  const current = generateDrizzleJson(schema, empty.id);
  const statements = await generateMigration(empty, current);
  for (const statement of statements) await db.$client.exec(statement);
}
await ensureMessagesSwipeCount();
await ensureWorldsSchemaDerived();
// Production refuses any wallet balance change without a matching ledger row
// (scripts/install-ledger-guard.sql). Tests run under the same rule, so a code
// path that forgets the ledger fails here, not in prod.
await db.$client.exec(readFileSync(new URL("../../scripts/install-ledger-guard.sql", import.meta.url), "utf8"));
