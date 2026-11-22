import assert from "node:assert/strict";
import test from "node:test";
import { guessLang, plazaLang, plazaReadLangs, plazaTargets } from "./plaza-translate.js";

// 广场 is translated on view only. Korean, Indonesian and Russian readers get
// their own language once they open the shelf, and only then: a zh/en/es/ja
// reader's visit never starts the three newer languages for every item.

test("the reader's UI language picks the translation, zh-Hant reading zh", () => {
  assert.equal(plazaLang("ko"), "ko");
  assert.equal(plazaLang("id"), "id");
  assert.equal(plazaLang("ru-RU"), "ru");
  assert.equal(plazaLang("zh-Hant"), "zh");
  assert.equal(plazaLang("fr"), null);
  assert.equal(plazaLang(undefined), null);
});

test("a visit starts the four old languages plus the reader's own", () => {
  assert.deepEqual(plazaTargets("zh"), ["zh", "en", "es", "ja"]);
  assert.deepEqual(plazaTargets("ko"), ["zh", "en", "es", "ja", "ko"]);
  assert.deepEqual(plazaTargets("ru"), ["zh", "en", "es", "ja", "ru"]);
});

test("newer-language readers see the English translation until theirs exists", () => {
  assert.deepEqual(plazaReadLangs("ja"), ["ja"]);
  assert.deepEqual(plazaReadLangs("id"), ["id", "en"]);
});

test("short titles are told apart by script", () => {
  assert.equal(guessLang("나의 첫 번째 카드"), "ko");
  assert.equal(guessLang("Моя первая карточка"), "ru");
  assert.equal(guessLang("我的第一张卡"), "zh");
  assert.equal(guessLang("私のカード"), "ja");
  assert.equal(guessLang("Mi tarjeta favorita ñ"), "es");
  assert.equal(guessLang("Ceritanya bagus banget"), "id");
  assert.equal(guessLang("My first card"), "en");
});
