import assert from "node:assert/strict";
import test from "node:test";
import { detectLang } from "./detect-lang.js";

// The 30% han ratio alone filed 53 Chinese posts as English on 2026-09-06 —
// posts about model names and error strings, where the Latin is quoted
// verbatim and outweighs the Chinese around it. A source filed as English
// never gets an English translation, so English readers saw Chinese. Every
// case below is a real prod post (lightly trimmed).

test("Chinese around quoted Latin is Chinese", () => {
  for (const zh of [
    "本地ollma无法正常调用 connect的时候提示Failed to fetch model list: fetch failed 但是ollma正常运行",
    "Grok 4.1 掛了? 從剛剛開始就不能用了，完全不回饋訊息(直接空白)，有些卡還會直接回覆Grok 4.1 已棄用(deprecated)",
    "gork-4.1和4.2均显示“dismiss” 详细显示“response blocked by safety/content filter.Try regenerating——the filter",
    "工作室ai助手无限Error: Connection lost — please check your network and try again. 如题，换模型甚至私有api都Error",
    "之前是An unexpected error occured，现在是A resource failed to load. Reloading should fix it.",
    "我也是，还有一个cannot execute INSERT in a read-only transaction……",
    "GEMINI 3 FLASH和3.1 flash lite混用，不错的",
    "今晚会添加kimi2.6, GLM, 还有 3 haiku",
    "Deepseek V3.2已恢复",
    "NWJ9U7MQ，求求qwq",
    "我的！JGZGZFLS",
  ]) {
    assert.equal(detectLang(zh), "zh", zh);
  }
});

test("English that mentions one Chinese name is still English", () => {
  for (const en of [
    "Has anyone finished 仙宗遗梦? The second ending is really hard.",
    "The card 墟井 is the best DnD experience on here, 10/10 would recommend",
    "My favourite is still 禁果 but the new one is close",
    "Gemini 3 Flash is fast but Sonnet 4.6 writes better",
  ]) {
    assert.equal(detectLang(en), "en", en);
  }
});

test("a lone han run is Chinese unless English prose surrounds it", () => {
  assert.equal(detectLang("嗯，4.1 YYDS"), "zh"); // punctuation tips it
  assert.equal(detectLang("Gemini 2.5flash light這個"), "zh"); // no English words, just names
  assert.equal(detectLang("3.1 flash lite也不错"), "zh");
  assert.equal(detectLang("2.5pro和3.5 flash！"), "zh");
  assert.equal(detectLang("2.5pro and 3.5 flash"), "en");
  assert.equal(detectLang("Gemini 3 Flash呢？"), "zh");
});

test("kana still wins over han, and Spanish still needs its markers", () => {
  assert.equal(detectLang("レビューに返信できる機能を追加してほしい"), "ja");
  assert.equal(detectLang("Grok 4.1 が落ちた？さっきから全然使えない"), "ja");
  assert.equal(detectLang("¿El suministro diario todavía tiene un error?"), "es");
  assert.equal(detectLang("Alguien me dejó feedback sobre mi bot y sería genial poder responder."), "es");
  assert.equal(detectLang("Someone gave me a feedback on my bot and It would be really nice"), "en");
});
