import { describe, expect, it } from "vitest";
import ts from "typescript";
import { compileUiDoc } from "../compile.js";
import { UI_LOOKS, applyUiLook, currentUiLook, uiLookPartOf, uiLooksFor } from "../looks.js";
import type { UiLookPart } from "../looks.js";
import { validateUiDoc } from "../schema.js";
import type { UiDoc, UiElement } from "../types.js";

const at = { x: 20, y: 100, w: 300, h: 300 };

/** One element of every kind a look can dress. */
const SAMPLES: Record<UiLookPart, UiElement> = {
  choice: {
    id: "c", type: "choice", ...at, layout: "grid", columns: 2, variableId: "pick",
    style: { imageRatio: 0 },
    options: [{ id: "a", title: "晨", actions: [{ kind: "go-page", pageId: "p1" }] }, { id: "b", title: "Dusk" }],
  },
  field: { id: "f", type: "field", ...at, kind: "chips", variableId: "role", options: ["a", "b"], allowCustom: true },
  popup: { id: "p", type: "popup", ...at, variableId: "note", title: { template: "Found" }, body: { template: "{{value}}" } },
  list: {
    id: "l", type: "list", ...at, source: { kind: "variable", variableId: "bag" }, item: { template: "{{item.name}}" },
    card: { title: { template: "{{item.name}}" }, imageField: "icon" },
  },
  button: {
    id: "b", type: "button", ...at, label: { template: "Go" }, actions: [{ kind: "send-message", text: { template: "hi" } }],
    style: { size: 17, fills: [{ kind: "color", color: "red" }] },
  },
};

const docOf = (el: UiElement): UiDoc => ({ version: 1, entryPageId: "p1", pages: [{ id: "p1", name: "Main", height: 812, elements: [el] }] });

describe("looks", () => {
  it("has the promised number of looks per part, with unique ids", () => {
    const ids = UI_LOOKS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    const styled = (part: UiLookPart) => uiLooksFor(part).filter((l) => l.style || l.css).length;
    expect(styled("choice")).toBeGreaterThanOrEqual(4);
    expect(styled("field")).toBeGreaterThanOrEqual(3);
    expect(styled("popup")).toBeGreaterThanOrEqual(3);
    expect(styled("list")).toBeGreaterThanOrEqual(3);
    expect(styled("button")).toBeGreaterThanOrEqual(4);
  });

  for (const look of UI_LOOKS) {
    it(`${look.id} applies to a valid document that compiles to parseable TSX`, () => {
      const el = applyUiLook(SAMPLES[look.part], look.id);
      const doc = docOf(el);
      const valid = validateUiDoc(doc);
      expect(valid.ok ? [] : valid.errors).toEqual([]);
      const src = compileUiDoc(doc).files["index.tsx"]!;
      const out = ts.transpileModule(src, { reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 } });
      expect(out.diagnostics ?? []).toEqual([]);
      // The look is recognised again, except the theme default, which is the
      // absence of one.
      expect(currentUiLook(el)).toBe(look.style || look.css ? look.id : null);
    });
  }

  it("never touches content, bindings or steps", () => {
    for (const [part, el] of Object.entries(SAMPLES) as Array<[UiLookPart, UiElement]>) {
      for (const look of uiLooksFor(part)) {
        const next = applyUiLook(el, look.id) as unknown as Record<string, unknown>;
        const before = el as unknown as Record<string, unknown>;
        for (const key of Object.keys(before)) {
          if (key === "style" || key === "itemStyle" || key === "css") continue;
          expect(next[key]).toEqual(before[key]);
        }
      }
    }
  });

  it("replaces the previous look instead of piling up, and keeps the creator's own CSS", () => {
    const own = { ...SAMPLES.choice, css: "& .yp-title { color: hotpink }" } as UiElement;
    const once = applyUiLook(own, "choice-bookmark");
    const twice = applyUiLook(once, "choice-neon");
    expect(currentUiLook(twice)).toBe("choice-neon");
    expect(twice.css).not.toContain("look:choice-bookmark");
    expect(twice.css).toContain("hotpink");
    const back = applyUiLook(twice, "choice-default");
    expect(back.css).toBe("& .yp-title { color: hotpink }");
    expect((back as Extract<UiElement, { type: "choice" }>).style).toEqual({ imageRatio: 0 });
  });

  it("keeps a choice's picture setting unless the look is about pictures", () => {
    const glass = applyUiLook(SAMPLES.choice, "choice-glass") as Extract<UiElement, { type: "choice" }>;
    expect(glass.style?.imageRatio).toBe(0);
    const cover = applyUiLook(SAMPLES.choice, "choice-cover") as Extract<UiElement, { type: "choice" }>;
    expect(cover.style?.imageRatio).toBe(1.3);
  });

  it("keeps a button's type size across looks", () => {
    const outlined = applyUiLook(SAMPLES.button, "button-outline") as Extract<UiElement, { type: "button" }>;
    expect(outlined.style?.size).toBe(17);
    expect(outlined.style?.borderColor).toBeTruthy();
  });

  it("ignores a look meant for another part, and a list that is not cards", () => {
    expect(applyUiLook(SAMPLES.field, "choice-neon")).toBe(SAMPLES.field);
    const plain = { ...SAMPLES.list } as Extract<UiElement, { type: "list" }>;
    delete plain.card;
    expect(uiLookPartOf(plain)).toBeNull();
    expect(applyUiLook(plain, "list-ledger")).toBe(plain);
  });
});

describe("every look is visibly its own", () => {
  /** What a look paints, as one comparable string: its fields, its CSS and
   *  its thumbnail. Two looks that paint the same things are one look. */
  const paint = (id: string) => {
    const look = UI_LOOKS.find((l) => l.id === id)!;
    return JSON.stringify([look.style ?? null, look.css ?? "", look.swatch]);
  };

  it("no two looks of a part share their surface, their thumbnail or their CSS", () => {
    for (const part of ["choice", "field", "popup", "list", "button"] as UiLookPart[]) {
      const looks = uiLooksFor(part);
      const surfaces = looks.map((l) => JSON.stringify(l.swatch));
      expect(new Set(surfaces).size, `${part} thumbnails`).toBe(looks.length);
      expect(new Set(looks.map((l) => paint(l.id))).size, part).toBe(looks.length);
    }
  });

  it("glass is a lit, translucent pane holding its picture inset; neon is a black box with a glowing frame", () => {
    const glass = UI_LOOKS.find((l) => l.id === "choice-glass")!;
    const card = (glass.style as { card: { backdropBlur?: number; fills?: unknown[]; shadows?: Array<{ inset?: boolean }> } }).card;
    expect(card.backdropBlur).toBeGreaterThan(0);
    expect(card.fills?.[0]).toMatchObject({ kind: "gradient" });
    expect(card.shadows?.some((s) => s.inset)).toBe(true);
    expect(glass.css).toContain(".yp-card>.yp-media{width:auto;border-radius");
    expect(glass.swatch.media).toBe("inset");

    const neon = UI_LOOKS.find((l) => l.id === "choice-neon")!;
    const ncard = (neon.style as { card: { fills: Array<{ color: string }>; shadows: Array<{ blur: number; inset?: boolean }> } }).card;
    expect(ncard.fills[0]!.color).toBe("#05060a");
    expect(ncard.shadows.filter((s) => !s.inset && s.blur >= 16).length).toBeGreaterThanOrEqual(1);
    expect(neon.css).toContain("repeating-linear-gradient"); // scan lines on the picture

    // The theme default is the theme's own card: it sets nothing.
    const def = UI_LOOKS.find((l) => l.id === "choice-default")!;
    expect(def.style).toBeUndefined();
    expect(def.css).toBeUndefined();
  });

  it("offers the theme's own button, first, in the theme's accent", () => {
    const [first] = uiLooksFor("button");
    expect(first!.id).toBe("button-theme");
    expect(JSON.stringify(first!.style)).toContain("var(--yc-send-bg");
    expect((first!.style as { radius?: unknown }).radius).toBeUndefined();
    const src = compileUiDoc(docOf(applyUiLook(SAMPLES.button, "button-theme"))).files["index.tsx"]!;
    expect(src).toContain("var(--yc-send-radius, 10px)");
  });
});
