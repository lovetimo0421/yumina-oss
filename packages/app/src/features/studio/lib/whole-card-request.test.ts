import { test } from "node:test";
import assert from "node:assert/strict";
import { wholeCardRequest } from "./whole-card-request";

const zh = "帮我把整张卡写出来（名字、简介、角色、开场白都要）。我的点子是：";
const en = "Write this whole card for me (name, blurb, character and opening). My idea: ";

test("the fill with an idea after it is the whole-card request", () => {
  assert.equal(wholeCardRequest(`${zh}深夜便利店的店员，其实是吸血鬼`, zh), true);
  assert.equal(wholeCardRequest(`${en}a vampire night-shift clerk`, en), true);
});

test("the fill alone, or with nothing worth calling an idea, is not", () => {
  assert.equal(wholeCardRequest(zh, zh), false);
  assert.equal(wholeCardRequest(`${zh} `, zh), false);
  assert.equal(wholeCardRequest(`${en}x`, en), false);
});

test("a message that does not start with the fill is not", () => {
  assert.equal(wholeCardRequest("把开场白改短一点", zh), false);
  assert.equal(wholeCardRequest(`我想要：${zh}吸血鬼`, zh), false);
});
