import assert from "node:assert/strict";
import test from "node:test";
import { guessTextScript, variantNeedsTranslation } from "./languages";

test("guessTextScript reads the writing system", () => {
  assert.equal(guessTextScript("雨下得很大，顺着招牌滴成一条细线。你推开门，铃铛叮当一响。"), "zh");
  assert.equal(guessTextScript("雨がひどく降っている。あなたはドアを開けた。ベルが鳴った。"), "ja");
  assert.equal(guessTextScript("It was raining hard. You push the door open and the bell rings."), "latin");
  assert.equal(guessTextScript("短"), null);
});

test("a variant flags only when its text is in another script", () => {
  const chinese = "雨下得很大，顺着招牌滴成一条细线。你推开门，铃铛叮当一响。";
  assert.equal(variantNeedsTranslation("en", chinese), true);
  assert.equal(variantNeedsTranslation("zh", chinese), false);
  assert.equal(variantNeedsTranslation("zh-Hant", chinese), false);
  assert.equal(variantNeedsTranslation("en", "It was raining hard. You push the door open."), false);
  assert.equal(variantNeedsTranslation("es", "It was raining hard. You push the door open."), false, "Latin to Latin is not guessed");
  assert.equal(variantNeedsTranslation(null, chinese), false);
});
