import assert from "node:assert/strict";
import test from "node:test";
import { keywordMatches } from "@yumina/engine";
import { cleanKeywords, wordStartKeyword, type KeywordEntry } from "./card-translate-keywords.js";

// A small DanMachi-like card in Russian: most entries mention adventurers and ladies, as the real one does.
function card(): KeywordEntry[] {
  const filler = (i: number): KeywordEntry => ({
    srcName: `Place ${i}`, srcText: `An adventurer rests here. The lady of the house greets the adventurer ${i}.`,
    name: `Место ${i}`, text: `Здесь отдыхает авантюрист. Госпожа дома встречает авантюриста ${i}.`, matchWholeWords: false,
  });
  return [
    { srcName: "Syr Flova", srcText: "Syr is a waitress at the Benevolent Mistress.", name: "Сир Флова", text: "Сир работает официанткой в «Хозяйке».", matchWholeWords: false },
    { srcName: "Riveria Ljos Alf", srcText: "Riveria is the high elf mage of Loki Familia.", name: "Риверия Льос Альв", text: "Риверия, высшая эльфийка и маг Фамилии Локи.", matchWholeWords: false },
    { srcName: "Rivira", srcText: "Rivira is the town on the 18th floor.", name: "Ривира", text: "Ривира, город на 18-м этаже.", matchWholeWords: false },
    { srcName: "Mia Grand", srcText: "Mama Mia runs the tavern.", name: "Миа Гранд", text: "Мама Миа держит таверну.", matchWholeWords: false },
    { srcName: "Adventurers", srcText: "Adventurers dive into the Dungeon.", name: "Авантюристы", text: "Авантюристы спускаются в Подземелье.", matchWholeWords: false },
    ...Array.from({ length: 20 }, (_, i) => filler(i)),
  ];
}

test("translated keywords: too short, too generic and mismapped forms are dropped; short names match at a word start", () => {
  const entries = card();
  const glossary = { "Syr": "Сир", "Riveria": "Риверия", "Rivira": "Ривира", "Mia": "Миа" };
  const original = { "entry.0.keywords": ["Syr"], "entry.1.keywords": ["Riveria"], "entry.2.keywords": ["Rivira"], "entry.3.keywords": ["Mia", "Mama Mia"], "entry.4.keywords": ["adventurer"] };
  const proposed = {
    "entry.0.keywords": ["Сир", "госпож", "Syr"],
    "entry.1.keywords": ["Риверия", "Ривира", "Riveria"],
    "entry.2.keywords": ["Ривира", "Rivira"],
    "entry.3.keywords": ["ма", "Миа", "мама Миа", "авантюрист", "Mia"],
    "entry.4.keywords": ["авантюрист", "adventurer"],
  };
  const { keywords, dropped } = cleanKeywords({ tgt: "ru", glossary, entries, original, proposed });
  const why = Object.fromEntries(dropped.map((d) => [`${d.key}:${d.keyword}`, d.why]));
  // «ма» is two letters and no name: it would fire inside мама, мать, магия
  assert.equal(why["entry.3.keywords:ма"], "short");
  // «госпож» and «авантюрист» are in most of the card's text, unlike Syr / Mia themselves
  assert.equal(why["entry.0.keywords:госпож"], "generic");
  assert.equal(why["entry.3.keywords:авантюрист"], "generic");
  // ...but the Adventurers entry is about adventurers: its own name keeps the word
  assert.ok(keywords["entry.4.keywords"]!.includes("авантюрист"));
  // the town's name handed to Riveria's entry
  assert.equal(why["entry.1.keywords:Ривира"], "mismapped");
  assert.deepEqual(keywords["entry.2.keywords"], ["Ривира", "Rivira"]);
  // every original keyword is kept
  assert.ok(keywords["entry.3.keywords"]!.includes("Mama Mia") && keywords["entry.3.keywords"]!.includes("Mia"));
  // «Сир» (3 letters) becomes a word-start regex: Сиру / Сиры fire, сирота / сирена do not
  const syr = keywords["entry.0.keywords"]!.find((k) => k.startsWith("/"))!;
  assert.ok(syr);
  for (const t of ["Сир улыбнулась.", "Я позвал Сиру.", "у Сиры глаза"]) assert.ok(keywordMatches(t, syr, false), t);
  for (const t of ["Сирота плачет.", "Сирена воет.", "Кассир молчит."]) assert.ok(!keywordMatches(t, syr, false), t);
  // «Миа» is a 3-letter name: a word-start regex too
  const mia = keywords["entry.3.keywords"]!.find((k) => k.startsWith("/"))!;
  assert.ok(keywordMatches("Мама Миа нахмурилась", mia, false));
  assert.ok(!keywordMatches("Мамиа", mia, false));
});

test("translated keywords: Korean one-syllable forms are dropped, two-syllable ones match at a word start; Indonesian short words match whole", () => {
  const ko: KeywordEntry[] = [{ srcName: "Mana", srcText: "Mana flows.", name: "마나", text: "마나가 흐른다.", matchWholeWords: false }];
  const k = cleanKeywords({ tgt: "ko", glossary: {}, entries: ko, original: { "entry.0.keywords": ["mana"] }, proposed: { "entry.0.keywords": ["마", "마나", "mana"] } });
  assert.deepEqual(k.dropped.map((d) => d.keyword), ["마"]);
  const re = k.keywords["entry.0.keywords"]![0]!;
  assert.ok(keywordMatches("그녀의 마나가 흐른다", re, false));
  assert.ok(!keywordMatches("그녀는 사마나라고 불렸다", re, false));

  const id: KeywordEntry[] = [{ srcName: "Fire", srcText: "Fire burns.", name: "Api", text: "Api membakar.", matchWholeWords: false }];
  const r = cleanKeywords({ tgt: "id", glossary: {}, entries: id, original: { "entry.0.keywords": ["fire"] }, proposed: { "entry.0.keywords": ["api", "fire"] } });
  const api = r.keywords["entry.0.keywords"]![0]!;
  assert.equal(api, wordStartKeyword("api", "id"));
  assert.ok(keywordMatches("Apinya padam.", api, false));
  assert.ok(keywordMatches("Ada api!", api, false));
  assert.ok(!keywordMatches("Kapten itu sapi.", api, false));
});

test("translated keywords: a form that fires where the entry's own source keywords fire is kept; one that names another subject is dropped", () => {
  const bell = (i: number): KeywordEntry => ({ srcName: `Bell Cranel · Now ${i}`, srcText: `Bell trains. Bell eats. ${i}`, name: `Bell Cranel · Kini ${i}`, text: `Bell berlatih. Si Kelinci Putih makan. ${i}`, matchWholeWords: false });
  const ryuu = (i: number): KeywordEntry => ({ srcName: `Ryuu ${i}`, srcText: `Ryuu works at the tavern. ${i}`, name: `Ryuu ${i}`, text: `Ryuu bekerja di kedai. ${i}`, matchWholeWords: false });
  const entries = [...Array.from({ length: 5 }, (_, i) => bell(i)), ...Array.from({ length: 4 }, (_, i) => ryuu(i)), { srcName: "Lili", srcText: "Lili counts coins.", name: "Lili", text: "Lili menghitung koin.", matchWholeWords: false }];
  const original = { "entry.0.keywords": ["Bell", "White Rabbit"], "entry.9.keywords": ["Lili"] };
  const proposed = { "entry.0.keywords": ["Kelinci Putih", "Bell"], "entry.9.keywords": ["kedai", "Lili"] };
  const { keywords, dropped } = cleanKeywords({ tgt: "id", glossary: {}, entries, original, proposed });
  assert.ok(keywords["entry.0.keywords"]!.includes("Kelinci Putih"));
  assert.deepEqual(dropped.map((d) => `${d.keyword}:${d.why}`), ["kedai:elsewhere"]);
});
