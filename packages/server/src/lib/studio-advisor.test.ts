import test from "node:test";
import assert from "node:assert/strict";
import { UI_PAGE_TEMPLATES, migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { BRIEF_HEADINGS, PAGE_TEMPLATE_NAMES, advisorPrompt, approxPromptSize, capabilitySheet, cardLanguageName, cardOutline, creatorLanguage, describeLanguage, referenceIndex, saveBrief } from "./studio-advisor.js";
import { createBuildProposal, advisorTools, localizeBriefHeadings, sheetLanguageProblem } from "./studio-advisor.js";
import { STUDIO_TOOLS } from "./studio-tools/tools.js";
import { buildSystemPrompt } from "./studio-tools/system-prompt.js";
import type { ResolvedContext } from "./studio-tools/context-resolver.js";

test("build offers validate concise scope and identify the exact saved brief", () => {
  const proposal = createBuildProposal(" Port story ", "First version", ["Opening", "Trust"]);
  assert.ok(proposal);
  assert.equal(proposal.revision.length, 64);
  assert.equal(createBuildProposal("Port story", "New wording", ["Opening"])!.revision, proposal.revision);
  assert.notEqual(createBuildProposal("Different story", "First version", ["Opening"])!.revision, proposal.revision);
  assert.equal(createBuildProposal("story", "summary", []), null);
  assert.equal(createBuildProposal("x".repeat(6001), "summary", ["Opening"]), null);
  assert.equal(createBuildProposal("story", "summary", [null]), null);
  assert.deepEqual(advisorTools(STUDIO_TOOLS).map(t => t.function.name).sort(),
    ["grep_world", "list_loras", "read_entities", "read_source", "read_ui_doc", "read_web_page", "save_brief", "search_source", "simulate_behaviors", "translate_card", "view_asset", "web_search"]);
});

test("every ready-made page the engine has is named for the advisor", () => {
  for (const t of UI_PAGE_TEMPLATES) assert.ok(PAGE_TEMPLATE_NAMES[t.id], `name ${t.id} in PAGE_TEMPLATE_NAMES`);
  const sheet = capabilitySheet("zh");
  assert.ok(sheet.includes("地图前往") && sheet.includes("片头"));
  assert.ok(sheet.includes("cannot do"));
});

test("the advisor knows about live characters only where they can be made", () => {
  // 2026-11-01: without this line the advisor told a creator a moving character needs Live2D and outside software
  assert.ok(capabilitySheet("zh", { liveCharacter: true }).includes("A live character from one picture"));
  assert.ok(!capabilitySheet("zh").includes("A live character from one picture"));
  const world = migrateWorldDefinition({ id: "w", version: "19.0.0", name: "x", entries: [], variables: [], rules: [], reactions: [],
    components: [], audioTracks: [], customUI: [], settings: {} } as unknown as WorldDefinition);
  assert.ok(advisorPrompt({ world, sources: [], brief: null, language: "Chinese", liveCharacter: true }).static.includes("A live character from one picture"));
});

test("the advisor's whole prompt stays small", () => {
  const world = migrateWorldDefinition({ id: "w", version: "19.0.0", name: "老信天翁号", entries: [], variables: [], rules: [], reactions: [],
    components: [], audioTracks: [], customUI: [], settings: {} } as unknown as WorldDefinition);
  const parts = advisorPrompt({ world, sources: [], brief: null, language: "Chinese" });
  assert.ok(parts.world.includes("The card is empty"));
  assert.ok(approxPromptSize(parts) < 6_000, `about ${approxPromptSize(parts)} tokens`);
});

test("the outline names what is on the card without its contents", () => {
  const world = migrateWorldDefinition({ id: "w", version: "19.0.0", name: "港口", entries: [
    { id: "g1", name: "清晨的码头", role: "greeting", content: "灰湾港，清晨。".repeat(50), enabled: true },
    { id: "c1", name: "莫琳", role: "character", content: "大副。".repeat(500), enabled: true },
  ], variables: [{ id: "gold", name: "金币", type: "number", defaultValue: 200 }], rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: {} } as unknown as WorldDefinition);
  const outline = cardOutline(world, []);
  assert.ok(outline.includes("莫琳") && outline.includes("金币 (number)") && outline.includes("清晨的码头"));
  assert.ok(outline.length < 600);
});

test("a brief must be text and fit on a page", async () => {
  assert.deepEqual(await saveBrief("u", "w", ""), { error: "brief must be non-empty text" });
  assert.ok("error" in (await saveBrief("u", "w", "字".repeat(7000))));
});

test("the creator's language is named, and a canon reference gives its people's names", () => {
  assert.equal(describeLanguage("I want a detective game"), "English");
  assert.equal(describeLanguage("我想做个侦探游戏"), "Chinese");
  assert.equal(describeLanguage("探偵ゲームを作りたい"), "Japanese");
  assert.equal(describeLanguage("Quiero un juego de detectives en Shanghái"), "Spanish");
  const bible = "# x\n## 剧情 1/2\n### 第一卷\n## 人物：贝尔、艾丝\n### 贝尔\n### 艾丝\n## 其他人物 1/1\n### 埃伊娜\n## 世界与术语\n### 地点\n## 段号对照";
  const index = referenceIndex(bible);
  assert.ok(index.startsWith("People: 贝尔、艾丝、埃伊娜"));
  assert.ok(index.includes("剧情 1/2 / 世界与术语") && !index.includes("地点") && !index.includes("段号"));
});

test("an attached image never turns an English creator's replies Chinese", () => {
  const image = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
  // Text + screenshot: the words decide.
  assert.equal(creatorLanguage([{ content: [{ type: "text", text: "What does this person mean?" }, image] }], "en"), "English");
  assert.equal(creatorLanguage([{ content: [image, { type: "text", text: "这个人是什么意思" }] }], "en"), "Chinese");
  // Image only: the creator's previous words.
  assert.equal(creatorLanguage([{ content: "Make the map bigger" }, { content: [image] }], "zh"), "English");
  assert.equal(creatorLanguage([{ content: "把地图做大一点" }, { content: [image] }, { content: "  " }], "en"), "Chinese");
  // No words at all: the card's own language, never a hard-coded Chinese.
  assert.equal(creatorLanguage([{ content: [image] }], "en"), "English");
  assert.equal(creatorLanguage([], "zh-TW"), "Chinese");
  assert.equal(creatorLanguage([], "ja"), "Japanese");
  assert.equal(creatorLanguage([], null), "English");
});

test("an English creator's brief and build stay in English (2026-10-30)", () => {
  const world = migrateWorldDefinition({ id: "w", version: "19.0.0", name: "Ascension", entries: [], variables: [], rules: [], reactions: [],
    components: [], audioTracks: [], customUI: [], settings: {} } as unknown as WorldDefinition);
  // The brief's headings follow the creator: Chinese only for a Chinese creator.
  const en = advisorPrompt({ world, sources: [], brief: null, language: "English" }).static;
  assert.ok(en.includes(BRIEF_HEADINGS.en) && !en.includes("一句话"));
  assert.ok(advisorPrompt({ world, sources: [], brief: null, language: "Chinese" }).static.includes(BRIEF_HEADINGS.zh));
  assert.ok(advisorPrompt({ world, sources: [], brief: null, language: "Japanese" }).static.includes(BRIEF_HEADINGS.en));
  // Build mode names the card's language and writes the card in it, whatever the brief is in.
  assert.equal(cardLanguageName("en"), "English");
  assert.equal(cardLanguageName("zh-TW"), "Chinese");
  assert.equal(cardLanguageName(null), null);
  const resolved = { inventory: "", preloadedEntities: "", truncated: false } as unknown as ResolvedContext;
  const built = buildSystemPrompt(resolved, { cardLanguage: "English" });
  assert.ok(built.static.includes("Text you write INTO the card follows the card's language"));
  assert.ok(built.dynamic.includes("<card-language>This card is in English."));
  assert.ok(!buildSystemPrompt(resolved, {}).dynamic.includes("<card-language>"));
});

test("an old brief's Chinese headings are shown in the creator's language", () => {
  const brief = "## 一句话\n修复房间\n\n## 玩家是谁 / 每一轮做什么 / 怎么结束\n（不变）\n正文里的一句话不动";
  const out = localizeBriefHeadings(brief, "en");
  assert.match(out, /^## In one line$/m);
  assert.match(out, /^## Who the player is \/ What happens each turn \/ How it ends$/m);
  assert.match(out, /正文里的一句话不动/, "body text is left as written");
  assert.equal(localizeBriefHeadings(brief, "zh"), brief);
});

test("a confirmation sheet in another language than the creator's is caught", () => {
  assert.ok(sheetLanguageProblem("修复地下城房间突然消失", ["自愈逻辑不再覆盖存档"], "English"));
  assert.equal(sheetLanguageProblem("Fix the rooms in 华山 and 青城", ["Guard the lists"], "English"), null, "a few names are fine");
  assert.equal(sheetLanguageProblem("修复房间", ["保护列表"], "Chinese"), null);
  assert.equal(sheetLanguageProblem("部屋が消える不具合を直す", ["リストを守る"], "Japanese"), null);
  assert.ok(sheetLanguageProblem("修复房间消失", ["保护列表"], "Japanese"));
});
