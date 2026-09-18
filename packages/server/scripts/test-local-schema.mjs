import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { PGlite } from "@electric-sql/pglite";

// Only the isolated launcher may provision the application's test database.
// Never load db/index (and therefore env.ts) before these checks succeed.
if (process.env.YUMINA_LOCAL_TEST !== "1"
  || process.env.DATABASE_URL !== ""
  || process.env.DATABASE_READ_URL !== ""
  || process.env.PGLITE_DATA_DIR !== "memory://") {
  throw new Error("Use scripts/test-local.mjs to provision an isolated test schema");
}

// Keep this helper safe on its own as well as through the test preload: env.ts
// must never read local credentials before the actual client can be checked.
const require = createRequire(import.meta.url);
require("dotenv").config = () => ({ parsed: {} });

const { db, ensureWorldsSchemaDerived, ensureMessagesSwipeCount } = await import("../src/db/index.ts");
assert.ok(db.$client instanceof PGlite, "Test schema requires an in-memory PGlite client");

// Generate from the same schema as production. Unlike hand-written fixture
// tables, this retains foreign keys, unique constraints, checks, and indexes.
// No introspection, connection URL, migration directory, or shared data is used.
const { generateDrizzleJson, generateMigration } = require("drizzle-kit/api");
const schema = await import("../src/db/schema.ts");
const empty = generateDrizzleJson({});
const current = generateDrizzleJson(schema, empty.id);
const statements = await generateMigration(empty, current);
for (const statement of statements) await db.$client.exec(statement);

// These production triggers live outside Drizzle's declarative schema.
await ensureWorldsSchemaDerived();
await ensureMessagesSwipeCount();
