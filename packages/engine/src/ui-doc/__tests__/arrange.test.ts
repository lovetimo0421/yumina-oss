import { describe, expect, it } from "vitest";
import {
  alignElements, alignUnits, copyElements, distributeUnits, marqueeHits, nudgeElements, paintOrder,
  pasteElements, reorderElements, snapMove, snapResize, unitsOf,
} from "../arrange.js";
import { compileUiDoc } from "../compile.js";
import { webFontOf, webFontsHref } from "../fonts.js";
import type { UiDoc, UiElement } from "../types.js";

const box = (id: string, x: number, y: number, w: number, h: number, extra: Partial<UiElement> = {}): UiElement =>
  ({ id, type: "box", x, y, w, h, ...extra }) as UiElement;

const docOf = (elements: UiElement[]): UiDoc => ({
  version: 1, entryPageId: "p", pages: [{ id: "p", name: "P", height: 812, elements }],
});
const els = (d: UiDoc) => d.pages[0]!.elements;
const byId = (d: UiDoc, id: string) => els(d).find((e) => e.id === id)!;
const PAGE = { x: 0, y: 0, w: 375, h: 812 };

describe("units", () => {
  it("treats a group as one box", () => {
    const d = docOf([box("a", 10, 10, 20, 20, { group: "g" }), box("b", 40, 50, 10, 10, { group: "g" }), box("c", 0, 0, 5, 5)]);
    const units = unitsOf(d, "p", ["a", "b", "c"], "phone");
    expect(units).toHaveLength(2);
    expect(units[0]).toEqual({ ids: ["a", "b"], box: { x: 10, y: 10, w: 40, h: 50 } });
  });

  it("uses the desktop box on the desktop and skips parts that are off it", () => {
    const d = docOf([box("a", 10, 10, 20, 20, { desktop: { x: 100, y: 0, w: 50, h: 50 } }), box("b", 0, 0, 5, 5, { desktop: null })]);
    const units = unitsOf(d, "p", ["a", "b"], "desktop");
    expect(units).toEqual([{ ids: ["a"], box: { x: 100, y: 0, w: 50, h: 50 } }]);
  });
});

describe("align", () => {
  const units = [
    { ids: ["a"], box: { x: 10, y: 10, w: 20, h: 20 } },
    { ids: ["b"], box: { x: 50, y: 40, w: 40, h: 10 } },
  ];
  it("aligns to the selection's outer box", () => {
    expect(alignUnits(units, "left")).toEqual([{ dx: 0, dy: 0 }, { dx: -40, dy: 0 }]);
    expect(alignUnits(units, "right")).toEqual([{ dx: 60, dy: 0 }, { dx: 0, dy: 0 }]);
    expect(alignUnits(units, "bottom")).toEqual([{ dx: 0, dy: 20 }, { dx: 0, dy: 0 }]);
    expect(alignUnits(units, "hcenter")).toEqual([{ dx: 30, dy: 0 }, { dx: -20, dy: 0 }]);
  });
  it("aligns a lone part to the page", () => {
    expect(alignUnits([units[0]!], "hcenter", PAGE)).toEqual([{ dx: 168, dy: 0 }]);
    expect(alignUnits([units[0]!], "right", PAGE)).toEqual([{ dx: 345, dy: 0 }]);
  });
  it("moves whole groups on the canvas in view only", () => {
    const d = docOf([
      box("a", 10, 10, 20, 20, { group: "g" }), box("a2", 10, 30, 20, 5, { group: "g" }),
      box("b", 100, 10, 20, 20),
    ]);
    const next = alignElements(d, "p", ["a", "a2", "b"], "phone", "left");
    expect(byId(next, "b").x).toBe(10);
    expect(byId(next, "a").x).toBe(10);
    const desk = alignElements(d, "p", ["a", "a2", "b"], "desktop", "left");
    expect(byId(desk, "b").x).toBe(100);
    expect(byId(desk, "b").desktop).toEqual({ x: 10, y: 10, w: 20, h: 20 });
  });
});

describe("distribute", () => {
  it("leaves equal gaps and keeps the ends", () => {
    const units = [
      { ids: ["a"], box: { x: 0, y: 0, w: 10, h: 10 } },
      { ids: ["c"], box: { x: 90, y: 0, w: 10, h: 10 } },
      { ids: ["b"], box: { x: 20, y: 0, w: 20, h: 10 } },
    ];
    // Span 100, used 40, three gaps of... two gaps of 30.
    expect(distributeUnits(units, "horizontal")).toEqual([{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }, { dx: 20, dy: 0 }]);
  });
  it("does nothing with two", () => {
    expect(distributeUnits([{ ids: ["a"], box: PAGE }, { ids: ["b"], box: PAGE }], "vertical")).toEqual([{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }]);
  });
});

describe("nudge", () => {
  it("moves the picked parts by the step", () => {
    const d = nudgeElements(docOf([box("a", 10, 10, 5, 5), box("b", 0, 0, 5, 5)]), "p", ["a"], "phone", 10, -1);
    expect(byId(d, "a")).toMatchObject({ x: 20, y: 9 });
    expect(byId(d, "b")).toMatchObject({ x: 0, y: 0 });
  });
});

describe("stacking order", () => {
  const d = docOf([box("a", 0, 0, 1, 1), box("b", 0, 0, 1, 1), box("c", 0, 0, 1, 1), box("d", 0, 0, 1, 1)]);
  const ids = (x: UiDoc) => paintOrder(x.pages[0]!).map((e) => e.id).join("");
  it("brings forward and sends backward one step", () => {
    expect(ids(reorderElements(d, "p", ["b"], "forward"))).toBe("acbd");
    expect(ids(reorderElements(d, "p", ["c"], "backward"))).toBe("acbd");
    expect(ids(reorderElements(d, "p", ["d"], "forward"))).toBe("abcd");
  });
  it("moves a run together", () => {
    expect(ids(reorderElements(d, "p", ["a", "b"], "forward"))).toBe("cabd");
    expect(ids(reorderElements(d, "p", ["c", "d"], "backward"))).toBe("acdb");
  });
  it("to front and back", () => {
    expect(ids(reorderElements(d, "p", ["a", "c"], "front"))).toBe("bdac");
    expect(ids(reorderElements(d, "p", ["d"], "back"))).toBe("dabc");
  });
  it("does not introduce z when the page never used it", () => {
    const next = reorderElements(d, "p", ["a"], "front");
    expect(els(next).every((e) => e.z === undefined)).toBe(true);
  });
  it("rewrites z when it was in use, so order and z agree", () => {
    const z = docOf([box("a", 0, 0, 1, 1, { z: 5 }), box("b", 0, 0, 1, 1), box("c", 0, 0, 1, 1, { z: 1 })]);
    // Paint order is b(0) c(1) a(5).
    const next = reorderElements(z, "p", ["a"], "back");
    expect(ids(next)).toBe("abc");
    expect(els(next).map((e) => e.z)).toEqual([0, 1, 2]);
  });
});

describe("copy and paste", () => {
  it("gives fresh ids, a fresh group per group, and an offset", () => {
    const d = docOf([
      box("m", 10, 10, 20, 20, { group: "g1" }), box("m2", 10, 40, 20, 5, { group: "g1" }), box("x", 100, 100, 10, 10),
    ]);
    const clip = copyElements(d, "p", ["m", "m2", "x"]);
    const { doc: next, ids } = pasteElements(d, "p", clip, "el-new", "phone");
    expect(ids).toEqual(["el-new-0", "el-new-1", "el-new-2"]);
    const pasted = ids.map((id) => byId(next, id));
    expect(pasted[0]!.group).toBe(pasted[1]!.group);
    expect(pasted[0]!.group).not.toBe("g1");
    expect(pasted[2]!.group).toBeUndefined();
    expect(pasted[0]).toMatchObject({ x: 22, y: 22 });
    expect(els(next)).toHaveLength(6);
  });
  it("never collides with an id already on the page", () => {
    const d = docOf([box("s-0", 0, 0, 1, 1)]);
    const { ids } = pasteElements(d, "p", copyElements(d, "p", ["s-0"]), "s");
    expect(ids).toEqual(["s-0-2"]);
  });
  it("the clipboard is a copy, not a reference", () => {
    const d = docOf([box("a", 0, 0, 1, 1, { style: { fills: [{ kind: "color", color: "#fff" }] } } as Partial<UiElement>)]);
    const clip = copyElements(d, "p", ["a"]);
    (clip[0] as { style: { fills: unknown[] } }).style.fills.push({ kind: "color", color: "#000" });
    expect((byId(d, "a") as { style: { fills: unknown[] } }).style.fills).toHaveLength(1);
  });
});

describe("snapping", () => {
  it("snaps a moving box to the page centre", () => {
    const { box: b, guide } = snapMove({ x: 170, y: 300, w: 40, h: 40 }, [], PAGE, 6);
    expect(b.x).toBe(167.5);
    expect(guide.vertical?.x).toBe(187.5);
  });
  it("snaps to another part's edge and draws the guide across both", () => {
    const { box: b, guide } = snapMove({ x: 53, y: 200, w: 20, h: 20 }, [{ x: 10, y: 10, w: 40, h: 40 }], PAGE, 6);
    expect(b.x).toBe(50);
    expect(guide.vertical).toEqual({ x: 50, from: 10, to: 220 });
  });
  it("leaves a box alone out of reach", () => {
    const { box: b, guide } = snapMove({ x: 100, y: 100, w: 20, h: 20 }, [], PAGE, 6);
    expect(b).toEqual({ x: 100, y: 100, w: 20, h: 20 });
    expect(guide).toEqual({});
  });
  it("snaps only the edge a resize drags", () => {
    const { box: b } = snapResize({ x: 10, y: 10, w: 362, h: 30 }, { right: true }, [], PAGE, 6);
    expect(b).toEqual({ x: 10, y: 10, w: 365, h: 30 });
    const left = snapResize({ x: 4, y: 10, w: 100, h: 30 }, { left: true }, [], PAGE, 6);
    expect(left.box).toEqual({ x: 0, y: 10, w: 104, h: 30 });
  });
  it("marquee picks whole units it touches", () => {
    const units = [{ ids: ["a", "a2"], box: { x: 0, y: 0, w: 10, h: 10 } }, { ids: ["b"], box: { x: 50, y: 50, w: 10, h: 10 } }];
    expect(marqueeHits({ x: 5, y: 5, w: 10, h: 10 }, units)).toEqual(["a", "a2"]);
  });
});

describe("web fonts", () => {
  it("recognises a curated font by its stack", () => {
    expect(webFontOf(`"Noto Serif SC", serif`)?.family).toBe("Noto Serif SC");
    expect(webFontOf(`Georgia, serif`)).toBeNull();
  });
  it("loads only the fonts the doc uses, once", () => {
    const d = docOf([
      { id: "t", type: "text", x: 0, y: 0, w: 10, h: 10, text: { template: "hi" }, style: { family: `"Cinzel", serif` } } as UiElement,
      { id: "b", type: "button", x: 0, y: 0, w: 10, h: 10, label: { template: "go" }, actions: [], style: { family: `"Cinzel", serif` } } as UiElement,
    ]);
    const href = webFontsHref(d)!;
    expect(href).toContain("family=Cinzel");
    expect(href.match(/family=/g)).toHaveLength(1);
    const out = compileUiDoc(d).files["index.tsx"]!;
    expect(out).toContain("useWebFonts(");
    expect(out).toContain("function useWebFonts");
  });
  it("emits nothing for a doc without web fonts", () => {
    expect(webFontsHref(docOf([box("a", 0, 0, 1, 1)]))).toBeNull();
    expect(compileUiDoc(docOf([box("a", 0, 0, 1, 1)])).files["index.tsx"]).not.toContain("useWebFonts");
  });
});
