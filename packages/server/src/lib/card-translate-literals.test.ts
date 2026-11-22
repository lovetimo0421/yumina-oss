import assert from "node:assert/strict";
import test from "node:test";
import { cardLiterals, isFormatPattern, lostPatterns, lostValues, restoreMarkers, valueNote } from "./card-translate-literals.js";
import { checkTsxRewrite, comparedValues } from "./card-translate-tsx.js";
import { translateCard, type ChatFn } from "./card-translate.js";

const CODE = `const EMOTION_ASSETS = { "Neutral": "@asset:n", "Irritated": "@asset:i" };
const moodColors = { Smug: "#6aa0c8", Scheming: "#5a8ab0", "Playing Innocent": "#e0c46a" };
const PORTRAITS = { BROOKE: { smile: "@asset:b1", angry: "@asset:b2" } };
function parseStatus(raw) { return raw.match(/\`\`\`[\\s\\S]*?\\[Status Panel\\]([\\s\\S]*?)\`\`\`/i); }
function speaker(line) { return line.match(/^(?:【Bella】|\\[Bella\\])\\s*([\\s\\S]*)$/); }
function face(t) { return t.match(/<face>\\s*([a-z_]+)\\s*<\\/face>/i); }
function mood(t) { return /blush|shy|arous/.test(t); }
export default function R({ variables: v }) { const night = v.scene.indexOf("Bath") >= 0; return <div title="Mood">{v.mode === "duel" ? "Duel" : EMOTION_ASSETS[v.e]}</div>; }`;

test("literals: lookup-map keys, scans, options, JSON keys and format patterns; prose keyword lists are not formats", () => {
  const lit = cardLiterals({
    rootComponent: { files: { "index.tsx": CODE } },
    variables: [{ id: "loc", type: "string", options: ["Lobby", "Hotel Room"] }, { id: "world", type: "json", defaultValue: { goals: [], threats: [] } }],
    rules: [{ conditions: [{ variableId: "loc", value: "Spa" }] }],
  });
  for (const k of ["Neutral", "Smug", "Playing Innocent", "BROOKE", "smile", "goals", "threats"]) assert.ok(lit.keys.has(k), k);
  for (const v of ["Bath", "duel", "Lobby", "Hotel Room", "Spa"]) assert.ok(lit.values.has(v), v);
  const srcs = lit.patterns.map((p) => p.src).join("\n");
  assert.match(srcs, /Status Panel/);
  assert.match(srcs, /Bella/);
  assert.match(srcs, /face/);
  assert.doesNotMatch(srcs, /blush/);
  assert.equal(isFormatPattern("\\b(blush|shy|arous)\\b"), false);
  assert.equal(isFormatPattern("^【System Notice\\s*(.+?)】"), true);
});

test("lost values count only list / quoted / id-like mentions, not a name in prose", () => {
  const src = "Calm, Wary, Aroused, Tender. She is Calm by default.";
  assert.deepEqual(lostValues(src, "차분함, 경계, 흥분, 다정함.", ["Calm", "Wary", "Aroused", "Tender"]).sort(), ["Aroused", "Calm", "Tender", "Wary"]);
  assert.deepEqual(lostValues("Brooke smiles at you across the hall.", "브룩이 복도 너머로 미소 짓는다.", ["Brooke"]), []);
  assert.deepEqual(lostValues("Set it to \"hotel_room\" when they arrive.", "도착하면 \"hotel_room\"으로 설정한다.", ["hotel_room"]), []);
});

test("restore: speaker tags, tag ids, CJK quotes, a dropped fence and a looked-up label value come back; the words stay translated", () => {
  const lit = cardLiterals({ rootComponent: { files: { "index.tsx": CODE + `\nfunction q(l){ return l.match(/^(.{1,10})[：:]\\s*「(.+?)」/); }` } } });
  const src = "```\n[Status Panel]\nEmotion: Neutral.\nPlace: the woods.\n```\n【Bella】Oh my, the hero is awake.\n<face>surprised</face>“Hello!”\nTsunade: 「We're out of time.」";
  const out = "[Status Panel]\nEmotion: 중립.\nPlace: 숲.\n```\n【벨라】어머, 용사님이 깨어나셨네.\n<표정>놀람</표정>“안녕하세요!”\n츠나데: “시간이 없어.”";
  assert.ok(lostPatterns(src, out, lit.patterns, true).length >= 3);
  // lines no longer align (the fence line is gone), so the fence comes back first, then line by line
  const r = restoreMarkers(src, out, lit, true);
  assert.ok(r.text.startsWith("```\n[Status Panel]\nEmotion: Neutral."), r.text);
  const again = restoreMarkers(src, r.text, lit, true).text;
  assert.match(again, /^【Bella】어머, 용사님이 깨어나셨네\.$/m);
  assert.match(again, /^<face>surprised<\/face>“안녕하세요!”$/m);
  assert.match(again, /^츠나데: 「시간이 없어\.」$/m);
  assert.deepEqual(lostPatterns(src, again, lit.patterns, true), []);
});

test("restore leaves an instruction line alone when the pattern names no marker", () => {
  const lit = cardLiterals({ rootComponent: { files: { "a.tsx": "const m = (s) => s.match(/^([A-Za-z -]+):\\s*(.+)$/);" } } });
  const src = "Availability and player knowledge: met at the gate.";
  const out = "등장 시점과 플레이어 지식: 문에서 만났다.";
  assert.equal(restoreMarkers(src, out, lit, false).text, out);
});

test("tsx: a translated scan value or a rewritten regex is rejected", () => {
  const before = `export function f(recent){ if (recent.includes("Critical")) return 5; return /^【Bella】/.test(recent) ? 1 : 0; }`;
  assert.match(checkTsxRewrite(before, before.replace('"Critical"', '"심각"'), new Set()).join(), /compare literal changed/);
  assert.match(checkTsxRewrite(before, before.replace("【Bella】", "【벨라】"), new Set()).join(), /regex changed/);
  assert.ok(comparedValues(before).includes("Critical"));
});

test("directives for hyphenated variable ids are protected too", async () => {
  const { protect, restore } = await import("./card-translate.js");
  const p = protect("She opens the door.\n[current-scene: set Purification Room]\n[visit-count: add 1]", new Set(["current-scene", "visit-count"]));
  assert.equal(p.spans.length, 2);
  assert.ok(!p.text.includes("Purification Room"));
  assert.equal(restore(p.text, p.spans, p.salt), "She opens the door.\n[current-scene: set Purification Room]\n[visit-count: add 1]");
});

test("value note is in the target language", () => {
  assert.match(valueNote("ko", ["Smug", "Calm"]), /원문 표기 그대로 쓴다: Smug, Calm\./);
  assert.match(valueNote("id", ["Lobby"]), /seperti aslinya: Lobby\./);
  assert.match(valueNote("ru", ["Lobby"]), /как в оригинале: Lobby\./);
});

test("translateCard: a model that translates markers and mood values gets them restored and pinned", async () => {
  const code = `const MOOD = { Smug: "@asset:a", Calm: "@asset:b" };
export default function R({ messages, variables }) { const t = String(messages?.[0] ?? ""); const m = t.match(/^【(?:Bella|Luna)】/m); return <div title="Mood">{m ? MOOD[variables.mood] : null}</div>; }`;
  const schema = {
    name: "Witches", description: "d",
    entries: [
      { id: "g", name: "Opening", role: "greeting", content: "【Bella】Oh my, the hero is finally awake.\n【Luna】I am right here too, hero dear.", keywords: [] },
      { id: "s", name: "Format", role: "system", content: "Start every line of a witch's speech with her tag, 【Bella】 or 【Luna】, then the words.", alwaysSend: true, keywords: [] },
    ],
    variables: [{ id: "mood", name: "Mood", type: "string", defaultValue: "Calm", behaviorRules: "Exactly one of: Smug, Calm. Smug when she is winning the argument." }],
    rules: [], settings: {},
    rootComponent: { entryFile: "index.tsx", files: { "index.tsx": code } },
  };
  const ko: Record<string, string> = {
    "meta.name": "마녀들", "meta.description": "두 마녀와 용사의 이야기를 다루는 카드입니다.",
    "entry.0.name": "오프닝", "entry.0.content": "【벨라】어머, 용사님이 드디어 깨어나셨네요.\n【루나】저도 여기 있어요, 용사님.",
    "entry.1.name": "형식", "entry.1.content": "마녀의 대사는 매 줄 그녀의 태그 【벨라】 또는 【루나】로 시작하고, 그다음 말을 쓴다.",
    "var.0.name": "기분", "var.0.behaviorRules": "정확히 하나: 잘난척, 차분함. 말싸움에서 이기고 있을 때는 잘난척.",
  };
  let rules = "";
  const chat: ChatFn = async (messages) => {
    const sys = messages[0]!.content, user = messages[messages.length - 1]!.content;
    if (sys.startsWith("You build a translation glossary")) return { text: '{"terms":{"Bella":"벨라","Luna":"루나"}}', costUsd: 0, model: "m" };
    if (user.startsWith("File index.tsx")) return { text: "```tsx\n" + code + "\n```", costUsd: 0, model: "m" };
    rules = sys;
    const obj = JSON.parse(user.slice(user.indexOf("{")));
    return { text: JSON.stringify(Object.fromEntries(Object.keys(obj).map((k) => [k, ko[k] ?? obj[k]]))), costUsd: 0, model: "m" };
  };
  const r = await translateCard({ name: "Witches", description: "A card about two witches and the hero they caught.", schema, sourceLang: "en", targetLang: "ko" }, chat);
  assert.match(rules, /【Bella】/, "the prompt names the markers to copy");
  assert.equal(r.schema.entries[0].content, "【Bella】어머, 용사님이 드디어 깨어나셨네요.\n【Luna】저도 여기 있어요, 용사님.");
  assert.match(r.schema.entries[1].content, /【Bella】 또는 【Luna】/);
  assert.match(r.schema.variables[0].behaviorRules, /Smug, Calm\.$/);
  assert.equal(r.schema.variables[0].defaultValue, "Calm");
  assert.ok(r.report.markersRestored >= 3);
  assert.equal(r.report.valuesPinned, 1);
  assert.deepEqual(r.report.problems.filter((p) => p.kind === "state_value"), []);
});

// --- Russian batch, 2026-11-21 ---------------------------------------------------------------

const FRIEREN_CODE = `export function split(line) { return line.match(/^(.*?)「(.+?)」(.*)/); }`;

test("a quoted-dialogue format yields the marker 「…」, never the sentence inside it", async () => {
  const { markerOf } = await import("./card-translate-literals.js");
  const lit = cardLiterals({ rootComponent: { files: { "a.tsx": FRIEREN_CODE } } });
  const p = lit.patterns.find((x) => x.src.includes("「"))!;
  assert.equal(markerOf("「…You have the scent of mana about you.」", p), "「…」");
  assert.equal(markerOf("「…Whatever.」", p), "「…」");
  assert.equal(markerOf("「Oh—」 He swallows the bread.", p), "「…」");
  const bella = cardLiterals({ rootComponent: { files: { "a.tsx": CODE } } }).patterns;
  assert.equal(markerOf("【Bella】Oh my, the hero is awake.", bella.find((x) => x.src.includes("Bella"))!), "【Bella】");
  assert.equal(markerOf("<face>smile</face> she laughs", bella.find((x) => x.src.includes("face"))!), "<face>smile</face>");
});

test("translateCard: short 「…」 lines are not handed to the model as markers to copy (they came back in English)", async () => {
  const schema = {
    name: "Frieren", description: "d",
    entries: [{ id: "g", name: "Opening", role: "greeting", content: "The elf looks up from her book.\n「…You have the scent of mana about you.」\n「…Whatever.」", keywords: [] }],
    variables: [], rules: [], settings: {},
    rootComponent: { entryFile: "index.tsx", files: { "index.tsx": FRIEREN_CODE } },
  };
  const ru: Record<string, string> = {
    "meta.name": "Фрирен", "meta.description": "Путешествие на север с эльфийкой-магом и её учениками.", "entry.0.name": "Начало",
    "entry.0.content": "Эльфийка поднимает взгляд от книги.\n«…От тебя пахнет маной.»\n«…Как хочешь.»",
  };
  let rules = "";
  const chat: ChatFn = async (messages) => {
    const sys = messages[0]!.content, user = messages[messages.length - 1]!.content;
    if (sys.startsWith("You build a translation glossary")) return { text: '{"terms":{}}', costUsd: 0, model: "m" };
    rules = sys;
    const obj = JSON.parse(user.slice(user.indexOf("{")));
    return { text: JSON.stringify(Object.fromEntries(Object.keys(obj).map((k) => [k, ru[k] ?? obj[k]]))), costUsd: 0, model: "m" };
  };
  const r = await translateCard({ name: "Frieren", description: "A journey north with an elf mage and her apprentices.", schema, sourceLang: "en", targetLang: "ru" }, chat);
  assert.doesNotMatch(rules, /scent of mana|Whatever/, "no sentence is listed as a marker");
  assert.match(rules, /「…」/);
  // the model wrote «» for 「」: the quote marks come back, the Russian words stay
  assert.equal(r.schema.entries[0].content, "Эльфийка поднимает взгляд от книги.\n「…От тебя пахнет маной.」\n「…Как хочешь.」");
});

test("restore never copies a source sentence back over its translation", async () => {
  const { restoreLine } = await import("./card-translate-literals.js");
  // A pattern only the English text satisfies: a bracket restore would have to write the sentence back.
  const pats = [{ re: /^「[A-Z]/, words: [], src: "/^「[A-Z]/", multiline: false }];
  const s = "「Don't move. You have a cracked rib.」", t = "「Не двигайся. У тебя треснуло ребро.」";
  assert.equal(restoreLine(s, t, pats, true), null);
  const lit = { values: new Set<string>(), keys: new Set<string>(), patterns: pats, scans: [], listed: new Set<string>() };
  assert.equal(restoreMarkers(s, t, lit, true).text, t);
  // a marker head still comes back, words kept
  const bella = cardLiterals({ rootComponent: { files: { "a.tsx": CODE } } });
  assert.equal(restoreMarkers("【Bella】Oh my, the hero is awake.", "【Белла】Ох, герой проснулся.", bella, true).text, "【Bella】Ох, герой проснулся.");
});

const MARLENE_CODE = `var PLACES = [
  { key: 'doorway', label: 'doorway', match: /door|threshold|hall/i },
  { key: 'foot', label: 'foot of the bed', match: /foot|end of the bed|bedside|beside/i },
  { key: 'edge', label: 'edge of the bed', match: /edge|sat|sitting|next to her|on the bed/i },
];
export default function Root({ variables: V }) { var distance = String(V.distance || 'doorway'); var at = PLACES.filter(function (p) { return p.match.test(distance); })[0]; return <div title="Where you are">{at ? at.label : 'doorway'}</div>; }`;

test("literals: values a variable lists, read by a keyword regex the code tests it with, are code-matched", async () => {
  const { listedValues } = await import("./card-translate-literals.js");
  const lit = cardLiterals({
    rootComponent: { files: { "index.tsx": MARLENE_CODE } },
    variables: [
      { id: "distance", type: "string", defaultValue: "doorway", behaviorRules: "Doorway / foot of the bed / edge of the bed. Move one step at a time." },
      { id: "mood", type: "string", defaultValue: "calm", behaviorRules: "She sat down whenever she could. Calm, wary or quidditch-mad." },
    ],
  });
  assert.equal(lit.scans.length, 3);
  for (const v of ["Doorway", "foot of the bed", "edge of the bed", "doorway"]) assert.ok(lit.listed.has(v), v);
  assert.ok(!lit.values.has("foot of the bed"), "listed values are not code literals (an interface label may say the same)");
  // a sentence that merely uses "sat", a list without two hits: not values
  assert.ok(![...lit.listed].some((v) => /sat|whenever|Calm|wary/.test(v)), [...lit.listed].join("|"));
  assert.deepEqual(listedValues("Doorway / foot of the bed / edge of the bed. Move one step at a time."), [["Doorway", "foot of the bed", "edge of the bed"]]);
  // a regex that is never run against text (a .replace pattern) is not a scan
  assert.equal(cardLiterals({ rootComponent: { files: { "a.tsx": `const f = (s) => s.replace(/door|hall/g, "x");` } } }).scans.length, 0);
});

test("translateCard: a regex-read variable keeps its listed values in a Russian version (pinned when the model translates them)", async () => {
  const schema = {
    name: "Marlene", description: "d",
    entries: [{ id: "s", name: "Engine", role: "system", content: "Write in natural English. Track where the player stands.", alwaysSend: true, keywords: [] }],
    variables: [{ id: "distance", name: "Distance", type: "string", defaultValue: "doorway", behaviorRules: "Doorway / foot of the bed / edge of the bed. Move one step at a time." }],
    rules: [], settings: {},
    rootComponent: { entryFile: "index.tsx", files: { "index.tsx": MARLENE_CODE } },
  };
  const ru: Record<string, string> = {
    "meta.name": "Марлин", "meta.description": "Тихий дом, мачеха и разговор, который никто не начинает.", "entry.0.name": "Движок",
    "entry.0.content": "Пиши на естественном русском. Следи, где стоит игрок.", "var.0.name": "Расстояние",
    "var.0.behaviorRules": "Дверной проём / изножье кровати / край кровати. Двигайся на один шаг за раз.",
  };
  let rules = "";
  const chat: ChatFn = async (messages) => {
    const sys = messages[0]!.content, user = messages[messages.length - 1]!.content;
    if (sys.startsWith("You build a translation glossary")) return { text: '{"terms":{}}', costUsd: 0, model: "m" };
    if (user.startsWith("File index.tsx")) return { text: "```tsx\n" + MARLENE_CODE.replace('"Where you are"', '"Где ты"').replace("label: 'foot of the bed'", "label: 'изножье кровати'") + "\n```", costUsd: 0, model: "m" };
    if (!rules) rules = sys;
    const obj = JSON.parse(user.slice(user.indexOf("{")));
    return { text: JSON.stringify(Object.fromEntries(Object.keys(obj).map((k) => [k, ru[k] ?? obj[k]]))), costUsd: 0, model: "m" };
  };
  const r = await translateCard({ name: "Marlene", description: "A quiet house, a stepmother and a talk nobody starts.", schema, sourceLang: "en", targetLang: "ru" }, chat);
  assert.match(rules, /state values the game code checks: [^\n]*foot of the bed/);
  assert.match(r.schema.variables[0].behaviorRules, /как в оригинале: [^\n]*foot of the bed/);
  assert.match(r.schema.variables[0].behaviorRules, /edge of the bed/);
  assert.equal(r.report.valuesPinned, 1);
  assert.equal(r.schema.variables[0].defaultValue, "doorway");
  assert.ok(r.schema.rootComponent.files["index.tsx"].includes("label: 'изножье кровати'"), "the interface label is still translatable");
});
