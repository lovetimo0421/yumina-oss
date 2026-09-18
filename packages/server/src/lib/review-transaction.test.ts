import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import type { LedgerDatabase } from "./transaction-hash.js";
import {
  runReviewDecision,
  reviewRevision,
  StaleReviewError,
  BannedReviewError,
} from "./review-transaction.js";

test("review guards stale content and commits mixed decisions before side effects", async () => {
  const pg = new PGlite(),
    db = drizzle(pg) as unknown as LedgerDatabase;
  try {
    await pg.exec(`CREATE TABLE "user"(id text PRIMARY KEY,is_banned boolean);
      CREATE TABLE worlds(id text PRIMARY KEY,creator_id text,language_group_id text,updated_at timestamp,status text);
      CREATE TABLE world_pending_edits(world_id text PRIMARY KEY,group_key text,updated_at timestamp,status text);
      INSERT INTO "user" VALUES('author',false);
      INSERT INTO worlds VALUES('a','author','group','2026-04-01','pending_review'),('b','author','group','2026-04-01','published');
      INSERT INTO world_pending_edits VALUES('b','group','2026-04-02','pending');`);
    const read = async () => {
      const rows = await pg.query<Record<string, unknown>>(
        "SELECT w.id,w.updated_at::text AS ws,p.updated_at::text AS ps,w.status,p.status AS pending FROM worlds w LEFT JOIN world_pending_edits p ON p.world_id=w.id ORDER BY w.id",
      );
      return rows.rows.map((row) => ({
        id: String(row.id),
        revision: reviewRevision(row.ws, row.ps, row.status, row.pending),
      }));
    };
    const old = await read();
    await pg.exec(
      "UPDATE world_pending_edits SET updated_at='2026-04-03' WHERE world_id='b'",
    );
    await assert.rejects(
      runReviewDecision(db, "group", old, true, async () =>
        assert.fail("must not decide changed content"),
      ),
      StaleReviewError,
    );
    const current = await read();
    let effects = 0;
    await assert.rejects(
      runReviewDecision(db, "group", current, true, async (context) => {
        await context.database.execute(
          sql`UPDATE worlds SET status='published' WHERE id='a'`,
        );
        context.afterCommit(() => {
          effects++;
        });
        throw new Error("second part failed");
      }),
      /second part failed/,
    );
    assert.equal(
      (
        await pg.query<{ status: string }>(
          "SELECT status FROM worlds WHERE id='a'",
        )
      ).rows[0]?.status,
      "pending_review",
    );
    assert.equal(effects, 0);
    await runReviewDecision(db, "group", current, true, async (context) => {
      await context.database.execute(
        sql`UPDATE worlds SET status='published' WHERE id='a'`,
      );
      await context.database.execute(
        sql`DELETE FROM world_pending_edits WHERE world_id='b'`,
      );
      context.afterCommit(() => {
        effects++;
      });
    });
    await Promise.resolve();
    assert.equal(effects, 1);
    assert.equal(
      (
        await pg.query<{ n: number }>(
          "SELECT count(*)::int n FROM world_pending_edits",
        )
      ).rows[0]?.n,
      0,
    );
    await pg.exec('UPDATE "user" SET is_banned=true');
    await assert.rejects(
      runReviewDecision(db, "group", await read(), true, async () => {}),
      BannedReviewError,
    );
    // Banned authors' work can still be rejected.
    await runReviewDecision(db, "group", await read(), false, async () => {});
  } finally {
    await pg.close();
  }
});
