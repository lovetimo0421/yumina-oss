import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const source = readFileSync(new URL("../db/index.ts", import.meta.url), "utf8");

function rawSqlStartingAt(needle: string): string {
  const start = source.indexOf(needle);
  assert.ok(start >= 0, `missing SQL block: ${needle}`);
  const end = source.indexOf("\n  `));", start);
  assert.ok(end > start, `unterminated SQL block: ${needle}`);
  return source.slice(start, end);
}

test("verification trigger rejects stale user-owned credentials", async () => {
  const database = new PGlite();
  try {
    await database.exec(`
      CREATE TABLE "user" (id TEXT PRIMARY KEY, email TEXT NOT NULL);
      CREATE TABLE verification (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL,
        value TEXT NOT NULL
      );
    `);
    await database.exec(rawSqlStartingAt("CREATE OR REPLACE FUNCTION guard_verification_user_identity()"));
    await database.exec(rawSqlStartingAt("CREATE TRIGGER verification_guard_user_identity"));

    await database.query(
      `INSERT INTO "user" (id, email) VALUES ($1, $2)`,
      ["user-1", "owner@example.test"],
    );
    await database.query(
      `INSERT INTO verification (id, identifier, value) VALUES ($1, $2, $3)`,
      ["reset-live", "reset-password:token", "user-1"],
    );
    await database.query(
      `INSERT INTO verification (id, identifier, value) VALUES ($1, $2, $3)`,
      ["oauth-live", "oauth-state", JSON.stringify({ link: { userId: "user-1" } })],
    );

    await database.query(`DELETE FROM "user" WHERE id = $1`, ["user-1"]);
    await assert.rejects(
      database.query(
        `INSERT INTO verification (id, identifier, value) VALUES ($1, $2, $3)`,
        ["reset-stale", "reset-password:stale", "user-1"],
      ),
      (error: unknown) => (error as { code?: string }).code === "23503",
    );
    await assert.rejects(
      database.query(
        `INSERT INTO verification (id, identifier, value) VALUES ($1, $2, $3)`,
        ["email-stale", "magic-link-token", "owner@example.test"],
      ),
      (error: unknown) => (error as { code?: string }).code === "23503",
    );
    await assert.rejects(
      database.query(
        `INSERT INTO verification (id, identifier, value) VALUES ($1, $2, $3)`,
        ["oauth-stale", "oauth-state-stale", JSON.stringify({ link: { userId: "user-1" } })],
      ),
      (error: unknown) => (error as { code?: string }).code === "23503",
    );

    await database.query(
      `INSERT INTO verification (id, identifier, value) VALUES ($1, $2, $3)`,
      ["unowned-state", "oauth-sign-in-state", JSON.stringify({ callbackURL: "/app" })],
    );
  } finally {
    await database.close();
  }
});
