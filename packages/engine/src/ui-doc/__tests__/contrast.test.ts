import { describe, it, expect } from "vitest";
import { contrastRatio, parseCssColor, readableOn, readableThemeTokens, MIN_TEXT_CONTRAST } from "../contrast.js";
import { UI_THEMES, buildUiTheme } from "../themes.js";

const c = (s: string) => parseCssColor(s)!;
const ratio = (fg: string, bg: string) => contrastRatio(c(fg), c(bg));

describe("contrast", () => {
  it("parses the colour forms themes use", () => {
    expect(c("#fff")).toMatchObject({ r: 255, g: 255, b: 255, a: 1 });
    expect(c("#e8a0bf1f").a).toBeCloseTo(0x1f / 255);
    expect(c("rgba(0, 0, 0, 0.5)")).toMatchObject({ r: 0, a: 0.5 });
    expect(c("hsl(0, 100%, 50%)")).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(parseCssColor("linear-gradient(#000, #fff)")).toBeNull();
    expect(parseCssColor("var(--x)")).toBeNull();
  });

  it("computes WCAG ratios", () => {
    expect(ratio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(ratio("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
  });

  it("readableOn keeps a readable ink and fixes an unreadable one", () => {
    const ok = readableOn(c("#111111"), c("#ffffff"));
    expect(ok).toMatchObject({ r: 17, g: 17, b: 17 });
    const fixed = readableOn(c("#8a4a64"), c("#241a27"));
    expect(contrastRatio(fixed, c("#241a27"))).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });
});

describe("readableThemeTokens", () => {
  it("fixes the 粉色可爱风 restyle: pink page, dark rose text left on the dark bubble and composer", () => {
    const tokens: Record<string, string> = {
      ...buildUiTheme({ id: "blossom" })!.tokens,
      "--yc-bg": "linear-gradient(180deg, #fff0f6 0%, #ffe4ef 100%)",
      "--yc-bg-solid": "#ffe4ef",
      "--yc-text": "#8a4a64",
      "--yc-input-fg": "#8a4a64",
    };
    const out = readableThemeTokens(tokens)!;
    expect(ratio(out["--yc-text"]!, out["--yc-bubble-bg"]!)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(out["--yc-input-fg"]!, out["--yc-input-bg"]!)).toBeGreaterThanOrEqual(4.5);
    // The surfaces — the design — are untouched.
    expect(out["--yc-bubble-bg"]).toBe(tokens["--yc-bubble-bg"]);
    expect(out["--yc-bg"]).toBe(tokens["--yc-bg"]);
  });

  it("measures a see-through bubble against the page, and supplies ink for a light bubble with none", () => {
    const out = readableThemeTokens({ "--yc-bg-solid": "#ffffff", "--yc-bubble-bg": "#ffd6e7", "--yc-user-bubble-bg": "#00000010", "--yc-user-text": "#eeeeee" })!;
    expect(out["--yc-text"]).toBeDefined();
    expect(ratio(out["--yc-text"]!, "#ffd6e7")).toBeGreaterThanOrEqual(4.5);
    expect(ratio(out["--yc-user-text"]!, "#f0f0f0")).toBeGreaterThanOrEqual(4.4);
  });

  it("leaves what it cannot judge, and returns the same object when nothing changes", () => {
    const tokens = { "--yc-bubble-bg": "linear-gradient(#000,#111)", "--yc-text": "#000000" };
    expect(readableThemeTokens(tokens)).toBe(tokens);
    const fine = { "--yc-bg-solid": "#000000", "--yc-text": "#ffffff" };
    expect(readableThemeTokens(fine)).toBe(fine);
  });

  it("an official preset draws exactly as designed; a pair someone changed is held to the line", () => {
    for (const theme of UI_THEMES) {
      for (const accent of theme.accents) {
        const tokens = buildUiTheme({ id: theme.id, accent })!.tokens!;
        expect(readableThemeTokens(tokens, tokens)).toBe(tokens);
      }
    }
    const designed = buildUiTheme({ id: "blossom" })!.tokens!;
    const pink = { ...designed, "--yc-bg-solid": "#ffe4ef", "--yc-text": "#8a4a64" };
    const out = readableThemeTokens(pink, designed)!;
    expect(ratio(out["--yc-text"]!, designed["--yc-bubble-bg"]!)).toBeGreaterThanOrEqual(4.5);
  });
});
