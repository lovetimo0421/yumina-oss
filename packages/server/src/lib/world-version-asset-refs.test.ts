import { test } from "node:test";
import assert from "node:assert/strict";
import { assetRefsCover, versionAssetRefs } from "./world-version-asset-refs.js";

const ID = "2ab61d99-2021-8b22-a6c7-1fa2ed1b6702";
const PATH = "users/IjV4beDHrIo85dKxT1Q2eOvPR5klFlbe/registered/786372bf861e85cd";

test("every asset id and storage path in the content is listed", () => {
  const refs = versionAssetRefs({
    entries: [{ content: `<img src="/api/files/${PATH}.png">`, image: `@asset:${ID}` }],
    [`map-${ID.toUpperCase()}`]: "x",
    music: "users/Q0iV/audio/music/032fe276-614c-47b2-a2d1-45e8780b65bd-富江_慢节奏.mp3",
    css: `background: url(https://cdn.example/${PATH}?w=3)`,
  }, { galleryImages: ["worlds/w1/image/a.png"] });
  assert.ok(refs.assetIds.includes(ID));
  assert.ok(refs.assetIds.includes(ID.toUpperCase()));
  assert.ok(refs.assetIds.includes("032fe276-614c-47b2-a2d1-45e8780b65bd"));
  for (const path of [PATH, "users/Q0iV/audio/music/032fe276-614c-47b2-a2d1-45e8780b65bd-富江_慢节奏.mp3", "worlds/w1/image/a.png"]) {
    assert.ok(refs.assetPaths.some((p) => p.includes(path)), path);
  }
});

test("an id glued to more hex-and-dash text is still found", () => {
  const other = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const glued = `${other}-${ID}`;
  assert.deepEqual(versionAssetRefs({ k: glued }).assetIds.filter((x) => x === other || x === ID).sort(), [ID, other].sort());
});

test("odd-shaped assets fall back to reading the content", () => {
  assert.equal(assetRefsCover(ID, PATH), true);
  assert.equal(assetRefsCover("asset-123", PATH), false);
  assert.equal(assetRefsCover(ID, "gallery/old.png"), false);
  assert.equal(assetRefsCover(ID, "users/a/b c.png"), false);
});
