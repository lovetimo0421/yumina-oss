import { describe, it, expect } from "vitest";
import { compileUiDoc, stockChatTopBand } from "../compile.js";
import type { UiDoc, UiElement, UiPage } from "../types.js";
import { validateUiDoc } from "../schema.js";
import { remapDocVariable } from "../variable-refs.js";

const pageOf = (elements: UiElement[]): UiPage => ({ id: "p1", name: "Main", height: 812, elements });
const stockDoc = (elements: UiElement[]): UiDoc => ({ version: 1, entryPageId: "p1", surface: "chat", pages: [pageOf(elements)] });

const label: UiElement = { id: "t", type: "text", x: 16, y: 12, w: 120, h: 20, text: "信任度" } as unknown as UiElement;
const meter: UiElement = { id: "m", type: "meter", x: 16, y: 32, w: 220, h: 10 } as UiElement;

describe("stock chat top band", () => {
  it("one-click displays survive validation and renaming and reserve space over a handwritten frontend", () => {
    const doc: UiDoc = { ...stockDoc([]), surface: undefined, base: { file: "_base.tsx" } };
    doc.pages[0]!.elements = [{
      id: "rooms", type: "list", variableDisplay: "rooms", x: 16, y: 32, w: 343, h: 72,
      desktop: { x: 16, y: 32, w: 992, h: 72 },
      source: { kind: "variable", variableId: "rooms" }, item: { template: "{{item}}" },
    }];
    const checked = validateUiDoc(doc);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.doc.pages[0]!.elements[0]!.variableDisplay).toBe("rooms");
    const renamed = remapDocVariable(checked.doc, "rooms", "roster");
    expect(renamed.pages[0]!.elements[0]!.variableDisplay).toBe("roster");
    expect(compileUiDoc(renamed).files["index.tsx"]).toContain('"p1": { phone: 112, desktop: 112 }');
    doc.pages[0]!.elements = [];
    expect(compileUiDoc(doc).files["index.tsx"]).not.toContain("CHAT_TOP_BAND");
  });
  it("a label and a meter across the top push the chat below them", () => {
    expect(stockChatTopBand(pageOf([label, meter]), "phone")).toBe(50);
    const out = compileUiDoc(stockDoc([label, meter])).files["index.tsx"]!;
    expect(out).toContain("const CHAT_TOP_BAND = {");
    expect(out).toContain(`"p1": { phone: 50, desktop: 50 },`);
    expect(out).toContain("CHAT_TOP_BAND[page]");
  });

  it("a picture filling the page is a backdrop, not a bar", () => {
    const backdrop = { id: "bg", type: "image", x: 0, y: 0, w: 375, h: 812 } as UiElement;
    expect(stockChatTopBand(pageOf([backdrop]), "phone")).toBe(0);
  });

  it("a card with nothing across its top compiles the chat full-bleed, as before", () => {
    const out = compileUiDoc(stockDoc([])).files["index.tsx"]!;
    expect(out).not.toContain("CHAT_TOP_BAND");
    expect(out).toContain(`<div style={{ position: "absolute", inset: 0 }}>`);
  });
});

describe("stock chat under a doc that draws its own (2026-10-15, two chats stacked)", () => {
  const chatCount = (doc: UiDoc) => compileUiDoc(doc).files["index.tsx"]!.match(/<Chat\b/g)?.length ?? 0;
  const ownChat = { id: "story-chat", type: "chat", x: 0, y: 60, w: 375, h: 752 } as UiElement;

  it("a surface-chat doc with a chat part on any page compiles one chat, not two", () => {
    const doc: UiDoc = {
      ...stockDoc([]),
      pages: [pageOf([]), { id: "story", name: "Story", height: 812, elements: [ownChat] }],
    };
    expect(chatCount(doc)).toBe(1);
    // Same output as the doc with surface cleared — the shape the editor leaves.
    expect(compileUiDoc(doc).files["index.tsx"]).toBe(compileUiDoc({ ...doc, surface: undefined }).files["index.tsx"]);
  });

  it("half a chat counts too: a composer alone would sit over the stock input", () => {
    const composer = { id: "c", type: "composer", x: 0, y: 740, w: 375, h: 60 } as UiElement;
    expect(compileUiDoc(stockDoc([composer])).files["index.tsx"]).not.toContain("typeof Chat !== \"undefined\" ? <Chat />");
  });

  it("a doc with no chat of its own keeps the platform chat underneath", () => {
    expect(chatCount(stockDoc([label]))).toBe(1);
  });

  it("a custom part that mounts its own <Chat> keeps the stock chat underneath, as it always has", () => {
    const custom = { id: "mine", type: "custom", x: 0, y: 0, w: 375, h: 812, code: `return <Chat className="mine" />;` } as UiElement;
    const out = compileUiDoc(stockDoc([custom])).files["index.tsx"]!;
    expect(out).toContain(`<div style={{ position: "absolute", inset: 0 }}>\n        {typeof Chat !== "undefined" ? <Chat /> : null}`);
    expect(out).toContain(`<Chat className="mine" />`);
  });
});
