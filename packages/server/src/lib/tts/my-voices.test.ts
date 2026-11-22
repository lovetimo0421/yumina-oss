import { test } from "node:test";
import assert from "node:assert/strict";
import { voiceElementName } from "./my-voices.js";

test("a kept voice is named by what was typed, else by the description's first clause", () => {
  assert.equal(voiceElementName("沈砚", "三十岁男人，嗓音温和低沉"), "沈砚");
  assert.equal(voiceElementName("", "二十岁出头的女剑客，声音清冷干脆，说话简短"), "二十岁出头的女剑客");
  assert.equal(voiceElementName(undefined, "A warm, low voice"), "Awarm");
  // Spaces and symbols an @name cannot hold are dropped; a long clause is cut at 12.
  assert.equal(voiceElementName("Old Man Li!", ""), "OldManLi");
  assert.equal(voiceElementName("", "一个非常非常非常非常非常长的描述没有标点"), "一个非常非常非常非常非常");
  assert.equal(voiceElementName("", "，，"), "声音");
});
