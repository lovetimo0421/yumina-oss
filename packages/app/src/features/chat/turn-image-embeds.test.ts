import assert from "node:assert/strict";
import test from "node:test";
import { splitTurnImages } from "../../../sandbox/chat/turn-image-embeds";

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
