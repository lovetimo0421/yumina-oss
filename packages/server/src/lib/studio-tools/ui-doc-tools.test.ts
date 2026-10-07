import test from "node:test";
import assert from "node:assert/strict";
import type { WorldDefinition, UiDoc } from "@yumina/engine";
import { compileUiDoc, worldDefinitionSchema } from "@yumina/engine";
import { executeApplyChanges, toolCallsToSchemaChanges } from "./tool-executor.js";
import { compileUiDocInto, executeReadUiDoc } from "./ui-doc-tools.js";
import { READ_TOOL_NAMES, WRITE_TOOL_NAMES } from "./tools.js";
import { getSkillContent } from "../studio-skills/index.js";

function toolCall(name: string, args: Record<string, unknown>) {
  return { id: `tc-${name}-${Math.random().toString(36).slice(2, 8)}`, function: { name, arguments: JSON.stringify(args) } };
}

function makeWorld(overrides?: Partial<WorldDefinition>): WorldDefinition {
  return {
    id: "test-world",
    version: "19.0.0",
    name: "Test World",
    description: "",
    author: "test",
    entries: [
      { id: "g1", name: "雨夜初遇", content: "雨下得很大。", role: "greeting", section: "system-presets", position: 0, keywords: [], conditions: [], conditionLogic: "all", enabled: true, alwaysSend: false },
      { id: "g2", name: "重逢", content: "好久不见。", role: "greeting", section: "system-presets", position: 1, keywords: [], conditions: [], conditionLogic: "all", enabled: true, alwaysSend: false },
    ],
    variables: [
      { id: "player_name", name: "玩家名字", type: "string", defaultValue: "" },
      { id: "hp", name: "HP", type: "number", defaultValue: 100 },
      { id: "found", name: "已收集", type: "json", defaultValue: [] },
    ],
    rules: [],
    reactions: [],
    components: [],
    audioTracks: [],
    customUI: [],
    settings: { maxTokens: 4000, temperature: 1.0, playerName: "User" },
    ...overrides,
  } as WorldDefinition;
}

const DOC: UiDoc = {
  version: 1,
  entryPageId: "page-1",
  surface: "chat",
  pages: [{
    id: "page-1", name: "Main", height: 812, elements: [
      { id: "title", type: "text", x: 20, y: 40, w: 335, h: 40, text: { template: "欢迎" }, style: { size: 20, color: "#ffffff" } },
      { id: "start", type: "button", x: 20, y: 700, w: 335, h: 48, label: { template: "开始" }, actions: [{ kind: "send-message", text: { template: "开始" } }] },
    ],
  }],
};

/** A card built in the visual editor: document + its compiled frontend. */
function makeDocWorld(): WorldDefinition {
  const doc = structuredClone(DOC);
  const built = compileUiDoc(doc);
  return makeWorld({
    uiDoc: doc,
    rootComponent: { id: "rc-1", name: "Interface", entryFile: built.entryFile, files: { ...built.files }, updatedAt: new Date(0).toISOString(), generatedFrom: "uiDoc" },
  } as Partial<WorldDefinition>);
}

function edit(world: WorldDefinition, ops: unknown[]) {
  const parsed = toolCallsToSchemaChanges([toolCall("edit_ui_doc", { ops })], world);
  assert.equal(parsed[0]!.error, undefined, parsed[0]!.error);
  return executeApplyChanges(world, [parsed[0]!.change!]);
}

/** What the editor's save does to any card that has a uiDoc. */
const editorSave = (w: WorldDefinition) => compileUiDocInto(w.uiDoc!, w.rootComponent);

// ── Registration ──

test("read_ui_doc is a read tool, edit_ui_doc a write tool, and the ui-doc skill loads on demand", () => {
  assert.ok(READ_TOOL_NAMES.has("read_ui_doc"));
  assert.ok(WRITE_TOOL_NAMES.has("edit_ui_doc"));
  const skill = getSkillContent("ui-doc");
  assert.ok(skill && skill.includes("edit_ui_doc"));
});

// ── Valid ops apply and compile ──

test("edit_ui_doc applies ops in order, mints ids, and recompiles the frontend", () => {
  const world = makeDocWorld();
  const result = edit(world, [
    { op: "update_part", id: "title", patch: { style: { color: "#ff8fc7" }, text: { template: "欢迎 {{hp}}" } } },
    { op: "add_part", part: { type: "meter", x: 20, y: 90, w: 335, h: 12, value: { kind: "variable", variableId: "hp" }, min: { kind: "literal", value: 0 }, max: { kind: "literal", value: 100 } } },
    { op: "add_page", name: "背包" },
    { op: "update_part", id: "start", patch: { actions: [{ kind: "go-page", pageId: "page-2" }] } },
    { op: "set_theme", preset: { id: "night" } },
  ]);
  assert.equal(result.success, true, result.summary);
  const doc = result.world.uiDoc!;
  const title = doc.pages[0]!.elements.find((e) => e.id === "title")!;
  assert.equal((title as { style?: { color?: string; size?: number } }).style?.color, "#ff8fc7");
  assert.equal((title as { style?: { size?: number } }).style?.size, 20, "merge patch keeps untouched style fields");
  assert.ok(doc.pages[0]!.elements.some((e) => e.id === "meter-1" && e.type === "meter"));
  assert.equal(doc.pages[1]!.id, "page-2");
  assert.equal(doc.theme?.preset?.id, "night");
  assert.match(result.results[0]!.note!, /meter "meter-1" added/);

  // Compiled in the same step: play sees it, and the editor's save has nothing left to change.
  const rc = result.world.rootComponent!;
  assert.equal(rc.generatedFrom, "uiDoc");
  assert.equal(rc.files["index.tsx"], compileUiDoc(doc).files["index.tsx"]);
  assert.match(rc.files["index.tsx"]!, /#ff8fc7/);
  assert.equal(editorSave(result.world), rc);
  assert.ok(worldDefinitionSchema.safeParse(result.world).success);
  // The input world is untouched.
  assert.equal(world.uiDoc!.pages.length, 1);
});

test("set_theme: a half palette (pink page, dark rose text on the preset's dark bubble) is drawn readable and the assistant is told", () => {
  const world = makeDocWorld();
  const result = edit(world, [
    { op: "set_theme", preset: { id: "blossom" } },
    { op: "set_theme", tokens: { "--yc-bg": "#ffe4ef", "--yc-bg-solid": "#ffe4ef", "--yc-text": "#8a4a64" } },
  ]);
  assert.equal(result.success, true, result.summary);
  assert.equal(result.world.uiDoc!.theme!.tokens!["--yc-text"], "#8a4a64", "the stored choice is the creator's");
  assert.match(result.results[0]!.note!, /contrast: --yc-text #8a4a64→#/);
  const code = result.world.rootComponent!.files["index.tsx"]!;
  assert.match(code, /"--yc-text": "#[0-9a-f]{6}"/);
  assert.doesNotMatch(code, /"--yc-text": "#8a4a64"/, "the drawn ink is not the unreadable one");
});

test("choice, field and popup parts land with names resolved to variable ids", () => {
  const world = makeDocWorld();
  const result = edit(world, [
    { op: "add_part", part: { type: "field", kind: "text", variableId: "玩家名字", label: { template: "你的名字" }, x: 32, y: 260, w: 311, h: 72, visibleWhen: { variableId: "$chat.started", operator: "eq", value: false } } },
    { op: "add_part", part: { type: "button", label: { template: "开始" }, requires: ["玩家名字"], actions: [{ kind: "send-message", text: { template: "我叫{{玩家名字}}" } }], x: 32, y: 470, w: 311, h: 52 } },
    { op: "add_part", part: { type: "choice", layout: "grid", x: 16, y: 120, w: 343, h: 500, options: [
      { title: "雨夜初遇", actions: [{ kind: "switch-greeting", index: 0 }] },
      { title: "重逢", actions: [{ kind: "switch-greeting", index: 1 }] },
    ] } },
    { op: "add_part", part: { type: "popup", variableId: "hp", body: { template: "{{value}}" }, x: 40, y: 300, w: 295, h: 200 } },
  ]);
  assert.equal(result.success, true, result.summary);
  const els = result.world.uiDoc!.pages[0]!.elements;
  const field = els.find((e) => e.type === "field") as { variableId: string };
  const button = els.find((e) => e.id === "button-1") as { requires: string[]; actions: Array<{ text: { template: string } }> };
  const choice = els.find((e) => e.type === "choice") as { options: Array<{ id: string }> };
  assert.equal(field.variableId, "player_name");
  assert.deepEqual(button.requires, ["player_name"]);
  assert.equal(button.actions[0]!.text.template, "我叫{{player_name}}");
  assert.deepEqual(choice.options.map((o) => o.id), ["opt-1", "opt-2"]);
  assert.match(result.results[0]!.note!, /"玩家名字" → variable id "player_name"/);
});

test("a plain-chat card with no document gets one over the platform chat", () => {
  const world = makeWorld({
    rootComponent: { id: "rc", name: "Root", entryFile: "index.tsx", files: { "index.tsx": "export default function MyWorld() {\n  return <Chat />;\n}" }, updatedAt: "" },
  } as Partial<WorldDefinition>);
  const result = edit(world, [{ op: "add_part", part: { type: "text", x: 0, y: 0, w: 375, h: 30, text: { template: "HP {{hp}}" } } }]);
  assert.equal(result.success, true, result.summary);
  assert.equal(result.world.uiDoc!.surface, "chat");
  assert.equal(result.world.rootComponent!.generatedFrom, "uiDoc");
  assert.match(result.world.rootComponent!.files["index.tsx"]!, /HP /);
});

test("a hand-written frontend is kept as the base layer when a document is created", () => {
  const code = `export default function App() {\n  const api = useYumina();\n  return <div onClick={() => api.sendMessage("hi")}>${"x".repeat(900)}</div>;\n}`;
  const world = makeWorld({
    rootComponent: { id: "rc", name: "Root", entryFile: "index.tsx", files: { "index.tsx": code }, updatedAt: "" },
  } as Partial<WorldDefinition>);
  const result = edit(world, [{ op: "add_part", part: { type: "text", x: 0, y: 0, w: 375, h: 30, text: { template: "HP" } } }]);
  assert.equal(result.success, true, result.summary);
  assert.equal(result.world.uiDoc!.base!.file, "_base.tsx");
  assert.equal(result.world.rootComponent!.files["_base.tsx"], code);
  assert.match(result.world.rootComponent!.files["index.tsx"]!, /_base\.tsx/);
});

// ── Rejections the model can fix ──

test("an invalid part is rejected with the part, the field and the reason — and nothing applies", () => {
  const world = makeDocWorld();
  const bad = edit(world, [
    { op: "update_part", id: "title", patch: { style: { color: "#000" } } },
    { op: "add_part", part: { type: "meter", x: 0, y: 0, w: 100, h: 10, value: { kind: "literal", value: 1 }, min: { kind: "literal", value: 0 } } },
  ]);
  assert.equal(bad.success, false);
  assert.equal(bad.world, world);
  assert.match(bad.summary, /part "meter-1" \(meter\) → max: Required/);

  const typo = edit(world, [{ op: "update_part", id: "title", patch: { style: { colour: "#f0f" } } }]);
  assert.equal(typo.success, false);
  assert.match(typo.summary, /unknown field\(s\) "style\.colour"/);

  const unknownType = edit(world, [{ op: "add_part", part: { type: "slider", x: 0, y: 0, w: 1, h: 1 } }]);
  assert.equal(unknownType.success, false);
  assert.match(unknownType.summary, /no allowed shape matches/);
});

test("references are checked: missing variable, ambiguous name, missing page, missing opening", () => {
  const world = makeDocWorld();
  const noVar = edit(world, [{ op: "add_part", part: { type: "field", kind: "text", variableId: "mood", x: 0, y: 0, w: 100, h: 40 } }]);
  assert.equal(noVar.success, false);
  assert.match(noVar.summary, /no variable "mood"\. Variables: player_name \("玩家名字", string\)/);

  const twins = makeDocWorld();
  twins.variables.push({ id: "hp2", name: "HP", type: "number", defaultValue: 0 });
  const ambiguous = edit(twins, [{ op: "update_part", id: "title", patch: { visibleWhen: { variableId: "HP", operator: "gt", value: 0 } } }]);
  assert.equal(ambiguous.success, false);
  assert.match(ambiguous.summary, /ambiguous/);

  const noPage = edit(world, [{ op: "update_part", id: "start", patch: { actions: [{ kind: "go-page", pageId: "bag" }] } }]);
  assert.equal(noPage.success, false);
  assert.match(noPage.summary, /missing page "bag"/);

  const noOpening = edit(world, [{ op: "add_part", part: { type: "button", label: { template: "x" }, actions: [{ kind: "switch-greeting", index: 5 }], x: 0, y: 0, w: 10, h: 10 } }]);
  assert.equal(noOpening.success, false);
  assert.match(noOpening.summary, /switch-greeting index 5 but the card has 2 opening/);

  const noPart = edit(world, [{ op: "remove_part", id: "ghost" }]);
  assert.equal(noPart.success, false);
  assert.match(noPart.summary, /no part "ghost"/);
});

test("a custom part with broken TSX is rejected before it can blank the card", () => {
  const result = edit(makeDocWorld(), [{ op: "add_part", part: { type: "custom", code: "return <div>{", x: 0, y: 0, w: 10, h: 10 } }]);
  assert.equal(result.success, false);
  assert.match(result.summary, /custom\) code does not compile/);
});

// ── read_ui_doc ──

test("read_ui_doc summarises pages, parts, variables and openings, and returns full JSON on request", () => {
  const out = executeReadUiDoc(makeDocWorld(), { parts: ["start"] });
  const summary = String(out.summary);
  assert.match(summary, /PAGE page-1 "Main" 375×812/);
  assert.match(summary, /title \[text\] \(20,40 335×40\) · "欢迎"/);
  assert.match(summary, /start \[button\].*does: send "开始"/);
  assert.match(summary, /player_name "玩家名字" string/);
  assert.match(summary, /#0 "雨夜初遇", #1 "重逢"/);
  assert.equal((out.parts as Record<string, { type: string }>).start!.type, "button");
});

// ── The overwrite bug ──

test("regression: a raw TSX write to a uiDoc-generated entry is refused instead of being lost on the next save", () => {
  const world = makeDocWorld();
  for (const call of [
    toolCall("write_custom_ui", { id: "index.tsx", tsxCode: "export default function App() { return <div>MARKER</div>; }" }),
    toolCall("edit_custom_ui", { id: "index.tsx", old_code: "const DESIGN_W", new_code: "const MARKER = 1;\nconst DESIGN_W" }),
    toolCall("write_custom_ui", { id: "root-component", tsxCode: "export default function App() { return <div>MARKER</div>; }" }),
  ]) {
    const parsed = toolCallsToSchemaChanges([call], world);
    const result = executeApplyChanges(world, [parsed[0]!.change!]);
    // Before the fix these writes "succeeded" and the editor's next save
    // recompiled index.tsx from the document, silently dropping MARKER.
    const survives = result.success && editorSave(result.world).files["index.tsx"]!.includes("MARKER");
    assert.ok(!result.success || survives, "the code write must either be refused or survive a save");
    assert.equal(result.success, false);
    assert.match(result.summary, /compiled from that document.*edit_ui_doc/s);
    assert.equal(result.world, world);
  }
});

test("code edits to a preserved base layer and new helper files still go through", () => {
  const world = makeDocWorld();
  world.uiDoc!.base = { file: "_base.tsx" };
  world.rootComponent!.files["_base.tsx"] = "export default function B() { return <div>old</div>; }";
  const result = executeApplyChanges(world, toolCallsToSchemaChanges([
    toolCall("edit_custom_ui", { id: "_base.tsx", old_code: "<div>old</div>", new_code: "<div>new</div>" }),
  ], world).map((p) => p.change!));
  assert.equal(result.success, true, result.summary);
  assert.match(editorSave(result.world).files["_base.tsx"]!, /new/);

  const knobs = executeApplyChanges(world, toolCallsToSchemaChanges([
    toolCall("write_custom_ui", { id: "_knobs.tsx", tsxCode: "export default {};" }),
  ], world).map((p) => p.change!));
  assert.equal(knobs.success, false, "the generated knobs module is document output too");

  const resetAll = executeApplyChanges(world, [{ action: "delete", entityType: "customUI", id: "rc-1" }]);
  assert.equal(resetAll.success, false, "resetting the root would drop the base layer");
});

test("detach_to_code hands the frontend to code explicitly, keeping the compiled files", () => {
  const world = makeDocWorld();
  const result = edit(world, [{ op: "detach_to_code" }]);
  assert.equal(result.success, true, result.summary);
  assert.equal(result.world.uiDoc, undefined);
  assert.equal(result.world.rootComponent!.generatedFrom, undefined);
  assert.equal(result.world.rootComponent!.files["index.tsx"], world.rootComponent!.files["index.tsx"]);
  const after = executeApplyChanges(result.world, toolCallsToSchemaChanges([
    toolCall("write_custom_ui", { id: "index.tsx", tsxCode: "export default function App() { return <div>MARKER</div>; }" }),
  ], result.world).map((p) => p.change!));
  assert.equal(after.success, true, after.summary);
});

test("compileUiDocInto keeps an installed bundle composer mounted", () => {
  const world = makeDocWorld();
  world.rootComponent!.files["__user-root.tsx"] = "old";
  world.rootComponent!.files["_bundles/phone/index.tsx"] = "export default function P() { return null; }";
  const result = edit(world, [{ op: "update_part", id: "title", patch: { style: { color: "#123456" } } }]);
  assert.equal(result.success, true, result.summary);
  const files = result.world.rootComponent!.files;
  assert.match(files["index.tsx"]!, /AUTO-GENERATED by importBundle/);
  assert.match(files["__user-root.tsx"]!, /#123456/);
});

test("message rules on a transcript validate, compile, and keep the 界面约定 entry in step", () => {
  const world = makeDocWorld();
  world.uiDoc!.pages[0]!.elements.push({ id: "log", type: "messages", x: 0, y: 100, w: 375, h: 560 });
  world.rootComponent = compileUiDocInto(world.uiDoc!, world.rootComponent);
  const rules = [
    { id: "thought", name: "心里话", match: { kind: "wrap", open: "♡", close: "♡" }, show: "reveal", options: { cover: "ink" } },
    { id: "opts", name: "选项", match: { kind: "line-prefix", prefix: "※" }, show: "choices" },
  ];
  const added = edit(world, [{ op: "update_part", id: "log", patch: { rules, messageStyle: { showNames: false } } }]);
  assert.equal(added.success, true, added.summary);
  const entry = added.world.entries.find((e) => e.id === "ui-message-rules");
  assert.ok(entry, "the rules became a lorebook entry");
  assert.equal(entry!.section, "post-history");
  assert.match(entry!.content, /♡…♡/);
  assert.match(added.world.rootComponent!.files["index.tsx"]!, /<MessageList rendererComponent=\{null\} design=\{/);
  assert.match(executeReadUiDoc(added.world, {}).summary as string, /thought="心里话" ♡…♡→reveal/);

  const cleared = edit(added.world, [{ op: "update_part", id: "log", patch: { rules: null } }]);
  assert.equal(cleared.success, true, cleared.summary);
  assert.equal(cleared.world.entries.some((e) => e.id === "ui-message-rules"), false, "no rules, no entry");

  const broken = toolCallsToSchemaChanges([toolCall("edit_ui_doc", { ops: [{ op: "update_part", id: "log", patch: { rules: [{ id: "x", name: "x", match: { kind: "regex", pattern: "([" }, show: "hide" }] } }] })], added.world);
  const result = broken[0]!.error ? { success: false } : executeApplyChanges(added.world, [broken[0]!.change!]);
  assert.equal(result.success, false, "a pattern that does not compile is refused");
});

// ── Looks ──

test("apply_look restyles a part in one op, leaves its content alone, and read_ui_doc names looks", () => {
  const world = makeDocWorld();
  const result = edit(world, [{ op: "apply_look", id: "start", look: "button-outline" }]);
  assert.equal(result.success, true, result.summary);
  const button = result.world.uiDoc!.pages[0]!.elements.find((e) => e.id === "start") as { style?: { borderColor?: string }; css?: string; label: { template: string } };
  assert.ok(button.style?.borderColor, "the look's style fields landed");
  assert.match(button.css ?? "", /look:button-outline/);
  assert.equal(button.label.template, "开始");
  const summary = String(executeReadUiDoc(result.world, {}).summary);
  assert.match(summary, /LOOKS \(apply_look\): choice: choice-default/);
  assert.match(summary, /start \[button\].*look button-outline/);
});

test("apply_look refuses a look for another kind of part and says which ones fit", () => {
  const world = makeDocWorld();
  const parsed = toolCallsToSchemaChanges([toolCall("edit_ui_doc", { ops: [{ op: "apply_look", id: "start", look: "choice-glass" }] })], world);
  const result = parsed[0]!.change ? executeApplyChanges(world, [parsed[0]!.change]) : null;
  const error = parsed[0]!.error ?? (result && !result.success ? result.summary : "");
  assert.match(String(error), /no button look "choice-glass".*button-solid/);
});

test("set_entry_page tells the AI the old first page only steps aside for a player a button brings there", () => {
  const world = makeDocWorld();
  world.uiDoc!.pages[0]!.leaveWhen = { when: { variableId: "$chat.started", operator: "eq", value: true }, pageId: "page-2" };
  world.uiDoc!.pages.push({ id: "page-2", name: "Chat", height: 812, elements: [] });
  const result = edit(world, [{ op: "set_entry_page", page: "page-2" }]);
  assert.equal(result.success, true, result.summary);
  assert.equal(result.world.uiDoc!.entryPageId, "page-2");
  assert.match(result.results[0]!.note!, /no longer the first page/);
});

test("raising a text part's size grows its box so the letters are not clipped", () => {
  const world = makeDocWorld();
  const result = edit(world, [{ op: "update_part", id: "title", patch: { style: { size: 52, lineHeight: 1.15 } } }]);
  assert.equal(result.success, true, result.summary);
  const title = result.world.uiDoc!.pages[0]!.elements.find((e) => e.id === "title")!;
  assert.ok(title.h >= Math.ceil(52 * 1.15), `h ${title.h}`);
  assert.match(result.results[0]!.note!, /grew/);
  // An explicit height wins.
  const pinned = edit(world, [{ op: "update_part", id: "title", patch: { h: 40, style: { size: 52 } } }]);
  assert.equal(pinned.world.uiDoc!.pages[0]!.elements.find((e) => e.id === "title")!.h, 40);
});

test("a title the AI makes bigger pushes the parts under it down instead of landing on them", () => {
  const world = makeDocWorld();
  const page = world.uiDoc!.pages[0]!;
  page.elements.push(
    { id: "sub", type: "text", x: 20, y: 86, w: 335, h: 24, desktop: { x: 40, y: 90, w: 500, h: 24 }, text: { template: "副标题" }, style: { size: 14 } },
    // A one-line title in a row: too long for a phone at 52px.
    { id: "head", type: "text", x: 20, y: 130, w: 335, h: 36, desktop: { x: 40, y: 130, w: 900, h: 40 }, text: { template: "从哪一刻开始故事？" }, style: { size: 28, nowrap: true } },
    { id: "cards", type: "box", x: 20, y: 180, w: 335, h: 400, desktop: { x: 40, y: 190, w: 900, h: 300 } },
  );
  world.rootComponent = { ...world.rootComponent!, files: { ...compileUiDoc(world.uiDoc!).files } };
  const result = edit(world, [{ op: "update_part", id: "head", patch: { style: { size: 52 } } }]);
  assert.equal(result.success, true, result.summary);
  const els = result.world.uiDoc!.pages[0]!.elements;
  const get = (id: string) => els.find((e) => e.id === id)!;
  const head = get("head");
  // Wraps rather than ending in 「…」, and grows taller.
  assert.equal(head.type === "text" && head.style?.nowrap, false);
  assert.ok(head.h > 36 * 2, `h ${head.h}`);
  // The box under it moved down by exactly as much — on each canvas by that
  // canvas's own growth (the wide title stays one line, just taller).
  assert.equal(get("cards").y, 180 + (head.h - 36));
  assert.ok(get("cards").y >= head.y + head.h, "cards clear of the title");
  const wide = head.desktop!;
  assert.deepEqual(get("cards").desktop, { x: 40, y: 190 + (wide.h - 40), w: 900, h: 300 });
  assert.ok(get("cards").desktop!.y >= wide.y + wide.h, "cards clear of the title on the wide canvas");
  // Parts above it stay where they were.
  assert.equal(get("sub").y, 86);
  assert.match(result.results[0]!.note!, /wraps now/);
  assert.match(result.results[0]!.note!, /moved down to make room: start, cards/);
});
