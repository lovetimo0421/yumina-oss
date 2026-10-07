import test from "node:test";
import assert from "node:assert/strict";
import { fitFontWeight, fontWeightsOf } from "@yumina/engine";
import { idsToNames, namesToIds } from "./parts/variable-text";

import { colorWord } from "./color-words";

test("a colour reads as a word, not as rgba()", () => {
  const word = (v: string) => {
    const m = /^rgba?\((\d+), (\d+), (\d+)/.exec(v);
    const hex = v.startsWith("#") ? [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)) : m!.slice(1, 4).map(Number);
    return colorWord({ r: hex[0]!, g: hex[1]!, b: hex[2]! });
  };
  assert.equal(word("rgba(0, 0, 0, 0.5)"), "black");
  assert.equal(word("#ffffff"), "white");
  assert.equal(word("#808080"), "gray");
  assert.equal(word("#e05c6e"), "red");
  assert.equal(word("#d06fa8"), "pink");
  assert.equal(word("#4c8fd0"), "blue");
  assert.equal(word("#5bb974"), "green");
  assert.equal(word("#f2c14e"), "yellow");
  assert.equal(word("#8d6fd1"), "purple");
  assert.equal(word("#7a5c3e"), "brown");
});

test("a single-weight display face offers only the weight it has", () => {
  assert.deepEqual(fontWeightsOf(`"ZCOOL KuaiLe", sans-serif`), [400]);
  assert.equal(fitFontWeight(`"ZCOOL KuaiLe", sans-serif`, 700), 400);
  assert.equal(fitFontWeight(`"Noto Serif SC", serif`, 700), 600);
  assert.equal(fitFontWeight("Georgia, serif", 700), 700);
  assert.equal(fontWeightsOf("Georgia, serif"), null);
});

test("a part's own tokens read as words and write back as tokens", () => {
  const named = [{ id: "v1", name: "好感" }, { id: "value", name: "这个变量的内容" }];
  assert.equal(idsToNames("{{value}} / {{v1}}", named), "{{这个变量的内容}} / {{好感}}");
  assert.equal(namesToIds("{{这个变量的内容}} / {{好感}}", named), "{{value}} / {{v1}}");
});
