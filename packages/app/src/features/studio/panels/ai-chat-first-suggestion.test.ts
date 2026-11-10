import { test } from "node:test";
import assert from "node:assert/strict";
import { firstSuggestionKey } from "./ai-chat-first-suggestion";

const english = "Alice is a high school bully who secretly regrets everything she does. ".repeat(6);
const chinese = "爱丽丝是学校里人人害怕的校霸，其实她心里一直为自己做过的事后悔。".repeat(6);

test("an empty card is asked to be written", () => {
  assert.equal(firstSuggestionKey([{ role: "character", content: "" }, { role: "greeting", content: english }], "zh"), "suggestLore");
});

test("an imported card in another script is offered a translation", () => {
  assert.equal(firstSuggestionKey([{ role: "character", content: english }], "zh"), "suggestTranslate");
  assert.equal(firstSuggestionKey([{ role: "character", content: chinese }], "en"), "suggestTranslate");
});

test("a card already written in the reader's script is looked over", () => {
  assert.equal(firstSuggestionKey([{ role: "character", content: chinese }], "zh"), "suggestReview");
  assert.equal(firstSuggestionKey([{ role: "character", content: english }], "en"), "suggestReview");
});

test("the presets every card carries do not count as writing", () => {
  assert.equal(firstSuggestionKey([{ role: "system", presetId: "task", content: english }, { role: "character", content: "" }], "zh"), "suggestLore");
});
