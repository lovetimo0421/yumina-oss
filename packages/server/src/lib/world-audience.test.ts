import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { WORLD_AUDIENCE_DDL } from "../db/world-audience-ddl.js";
import { resolveWorldAudience, resolveWorldAudienceEdit } from "./world-audience.js";

const both = ["原创", "男性向", "女性向"];

for (const audience of ["all", "male", "female"] as const) {
  test(`publishing explicit dual tags preserves both despite ${audience} in the form`, () => {
    assert.deepEqual(resolveWorldAudience(both, audience), {
      tags: both, targetAudience: "all",
    });
  });
}

test("an explicit audience-only edit can switch a dual card to a single audience", () => {
  assert.deepEqual(resolveWorldAudience(both, "male", false), {
    tags: ["原创", "男性向"], targetAudience: "male",
  });
  assert.deepEqual(resolveWorldAudience(both, "female", false), {
    tags: ["原创", "女性向"], targetAudience: "female",
  });
});

test("choosing all keeps dual tags but removes a single audience restriction", () => {
  assert.deepEqual(resolveWorldAudience(both, "all", false), {
    tags: both, targetAudience: "all",
  });
  assert.deepEqual(resolveWorldAudience(["原创", "男性向"], "all", false), {
    tags: ["原创"], targetAudience: "all",
  });
});

test("single audience publishing keeps its existing behavior", () => {
  assert.deepEqual(resolveWorldAudience(["原创", "男性向"], "female"), {
    tags: ["原创", "女性向"], targetAudience: "female",
  });
});

test("adding the second audience tag survives an accompanying audience field", () => {
  assert.deepEqual(resolveWorldAudienceEdit(["原创", "男性向"], both, "female"), {
    tags: both, targetAudience: "all",
  });
});

test("editing an ordinary tag cannot cancel an explicit audience switch", () => {
  assert.deepEqual(resolveWorldAudienceEdit(both, [...both, "校园"], "female"), {
    tags: ["原创", "校园", "女性向"], targetAudience: "female",
  });
  assert.deepEqual(resolveWorldAudienceEdit(both, undefined, "male"), {
    tags: ["原创", "男性向"], targetAudience: "male",
  });
});

test("saving dual tags before or after publishing keeps both searchable in storage", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE worlds (
      id TEXT PRIMARY KEY, target_audience TEXT NOT NULL DEFAULT 'all',
      tags JSONB NOT NULL DEFAULT '[]', CHECK (jsonb_array_length(tags) <= 50)
    ); BEGIN; ${WORLD_AUDIENCE_DDL} COMMIT;`);
    for (const audience of ["male", "female", "all"] as const) {
      for (const order of ["save-first", "publish-first"] as const) {
        const id = `${audience}-${order}`;
        await db.query("INSERT INTO worlds(id,target_audience) VALUES ($1,$2)", [id, audience]);
        const save = () => db.query("UPDATE worlds SET tags=$2::jsonb WHERE id=$1", [id, JSON.stringify(both)]);
        const publish = async () => {
          await db.transaction(async (tx) => {
            const { rows } = await tx.query<{ tags: string[] }>("SELECT tags FROM worlds WHERE id=$1 FOR UPDATE", [id]);
            const resolved = resolveWorldAudience(rows[0]!.tags, audience);
            await tx.query("UPDATE worlds SET target_audience=$2,tags=$3::jsonb WHERE id=$1", [
              id, resolved.targetAudience, JSON.stringify(resolved.tags),
            ]);
          });
        };
        // The row lock serializes the two requests into one of these orders.
        if (order === "save-first") { await save(); await publish(); }
        else { await publish(); await save(); }
        const { rows } = await db.query("SELECT target_audience,tags FROM worlds WHERE id=$1", [id]);
        assert.deepEqual(rows[0], { target_audience: "all", tags: both }, id);
        for (const query of [["男性向"], ["女性向"], ["男性向", "女性向"]]) {
          const found = await db.query("SELECT id FROM worlds WHERE id=$1 AND tags @> $2::jsonb", [id, JSON.stringify(query)]);
          assert.equal(found.rows.length, 1, `${id}: ${query.join("+")}`);
        }
        const single = resolveWorldAudience(both, "female", false);
        await db.query("UPDATE worlds SET target_audience=$2,tags=$3::jsonb WHERE id=$1", [id, single.targetAudience, JSON.stringify(single.tags)]);
        assert.deepEqual((await db.query("SELECT target_audience,tags FROM worlds WHERE id=$1", [id])).rows[0], {
          target_audience: "female", tags: ["原创", "女性向"],
        });
      }
    }
  } finally {
    await db.close();
  }
});
