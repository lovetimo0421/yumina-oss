import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { db } from "../db/index.js";
import { user, worlds } from "../db/schema.js";
import { configureWorldAudience, runWithWorldViewer } from "./world-publication-access.js";
import { clearPrerenderCache, renderPublicContent } from "./prerender.js";

const owner = `prerender-owner-${crypto.randomUUID()}`;
const hidden = crypto.randomUUID();
const visible = crypto.randomUUID();
const hiddenTitle = "Hidden prerender story";
const username = "prerenderowner";
const creatorPath = `/@${username}`;
const visiblePath = `/@${username}/visible-story-aabb1122`;

before(async () => {
  await db.insert(user).values({ id: owner, name: "Owner", username, email: `${owner}@test.invalid`, emailVerified: true });
  await db.insert(worlds).values([
    { id: hidden, creatorId: owner, publicId: "aabb3344", name: hiddenTitle, thumbnailUrl: "worlds/hidden-cover.png", status: "published", isPublished: true, visibility: "public", ageRating: "all", downloadCount: 200 },
    { id: visible, creatorId: owner, publicId: "aabb1122", name: "Visible story", status: "published", isPublished: true, visibility: "public", ageRating: "all", downloadCount: 100 },
  ]);
  configureWorldAudience([{ worldId: hidden, creatorId: owner }]);
});

test("public home, creator and related-card HTML omit the restricted card while retaining another card by its creator", async () => {
  for (const path of ["/", creatorPath, visiblePath]) {
    clearPrerenderCache();
    const html = await renderPublicContent(path);
    assert.ok(html, path);
    assert.equal(html.includes(hiddenTitle), false, `${path} leaks the hidden title`);
    assert.equal(html.includes("worlds/hidden-cover.png"), false, `${path} leaks the hidden cover`);
    assert.equal(html.includes("aabb3344"), false, `${path} leaks the hidden public address`);
    assert.equal(html.includes("Visible story"), true, `${path} removes an unrelated card`);
  }
});

test("owner and admin rendering cannot populate a shared public HTML cache with restricted cards", async () => {
  for (const isAdmin of [false, true]) {
    const actorId = isAdmin ? "prerender-admin" : owner;
    for (const path of ["/", creatorPath, visiblePath]) {
      clearPrerenderCache();
      const privileged = await runWithWorldViewer(actorId, () => renderPublicContent(path), isAdmin);
      assert.ok(privileged, path);
      assert.equal(privileged.includes(hiddenTitle), false, `${path} caches privileged content`);
      const anonymous = await renderPublicContent(path);
      assert.ok(anonymous, path);
      assert.equal(anonymous.includes(hiddenTitle), false, `${path} serves privileged content to guests`);
      assert.equal(anonymous.includes("Visible story"), true);
    }
    clearPrerenderCache();
    const hiddenPath = `/@${username}/hidden-prerender-story-aabb3344`;
    assert.equal(await runWithWorldViewer(actorId, () => renderPublicContent(hiddenPath), isAdmin), null);
    assert.equal(await renderPublicContent(hiddenPath), null);
  }
});
