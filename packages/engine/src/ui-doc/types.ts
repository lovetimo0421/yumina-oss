import type { Condition } from "../types/index.js";

/**
 * The uiDoc: a card's interface as a document instead of as code.
 *
 * Eleven percent of stored cards have a real frontend. The other 89% stop at
 * plain text, and the reason is structural rather than a matter of taste: the
 * only way to put a portrait, a meter or a button on screen is to write TSX.
 * The no-code tier existed once (stat-bar / text-display / image-panel /
 * inventory-grid / web-panel) and was deleted in the v1→v2 unification, so
 * today the ladder goes "text story" then straight to "write React".
 *
 * This is that missing rung. The doc is the single source of truth — a drag
 * editor edits it, and the Studio agent edits it too, so the two can never
 * disagree about what the card looks like. It COMPILES to the TSX the sandbox
 * already runs (see compile.ts), which means no second renderer, no second
 * contract, and the board's live preview works on day one.
 *
 * What the shape is made of is not a taste call either. Across the 38 real
 * frontends in the library: 92% animate something, 87% render a list, 66% have
 * buttons, 61% have meters, 50% show an image or portrait, 58% read or write
 * variables, 45% send a message to the AI. The commonest single skeleton is
 * image + meters + buttons + list.
 *
 * ── On freedom ──
 *
 * A fixed element table with a fixed style schema has a ceiling, and a builder
 * whose ceiling you can feel is a builder you leave. The escape hatch is
 * therefore not a door out of the tool ("export to code, never come back") but
 * a zoom level inside it, and it comes in three grades that all edit this one
 * document:
 *
 *   1. Presets — a material pack, applied in one click.
 *   2. Properties — every visual property, including the platform's own chat
 *      components, reached through the CSS custom properties in `UiTheme`.
 *   3. Free CSS and free code — `UiElementBase.css` per element, `UiTheme.css`
 *      for the card, and the `custom` element for a block of hand-written TSX
 *      that still gets dragged, positioned and conditionally shown like every
 *      other element.
 *
 * Grade 3 is what makes the promise true: we cannot foresee every property a
 * creator will want to change, but the sandbox's chat surface already carries
 * 29 stable hand-written `play-*` class hooks (play-composer-card,
 * play-composer-textarea, play-message-block, play-user-message-shell, …), and
 * a selector can reach what a schema field never anticipated. Publishing those
 * hooks makes them a contract — `message-input.tsx` can no longer rename them
 * freely — and that is the price of the promise.
 */

export const UI_DOC_VERSION = 1;

/**
 * The design canvas is a fixed 375px-wide phone page, the width cards already
 * lay out at (the board preview scales 300/375 off the same number). Elements
 * are placed absolutely on it and the whole stage scales to fit its container,
 * preserving aspect — so what the creator arranges is what every player sees,
 * which is the entire premise of a slides-style editor.
 */
export const UI_CANVAS_W = 375;

/**
 * The wide canvas, for the same card on a screen that is not a phone.
 *
 * A uiDoc used to be one 375x812 arrangement scaled to fit, which on a desktop
 * meant a column down the middle of the window with a third of the width used
 * and two empty gutters. A card is played on both, so it is laid out for both:
 * same elements, same bindings, same colours, a second set of coordinates.
 *
 * 1024x640 is the shape a browser window actually is, and dividing it gives the
 * layouts what a phone cannot — art beside the conversation rather than above
 * it, and a transcript that can be held to a readable measure instead of
 * stretching the full width of a monitor.
 */
export const UI_DESKTOP_W = 1024;
export const UI_DESKTOP_H = 640;

/** Where an element sits on the wide canvas. `null` takes it off that canvas
 *  entirely — a phone's cramped header row has parts a desktop does not need. */
export type UiDesktopBox = { x: number; y: number; w: number; h: number } | null;

export interface UiDoc {
  version: number;
  pages: UiPage[];
  /** The page shown when the card opens. */
  entryPageId: string;
  /** Card-wide fonts, style tokens and free CSS. */
  theme?: UiTheme;
  /**
   * The platform's own chat, underneath, unscaled — the same bottom layer a
   * preserved frontend gets, for a card that never had one.
   *
   * This is what a card gets when its creator picks a THEME without opening
   * the builder: the interface they already had, restyled. Elements arranged
   * later overlay it exactly as they overlay a preserved frontend, so picking
   * a look and building a screen are the same ladder rather than two doors.
   */
  surface?: "chat";
  /**
   * Variables the editor created on the creator's behalf when a part needed
   * one (a form question's answer, a popup's message). Only these are ever
   * removed automatically — when the part that needed one is deleted or
   * pointed elsewhere and nothing else in the card reads it. A variable the
   * creator made themselves is never on this list.
   */
  autoVariables?: string[];
  /**
   * What a variable looks like once the story has filled it, shown only while
   * the creator is arranging the screen. A bag page added to a new card is an
   * empty box with 「还什么都没有。」; with two sample items the creator sees
   * the page they are actually making. Players never see these: in play an
   * empty variable is empty.
   */
  editorSamples?: Record<string, UiEditorSample>;
  /**
   * A card that already HAD a frontend keeps it — this names the file it
   * lives in (a sibling in the same rootComponent), and the compiled output
   * renders it as the bottom layer, unscaled, exactly as it rendered before
   * the visual editor ever touched the card. Typed elements become an overlay
   * in the usual 375-design space above it.
   *
   * This is what makes adoption LOSSLESS for the cards with real frontends:
   * there is only ever one frontend — the one the player sees — and opening
   * the builder re-expresses that same frontend rather than starting a rival.
   * Decomposing the base into real elements is a separate, explicit act (the
   * AI conversion), never a side effect of opening the editor.
   */
  base?: {
    /** Entry file of the preserved frontend, relative to the rootComponent. */
    file: string;
    /**
     * Style knobs decomposed OUT of the base code — the "拆积木" result. Each
     * knob is a visual constant (a colour, a piece of display text, a size)
     * that the base file reads from the generated `_knobs.tsx` module instead
     * of hardcoding, so the builder can edit it without understanding the
     * code around it. Groups mirror the visual regions of the frontend
     * ("夜晚横幅", "敲门", …); the decomposition step tags each region's DOM
     * with `data-knob-group="<id>"` so the canvas can hit-test a click
     * straight to its group.
     */
    groups?: UiKnobGroup[];
  };
}

/** One visual region of a preserved frontend, holding its editable knobs. */
export interface UiKnobGroup {
  id: string;
  label: string;
  knobs: UiKnob[];
}

/** One editable visual constant of a preserved frontend. */
export interface UiKnob {
  /** Key the base code reads: `K["night.title-color"]`. */
  id: string;
  label: string;
  kind: "color" | "text" | "number";
  value: string | number;
  /** For number knobs: slider bounds and step, purely presentational. */
  min?: number;
  max?: number;
  step?: number;
  /** For number knobs: unit hint shown beside the field ("em", "px", "rem"). */
  unit?: string;
}

export interface UiPage {
  id: string;
  name: string;
  /** Canvas height in design px. Width is always UI_CANVAS_W. */
  height: number;
  /** Height of the wide canvas; defaults to UI_DESKTOP_H. */
  desktopHeight?: number;
  background?: UiBackground;
  /**
   * Step aside by itself: while this page is on screen and `when` holds, the
   * card shows `pageId` instead. The opening screen that should be there only
   * until the player has started talking is
   * `{ when: { variableId: "$chat.started", operator: "eq", value: true }, pageId: "chat" }`.
   * Never applied in the editor, where a creator has to be able to stay on
   * the page to arrange it.
   */
  leaveWhen?: { when: Condition; pageId: string };
  elements: UiElement[];
}

export type UiBackground =
  | { kind: "color"; color: string }
  /** `dim` darkens the picture (0..0.9) so words on it stay readable. */
  | { kind: "image"; src: UiImageSrc; fit?: UiFit; dim?: number };

/** Where an image comes from: a fixed asset, or whatever ref a variable holds
 *  right now (how cards swap backgrounds as the story moves). */
export type UiImageSrc =
  | { kind: "asset"; ref: string }
  | { kind: "variable"; variableId: string; fallback?: string };

export type UiFit = "cover" | "contain" | "fill";

/** A number that is either fixed or read live off a variable. */
export type UiNumber =
  | { kind: "literal"; value: number }
  | { kind: "variable"; variableId: string; fallback?: number };

/**
 * Text with `{{variableId}}` interpolation — deliberately the same macro shape
 * creators already write in prompts and entries, so the syntax is one thing to
 * learn rather than two.
 */
export interface UiText {
  template: string;
}

export interface UiAnimation {
  kind: "fade" | "rise" | "pulse";
  durationMs: number;
  delayMs?: number;
}

// ── Paint ──────────────────────────────────────────────────────────────────
//
// Fills are a LIST, not a single colour, because that is what a material is:
// parchment is a texture over a tint, frosted glass is a translucent wash over
// a backdrop blur, a metal plate is a gradient plus a hairline. CSS composites
// stacked backgrounds natively, so the list costs the compiler one join and
// buys the whole materials tier. Index 0 paints on top, matching both the CSS
// `background` shorthand and the way a layer list reads.

export interface UiGradientStop {
  color: string;
  /** Position along the gradient, 0–100. */
  at: number;
}

export type UiFill =
  | { kind: "color"; color: string }
  | { kind: "gradient"; angle?: number; stops: UiGradientStop[] }
  // No per-layer opacity: CSS composites stacked backgrounds but gives them no
  // individual alpha, and faking it costs the single-background-string model
  // that makes the whole stack one property. A creator who wants a faded
  // texture stacks a translucent colour fill over it, which is what a designer
  // does anyway.
  | { kind: "image"; src: UiImageSrc; fit?: UiFit; repeat?: boolean };

export interface UiShadow {
  x: number;
  y: number;
  blur: number;
  spread?: number;
  color: string;
  /** Cast inward. An inner shadow is how a surface reads as recessed. */
  inset?: boolean;
}

/** One radius for every corner, or four in CSS order (TL TR BR BL) — a bubble
 *  with one square corner and a tab need per-corner control. */
export type UiRadius = number | [number, number, number, number];

export interface UiTextStyle {
  size?: number;
  /**
   * Size on the wide canvas, when it should differ.
   *
   * The two canvases are 375 and 1024 design-px across, so the same number is
   * a different size RELATIVE to the card: a 24px name is a heading on a phone
   * and a caption on a monitor. Absent means the one size serves both, which
   * is true of body copy and false of almost every heading.
   */
  desktopSize?: number;
  color?: string;
  weight?: number;
  align?: "left" | "center" | "right";
  lineHeight?: number;
  italic?: boolean;
  /** A family named in `UiTheme.fonts`, or a raw CSS font stack. */
  family?: string;
  letterSpacing?: number;
  transform?: "none" | "uppercase" | "lowercase" | "capitalize";
  textShadow?: UiShadow;
  stroke?: { width: number; color: string };
  /** Render the text through the chat's markdown pipeline. */
  markdown?: boolean;
  /**
   * Keep the text on one line and end it with an ellipsis when it does not
   * fit.
   *
   * The default is to wrap, which is right for prose and wrong for a readout:
   * a text element clips at its box with no scrollbar, so a place name one
   * word too long for its chip does not overflow, it silently loses its
   * second line. "Somewhere unnam…" is a worse name and a better readout,
   * because the reader can see that something was cut.
   */
  nowrap?: boolean;
}

export interface UiBoxStyle {
  fills?: UiFill[];
  radius?: UiRadius;
  borderColor?: string;
  borderWidth?: number;
  borderStyle?: "solid" | "dashed" | "dotted";
  shadows?: UiShadow[];
  /** Frosted glass: blurs whatever is behind the element, in px. Pair it with a
   *  translucent colour fill — that is what frosted glass actually is. */
  backdropBlur?: number;
  padding?: number;
}

export interface UiMeterStyle {
  fills?: UiFill[];
  track?: UiFill[];
  radius?: UiRadius;
  /** Drain right-to-left instead of filling left-to-right. */
  reverse?: boolean;
}

export interface UiButtonStyle extends UiBoxStyle {
  textColor?: string;
  size?: number;
  /** Size on the wide canvas — see UiTextStyle.desktopSize. */
  desktopSize?: number;
  weight?: number;
  family?: string;
  letterSpacing?: number;
}

// ── Theme ──────────────────────────────────────────────────────────────────

/** An uploaded font file, loaded through the sandbox's existing `useAssetFont`
 *  (src/lib/asset-font.ts) — which scopes the family name per asset so two
 *  cards shipping different files under the same family cannot collide. */
export interface UiFontFace {
  /** What `UiTextStyle.family` and `var(--font-<slug>)` refer to. */
  family: string;
  /** `@asset:<id>` reference to the font file. */
  ref: string;
  fallback?: string;
  weight?: number;
  style?: "normal" | "italic";
}

export interface UiTheme {
  /**
   * Which official theme this is, and how it was varied. Kept because a set of
   * tokens cannot be read back into "night, blue, round" — the gallery has to
   * be told what is selected rather than guess, and a creator who hand-edits a
   * token has not stopped being on that theme.
   */
  preset?: { id: string; accent: string; font: string; radius: string };
  fonts?: UiFontFace[];
  /**
   * CSS custom properties written onto the stage root. This is the bridge to
   * the platform's own chat components: `message-input.tsx` and friends read
   * `var(--yc-input-bg, <original>)`, so a token set here restyles them and an
   * absent token leaves every existing card byte-identical.
   */
  tokens?: Record<string, string>;
  /**
   * Card-level free CSS, emitted verbatim. Its targets are the sandbox's
   * `play-*` hooks. Unscoped on purpose — the card already renders inside its
   * own sandbox, so the blast radius is the card, and scoping would break the
   * portalled popovers (message actions, model picker) that render outside the
   * stage subtree.
   */
  css?: string;
}

// ── Elements ───────────────────────────────────────────────────────────────

export interface UiElementBase {
  id: string;
  /** Creator-facing label in the layers list. Never rendered. */
  name?: string;
  /**
   * Parts that are one THING to the person editing.
   *
   * A meter is three elements — its label, its live value and its track — and
   * nobody thinks of those as three. Selecting any of them selects the group,
   * recolouring recolours the group, and deleting deletes the group rather
   * than leaving an orphaned label over a hole. Elements without a group are
   * their own unit, which is every element a hand-built document has.
   */
  group?: string;
  /**
   * This element's box on the wide canvas. Absent means "the same numbers as
   * the phone", which is right for a full-bleed backdrop and wrong for almost
   * everything else — so the official layouts set it on every part they place.
   */
  desktop?: UiDesktopBox;
  x: number;
  y: number;
  w: number;
  h: number;
  z?: number;
  opacity?: number;
  rotation?: number;
  /** On screen only while this holds — how a card shows a portrait for the
   *  character who is actually present. */
  visibleWhen?: Condition;
  animation?: UiAnimation;
  /**
   * Free CSS scoped to this element. Emitted inside `[data-ui-el="<id>"] { … }`
   * and relying on native CSS nesting, so a bare `.play-composer-card { … }`
   * inside it means "within this element" and `&:hover` means the element
   * itself — with no CSS parser in the compiler to get subtly wrong.
   */
  css?: string;
}

/**
 * What a button does. Every action maps to one call the sandbox already
 * exposes, so the vocabulary is a curated subset of a contract that exists
 * rather than a new one. Destructive members of that API (restartChat wipes a
 * playthrough with no confirmation) are deliberately not offered here.
 *
 * `regenerate` and `copy-message` act on the last assistant message and go
 * through the same `api.regenerateMessage` / `api.copyToClipboard` the bubble's
 * own hover toolbar calls (message-actions.tsx) — one behaviour, not two.
 */
export type UiAction =
  | { kind: "set-variable"; variableId: string; op: "set" | "add" | "subtract" | "toggle"; value?: number | string | boolean }
  | { kind: "send-message"; text: UiText }
  | { kind: "go-page"; pageId: string }
  /**
   * Start from another opening. `index` is what the player's chat counts
   * (enabled openings with text, in order); `greetingId` names the opening
   * itself, so the index can be recounted when openings are added, removed
   * or reordered (see syncGreetingActions). Older documents have only index.
   */
  | { kind: "switch-greeting"; index: number; greetingId?: string }
  /**
   * Draw something by chance and write it to a variable — one of `from`, or a
   * whole number between `min` and `max` (a die is 1..20). The draw happens
   * here, in the card, so the AI is told the result rather than choosing it.
   */
  | { kind: "random"; variableId: string; from?: string[]; min?: number; max?: number }
  | { kind: "play-audio"; trackId: string }
  | { kind: "stop-audio"; trackId?: string }
  | { kind: "toast"; text: UiText }
  /**
   * Set off one of the card's behaviours: the one listening for this button
   * (`when: action:fired` with this `actionId`). Whatever a behaviour can do
   * (open a setting, play music, tell the AI something) a button now can,
   * written once on the canvas instead of again in the interface.
   */
  | {
      kind: "run-behavior";
      actionId: string;
      /** What the button passes in (商品: 伞, 价格: 30). Each value is text
       *  that may read variables ({{金币}}); the behaviour reads it as
       *  {参数.商品}. */
      params?: Array<{ name: string; value: UiText }>;
    }
  /** Call one of the card's UI-based AIs (worker trigger { on: "ui" }) by its
   *  worldbook id: it answers into the story — a line, values, or nothing. */
  | { kind: "run-ai"; aiId: string }
  | { kind: "regenerate" }
  | { kind: "copy-message" }
  /**
   * Take the conversation back to before the last exchange.
   *
   * The bubble toolbar has offered this since long before uiDoc existed
   * (`api.revertToMessage`), but only on hover over a specific message — which
   * a player on a touch screen never discovers. A layout that puts it on the
   * card is not adding a capability, it is admitting one exists.
   */
  | { kind: "rewind" };

/** Where a list's rows come from: a json ARRAY variable (the live case — an
 *  inventory, a clue log, a roster) or a fixed authored list. Authored rows may
 *  be records, so a collection can carry a title, a body and a picture per row
 *  without inventing a variable to hold them. */
export type UiEditorSample = string | Array<string | Record<string, string>>;

export type UiListSource =
  | { kind: "variable"; variableId: string }
  | { kind: "static"; items: Array<string | Record<string, string>> }
  /**
   * The card's own entries (设定): one kind of them (`role`, e.g. the
   * characters) or one of the creator's folders. Rows read like hand-written
   * ones (`title`, `body`, `image`), so a cast page lists the cast the creator
   * wrote, and grows when a character is added. `body` is an entry's first
   * line, and only for an entry the player may read (not `audience: "ai"`).
   */
  | { kind: "entries"; role?: string; folderId?: string };

/**
 * A list row drawn as a card instead of one line of text: a picture, a title,
 * a line under it, a badge. Every field is a template over the row, so
 * `{{item.name}}` / `{{item}}` / `{{index}}` work as in the list's `item`.
 */
export interface UiListCard {
  title?: UiText;
  subtitle?: UiText;
  badge?: UiText;
  /** Name of the row field holding an asset ref (`@asset:…`) for the picture. */
  imageField?: string;
  /** Picture height ÷ width. Absent: a square thumbnail beside the text. */
  imageRatio?: number;
  /**
   * Draw the row locked until a variable admits it: the variable (a json array
   * of ids, or an object of id → truthy) must contain the row's `field`. How a
   * collection shows what is still to find — the row is there, greyed, with
   * `lockedText` in place of its title — rather than simply absent.
   */
  lockedUnless?: { variableId: string; field: string };
  lockedText?: UiText;
}

/**
 * One card in a `choice`. What it IS is up to the creator — an opening, an
 * identity, a route, a companion — which is the point: one part, many uses,
 * rather than a picker shaped after any one card.
 */
export interface UiChoiceOption {
  id: string;
  title: string;
  subtitle?: string;
  /** Longer text, shown in list layout and under a carousel card. */
  detail?: string;
  image?: UiImageSrc;
  /** Drive the tag filter chips above the cards. */
  tags?: string[];
  /** What is written to the choice's variable; defaults to `title`. */
  value?: string;
  /**
   * Run when this option is taken — on tap, or on the confirm button when the
   * choice has one. Typically one `switch-greeting` (each card an opening),
   * but any action sequence. `{{choice}}` in these actions reads this
   * option's value.
   */
  actions?: UiAction[];
}

export interface UiChoiceStyle {
  card?: UiBoxStyle;
  /** Layered over `card` on picked options. */
  selected?: UiBoxStyle;
  title?: UiTextStyle;
  subtitle?: UiTextStyle;
  /** Picture height ÷ width. 0 hides pictures. */
  imageRatio?: number;
}

/** What kind of answer a `field` takes. */
export type UiFieldKind = "text" | "textarea" | "chips" | "number" | "slider";

export interface UiFieldStyle {
  label?: UiTextStyle;
  input?: UiBoxStyle & { textColor?: string; size?: number };
  chip?: UiBoxStyle & { textColor?: string };
  /** Layered over `chip` on the picked one. */
  chipSelected?: UiBoxStyle & { textColor?: string };
}

export interface UiPopupStyle {
  /** The dim layer behind the card. */
  scrim?: string;
  card?: UiBoxStyle;
  title?: UiTextStyle;
  body?: UiTextStyle;
  button?: UiButtonStyle;
}

// ── The message layer ─────────────────────────────────────────────────────
//
// The top hand-written frontends get much of their charm not from the frame
// around the conversation but from INSIDE it: a thought the character did not
// say aloud, inked over until the player taps it; a broadcast drawn as its own
// card; 【第3天·傍晚】 as a banner across the page; the options the AI offered
// turned into buttons. Every one of those is the same two-step move — find a
// written convention in the reply, draw it differently — so it is offered as
// that move, generically, rather than as any one card's feature.

/** How one side of the conversation is drawn. */
export interface UiMessageRoleStyle {
  /** Draw the message on a surface. Off means bare text on the page. */
  bubble?: boolean;
  /** The surface: fills, corners, border, shadow, padding. Used when `bubble`. */
  box?: UiBoxStyle;
  text?: UiTextStyle;
}

export interface UiMessageStyle {
  /** Which look the gallery shows as picked. Presentational only. */
  preset?: string;
  assistant?: UiMessageRoleStyle;
  user?: UiMessageRoleStyle;
  /** The opening, layered over `assistant`. */
  greeting?: UiMessageRoleStyle;
  /** Show the 旁白 / 你 labels above messages. Default true. */
  showNames?: boolean;
  /** Hold the transcript to a readable measure, in px. */
  maxWidth?: number;
  /** Space between messages, in px. */
  gap?: number;
}

/** Where a rule finds its text. */
export type UiMessageMatch =
  /** Text between two markers: ♡…♡, 【…】, <think>…</think>. */
  | { kind: "wrap"; open: string; close: string }
  /** A line starting with a marker: ※ 去图书馆. */
  | { kind: "line-prefix"; prefix: string }
  /** A literal piece of text anywhere. */
  | { kind: "contains"; text: string }
  /** Anything else. Capture groups pick the text (speaker: name, then line). */
  | { kind: "regex"; pattern: string; flags?: string };

/**
 * What the matched text becomes.
 *
 * reveal — covered until tapped · banner — a full-width line · card — the whole
 * message drawn as a card · choices — lines turned into buttons that send
 * themselves · speaker — a line of dialogue with a name label · hide — gone.
 */
export type UiMessageShow = "reveal" | "banner" | "card" | "choices" | "speaker" | "hide";

export interface UiMessageRuleOptions {
  /** reveal: what the covered text looks like. */
  cover?: "ink" | "blur" | "sticker";
  /** reveal: the words on the cover. */
  coverText?: string;
  /** reveal: the chance a tap reveals it, 0–1 (default 1). A miss is remembered. */
  revealChance?: number;
  /** reveal: shown when a tap misses. */
  missText?: string;
  /** banner / card / choices: the surface. */
  box?: UiBoxStyle;
  /** banner / card / choices / speaker label: the type. */
  text?: UiTextStyle;
  /** card: the heading; absent = the matched text. */
  title?: string;
  /** speaker: a colour per name. Names not listed get one from a palette. */
  colors?: Record<string, string>;
  /** speaker: a picture (`@asset:…`) per name. */
  avatars?: Record<string, string>;
  /** Apply to the player's own messages too. */
  applyToUser?: boolean;
}

export interface UiMessageRule {
  id: string;
  /** Creator-facing. Also how the rule is introduced to the AI. */
  name: string;
  /** Default true. */
  enabled?: boolean;
  match: UiMessageMatch;
  show: UiMessageShow;
  options?: UiMessageRuleOptions;
  /**
   * What the AI is told about this convention, so it actually writes it. Absent
   * means a sentence generated from the rule (see `defaultAiHint`).
   */
  aiHint?: string;
  /** Default true. Off: the rule still draws, the AI is told nothing. */
  teachAi?: boolean;
  /** A sample of the convention as the AI would write it — shown in the preview
   *  and given to the AI as the example. */
  example?: string;
}

export type UiElementBody =
  | { type: "box"; style?: UiBoxStyle }
  | { type: "text"; text: UiText; style?: UiTextStyle }
  | {
      type: "image";
      src: UiImageSrc;
      fit?: UiFit;
      radius?: UiRadius;
      /** The asset is a video clip. Plays muted on a loop unless told otherwise. */
      media?: "video";
      /** Video: false = play once and hold the last frame. */
      loop?: boolean;
      /** Video: true = with sound (starts on the player's first tap). */
      sound?: boolean;
    }
  | { type: "meter"; value: UiNumber; min: UiNumber; max: UiNumber; style?: UiMeterStyle }
  | {
      type: "button";
      label: UiText;
      actions: UiAction[];
      style?: UiButtonStyle;
      /**
       * Variables that must hold something before the button can be pressed —
       * a form's "开始" stays dim until the name is filled. Empty string, empty
       * array and null all count as unfilled.
       */
      requires?: string[];
    }
  /**
   * A set of cards to pick from. `layout` decides the look (a grid of cards,
   * one big card at a time you swipe, a vertical list); `multi` lets several
   * be picked; the picked value(s) go to `variableId` (a string, or a json
   * array when multi). With `confirm`, picking only highlights and the button
   * runs the picked options' actions then its own; without it, a tap runs the
   * option's actions at once (single pick only).
   */
  | {
      type: "choice";
      options: UiChoiceOption[];
      layout: "grid" | "carousel" | "list";
      columns?: number;
      gap?: number;
      multi?: boolean;
      /** With `multi`: at most this many. */
      maxPick?: number;
      variableId?: string;
      /** Chips above the cards built from the options' tags. */
      tagFilter?: boolean;
      confirm?: { label: UiText; actions?: UiAction[]; style?: UiButtonStyle };
      style?: UiChoiceStyle;
    }
  /**
   * One question on a form, bound to a variable: typing or picking writes the
   * variable as it happens, so any text on the page can echo it live
   * (`{{player_name}}`) and a button's `requires` can wait for it.
   */
  | {
      type: "field";
      kind: UiFieldKind;
      variableId: string;
      label?: UiText;
      placeholder?: string;
      /** For `chips`. */
      options?: string[];
      /** For `chips`: an extra chip that turns into a text box. */
      allowCustom?: boolean;
      /** For `number` / `slider`. */
      min?: number;
      max?: number;
      step?: number;
      style?: UiFieldStyle;
    }
  /**
   * A card that appears over everything while `variableId` holds something,
   * and clears it when closed — the AI writes `new-clue = "…"`, the player
   * sees it once. `{{value}}` in the texts reads the variable (and
   * `{{value.field}}` when it holds an object). `x/y/w/h` place the card.
   */
  | {
      type: "popup";
      variableId: string;
      title?: UiText;
      body: UiText;
      image?: UiImageSrc;
      buttonLabel?: UiText;
      /** Default true. */
      clearOnClose?: boolean;
      style?: UiPopupStyle;
    }
  /** The whole conversation as one block — message list and composer together.
   *  The one-click option; `messages` + `composer` is the same thing taken
   *  apart so the two halves can be placed independently. */
  | { type: "chat"; style?: UiBoxStyle; messageStyle?: UiMessageStyle; rules?: UiMessageRule[] }
  /** The transcript alone. */
  | { type: "messages"; style?: UiBoxStyle; messageStyle?: UiMessageStyle; rules?: UiMessageRule[] }
  /** The input alone — text field, send, model picker. */
  | { type: "composer"; style?: UiBoxStyle }
  /**
   * The commonest thing a real frontend renders: 87% of the library's
   * hand-written cards draw a list. Rows come from a json array variable (or
   * a fixed set), and each row renders `item` with `{{item}}`,
   * `{{item.field}}` and `{{index}}` resolved before the ordinary `{{var}}`
   * pass — so "第{{index}}条线索：{{item.text}}" reads like the templates
   * creators already write.
   */
  | {
      type: "list";
      source: UiListSource;
      /** Per-row template. */
      item: UiText;
      direction?: "column" | "row";
      gap?: number;
      maxItems?: number;
      /** Shown when the array is empty — an empty box explains nothing. */
      emptyText?: UiText;
      itemStyle?: UiBoxStyle;
      textStyle?: UiTextStyle;
      /** Draw each row as a card (picture, title, subtitle, badge, locked). */
      card?: UiListCard;
      /** Tapping a row runs these; `{{item}}` / `{{item.field}}` read the row. */
      rowActions?: UiAction[];
      /** Cards per row when `direction` is "row" (a gallery that wraps). */
      columns?: number;
    }
  /**
   * A block of hand-written TSX, positioned and conditionally shown like any
   * other element. The point is that reaching for code costs one element rather
   * than the whole document: the radar chart nobody anticipated goes here while
   * the portrait beside it stays draggable.
   *
   * `code` is a component body — statements ending in a `return`. It runs in
   * the same `new Function` scope as the rest of the generated file, so it may
   * not import, and hooks are `React.useState`, never bare `useState`.
   */
  | { type: "custom"; code: string; style?: UiBoxStyle };

export type UiElement = UiElementBase & UiElementBody;

export type UiElementType = UiElementBody["type"];

/**
 * A condition subject that is not a variable: "has the player said anything
 * yet in this session". Opening flows — pick a cast, pick a route, then hide
 * the picker — are the commonest thing a top card's frontend does, and they
 * hinge on exactly this fact, which no variable holds.
 *
 * It rides in `visibleWhen.variableId` so the single-Condition shape stays the
 * one thing it has always been: `{ variableId: UI_CHAT_STARTED, operator: "eq",
 * value: false }` reads "还没开始聊". The compiler reads it off the live
 * message list instead of the variable bag. The leading `$` keeps it out of the
 * id space real variables are minted in.
 */
export const UI_CHAT_STARTED = "$chat.started";

/**
 * What a button does, in order. `actions` has been the shape since the button
 * existed; a hand-written or older doc that says `action: {…}` (one) is read as
 * a one-item list rather than as a button that does nothing.
 */
export function buttonActionsOf(el: { actions?: unknown; action?: unknown }): UiAction[] {
  const list = Array.isArray(el.actions) ? el.actions : el.action ? [el.action] : [];
  return list.filter((a): a is UiAction => !!a && typeof (a as { kind?: unknown }).kind === "string");
}
