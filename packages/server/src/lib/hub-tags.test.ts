import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { buildHubTagQuery, type HubTagQueryOptions } from "./hub-tags.js";

const client = new PGlite();
const db = drizzle(client);
const find = async (options: HubTagQueryOptions = {}) => {
  const result = await db.execute(buildHubTagQuery({ lang: "zh", ...options }));
  return result.rows.map((row) => ({ tag: String(row.tag), count: Number(row.count) }));
};

before(async () => {
  await client.exec(`CREATE TABLE worlds (
    id TEXT PRIMARY KEY, creator_id TEXT NOT NULL DEFAULT 'author',
    tags JSONB NOT NULL, is_published BOOLEAN DEFAULT true,
    status TEXT DEFAULT 'published', age_rating TEXT DEFAULT 'all',
    language TEXT DEFAULT 'zh', visibility TEXT DEFAULT 'public'
  );
  CREATE TABLE follows (follower_id TEXT, following_id TEXT);
  CREATE TABLE user_blocks (
    blocker_id TEXT, blocked_id TEXT,
    hide_blocked_worlds BOOLEAN DEFAULT true, hide_own_worlds BOOLEAN DEFAULT true
  );
  INSERT INTO worlds(id,tags) VALUES ('rare','["全性向"]'),('alias','["Slice of Life"]'),
    ('percent','["100%原创"]'),('underscore','["my_tag"]');
  INSERT INTO worlds(id,tags,age_rating) VALUES ('adult','["敏感新标签"]','sensitive');
  INSERT INTO worlds(id,tags,visibility) VALUES ('followers','["关注标签"]','followers');
  INSERT INTO worlds(id,tags,visibility,creator_id) VALUES ('private','["自己的标签"]','private','reader');
  INSERT INTO worlds(id,tags,is_published) VALUES ('draft','["未发布标签"]',false);
  INSERT INTO worlds(id,tags,status) VALUES ('withdrawn','["未发布标签"]','unpublished');
  INSERT INTO worlds(id,tags,language) VALUES ('english','["English-only"]','en'),
    ('regional','["地区标签"]','zh-TW');
  INSERT INTO worlds(id,tags,creator_id) VALUES ('blocked','["屏蔽标签"]','blocked-author'),
    ('blocks-reader','["被屏蔽标签"]','blocking-author');
  INSERT INTO follows VALUES ('follower','author');
  INSERT INTO user_blocks(blocker_id,blocked_id) VALUES
    ('reader','blocked-author'),('blocking-author','reader');
  INSERT INTO worlds(id,tags)
    SELECT 'popular-' || n || '-' || copy, jsonb_build_array('全性向热门' || n)
    FROM generate_series(1,60) n CROSS JOIN generate_series(1,2) copy;`);
});

after(async () => { await client.close(); });

test("an exact rare tag ranks before 60 more popular substring matches", async () => {
  const popular = await find({ limit: 50 });
  assert.equal(popular.some((row) => row.tag === "全性向"), false);
  const searched = await find({ query: "全性向", limit: 20 });
  assert.deepEqual(searched[0], { tag: "全性向", count: 1 });
  assert.equal(searched.length, 20);
});

test("authenticated sensitive mode includes tags found only on sensitive cards", async () => {
  for (const contentLevel of ["sensitive", "r18", "r18g"]) {
    assert.deepEqual(await find({ query: "敏感新标签", currentUserId: "reader", contentLevel }),
      [{ tag: "敏感新标签", count: 1 }], contentLevel);
  }
});

test("guests and safe viewers never receive sensitive-only tags", async () => {
  for (const contentLevel of [undefined, "safe", "sensitive", "r18", "r18g"]) {
    assert.deepEqual(await find({ query: "敏感新标签", contentLevel }), []);
  }
  assert.deepEqual(await find({ query: "敏感新标签", currentUserId: "reader", contentLevel: "safe" }), []);
});

test("search recognizes translated labels and aliases without needing popular-tag status", async () => {
  for (const query of ["日常", "日常系", "slice of life", "  Slice of Life  "]) {
    assert.deepEqual(await find({ query }), [{ tag: "Slice of Life", count: 1 }]);
  }
});

test("search treats percent and underscore as literal tag characters", async () => {
  assert.deepEqual(await find({ query: "%" }), [{ tag: "100%原创", count: 1 }]);
  assert.deepEqual(await find({ query: "_" }), [{ tag: "my_tag", count: 1 }]);
});

test("tag search follows the selected language scope including regional Chinese", async () => {
  assert.deepEqual(await find({ query: "English-only" }), []);
  assert.deepEqual(await find({ query: "English-only", includeOtherLanguages: true }),
    [{ tag: "English-only", count: 1 }]);
  assert.deepEqual(await find({ query: "地区标签", lang: "zh-Hant" }), [{ tag: "地区标签", count: 1 }]);
});

test("unpublished tags do not become searchable", async () => {
  assert.deepEqual(await find({ query: "未发布标签", currentUserId: "author" }), []);
});

test("followers-only tag search honors the viewer's access", async () => {
  assert.deepEqual(await find({ query: "关注标签" }), []);
  assert.deepEqual(await find({ query: "关注标签", currentUserId: "reader" }), []);
  for (const currentUserId of ["follower", "author"]) {
    assert.deepEqual(await find({ query: "关注标签", currentUserId }), [{ tag: "关注标签", count: 1 }]);
  }
});

test("own private tags are visible only to the owner", async () => {
  assert.deepEqual(await find({ query: "自己的标签" }), []);
  assert.deepEqual(await find({ query: "自己的标签", currentUserId: "follower" }), []);
  assert.deepEqual(await find({ query: "自己的标签", currentUserId: "reader" }),
    [{ tag: "自己的标签", count: 1 }]);
});

test("both directions of creator blocking apply to tag results", async () => {
  assert.deepEqual(await find({ query: "屏蔽标签", currentUserId: "reader" }), []);
});

test("sensitive-only filter excludes tags used solely by safe cards", async () => {
  assert.deepEqual(await find({ query: "全性向", currentUserId: "reader", contentLevel: "sensitive", nsfwOnly: true }), []);
  assert.deepEqual(await find({ query: "敏感新标签", currentUserId: "reader", contentLevel: "sensitive", nsfwOnly: true }),
    [{ tag: "敏感新标签", count: 1 }]);
});

test("unmatched search returns an empty list", async () => {
  assert.deepEqual(await find({ query: "不存在的标签" }), []);
});
