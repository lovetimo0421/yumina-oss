import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { createLastActiveToucher, lastActiveTouchStatement } from "./last-active.js";

test("the touch statement writes only when the stored value is missing or older than five minutes", async () => {
  const client = new PGlite();
  try {
    await client.exec(`CREATE TABLE "user"(id text PRIMARY KEY, last_active_at timestamp);
      INSERT INTO "user" VALUES ('fresh', now() - interval '1 minute'), ('stale', now() - interval '10 minutes'), ('never', NULL);`);
    const db = drizzle(client);
    const before = (await client.query<{ id: string; last_active_at: Date | null }>('SELECT id, last_active_at FROM "user" ORDER BY id')).rows;
    for (const id of ["fresh", "stale", "never", "missing"]) await db.execute(lastActiveTouchStatement(id));
    const after = (await client.query<{ id: string; last_active_at: Date | null }>('SELECT id, last_active_at FROM "user" ORDER BY id')).rows;
    const at = (rows: typeof after, id: string) => rows.find((r) => r.id === id)!.last_active_at;
    assert.equal(+at(after, "fresh")!, +at(before, "fresh")!, "a recent value is left alone");
    assert.ok(+at(after, "stale")! > +at(before, "stale")!, "an old value moves forward");
    assert.ok(at(after, "never") !== null, "a missing value is set");
    assert.equal(after.length, 3, "an unknown id writes nothing");
  } finally {
    await client.close();
  }
});

test("the in-process throttle issues one write per account per gap and retries after a failure", async () => {
  const issued: unknown[][] = [];
  let fail = false;
  const dialect = new PgDialect();
  const execute = async (statement: SQL) => {
    issued.push(dialect.sqlToQuery(statement).params);
    if (fail) throw new Error("db down");
  };
  const toucher = createLastActiveToucher(execute, 1000);
  assert.equal(toucher.touch("a", 0), true);
  assert.equal(toucher.touch("a", 500), false, "same account inside the gap is skipped");
  assert.equal(toucher.touch("b", 500), true, "another account is independent");
  assert.equal(toucher.touch("a", 1000), true, "after the gap the account is touched again");
  assert.equal(toucher.touch("", 1000), false, "no account, no write");
  assert.deepEqual(issued, [["a"], ["b"], ["a"]], "each write names its account");
  fail = true;
  assert.equal(toucher.touch("c", 2000), true);
  await new Promise((resolve) => setImmediate(resolve));
  fail = false;
  assert.equal(toucher.touch("c", 2001), true, "a failed write does not poison the throttle");
});
