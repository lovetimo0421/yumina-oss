import { describe, expect, it } from "vitest";
import ts from "typescript";
import { compileUiDoc } from "../compile.js";
import { duplicatePage, elementActions, removePage } from "../edit.js";
import { UI_PAGE_TEMPLATES, getUiPageTemplate, insertPageTemplate, openingChain, refreshConfirmSummary, carryOpeningChain } from "../page-templates.js";
import { validateUiDoc } from "../schema.js";
import type { UiDoc } from "../types.js";
import { uiDocVariableRefs } from "../variable-refs.js";

/** A card that already has a screen: one chat page. */
const chatOnly = (): UiDoc => ({
  version: 1,
  entryPageId: "page-1",
  pages: [{
    id: "page-1", name: "Main", height: 812,
    elements: [
      { id: "m", type: "messages", x: 0, y: 0, w: 375, h: 700 },
      { id: "c", type: "composer", x: 0, y: 716, w: 375, h: 96 },
    ],
  }],
});

const input = {
  strings: {},
  greetings: [{ title: "码头", preview: "雾没散" }, { title: "邮局", preview: "一封信" }, { title: "灯塔", preview: "" }],
  summary: [{ id: "player_name", label: "名字" }],
  cardName: "雾港来信",
};

const add = (doc: UiDoc, id: string) => insertPageTemplate(doc, getUiPageTemplate(id)!, input, `${id}-x`);
const goes = (doc: UiDoc, pageId: string) =>
  [...new Set(doc.pages.find((p) => p.id === pageId)!.elements.flatMap(elementActions)
    .filter((a) => a.kind === "go-page").map((a) => (a as { pageId: string }).pageId))];

describe("page templates", () => {
  for (const tpl of UI_PAGE_TEMPLATES) {
    it(`${tpl.id} makes a valid page that compiles and binds only what it declares`, () => {
      const doc = add(chatOnly(), tpl.id);
      const valid = validateUiDoc(doc);
      expect(valid.ok ? [] : valid.errors).toEqual([]);
      const src = compileUiDoc(doc).files["index.tsx"]!;
      const out = ts.transpileModule(src, { reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 } });
      expect(out.diagnostics ?? []).toEqual([]);
      const declared = new Set([...tpl.variables.map((v) => v.id), ...(tpl.id === "confirm" ? ["player_name"] : [])]);
      const refs = uiDocVariableRefs({ ...doc, pages: doc.pages.filter((p) => p.id !== "page-1") });
      for (const id of [...refs.reads, ...refs.writes]) if (!id.startsWith("$")) expect(declared, `undeclared ${id}`).toContain(id);
    });
  }

  it("the first one becomes the entry, steps aside to the chat, and leads to it", () => {
    const doc = add(chatOnly(), "enter-name");
    expect(doc.entryPageId).toBe("enter-name-x");
    expect(doc.pages.find((p) => p.id === "enter-name-x")!.leaveWhen?.pageId).toBe("page-1");
    expect(goes(doc, "enter-name-x")).toEqual(["page-1"]);
  });

  it("chains in the order added, the title first and the confirm page last", () => {
    let doc = add(chatOnly(), "enter-name");
    doc = add(doc, "confirm");
    doc = add(doc, "pick-opening");
    doc = add(doc, "title-screen");
    expect(openingChain(doc)).toEqual({
      chain: ["title-screen-x", "enter-name-x", "pick-opening-x", "confirm-x"],
      chatPageId: "page-1",
    });
    expect(goes(doc, "pick-opening-x")).toEqual(["confirm-x"]);
    // The confirm page goes on to the chat, and back to where the chain began
    // when it was made.
    expect(goes(doc, "confirm-x")).toEqual(["page-1", "enter-name-x"]);
  });

  it("switches between the card's own openings, one card each", () => {
    const doc = add(chatOnly(), "pick-opening");
    const choice = doc.pages[0]!.elements.find((el) => el.type === "choice") as Extract<UiDoc["pages"][0]["elements"][0], { type: "choice" }>;
    expect(choice.options.map((o) => o.title)).toEqual(["码头", "邮局", "灯塔"]);
    expect(choice.options.map((o) => o.actions?.find((a) => a.kind === "switch-greeting"))).toEqual([
      { kind: "switch-greeting", index: 0 }, { kind: "switch-greeting", index: 1 }, { kind: "switch-greeting", index: 2 },
    ]);
  });

  it("removing a page in the chain closes the gap", () => {
    let doc = add(chatOnly(), "enter-name");
    doc = add(doc, "pick-origin");
    doc = add(doc, "difficulty");
    doc = removePage(doc, "pick-origin-x");
    expect(openingChain(doc).chain).toEqual(["enter-name-x", "difficulty-x"]);
    doc = removePage(doc, "enter-name-x");
    expect(doc.entryPageId).toBe("difficulty-x");
    expect(openingChain(doc).chain).toEqual(["difficulty-x"]);
  });

  it("works over a frontend the card already had", () => {
    const base: UiDoc = { version: 1, entryPageId: "page-1", pages: [{ id: "page-1", name: "Main", height: 812, elements: [] }], surface: "chat" };
    const doc = add(base, "profile");
    expect(doc.entryPageId).toBe("profile-x");
    // The page covers what is under it.
    expect(doc.pages.find((p) => p.id === "profile-x")!.background).toBeDefined();
  });

  it("a confirm page made first lists what later pages ask, until the creator edits it", () => {
    let doc = insertPageTemplate(chatOnly(), getUiPageTemplate("confirm")!, { ...input, summary: [] }, "confirm-x");
    const summaryOf = (d: UiDoc) => (d.pages.find((p) => p.id === "confirm-x")!.elements.find((el) => el.id === "confirm-x-summary") as { text: { template: string } }).text.template;
    doc = refreshConfirmSummary(doc, [{ id: "player_name", label: "名字" }, { id: "origin", label: "出身" }], {});
    expect(summaryOf(doc)).toBe("名字：{{player_name}}\n出身：{{origin}}");
    const edited: UiDoc = { ...doc, pages: doc.pages.map((p) => ({ ...p, elements: p.elements.map((el) => (el.id === "confirm-x-summary" ? { ...el, text: { template: "都选好了" } } : el)) })) };
    expect(refreshConfirmSummary(edited, [{ id: "age", label: "年龄" }], {})).toBe(edited);
  });

  it("switching the layout keeps the opening pages in front of the new one", () => {
    let old = add(chatOnly(), "enter-name");
    old = add(old, "difficulty");
    const fresh: UiDoc = { version: 1, entryPageId: "main", pages: [{ id: "main", name: "Main", height: 812, elements: [] }] };
    const doc = carryOpeningChain(old, fresh);
    expect(openingChain(doc)).toEqual({ chain: ["enter-name-x", "difficulty-x"], chatPageId: "main" });
    expect(goes(doc, "difficulty-x")).toEqual(["main"]);
    expect(carryOpeningChain(chatOnly(), fresh)).toBe(fresh);
  });

  it("play pages share one menu: one button on the conversation, a row each on the menu", () => {
    let doc = add(add(chatOnly(), "enter-name"), "bag");
    doc = insertPageTemplate(doc, getUiPageTemplate("dice")!, input, "dice-x");
    const chat = doc.pages.find((p) => p.id === "page-1")!;
    const openers = chat.elements.filter((el) => el.type === "button");
    expect(openers.map((el) => elementActions(el))).toEqual([[{ kind: "go-page", pageId: "play-menu" }]]);
    const menu = doc.pages.find((p) => p.id === "play-menu")!;
    const rows = menu.elements.filter((el) => el.id.endsWith("-menuitem"));
    expect(rows.map((el) => elementActions(el)[0])).toEqual([{ kind: "go-page", pageId: "bag-x" }, { kind: "go-page", pageId: "dice-x" }]);
    expect(rows[0]!.x === rows[1]!.x && rows[0]!.y === rows[1]!.y).toBe(false);
    // The popup is on the conversation, where the story is when it fires.
    expect(chat.elements.some((el) => el.type === "popup" && el.variableId === "new_item")).toBe(true);
    expect(goes(doc, "bag-x")).toEqual(["page-1"]);
    expect(goes(doc, "play-menu")).toContain("page-1");
    // Not part of the opening sequence.
    expect(openingChain(doc).chain).toEqual(["enter-name-x"]);
  });

  it("the menu button keeps off the layout's own words and controls", () => {
    const busy: UiDoc = { ...chatOnly(), pages: [{ ...chatOnly().pages[0]!, elements: [
      ...chatOnly().pages[0]!.elements,
      { id: "details", type: "button", x: 283, y: 12, w: 80, h: 32, desktop: { x: 912, y: 20, w: 92, h: 36 }, label: { template: "详情" }, actions: [] },
    ] }] };
    const doc = add(busy, "status");
    const opener = doc.pages[0]!.elements.find((el) => el.id === "play-menu-opener")!;
    expect(opener.x === 283 && opener.y === 12).toBe(false);
  });

  it("the dice and the lot are drawn in the card, not by the AI", () => {
    const dice = add(chatOnly(), "dice");
    const src = compileUiDoc(dice).files["index.tsx"]!;
    expect(src).toContain("Math.floor(Math.random() * 20)");
    const draw = add(chatOnly(), "random-draw");
    const button = draw.pages.find((p) => p.id === "random-draw-x")!.elements.find((el) => el.id === "random-draw-x-draw")!;
    expect(elementActions(button)[0]).toMatchObject({ kind: "random", variableId: "draw" });
    expect((elementActions(button)[0] as { from: string[] }).from).toHaveLength(6);
  });

  it("points: plus only while points are left, minus only above the start", () => {
    const doc = add(chatOnly(), "points");
    const els = doc.pages.find((p) => p.id === "points-x")!.elements;
    expect(els.find((el) => el.id === "points-x-str-plus")!.visibleWhen).toEqual({ variableId: "points_left", operator: "gt", value: 0 });
    expect(els.find((el) => el.id === "points-x-str-minus")!.visibleWhen).toEqual({ variableId: "str", operator: "gt", value: 1 });
  });

  it("status shows the variables it is given", () => {
    const doc = insertPageTemplate(chatOnly(), getUiPageTemplate("status")!, {
      ...input, stats: [{ id: "hp", label: "生命", type: "number", max: 50 }, { id: "place", label: "地点", type: "string" }],
    }, "status-x");
    const els = doc.pages.find((p) => p.id === "status-x")!.elements;
    const meter = els.find((el) => el.type === "meter") as { value: { variableId: string }; max: { value: number } };
    expect(meter.value.variableId).toBe("hp");
    expect(meter.max.value).toBe(50);
    expect(els.some((el) => el.type === "text" && el.text.template === "{{place}}")).toBe(true);
  });

  it("uses the card's own variable when it already tracks the same thing", () => {
    const doc = insertPageTemplate(chatOnly(), getUiPageTemplate("map")!, { ...input, strings: { here: "现在在：{{location}}" } }, "map-x", { location: "当前位置" });
    const json = JSON.stringify(doc.pages.find((p) => p.id === "map-x"));
    expect(json).toContain('"variableId":"当前位置"');
    expect(json).toContain("{{当前位置}}");
    expect(json).not.toContain('"variableId":"location"');
    expect(json).not.toContain("{{location}}");
    // What was on the card before stays, except the conversation now starts
    // below the menu button instead of under it.
    const [messages, composer] = doc.pages.find((p) => p.id === "page-1")!.elements;
    const opener = doc.pages.find((p) => p.id === "page-1")!.elements.find((el) => el.id === "play-menu-opener")!;
    expect(composer).toEqual(chatOnly().pages[0]!.elements[1]);
    expect(messages!.y).toBeGreaterThanOrEqual(opener.y + opener.h);
    expect(messages!.y + messages!.h).toBe(700);
  });

  it("removing a play page takes its menu row with it; the last one takes the menu", () => {
    let doc = add(chatOnly(), "bag");
    doc = insertPageTemplate(doc, getUiPageTemplate("map")!, input, "map-x");
    doc = insertPageTemplate(doc, getUiPageTemplate("dice")!, input, "dice-x");
    doc = removePage(doc, "map-x");
    const rows = () => doc.pages.find((p) => p.id === "play-menu")?.elements.filter((el) => el.id.endsWith("-menuitem")) ?? [];
    expect(rows().map((el) => el.id)).toEqual(["bag-x-menuitem", "dice-x-menuitem"]);
    // The gap closes: dice moves into map's place.
    expect(rows()[1]!.x).not.toBe(rows()[0]!.x);
    expect(rows()[1]!.y).toBe(rows()[0]!.y);
    doc = removePage(removePage(doc, "bag-x"), "dice-x");
    expect(doc.pages.some((p) => p.id === "play-menu")).toBe(false);
    expect(doc.pages[0]!.elements.some((el) => el.id === "play-menu-opener")).toBe(false);
  });

  it("an option renamed by the creator writes its new name", () => {
    const doc = add(chatOnly(), "difficulty");
    const choice = doc.pages[0]!.elements.find((el) => el.type === "choice") as Extract<UiDoc["pages"][0]["elements"][0], { type: "choice" }>;
    expect(choice.options.every((o) => o.value === undefined)).toBe(true);
  });

  it("duplicating a page copies its parts under fresh ids, right after it", () => {
    const doc = add(chatOnly(), "enter-name");
    const next = duplicatePage(doc, "enter-name-x", { id: "page-copy1", name: "填名字 副本" });
    expect(next.pages.map((p) => p.id)).toEqual(["enter-name-x", "page-copy1", "page-1"]);
    const a = next.pages[0]!.elements.map((el) => el.id);
    const b = next.pages[1]!.elements.map((el) => el.id);
    expect(b).toHaveLength(a.length);
    expect(b.some((id) => a.includes(id))).toBe(false);
    expect(validateUiDoc(next).ok).toBe(true);
  });
});

describe("editor-only samples", () => {
  const strings = { ex1_name: "旧怀表", ex1_note: "停在三点十分", ex2_name: "半块面包", ex2_note: "", exHere: "街口" };
  it("a bag page brings sample rows under the card's own variable id", () => {
    const doc = insertPageTemplate(chatOnly(), getUiPageTemplate("bag")!, { ...input, strings }, "bag-x", { bag: "items" });
    expect(doc.editorSamples).toEqual({ items: [{ name: "旧怀表", note: "停在三点十分" }, { name: "半块面包", note: "" }] });
    expect(validateUiDoc(doc).ok).toBe(true);
    expect(Object.values(compileUiDoc(doc).files).join("")).toContain('const EDITOR_SAMPLES = {"items":[{"name":"旧怀表"');
  });
  it("keeps a sample already there and adds none without strings", () => {
    let doc = insertPageTemplate(chatOnly(), getUiPageTemplate("map")!, { ...input, strings }, "map-x");
    doc = insertPageTemplate(doc, getUiPageTemplate("status")!, { ...input, strings: { exHere: "河边" } }, "status-x");
    expect(doc.editorSamples).toEqual({ location: "街口" });
    expect(insertPageTemplate(chatOnly(), getUiPageTemplate("clues")!, input, "clues-x").editorSamples).toBeUndefined();
    expect(Object.values(compileUiDoc(chatOnly()).files).join("")).toContain("const EDITOR_SAMPLES = null;");
  });
});
