// A held edit keeps the group key it was created with. If the card joins a
// language group before the author submits, the submission must still find the
// edit, or neither the AI nor an admin can approve it (11/13, Raley Serenhitas).

import "../test/database-fixture.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { commitPendingEditsForGroup, submitPendingEdit } from "./pending-edit.js";

const liveSchema = { entries: [{ id: "e1", name: "Lore", content: "An old academy." }] };
const heldSchema = { entries: [{ id: "e1", name: "Lore", content: "An old academy, rebuilt." }] };

async function seedHeldEditThenJoinGroup() {
  const creatorId = `test-gk-${crypto.randomUUID()}`;
  const worldId = crypto.randomUUID();
  const groupId = crypto.randomUUID();
  await db.execute(sql`INSERT INTO "user" (id, name, email, email_verified) VALUES (${creatorId}, 'GK', ${`${crypto.randomUUID()}@test.local`}, true)`);
  await db.execute(sql`
    INSERT INTO worlds (id, creator_id, name, description, language, is_published, status, visibility, age_rating, thumbnail_url, schema)
    VALUES (${worldId}, ${creatorId}, 'Academy', 'A school story.', 'es', true, 'published', 'public', 'all', 'users/x/cover.png', ${JSON.stringify(liveSchema)}::jsonb)`);
  // The draft is made while the card stands alone...
  await db.execute(sql`
    INSERT INTO world_pending_edits (id, world_id, created_by, group_key, schema, reasons, status, thumbnail_url, age_rating, metadata)
    VALUES (${crypto.randomUUID()}, ${worldId}, ${creatorId}, ${worldId}, ${JSON.stringify(heldSchema)}::jsonb, '["entries"]'::jsonb, 'draft', 'users/x/cover.png', 'all',
      ${JSON.stringify({ name: "Academy", description: "A school story." })}::jsonb)`);
  // ...then the author links it with another edition.
  await db.execute(sql`UPDATE worlds SET language_group_id = ${groupId} WHERE id = ${worldId}`);
  return { creatorId, worldId, groupId };
}

describe("submitting a held edit after the card joined a language group", () => {
  before(() => { process.env.WORLD_AI_REVIEW = "0"; });

  it("the edit and its submission share the card's current group, so it can be approved", async () => {
    const { creatorId, worldId, groupId } = await seedHeldEditThenJoinGroup();
    const res = await submitPendingEdit({ worldId, creatorId });
    assert.deepEqual(res, { ok: true, autoApproved: false });

    const edit = (await db.execute(sql`SELECT group_key, status FROM world_pending_edits WHERE world_id = ${worldId}`)) as unknown as { rows: Array<{ group_key: string; status: string }> };
    const sub = (await db.execute(sql`SELECT group_key FROM world_review_submissions WHERE world_id = ${worldId} AND decision = 'pending'`)) as unknown as { rows: Array<{ group_key: string }> };
    assert.equal(edit.rows[0]!.status, "pending");
    assert.equal(sub.rows[0]!.group_key, groupId);
    assert.equal(edit.rows[0]!.group_key, groupId);

    const committed = await commitPendingEditsForGroup(groupId, creatorId);
    assert.equal(committed.handled, true);
    const live = (await db.execute(sql`SELECT schema FROM worlds WHERE id = ${worldId}`)) as unknown as { rows: Array<{ schema: typeof heldSchema }> };
    assert.equal(live.rows[0]!.schema.entries[0]!.content, "An old academy, rebuilt.");
  });
});
