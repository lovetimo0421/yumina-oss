import test from "node:test";
import assert from "node:assert/strict";
import { UI_PAGE_TEMPLATES, migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { PAGE_TEMPLATE_NAMES, advisorPrompt, approxPromptSize, capabilitySheet, cardOutline, describeLanguage, referenceIndex, saveBrief } from "./studio-advisor.js";
import { createBuildProposal, advisorTools } from "./studio-advisor.js";
import { STUDIO_TOOLS } from "./studio-tools/tools.js";

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
    ["grep_world", "read_entities", "read_source", "read_ui_doc", "save_brief", "search_source"]);
});

test("every ready-made page the engine has is named for the advisor", () => {
  for (const t of UI_PAGE_TEMPLATES) assert.ok(PAGE_TEMPLATE_NAMES[t.id], `name ${t.id} in PAGE_TEMPLATE_NAMES`);
  const sheet = capabilitySheet("zh");
  assert.ok(sheet.includes("地图前往") && sheet.includes("片头"));
  assert.ok(sheet.includes("cannot do"));
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
