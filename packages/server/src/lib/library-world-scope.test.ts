import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq, or } from "drizzle-orm";
import { worlds } from "../db/schema.js";
import { libraryWorldScope } from "./library-world-scope.js";

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

test("Library metadata includes saved groups, favorites, own drafts and direct links without broadening visibility", async (t) => {
  const pg = new PGlite();
  t.after(() => pg.close());
  await pg.exec(`
    CREATE TABLE worlds (id text PRIMARY KEY, creator_id text, is_published boolean, language_group_id text);
    CREATE TABLE user_library (user_id text, world_id text);
    CREATE TABLE favorites (user_id text, world_id text);
  `);
  for (const [n, creator, published, group] of [
    [1, "alice", false, null], [2, "bob", true, null], [3, "bob", true, id(100)],
    [4, "bob", true, id(100)], [5, "bob", true, null], [6, "bob", false, null],
    [7, "bob", true, null], [8, "bob", true, null],
  ] as const) {
    await pg.query("INSERT INTO worlds VALUES ($1,$2,$3,$4)", [id(n), creator, published, group]);
  }
  await pg.query("INSERT INTO user_library VALUES ('alice',$1),('alice',$2),('alice',$3),('charlie',$4)", [id(2), id(4), id(6), id(8)]);
  await pg.query("INSERT INTO favorites VALUES ('alice',$1)", [id(5)]);
  const db = drizzle(pg);
  const read = async (requested?: string) => (await db.select({ id: worlds.id }).from(worlds).where(and(
    or(eq(worlds.creatorId, "alice"), eq(worlds.isPublished, true)),
    libraryWorldScope("alice", requested),
  ))).map((row) => row.id).sort();
  assert.deepEqual(await read(), [1, 2, 3, 4, 5].map(id));
  assert.deepEqual(await read(id(7)), [1, 2, 3, 4, 5, 7].map(id));
  assert.deepEqual(await read(id(6)), [1, 2, 3, 4, 5].map(id), "deep links cannot expose another user's draft");
  assert.deepEqual(await read("bad' OR true --"), [1, 2, 3, 4, 5].map(id));
  await pg.query("INSERT INTO worlds VALUES ('legacy-import-id','bob',true,NULL)");
  assert.deepEqual(await read("legacy-import-id"), [...[1, 2, 3, 4, 5].map(id), "legacy-import-id"]);
});
