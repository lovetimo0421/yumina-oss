import { test } from "node:test";
import assert from "node:assert/strict";
import { previewText } from "./preview-text";

test("an image tag at the head of an opening is not shown", () => {
  const raw = "[image:@asset:5c3e5cbd-c74d-4a50-b31c-550eb173d775|alt=又一次伸出的手|scene=cg_express] *1996年9月1日。霍格沃茨特快列车。*";
  assert.equal(previewText(raw), "1996年9月1日。霍格沃茨特快列车。");
});

test("markdown leads and marks go, the words stay", () => {
  const raw = "# 德拉科妮娅·马尔福\n\n**1980年6月5日生。** 卢修斯的独生女\n- 斯莱特林\n> 引言";
  assert.equal(previewText(raw), "德拉科妮娅·马尔福\n1980年6月5日生。 卢修斯的独生女\n斯莱特林\n引言");
});

test("every platform tag and imported HTML is dropped", () => {
  assert.equal(previewText("[bg: rain] 雨 [audio: bell] 钟声 [speaker: 莉莉]"), "雨 钟声");
  assert.equal(previewText('<div style="color:red">红字</div><br>下一行'), "红字 下一行");
});

test("a bracket that is not a platform tag is the author's own words", () => {
  assert.equal(previewText("[好感: 25] 她看着你"), "[好感: 25] 她看着你");
  assert.equal(previewText("snake_case_name 和 2*3*4"), "snake_case_name 和 2*3*4");
});
