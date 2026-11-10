import { describe, expect, it } from "vitest";
import { compileUiDoc } from "../compile.js";
import { validateUiDoc } from "../schema.js";
import { UI_THEMES, UI_THEME_FONTS, buildUiTheme, resolveUiThemeChoice } from "../themes.js";
import type { UiDoc } from "../types.js";

const themed = (themeId: string, extra: Partial<UiDoc> = {}): UiDoc => ({
  version: 1,
  entryPageId: "page-1",
  pages: [{ id: "page-1", name: "Main", height: 812, elements: [] }],
  surface: "chat",
  theme: buildUiTheme({ id: themeId })!,
  ...extra,
});

describe("official themes", () => {
  it("every theme declares a real token for everything the chat can be styled by", () => {
    for (const preset of UI_THEMES) {
      const theme = buildUiTheme({ id: preset.id });
      expect(theme, preset.id).toBeTruthy();
      const tokens = theme!.tokens!;
      // A theme that sets a background and forgets the text colour is the one
      // failure that makes a card unreadable rather than ugly.
      expect(tokens["--yc-bg"], preset.id).toBeTruthy();
      expect(tokens["--yc-text"], preset.id).toBeTruthy();
      expect(tokens["--yc-user-text"], preset.id).toBeTruthy();
      expect(tokens["--yc-font"], preset.id).toBe(UI_THEME_FONTS[preset.font]);
      for (const [name, value] of Object.entries(tokens)) {
        expect(name.startsWith("--yc-"), `${preset.id}: ${name}`).toBe(true);
        expect(String(value).trim().length, `${preset.id}: ${name}`).toBeGreaterThan(0);
      }
    }
  });

  it("names its Latin face before its CJK one, so Latin is never drawn by a Chinese font", () => {
    const cjk = /Songti|PingFang|Hiragino|YaHei|SimSun|Noto Sans CJK|Noto Serif CJK|Noto Sans Mono CJK/;
    for (const [key, stack] of Object.entries(UI_THEME_FONTS)) {
      const families = stack.split(",").map((f) => f.trim());
      const firstCjk = families.findIndex((f) => cjk.test(f));
      expect(firstCjk, key).toBeGreaterThan(0);
    }
  });

  it("fills an incomplete choice from the theme's own defaults and refuses an unknown theme", () => {
    const preset = UI_THEMES[0]!;
    expect(resolveUiThemeChoice({ id: preset.id })).toEqual({
      id: preset.id, accent: preset.accents[0], font: preset.font, radius: preset.radius,
    });
    // A value that is not on offer falls back rather than reaching the tokens.
    expect(resolveUiThemeChoice({ id: preset.id, accent: "#bada55" })!.accent).toBe(preset.accents[0]);
    expect(resolveUiThemeChoice({ id: "nope" })).toBeNull();
    expect(buildUiTheme({ id: "nope" })).toBeNull();
  });

  it("carries the choice, so the gallery can show what is selected", () => {
    const theme = buildUiTheme({ id: "night", accent: "#7a5cc4", font: "mono", radius: "round" })!;
    expect(theme.preset).toEqual({ id: "night", accent: "#7a5cc4", font: "mono", radius: "round" });
    expect(theme.tokens!["--yc-user-bubble-bg"]).toBe("#7a5cc4");
    expect(theme.tokens!["--yc-font"]).toBe(UI_THEME_FONTS.mono);
  });

  it("the radius control moves every corner together, and square means square", () => {
    const soft = buildUiTheme({ id: "night", radius: "soft" })!.tokens!;
    const sharp = buildUiTheme({ id: "night", radius: "sharp" })!.tokens!;
    const round = buildUiTheme({ id: "night", radius: "round" })!.tokens!;
    for (const token of ["--yc-bubble-radius", "--yc-input-radius", "--yc-send-radius"]) {
      expect(sharp[token]).toBe("0px");
      expect(parseFloat(round[token]!)).toBeGreaterThan(parseFloat(soft[token]!));
    }
  });
});

describe("a themed card with no interface of its own", () => {
  it("is a valid document", () => {
    const result = validateUiDoc(themed("paper"));
    expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
  });

  it("compiles to the platform's own chat, unscaled, with the theme's rules", () => {
    const code = compileUiDoc(themed("paper")).files["index.tsx"]!;
    // The chat is the bottom layer, the way a preserved frontend is: full
    // bleed, not inside the 375-wide design stage that would scale it.
    expect(code).toContain("<Chat />");
    expect(code).toMatch(/position: "absolute", inset: 0[\s\S]*<Chat \/>/);
    // The rules that restyle it, and the ground it stands on.
    expect(code).toContain('[data-ui-stage] .play-message-content { color: var(--yc-text); }');
    expect(code).toContain('background: "var(--yc-bg)"');
  });

  it("emits a rule only for a token the card actually declared", () => {
    const bare = compileUiDoc({
      version: 1, entryPageId: "page-1",
      pages: [{ id: "page-1", name: "Main", height: 812, elements: [] }],
      surface: "chat",
    }).files["index.tsx"]!;
    expect(bare).not.toContain("--yc-");
    expect(bare).toContain("<Chat />");
  });

  it("a card with elements keeps its own arrangement over the chat", () => {
    const doc = themed("night", {
      pages: [{
        id: "page-1", name: "Main", height: 812,
        elements: [{ id: "portrait", type: "image", src: { kind: "asset", ref: "@asset:1" }, x: 0, y: 0, w: 375, h: 200 }],
      }],
    });
    const code = compileUiDoc(doc).files["index.tsx"]!;
    expect(code).toContain("<Chat />");
    expect(code).toContain('data-ui-el="portrait"');
    // The overlay still scales; only the chat underneath does not.
    expect(code).toContain('transform: "scale(" + scale + ")"');
  });
});
