import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { anonymizeDeletedAccountAudit } from "./account-deletion-audit.js";

test("administrator audit history is anonymized and does not block user deletion", async () => {
  const database = new PGlite();
  try {
    await database.exec(`
      CREATE TABLE "user" (id TEXT PRIMARY KEY);
      CREATE TABLE admin_actions (
        id TEXT PRIMARY KEY,
        admin_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
        action_type TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        metadata JSONB
      );
      INSERT INTO "user" (id) VALUES ('admin-1'), ('other-1');
      INSERT INTO admin_actions
        (id, admin_id, action_type, target_type, target_id, metadata)
      VALUES
        (
          'acted',
          'admin-1',
          'world_review',
          'world',
          'world-1',
          '{"creatorId":"admin-1","decision":"approved"}'
        ),
        (
          'targeted',
          'other-1',
          'user_plan_change',
          'user',
          'admin-1',
          '{"targetUserId":"admin-1","reason":"test"}'
        );
    `);

    await anonymizeDeletedAccountAudit(
      drizzle(database),
      "admin-1",
      "deleted:keyed-identity",
    );
    await database.query(`DELETE FROM "user" WHERE id = 'admin-1'`);

    const result = await database.query<{
      id: string;
      admin_id: string | null;
      target_id: string;
      metadata: Record<string, unknown>;
    }>(`
      SELECT id, admin_id, target_id, metadata
      FROM admin_actions
      ORDER BY id
    `);
    assert.deepEqual(result.rows, [
      {
        id: "acted",
        admin_id: null,
        target_id: "world-1",
        metadata: {
          creatorId: "deleted:keyed-identity",
          decision: "approved",
          deletedAdminIdentity: "deleted:keyed-identity",
        },
      },
      {
        id: "targeted",
        admin_id: "other-1",
        target_id: "deleted:keyed-identity",
        metadata: {
          reason: "test",
          targetUserId: "deleted:keyed-identity",
        },
      },
    ]);
  } finally {
    await database.close();
  }
});
