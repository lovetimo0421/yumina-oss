import { describe, expect, it } from "vitest";
import { compileUiDoc, uiDocInk } from "../compile.js";
import { composite, contrastRatio, readableThemeTokens, resolveCssColor } from "../contrast.js";
import type { Rgba } from "../contrast.js";
import { UI_STARTERS, getUiStarter } from "../starters.js";
import { UI_TEMPLATES } from "../templates.js";
import type { UiTemplatePreset } from "../templates.js";
import { UI_THEMES, buildUiTheme } from "../themes.js";
import type { UiDoc, UiElement } from "../types.js";

/** The theme as the stage draws it: the chat pairs fixed, plus the page inks. */
function stageTokens(doc: UiDoc): Record<string, string> {
  const preset = doc.theme?.preset;
  const designed = preset ? buildUiTheme(preset as never)?.tokens : undefined;
  return { ...(readableThemeTokens(doc.theme?.tokens, designed) ?? {}), ...uiDocInk(doc).tokens };
}

const isLarge = (size: number, weight: number) => size >= 24 || (size >= 18.5 && weight >= 700);

interface Reading { id: string; canvas: "phone" | "desktop"; ratio: number; before: number; large: boolean }

/** Every text element drawn in the theme's text colour, measured on the
 *  ground it lands on — after the fix, and as it was before. */
function readings(doc: UiDoc): Reading[] {
  const plan = uiDocInk(doc);
  const tokens = stageTokens(doc);
  const out: Reading[] = [];
  for (const [el, entry] of plan.elements) {
    if (el.type !== "text" || !/var\(--yc-text[,)]/.test(el.style?.color ?? "")) continue;
    for (const canvas of ["phone", "desktop"] as const) {
      const ink = entry[canvas];
      if (!ink) continue;
      const measure = (color: string) => {
        const c = resolveCssColor(color, tokens)!;
        expect(c, `${el.id} ${color}`).not.toBeNull();
        return contrastRatio(composite(c, ink.ground), ink.ground);
      };
      const size = canvas === "desktop" ? el.style?.desktopSize ?? el.style?.size ?? 14 : el.style?.size ?? 14;
      out.push({
        id: el.id,
        canvas,
        ratio: measure(ink.color ?? el.style!.color!),
        before: measure(el.style!.color!),
        large: isLarge(size, el.style?.weight ?? 400),
      });
    }
  }
  return out;
}

const floor = (r: Reading) => (r.large ? 3 : 4.5);
const failing = (doc: UiDoc) => readings(doc).filter((r) => r.ratio < floor(r)).map((r) => `${r.id}@${r.canvas} ${r.ratio.toFixed(2)}`);

/** 「粉色可爱风」 on the adventure panel: the page goes pink and the text dark
 *  rose, while the theme's dark bubble and dark composer stay. */
function pinkAdventure(): UiDoc {
  const doc = getUiStarter("adventure-panel")!.build({ strings: {}, theme: { id: "blossom" } });
  doc.theme = {
    ...doc.theme!,
    tokens: {
      ...doc.theme!.tokens,
      "--yc-bg": "#f9d3e3",
      "--yc-bg-solid": "#f9d3e3",
      "--yc-text": "#7a2e4f",
    },
  };
  return doc;
}

function templateDoc(template: UiTemplatePreset, themeId: string): UiDoc {
  const strings: Record<string, string> = { title: "Lin Zhou" };
  for (const key of template.stringKeys) strings[key] = `word:${key}`;
  const variableIds = Object.fromEntries(template.needs.map((need) => [need.key, need.key]));
  const doc = template.build({ strings, variableIds } as never);
  return { ...doc, theme: buildUiTheme({ id: themeId })! };
}

describe("resolveCssColor", () => {
  it("reads the forms parts are coloured with", () => {
    const tokens = { "--yc-text": "#2b2622", "--yc-send-bg": "#3a5478" };
    expect(resolveCssColor("var(--yc-text, #f1ece4)", tokens)).toMatchObject({ r: 0x2b, g: 0x26, b: 0x22, a: 1 });
    expect(resolveCssColor("var(--yc-missing, #f1ece4)", tokens)).toMatchObject({ r: 0xf1, a: 1 });
    const quiet = resolveCssColor("color-mix(in srgb, var(--yc-text, #f1ece4) 62%, transparent)", tokens)!;
    expect(quiet).toMatchObject({ r: 0x2b, g: 0x26, b: 0x22 });
    expect(quiet.a).toBeCloseTo(0.62);
    const mixed = resolveCssColor("color-mix(in srgb, var(--yc-send-bg, #d9a13f) 50%, #ffffff)", tokens)!;
    expect(mixed.r).toBeCloseTo((0x3a + 255) / 2);
    expect(resolveCssColor("color-mix(in oklab, #000 50%, #fff)", tokens)).toBeNull();
    expect(resolveCssColor("var(--yc-missing)", tokens)).toBeNull();
  });
});

describe("text on the page", () => {
  it("pink page, dark bubble: the page's words read on the phone and on the wide canvas's panel", () => {
    const doc = pinkAdventure();
    const all = readings(doc);
    // The case as it was: labels on the pink page at under 2:1.
    const label = all.find((r) => r.id === "where-label" && r.canvas === "phone")!;
    expect(label.before).toBeLessThan(2.5);
    expect(failing(doc)).toEqual([]);
    for (const r of all) expect(r.ratio, `${r.id}@${r.canvas}`).toBeGreaterThanOrEqual(4.5);
    // The labels on the wide canvas sit on the rail, the input surface.
    const rail = all.find((r) => r.id === "where-label" && r.canvas === "desktop")!;
    expect(rail.ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("pink page, dark bubble: the bubble keeps its own readable ink", () => {
    const doc = pinkAdventure();
    const tokens = stageTokens(doc);
    const bubble = resolveCssColor(tokens["--yc-bubble-bg"], tokens)!;
    const text = resolveCssColor(tokens["--yc-text"], tokens)!;
    expect(contrastRatio(text, bubble)).toBeGreaterThanOrEqual(4.5);
    // …and the page keeps the creator's own dark rose, not a grey.
    const plan = uiDocInk(doc);
    expect(plan.tokens["--yc-page-text"]).toBe("#7a2e4f");
    expect(plan.tokens["--yc-page-text-muted"]).toBeDefined();
  });

  it("pink page: a list's empty line on the page gets the page's quiet ink", () => {
    const doc = pinkAdventure();
    const plan = uiDocInk(doc);
    const bag = doc.pages[0]!.elements.find((el) => el.id === "bag")!;
    const vars = plan.elements.get(bag)?.phone?.vars;
    expect(vars?.["--ui-ground-muted"]).toBe("var(--yc-page-text-muted)");
    const tokens = stageTokens(doc);
    const ground = plan.elements.get(bag)!.phone!.ground;
    expect(contrastRatio(resolveCssColor("var(--yc-page-text-muted)", tokens)!, ground)).toBeGreaterThanOrEqual(4.5);
    const src = compileUiDoc(doc).files["index.tsx"]!;
    expect(src).toContain(".yp-empty");
    expect(src).toContain("--yp-ground-muted");
  });

  it("素纸: every label and caption on every starter and layout reads at 4.5:1", () => {
    for (const starter of UI_STARTERS) {
      for (const accent of UI_THEMES.find((t) => t.id === "paper")!.accents) {
        const doc = starter.build({ strings: {}, theme: { id: "paper", accent } });
        expect(failing(doc), `${starter.id} ${accent}`).toEqual([]);
        for (const r of readings(doc)) expect(r.ratio, `${starter.id} ${r.id}@${r.canvas}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    for (const template of UI_TEMPLATES) {
      expect(failing(templateDoc(template, "paper")), template.id).toEqual([]);
    }
    // The case as it was: 素纸's quiet labels at 4.1:1.
    const doc = getUiStarter("character-setup")!.build({ strings: {}, theme: { id: "paper" } });
    const sub = readings(doc).find((r) => r.id === "form-sub" && r.canvas === "phone")!;
    expect(sub.before).toBeLessThan(4.5);
  });

  it("an official preset whose words already read compiles exactly as before", () => {
    for (const theme of UI_THEMES.filter((t) => t.id !== "paper")) {
      for (const accent of theme.accents) {
        for (const starter of UI_STARTERS) {
          const doc = starter.build({ strings: {}, theme: { id: theme.id, accent } });
          const plan = uiDocInk(doc);
          expect(plan.tokens, `${starter.id} ${theme.id}`).toEqual({});
          expect(plan.css).toEqual([]);
          const moved = [...plan.elements].filter(([, e]) => e.phone?.color || e.phone?.vars || e.desktop?.color || e.desktop?.vars);
          expect(moved.map(([el]) => el.id), `${starter.id} ${theme.id} ${accent}`).toEqual([]);
          expect(failing(doc)).toEqual([]);
        }
      }
      for (const template of UI_TEMPLATES) {
        const plan = uiDocInk(templateDoc(template, theme.id));
        expect(plan.tokens, `${template.id} ${theme.id}`).toEqual({});
      }
    }
  });

  it("every page ink the compiled card uses is defined on its stage", () => {
    for (const doc of [pinkAdventure(), getUiStarter("character-setup")!.build({ strings: {}, theme: { id: "paper" } })]) {
      const src = compileUiDoc(doc).files["index.tsx"]!;
      const used = new Set([...src.matchAll(/var\((--yc-(?:page|panel)-text(?:-muted)?)\)/g)].map((m) => m[1]!));
      expect(used.size).toBeGreaterThan(0);
      for (const name of used) expect(src, name).toContain(`"${name}": "#`);
    }
  });

  it("leaves what it cannot judge: no theme page, an image page, a part over an image", () => {
    const bare = getUiStarter("adventure-panel")!.build({ strings: {} });
    delete bare.theme;
    expect(uiDocInk(bare).elements.size).toBe(0);

    const imaged = pinkAdventure();
    imaged.pages[0]!.background = { kind: "image", src: { kind: "url", url: "https://example.com/a.png" } } as never;
    expect(uiDocInk(imaged).elements.size).toBe(0);

    const covered = pinkAdventure();
    const photo: UiElement = { id: "photo", type: "image", x: 0, y: 0, w: 375, h: 812, src: { kind: "url", url: "https://example.com/a.png" } } as never;
    covered.pages[0]!.elements.unshift(photo);
    const plan = uiDocInk(covered);
    const label = covered.pages[0]!.elements.find((el) => el.id === "where-label")!;
    expect(plan.elements.get(label)?.phone).toBeUndefined();
  });

  it("a text part on a light box on a dark page is measured against the box", () => {
    const doc = getUiStarter("adventure-panel")!.build({ strings: {}, theme: { id: "night" } });
    const els = doc.pages[0]!.elements;
    const card: UiElement = { id: "note-card", type: "box", x: 10, y: 300, w: 300, h: 80, desktop: null, style: { fills: [{ kind: "color", color: "#fff6e0" }] } };
    const note: UiElement = {
      id: "note", type: "text", x: 20, y: 310, w: 280, h: 20, desktop: null,
      text: { template: "hello" }, style: { size: 13, color: "var(--yc-text, #f1ece4)" },
    };
    els.push(card, note);
    const r = readings(doc).find((x) => x.id === "note" && x.canvas === "phone")!;
    expect(r.before).toBeLessThan(2);
    expect(r.ratio).toBeGreaterThanOrEqual(4.5);
    const ground: Rgba = uiDocInk(doc).elements.get(note)!.phone!.ground;
    expect(ground).toMatchObject({ r: 0xff, g: 0xf6, b: 0xe0 });
  });
});
