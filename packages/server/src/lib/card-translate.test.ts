import assert from "node:assert/strict";
import test from "node:test";
import { duplicatedParagraphs, fenceLooksLikeCode, protect, restore, translateCard, unitProblems, type ChatFn } from "./card-translate.js";
import { checkTsxRewrite, comparedValues, extractDisplayStrings, hasVisibleProse } from "./card-translate-tsx.js";

test("directives for known variables are protected and restore in any order", () => {
  const p = protect("She smiles. [mood: set \"happy\"] Then [gold: +5] and [notavar: x].", new Set(["mood", "gold"]));
  assert.equal(p.spans.length, 2);
  assert.ok(p.text.includes("[notavar: x]"));
  const t0 = `⟦K0${p.salt}⟧`, t1 = `⟦K1${p.salt}⟧`;
  const reordered = p.text.replace(t0, "@@").replace(t1, t0).replace("@@", t1);
  assert.ok(restore(reordered, p.spans, p.salt)?.includes('[mood: set "happy"]'));
  assert.equal(restore(p.text.replace(t1, ""), p.spans, p.salt), null);
  // a card that already contains token-like text is left alone
  const q = protect("Literal ⟦K0⟧ in the lore. [mood: set calm]", new Set(["mood"]));
  assert.equal(restore(q.text, q.spans, q.salt), "Literal ⟦K0⟧ in the lore. [mood: set calm]");
});

test("a repeated closing paragraph is caught even with one word left in English", () => {
  const text = "*她盯着你，仿佛你是从她噩梦里走出来的怪物。走廊似乎更冷了。空气紧绷。她的尾巴因恐惧而抽动，等着她认定 inevitable 的结局降临。*\n\n*她盯着你，仿佛你是从她噩梦里走出来的怪物。走廊似乎更冷了。空气紧绷。她的尾巴因恐惧而抽动，等着她认定无可避免的结局降临。*";
  assert.equal(duplicatedParagraphs(text).length, 1);
});

test("unit checks: placeholders, stray English in player-facing text, leftover Chinese", () => {
  const keep = new Set(["flat"]);
  assert.deepEqual(unitProblems("Hi {{user}}, you look tired today, said the girl at the door.", "{{user}}，你看起来很累。门口的女孩说。", "en", "zh", keep, true), []);
  assert.match(unitProblems("Hello {{user}} and {{char}}", "你好", "en", "zh", keep, false).join(), /placeholders/);
  assert.match(unitProblems("The bully who must be confronted.", "必须被 confront 的霸凌者。", "en", "zh", keep, true).join(), /stray English/);
  assert.deepEqual(unitProblems("Her ears are flat.", "她的耳朵是 flat（贴平）。", "en", "zh", keep, true), []);
  assert.match(unitProblems("她叫莉莉尔，是一名精灵。", "Her name is 莉莉尔, an elf.", "zh", "en", new Set(), true).join(), /untranslated Chinese/);
});

test("tsx: reordering a concatenation for word order is accepted", () => {
  const before = `export default function A(){ var day = 1; return <div title="Her ears">{'Brackenfield apartments · day ' + day}</div>; }`;
  const after = `export default function A(){ var day = 1; return <div title="她的耳朵">{'布莱肯菲尔德公寓 · 第' + day + '天'}</div>; }`;
  assert.deepEqual(checkTsxRewrite(before, after, new Set()), []);
});

test("tsx: changing a compared state value, a className or code is rejected", () => {
  const before = `function E(p){ return <span className="pi-ear pi-ear--flat">{p.state === 'flat' ? 'Pressed flat' : 'Up'}</span>; }`;
  assert.match(checkTsxRewrite(before, before.replace("=== 'flat'", "=== '贴平'"), new Set(["flat"])).join(), /compare|state value/);
  assert.match(checkTsxRewrite(before, before.replace('"pi-ear pi-ear--flat"', '"耳朵"'), new Set()).join(), /key literal/);
  assert.match(checkTsxRewrite(before, before.replace("p.state", "p.mood"), new Set()).join(), /code changed/);
  assert.deepEqual(checkTsxRewrite(before, before.replace("'Pressed flat'", "'紧贴'").replace("'Up'", "'竖起'"), new Set(["flat"])), []);
  assert.deepEqual(comparedValues(before), ["flat"]);
  assert.equal(hasVisibleProse(before, "en"), true);
  assert.equal(hasVisibleProse(`const c = "az-chat az-dock";`, "en"), false);
});

test("translateCard keeps ids, directives and state values, appends the Chinese directive reminder", async () => {
  const schema = {
    name: "Prey", description: "d",
    entries: [
      { id: "g", name: "Opening", role: "greeting", content: "Hello {{user}}. She is scared.", alwaysSend: true, keywords: [] },
      { id: "s", name: "Narrative Engine", role: "system", content: "Write in natural English. Update [ears: set flat] when calm.", alwaysSend: true, keywords: [] },
      { id: "l", name: "The Dorm", role: "lore", content: "The dorm is old and cold.", keywords: ["dorm"], matchWholeWords: true },
    ],
    variables: [{ id: "ears", name: "Her ears", type: "string", defaultValue: "flat", behaviorRules: "One word: flat or up." }],
    rules: [], settings: { greeting: "Hello {{user}}. She is scared.", playerName: "Player" },
    rootComponent: { entryFile: "index.tsx", files: { "index.tsx": `export default function R(){ var e = 'flat'; return <div title="Her ears">{e === 'flat' ? 'Pressed flat' : 'Up'}</div>; }` }, compiled: { code: "x", filesHash: "h", compilerVersion: 1 } },
  };
  const zh: Record<string, string> = {
    "meta.name": "猎物", "meta.description": "一只受惊的兔子，和你这个身为掠食者的室友。", "entry.0.name": "开场", "entry.0.content": "你好，{{user}}。她很害怕。",
    "entry.1.name": "叙事引擎", "entry.1.content": "用自然的简体中文写作。冷静时更新 TOKEN0。", "entry.2.name": "宿舍", "entry.2.content": "宿舍又旧又冷。",
    "var.0.name": "她的耳朵", "var.0.behaviorRules": "一个词：flat（贴平）或 up（竖起）。",
  };
  const chat: ChatFn = async (messages) => {
    const user = messages[messages.length - 1]!.content;
    if (messages[0]!.content.startsWith("You build a translation glossary")) return { text: '{"terms":{"Clover":"克洛弗","Vael Dominion":"维尔 Dominion? "}}', costUsd: 0.001, model: "m" };
    if (messages[0]!.content.startsWith("Lorebook entries")) return { text: '{"entry.2.keywords":["宿舍","dorm"]}', costUsd: 0.001, model: "m" };
    if (user.startsWith("File index.tsx")) return { text: "```tsx\n" + schema.rootComponent.files["index.tsx"].replace('"Her ears"', '"她的耳朵"').replace("'Pressed flat'", "'紧贴'").replace("'Up'", "'竖起'") + "\n```", costUsd: 0.002, model: "m" };
    const obj = JSON.parse(user.slice(user.indexOf("{")));
    // put back whatever salted token the translator sent in place of TOKEN0
    const tokenOf = (k: string) => String(obj[k] ?? "").match(/⟦K0[a-z0-9]*⟧/)?.[0] ?? "";
    return { text: JSON.stringify(Object.fromEntries(Object.keys(obj).map((k) => [k, (zh[k] ?? obj[k]).replace("TOKEN0", tokenOf(k))]))), costUsd: 0.003, model: "m" };
  };
  const r = await translateCard({ name: "Prey", description: "A scared rabbit and you, her predator roommate.", schema, sourceLang: "en", targetLang: "zh" }, chat);
  assert.deepEqual(r.report.issues, []);
  assert.equal(r.name, "猎物");
  assert.equal(r.schema.entries[1].content.includes("[ears: set flat]"), true);
  assert.equal(r.schema.entries[1].content.includes("## 状态指令（必须遵守）"), true);
  assert.equal(r.schema.settings.greeting, r.schema.entries[0].content);
  assert.equal(r.schema.settings.playerName, "你");
  assert.deepEqual(r.schema.entries[2].keywords, ["宿舍", "dorm"]);
  assert.equal(r.schema.entries[2].matchWholeWords, false);
  assert.equal(r.schema.variables[0].id, "ears");
  assert.equal(r.schema.variables[0].defaultValue, "flat");
  assert.ok(r.schema.rootComponent.files["index.tsx"].includes("=== 'flat'"));
  assert.ok(r.schema.rootComponent.files["index.tsx"].includes("她的耳朵"));
  assert.equal(r.schema.rootComponent.compiled, undefined);
  assert.equal(schema.rootComponent.compiled.code, "x", "input schema must not be mutated");
  assert.ok(r.report.costUsd > 0);
});

test("a unit every model refuses is reported as refused, with where it is, and counted", async () => {
  const schema = {
    entries: [
      { id: "g", name: "Opening", role: "greeting", content: "She waits for you at the door of the old house, nervous.", keywords: [] },
      { id: "l", name: "The Cellar", role: "lore", content: "The cellar holds what nobody in the village talks about.", keywords: [] },
    ],
    variables: [], rules: [], settings: {},
  };
  const chat: ChatFn = async (messages) => {
    const sys = messages[0]!.content, user = messages[messages.length - 1]!.content;
    if (sys.startsWith("You build a translation glossary")) return { text: '{"terms":{}}', costUsd: 0, model: "m" };
    if (user.includes("The cellar")) throw new Error("m: refused");
    const obj = JSON.parse(user.slice(user.indexOf("{")));
    return { text: JSON.stringify(Object.fromEntries(Object.keys(obj).map((k) => [k, k === "entry.1.name" ? "地窖" : "她紧张地在老房子门口等你，手指绞着衣角，不时朝街角张望。"]))), costUsd: 0, model: "m" };
  };
  const r = await translateCard({ name: "Old House", description: "A quiet village and a house that keeps a secret.", schema, sourceLang: "en", targetLang: "zh" }, chat);
  assert.equal(r.report.unitsRefused >= 1, true);
  const refused = r.report.problems.filter((p) => p.kind === "refused");
  assert.ok(refused.some((p) => p.field === "entry" && p.where === "地窖"));
  assert.equal(r.schema.entries[1]!.content, schema.entries[1]!.content, "a refused text stays in the original");
});

test("tsx fallback: only display strings are sent and put back; key-used values never move", async () => {
  const { extractDisplayStrings, applyDisplayStrings, checkTsxRewrite } = await import("./card-translate-tsx.js");
  const code = `const CLASSES = [{ name: 'Hero', blurb: 'The one everyone expected' }, { name: 'Rogue', blurb: "Quiet hands, loud debts" }];
export default function R(p) { const c = CLASSES.find((x) => x.name === p.cls); return <div title="Your class">{c.name === 'Hero' ? 'Chosen' : 'Unchosen'} <b>Status window</b></div>; }`;
  const items = extractDisplayStrings(code, "en", new Set(["unbeaten"]));
  const texts = items.map((i) => i.text);
  assert.ok(texts.includes("The one everyone expected") && texts.includes("Status window") && texts.includes("Your class"));
  assert.ok(!texts.includes("Hero") && !texts.includes("Rogue"), "names used as keys / comparisons are not sent");
  const zh: Record<string, string> = { "The one everyone expected": "所有人都料到的那个", "Quiet hands, loud debts": "手很轻，债很响", "Your class": "你的职业", "Chosen": "天选", "Unchosen": "落选", "Status window": "状态栏" };
  const next = applyDisplayStrings(code, items, Object.fromEntries(items.map((i) => [i.id, zh[i.text] ?? i.text])));
  assert.deepEqual(checkTsxRewrite(code, next, new Set()), []);
  assert.ok(next.includes("name: 'Hero'") && next.includes("=== 'Hero'") && next.includes("状态栏") && next.includes('"手很轻，债很响"'));
});

test("protect salt is stable for the same text, so a resumed job sends the same prompts", () => {
  const a = protect("Mood is [mood: set calm] now.", new Set(["mood"]));
  const b = protect("Mood is [mood: set calm] now.", new Set(["mood"]));
  assert.equal(a.salt, b.salt);
  assert.equal(a.text, b.text);
});

test("a fenced status template is prose; a fenced code sample stays as is", () => {
  assert.equal(fenceLooksLikeCode("```\n*Arousal 1% (She feels warm and tingly)\n*Inner thoughts: (I'm so nervous)\n```"), false);
  assert.equal(fenceLooksLikeCode("```\nMood: {{mood}} | Place: {{place}}\n```"), false);
  assert.equal(fenceLooksLikeCode("```json\n{\"hp\": 10}\n```"), true);
  assert.equal(fenceLooksLikeCode("```\nconst x = 1;\n```"), true);
  const p = protect("Status:\n```\n*Arousal 1% (warm)\n```\n```json\n{\"a\":1}\n```", new Set());
  assert.ok(p.text.includes("Arousal"));
  assert.ok(!p.text.includes("\"a\":1"));
});

test("translateCard leaves identifier and code-checked variable defaults alone", async () => {
  const record = { job: "Records Department clerk", household: "One resident. No dependants." };
  const schema = {
    name: "Unperson", description: "d",
    entries: [{ id: "s", name: "Engine", role: "system", content: "Narrate the morning in plain English.", alwaysSend: true, keywords: [] }],
    variables: [
      { id: "referee", name: "Referee model", type: "string", defaultValue: "google/gemini-3-flash-preview" },
      { id: "rooms", name: "Rooms", type: "string", defaultValue: "Bathroom=Empty;Kitchen=Empty" },
      { id: "roster", name: "Roster", type: "json", defaultValue: [{ slug: "baek-seo-rin", state: "Trainee, six evaluations deep, currently second" }] },
      { id: "record", name: "Record", type: "json", defaultValue: record },
    ],
    rules: [], settings: { greeting: "The screen wakes you before the bell does." },
    rootComponent: { entryFile: "index.tsx", files: { "index.tsx": `const R = Object.freeze({job:"Records Department clerk",household:"One resident. No dependants."}); export default function A(){ return <div>{R.job}</div>; }` } },
  };
  const chat: ChatFn = async (messages) => {
    const user = messages[messages.length - 1]!.content;
    if (messages[0]!.content.startsWith("You build a translation glossary")) return { text: '{"terms":{}}', costUsd: 0, model: "m" };
    if (user.startsWith("File index.tsx")) return { text: "```tsx\n" + schema.rootComponent.files["index.tsx"] + "\n```", costUsd: 0, model: "m" };
    const obj = JSON.parse(user.slice(user.indexOf("{")));
    return { text: JSON.stringify(Object.fromEntries(Object.keys(obj).map((k) => [k, `번역된 문장 ${k} 입니다`]))), costUsd: 0, model: "m" };
  };
  const r = await translateCard({ name: "Unperson", description: "A morning at the Ministry.", schema, sourceLang: "en", targetLang: "ko" }, chat);
  const v = Object.fromEntries(r.schema.variables.map((x: any) => [x.id, x.defaultValue]));
  assert.equal(v.referee, "google/gemini-3-flash-preview");
  assert.equal(v.rooms, "Bathroom=Empty;Kitchen=Empty");
  assert.equal(v.roster[0].slug, "baek-seo-rin");
  assert.match(v.roster[0].state, /번역된/);
  assert.deepEqual(v.record, record);
});

test("an Indonesian version keeps whole-word keywords on and names the player kamu", async () => {
  const schema = {
    name: "Prey", description: "d",
    entries: [{ id: "l", name: "The Dorm", role: "lore", content: "The dorm is old and cold.", keywords: ["dorm"], matchWholeWords: true }],
    variables: [], rules: [], settings: { greeting: "Hello {{user}}. She is scared.", playerName: "Player" },
  };
  const id: Record<string, string> = {
    "meta.name": "Mangsa", "meta.description": "Seekor kelinci yang ketakutan dan kamu, teman sekamarnya yang predator.",
    "entry.0.name": "Asrama", "entry.0.content": "Asrama itu tua dan dingin.", "settings.greeting": "Halo {{user}}. Dia ketakutan.",
  };
  let rules = "";
  const chat: ChatFn = async (messages) => {
    const user = messages[messages.length - 1]!.content;
    if (messages[0]!.content.startsWith("You build a translation glossary")) return { text: '{"terms":{}}', costUsd: 0, model: "m" };
    if (messages[0]!.content.startsWith("Lorebook entries")) return { text: '{"entry.0.keywords":["asrama","dorm"]}', costUsd: 0, model: "m" };
    rules = messages[0]!.content;
    const obj = JSON.parse(user.slice(user.indexOf("{")));
    return { text: JSON.stringify(Object.fromEntries(Object.keys(obj).map((k) => [k, id[k] ?? obj[k]]))), costUsd: 0, model: "m" };
  };
  const r = await translateCard({ name: "Prey", description: "A scared rabbit and you, her predator roommate.", schema, sourceLang: "en", targetLang: "id" }, chat);
  assert.deepEqual(r.report.issues, []);
  assert.equal(r.name, "Mangsa");
  assert.equal(r.schema.settings.playerName, "kamu");
  assert.deepEqual(r.schema.entries[0].keywords, ["asrama", "dorm"]);
  assert.equal(r.schema.entries[0].matchWholeWords, true);
  assert.match(rules, /into Indonesian/);
});

test("a Russian version turns whole-word keywords off, asks for stems and names the player ты", async () => {
  const schema = {
    name: "Prey", description: "d",
    entries: [{ id: "l", name: "The Witch", role: "lore", content: "The witch lives in the old dorm.", keywords: ["witch"], matchWholeWords: true }],
    variables: [], rules: [], settings: { greeting: "Hello {{user}}. She is scared.", playerName: "Player" },
  };
  const ru: Record<string, string> = {
    "meta.name": "Добыча", "meta.description": "Испуганная крольчиха и ты, её соседка-хищница.",
    "entry.0.name": "Ведьма", "entry.0.content": "Ведьма живёт в старом общежитии.", "settings.greeting": "Привет, {{user}}. Ей страшно.",
  };
  let rules = "", kwPrompt = "";
  const chat: ChatFn = async (messages) => {
    const user = messages[messages.length - 1]!.content;
    if (messages[0]!.content.startsWith("You build a translation glossary")) return { text: '{"terms":{}}', costUsd: 0, model: "m" };
    if (messages[0]!.content.startsWith("Lorebook entries")) { kwPrompt = messages[0]!.content; return { text: '{"entry.0.keywords":["ведьм","witch"]}', costUsd: 0, model: "m" }; }
    rules = messages[0]!.content;
    const obj = JSON.parse(user.slice(user.indexOf("{")));
    return { text: JSON.stringify(Object.fromEntries(Object.keys(obj).map((k) => [k, ru[k] ?? obj[k]]))), costUsd: 0, model: "m" };
  };
  const r = await translateCard({ name: "Prey", description: "A scared rabbit and you, her predator roommate.", schema, sourceLang: "en", targetLang: "ru" }, chat);
  assert.deepEqual(r.report.issues, []);
  assert.equal(r.name, "Добыча");
  assert.equal(r.schema.settings.playerName, "ты");
  assert.deepEqual(r.schema.entries[0].keywords, ["ведьм", "witch"]);
  assert.equal(r.schema.entries[0].matchWholeWords, false);
  assert.match(rules, /into Russian/);
  assert.match(kwPrompt, /stem/);
});

test("a Russian source keeps its Cyrillic state values and flags Russian left untranslated", async () => {
  const schema = {
    name: "Кафе", description: "d",
    entries: [{ id: "s", name: "Правила", role: "system", content: "Пиши от третьего лица. Настроение Лены сейчас: Спокойна.", alwaysSend: true, keywords: [] }],
    variables: [{ id: "mood", name: "Настроение", type: "string", defaultValue: "Спокойна", behaviorRules: "Ставь Спокойна, пока Лену никто не злит." }],
    rules: [{ id: "r", name: "Злость", conditions: [{ variableId: "mood", operator: "eq", value: "Спокойна" }], actions: [] }],
    settings: { greeting: "Лена протирает стойку и улыбается тебе." },
  };
  let rules = "";
  const chat: ChatFn = async (messages) => {
    const user = messages[messages.length - 1]!.content;
    if (messages[0]!.content.startsWith("You build a translation glossary")) return { text: '{"terms":{"Лена":"Lena"}}', costUsd: 0, model: "m" };
    rules = messages[0]!.content;
    const obj = JSON.parse(user.slice(user.indexOf("{")));
    return { text: JSON.stringify(Object.fromEntries(Object.keys(obj).map((k) => [k, k === "var.0.behaviorRules" ? "Set Спокойна (calm) while nobody angers Lena." : `Translated text for ${k}, written in plain English.`]))), costUsd: 0, model: "m" };
  };
  const r = await translateCard({ name: "Кафе", description: "Тихое кафе у моря, где работает Лена.", schema, sourceLang: "ru", targetLang: "en" }, chat);
  assert.match(rules, /from Russian into English/);
  assert.match(rules, /state values the game code checks: [^\n]*Спокойна/);
  assert.equal(r.schema.variables[0].defaultValue, "Спокойна");
  assert.deepEqual(unitProblems("Лена протирает стойку и улыбается тебе.", "Lena wipes the стойку and smiles at you.", "ru", "en", new Set(), true), ["untranslated Russian: стойку"]);
});

// --- Russian batch, 2026-11-21 ---------------------------------------------------------------

test("glosses: a source word with its translation in parentheses is found and stripped; a bracket the source wrote is not", async () => {
  const { glosses, stripGlosses } = await import("./card-translate.js");
  const src = "A girl with long silver-green hair. Brother (executed).";
  const out = "Девушка с длинными silver-green (серебристо-зелёными) волосами. Брат (казнён).";
  assert.deepEqual(glosses(src, out, "en", "ru").map((g) => g.word), ["silver-green"]);
  assert.equal(stripGlosses(src, out, "en", "ru"), "Девушка с длинными серебристо-зелёными волосами. Брат (казнён).");
  assert.equal(stripGlosses("flat back", "flat (прижаты) back (назад)", "en", "ru"), "прижаты назад");
  assert.equal(stripGlosses("The purple-haired girl's voice is flat.", "Голос девушки (purple-haired) звучит ровно.", "en", "ru"), "Голос девушки звучит ровно.");
  assert.equal(stripGlosses("The purple-haired girl nods.", "purple-haired (фиолетоволосая) девушка кивает.", "en", "ru"), "Фиолетоволосая девушка кивает.");
  // Latin to Latin: only a code value counts, so an ordinary remark in brackets stays
  assert.equal(stripGlosses("Her ears are flat.", "Sus orejas están flat (planas).", "en", "es", new Set(["flat"])), "Sus orejas están planas.");
  assert.equal(stripGlosses("Marta smiles.", "Marta (la vecina) sonríe.", "en", "es", new Set(["flat"])), "Marta (la vecina) sonríe.");
});

const EARS_CODE = `export type EarState = 'flat' | 'half' | 'up';
export function earState(s) { if (s.indexOf('back') >= 0) return 'flat'; if (s.indexOf('half') >= 0) return 'half'; if (s.indexOf('up') >= 0) return 'up'; return 'flat'; }
export var EAR_WORD = { flat: 'flat back', half: 'half up', up: 'all the way up' };
export default function Ears({ state }) { return <div title="Her ears">{EAR_WORD[state]} <span>Pressed to her skull. She thinks you might bite.</span></div>; }`;

test("interface fallback uses interface rules, not the prose state-value rule, and never ships a gloss", async () => {
  const schema = {
    name: "Prey", description: "d",
    entries: [{ id: "g", name: "Opening", role: "greeting", content: "A girl with long silver-green hair watches you from the corner, ears flat back.", keywords: [] }],
    variables: [{ id: "ears", name: "Her ears", type: "string", defaultValue: "flat", behaviorRules: "Exactly one word: flat, half or up." }],
    rules: [], settings: {},
    rootComponent: { entryFile: "features.tsx", files: { "features.tsx": EARS_CODE + `\nexport const HAIR = (t) => t.includes("silver-green");` } },
  };
  const ru: Record<string, string> = {
    "meta.name": "Добыча", "meta.description": "Испуганная крольчиха и ты, её сосед-хищник.", "entry.0.name": "Начало",
    "entry.0.content": "Девушка с длинными silver-green (серебристо-зелёными) волосами смотрит на тебя из угла, уши прижаты.",
    "var.0.name": "Её уши", "var.0.behaviorRules": "Ровно одно слово: flat (прижаты), half (наполовину) или up (подняты).",
  };
  const uiRu: Record<string, string> = { "flat back": "flat (прижаты) back (назад)", "half up": "half (наполовину) up (вверх)", "all the way up": "all the way up (вверх до конца)", "Her ears": "Её уши", "Pressed to her skull. She thinks you might bite.": "Прижаты к черепу. Она думает, что ты укусишь." };
  let uiSystem = "", proseRulesSeen = "", repairAsked = "";
  const chat: ChatFn = async (messages) => {
    const sys = messages[0]!.content, user = messages[messages.length - 1]!.content;
    if (sys.startsWith("You build a translation glossary")) return { text: '{"terms":{}}', costUsd: 0, model: "m" };
    // the whole-file rewrite keeps touching a compared value
    if (user.startsWith("File features.tsx")) return { text: "```tsx\n" + schema.rootComponent.files["features.tsx"].replace("indexOf('back')", "indexOf('назад')") + "\n```", costUsd: 0, model: "m" };
    const obj = JSON.parse(user.slice(user.indexOf("{")));
    if (sys.startsWith("You translate the visible texts of a game's interface")) {
      uiSystem = sys;
      return { text: JSON.stringify(Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, uiRu[v as string] ?? v]))), costUsd: 0, model: "m" };
    }
    proseRulesSeen = sys;
    if (user.startsWith("A previous translation")) repairAsked = user;
    return { text: JSON.stringify(Object.fromEntries(Object.keys(obj).map((k) => [k, ru[k] ?? obj[k]]))), costUsd: 0, model: "m" };
  };
  const r = await translateCard({ name: "Prey", description: "A scared rabbit girl and you, her predator roommate.", schema, sourceLang: "en", targetLang: "ru" }, chat);
  assert.ok(uiSystem, "the string pass ran");
  assert.doesNotMatch(uiSystem, /state values the game code checks/);
  assert.match(uiSystem, /never add a translation or explanation in parentheses/);
  const code = r.schema.rootComponent.files["features.tsx"];
  assert.ok(code.includes("{ flat: 'прижаты назад', half: 'наполовину вверх', up: 'вверх до конца' }"), code);
  assert.ok(code.includes("indexOf('back')") && code.includes("'flat'"), "compared values untouched");
  assert.deepEqual(r.report.tsxPartial, ["features.tsx"]);
  // prose: the rule keeps values only where the narrator is told what to write, and an opening never ships a gloss
  assert.match(proseRulesSeen, /Only where the text tells the narrator which value to write or set/);
  assert.match(repairAsked, /glossed: "silver-green \(серебристо-зелёными\)"/);
  assert.equal(r.schema.entries[0].content, "Девушка с длинными серебристо-зелёными волосами смотрит на тебя из угла, уши прижаты.");
  // a narrator instruction may keep "flat (прижаты)": the code needs the value there
  assert.match(r.schema.variables[0].behaviorRules, /flat \(прижаты\)/);
});

const STR_TABLE = `// ── STR:BEGIN ──
const STR: any = {
 "lang": "en",
 "fonts": "",
 "ui": { "begin": "Begin the story", "keepPlaying": "Keep playing", "endN": "{n} of 5 endings discovered" },
 "gifts": { "rose": { "name": "Black Rose", "desc": "A rose that never wilts" }, "quill": { "name": "Sugar Quill", "desc": "Sweet enough to forgive anything" } },
 "stage": { "Nemesis": "Nemesis", "Rival": "Rival" },
 "tapSpam": ["Stop poking me.", "Seriously, stop it."]
};
// ── STR:END ──`;
const STR_CODE = `const LANG = "en";
${STR_TABLE}
const GIFTS = ["rose", "quill"].map((id) => ({ id, ...STR.gifts[id] }));
export default function R({ variables }) { const s = variables.stage === "Nemesis" ? STR.stage["Nemesis"] : STR.stage["Rival"]; return <div lang={LANG === "en" ? undefined : LANG}><b>{STR.ui.begin}</b>{GIFTS.map((g) => <i key={g.id}>{g.name}</i>)}{s}</div>; }`;

test("a STR string table is translated (names included, keys and ids untouched) and LANG follows; a file too big for one rewrite goes straight to the string pass", async () => {
  const big = "// " + "padding ".repeat(8000) + "\n" + STR_CODE; // over the whole-file limit
  const schema = {
    name: "Draco", description: "d",
    entries: [{ id: "l", name: "Lore", role: "lore", content: "Hogwarts, sixth year.", keywords: [] }],
    variables: [{ id: "stage", name: "Stage", type: "string", defaultValue: "Nemesis", options: ["Nemesis", "Rival"] }],
    rules: [], settings: {},
    rootComponent: { entryFile: "index.tsx", files: { "index.tsx": big } },
  };
  const uiRu: Record<string, string> = {
    "Begin the story": "Начать историю", "Keep playing": "Играть дальше", "{n} of 5 endings discovered": "Открыто концовок: {n} из 5",
    "Black Rose": "Чёрная роза", "A rose that never wilts": "Роза, которая никогда не вянет", "Sugar Quill": "Сахарное перо", "Sweet enough to forgive anything": "Так сладко, что простишь что угодно",
    "Stop poking me.": "Хватит в меня тыкать.", "Seriously, stop it.": "Серьёзно, прекрати.",
  };
  let wholeFileCalls = 0, stringCalls = 0;
  const chat: ChatFn = async (messages) => {
    const sys = messages[0]!.content, user = messages[messages.length - 1]!.content;
    if (sys.startsWith("You build a translation glossary")) return { text: '{"terms":{}}', costUsd: 0, model: "m" };
    if (user.startsWith("File index.tsx")) { wholeFileCalls++; throw new Error("m: finish_reason length"); }
    const obj = JSON.parse(user.slice(user.indexOf("{")));
    if (sys.startsWith("You translate the visible texts of a game's interface")) {
      stringCalls++;
      // more than four texts in one answer runs into the output cap: the batch must be split, not dropped
      if (Object.keys(obj).length > 4) throw new Error("m: finish_reason length");
      return { text: JSON.stringify(Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, uiRu[v as string] ?? v]))), costUsd: 0, model: "m" };
    }
    return { text: JSON.stringify(Object.fromEntries(Object.keys(obj).map((k) => [k, k === "entry.0.content" ? "Хогвартс, шестой курс." : k === "entry.0.name" ? "Лор" : k === "var.0.name" ? "Стадия" : k.startsWith("meta.") ? "Драко Малфой: история" : obj[k]]))), costUsd: 0, model: "m" };
  };
  const r = await translateCard({ name: "Draco", description: "Sixth year at Hogwarts with Draconia Malfoy.", schema, sourceLang: "en", targetLang: "ru" }, chat);
  assert.equal(wholeFileCalls, 0, "no whole-file rewrite for a file over the limit");
  assert.ok(stringCalls >= 3, "the string pass ran in split batches");
  const code: string = r.schema.rootComponent.files["index.tsx"];
  for (const ru of ["Начать историю", "Открыто концовок: {n} из 5", "Чёрная роза", "Сахарное перо", "Хватит в меня тыкать."]) assert.ok(code.includes(ru), ru);
  assert.ok(code.includes('"stage": { "Nemesis": "Nemesis", "Rival": "Rival" }'), "values the code compares stay");
  assert.ok(code.includes('const LANG = "ru";') && code.includes('"lang": "ru"'), "LANG follows the table");
  assert.ok(code.includes('LANG === "en"') && code.includes('variables.stage === "Nemesis"') && code.includes('"rose"'));
  assert.deepEqual(r.report.tsxKeptOriginal, []);
  assert.deepEqual(r.report.tsxPartial, ["index.tsx"]);
});

test("a per-language table: only the source language's texts are translated, in place; LANG stays", async () => {
  const { extractDisplayStrings, applyDisplayStrings, checkTsxRewrite, retargetLang } = await import("./card-translate-tsx.js");
  const code = `const LANG = "en";
const T = { en: { hello: "Welcome back, traveler", bye: "See you tomorrow night", gift: "A small gift for you", n: "No new letters today", ok: "Close the window", go: "Go to the tower" },
  es: { hello: "Bienvenido de nuevo, viajero", bye: "Hasta mañana por la noche", gift: "Un pequeño regalo", n: "No hay cartas nuevas", ok: "Cerrar la ventana", go: "Ir a la torre" } };
export default function R() { return <div>{T[LANG].hello}</div>; }`;
  const items = extractDisplayStrings(code, "en", new Set());
  assert.equal(items.length, 6);
  assert.ok(items.every((i) => !/Bienvenido|Hasta/.test(i.text)));
  const next = applyDisplayStrings(code, items, Object.fromEntries(items.map((i) => [i.id, "Ж " + i.id])));
  assert.deepEqual(checkTsxRewrite(code, next, new Set()), []);
  assert.ok(next.includes('"Bienvenido de nuevo, viajero"'));
  assert.equal(retargetLang(next, "en", "ru"), next, "T[LANG] has no ru branch: LANG is left alone");
});

test("a reply cut off at the output cap is recognised as truncation (the regex held backspace bytes, so batches never split)", async () => {
  const { isTruncation } = await import("./card-translate.js");
  assert.equal(isTruncation("x-ai/grok-4.3: 200 length"), true);
  assert.equal(isTruncation("deepseek: truncated"), true);
  assert.equal(isTruncation("m: refused"), false);
  assert.equal(isTruncation("m: lengthy error"), false);
});

// --- DanMachi, Russian, 2026-11-21 ----------------------------------------------------------

const PIN_CODE = `export default function M({ pins, here, ask, floor }) {
  var cls = "dm-fl" + (floor === here ? " here" : "") + (floor > 3 ? " deep" : "");
  return <div className={cls}>
    {pins.map((p) => <button key={p.id} className={"dmm-pin" + (p.id === here ? " here" : "") + (ask === p.id ? " ask" : "")} title={p.name}>{p.name}</button>)}
    <span className={clsx("dm-boss", { up: floor > 1 }, floor > 9 && " danger zone")}>Floor {floor} — the Dungeon breathes</span>
    <i style={{ border: "1px solid rgba(0,0,0,.2)" }} onClick={() => document.querySelector(".dm-panel open")?.classList.toggle("dm-shown big")}>Open the map</i>
    <b className={pinClass(floor)}>{floor} {floor === 1 ? "day" : " days"} left</b>
  </div>;
}
function pinClass(f) { return f > 9 ? "dm-x deep down" : "dm-x shallow up"; }
const CSS = ".dm-fl.here { color: gold } .dm-fl.deep { opacity: .5 }";`;

test("class names built in ternaries, class variables, clsx, classList, selectors and styles are never sent for translation", () => {
  const texts = extractDisplayStrings(PIN_CODE, "en", new Set()).map((d) => d.text);
  for (const cls of [" here", " deep", " ask", " danger zone", "1px solid rgba(0,0,0,.2)", ".dm-panel open", "dm-shown big", "dm-x deep down", "dm-x shallow up", ".dm-fl.here { color: gold } .dm-fl.deep { opacity: .5 }"]) assert.ok(!texts.includes(cls), `class literal sent: ${JSON.stringify(cls)}`);
  for (const shown of ["the Dungeon breathes", "Open the map", " days"]) assert.ok(texts.some((t) => t.includes(shown)), `display text missing: ${shown}`);
  // a whole-file rewrite that translates a modifier is rejected
  assert.match(checkTsxRewrite(PIN_CODE, PIN_CODE.replace('" here" : "") + (ask', '" здесь" : "") + (ask'), new Set()).join(), /key literal changed:  here/);
});

test("lorebook keywords go out in batches; a failed batch keeps its own source keywords and the rest are translated", async () => {
  const entries = Array.from({ length: 100 }, (_, i) => ({ id: `e${i}`, name: `Place ${i}`, role: "lore", content: `Place number ${i} is a quiet spot.`, keywords: [`place${i}`] }));
  const schema = { name: "Big", description: "d", entries, variables: [], rules: [], settings: {} };
  const kwCalls: string[][] = [];
  const chat: ChatFn = async (messages) => {
    const sys = messages[0]!.content, user = messages[messages.length - 1]!.content;
    if (sys.startsWith("You build a translation glossary")) return { text: '{"terms":{}}', costUsd: 0, model: "m" };
    const obj = JSON.parse(user.slice(user.indexOf("{")));
    if (sys.startsWith("Lorebook entries")) {
      kwCalls.push(Object.keys(obj));
      if (obj["entry.0.keywords"]) throw new Error("m: 500 provider error");
      return { text: JSON.stringify(Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, [`местечко${k.split(".")[1]}`, ...(v as string[])]]))), costUsd: 0, model: "m" };
    }
    return { text: JSON.stringify(Object.fromEntries(Object.keys(obj).map((k) => [k, k.endsWith(".content") ? `Местечко${k.split(".")[1]}: тихий уголок.` : `Место ${k}`]))), costUsd: 0, model: "m" };
  };
  const r = await translateCard({ name: "Big", description: "A big card with a hundred places to visit.", schema, sourceLang: "en", targetLang: "ru" }, chat);
  assert.ok(kwCalls.length >= 3, `keyword calls: ${kwCalls.length}`);
  assert.ok(kwCalls.every((c) => c.length <= 40));
  assert.deepEqual(r.schema.entries[0].keywords, ["place0"]);
  assert.deepEqual(r.schema.entries[99].keywords, ["местечко99", "place99"]);
  assert.ok(r.report.warnings.some((w) => /keyword translation failed for 40 of 100/.test(w)), r.report.warnings.join(" | "));
});

test("pin notes name only values a rule writes as values, not every code-scanned word it uses", async () => {
  const code = `export default function P({ variables: v }) { var loc = String(v.scene_tag); var deep = loc.indexOf("floor") >= 0 || loc.indexOf("next") >= 0 || loc.indexOf("where") >= 0; return <div>{v.mood === "calm" ? "Calm here" : v.mood === "tense" ? "Tense now" : v.mood === "danger" ? "Danger ahead" : ""}{v.scene === "rite" ? "The rite begins" : deep ? "Deep in the Dungeon" : "On the surface"}</div>; }`;
  const schema = {
    name: "D", description: "d",
    entries: [{ id: "s", name: "Rules", role: "system", content: "Narrate the Dungeon.", alwaysSend: true, keywords: [] }],
    variables: [
      { id: "mood", name: "Mood", type: "string", defaultValue: "calm", behaviorRules: "The scene's feeling: calm, tense or danger. Pick the one that fits where the player is." },
      { id: "scene", name: "Scene", type: "string", defaultValue: "", behaviorRules: "Empty on the surface. Never write rite yourself." },
      { id: "goal", name: "Goal", type: "number", defaultValue: 0, behaviorRules: "The target floor the player set; the next floor down is where they go. When they reach it, set scene to rite." },
      { id: "volume", name: "Volume", type: "number", defaultValue: 0, behaviorRules: "Mind the off-by-one: reaching a floor is never a reason to turn the volume; it moves on to the next one only at the volume's end." },
    ],
    rules: [], settings: { greeting: "You stand at the top of the Dungeon, wondering where to go next." },
    rootComponent: { entryFile: "p.tsx", files: { "p.tsx": code } },
  };
  // the model translates everything, values included
  const ru: Record<string, string> = {
    "var.0.behaviorRules": "Чувство сцены: спокойствие, напряжение или опасность. Выбирай то, что подходит месту, где находится игрок.",
    "var.1.behaviorRules": "Пусто на поверхности. Никогда не пиши обряд сам.",
    "var.2.behaviorRules": "Целевой этаж, заданный игроком; следующий этаж вниз — куда он идёт. Когда он его достигнет, поставь scene в обряд.",
    "var.3.behaviorRules": "Осторожно со сдвигом на единицу: достижение этажа никогда не повод менять том; он переходит к следующему только в конце тома.",
  };
  const chat: ChatFn = async (messages) => {
    const sys = messages[0]!.content, user = messages[messages.length - 1]!.content;
    if (sys.startsWith("You build a translation glossary")) return { text: '{"terms":{}}', costUsd: 0, model: "m" };
    if (user.startsWith("File ")) return { text: "no", costUsd: 0, model: "m" };
    const obj = JSON.parse(user.slice(user.indexOf("{")));
    return { text: JSON.stringify(Object.fromEntries(Object.keys(obj).map((k) => [k, ru[k] ?? (String(obj[k]).length > 40 ? "Длинный текст про подземелье и игрока, переведённый полностью." : "Текст")]))), costUsd: 0, model: "m" };
  };
  const r = await translateCard({ name: "D", description: "A dungeon card where the player dives into the depths.", schema, sourceLang: "en", targetLang: "ru" }, chat);
  const rules = r.schema.variables.map((v: any) => String(v.behaviorRules));
  const note = /Код карточки сравнивает эти значения буквально[^:]*: ([^\n]*)\.$/;
  // the listed values of a string variable are pinned
  assert.deepEqual(rules[0].match(note)?.[1].split(", ").sort(), ["calm", "danger", "tense"]);
  // a number variable: only the value it gives another variable ("set scene to rite"), not floor / next
  assert.equal(rules[2].match(note)?.[1], "rite");
  // ordinary words the code happens to scan for (off, floor, next) never get pinned
  assert.doesNotMatch(rules[3], note);
});

test("variable ids and JSON field names never enter the glossary (Indonesian DanMachi: title -> judul, gear -> perlengkapan)", async () => {
  const schema = {
    name: "D", description: "d",
    entries: [{ id: "s", name: "Rules", role: "system", content: "The falna holds title and gear. Hestia reads it.", alwaysSend: true, keywords: [] }],
    variables: [{ id: "falna", name: "Falna", type: "json", defaultValue: { lv: 1, title: "", gear: "" }, behaviorRules: "Holds lv, title (epithet) and gear. Write gear when equipment changes." }],
    rules: [], settings: {},
  };
  let rules = "";
  const chat: ChatFn = async (messages) => {
    const sys = messages[0]!.content, user = messages[messages.length - 1]!.content;
    if (sys.startsWith("You build a translation glossary")) return { text: '{"terms":{"title":"judul","gear":"perlengkapan","falna":"falna","Hestia":"Hestia","Sword Princess":"Putri Pedang"}}', costUsd: 0, model: "m" };
    if (!user.startsWith("A previous")) rules = sys;
    const obj = JSON.parse(user.slice(user.indexOf("{")));
    return { text: JSON.stringify(Object.fromEntries(Object.keys(obj).map((k) => [k, `Teks terjemahan untuk ${k}, ditulis dalam bahasa Indonesia yang wajar.`]))), costUsd: 0, model: "m" };
  };
  await translateCard({ name: "D", description: "A dungeon card where the player dives into the depths.", schema, sourceLang: "en", targetLang: "id" }, chat);
  const glossary = rules.match(/glossary for names and terms, consistently: (\{.*\})/)?.[1] ?? "";
  assert.match(glossary, /Putri Pedang/);
  assert.doesNotMatch(glossary, /judul|perlengkapan/);
});
