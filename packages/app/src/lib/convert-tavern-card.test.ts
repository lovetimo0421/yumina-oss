import assert from "node:assert/strict";
import test from "node:test";
import { migrateWorldDefinition } from "@yumina/engine";
import { convertTavernCard, convertTavernWorldbook, guessTavernLanguage, isTavernCharacterCard } from "./convert-tavern-card";
import { simpleArchetypeLabelOf } from "@/features/editor/lib/simple-archetype";
import { TAVERN_V1, TAVERN_V2, TAVERN_V3 } from "./__fixtures__/tavern-cards";

const ZH = { personality: "性格", scenario: "故事背景", greeting: "开场白", greetingN: "开场白 {{n}}", lorebookEntryN: "世界书条目 {{n}}" };

/** Characters as the editor sees them — after the load-time migration that
 *  folds the old "personality" role into "character". */
const characters = (world: ReturnType<typeof convertTavernCard>) =>
  migrateWorldDefinition(world).entries.filter((e) => e.role === "character");

test("V1: one character named after the card, personality under its own heading", () => {
  assert.ok(isTavernCharacterCard(TAVERN_V1));
  const world = convertTavernCard(TAVERN_V1);
  const chars = characters(world);
  assert.equal(chars.length, 1);
  assert.equal(chars[0]!.name, "Aqua");
  assert.equal(chars[0]!.content, "A cheerful water goddess who is bad with money.\n\n## Personality\nLoud, proud, cries easily.");
  assert.equal(world.entries.find((e) => e.role === "scenario")!.name, "Scenario");
  assert.equal(simpleArchetypeLabelOf(migrateWorldDefinition(world).entries), "chat");
});

test("V2: real name, localized titles, lorebook titles from comment / name / first key", () => {
  const world = convertTavernCard(TAVERN_V2, ZH);
  const chars = characters(world);
  assert.equal(chars.length, 1);
  assert.equal(chars[0]!.name, "林雾");
  assert.match(chars[0]!.content, /图书管理员[\s\S]*## 性格\n安静/);
  assert.equal(world.entries.find((e) => e.role === "scenario")!.name, "故事背景");
  assert.deepEqual(world.entries.filter((e) => e.role === "greeting").map((e) => e.name), ["开场白", "开场白 2"]);
  const lore = world.entries.filter((e) => e.role === "lore").map((e) => e.name);
  assert.deepEqual(lore, ["旧书库", "周馆长", "借书卡", "世界书条目 4"]);
  assert.ok(!world.entries.some((e) => /Imported Entry|Character Description/.test(e.name)));
  assert.equal(simpleArchetypeLabelOf(migrateWorldDefinition(world).entries), "chat");
});

test("V3: name (not nickname), V3 entry `name`, description-only character", () => {
  const world = convertTavernCard(TAVERN_V3);
  const chars = characters(world);
  assert.equal(chars.length, 1);
  assert.equal(chars[0]!.name, "Sera");
  assert.equal(chars[0]!.content, "Captain of the airship Kestrel.");
  assert.deepEqual(world.entries.filter((e) => e.role === "lore").map((e) => e.name), ["The Kestrel"]);
});

test("a card with no name gets a titled fallback, not an empty character", () => {
  const world = convertTavernCard({ spec: "chara_card_v2", data: { name: "", description: "x" } }, { cardName: "导入的角色卡" });
  assert.equal(world.name, "导入的角色卡");
  assert.equal(characters(world)[0]!.name, "导入的角色卡");
});

test("standalone worldbook: its name, entry titles from comment then key", () => {
  const world = convertTavernWorldbook({
    name: "雨城",
    entries: {
      "0": { uid: 0, key: ["码头"], comment: "", content: "东边的码头。" },
      "1": { uid: 1, key: [], comment: "天气", content: "常年下雨。" },
    },
  });
  assert.equal(world.name, "雨城");
  assert.deepEqual(world.entries.map((e) => e.name).sort(), ["码头", "天气"].sort());
});

test("guessTavernLanguage reads the file, not the interface", () => {
  assert.equal(guessTavernLanguage(TAVERN_V2, "en"), "zh");
  assert.equal(guessTavernLanguage(TAVERN_V2, "zh-Hant"), "zh-Hant");
  assert.equal(guessTavernLanguage(TAVERN_V1, "zh"), "en");
  assert.equal(guessTavernLanguage({ data: { description: "ここは図書館です。" } }, "zh"), "ja");
  assert.equal(guessTavernLanguage({ data: { description: "Ella es la capitana de la nave y no confía en los que llegan para robar." } }, "en"), "es");
});
