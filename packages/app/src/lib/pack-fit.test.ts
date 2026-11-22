import assert from "node:assert/strict";
import { test } from "node:test";
import type { Variable, WorldEntry, YuminaBundle } from "@yumina/engine";
import {
  cardCharacters,
  displayName,
  defaultCollectionChoices,
  findPackCollections,
  fitPackToCard,
  linkableVariables,
  packTakesCharacters,
  shortDescription,
} from "./pack-fit";

const v = (id: string, name: string, type: Variable["type"], defaultValue: unknown): Variable =>
  ({ id, name, type, defaultValue } as unknown as Variable);

const bundle = (variables: Variable[]): YuminaBundle =>
  ({ bundleVersion: "3.0.0", name: "p", description: "", tags: [], createdAt: "", entries: [], variables, rules: [], audioTracks: [] } as YuminaBundle);

const entry = (over: Partial<WorldEntry>): WorldEntry =>
  ({ id: crypto.randomUUID(), name: "", content: "", role: "character", enabled: true, keywords: [], conditions: [], conditionLogic: "all", alwaysSend: false, position: 0, section: "system-presets", ...over } as WorldEntry);

// The NPC Relationship Board's own starting value, trimmed.
const npcBoard = bundle([
  v("npcs", "NPCs", "json", {
    aria: { bio: "A close friend who has traveled alongside the protagonist.", mood: "happy", name: "Aria", tags: ["Companion", "Healer"], color: "#ec4899", trust: 65, avatar: "A", affinity: 72, eventLog: [{ text: "Met at the inn", time: "Day 1" }], lastInteraction: "Shared a meal by the fire" },
    kane: { bio: "A mercenary.", mood: "neutral", name: "Kane", tags: ["Mercenary"], color: "#3b82f6", trust: 40, avatar: "K", affinity: 30, eventLog: [], lastInteraction: "" },
  }),
]);

// The phone's: contacts, and sample messages and posts from them.
const phone = bundle([
  v("phone_contacts", "Contacts", "json", { aria: { name: "Aria", color: "#ec4899", avatar: "A", signature: "Eat well today, too!" } }),
  v("phone_sms", "SMS", "json", [{ from: "aria", text: "Dinner?", time: "12:14", npcId: "aria" }]),
  v("phone_feed", "Feed", "json", [{ id: "p1", text: "Rain today", author: "aria", comments: [] }]),
  v("phone_notes", "Notes", "json", []),
  v("phone_unread", "Unread", "json", { sms: 1, feed: 1 }),
]);

const inventory = bundle([
  v("inventory", "Inventory", "json", [{ id: "potion", name: "Healing Potion", count: 3 }, { id: "scroll", name: "Fireball Scroll", count: 1 }]),
  v("inventory_equipped", "Equipped", "json", { weapon: { id: "sword", name: "Iron Sword" }, accessory: null }),
  v("inventory_capacity", "Inventory Capacity", "number", 20),
]);

const card = {
  entries: [
    entry({ name: "Aqua", content: "Name: Aqua Hoshino\nA high-school actor who hides his plans behind a calm face. He wants revenge.", portrait: "@asset:00000000-0000-4000-8000-000000000001", position: 1 }),
    entry({ name: "有马加奈", content: "# 有马加奈\n天才童星出身的演员，嘴硬心软。喜欢 Aqua。", position: 2 }),
    entry({ name: "{{user}}", content: "the player", position: 3 }),
    entry({ name: "Off", content: "disabled", enabled: false, position: 4 }),
    entry({ name: "Pack NPC", content: "from a pack", bundleInstallId: "x", position: 5 }),
    entry({ name: "World", role: "lore", content: "not a person", position: 6 }),
  ],
  variables: [v("money", "Money", "number", 0), v("trustAqua", "Aqua trust", "number", 50), v("chapter", "Chapter", "string", "1")],
};

test("the card's characters are its own enabled character entries", () => {
  const chars = cardCharacters(card);
  assert.deepEqual(chars.map((c) => c.name), ["Aqua", "有马加奈"]);
  assert.equal(chars[0]!.key, "aqua");
  assert.equal(chars[1]!.key, "char_2");
  assert.equal(chars[0]!.portrait, "@asset:00000000-0000-4000-8000-000000000001");
  assert.equal(chars[0]!.description, "A high-school actor who hides his plans behind a calm face.");
  assert.equal(chars[1]!.description, "天才童星出身的演员，嘴硬心软。");
});

test("a short description skips name lines and headings", () => {
  assert.equal(shortDescription("[Character: Kana]\nName: Kana\nAge: 17\nAppearance: red hair, short, sharp eyes.", "Kana"), "red hair, short, sharp eyes.");
  assert.equal(shortDescription("**Personality:** proud, blunt and secretly kind to everyone she meets", "Kana"), "proud, blunt and secretly kind to everyone she meets");
  assert.equal(shortDescription("", "Kana"), "");
});

test("a relationship board's people are found and filled with the card's characters", () => {
  const cols = findPackCollections(npcBoard);
  assert.equal(cols.length, 1);
  assert.equal(cols[0]!.people, true);
  assert.deepEqual(cols[0]!.sampleNames, ["Aria", "Kane"]);
  const chars = cardCharacters(card);
  const choices = defaultCollectionChoices(cols, chars);
  assert.equal(choices.npcs, "characters");
  const fitted = fitPackToCard(npcBoard, cols, choices, chars);
  const npcs = fitted.variables[0]!.defaultValue as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(npcs), ["aqua", "char_2"]);
  assert.equal(npcs.aqua!.name, "Aqua");
  assert.equal(npcs.aqua!.avatar, "@asset:00000000-0000-4000-8000-000000000001");
  assert.equal(npcs.char_2!.avatar, "有");
  assert.equal(npcs.aqua!.bio, "A high-school actor who hides his plans behind a calm face.");
  // Numbers, colours and one-word states stay; the sample's story goes.
  assert.equal(npcs.aqua!.affinity, 72);
  assert.equal(npcs.char_2!.affinity, 30);
  assert.equal(npcs.aqua!.mood, "happy");
  assert.equal(npcs.aqua!.color, "#ec4899");
  assert.deepEqual(npcs.aqua!.tags, []);
  assert.deepEqual(npcs.aqua!.eventLog, []);
  assert.equal(npcs.aqua!.lastInteraction, "");
  assert.equal(npcs.char_2!.lastInteraction, "");
  // The original pack is untouched.
  assert.equal((npcBoard.variables[0]!.defaultValue as Record<string, unknown>).aria !== undefined, true);
});

test("a phone's sample messages go with its sample contacts", () => {
  const cols = findPackCollections(phone);
  const byKey = Object.fromEntries(cols.map((c) => [c.key, c]));
  assert.equal(byKey.phone_contacts!.people, true);
  assert.equal(byKey.phone_sms!.dependsOn, "phone_contacts");
  assert.equal(byKey.phone_feed!.dependsOn, "phone_contacts");
  assert.equal(byKey.phone_notes, undefined);
  const chars = cardCharacters(card);
  const choices = defaultCollectionChoices(cols, chars);
  assert.equal(choices.phone_sms, "clear");
  const fitted = fitPackToCard(phone, cols, choices, chars);
  const value = (id: string) => fitted.variables.find((x) => x.id === id)!.defaultValue;
  assert.deepEqual(Object.keys(value("phone_contacts") as object), ["aqua", "char_2"]);
  assert.equal((value("phone_contacts") as Record<string, Record<string, unknown>>).aqua!.signature, "");
  assert.deepEqual(value("phone_sms"), []);
  assert.deepEqual(value("phone_feed"), []);
  assert.deepEqual(value("phone_unread"), { sms: 0, feed: 0 });
  // Keeping the sample contacts keeps their messages too.
  const kept = fitPackToCard(phone, cols, { ...choices, phone_contacts: "keep" }, chars);
  assert.equal(kept, phone);
  // Every character left out: the same.
  assert.equal(fitPackToCard(phone, cols, choices, []), phone);
});

test("a card without characters keeps the samples", () => {
  const cols = findPackCollections(npcBoard);
  const choices = defaultCollectionChoices(cols, []);
  assert.equal(choices.npcs, "keep");
  assert.equal(fitPackToCard(npcBoard, cols, choices, []), npcBoard);
});

test("other samples can be emptied: a bag, and equipment slots", () => {
  const cols = findPackCollections(inventory);
  assert.deepEqual(cols.map((c) => [c.key, c.people, c.shape]), [["inventory", false, "array"], ["inventory_equipped", false, "slots"]]);
  const choices = defaultCollectionChoices(cols, cardCharacters(card));
  assert.deepEqual(choices, { inventory: "keep", inventory_equipped: "keep" });
  const fitted = fitPackToCard(inventory, cols, { inventory: "clear", inventory_equipped: "clear" }, []);
  assert.deepEqual(fitted.variables[0]!.defaultValue, []);
  assert.deepEqual(fitted.variables[1]!.defaultValue, { weapon: null, accessory: null });
  assert.equal(fitted.variables[2]!.defaultValue, 20);
});

test("an in-story app that starts empty has nothing to fit", () => {
  assert.deepEqual(findPackCollections(bundle([v("app_relations", "App · Relationships", "json", { chars: {} })])), []);
});

test("a sample's own moment is dropped", () => {
  const b = bundle([v("npcs", "NPCs", "json", { aria: { name: "Aria", lastInteraction: { time: "Day 3", scene: "camp" } } })]);
  const cols = findPackCollections(b);
  const fitted = fitPackToCard(b, cols, { npcs: "characters" }, cardCharacters(card));
  assert.equal((fitted.variables[0]!.defaultValue as Record<string, Record<string, unknown>>).aqua!.lastInteraction, null);
});

test("a list one level inside a variable is found", () => {
  const b = bundle([v("app", "App", "json", { title: "x", cast: [{ name: "Aria", trust: 1 }] })]);
  const cols = findPackCollections(b);
  assert.equal(cols[0]!.key, "app.cast");
  const fitted = fitPackToCard(b, cols, { "app.cast": "characters" }, cardCharacters(card));
  const val = fitted.variables[0]!.defaultValue as { title: string; cast: Array<{ name: string; trust: number }> };
  assert.equal(val.title, "x");
  assert.deepEqual(val.cast.map((c) => [c.name, c.trust]), [["Aqua", 1], ["有马加奈", 1]]);
});

test("a pack's single values can point at the card's of the same kind", () => {
  const links = linkableVariables(inventory, card);
  assert.deepEqual(links.map((l) => [l.packVar.id, l.candidates.map((c) => c.id)]), [["inventory_capacity", ["money", "trustAqua"]]]);
});

// From real cards: everything filed as "character", people told apart by tag.
const onePiece = {
  entries: [
    entry({ name: "世界观：大航海时代", tags: ["世界观"], content: "这是一个属于海贼的时代。", position: 0 }),
    entry({ name: "输出控制", tags: ["输出控制"], content: "你是叙述者。", position: 1 }),
    entry({ name: "蒙奇·D·路飞 — 草帽船长", tags: ["角色", "主角"], position: 2, content: "## 蒙奇·D·路飞（Monkey D. Luffy）\n\n**身高**：172 cm　**年龄**：17→19岁\n**能力**：橡皮果实\n\n**人格核心**：\n路飞的世界里没有「不可能」这个词，因为他压根没时间想。他是一个用本能生活的人。\n\n**关于{{user}}**：\n路飞不会分析" }),
    entry({ name: "示例对话", tags: ["示例对话"], content: "{{user}}：「你真的不怕？」", position: 3 }),
    entry({ name: "罗罗亚·索隆 — 三刀流剑士", tags: ["角色"], section: "world-info" as never, position: 4, content: "## 罗罗亚·索隆（Roronoa Zoro）\n\n**身高**：178 cm\n**武器**：三刀流\n\n索隆是草帽团沉默的支柱。他不说废话。" }),
    entry({ name: "恶魔果实", tags: ["世界设定"], content: "## 恶魔果实\n\n恶魔果实是……", position: 5 }),
    entry({ name: "回复指引", tags: ["指引"], section: "post-history", content: "保持热血。", position: 6 }),
  ],
};
const oshi = {
  entries: [
    entry({ name: "文风指南：嘘と真実の間", tags: ["Style"], content: "## 文风指南", position: 0 }),
    entry({ name: "Aqua（星野愛久愛海）", tags: ["Character"], position: 1, content: "## アクア / 星野 愛久愛海\n\n身高172cm，男，苺Production演员，双胞胎哥哥\n外貌：继承母亲星野爱的面容" }),
    entry({ name: "有马加奈（Kana Arima）", tags: ["Character"], position: 2, content: "## 有馬 かな（Kana Arima）\n\n年龄17岁，身高150cm，女，前童星，现B小町成员\n\n### 核心矛盾\n她9岁被叫做天才。" }),
    entry({ name: "苺Production事务所", tags: ["World"], content: "## 苺Production", position: 3 }),
  ],
};

test("on real cards only the tagged people count, with their short names and first prose", () => {
  const op = cardCharacters(onePiece);
  assert.deepEqual(op.map((c) => c.name), ["蒙奇·D·路飞", "罗罗亚·索隆"]);
  assert.equal(op[0]!.description, "路飞的世界里没有「不可能」这个词，因为他压根没时间想。");
  assert.equal(op[1]!.description, "索隆是草帽团沉默的支柱。");
  const os = cardCharacters(oshi);
  assert.deepEqual(os.map((c) => c.name), ["Aqua", "有马加奈"]);
  assert.equal(os[0]!.key, "aqua");
  assert.equal(os[0]!.description, "身高172cm，男，苺Production演员，双胞胎哥哥");
});

test("untagged cards leave out entries named like setting, style or instructions", () => {
  const untagged = { entries: onePiece.entries.map((e) => ({ ...e, tags: [] })) };
  assert.deepEqual(cardCharacters(untagged).map((c) => c.name), ["蒙奇·D·路飞", "罗罗亚·索隆", "恶魔果实"]);
});

test("display names drop the epithet and the reading", () => {
  assert.equal(displayName("蒙奇·D·路飞 — 草帽船长"), "蒙奇·D·路飞");
  assert.equal(displayName("Aqua（星野愛久愛海）"), "Aqua");
  assert.equal(displayName("Jean-Luc Picard"), "Jean-Luc Picard");
  assert.equal(displayName("（无名）"), "（无名）");
});

test("the shape the docs teach authors fits, messages and all", () => {
  // docs/creator/advanced/publishing-deep.md#shareable-interface
  const taught = bundle([
    v("npcs", "NPCs", "json", {
      aria: { name: "Aria", bio: "A squire in the royal city", avatar: "A", affinity: 30 },
      ken: { name: "Ken", bio: "Runs the tavern", avatar: "K", affinity: 10 },
    }),
    v("messages", "Messages", "json", [{ from: "aria", text: "See you at noon" }]),
    v("items", "Items", "json", [{ name: "Potion", qty: 2 }]),
  ]);
  const found = findPackCollections(taught);
  assert.deepEqual(found.map((c) => [c.key, c.people, c.dependsOn ?? null]), [
    ["npcs", true, null],
    ["messages", false, "npcs"],
    ["items", false, null],
  ]);
  assert.equal(packTakesCharacters(taught), true);
  assert.equal(packTakesCharacters(inventory), false);
  assert.equal(packTakesCharacters({}), false);
  assert.equal(packTakesCharacters(null), false);
  // A things list named after whose things they are stays a sample list.
  const owned = findPackCollections(bundle([
    v("cast_items", "Items", "json", [{ name: "Potion", qty: 2 }]),
    v("npc_bag", "NPC bag", "json", { a: { name: "Rope" } }),
    v("party", "Party", "json", [{ name: "Aria", hp: 10 }]),
  ]));
  assert.deepEqual(owned.map((c) => [c.key, c.people]), [["cast_items", false], ["npc_bag", false], ["party", true]]);
});
