import assert from "node:assert/strict";
import test from "node:test";
import { readTurnImageVersions } from "@yumina/shared";
import { removeTurnImage, selectTurnImageInText, splitTurnImages } from "../../../sandbox/chat/turn-image-embeds";

const key = (path: string) => Buffer.from(path).toString("base64url");
const turnEmbed = `[image:/cdn/key/${key("users/u1/turn-images/abc.jpg")}|alt=scene]`;

// 问道 slices everything after 【去向】 into choice buttons and drops long
// lines, so a picture appended after the choices silently disappeared.
test("a per-turn picture after the choices is peeled off for the card", () => {
  const reply = `正文\n\n【去向】\n- 走生门路\n- 独行归庐\n\n${turnEmbed}`;
  const out = splitTurnImages(reply);
  assert.equal(out.text, "正文\n\n【去向】\n- 走生门路\n- 独行归庐");
  assert.deepEqual(out.embeds, [turnEmbed]);
});

test("a card's own image embeds stay in the text", () => {
  const own = `[image:/cdn/key/${key("users/u1/assets/map.png")}|size=full]`;
  const out = splitTurnImages(`地图\n\n${own}`);
  assert.equal(out.text, `地图\n\n${own}`);
  assert.deepEqual(out.embeds, []);
});

test("a reply without pictures is returned untouched", () => {
  const out = splitTurnImages("只有文字  \n");
  assert.equal(out.text, "只有文字  \n");
  assert.deepEqual(out.embeds, []);
});

test("removing a picture keeps the reply text and the other pictures", () => {
  const second = `[image:/cdn/key/${key("users/u1/turn-images/def.jpg")}|alt=again]`;
  const reply = `正文

${turnEmbed}

${second}`;
  const out = removeTurnImage(reply, turnEmbed);
  assert.equal(out, `正文

${second}`);
  assert.deepEqual(splitTurnImages(out).embeds, [second]);
  assert.equal(removeTurnImage(out, second), "正文");
});

test("removing the only picture leaves just the story", () => {
  const embed = splitTurnImages(`正文

${turnEmbed}`).embeds[0]!;
  assert.equal(removeTurnImage(`正文

${turnEmbed}`, embed), "正文");
});

test("removing a picture that is no longer there changes nothing", () => {
  const own = `[image:/cdn/key/${key("users/u1/assets/map.png")}|size=full]`;
  assert.equal(removeTurnImage(`地图

${own}  `, turnEmbed), `地图

${own}  `);
  // A card's own embed is never removed, even when named.
  assert.equal(removeTurnImage(`地图

${own}`, own), `地图

${own}`);
});

const k = (name: string) => key(`users/u1/turn-images/${name}.jpg`);
const redrawn = `[image:/cdn/key/${k("c")}|alt=scene|versions=${k("a")},${k("b")},${k("c")}]`;

test("a picture drawn before versions existed reads as its one version", () => {
  const embed = splitTurnImages(`正文

${turnEmbed}`).embeds[0]!;
  assert.equal(readTurnImageVersions(embed)?.keys.length, 1);
  assert.equal(embed, turnEmbed);
});

test("a redrawn picture shows the picked version and lists them all", () => {
  const [embed] = splitTurnImages(`正文

${redrawn}`).embeds;
  assert.equal(embed, redrawn);
  // What everything that shows the picture reads: the address in front.
  assert.ok(embed!.startsWith(`[image:/cdn/key/${k("c")}|`));
  assert.deepEqual(readTurnImageVersions(embed!), { keys: [k("a"), k("b"), k("c")], index: 2, options: ["alt=scene"] });
  // The card's renderer never sees it, versions and all.
  assert.equal(splitTurnImages(`正文

${redrawn}`).text, "正文");
});

test("stepping back rewrites only the picture's address, and the album/gallery read the picked one", () => {
  const own = `[image:/cdn/key/${key("users/u1/assets/map.png")}|size=full]`;
  const text = `地图
${own}

正文

${redrawn}`;
  const back = selectTurnImageInText(text, k("a"))!;
  assert.equal(back, `地图
${own}

正文

[image:/cdn/key/${k("a")}|alt=scene|versions=${k("a")},${k("b")},${k("c")}]`);
  const shown = splitTurnImages(back).embeds[0]!;
  assert.ok(shown.startsWith(`[image:/cdn/key/${k("a")}|`));
  assert.equal(readTurnImageVersions(shown)?.index, 0);
  // "Remove picture" still removes it, every version with it.
  assert.equal(removeTurnImage(back, shown), `地图
${own}

正文`);
});

test("a version that isn't the reply's is not picked", () => {
  assert.equal(selectTurnImageInText(`正文

${redrawn}`, k("zzz")), null);
  assert.equal(selectTurnImageInText("没有图", k("a")), null);
  // Picking the shown one is a no-op.
  assert.equal(selectTurnImageInText(`正文

${redrawn}`, k("c")), `正文

${redrawn}`);
});
