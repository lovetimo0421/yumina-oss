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
const empty = generateDrizzleJson({});
const current = generateDrizzleJson(schema, empty.id);
const statements = await generateMigration(empty, current);
for (const statement of statements) await db.$client.exec(statement);
await ensureMessagesSwipeCount();
await ensureWorldsSchemaDerived();
