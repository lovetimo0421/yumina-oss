import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql } from "drizzle-orm";
import { db, ensureTables } from "../db/index.js";
import { PUBLIC_ORIGIN } from "./env.js";
import { looksLikeContactHandle } from "./handle-privacy.js";
import { creatorSitemapHandles, generateSitemaps, getMetaForPath, invalidateSitemaps, robotsValue } from "./seo.js";

test("a handle that is an email address is caught, with or without its punctuation", () => {
  for (const handle of [
    "annagmailcom", "anna.leegmailcom", "anna_gmail_com", "anna@gmail.com", "AnnaGmailCom", "@annagmailcom",
    "123456789qqcom", "lilyqqcom", "wang163com", "wang_126.com", "samoutlookcom", "samhotmailcom", "kenyahoocom",
    "mayicloudcom", "lifoxmailcom", "joprotonmailcom", "minnavercom", "someone@example.org",
  ]) {
    assert.equal(looksLikeContactHandle(handle), true, handle);
  }
});

test("a handle of nine or more digits is caught; shorter numbers are not", () => {
  for (const handle of ["13800138000", "123456789", "+8613800138000", "138-0013-8000", "138.0013.8000"]) {
    assert.equal(looksLikeContactHandle(handle), true, handle);
  }
  for (const handle of ["12345678", "2024", "007", "1"]) assert.equal(looksLikeContactHandle(handle), false, handle);
});

test("ordinary handles are left alone", () => {
  for (const handle of [
    "mia", "qq", "qqcom", "gmailcom", "gmail", "qqmusic", "outlook_fan", "yahoo", "comet", "dotcom", "welcome", "tomcom",
    "player123456789", "123456789abc", "a1b2c3d4e5f6g7h8i9", "anna2024", "x163", "naverland", "icloudy", "gmailcommander",
    "hotmailcomics", "user_9000", "", null, undefined,
  ]) {
    assert.equal(looksLikeContactHandle(handle), false, String(handle));
  }
});

test("the sitemap's creator list drops contact handles and keeps the rest in order", () => {
  assert.deepEqual(creatorSitemapHandles(new Set(["mia", "annagmailcom", "13800138000", "ren", "lilyqqcom"])), ["mia", "ren"]);
});

// ── against the database ─────────────────────────────────────────────────────

const prefix = `hp${crypto.randomUUID().slice(0, 6)}`;
const hex = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const plain = `${prefix}-mia`;
const email = `${prefix}gmailcom`;

before(async () => {
  await ensureTables();
  for (const [id, key] of [[plain, "p1"], [email, "e1"]] as const) {
    await db.execute(sql`INSERT INTO "user"(id, name, email, username, email_verified, role, created_at, updated_at)
      VALUES (${id}, 'Mia', ${`${id}@example.test`}, ${id}, true, 'user', now(), now())`);
    await db.execute(sql`INSERT INTO worlds(id, public_id, creator_id, name, description, status, is_published, visibility, age_rating, language, schema, tags, download_count)
      VALUES (${`${prefix}-${key}`}, ${`${hex}${key}`}, ${id}, 'Iron Keep', 'A keep.', 'published', true, 'public', 'all', 'en', '{}'::jsonb, '[]'::jsonb, 1)`);
  }
  invalidateSitemaps();
});

after(async () => {
  await db.execute(sql`DELETE FROM worlds WHERE id LIKE ${`${prefix}-%`}`);
  await db.execute(sql`DELETE FROM "user" WHERE id IN (${plain}, ${email})`);
});

test("a profile whose handle is an email address is not in the sitemap and carries noindex; its worlds stay listed", async () => {
  const files = await generateSitemaps();
  const pages = files.children.get("sitemap-pages.xml")!;
  assert.ok(pages.includes(`<loc>${PUBLIC_ORIGIN}/@${plain}</loc>`));
  assert.ok(!pages.includes(`<loc>${PUBLIC_ORIGIN}/@${email}</loc>`));
  const worlds = [...files.children].filter(([name]) => name.startsWith("sitemap-worlds")).map(([, xml]) => xml).join("");
  assert.ok(worlds.includes(`${hex}e1</loc>`), "the world itself is still listed");

  const hidden = await getMetaForPath(`/@${email}`);
  assert.equal(hidden.noindex, true);
  assert.equal(hidden.status, undefined, "the page still opens");
  assert.equal(robotsValue(hidden), "noindex", "links to the member's worlds may still be followed");
  assert.equal((await getMetaForPath(`/@${plain}`)).noindex, undefined);
});
