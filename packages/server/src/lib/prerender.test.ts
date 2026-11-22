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
  // A tag with a page is a link to it; the text stays as the creator typed it.
  assert.match(html, /<li><a href="\/app\/tag\/romance">romance<\/a><\/li><li><a href="\/app\/tag\/slice-of-life">slice of life<\/a><\/li>/);
  assert.match(html, /href="\/@mia\/another-0a0a0a0a"/);
});

const fullWorld = {
  id: card.id,
  publicId: card.publicId,
  name: card.name,
  description: "A spring story.",
  thumbnailUrl: card.thumbnailUrl,
  status: "published",
  isPublished: true,
  visibility: "public",
  ageRating: "all",
  language: "en",
  tags: ["恋爱", "my own tag", "NSFW", `<b>"x"</b>`],
  creatorId: "u1",
  creatorName: "mia~",
  creatorUsername: "mia",
  downloadCount: 12345,
  reviewCount: 23,
  averageRating: 4.56,
};

test("the world page shows the whole description, not the first 2,400 characters", () => {
  const long = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1} ${"word ".repeat(40)}`).join("\n\n");
  const html = renderWorld({ ...fullWorld, description: long }, []);
  assert.match(html, /<p>Paragraph 1 word/);
  assert.match(html, /<p>Paragraph 30 word/, "the last paragraph of a 6,000-character description is on the page");
});

test("the world page carries the opening, counts, languages, tag links and worlds like it", () => {
  const html = renderWorld(fullWorld, [], {
    opening: "The bell rings.\n\nYou look up <at> the door.",
    announcement: "Chapter two is out.",
    similar: [{ ...card, id: "sim", publicId: "0b0b0b0b", name: "Plum Rain", creatorName: "ren", creatorUsername: "ren" }],
    siblings: [{ publicId: "0c0c0c0c", name: "樱花季", language: "zh", creatorUsername: "mia" }],
  });
  assert.match(html, /<section class="pre-opening"><h2 class="pre-h2">Opening<\/h2><div class="pre-text"><p>The bell rings\.<\/p><p>You look up &lt;at&gt; the door\.<\/p><\/div><\/section>/);
  assert.match(html, /<p>Chapter two is out\.<\/p>/);
  assert.match(html, /<p class="pre-by pre-stats">12,345 plays · 4\.6 \/ 5, 23 reviews<\/p>/);
  assert.match(html, /<p class="pre-by pre-langs">English · <a href="\/@mia\/[^"]*0c0c0c0c" hreflang="zh">中文<\/a><\/p>/);
  // 恋爱 is Romance in the vocabulary, so it links to /app/tag/romance.
  assert.match(html, /<li><a href="\/app\/tag\/romance">恋爱<\/a><\/li>/);
  // A tag outside the vocabulary, and one that names adult content, stay plain text.
  assert.match(html, /<li>my own tag<\/li><li>NSFW<\/li>/);
  assert.match(html, /<li>&lt;b&gt;&quot;x&quot;&lt;\/b&gt;<\/li>/);
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /<section class="pre-more pre-similar"><h2 class="pre-h2">More like this<\/h2><div class="pre-grid"><a class="pre-card" href="\/@ren\/plum-rain-0b0b0b0b">/);
});

test("a world with no plays, reviews, opening or neighbours shows none of those blocks", () => {
  const html = renderWorld({ ...fullWorld, downloadCount: 0, reviewCount: 0, language: null }, [], { opening: null, announcement: null, similar: [], siblings: [] });
  assert.doesNotMatch(html, /pre-stats|pre-langs|pre-opening|pre-similar/);
});

test("the home page links to every kind of public page, and leaves out what this edition lacks", () => {
  const tags = [
    { canonical: "Romance", slug: "romance", label: "Romance", count: 224 },
    { canonical: "RPG", slug: "rpg", label: "RPG <b>", count: 90 },
  ];
  const full = renderHome([card], { tags, posts: [{ slug: "is-janitor-ai-free", title: "Is Janitor AI free? & more" }], fresh: [{ ...card, id: "new-1", name: "Brand New" }], browse: [{ path: "/ai-rpg", label: "AI RPG" }], pricing: true, atelier: true, community: true });
  assert.match(full, /^<main class="pre pre-home"><h1 class="pre-h1">Discover<\/h1>/);
  assert.match(full, /free AI model with no message limit/);
  assert.match(full, /<h2 class="pre-h2">Browse by tag<\/h2><ul class="pre-tags"><li><a href="\/app\/tag\/romance">Romance<\/a><\/li><li><a href="\/app\/tag\/rpg">RPG &lt;b&gt;<\/a><\/li><\/ul>/);
  for (const href of ["/atelier", "/pricing", "/blog", "/blog/is-janitor-ai-free", "/updates", "/app/community", "https://docs.yumina.io/"]) {
    assert.ok(full.includes(`href="${href}"`), `links to ${href}`);
  }
  assert.ok(full.includes("Is Janitor AI free? &amp; more"), "post titles are escaped");
  assert.ok(full.indexOf('class="pre-grid"') < full.indexOf("Browse by tag"), "worlds come first");
  assert.match(full, /<h2 class="pre-h2">New worlds<\/h2><div class="pre-grid">[\s\S]*Brand New/);

  const bare = renderHome([card], { tags: [], posts: [], fresh: [], browse: [], pricing: false, atelier: false, community: false });
  for (const gone of ['href="/atelier"', 'href="/pricing"', 'href="/app/community"', "Browse by tag", "From the blog", "New worlds"]) {
    assert.ok(!bare.includes(gone), `no ${gone} when it does not exist`);
  }
  assert.ok(bare.includes('href="/updates"'));
});

test("home and creator pages render a heading and a grid", () => {
  assert.match(renderHome([card]), /^<main class="pre pre-home"><h1 class="pre-h1">Discover<\/h1><p class="pre-lede">Play and create AI driven games, visual novels, anime characters and simulators\.<\/p><div class="pre-grid">/);
  const creator = renderCreator(
    { id: "u1", name: "mia~", username: "mia", bio: "Writes *small* worlds.", image: null, banner: null, isBanned: false, isSuspended: false },
    [card],
  );
  assert.match(creator, /<h1 class="pre-h1">mia~<\/h1>/);
  assert.match(creator, /<p>Writes small worlds\.<\/p>/);
  assert.match(creator, /pre-card/);
});

test("Krew listings link to the public game without exposing arbitrary game paths", () => {
  const world = {
    ...card, name: "Krew.io", description: "Sail with your crew.",
    status: "published", isPublished: true, visibility: "public", ageRating: "all",
    language: "en", tags: [], creatorId: "u1",
  };
  for (const gamePath of ["/krew", "/krew/"]) {
    assert.match(renderWorld({ ...world, gamePath }, []), /<a href="\/krew">Play Krew\.io<\/a>/);
  }
  for (const gamePath of [null, undefined, "/krew?env=test", "/krew/room/ABCD", "javascript:alert(1)"]) {
    assert.doesNotMatch(renderWorld({ ...world, gamePath }, []), /Play Krew\.io|href="javascript:/);
  }
});
