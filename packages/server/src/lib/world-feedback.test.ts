import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Database } from "../db/index.js";
import type { AppEnv } from "./types.js";
import { WORLD_FEEDBACK_DDL } from "../db/world-feedback-ddl.js";
import { createWorldFeedbackService, feedbackWorldIds } from "./world-feedback.js";
import { createWorldFeedbackRoutes } from "../routes/world-feedback.js";

const author = { id: "author" }, other = { id: "other" }, creator = { id: "creator" }, admin = { id: "admin", role: "admin" };
const base = `
CREATE TABLE "user"(id text PRIMARY KEY, name text, image text, username text);
INSERT INTO "user" VALUES ('author','Author',NULL,NULL),('other','Other',NULL,NULL),('creator','Creator',NULL,NULL),('admin','Admin',NULL,NULL);
CREATE TABLE worlds(id text PRIMARY KEY, creator_id text, language_group_id text, status text DEFAULT 'published',
 visibility text DEFAULT 'public', age_rating text DEFAULT 'all', allow_reviews boolean DEFAULT true, game_path text, name text DEFAULT 'World',
 review_count integer DEFAULT 0, average_rating real DEFAULT 0);
INSERT INTO worlds(id,creator_id,language_group_id) VALUES ('world','creator','group'),('sibling','creator','group'),('elsewhere','creator',NULL);
CREATE TABLE reviews(id text PRIMARY KEY, user_id text REFERENCES "user"(id), world_id text REFERENCES worlds(id),
 rating integer, content text, reason text, reply_count integer DEFAULT 0 NOT NULL, hidden_by_creator_at timestamp,
 created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now());
CREATE TABLE world_ratings(id text PRIMARY KEY,user_id text,world_id text,rating integer,low_reason text,created_at timestamp DEFAULT now(),updated_at timestamp DEFAULT now(),UNIQUE(user_id,world_id));
CREATE TABLE review_replies(id text PRIMARY KEY,review_id text REFERENCES reviews(id),user_id text REFERENCES "user"(id),reply_to_reply_id text REFERENCES review_replies(id),content text NOT NULL,created_at timestamp DEFAULT now(),updated_at timestamp DEFAULT now());
CREATE TABLE follows(id text, follower_id text, following_id text, created_at timestamp);
CREATE TABLE content_translations(id text,source_id text,source_type text,source_lang text,target_lang text,translated_content text,translated_title text,source_hash text,created_at timestamp,updated_at timestamp);
CREATE TABLE notifications(id text,type text,payload jsonb);
CREATE TABLE admin_actions(id text PRIMARY KEY,admin_id text,action_type text,target_type text,target_id text,metadata jsonb,created_at timestamp DEFAULT now());`;
async function fixture(seed = "") {
  const pg = new PGlite();
  await pg.exec(base + seed);
  await pg.exec(`BEGIN; ${WORLD_FEEDBACK_DDL} COMMIT;`);
  const db = drizzle(pg) as unknown as Database;
  let played = true, blocked = false, playtime = 3600;
  const service = createWorldFeedbackService(db, { hasPlayed: async () => played, playtime: async () => playtime, isBlocked: async () => blocked });
  return { pg, db, service, setPlaytime: (value: number) => { playtime = value; }, setPlayed: (value: boolean) => { played = value; }, setBlocked: (value: boolean) => { blocked = value; } };
}
async function rejectStatus(work: Promise<unknown>, status: number) {
  await assert.rejects(work, (error: unknown) => error instanceof HTTPException && error.status === status);
}

test("review updates snapshot reason tags and accept short bug details", async () => {
  const f = await fixture();
  try {
    await f.service.saveReview("world", author, { rating: 5, content: "Original" });
    const updated = await f.service.saveReview("world", author, { rating: 2, reasons: ["bug"], content: "Bug" });
    assert.equal(updated.content, "Original");
    assert.equal(updated.reviewUpdates[0]?.reasonBefore, null);
    assert.equal(updated.reviewUpdates[0]?.reasonAfter, "bug");
    const next = await f.service.saveReview("world", author, { rating: 1, reasons: ["boring"] });
    assert.equal(next.reviewUpdates[0]?.reasonAfter, "bug");
    assert.equal(next.reviewUpdates[1]?.reasonBefore, "bug");
    assert.equal(next.reviewUpdates[1]?.reasonAfter, "boring");
    // Legacy entries have no snapshots: preserve their last known tags on append.
    await f.pg.query("UPDATE reviews SET review_updates=$1 WHERE id=$2", [JSON.stringify([{ id: "old", content: "Old update", createdAt: new Date().toISOString(), ratingBefore: 5, ratingAfter: 1 }]), next.id]);
    const legacy = await f.service.saveReview("world", author, { rating: 4 });
    assert.equal(legacy.reviewUpdates[0]?.reasonAfter, "boring");
    assert.equal(legacy.reviewUpdates[1]?.reasonAfter, null);
  } finally { await f.pg.close(); }
});

test("authors can erase posts with only their own nested comments", async () => {
  const f = await fixture();
  try {
    for (const kind of ["review", "discussion"]) {
      const post = kind === "review" ? await f.service.saveReview("world", author, { rating: 5 })
        : await f.service.createDiscussion("world", author, { title: "Topic", content: "Opening" });
      const parent = await f.service.reply("world", post.id, author, { content: "My comment" });
      const child = await f.service.reply("world", post.id, author, { content: "My follow-up", replyToReplyId: parent.reply.id });
      await f.pg.query("INSERT INTO content_translations(id,source_id,source_type) VALUES ('translated',$1,'review_reply')", [child.reply.id]);
      await f.service.remove("world", post.id, author);
      assert.equal((await f.pg.query("SELECT id FROM reviews WHERE id=$1", [post.id])).rows.length, 0);
      assert.equal((await f.pg.query("SELECT id FROM review_replies WHERE review_id=$1", [post.id])).rows.length, 0);
      assert.equal((await f.pg.query("SELECT id FROM content_translations WHERE source_id=$1", [child.reply.id])).rows.length, 0);
    }
  } finally { await f.pg.close(); }
});

test("legacy reviews keep their original IDs, stars, unrated posts and inline replies", async () => {
  const f = await fixture(`
    INSERT INTO reviews(id,user_id,world_id,rating,content) VALUES
      ('rated','author','world',4,'Good story'),('bug','other','world',NULL,'Fix the button');
    INSERT INTO world_ratings(id,user_id,world_id,rating) VALUES('only-stars','other','world',5);
    INSERT INTO review_replies(id,review_id,user_id,content) VALUES('chat','rated','creator','Thanks');`);
  try {
    const rows = await f.service.list("world", "review", author);
    assert.deepEqual(new Set(rows.map(r => r.id)), new Set(["rated", "bug"]));
    assert.equal(rows.find(r => r.id === "bug")?.rating, null);
    assert.equal(rows.find(r => r.id === "bug")?.canUpdate, false);
    assert.equal(rows.find(r => r.id === "rated")?.legacyFeedback, true);
    assert.equal(rows.find(r => r.id === "rated")?.canUpdate, true);
    assert.equal((await f.service.list("world", "discussion", author)).length, 0);
    assert.equal((await f.service.replies("world", "rated", author))[0]?.id, "chat");
    assert.deepEqual(await f.service.location("world", "rated", author), { id: "rated", kind: "review" });
    await f.service.remove("world", "rated", author);
    assert.equal((await f.pg.query("SELECT * FROM world_ratings")).rows.length, 1);
    await f.service.remove("world", "feedback-vote-v4-only-stars", other);
    assert.equal((await f.pg.query("SELECT * FROM world_ratings")).rows.length, 0);
    assert.equal((await f.service.list("world", "review", other)).find(row => row.id === "bug")?.content, "Fix the button");
  } finally { await f.pg.close(); }
});

test("ratings and discussion are separate, with playtime, self-rating, privacy and block rules", async () => {
  const f = await fixture();
  try {
    // These validators throw before beginning their async transaction.
    assert.throws(() => f.service.saveReview("world", author, { content: "No rating" }), HTTPException);
    assert.throws(() => f.service.createDiscussion("world", author, { title: "Topic", content: "Chat", rating: 4 }), HTTPException);
    await rejectStatus(f.service.saveReview("world", creator, { rating: 5 }), 403);
    f.setPlayed(false);
    await rejectStatus(f.service.saveReview("world", author, { rating: 4 }), 403);
    assert.equal((await f.service.createDiscussion("world", author, { title: "Topic", content: "A bug report" })).rating, null);
    f.setPlayed(true);
    await rejectStatus(f.service.saveReview("world", author, { rating: 1 }), 400);
    f.setBlocked(true);
    await rejectStatus(f.service.createDiscussion("world", author, { title: "Topic", content: "Blocked" }), 403);
    f.setBlocked(false);
    const review = await f.service.saveReview("world", author, { rating: 4, content: "Good story" });
    const edited = await f.service.saveReview("sibling", author, { rating: 5, content: "Even better" });
    assert.equal(edited.id, review.id);
    assert.equal((await f.pg.query("SELECT * FROM world_ratings")).rows.length, 1);
    await f.pg.exec("UPDATE worlds SET visibility='private' WHERE id='sibling'");
    await rejectStatus(f.service.list("sibling", "review", other), 404);
    await f.pg.exec("UPDATE worlds SET age_rating='18+' WHERE id='world'");
    await rejectStatus(f.service.list("world", "review"), 404);
    await rejectStatus(f.service.list("world", "review", { ...author, limitedContentOnly: true }), 404);
  } finally { await f.pg.close(); }
});

test("admins alone move posts, preserving identity and removing/restoring the author's rating", async () => {
  const f = await fixture();
  try {
    const review = await f.service.saveReview("world", author, { rating: 4, content: "Story" });
    assert.throws(() => f.service.move("world", review.id, creator, "discussion", "Bug"), HTTPException);
    await f.service.move("world", review.id, admin, "discussion", "Support request");
    assert.equal((await f.pg.query("SELECT * FROM world_ratings")).rows.length, 0);
    const rows = await f.service.list("world", "discussion", author);
    assert.equal(rows[0]?.id, review.id);
    assert.equal(rows[0]?.rating, null);
    assert.equal("archivedRating" in rows[0]!, false);
    assert.equal(rows[0]?.canMoveToReview, false);
    const reply = await f.service.reply("world", review.id, other, { content: "Let's talk" });
    await f.service.move("world", review.id, admin, "review", "Author's review");
    assert.equal((await f.pg.query<{ rating: number }>("SELECT rating FROM world_ratings")).rows[0]?.rating, 4);
    const location = await f.service.location("world", review.id, other, reply.reply.id);
    assert.equal(location.kind, "review");
    assert.equal(location.id, review.id);
    assert.equal((await f.service.replies("world", location.id, author))[0]?.id, reply.reply.id);
    assert.equal((await f.pg.query("SELECT * FROM admin_actions WHERE action_type='feedback_moved'")).rows.length, 2);
  } finally { await f.pg.close(); }
});

test("unrated discussions stay unrated and cannot become reviews", async () => {
  const f = await fixture();
  try {
    const discussion = await f.service.createDiscussion("world", author, { title: "Topic", content: "Actually a review" });
    await rejectStatus(f.service.move("world", discussion.id, admin, "review", "Reclassify"), 409);
    assert.equal((await f.pg.query("SELECT * FROM world_ratings")).rows.length, 0);
    await f.pg.query("UPDATE reviews SET archived_rating=3 WHERE id=$1", [discussion.id]);
    assert.equal((await f.service.list("world", "discussion", admin))[0]?.canMoveToReview, false);
    await rejectStatus(f.service.move("world", discussion.id, admin, "review", "Old consent"), 409);
    await f.service.saveReview("world", author, { rating: 4 });
    await rejectStatus(f.service.move("world", discussion.id, admin, "review", "Reclassify"), 409);
  } finally { await f.pg.close(); }
});

test("own deletions preserve other people's chat, tombstones and links; creator cannot moderate", async () => {
  const f = await fixture();
  try {
    const review = await f.service.saveReview("world", author, { rating: 4, content: "Secret old text" });
    const [first, again] = await Promise.all([f.service.discuss("world", review.id, author), f.service.discuss("world", review.id, other)]);
    assert.equal(first.id, again.id);
    const reply = await f.service.reply("world", first.id, other, { content: "Keep my message" });
    await rejectStatus(f.service.remove("world", review.id, creator), 403);
    await rejectStatus(f.service.removeReply("world", first.id, reply.reply.id, creator), 403);
    await rejectStatus(f.service.remove("world", review.id, admin), 400);
    await f.service.remove("world", review.id, author);
    assert.equal((await f.service.list("world", "review", author)).filter(row => !row.deletedAt).length, 0);
    const thread = (await f.service.list("world", "review", other))[0]!;
    assert.equal(thread.content, null); assert.equal(thread.rating, null); assert(thread.deletedAt);
    assert.equal((await f.service.list("world", "discussion", other)).length, 0);
    await f.service.remove("world", first.id, author);
    assert.equal((await f.service.replies("world", first.id, other))[0]?.content, "Keep my message");
    await f.service.removeReply("world", first.id, reply.reply.id, other);
    assert.equal((await f.service.replies("world", first.id, other)).length, 0);
    assert.equal((await f.pg.query("SELECT * FROM world_ratings")).rows.length, 0);
    await rejectStatus(f.service.reply("elsewhere", first.id, other, { content: "Wrong world" }), 404);
  } finally { await f.pg.close(); }
});

test("API gives JSON errors, retires creator hiding, supports inline review replies, and supports deep-linked paging", async () => {
  const f = await fixture();
  try {
    const app = new Hono<AppEnv>();
    app.onError((error, c) => error instanceof HTTPException ? error.getResponse() : c.json({ error: String(error) }, 500));
    const middleware = async (c: any, next: () => Promise<void>) => { c.set("user", author); await next(); };
    app.route("/worlds", createWorldFeedbackRoutes(f.db, f.service, { auth: middleware, optionalAuth: middleware, write: [], hiddenUsers: async () => [], changed: async () => {}, notify: async () => {} }));
    const request = (path: string, method: string, body?: unknown) => app.request(`/worlds/world${path}`, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const invalid = await request("/reviews", "POST", { content: "Missing stars" });
    assert.equal(invalid.status, 400);
    assert.match(((await invalid.json()) as { error: string }).error, /rating/);
    assert.equal((await request("/discussions/post/request-rating", "POST")).status, 404);
    assert.equal((await request("/discussions/post/rating-consent", "PUT", { rating: 5 })).status, 404);
    assert.equal((await request("/rating", "PUT", { rating: 5 })).status, 201);
    const review = (await f.service.ownReview("world", author))!;
    assert.equal((await request("/reviews", "POST", { content: "Old client without stars" })).status, 400);
    assert.equal((await request("/reviews", "DELETE")).status, 409);
    assert.equal((await f.pg.query<{ rating: number }>("SELECT rating FROM world_ratings")).rows[0]?.rating, 5);
    assert.equal((await request(`/reviews/${review.id}/by-creator`, "DELETE")).status, 403);
    assert.equal((await request(`/reviews/${review.id}/replies`, "POST", { content: "Inline comment" })).status, 201);
    const target = await f.service.createDiscussion("world", author, { title: "Topic", content: "Target" });
    for (let i = 0; i < 31; i++) await f.service.createDiscussion("world", other, { title: `Topic ${i}`, content: `Post ${i}` });
    const page = await request(`/discussions?postId=${target.id}`, "GET");
    const body = await page.json() as { data: Array<{ id: string }> };
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0]!.id, target.id);
    assert.equal("archivedRating" in body.data[0]!, false);
  } finally { await f.pg.close(); }
});


test("rating then text edits the same review and preserves original playtime across languages and deletion", async () => {
  const f = await fixture();
  try {
    const original = await f.service.saveReview("world", author, { rating: 5 });
    assert.equal(original.playtimeAtReviewSeconds, 3600);
    assert.equal((await f.service.list("world", "review", other)).length, 0);
    assert.equal((await f.service.ownReview("world", author))?.listed, false);
    await f.service.saveReview("world", author, { rating: 4 });
    assert.equal((await f.service.list("world", "review", author)).length, 0, "rating-only updates stay out of the list");
    f.setPlaytime(7200);
    const edited = await f.service.saveReview("sibling", author, { rating: 5, content: "Now adding my review" });
    assert.equal(edited.id, original.id);
    assert.equal(edited.rating, 5);
    assert.equal(edited.content, null);
    assert.equal(edited.reviewUpdates.at(-1)?.content, "Now adding my review");
    assert.equal(edited.playtimeAtReviewSeconds, 3600);
    assert.equal(edited.createdAt?.getTime(), original.createdAt?.getTime());
    assert.equal((await f.service.list("world", "review", author)).length, 1);
    const discussion = await f.service.discuss("world", original.id, other);
    await f.service.reply("world", discussion.id, other, { content: "Keep this conversation" });
    await f.service.remove("world", original.id, author);
    assert.equal((await f.service.list("world", "review", author)).filter(row => !row.deletedAt).length, 0);
    assert.equal((await f.pg.query("SELECT * FROM world_ratings")).rows.length, 0);
    const replacement = await f.service.saveReview("world", author, { rating: 4, content: "A fresh review" });
    assert.notEqual(replacement.id, original.id);
    assert.equal(replacement.playtimeAtReviewSeconds, 7200);
    assert.equal((await f.service.list("world", "review", author)).filter(row => !row.deletedAt).length, 1);
    assert.equal((await f.service.replies("world", discussion.id, author)).length, 1);
  } finally { await f.pg.close(); }
});

test("explicit legacy update preserves originals and consolidates only after author consent", async () => {
  const f = await fixture(`
    INSERT INTO reviews(id,user_id,world_id,rating,content,created_at,updated_at) VALUES
      ('old','author','world',2,'Old review','2026-01-01','2026-01-01'),
      ('written','author','sibling',4,'Newest written review','2026-02-01','2026-02-01');
    INSERT INTO world_ratings(id,user_id,world_id,rating) VALUES ('vote','author','world',5),('older-vote','author','sibling',4);
    INSERT INTO review_replies(id,review_id,user_id,content) VALUES ('chat','old','other','A conversation');`);
  try {
    assert.equal((await f.service.list("world", "review", author)).length, 2);
    assert.equal((await f.service.ownReview("world", author))?.id, "written");
    assert.equal((await f.service.ownReview("world", author))?.rating, 4, "do not attach coincident standalone stars");
    assert.equal((await f.pg.query("SELECT * FROM world_ratings")).rows.length, 2);
    assert.deepEqual(await f.service.location("world", "old", author), { id: "old", kind: "review" });
    assert.equal((await f.service.replies("world", "old", author))[0]?.id, "chat");
    const updated = await f.service.saveReview("world", author, { rating: 3, content: "Updated" });
    assert.equal(updated.id, "written");
    assert.equal(updated.legacyFeedback, false);
    assert.equal(updated.content, "Newest written review");
    assert.equal((await f.service.list("world", "review", author)).length, 2, "no blank duplicate cards after first update");
    assert.equal(updated.reviewUpdates[0]?.ratingBefore, 4);
    assert.equal(updated.playtimeAtReviewSeconds, null);
    assert.equal((await f.pg.query("SELECT * FROM world_ratings")).rows.length, 1);
    assert.equal((await f.pg.query<{ count: number }>("SELECT sum(review_count)::int AS count FROM worlds")).rows[0]?.count, 1);
    await f.service.move("world", "written", admin, "discussion", "Support");
    assert.equal((await f.pg.query("SELECT * FROM world_ratings")).rows.length, 0);
    assert.deepEqual(await f.service.location("world", "old", author), { id: "old", kind: "review" });
    await f.service.move("world", "written", admin, "review", "Review");
    await f.service.remove("world", "written", author);
    assert.equal((await f.pg.query("SELECT * FROM world_ratings")).rows.length, 0, "never resurrect old snapshots");
    assert.equal((await f.service.list("world", "review", author)).find(row => row.id === "old")?.rating, 2);
  } finally { await f.pg.close(); }
});

test("follower and unlisted siblings are gated consistently for posts, locations and rating totals", async () => {
  const f = await fixture();
  try {
    const review = await f.service.saveReview("sibling", author, { rating: 4, content: "Only followers" });
    const comment = await f.service.reply("sibling", review.id, author, { content: "Protected reply" });
    await f.pg.exec("UPDATE worlds SET visibility='followers' WHERE id='sibling'");
    for (const viewer of [undefined, other]) {
      assert.equal((await f.service.list("world", "review", viewer)).length, 0);
      await rejectStatus(f.service.location("world", review.id, viewer), 404);
      await rejectStatus(f.service.replies("world", review.id, viewer), 404);
      const total = await f.db.execute(sql`SELECT count(*)::int AS count FROM world_ratings WHERE world_id IN (${feedbackWorldIds("world", viewer)})`);
      assert.equal(total.rows[0]?.count, 0);
    }
    await f.pg.exec("INSERT INTO follows(id,follower_id,following_id) VALUES('follow','other','creator')");
    assert.equal((await f.service.list("world", "review", other)).length, 1);
    assert.equal((await f.service.replies("world", review.id, other))[0]?.id, comment.reply.id);
    await f.pg.exec("DELETE FROM follows");
    await rejectStatus(f.service.reply("sibling", review.id, other, { content: "Revoked" }), 404);
    await f.pg.exec("UPDATE worlds SET visibility='unlisted' WHERE id='sibling'");
    assert.equal((await f.service.list("world", "review", other)).length, 0);
    await rejectStatus(f.service.location("world", review.id, other), 404);
    assert.equal((await f.service.list("sibling", "review", other)).length, 1, "exact unlisted link remains usable");
    await f.pg.exec("UPDATE worlds SET visibility='private' WHERE id='sibling'");
    assert.equal((await f.service.list("world", "review", other)).length, 0);
    assert.equal((await f.service.list("world", "review", admin)).length, 1);
  } finally { await f.pg.close(); }
});

test("review updates append text and rating history while preserving first review and playtime", async () => {
  const f = await fixture();
  try {
    const first = await f.service.saveReview("world", author, { rating: 4, content: "Original opinion" });
    f.setPlaytime(9000);
    const updated = await f.service.saveReview("sibling", author, { rating: 5, content: "The bug is fixed" });
    assert.equal(updated.id, first.id); assert.equal(updated.content, "Original opinion");
    assert.equal(updated.reviewUpdates.length, 1); assert.equal(updated.reviewUpdates[0]?.ratingBefore, 4);
    assert.equal(updated.reviewUpdates[0]?.ratingAfter, 5); assert.equal(updated.playtimeAtReviewSeconds, 3600);
    assert.equal((await f.pg.query<{ rating: number }>("SELECT rating FROM world_ratings")).rows[0]?.rating, 5);
    const ratingOnly = await f.service.saveReview("world", author, { rating: 3 });
    assert.equal(ratingOnly.reviewUpdates.length, 2); assert.equal(ratingOnly.reviewUpdates[1]?.content, null);
    assert.equal((await f.service.saveReview("world", author, { rating: 3 })).reviewUpdates.length, 2);
    assert.equal((await f.service.list("world", "discussion", author)).length, 0);
  } finally { await f.pg.close(); }
});

test("discussion and comment edits enforce the three-minute deadline and ownership", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.service.createDiscussion("world", author, { content: "Missing title" }), HTTPException);
    const post = await f.service.createDiscussion("world", author, { title: "Bug", content: "Details" });
    await f.service.editDiscussion("world", post.id, author, { title: "Correct title", content: "Correct details" });
    assert.equal((await f.service.list("world", "discussion", author))[0]?.title, "Correct title");
    await rejectStatus(f.service.editDiscussion("world", post.id, other, { title: "No", content: "No" }), 403);
    const reply = await f.service.reply("world", post.id, other, { content: "My reply" });
    await f.service.editReply("world", post.id, reply.reply.id, other, { content: "My correction" });
    await rejectStatus(f.service.editReply("world", post.id, reply.reply.id, author, { content: "No" }), 403);
    await f.pg.query("UPDATE reviews SET created_at=now()-interval '3 minutes' WHERE id=$1", [post.id]);
    await f.pg.query("UPDATE review_replies SET created_at=now()-interval '3 minutes' WHERE id=$1", [reply.reply.id]);
    await rejectStatus(f.service.editDiscussion("world", post.id, author, { title: "Late", content: "Late" }), 409);
    await rejectStatus(f.service.editReply("world", post.id, reply.reply.id, other, { content: "Late" }), 409);
  } finally { await f.pg.close(); }
});

test("deletion removes leaf posts and comments but keeps one or more replies and allows continuation", async () => {
  const f = await fixture();
  try {
    const empty = await f.service.createDiscussion("world", author, { title: "Empty", content: "No replies" });
    await f.service.remove("world", empty.id, author);
    assert.equal((await f.pg.query("SELECT id FROM reviews WHERE id=$1", [empty.id])).rows.length, 0);
    const post = await f.service.createDiscussion("world", author, { title: "Keep", content: "Root" });
    const parent = await f.service.reply("world", post.id, author, { content: "Parent" });
    const child = await f.service.reply("world", post.id, other, { content: "Child", replyToReplyId: parent.reply.id });
    await f.service.removeReply("world", post.id, parent.reply.id, author);
    const rows = await f.service.replies("world", post.id, other);
    assert(rows.find(r => r.id === parent.reply.id)?.deletedAt);
    assert.equal(rows.find(r => r.id === child.reply.id)?.replyToReplyId, parent.reply.id);
    await f.service.remove("world", post.id, author);
    await f.service.reply("world", post.id, other, { content: "Continue after root deletion" });
    assert.equal((await f.service.replies("world", post.id, other)).length, 3);
    await f.service.removeReply("world", post.id, child.reply.id, other);
    assert.equal((await f.service.replies("world", post.id, other)).length, 2);
  } finally { await f.pg.close(); }
});

test("retrying the same submission never duplicates a review update, discussion or comment", async () => {
  const f = await fixture();
  try {
    const initial = { clientId: crypto.randomUUID(), rating: 4, content: "Original" };
    const review = await f.service.saveReview("world", author, initial);
    await f.service.saveReview("world", author, initial);
    const update = { clientId: crypto.randomUUID(), rating: 5, content: "Update" };
    await f.service.saveReview("world", author, update);
    assert.equal((await f.service.saveReview("world", author, update)).reviewUpdates.length, 1);
    const discussion = { clientId: crypto.randomUUID(), title: "Topic", content: "Content" };
    const first = await f.service.createDiscussion("world", author, discussion);
    assert.equal((await f.service.createDiscussion("world", author, discussion)).id, first.id);
    const comment = { clientId: crypto.randomUUID(), content: "Reply" };
    await f.service.reply("world", review.id, other, comment);
    await f.service.reply("world", review.id, other, comment);
    assert.equal((await f.service.replies("world", review.id, author)).length, 1);
    assert.equal((await f.service.list("world", "review", author))[0]?.replyCount, 1);
    await rejectStatus(f.service.createDiscussion("world", other, discussion), 409);
  } finally { await f.pg.close(); }
});

test("moving an updated review preserves dated text but exposes no ratings in Discussion", async () => {
  const f = await fixture();
  try {
    const review = await f.service.saveReview("world", author, { rating: 4, content: "Original" });
    await f.service.saveReview("world", author, { rating: 5, content: "Bug fixed" });
    await f.service.move("world", review.id, admin, "discussion", "Support");
    const moved = (await f.service.list("world", "discussion", author))[0]!;
    assert.equal(moved.rating, null); assert.deepEqual(moved.reviewUpdates, []);
    assert.equal(moved.discussionUpdates[0]?.content, "Bug fixed");
    assert.equal('ratingBefore' in moved.discussionUpdates[0]!, false);
    await f.service.move("world", review.id, admin, "review", "Return");
    assert.equal((await f.service.list("world", "review", author))[0]?.reviewUpdates[0]?.ratingAfter, 5);
  } finally { await f.pg.close(); }
});

test("existing legacy conversation URLs resolve and accept replies through the canonical post", async () => {
  const f = await fixture(`INSERT INTO reviews(id,user_id,world_id,rating,content) VALUES('old-review','author','world',4,'Original');
    INSERT INTO review_replies(id,review_id,user_id,content) VALUES('old-reply','old-review','other','First');`);
  try {
    await f.pg.exec("INSERT INTO reviews(id,user_id,world_id,kind,linked_review_id,legacy_feedback) VALUES('discussion-old-review','author','world','discussion','old-review',true)");
    await f.service.reply("world", "discussion-old-review", other, { content: "Second" });
    assert.equal((await f.service.list("world", "review", author))[0]?.replyCount, 2);
    assert.equal((await f.service.replies("world", "old-review", author)).length, 2);
    assert.deepEqual(await f.service.location("world", "discussion-old-review", author), {id:'old-review',kind:'review'});
  } finally { await f.pg.close(); }
});

test("pristine synthetic vote owners do not duplicate written reviews but all authored content stays visible", async () => {
  const f = await fixture(`INSERT INTO reviews(id,user_id,world_id,rating,content) VALUES('written','author','world',4,'Written opinion');
    INSERT INTO world_ratings(id,user_id,world_id,rating) VALUES('vote','author','world',5),('standalone','other','world',3);`);
  try {
    let rows = await f.service.list("world", "review", author);
    assert.deepEqual(new Set(rows.map(row => row.id)), new Set(['written']));
    assert.equal((await f.service.ownReview("world", author))?.id, 'written');
    assert.equal((await f.service.ownReview("world", other))?.id, 'feedback-vote-v4-standalone');
    await f.service.reply("world", "feedback-vote-v4-vote", other, { content: "Keep this conversation" });
    assert((await f.service.list("world", "review", author)).some(row => row.id === 'feedback-vote-v4-vote'));
    await f.service.saveReview("world", author, { rating: 5, content: "Update" });
    rows = await f.service.list("world", "review", author);
    assert(rows.some(row => row.id === 'feedback-vote-v4-vote'), 'never hide a row with replies after consolidation');
    await f.service.remove("world", 'feedback-vote-v4-vote', author);
    assert.equal((await f.pg.query("SELECT * FROM world_ratings WHERE user_id='author'")).rows.length, 1, 'archived synthetic owner cannot remove the new active vote');
  } finally { await f.pg.close(); }
});
