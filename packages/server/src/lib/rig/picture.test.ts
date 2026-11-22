import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { attachedPictureKeys, pictureOnWhite } from "./picture.js";
import type { ChatMessage } from "../llm/types.js";

const me = "u1abc";
const url = (user: string, id: string, ext = "png") =>
  `https://bucket.example/studio-chat%2F${user}%2F${id}.${ext}?X-Amz-Signature=abc`;
const a = "11111111-2222-3333-4444-555555555555";
const b = "66666666-7777-8888-9999-000000000000";

test("the pictures a creator attached, oldest first, only their own", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: [{ type: "text", text: "this one" }, { type: "image_url", image_url: { url: url(me, a, "jpg") } }] },
    { role: "user", content: "no picture" },
    { role: "user", content: [{ type: "image_url", image_url: { url: url("someone-else", b) } }] },
    { role: "user", content: [{ type: "image_url", image_url: { url: url(me, b, "webp") } }, { type: "image_url", image_url: { url: url(me, a, "jpg") } }] },
  ];
  assert.deepEqual(attachedPictureKeys(messages, me), [`studio-chat/${me}/${a}.jpg`, `studio-chat/${me}/${b}.webp`]);
  assert.deepEqual(attachedPictureKeys([{ role: "user", content: "hi" }], me), []);
});

test("the app's own /cdn/key/ address of an attachment (what the Studio actually sends)", () => {
  const key = `studio-chat/${me}/${a}.jpg`;
  const cdn = `https://yumina.example/cdn/key/${Buffer.from(key).toString("base64url")}`;
  assert.deepEqual(attachedPictureKeys([{ role: "user", content: [{ type: "text", text: "x" }, { type: "image_url", image_url: { url: cdn } }] }], me), [key]);
  const theirs = `https://x/cdn/key/${Buffer.from(`studio-chat/other/${a}.jpg`).toString("base64url")}`;
  assert.deepEqual(attachedPictureKeys([{ role: "user", content: [{ type: "image_url", image_url: { url: theirs } }] }], me), []);
});

test("a picture with transparency reaches the rig on white, not with the colour its transparent pixels hide", async () => {
  // 2x1: an opaque grey pixel, and a fully transparent one whose hidden colour is black (what a cut-out standee's
  // background often holds); a half-transparent dark pixel would have come out solid too
  const raw = Buffer.from([128, 128, 128, 255, 0, 0, 0, 0]);
  const png = await sharp(raw, { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
  const out = await pictureOnWhite(png, "png");
  assert.equal(out.name, "picture.png");
  const { data, info } = await sharp(out.bytes).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 3);
  assert.deepEqual([...data.subarray(0, 3)], [128, 128, 128]);
  assert.deepEqual([...data.subarray(3, 6)], [255, 255, 255]);
});

test("a picture without transparency goes to the rig untouched", async () => {
  const jpg = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer();
  const out = await pictureOnWhite(jpg, "jpeg");
  assert.equal(out.name, "picture.jpg");
  assert.equal(out.bytes, jpg);
});
