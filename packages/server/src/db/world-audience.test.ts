import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { WORLD_AUDIENCE_DDL, WORLD_AUDIENCE_VALID_SQL } from "./world-audience-ddl.js";

const db = new PGlite();
type Row = { target_audience: string; tags: string[] };
const read = async (id: string) => (await db.query<Row>(
  "SELECT target_audience, tags FROM worlds WHERE id = $1", [id],
)).rows[0];

before(async () => {
  await db.exec(`CREATE TABLE worlds (
    id TEXT PRIMARY KEY, target_audience TEXT NOT NULL DEFAULT 'all',
    tags JSONB NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'draft',
    updated_at TIMESTAMP DEFAULT '2026-07-15', schema JSONB DEFAULT '{"keep":true}',
    CHECK (jsonb_array_length(tags) <= 50)
  );
  INSERT INTO worlds (id, target_audience, tags, status) VALUES
    ('reported-zh', 'male', '["世界卡","原创"]', 'published'),
    ('reported-ja', 'male', '["世界卡","原创"]', 'published'),
    ('female-missing', 'female', '[]', 'published'),
    ('import', 'all', '["世界卡","男性向"]', 'draft'),
    ('import-female', 'all', '["女性向","角色卡"]', 'unpublished'),
    ('both', 'all', '["男性向","女性向","世界卡"]', 'published'),
    ('both-stale', 'male', '["世界卡","男性向","女性向"]', 'published'),
    ('neutral', 'all', '["世界卡"]', 'published');`);
  // Reproduce the production failure with the actual jsonb discovery predicate.
  const before = await db.query<{ visible: boolean }>(
    `SELECT NOT tags @> '["男性向"]'::jsonb AS visible FROM worlds WHERE id='reported-zh'`,
  );
  assert.equal(before.rows[0]?.visible, true, "missing tag leaks into female discovery before installation");
  await db.exec(`BEGIN; ${WORLD_AUDIENCE_DDL} COMMIT;`);
});
after(async () => { await db.close(); });

test("backfill repairs published variants and hidden drafts without changing content or freshness", async () => {
  assert.deepEqual(await read("reported-zh"), { target_audience: "male", tags: ["世界卡", "原创", "男性向"] });
  assert.deepEqual(await read("reported-ja"), await read("reported-zh"));
  assert.deepEqual(await read("female-missing"), { target_audience: "female", tags: ["女性向"] });
  assert.deepEqual(await read("import"), { target_audience: "male", tags: ["世界卡", "男性向"] });
  assert.deepEqual(await read("import-female"), { target_audience: "female", tags: ["角色卡", "女性向"] });
  assert.deepEqual(await read("both"), { target_audience: "all", tags: ["男性向", "女性向", "世界卡"] });
  assert.deepEqual(await read("both-stale"), { target_audience: "all", tags: ["世界卡", "男性向", "女性向"] });
  const drift = await db.query(`SELECT id FROM worlds WHERE NOT (${WORLD_AUDIENCE_VALID_SQL})
    OR updated_at <> '2026-07-15' OR schema <> '{"keep":true}'::jsonb`);
  assert.deepEqual(drift.rows, []);
});

test("male and female discovery hide the opposite audience after repair", async () => {
  for (const [id, excluded] of [["reported-zh", "男性向"], ["reported-ja", "男性向"], ["female-missing", "女性向"]]) {
    const result = await db.query<{ visible: boolean }>(
      "SELECT NOT tags @> $2::jsonb AS visible FROM worlds WHERE id=$1", [id, JSON.stringify([excluded])],
    );
    assert.equal(result.rows[0]?.visible, false);
  }
  assert.deepEqual(await read("neutral"), { target_audience: "all", tags: ["世界卡"] });
});

test("tags-only save cannot erase a world's audience", async () => {
  await db.query("UPDATE worlds SET tags=$1 WHERE id='reported-zh'", [JSON.stringify(["世界卡", "新标签"])]);
  assert.deepEqual(await read("reported-zh"), { target_audience: "male", tags: ["世界卡", "新标签", "男性向"] });
  await db.exec("UPDATE worlds SET tags='[]' WHERE id='female-missing'");
  assert.deepEqual(await read("female-missing"), { target_audience: "female", tags: ["女性向"] });
});

test("explicit audience edits override stale tags, including switching to all", async () => {
  await db.exec(`INSERT INTO worlds (id,target_audience) VALUES ('switch','male');
    UPDATE worlds SET target_audience='female' WHERE id='switch';`);
  assert.deepEqual(await read("switch"), { target_audience: "female", tags: ["女性向"] });
  await db.exec("UPDATE worlds SET target_audience='all' WHERE id='switch'");
  assert.deepEqual(await read("switch"), { target_audience: "all", tags: [] });
});

test("adding an explicit opposite tag updates the settings field", async () => {
  await db.exec(`INSERT INTO worlds (id,target_audience) VALUES ('tag-switch','male');
    UPDATE worlds SET tags='["女性向","原创"]' WHERE id='tag-switch';`);
  assert.deepEqual(await read("tag-switch"), { target_audience: "female", tags: ["原创", "女性向"] });
});

test("imports and copies with an omitted audience infer it from their tags", async () => {
  await db.exec(`INSERT INTO worlds (id,tags) VALUES ('new-import','["女性向","角色卡"]');
    INSERT INTO worlds (id,tags) SELECT 'copy',tags FROM worlds WHERE id='new-import';`);
  assert.deepEqual(await read("new-import"), { target_audience: "female", tags: ["角色卡", "女性向"] });
  assert.deepEqual(await read("copy"), await read("new-import"));
});

test("translation or script insert with missing or contradictory tags honors explicit audience", async () => {
  await db.exec(`INSERT INTO worlds (id,target_audience,tags) VALUES
    ('translation','male','["世界卡"]'), ('conflict','male','["女性向","世界卡"]');`);
  assert.deepEqual(await read("translation"), { target_audience: "male", tags: ["世界卡", "男性向"] });
  assert.deepEqual(await read("conflict"), await read("translation"));
});

test("full 50-tag saves retain the mandatory audience tag and preserve leading tags", async () => {
  const tags = Array.from({ length: 50 }, (_, i) => `tag-${i}`);
  await db.query("INSERT INTO worlds (id,target_audience,tags) VALUES ('full','male',$1)", [JSON.stringify(tags)]);
  assert.deepEqual((await read("full"))?.tags, [...tags.slice(0, 49), "男性向"]);
});

test("dual audience inserts preserve both tags despite any stale valid audience column", async () => {
  for (const audience of ["all", "male", "female"]) {
    const id = `dual-${audience}`;
    await db.query("INSERT INTO worlds(id,target_audience,tags) VALUES ($1,$2,$3)",
      [id, audience, JSON.stringify(["原创", "男性向", "女性向"])]);
    assert.deepEqual(await read(id), { target_audience: "all", tags: ["原创", "男性向", "女性向"] });
  }
});

test("adding both tags overrides stale columns and remains findable by either or both tags", async () => {
  await db.exec(`INSERT INTO worlds(id,target_audience) VALUES ('dual-update','female');
    UPDATE worlds SET tags='["男性向","女性向"]', target_audience='male' WHERE id='dual-update';`);
  assert.deepEqual(await read("dual-update"), { target_audience: "all", tags: ["男性向", "女性向"] });
  for (const tags of [["男性向"], ["女性向"], ["男性向", "女性向"]]) {
    const result = await db.query<{ matches: boolean }>(
      "SELECT tags @> $1::jsonb AS matches FROM worlds WHERE id='dual-update'", [JSON.stringify(tags)],
    );
    assert.equal(result.rows[0]?.matches, true);
  }
  await db.exec("UPDATE worlds SET target_audience='female' WHERE id='dual-update'");
  assert.deepEqual(await read("dual-update"), { target_audience: "all", tags: ["男性向", "女性向"] });
});

test("removing one dual tag adopts the remaining audience while removing a single tag stays guarded", async () => {
  for (const [audience, tag] of [["male", "男性向"], ["female", "女性向"]]) {
    const id = `dual-remove-${audience}`;
    await db.query("INSERT INTO worlds(id,tags) VALUES ($1,$2)", [id, JSON.stringify(["男性向", "女性向"])]);
    await db.query("UPDATE worlds SET tags=$2 WHERE id=$1", [id, JSON.stringify([tag])]);
    assert.deepEqual(await read(id), { target_audience: audience, tags: [tag] });
    await db.query("UPDATE worlds SET tags='[]' WHERE id=$1", [id]);
    assert.deepEqual(await read(id), { target_audience: audience, tags: [tag] });
  }
});

test("full dual-tag saves reserve two places and retain the first 48 ordinary tags", async () => {
  const ordinary = Array.from({ length: 50 }, (_, i) => `dual-tag-${i}`);
  await db.query("INSERT INTO worlds(id,target_audience,tags) VALUES ('dual-full','female',$1)",
    [JSON.stringify([...ordinary, "男性向", "女性向"])]);
  assert.deepEqual(await read("dual-full"), {
    target_audience: "all", tags: [...ordinary.slice(0, 48), "男性向", "女性向"],
  });
});

test("SQL tag helper keeps both only for all and forces explicitly requested single audiences", async () => {
  const input = JSON.stringify(["世界卡", "男性向", "女性向"]);
  for (const [audience, tags] of [
    ["all", ["世界卡", "男性向", "女性向"]],
    ["male", ["世界卡", "男性向"]],
    ["female", ["世界卡", "女性向"]],
  ]) {
    const result = await db.query<{ tags: string[] }>(
      "SELECT worlds_tags_with_audience($1::jsonb,$2) AS tags", [input, audience],
    );
    assert.deepEqual(result.rows[0]?.tags, tags);
  }
});

test("sibling audience updates normalize each row's own tags atomically before the trigger runs", async () => {
  const siblings = [
    { id: "sibling-audience-a", ordinary: ["世界卡", "第一版"] },
    { id: "sibling-audience-b", ordinary: ["原创", "第二版"] },
  ];
  for (const sibling of siblings) {
    await db.query("INSERT INTO worlds(id,tags) VALUES ($1,$2)",
      [sibling.id, JSON.stringify([...sibling.ordinary, "男性向", "女性向"])]);
  }
  const fanout = async (audience: string) => db.query(`
    UPDATE worlds SET target_audience=$1,
      tags=worlds_tags_with_audience(tags,$1::text)
    WHERE id IN ('sibling-audience-a','sibling-audience-b')`, [audience]);

  await fanout("all");
  for (const sibling of siblings) {
    assert.deepEqual(await read(sibling.id), {
      target_audience: "all", tags: [...sibling.ordinary, "男性向", "女性向"],
    }, "all keeps existing dual tags without replacing a sibling's ordinary tags");
  }

  await fanout("female");
  for (const sibling of siblings) {
    assert.deepEqual(await read(sibling.id), {
      target_audience: "female", tags: [...sibling.ordinary, "女性向"],
    }, "computing single-audience tags in the same UPDATE prevents the dual-tag guard from overriding the change");
  }

  await fanout("all");
  for (const sibling of siblings) {
    assert.deepEqual(await read(sibling.id), {
      target_audience: "all", tags: sibling.ordinary,
    }, "moving a single-audience sibling to all removes only its audience tag");
  }
});

test("invalid audience values fail without leaving a partial write", async () => {
  await assert.rejects(db.exec("INSERT INTO worlds (id,target_audience) VALUES ('invalid','unknown')"));
  assert.equal(await read("invalid"), undefined);
});

test("CHECK still rejects inconsistent data when a writer bypasses the trigger", async () => {
  await db.exec("ALTER TABLE worlds DISABLE TRIGGER worlds_audience_sync_trg");
  try {
    await assert.rejects(db.exec("INSERT INTO worlds (id,target_audience) VALUES ('bypass','male')"));
    await assert.rejects(db.exec("INSERT INTO worlds (id,target_audience,tags) VALUES ('bypass-dual','male','[\"男性向\",\"女性向\"]')"));
    await db.exec("INSERT INTO worlds (id,target_audience,tags) VALUES ('bypass-valid-dual','all','[\"男性向\",\"女性向\"]')");
  } finally {
    await db.exec("ALTER TABLE worlds ENABLE TRIGGER worlds_audience_sync_trg");
  }
});

test("installation upgrades the already validated v1 guard without changing existing rows or timestamps", async () => {
  const legacy = new PGlite();
  try {
    await legacy.exec(`CREATE TABLE worlds (
      id TEXT PRIMARY KEY, target_audience TEXT NOT NULL DEFAULT 'all',
      tags JSONB NOT NULL DEFAULT '[]', updated_at TIMESTAMP DEFAULT '2026-07-15',
      schema JSONB DEFAULT '{"keep":true}',
      CONSTRAINT worlds_audience_consistent CHECK (
        target_audience IN ('all','male','female')
        AND (tags @> '["男性向"]'::jsonb) = (target_audience = 'male')
        AND (tags @> '["女性向"]'::jsonb) = (target_audience = 'female')
      ), CHECK (jsonb_array_length(tags) <= 50)
    );
    CREATE FUNCTION worlds_sync_audience() RETURNS TRIGGER LANGUAGE plpgsql AS $old$
    BEGIN
      NEW.tags := (NEW.tags - '男性向' - '女性向') || CASE NEW.target_audience
        WHEN 'male' THEN '["男性向"]'::jsonb
        WHEN 'female' THEN '["女性向"]'::jsonb ELSE '[]'::jsonb END;
      RETURN NEW;
    END; $old$;
    CREATE TRIGGER worlds_audience_sync_trg BEFORE INSERT OR UPDATE OF tags,target_audience ON worlds
      FOR EACH ROW EXECUTE FUNCTION worlds_sync_audience();
    INSERT INTO worlds(id,target_audience,tags) VALUES ('old-male','male','["原创"]'),
      ('old-neutral','all','["世界卡"]');`);
    const before = await legacy.query("SELECT * FROM worlds ORDER BY id");
    await legacy.exec(`BEGIN; ${WORLD_AUDIENCE_DDL} COMMIT;`);
    assert.deepEqual((await legacy.query("SELECT * FROM worlds ORDER BY id")).rows, before.rows,
      "valid v1 data and freshness must survive the upgrade unchanged");
    const constraints = await legacy.query<{ conname: string; convalidated: boolean }>(
      "SELECT conname,convalidated FROM pg_constraint WHERE conrelid='worlds'::regclass AND conname LIKE 'worlds_audience_consistent%' ORDER BY conname",
    );
    assert.deepEqual(constraints.rows, [{ conname: "worlds_audience_consistent_v2", convalidated: true }]);
    await legacy.exec("INSERT INTO worlds(id,target_audience,tags) VALUES ('new-dual','male','[\"男性向\",\"女性向\"]')");
    const dual = await legacy.query<Row>("SELECT target_audience,tags FROM worlds WHERE id='new-dual'");
    assert.deepEqual(dual.rows[0], { target_audience: "all", tags: ["男性向", "女性向"] });
    const upgraded = await legacy.query("SELECT * FROM worlds ORDER BY id");
    await legacy.exec(`BEGIN; ${WORLD_AUDIENCE_DDL} COMMIT;`);
    assert.deepEqual((await legacy.query("SELECT * FROM worlds ORDER BY id")).rows, upgraded.rows);
  } finally {
    await legacy.close();
  }
});

test("installation is idempotent and leaves no inconsistent rows", async () => {
  const before = await db.query("SELECT * FROM worlds ORDER BY id");
  await db.exec(`BEGIN; ${WORLD_AUDIENCE_DDL} COMMIT;`);
  assert.deepEqual((await db.query("SELECT * FROM worlds ORDER BY id")).rows, before.rows);
  assert.deepEqual((await db.query(`SELECT id FROM worlds WHERE NOT (${WORLD_AUDIENCE_VALID_SQL})`)).rows, []);
});
