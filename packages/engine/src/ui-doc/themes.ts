import type { UiTheme } from "./types.js";

/**
 * Official themes: a card's look, picked rather than written.
 *
 * Eighty-nine percent of stored cards stop at plain text, so for nearly every
 * card in the library "the interface" is the platform's own chat — one look,
 * shared by thousands of cards that have nothing else in common. The tokens to
 * restyle that chat already exist (see TOKEN_RULES in compile.ts); what was
 * missing is a way to USE them without knowing what a CSS custom property is.
 *
 * So a theme is a named set of those tokens, and the choice is made the way a
 * slide deck makes it: pick a look, then vary it. The two axes a creator
 * actually reaches for are colour and letterform, and they are the two offered
 * — an accent that drives the surfaces a player touches, and a font stack. A
 * third, corner radius, is one control because it is the difference between a
 * terminal and a messenger and nobody wants to set four radii by hand.
 *
 * Every value here is a plain CSS string. No font files, no network: a theme
 * that needed a download would be a theme that flashes unstyled text at every
 * player on a slow connection, and a font a card OWNS is a different feature
 * (UiFontFace, uploaded as an asset).
 *
 * ── On the two background tokens ──
 *
 * `--yc-bg` paints the stage and may be a gradient. `--yc-bg-solid` is the same
 * ground as ONE colour, because a gradient is not a colour: a layout fading its
 * portrait into the page writes `linear-gradient(..., var(--yc-bg) 92%)`, and a
 * gradient substituted into a colour stop makes the whole declaration invalid —
 * the fade silently does not happen and the art ends on a hard edge. Themes
 * whose ground is flat set both tokens to the same value; the two gradient
 * themes set it to the colour their ground ENDS on, which is the colour meeting
 * anything that fades into the page from above.
 *
 * ── On Latin-before-CJK ──
 *
 * Every stack names its Latin face first and its CJK face after. A CJK font
 * usually carries its own Latin subset, so a stack that names it first never
 * falls through for the Latin range — the card's English and its numbers get
 * drawn by a face chosen for Chinese, which is how "the digits look wrong"
 * happens. Naming Latin first costs nothing for Chinese text, which the Latin
 * face has no glyphs for and passes on.
 */

export type UiThemeRadius = "sharp" | "soft" | "round";

/** The font stacks a theme can use. Names are keys; the editor labels them. */
export const UI_THEME_FONTS = {
  sans: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif`,
  serif: `Georgia, "Times New Roman", "Songti SC", SimSun, "Source Han Serif SC", "Noto Serif CJK SC", serif`,
  mono: `"SFMono-Regular", Consolas, "Liberation Mono", Menlo, "Noto Sans Mono CJK SC", NSimSun, monospace`,
  rounded: `ui-rounded, "SF Pro Rounded", Quicksand, "PingFang SC", "Hiragino Maru Gothic ProN", "Microsoft YaHei UI", system-ui, sans-serif`,
} as const;

export type UiThemeFont = keyof typeof UI_THEME_FONTS;

export interface UiThemeChoice {
  /** Which official theme. */
  id: string;
  accent?: string;
  font?: UiThemeFont;
  radius?: UiThemeRadius;
}

export interface UiThemePreset {
  id: string;
  /** Four colours for the picker's card: page, their bubble, your bubble, text. */
  swatch: { bg: string; bubble: string; user: string; text: string };
  /** Accent variants offered for this theme, the first being its default. */
  accents: string[];
  font: UiThemeFont;
  radius: UiThemeRadius;
  /** Everything the accent does not decide. */
  build(accent: string): Record<string, string>;
  /** Base radii in px, before the radius control scales them. */
  radii: { bubble: number; input: number; send: number };
}

/** How much the radius control scales a theme's own corners. */
const RADIUS_SCALE: Record<UiThemeRadius, number> = { sharp: 0, soft: 1, round: 1.7 };

export const UI_THEMES: UiThemePreset[] = [
  {
    // Light, serif, no bubbles: a page rather than a chat. The one theme that
    // leaves the platform's dark ground entirely, which is also why it has to
    // set its own text colour — cream text on cream paper is 1.09:1.
    id: "paper",
    swatch: { bg: "#f4efe6", bubble: "#f4efe6", user: "#3f6152", text: "#2b2622" },
    accents: ["#3f6152", "#8c3b3b", "#3a5478", "#8a5a2b", "#5b4570"],
    font: "serif",
    radius: "soft",
    radii: { bubble: 6, input: 12, send: 12 },
    build: (accent) => ({
      "--yc-bg": "#f4efe6",
      "--yc-bg-solid": "#f4efe6",
      "--yc-text": "#2b2622",
      "--yc-text-size": "16px",
      "--yc-line-height": "1.95",
      "--yc-name": accent,
      "--yc-bubble-bg": "transparent",
      "--yc-bubble-padding": "2px 0",
      "--yc-user-bubble-bg": `${accent}1f`,
      "--yc-user-text": "#2b2622",
      "--yc-input-bg": "#fffdf9",
      "--yc-input-fg": "#2b2622",
      "--yc-input-border": "1px solid #00000016",
      "--yc-send-bg": accent,
      "--yc-send-fg": "#fdfaf4",
      "--yc-chip-bg": "#0000000a",
      "--yc-chip-fg": "#2b2622",
    }),
  },
  {
    // The messenger look: bubbles both sides, cool ground, plain sans.
    id: "night",
    swatch: { bg: "#0c121c", bubble: "#18212f", user: "#4c7dbf", text: "#dbe4f0" },
    accents: ["#4c7dbf", "#2f8f7f", "#7a5cc4", "#c2607a", "#c9893f"],
    font: "sans",
    radius: "soft",
    radii: { bubble: 16, input: 16, send: 14 },
    build: (accent) => ({
      "--yc-bg": "linear-gradient(180deg, #0d1522 0%, #0a0f18 100%)",
      "--yc-bg-solid": "#0a0f18",
      "--yc-text": "#dbe4f0",
      "--yc-text-size": "15px",
      "--yc-line-height": "1.75",
      "--yc-name": "#8398b4",
      "--yc-bubble-bg": "#18212f",
      "--yc-bubble-padding": "10px 14px",
      "--yc-user-bubble-bg": accent,
      "--yc-user-text": "#ffffff",
      "--yc-input-bg": "#121a27",
      "--yc-input-fg": "#dbe4f0",
      "--yc-input-border": "1px solid #ffffff14",
      "--yc-send-bg": accent,
      "--yc-send-fg": "#ffffff",
      "--yc-chip-bg": "#ffffff10",
      "--yc-chip-fg": "#cfe0f5",
    }),
  },
  {
    // Monospace, square, one accent doing all the work — a machine talking.
    id: "terminal",
    swatch: { bg: "#07090b", bubble: "#07090b", user: "#101619", text: "#c8d3cc" },
    accents: ["#4ad07a", "#d8a13f", "#3fd0c8", "#d05fa0", "#b8c4bd"],
    font: "mono",
    radius: "sharp",
    radii: { bubble: 2, input: 3, send: 3 },
    build: (accent) => ({
      "--yc-bg": "#07090b",
      "--yc-bg-solid": "#07090b",
      "--yc-text": "#c8d3cc",
      "--yc-text-size": "14px",
      "--yc-line-height": "1.7",
      "--yc-name": accent,
      "--yc-bubble-bg": "transparent",
      "--yc-bubble-padding": "2px 0",
      "--yc-user-bubble-bg": "#101619",
      "--yc-user-text": "#d8e4dc",
      "--yc-input-bg": "#0b1014",
      "--yc-input-fg": "#c8d3cc",
      "--yc-input-border": `1px solid ${accent}55`,
      "--yc-send-bg": accent,
      "--yc-send-fg": "#07090b",
      "--yc-chip-bg": "#101619",
      "--yc-chip-fg": accent,
    }),
  },
  {
    // Warm dark and very round — the register most of the library is written in.
    id: "blossom",
    swatch: { bg: "#150f18", bubble: "#241a27", user: "#e8a0bf", text: "#efe3ec" },
    accents: ["#e8a0bf", "#e5c07b", "#8fd6c0", "#9fc2e8", "#c4a6e8"],
    font: "rounded",
    radius: "round",
    radii: { bubble: 14, input: 14, send: 13 },
    build: (accent) => ({
      "--yc-bg": "linear-gradient(180deg, #181119 0%, #120d14 100%)",
      "--yc-bg-solid": "#120d14",
      "--yc-text": "#efe3ec",
      "--yc-text-size": "15px",
      "--yc-line-height": "1.85",
      "--yc-name": accent,
      "--yc-bubble-bg": "#241a27",
      "--yc-bubble-padding": "10px 15px",
      "--yc-user-bubble-bg": accent,
      "--yc-user-text": "#241522",
      "--yc-input-bg": "#1e1521",
      "--yc-input-fg": "#efe3ec",
      "--yc-input-border": "1px solid #ffffff12",
      "--yc-send-bg": accent,
      "--yc-send-fg": "#241522",
      "--yc-chip-bg": "#ffffff0f",
      "--yc-chip-fg": "#f3d9e6",
    }),
  },
];

export const getUiThemePreset = (id: string): UiThemePreset | undefined =>
  UI_THEMES.find((theme) => theme.id === id);

/** The choice filled in with the preset's own defaults. */
export function resolveUiThemeChoice(choice: UiThemeChoice): Required<UiThemeChoice> | null {
  const preset = getUiThemePreset(choice.id);
  if (!preset) return null;
  return {
    id: preset.id,
    accent: choice.accent && preset.accents.includes(choice.accent) ? choice.accent : preset.accents[0]!,
    font: choice.font && choice.font in UI_THEME_FONTS ? choice.font : preset.font,
    radius: choice.radius && choice.radius in RADIUS_SCALE ? choice.radius : preset.radius,
  };
}

/**
 * A choice, as the theme a document carries.
 *
 * The choice itself travels in `preset` so the picker can show what is
 * selected — a set of tokens cannot be read back into "night, blue, round"
 * once a creator has hand-edited one of them, and guessing would light up the
 * wrong card in the gallery.
 */
export function buildUiTheme(choice: UiThemeChoice): UiTheme | null {
  const resolved = resolveUiThemeChoice(choice);
  const preset = resolved && getUiThemePreset(resolved.id);
  if (!resolved || !preset) return null;
  const scale = RADIUS_SCALE[resolved.radius];
  const px = (value: number) => `${Math.round(value * scale)}px`;
  return {
    preset: resolved,
    tokens: {
      ...preset.build(resolved.accent),
      "--yc-font": UI_THEME_FONTS[resolved.font],
      "--yc-bubble-radius": px(preset.radii.bubble),
      "--yc-input-radius": px(preset.radii.input),
      "--yc-send-radius": px(preset.radii.send),
    },
  };
}
