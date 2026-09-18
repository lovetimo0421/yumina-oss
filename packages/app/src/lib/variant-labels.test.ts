import assert from "node:assert/strict";
import test from "node:test";

import { variantLanguageLabel, variantRowLabels } from "./languages";

test("with no author label a row shows the variant's own translated title", () => {
  // Frieren ships four genuinely different titles.
  const labels = variantRowLabels([
    { id: "en", name: "Frieren · Journey to the North", language: "en", variantLabel: null },
    { id: "es", name: "Frieren: El Viaje hacia el Norte", language: "es", variantLabel: null },
    { id: "ja", name: "葬送のフリーレン 北上の旅", language: "ja", variantLabel: null },
    { id: "zh", name: "葬送的芙莉莲 北上之旅", language: "zh", variantLabel: null },
  ]);
  assert.equal(labels.get("en"), "Frieren · Journey to the North");
  assert.equal(labels.get("es"), "Frieren: El Viaje hacia el Norte");
  assert.equal(labels.get("zh"), "葬送的芙莉莲 北上之旅");
});

test("an author label is shown verbatim, contents never inspected", () => {
  // The whole point of the rewrite: a label an author chose to make a language
  // name is still theirs, and must survive.
  const labels = variantRowLabels([
    { id: "a", name: "Jujutsu Kaisen", language: "en", variantLabel: "English" },
    { id: "b", name: "咒术回战", language: "zh", variantLabel: "色色版" },
  ]);
  assert.equal(labels.get("a"), "English");
  assert.equal(labels.get("b"), "色色版");
});

test("a title shared across languages gets the language appended, not swapped in", () => {
  // Character-name cards keep one title everywhere. Every row still leads with
  // the card's name — swapping in the language would leave a list where some
  // rows name a card and others name a language.
  const labels = variantRowLabels([
    { id: "en", name: "Takagi and Chi", language: "en", variantLabel: null },
    { id: "es", name: "Takagi and Chi", language: "es", variantLabel: null },
    { id: "ja", name: "Takagi and Chi", language: "ja", variantLabel: null },
  ]);
  assert.equal(labels.get("en"), "Takagi and Chi（English）");
  assert.equal(labels.get("es"), "Takagi and Chi（Español）");
  assert.equal(labels.get("ja"), "Takagi and Chi（日本語）");
});

test("a group mixing unique and shared titles resolves each row on its own", () => {
  // 桜色の季節: en/es have real translations, zh and ja share one title.
  const labels = variantRowLabels([
    { id: "en", name: "Sakura Season", language: "en", variantLabel: null },
    { id: "es", name: "La Estación Color Cerezo", language: "es", variantLabel: null },
    { id: "ja", name: "桜色の季節", language: "ja", variantLabel: null },
    { id: "zh", name: "桜色の季節", language: "zh", variantLabel: null },
  ]);
  assert.equal(labels.get("en"), "Sakura Season");
  assert.equal(labels.get("es"), "La Estación Color Cerezo");
  assert.equal(labels.get("ja"), "桜色の季節（日本語）");
  assert.equal(labels.get("zh"), "桜色の季節（中文）");
});

test("same-language variants stay apart when one of them is numbered", () => {
  // Two zh variants of one card. The numbered one keeps its number; the other
  // keeps its title, and the two rows still read differently — which is the
  // only thing that matters. Forcing the unlabelled row down to "中文" would
  // say strictly less.
  const labels = variantRowLabels([
    { id: "a", name: "壶中之毒", language: "zh", variantLabel: null },
    { id: "b", name: "壶中之毒", language: "zh", variantLabel: "变体 2" },
  ]);
  assert.equal(labels.get("a"), "壶中之毒");
  assert.equal(labels.get("b"), "变体 2");
  assert.notEqual(labels.get("a"), labels.get("b"));
});

test("two unlabelled same-language variants are genuinely indistinguishable", () => {
  // Same title, same language, no author label: nothing can separate these, and
  // the appended language does not help. Pinned so the degenerate case is a
  // known wash rather than a surprise.
  const labels = variantRowLabels([
    { id: "a", name: "壶中之毒", language: "zh", variantLabel: null },
    { id: "b", name: "壶中之毒", language: "zh", variantLabel: null },
  ]);
  assert.equal(labels.get("a"), "壶中之毒（中文）");
  assert.equal(labels.get("b"), "壶中之毒（中文）");
});

test("a variant with neither label nor title still renders something", () => {
  const labels = variantRowLabels([
    { id: "a", name: "", language: "fr", variantLabel: null },
    { id: "b", name: null, language: null, variantLabel: null },
  ]);
  assert.equal(labels.get("a"), "Français");
  assert.equal(labels.get("b"), "");
});

test("download filenames keep the language, which is the point there", () => {
  assert.equal(variantLanguageLabel({ name: "La Estación", language: "es", variantLabel: null }), "Español");
  assert.equal(variantLanguageLabel({ name: "Sakura Season", language: "en", variantLabel: null }), "English");
});
