import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getMetaForPath, injectMeta } from "./seo.js";

const template = readFileSync(new URL("../../../app/index.html", import.meta.url), "utf8");

test("Krew previews identify the same real image and canonical page", async () => {
  for (const path of ["/krew", "/krew/"]) {
    const meta = await getMetaForPath(path);
    const html = injectMeta(template, meta);
    const imageUrl = new URL("/krew-pirate-island.png", meta.url).href;
    assert.equal(meta.image, imageUrl);
    assert.ok(html.includes(`<meta property="og:image" content="${imageUrl}"`));
    assert.ok(html.includes(`<meta name="twitter:image" content="${imageUrl}"`));
    assert.match(html, /property="og:image:width" content="2400"/);
    assert.match(html, /property="og:image:height" content="1260"/);
    assert.match(html, /<title>Krew\.io - Free Multiplayer Pirate Ship Battle Game<\/title>/);
    assert.ok(html.includes(`<link rel="canonical" href="${meta.url}"`));
    const objects = [...html.matchAll(/<script type="application\/ld\+json">([^]*?)<\/script>/g)]
      .map((match) => JSON.parse(match[1]!));
    const game = objects.find((object) => object["@type"] === "VideoGame");
    assert.ok(game);
    assert.equal(game.mainEntityOfPage["@id"], meta.url);
    assert.equal(game.mainEntityOfPage.primaryImageOfPage.url, imageUrl);
    assert.equal(game.image, imageUrl);
    assert.equal(game.screenshot, imageUrl);
  }
});

test("ordinary Yumina pages retain their own preview metadata", async () => {
  const html = injectMeta(template, await getMetaForPath("/app/hub"));
  assert.doesNotMatch(html, /krew-pirate-island|VideoGame|primaryImageOfPage/);
  assert.match(html, /property="og:image:width" content="1200"/);
  assert.match(html, /property="og:image:height" content="630"/);
});
