import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { TURN_IMAGE_TASK_DDLS } from "./turn-image-tasks-ddl.js";

test("task schema installs twice on a fresh database and retains account deletion cleanup", async () => {
  const client = new PGlite();
  try {
    await client.exec('CREATE TABLE "user" (id text PRIMARY KEY); INSERT INTO "user" VALUES (\'one\');');
    for (let i = 0; i < 2; i++) for (const statement of TURN_IMAGE_TASK_DDLS) await client.exec(statement);
    await client.exec("INSERT INTO turn_image_tasks(id,user_id,message_id) VALUES ('task','one','message')");
    const { rows } = await client.query<{ status: string; expires: boolean }>("SELECT status, expires_at > now() AS expires FROM turn_image_tasks");
    assert.deepEqual(rows, [{ status: "running", expires: true }]);
    await client.exec('DELETE FROM "user" WHERE id = \'one\'');
    assert.equal((await client.query("SELECT * FROM turn_image_tasks")).rows.length, 0);
  } finally { await client.close(); }
});
