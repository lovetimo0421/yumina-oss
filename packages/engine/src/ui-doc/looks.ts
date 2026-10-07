import type {
  UiBoxStyle,
  UiButtonStyle,
  UiChoiceStyle,
  UiElement,
  UiFieldStyle,
  UiPopupStyle,
} from "./types.js";

/**
 * Looks: a part's style in one click — 「换个样子」.
 *
 * A look is a set of STYLE fields and nothing else. It never touches what a
 * part says or does (its cards, its question, its steps), and it locks nothing:
 * after one is applied every field it set is an ordinary field the side panel
 * and the Studio assistant can change, and the part is exactly as editable as
 * one styled by hand. That is the whole difference between a look and a
 * template.
 *
 * Colours are theme tokens wherever the look is about SHAPE (glass, outline,
 * underline), so the same look reads right under 素纸 and under 夜航. A few
 * looks are about MATERIAL (paper) and bring their own ground and ink — and
 * then they redefine the part's own tokens (`--yp-text`, `--yp-ground`, …) for
 * their subtree, so every piece inside the part, tags and tiles included,
 * follows the material instead of half of it following the theme.
 *
 * That redefinition, and the few layout touches no style field can express,
 * live in the element's free CSS inside a marked block:
 *
 *     /* look:bookmark *\/ … /* /look *\/
 *
 * The marker is how a look is recognised again ("currently: 纸本书签") and
 * replaced cleanly by the next one, while CSS the creator wrote outside the
 * block is left alone.
 *
 * Pure data, so the editor's thumbnails and the Studio assistant's
 * `apply_look` op read the same list.
 */

export type UiLookPart = "choice" | "field" | "popup" | "list" | "button";

/** What the thumbnail in the side panel draws: a small card in the look's own
 *  colours. Plain CSS strings that may use the theme's `--yc-*` tokens — the
 *  panel paints them under the card's theme so the thumbnail is honest. */
export interface UiLookSwatch {
  bg: string;
  fg: string;
  sub?: string;
  border?: string;
  radius: number;
  shadow?: string;
  /** A band across the top of the thumbnail, for looks that are about the
   *  picture (a cover card) or a stripe (a banner). */
  band?: string;
  /** The thumbnail's second line is a hairline, not text — underline fields. */
  underline?: boolean;
  /** Where a card's picture sits: across the top, inset in the card, or
   *  under the words. Cards without it draw only their words. */
  media?: "bleed" | "inset" | "cover";
  font?: string;
}

export interface UiLook {
  id: string;
  part: UiLookPart;
  /** For the Studio assistant and the English/Chinese fallbacks; the editor
   *  labels looks from its own locale files by id. */
  name: { zh: string; en: string };
  /** The fields written. For a list it is the rows' `itemStyle`. */
  style?: UiChoiceStyle | UiFieldStyle | UiPopupStyle | UiBoxStyle | UiButtonStyle;
  /** Written inside the look's marked block in the element's CSS. */
  css?: string;
  swatch: UiLookSwatch;
}

// ── Shared pieces ──────────────────────────────────────────────────────────

const ACCENT = "var(--yc-send-bg, #d9a13f)";
const ON_ACCENT = "var(--yc-send-fg, #1d1406)";
const TEXT = "var(--yc-text, #f1ece4)";
const GROUND = "var(--yc-bg-solid, #15171d)";
const mix = (a: string, pct: number, b = "transparent") => `color-mix(in srgb, ${a} ${pct}%, ${b})`;
/** The accent pushed toward light, for a glow that reads on black even when
 *  the theme's accent is a muted one. */
const NEON = `color-mix(in oklab, ${ACCENT} 72%, #ffffff)`;

/** Paper and ink, for the looks that are about a material. */
const PAPER = "#f4ecdc";
const INK = "#2e2720";
const INK_SOFT = "#6b5d4f";
const SERIF = `Georgia, "Times New Roman", "Songti SC", SimSun, "Source Han Serif SC", "Noto Serif CJK SC", serif`;
const PAPER_TOKENS = `--yp-text:${INK};--yp-ground:${PAPER};--yp-card:${PAPER};--yp-card-solid:${PAPER};--yp-line:rgba(46,39,32,.16);--yp-muted:${INK_SOFT};--yp-shade:rgba(40,28,14,.35)`;

// ── 卡片选择 ───────────────────────────────────────────────────────────────

const CHOICE_LOOKS: UiLook[] = [
  {
    id: "choice-default",
    part: "choice",
    name: { zh: "主题默认", en: "Theme default" },
    swatch: { bg: "var(--yc-input-bg, #1b1e26)", fg: TEXT, sub: mix(TEXT, 60), border: mix(TEXT, 14), radius: 10, media: "bleed" },
  },
  {
    id: "choice-glass",
    part: "choice",
    name: { zh: "玻璃卡片", en: "Frosted glass" },
    style: {
      card: {
        // A pane lighter than whatever is behind it, with a sheen across the
        // top: the difference from the theme's solid card has to read at a
        // glance even on a flat ground, where the blur alone shows nothing.
        fills: [{ kind: "gradient", angle: 165, stops: [{ color: mix(TEXT, 36), at: 0 }, { color: mix(TEXT, 17), at: 45 }, { color: mix(TEXT, 10), at: 100 }] }],
        backdropBlur: 20,
        borderColor: mix(TEXT, 42),
        borderWidth: 1,
        radius: 22,
        shadows: [
          { x: 0, y: 1, blur: 0, color: mix(TEXT, 45), inset: true },
          { x: 0, y: 0, blur: 0, spread: 1, color: "rgba(0,0,0,0.12)" },
          { x: 0, y: 26, blur: 46, spread: -24, color: "rgba(0,0,0,0.6)" },
        ],
      },
      selected: { borderColor: ACCENT, borderWidth: 1.5, shadows: [{ x: 0, y: 1, blur: 0, color: mix(TEXT, 45), inset: true }, { x: 0, y: 0, blur: 0, spread: 3, color: mix(ACCENT, 35) }] },
      title: { size: 15, weight: 600, letterSpacing: 0.2 },
    },
    // The picture sits INSIDE the pane, inset and rounded — a sheet of glass
    // holding something — and a soft highlight runs across the pane.
    css: [
      "& .yp-card{padding:9px}",
      "& .yp-card::after{content:\"\";position:absolute;inset:0;border-radius:inherit;background:linear-gradient(115deg,rgba(255,255,255,.22) 0%,rgba(255,255,255,.05) 30%,transparent 44%);pointer-events:none}",
      "& .yp-card>.yp-media{width:auto;border-radius:15px;box-shadow:0 0 0 1px rgba(255,255,255,.14),0 8px 18px -10px rgba(0,0,0,.6)}",
      "& .yp-body{padding:11px 8px 8px}",
      "& .yp-tag{background:rgba(255,255,255,.14);color:var(--yp-text)}",
    ].join(" "),
    swatch: { bg: `linear-gradient(165deg, ${mix(TEXT, 42)}, ${mix(TEXT, 14)} 60%)`, fg: TEXT, sub: mix(TEXT, 70), border: mix(TEXT, 50), radius: 12, shadow: `inset 0 1px 0 ${mix(TEXT, 50)}`, media: "inset" },
  },
  {
    id: "choice-bookmark",
    part: "choice",
    name: { zh: "纸本书签", en: "Paper bookmark" },
    style: {
      card: {
        fills: [{ kind: "gradient", angle: 180, stops: [{ color: "#f8f1e3", at: 0 }, { color: PAPER, at: 100 }] }],
        borderColor: "rgba(46,39,32,0.14)",
        borderWidth: 1,
        radius: [3, 3, 14, 3],
        shadows: [
          { x: 0, y: 1, blur: 0, color: "rgba(255,255,255,0.7)", inset: true },
          { x: 0, y: 16, blur: 26, spread: -18, color: "rgba(20,12,4,0.55)" },
        ],
      },
      selected: { borderColor: ACCENT, borderWidth: 2 },
      title: { size: 16, weight: 600, color: INK, family: SERIF, letterSpacing: 0.4 },
      subtitle: { color: INK_SOFT, family: SERIF },
    },
    css: `& .yp-card{${PAPER_TOKENS}} & .yp-body{padding:12px 14px 14px}`,
    swatch: { bg: PAPER, fg: INK, sub: INK_SOFT, border: "rgba(46,39,32,.16)", radius: 3, font: SERIF, media: "bleed" },
  },
  {
    id: "choice-neon",
    part: "choice",
    name: { zh: "霓虹框", en: "Neon frame" },
    style: {
      card: {
        fills: [{ kind: "color", color: "#05060a" }],
        borderColor: NEON,
        borderWidth: 1.5,
        radius: 4,
        shadows: [
          { x: 0, y: 0, blur: 14, color: mix(NEON, 45), inset: true },
          { x: 0, y: 0, blur: 16, spread: 1, color: mix(NEON, 80) },
          { x: 0, y: 0, blur: 48, spread: -2, color: mix(NEON, 50) },
        ],
      },
      selected: {
        borderColor: "#ffffff",
        borderWidth: 2,
        shadows: [
          { x: 0, y: 0, blur: 16, color: mix(NEON, 60), inset: true },
          { x: 0, y: 0, blur: 26, spread: 2, color: NEON },
        ],
      },
      title: { size: 15, weight: 700, letterSpacing: 1.4, color: mix(NEON, 55, "#ffffff"), textShadow: { x: 0, y: 0, blur: 10, color: NEON } },
      subtitle: { color: "rgba(235,240,250,0.66)", letterSpacing: 0.4 },
    },
    // Lit from inside a black box whatever the theme's ground: the picture is
    // a screen — tinted to the accent, with scan lines — and the frame has
    // corner ticks.
    css: [
      "& .yp-card{--yp-text:#eef2f8;--yp-muted:rgba(235,240,250,.66);--yp-ground:#05060a;padding:6px}",
      "& .yp-card>.yp-media{width:auto;border-radius:2px;box-shadow:inset 0 0 0 1px " + mix(NEON, 55) + "}",
      "& .yp-card>.yp-media img{filter:saturate(.75) contrast(1.05)}",
      "& .yp-card>.yp-media::after{content:\"\";position:absolute;inset:0;background:repeating-linear-gradient(0deg,rgba(0,0,0,.34) 0 1px,transparent 1px 3px),linear-gradient(180deg," + mix(NEON, 26) + ",transparent 55%," + mix(NEON, 22) + ");mix-blend-mode:normal;pointer-events:none}",
      "& .yp-card::before{content:\"\";position:absolute;inset:3px;z-index:2;pointer-events:none;background:linear-gradient(" + NEON + "," + NEON + ") 0 0/10px 2px no-repeat,linear-gradient(" + NEON + "," + NEON + ") 0 0/2px 10px no-repeat,linear-gradient(" + NEON + "," + NEON + ") 100% 100%/10px 2px no-repeat,linear-gradient(" + NEON + "," + NEON + ") 100% 100%/2px 10px no-repeat}",
      "& .yp-tag{background:transparent;border:1px solid " + mix(NEON, 60) + ";color:" + mix(NEON, 45, "#ffffff") + "}",
    ].join(" "),
    swatch: { bg: "#05060a", fg: mix(NEON, 55, "#ffffff"), sub: "rgba(235,240,250,.6)", border: NEON, radius: 3, shadow: `0 0 10px ${mix(NEON, 70)}, inset 0 0 8px ${mix(NEON, 40)}`, media: "inset" },
  },
  {
    id: "choice-cover",
    part: "choice",
    name: { zh: "大图封面", en: "Full cover" },
    style: {
      card: { radius: 16, borderColor: "transparent", borderWidth: 1 },
      selected: { borderColor: ACCENT, borderWidth: 2 },
      title: { size: 18, weight: 700, letterSpacing: 0.3 },
      imageRatio: 1.3,
    },
    // The picture fills the card and the words sit on it, on their own dark
    // ground — legible over any picture, which the theme's text colour is not.
    css: [
      "& .yp-grid>.yp-card{justify-content:flex-end;min-height:180px;color:#fff}",
      "& .yp-grid>.yp-card>.yp-media{position:absolute;inset:0;aspect-ratio:auto!important}",
      "& .yp-grid>.yp-card>.yp-media::after{content:\"\";position:absolute;left:0;right:0;bottom:0;height:62%;background:linear-gradient(180deg,transparent,rgba(6,6,10,.86));pointer-events:none}",
      "& .yp-grid>.yp-card>.yp-body{position:relative;z-index:1;padding:14px 14px 15px}",
      // Two lines kept for every subtitle, so a row of cards shares one
      // baseline for its titles whether a subtitle wraps or not.
      "& .yp-grid .yp-sub{color:rgba(255,255,255,.8);min-height:2.9em}",
      "& .yp-grid .yp-tag{background:rgba(255,255,255,.16);color:#fff}",
      "& .yp-grid .yp-glyph{left:16px;top:14px;bottom:auto;font-size:60px;letter-spacing:0;opacity:.95}",
    ].join(" "),
    swatch: { bg: `linear-gradient(180deg, ${mix(ACCENT, 60, GROUND)} 0%, #0b0b10 100%)`, fg: "#ffffff", sub: "rgba(255,255,255,.75)", radius: 10, media: "cover" },
  },
];

// ── 填写项 ─────────────────────────────────────────────────────────────────

const FIELD_LOOKS: UiLook[] = [
  {
    id: "field-default",
    part: "field",
    name: { zh: "主题默认", en: "Theme default" },
    swatch: { bg: "var(--yc-input-bg, #1b1e26)", fg: TEXT, border: mix(TEXT, 16), radius: 8 },
  },
  {
    id: "field-underline",
    part: "field",
    name: { zh: "下划线", en: "Underline" },
    style: {
      label: { size: 11.5, weight: 600, letterSpacing: 1.2, color: mix(TEXT, 60) },
      input: { fills: [{ kind: "color", color: "transparent" }], radius: 0 },
    },
    css: [
      "& .yp-input{border-width:0 0 1.5px;border-color:var(--yp-line);box-shadow:none;padding-left:1px;padding-right:1px}",
      "& .yp-input:focus{border-color:var(--yp-accent);box-shadow:0 1.5px 0 var(--yp-accent)}",
      "& .yp-chipset .yp-chip{background:transparent;border-width:0 0 1.5px;border-color:transparent;border-radius:0;padding:6px 2px;margin-right:6px;color:var(--yp-muted)}",
      "& .yp-chipset .yp-chip[aria-checked=\"true\"]{background:transparent;color:var(--yp-text);border-color:var(--yp-accent);box-shadow:none}",
    ].join(" "),
    swatch: { bg: "transparent", fg: TEXT, radius: 0, underline: true },
  },
  {
    id: "field-filled",
    part: "field",
    name: { zh: "实底", en: "Filled" },
    style: {
      label: { size: 12.5, weight: 600, color: mix(TEXT, 72) },
      input: { fills: [{ kind: "color", color: mix(TEXT, 8) }], borderColor: "transparent", borderWidth: 1, radius: 12 },
      chip: { fills: [{ kind: "color", color: mix(TEXT, 8) }], borderColor: "transparent", borderWidth: 1, radius: 10 },
      chipSelected: { fills: [{ kind: "color", color: ACCENT }], textColor: ON_ACCENT },
    },
    swatch: { bg: mix(TEXT, 9), fg: TEXT, radius: 8 },
  },
  {
    id: "field-pill",
    part: "field",
    name: { zh: "胶囊", en: "Pill" },
    style: {
      label: { size: 13, weight: 600 },
      input: { fills: [{ kind: "color", color: "transparent" }], borderColor: mix(TEXT, 24), borderWidth: 1, radius: 999 },
      chip: { fills: [{ kind: "color", color: "transparent" }], borderColor: mix(TEXT, 24), borderWidth: 1, radius: 999 },
      chipSelected: { fills: [{ kind: "color", color: mix(ACCENT, 20) }], borderColor: ACCENT, textColor: TEXT },
    },
    css: "& .yp-input{padding-left:18px;padding-right:18px}",
    swatch: { bg: "transparent", fg: TEXT, border: mix(TEXT, 28), radius: 999 },
  },
];

// ── 弹窗 ───────────────────────────────────────────────────────────────────

const POPUP_LOOKS: UiLook[] = [
  {
    id: "popup-default",
    part: "popup",
    name: { zh: "主题默认", en: "Theme default" },
    swatch: { bg: "var(--yc-input-bg, #1b1e26)", fg: TEXT, sub: mix(TEXT, 60), border: mix(TEXT, 14), radius: 10 },
  },
  {
    id: "popup-letter",
    part: "popup",
    name: { zh: "信笺", en: "Letter" },
    style: {
      card: {
        fills: [{ kind: "gradient", angle: 180, stops: [{ color: "#faf4e8", at: 0 }, { color: PAPER, at: 100 }] }],
        borderColor: "rgba(46,39,32,0.12)",
        borderWidth: 1,
        radius: 6,
      },
      title: { size: 20, weight: 600, color: INK, family: SERIF, align: "center", letterSpacing: 1 },
      body: { size: 15, color: "#3b332b", family: SERIF, lineHeight: 1.9 },
      button: { fills: [{ kind: "color", color: INK }], textColor: PAPER, radius: 4, weight: 600 },
    },
    css: `&.yp{${PAPER_TOKENS}} & .yp-pop-body{padding:28px 26px 12px} & .yp-pop-title{padding:0 22px}`,
    swatch: { bg: PAPER, fg: INK, sub: INK_SOFT, border: "rgba(46,39,32,.14)", radius: 4, font: SERIF },
  },
  {
    id: "popup-banner",
    part: "popup",
    name: { zh: "横幅", en: "Banner" },
    style: {
      card: { radius: [6, 16, 16, 6] },
      title: { size: 15, weight: 700, color: mix(ACCENT, 60, TEXT), letterSpacing: 0.4 },
      body: { size: 14, lineHeight: 1.7 },
      button: { fills: [{ kind: "color", color: "transparent" }], textColor: mix(ACCENT, 60, TEXT), borderColor: mix(ACCENT, 60), borderWidth: 1, radius: 10, size: 14 },
    },
    css: "&.yp{border-left:4px solid var(--yp-accent)} & .yp-pop-body{padding:16px 18px 6px;gap:5px} &.yp>.yp-confirm{min-height:38px;margin:6px 16px 14px;box-shadow:none}",
    swatch: { bg: "var(--yc-input-bg, #1b1e26)", fg: mix(ACCENT, 60, TEXT), sub: mix(TEXT, 60), radius: 6, band: "stripe" },
  },
  {
    id: "popup-reward",
    part: "popup",
    name: { zh: "获得", en: "Reward" },
    style: {
      card: {
        fills: [
          { kind: "gradient", angle: 180, stops: [{ color: mix(ACCENT, 22, "var(--yc-input-bg, #1b1e26)"), at: 0 }, { color: "var(--yc-input-bg, #1b1e26)", at: 60 }] },
        ],
        borderColor: mix(ACCENT, 55),
        borderWidth: 1,
        radius: 22,
        shadows: [{ x: 0, y: 0, blur: 50, spread: -12, color: mix(ACCENT, 55) }],
      },
      title: { size: 22, weight: 800, align: "center", letterSpacing: 0.6 },
      body: { size: 14.5, align: "center", lineHeight: 1.75 },
      button: { fills: [{ kind: "color", color: ACCENT }], textColor: ON_ACCENT, radius: 999, weight: 700 },
    },
    css: "& .yp-pop-body{padding:28px 24px 10px;align-items:center} & .yp-pop-title{padding:0 18px}",
    swatch: { bg: `linear-gradient(180deg, ${mix(ACCENT, 25, "#15171d")}, #15171d 70%)`, fg: TEXT, sub: mix(TEXT, 60), border: mix(ACCENT, 60), radius: 12, shadow: `0 0 14px -4px ${mix(ACCENT, 60)}` },
  },
];

// ── 列表卡片 ───────────────────────────────────────────────────────────────

const LIST_LOOKS: UiLook[] = [
  {
    id: "list-default",
    part: "list",
    name: { zh: "主题默认", en: "Theme default" },
    swatch: { bg: "var(--yc-input-bg, #1b1e26)", fg: TEXT, sub: mix(TEXT, 60), border: mix(TEXT, 14), radius: 8 },
  },
  {
    id: "list-tiles",
    part: "list",
    name: { zh: "图块", en: "Tiles" },
    style: {
      // Soft, borderless, washed in the accent: a set of tiles, where the
      // theme default is a stack of outlined cards.
      fills: [{ kind: "gradient", angle: 150, stops: [{ color: mix(ACCENT, 30), at: 0 }, { color: mix(ACCENT, 10), at: 100 }] }],
      borderColor: "transparent",
      borderWidth: 1,
      radius: 18,
    },
    css: [
      "& .yp-card{box-shadow:none}",
      "& .yp-media{border-radius:13px;margin:6px 6px 0;width:auto}",
      "& .yp-thumb>.yp-media{margin:6px 0 6px 6px}",
      "& .yp-title{font-weight:700}",
      "& .yp-card[data-locked]{border-style:solid;border-color:transparent;opacity:.8}",
    ].join(" "),
    swatch: { bg: `linear-gradient(150deg, ${mix(ACCENT, 30)}, ${mix(ACCENT, 10)})`, fg: TEXT, sub: mix(TEXT, 60), radius: 12 },
  },
  {
    id: "list-ledger",
    part: "list",
    name: { zh: "账簿", en: "Ledger" },
    style: { fills: [{ kind: "color", color: "transparent" }], radius: 0 },
    // Rows ruled off by hairlines instead of boxed: a record, not a deck.
    css: "&.yp{gap:0!important} & .yp-card{border-width:0 0 1px;border-style:solid;border-color:var(--yp-line);border-radius:0;box-shadow:none;background:transparent} & button.yp-card:hover{transform:none;background:color-mix(in srgb,var(--yp-text) 4%,transparent)} & .yp-thumb>.yp-media{border-radius:8px;margin:8px 0}",
    swatch: { bg: "transparent", fg: TEXT, sub: mix(TEXT, 60), radius: 0, underline: true },
  },
  {
    id: "list-album",
    part: "list",
    name: { zh: "相册", en: "Album" },
    style: {
      fills: [{ kind: "color", color: "#f6f1e7" }],
      borderColor: "rgba(46,39,32,0.10)",
      borderWidth: 1,
      radius: 4,
      shadows: [{ x: 0, y: 10, blur: 22, spread: -14, color: "rgba(0,0,0,0.55)" }],
    },
    // A print with a white border: the picture sits inside the paper.
    css: `& .yp-card{${PAPER_TOKENS};--yp-card:#f6f1e7;padding:7px 7px 0} & .yp-media{border-radius:2px} & .yp-thumb{padding:7px} & .yp-title{font-family:${SERIF}}`,
    swatch: { bg: "#f6f1e7", fg: INK, sub: INK_SOFT, radius: 3, band: "print", font: SERIF },
  },
];

// ── 按钮 ───────────────────────────────────────────────────────────────────

const BUTTON_LOOKS: UiLook[] = [
  {
    // The theme's own button — the same colour, ink and corners as the send
    // button in the chat — so a card's buttons match the rest of the theme.
    // Radius is left unset on purpose: an unstyled button takes the theme's
    // send-button corners (see the button case in compile.ts).
    id: "button-theme",
    part: "button",
    name: { zh: "主题默认", en: "Theme default" },
    style: {
      fills: [{ kind: "color", color: ACCENT }],
      textColor: ON_ACCENT,
      weight: 650,
    },
    swatch: { bg: ACCENT, fg: ON_ACCENT, radius: 6 },
  },
  {
    id: "button-solid",
    part: "button",
    name: { zh: "实心", en: "Solid" },
    // Raised: lit from the top, with a glow under it — the theme default is
    // the flat version.
    style: {
      fills: [{ kind: "gradient", angle: 180, stops: [{ color: `color-mix(in oklab, ${ACCENT} 78%, #ffffff)`, at: 0 }, { color: ACCENT, at: 55 }, { color: `color-mix(in oklab, ${ACCENT} 85%, #000000)`, at: 100 }] }],
      textColor: ON_ACCENT,
      radius: 999,
      weight: 700,
      shadows: [
        { x: 0, y: 1, blur: 0, color: "rgba(255,255,255,0.35)", inset: true },
        { x: 0, y: 12, blur: 24, spread: -10, color: mix(ACCENT, 80) },
      ],
    },
    swatch: { bg: `linear-gradient(180deg, color-mix(in oklab, ${ACCENT} 78%, #ffffff), ${ACCENT} 55%, color-mix(in oklab, ${ACCENT} 85%, #000000))`, fg: ON_ACCENT, radius: 999, shadow: `0 4px 10px -3px ${mix(ACCENT, 80)}` },
  },
  {
    id: "button-outline",
    part: "button",
    name: { zh: "描边", en: "Outline" },
    style: {
      fills: [{ kind: "color", color: "transparent" }],
      textColor: mix(ACCENT, 62, TEXT),
      borderColor: mix(ACCENT, 80),
      borderWidth: 1.5,
      radius: 12,
      weight: 600,
    },
    swatch: { bg: "transparent", fg: mix(ACCENT, 62, TEXT), border: mix(ACCENT, 80), radius: 8 },
  },
  {
    id: "button-soft",
    part: "button",
    name: { zh: "柔底", en: "Soft" },
    style: {
      fills: [{ kind: "color", color: mix(ACCENT, 20) }],
      textColor: mix(ACCENT, 50, TEXT),
      radius: 999,
      weight: 600,
    },
    swatch: { bg: mix(ACCENT, 22), fg: mix(ACCENT, 50, TEXT), radius: 999 },
  },
  {
    id: "button-glass",
    part: "button",
    name: { zh: "玻璃", en: "Glass" },
    style: {
      fills: [{ kind: "color", color: mix(TEXT, 10) }],
      textColor: TEXT,
      borderColor: mix(TEXT, 22),
      borderWidth: 1,
      backdropBlur: 12,
      radius: 14,
      weight: 600,
      shadows: [{ x: 0, y: 1, blur: 0, color: mix(TEXT, 18), inset: true }],
    },
    swatch: { bg: mix(TEXT, 12), fg: TEXT, border: mix(TEXT, 24), radius: 9 },
  },
];

export const UI_LOOKS: UiLook[] = [...CHOICE_LOOKS, ...FIELD_LOOKS, ...POPUP_LOOKS, ...LIST_LOOKS, ...BUTTON_LOOKS];

export const getUiLook = (id: string): UiLook | undefined => UI_LOOKS.find((look) => look.id === id);

/** Which kind of look an element takes, if any. A list takes looks only once
 *  its rows are cards — a plain text list has nothing for a card look to do. */
export function uiLookPartOf(el: Pick<UiElement, "type"> & { card?: unknown }): UiLookPart | null {
  switch (el.type) {
    case "choice":
    case "field":
    case "popup":
    case "button":
      return el.type;
    case "list":
      return el.card && typeof el.card === "object" ? "list" : null;
    default:
      return null;
  }
}

export const uiLooksFor = (part: UiLookPart): UiLook[] => UI_LOOKS.filter((look) => look.part === part);

const LOOK_BLOCK = /\/\* look:([\w-]+) \*\/[\s\S]*?\/\* \/look \*\/\s*/;

/** The look an element was last given, read off its CSS marker. */
export function currentUiLook(el: { css?: string }): string | null {
  const m = typeof el.css === "string" ? LOOK_BLOCK.exec(el.css) : null;
  return m ? m[1]! : null;
}

/** Fields of a button's style that are about its words rather than its look,
 *  and so survive a change of look: a creator who made the label bigger still
 *  wants it bigger on the outline button. */
const BUTTON_KEEP = ["size", "desktopSize", "family", "letterSpacing", "padding"] as const;

/**
 * The element with a look applied. Content, bindings, steps, geometry and
 * the creator's own CSS outside the look's block are untouched; the style
 * fields the look owns are replaced wholesale, so looks never pile up on top
 * of each other. The theme-default looks clear the style back to nothing.
 */
export function applyUiLook<T extends UiElement>(el: T, lookId: string): T {
  const look = getUiLook(lookId);
  const part = uiLookPartOf(el as UiElement & { card?: unknown });
  if (!look || !part || look.part !== part) return el;
  const next = { ...el } as UiElement & Record<string, unknown>;
  const style = look.style ? structuredCloneSafe(look.style) : undefined;

  if (part === "list") {
    if (style) next.itemStyle = style as UiBoxStyle;
    else delete next.itemStyle;
  } else if (part === "button") {
    const prev = ((el as { style?: UiButtonStyle }).style ?? {}) as Record<string, unknown>;
    const kept: Record<string, unknown> = {};
    for (const key of BUTTON_KEEP) if (prev[key] !== undefined) kept[key] = prev[key];
    const merged = { ...kept, ...((style ?? {}) as Record<string, unknown>) };
    if (Object.keys(merged).length) next.style = merged as UiButtonStyle;
    else delete next.style;
  } else if (part === "choice") {
    const prev = (el as { style?: UiChoiceStyle }).style;
    const merged: UiChoiceStyle = { ...((style ?? {}) as UiChoiceStyle) };
    // Whether the cards carry pictures is a content decision, not a look —
    // unless the look is ABOUT the picture, which says so by setting it.
    if (merged.imageRatio === undefined && prev?.imageRatio !== undefined) merged.imageRatio = prev.imageRatio;
    if (Object.keys(merged).length) next.style = merged;
    else delete next.style;
  } else {
    if (style) next.style = style as UiFieldStyle | UiPopupStyle;
    else delete next.style;
  }

  const own = typeof el.css === "string" ? el.css.replace(LOOK_BLOCK, "").trim() : "";
  const isDefault = !look.style && !look.css;
  const block = isDefault ? "" : `/* look:${look.id} */ ${look.css ?? ""} /* /look */`;
  const css = [block, own].filter(Boolean).join("\n");
  if (css) next.css = css;
  else delete next.css;
  return next as T;
}

function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
