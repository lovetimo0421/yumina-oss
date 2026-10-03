import assert from "node:assert/strict";
import test from "node:test";
import { esc, markdownToParagraphs, renderCreator, renderGrid, renderHome, renderWorld } from "./prerender.js";

const card = {
  id: "5c9c88e8-f8fa-4893-b967-61f8c34404ba",
  publicId: "5c9c88e8",
  name: "Sakura Season",
  thumbnailUrl: "worlds/5c9c88e8/thumbnail/cover.png",
  creatorName: "mia~",
  creatorUsername: "mia",
};

test("text is escaped so creator content can never become markup", () => {
  assert.equal(esc(`<img onerror="x"> & "q"`), "&lt;img onerror=&quot;x&quot;&gt; &amp; &quot;q&quot;");
  const html = renderGrid([{ ...card, name: `<script>alert(1)</script>`, creatorName: `"><b>` }]);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("a card is a real link to the world's address with its cover and creator", () => {
  const html = renderGrid([card]);
  assert.match(html, /<a class="pre-card" href="\/@mia\/sakura-season-5c9c88e8">/);
  assert.match(html, /<img class="pre-card__img" src="[^"]*\/cdn\/key\/[^"]*"/);
  assert.match(html, /Sakura Season/);
  assert.match(html, /mia~/);
});

test("a world without a handle yet falls back to the old link, which forwards", () => {
  const html = renderGrid([{ ...card, publicId: null }]);
  assert.match(html, /href="\/app\/hub\/5c9c88e8-f8fa-4893-b967-61f8c34404ba"/);
});

test("markdown becomes plain paragraphs; a heading equal to the name is dropped", () => {
  const paragraphs = markdownToParagraphs(
    "# Sakura Season\n\n**Spring** in a small town.\n\n- one\n- two\n\nSecond paragraph with [a link](https://x.y).",
    "Sakura Season",
  );
  assert.deepEqual(paragraphs, ["Spring in a small town.", "one", "two", "Second paragraph with a link."]);
});

test("the world page carries name, creator link, description, tags and more from the creator", () => {
  const html = renderWorld(
    {
      id: card.id,
      publicId: card.publicId,
      name: card.name,
      description: "A spring story.\n\nIt rains.",
      thumbnailUrl: card.thumbnailUrl,
      status: "published",
      isPublished: true,
      visibility: "public",
      ageRating: "all",
      language: "en",
      tags: ["romance", "slice of life"],
      creatorId: "u1",
      creatorName: "mia~",
      creatorUsername: "mia",
    },
    [{ ...card, id: "other", publicId: "0a0a0a0a", name: "Another" }],
  );
  assert.match(html, /<h1 class="pre-h1">Sakura Season<\/h1>/);
  assert.match(html, /<a href="\/@mia">mia~<\/a>/);
  assert.match(html, /<p>A spring story\.<\/p><p>It rains\.<\/p>/);
  assert.match(html, /<li>romance<\/li><li>slice of life<\/li>/);
  assert.match(html, /href="\/@mia\/another-0a0a0a0a"/);
});

test("home and creator pages render a heading and a grid", () => {
  assert.match(renderHome([card]), /^<main class="pre pre-home"><h1 class="pre-h1">Discover<\/h1><div class="pre-grid">/);
  const creator = renderCreator(
    { id: "u1", name: "mia~", username: "mia", bio: "Writes *small* worlds.", image: null, banner: null, isBanned: false, isSuspended: false },
    [card],
  );
  assert.match(creator, /<h1 class="pre-h1">mia~<\/h1>/);
  assert.match(creator, /<p>Writes small worlds\.<\/p>/);
  assert.match(creator, /pre-card/);
});
