import { describe, it, expect } from "vitest";
import { compileUiDoc, stockChatTopBand } from "../compile.js";
import type { UiDoc, UiElement, UiPage } from "../types.js";

const pageOf = (elements: UiElement[]): UiPage => ({ id: "p1", name: "Main", height: 812, elements });
const stockDoc = (elements: UiElement[]): UiDoc => ({ version: 1, entryPageId: "p1", surface: "chat", pages: [pageOf(elements)] });

const label: UiElement = { id: "t", type: "text", x: 16, y: 12, w: 120, h: 20, text: "信任度" } as unknown as UiElement;
const meter: UiElement = { id: "m", type: "meter", x: 16, y: 32, w: 220, h: 10 } as UiElement;

describe("stock chat top band", () => {
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
