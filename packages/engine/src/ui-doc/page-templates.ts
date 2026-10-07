import { elementActions, freeSpotOn, mapElementActions } from "./edit.js";
import { applyUiLook } from "./looks.js";
import { PLAY_MENU_ID, menuItemBox } from "./play-menu.js";
import { UI_CANVAS_W, UI_CHAT_STARTED, UI_DESKTOP_W } from "./types.js";
import type { UiAction, UiDoc, UiEditorSample, UiElement, UiPage, UiTextStyle } from "./types.js";

/**
 * Page templates: a working FUNCTION, dropped into any card as a new page.
 *
 * The starters (starters.ts) were whole cards — a story, a theme and a screen
 * together — so a creator had to take the story too. These are the other way
 * round: the card is the creator's, and what we supply is the part that is
 * tedious to get right by hand. "Ask the player's name before the story" is a
 * field, a button that waits for it, a variable the AI can read and a page
 * that steps aside once the conversation has started — four things that each
 * have to be wired to the others. A template wires them; the look (colour,
 * size, position, font) stays ordinary parts the creator restyles like any
 * other, and the page follows whatever theme the card already wears.
 *
 * Opening templates form a CHAIN in front of the conversation: the card opens
 * on the first, each one's button goes to the next, the last goes to the
 * chat. Adding one splices it into that chain; removing one (removePage)
 * closes the gap. Every opening page also steps aside by itself once the
 * player has spoken, so a player coming back to a started story lands in it.
 */

export type UiPageTemplateId =
  | "title-screen"
  | "pick-opening"
  | "enter-name"
  | "profile"
  | "pick-origin"
  | "difficulty"
  | "random-draw"
  | "points"
  | "confirm"
  | "status"
  | "bag"
  | "map"
  | "phone"
  | "relations"
  | "schedule"
  | "dice"
  | "clues"
  | "collection";

export interface UiPageTemplateVariable {
  id: string;
  type: "string" | "number" | "json";
  defaultValue: string | number | unknown[];
  min?: number;
  max?: number;
  /** The player sets it and the AI only reads it (a die roll, a reply being
   *  typed). Everything an opening page asks is the player's too. */
  readOnly?: boolean;
}

export interface UiPageTemplateGreeting {
  /** The opening's entry id, so its card keeps pointing at it. */
  id?: string;
  /** What the option card says — the greeting's name, or its first words. */
  title: string;
  /** A line under it. */
  preview: string;
}

export interface UiPageTemplateInput {
  /** Every word on the page, in the creator's language. Missing keys print as
   *  the key, which a test catches. */
  strings: Record<string, string>;
  /** Id for the page being made. */
  pageId: string;
  /** Where this page's button goes. */
  nextPageId: string;
  /** The first page of the opening chain — the confirm page's "change it". */
  firstPageId: string;
  /** The card's openings, in order (for pick-opening). */
  greetings: UiPageTemplateGreeting[];
  /** Setup variables already on the card that a summary can show, with their
   *  display labels (for confirm). */
  summary: Array<{ id: string; label: string }>;
  /** The card's name (for title-screen). */
  cardName: string;
  /** What a status page shows: variables the card already has. */
  stats?: Array<{ id: string; label: string; type: "number" | "string"; max?: number }>;
}

export interface UiPageTemplate {
  id: UiPageTemplateId;
  /** Where in the chain it goes: the title screen first, the confirm page
   *  last, everything else in the order it was added. */
  place: "first" | "middle" | "last" | "play";
  /** Variables it writes. Fixed readable ids: the AI reads them by id, and a
   *  second template asking for `player_name` shares the first one's. */
  variables: UiPageTemplateVariable[];
  /** Openings the card needs before this makes sense. */
  minGreetings?: number;
  build(input: UiPageTemplateInput): UiPage;
  /** What its variables look like once the story has filled them, shown only
   *  in the editor (see `UiDoc.editorSamples`). */
  samples?(strings: Record<string, string>): Record<string, UiEditorSample>;
  /** Parts that belong on the conversation page itself — a popup that has to
   *  be on screen while the story runs. (Play templates only.) */
  chatParts?(input: UiPageTemplateInput): UiElement[];
}

// ── Geometry and ink ───────────────────────────────────────────────────────

const W = UI_CANVAS_W;
const H = 812;
const PAD = 24;
const COL = W - PAD * 2;
/** The wide canvas centres one reading column. */
const DCOL = 520;
const DX = (UI_DESKTOP_W - DCOL) / 2;

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

const TEXT = "var(--yc-text, #f1ece4)";
const QUIET = "color-mix(in srgb, var(--yc-text, #f1ece4) 62%, transparent)";
const FONT = "var(--yc-font, inherit)";
/** The page covers whatever is under it — the platform chat, or a frontend
 *  the card already had — in the card's own ground. */
const GROUND = { kind: "color" as const, color: "var(--yc-bg, #111015)" };

const t = (strings: Record<string, string>, key: string) => strings[key] ?? key;

function text(
  id: string,
  template: string,
  phone: { x: number; y: number; w: number; h: number },
  desktop: { x: number; y: number; w: number; h: number } | null,
  style: UiTextStyle,
): UiElement {
  return { id, type: "text", ...phone, desktop, text: { template }, style: { lineHeight: 1.25, color: TEXT, family: FONT, ...style } };
}

/** Heading and the line under it — every template opens the same way, so a
 *  chain of them reads as one sequence. */
function heading(p: string, s: Record<string, string>, top = 72): UiElement[] {
  return [
    // Room for a second line on the phone: a heading in a longer language
    // wraps rather than being cut.
    text(`${p}-title`, t(s, "title"), box(PAD, top, COL, 68), box(DX, top, DCOL, 48),
      { size: 26, desktopSize: 34, weight: 700, letterSpacing: 0.3, lineHeight: 1.25 }),
    text(`${p}-sub`, t(s, "sub"), box(PAD, top + 74, COL, 44), box(DX, top + 56, DCOL, 44),
      { size: 14, desktopSize: 15, color: QUIET, lineHeight: 1.6 }),
  ];
}

function nextButton(
  p: string,
  label: string,
  next: string,
  phoneY: number,
  deskY: number,
  requires?: string[],
): UiElement {
  return applyUiLook({
    id: `${p}-next`, type: "button",
    x: PAD, y: phoneY, w: COL, h: 52, desktop: box(DX, deskY, DCOL, 52),
    label: { template: label },
    ...(requires?.length ? { requires } : {}),
    actions: [{ kind: "go-page", pageId: next }],
    style: { size: 16 },
  }, "button-solid");
}

/**
 * The page's own light: two soft glows of the theme's accent, one high on the
 * left and one low on the right, under everything. A flat ground read as an
 * unfinished page; this is what makes a template look designed, and because
 * it is made of the theme's tokens it changes with the card's colours.
 * `panel` adds a raised card behind a centred column on the wide canvas, so
 * a form stands on something instead of floating in the window.
 */
function page(input: UiPageTemplateInput, name: string, elements: UiElement[], opts: { panel?: boolean } = {}): UiPage {
  const p = input.pageId;
  const accent = "var(--yc-send-bg,#d9a13f)";
  // The glow is the page's ground, not an element on the canvas: the ground
  // fills the whole screen, so the light does too. As a canvas-sized box its
  // edges cut straight lines across any window not exactly 16:10.
  // (One glow: a page ground is capped at 200 characters.)
  const ground = { kind: "color" as const, color: `radial-gradient(120% 60% at 12% 0%,color-mix(in srgb,${accent} 30%,transparent),transparent 62%),${GROUND.color}` };
  const decor: UiElement[] = [];
  if (opts.panel) {
    decor.push({
      id: `${p}-panel`, type: "box", name: t(input.strings, "panelName"),
      x: 0, y: 0, w: 0, h: 0, desktop: box(DX - 48, 36, DCOL + 96, 568),
      css: "pointer-events: none;",
      style: {
        fills: [{ kind: "color", color: "color-mix(in srgb, var(--yc-text, #f1ece4) 5%, transparent)" }],
        borderColor: "color-mix(in srgb, var(--yc-text, #f1ece4) 12%, transparent)", borderWidth: 1,
        radius: 22, backdropBlur: 8,
        shadows: [{ x: 0, y: 24, blur: 60, spread: -12, color: "rgba(0,0,0,0.45)" }],
      },
    } as UiElement);
  }
  return {
    id: input.pageId,
    name,
    height: H,
    background: ground,
    elements: [...decor, ...elements],
  };
}

// ── The templates ──────────────────────────────────────────────────────────

/** A title, a paragraph that sets the scene, one way in. */
function titleScreen(input: UiPageTemplateInput): UiPage {
  const s = input.strings;
  const p = input.pageId;
  return page(input, t(s, "pageName"), [
    text(`${p}-title`, input.cardName || t(s, "title"), box(PAD, 250, COL, 56), box(DX - 80, 150, DCOL + 160, 72),
      { size: 36, desktopSize: 50, weight: 700, align: "center", letterSpacing: 2, lineHeight: 1.2 }),
    text(`${p}-prologue`, t(s, "prologue"), box(PAD + 8, 330, COL - 16, 150), box(DX, 250, DCOL, 150),
      { size: 15, desktopSize: 16, color: QUIET, align: "center", lineHeight: 1.9 }),
    { ...nextButton(p, t(s, "start"), input.nextPageId, 640, 470), animation: { kind: "fade", durationMs: 900, delayMs: 600 } },
  ]);
}

/** One card per opening the card already has; a tap starts there. */
function pickOpening(input: UiPageTemplateInput): UiPage {
  const s = input.strings;
  const p = input.pageId;
  const options = input.greetings.map((g, i) => ({
    id: `${p}-o${i + 1}`,
    title: g.title,
    ...(g.preview ? { subtitle: g.preview } : {}),
    actions: [
      { kind: "switch-greeting" as const, index: i, ...(g.id ? { greetingId: g.id } : {}) },
      { kind: "go-page" as const, pageId: input.nextPageId },
    ],
  }));
  return page(input, t(s, "pageName"), [
    ...heading(p, s),
    applyUiLook({
      id: `${p}-cards`, type: "choice", name: t(s, "partName"),
      x: PAD - 4, y: 204, w: COL + 8, h: H - 204 - 32,
      desktop: box(72, 200, UI_DESKTOP_W - 144, 400),
      layout: "grid", gap: 12,
      variableId: "opening",
      options,
    }, "choice-cover"),
  ].map((el) => (el.type === "text" ? { ...el, desktop: el.desktop ? { ...el.desktop, x: 72, w: 640 } : null } : el)));
}

/** A name, and how the story should address you. */
function enterName(input: UiPageTemplateInput): UiPage {
  const s = input.strings;
  const p = input.pageId;
  return page(input, t(s, "pageName"), [
    ...heading(p, s, 120),
    applyUiLook({
      id: `${p}-name`, type: "field", kind: "text", variableId: "player_name", name: t(s, "nameLabel"),
      x: PAD, y: 262, w: COL, h: 80, desktop: box(DX, 240, DCOL, 80),
      label: { template: t(s, "nameLabel") }, placeholder: t(s, "namePlaceholder"),
    }, "field-underline"),
    applyUiLook({
      id: `${p}-address`, type: "field", kind: "chips", variableId: "address", name: t(s, "addressLabel"),
      x: PAD, y: 360, w: COL, h: 100, desktop: box(DX, 340, DCOL, 92),
      label: { template: t(s, "addressLabel") },
      options: [t(s, "address1"), t(s, "address2"), t(s, "address3")],
      allowCustom: true, placeholder: t(s, "addressCustom"),
    }, "field-underline"),
    nextButton(p, t(s, "start"), input.nextPageId, 690, 480, ["player_name"]),
  ], { panel: true });
}

/** A register: who you are, what you look like, one thing only you know. The
 *  wide canvas shows the card it is filling in beside the form. */
function profile(input: UiPageTemplateInput): UiPage {
  const s = input.strings;
  const p = input.pageId;
  const FX = 520;
  const FW = 420;
  const field = (id: string, variableId: string, kind: "text" | "textarea" | "chips" | "number", py: number, ph: number, dy: number, dh: number, extra: Partial<UiElement> = {}) =>
    applyUiLook({
      id: `${p}-${id}`, type: "field", kind, variableId, name: t(s, `${id}Label`),
      x: PAD, y: py, w: COL, h: ph, desktop: box(FX, dy, FW, dh),
      label: { template: t(s, `${id}Label`) },
      ...(kind !== "chips" ? { placeholder: t(s, `${id}Placeholder`) } : {}),
      ...extra,
    } as UiElement, "field-underline");
  const LX = 84;
  const LW = 360;
  const els: UiElement[] = [
    text(`${p}-title`, t(s, "title"), box(PAD, 48, COL, 40), box(LX, 60, LW, 48),
      { size: 28, desktopSize: 34, weight: 700, lineHeight: 1.2 }),
    text(`${p}-sub`, t(s, "sub"), box(PAD, 92, COL, 40), box(LX, 114, LW, 44),
      { size: 13.5, desktopSize: 14.5, color: QUIET, lineHeight: 1.6 }),
    // The card being filled in: wide canvas only, the phone has no room.
    {
      id: `${p}-card`, type: "box", x: 0, y: 0, w: 0, h: 0, desktop: box(LX, 180, LW, 360),
      css: "border-radius: var(--yc-input-radius, 14px);",
      style: {
        fills: [{ kind: "color", color: "color-mix(in srgb, var(--yc-text, #f1ece4) 5%, transparent)" }],
        borderColor: "color-mix(in srgb, var(--yc-text, #f1ece4) 14%, transparent)", borderWidth: 1,
      },
    },
    {
      ...text(`${p}-card-empty`, t(s, "cardEmpty"), box(0, 0, 0, 0), box(LX + 24, 206, LW - 48, 36),
        { size: 18, desktopSize: 20, color: QUIET, italic: true, nowrap: true }),
      visibleWhen: { variableId: "player_name", operator: "eq", value: "" },
    },
    text(`${p}-card-name`, "{{player_name}}", box(0, 0, 0, 0), box(LX + 24, 200, LW - 48, 44),
      { size: 30, desktopSize: 32, weight: 700, nowrap: true, lineHeight: 1.2 }),
    {
      // 「女 · 24」: only once there is something in it. Empty, it drew a lone
      // "·" under 还没有名字.
      ...text(`${p}-card-line`, t(s, "cardLine"), box(0, 0, 0, 0), box(LX + 24, 252, LW - 48, 22),
        { size: 14, desktopSize: 15, color: "var(--yc-send-bg, #d9a13f)", weight: 600, nowrap: true }),
      visibleWhen: { variableId: "gender", operator: "neq", value: "" },
    },
    text(`${p}-card-looks`, "{{looks}}", box(0, 0, 0, 0), box(LX + 24, 290, LW - 48, 220),
      { size: 13.5, desktopSize: 14, color: QUIET, lineHeight: 1.75 }),
    field("name", "player_name", "text", 150, 72, 60, 72),
    field("gender", "gender", "chips", 232, 84, 142, 76, {
      options: [t(s, "gender1"), t(s, "gender2"), t(s, "gender3")], allowCustom: true,
      placeholder: t(s, "genderCustom"),
    } as Partial<UiElement>),
    field("age", "age", "text", 326, 72, 228, 72),
    field("looks", "looks", "textarea", 408, 116, 310, 96),
    field("secret", "secret", "textarea", 534, 116, 416, 96),
    { ...nextButton(p, t(s, "start"), input.nextPageId, 672, 530, ["player_name"]), desktop: box(FX, 540, FW, 52) },
  ];
  return page(input, t(s, "pageName"), els);
}

/** Pick one of a few pasts. The option's text is what the AI is told. */
function pickFromList(kind: "origin" | "difficulty") {
  return (input: UiPageTemplateInput): UiPage => {
    const s = input.strings;
    const p = input.pageId;
    const options = [1, 2, 3].map((n) => ({
      id: `${p}-o${n}`,
      title: t(s, `option${n}Title`),
      detail: t(s, `option${n}Detail`),
    }));
    return page(input, t(s, "pageName"), [
      ...heading(p, s, 96),
      applyUiLook({
        id: `${p}-list`, type: "choice", name: t(s, "partName"),
        x: PAD, y: 228, w: COL, h: 520, desktop: box(DX, 212, DCOL, 368),
        layout: "list", gap: 10,
        variableId: kind,
        options,
        confirm: { label: { template: t(s, "start") }, actions: [{ kind: "go-page", pageId: input.nextPageId }] },
      }, "choice-default"),
    ], { panel: true });
  };
}

/** One line per choice: 「名字：{{player_name}}」. */
function summaryText(summary: UiPageTemplateInput["summary"], s: Record<string, string>): string {
  const sep = s.separator ?? "：";
  return summary.length ? summary.map((v) => `${v.label}${sep}{{${v.id}}}`).join("\n") : t(s, "nothingYet");
}

/** Everything chosen so far, once, before the story starts. */
function confirm(input: UiPageTemplateInput): UiPage {
  const s = input.strings;
  const p = input.pageId;
  const lines = summaryText(input.summary, s);
  const back: UiAction = { kind: "go-page", pageId: input.firstPageId };
  const els: UiElement[] = [
    ...heading(p, s, 110),
    {
      id: `${p}-sheet`, type: "box", x: PAD, y: 244, w: COL, h: 272, desktop: box(DX, 220, DCOL, 220),
      css: "border-radius: var(--yc-input-radius, 14px);",
      style: {
        fills: [{ kind: "color", color: "color-mix(in srgb, var(--yc-text, #f1ece4) 5%, transparent)" }],
        borderColor: "color-mix(in srgb, var(--yc-text, #f1ece4) 14%, transparent)", borderWidth: 1,
      },
    },
    text(`${p}-summary`, lines, box(PAD + 20, 264, COL - 40, 232), box(DX + 24, 242, DCOL - 48, 180),
      { size: 14, desktopSize: 14, lineHeight: 1.7 }),
    nextButton(p, t(s, "start"), input.nextPageId, 640, 470),
    applyUiLook({
      id: `${p}-back`, type: "button",
      x: PAD, y: 704, w: COL, h: 44, desktop: box(DX, 534, DCOL, 44),
      label: { template: t(s, "back") },
      actions: [back],
      style: { size: 14 },
    }, "button-outline"),
  ];
  return page(input, t(s, "pageName"), els, { panel: true });
}

// ── More openings ──────────────────────────────────────────────────────────

/** Draw who you are by lot, a few tries allowed. The draw is the card's, not
 *  the AI's: the AI is told what came up. */
function randomDraw(input: UiPageTemplateInput): UiPage {
  const s = input.strings;
  const p = input.pageId;
  const lots = [1, 2, 3, 4, 5, 6].map((n) => t(s, `lot${n}`));
  const els: UiElement[] = [
    ...heading(p, s, 96),
    {
      id: `${p}-card`, type: "box", x: PAD, y: 250, w: COL, h: 200, desktop: box(DX, 220, DCOL, 170),
      css: "border-radius: var(--yc-input-radius, 16px);",
      style: {
        fills: [{ kind: "color", color: "color-mix(in srgb, var(--yc-send-bg, #d9a13f) 10%, transparent)" }],
        borderColor: "color-mix(in srgb, var(--yc-send-bg, #d9a13f) 55%, transparent)", borderWidth: 1,
      },
    },
    {
      ...text(`${p}-empty`, t(s, "empty"), box(PAD + 20, 330, COL - 40, 40), box(DX + 24, 285, DCOL - 48, 40),
        { size: 16, desktopSize: 17, color: QUIET, align: "center", italic: true }),
      visibleWhen: { variableId: "draw", operator: "eq", value: "" },
    },
    text(`${p}-result`, "{{draw}}", box(PAD + 20, 280, COL - 40, 140), box(DX + 24, 240, DCOL - 48, 130),
      { size: 20, desktopSize: 22, weight: 700, align: "center", lineHeight: 1.6 }),
    {
      ...applyUiLook({
        id: `${p}-draw`, type: "button", name: t(s, "drawName"),
        x: PAD, y: 470, w: COL, h: 48, desktop: box(DX, 406, DCOL, 46),
        label: { template: t(s, "drawButton") },
        actions: [
          { kind: "random", variableId: "draw", from: lots },
          { kind: "set-variable", variableId: "draws_left", op: "subtract", value: 1 },
        ],
        style: { size: 15 },
      }, "button-outline"),
      visibleWhen: { variableId: "draws_left", operator: "gt", value: 0 },
    },
    nextButton(p, t(s, "start"), input.nextPageId, 690, 470, ["draw"]),
  ];
  return page(input, t(s, "pageName"), els, { panel: true });
}

const ATTRS = ["str", "agi", "cha", "wit"] as const;

/** A few points to spend across four attributes. Plus shows while points are
 *  left, minus while the attribute is above where it started. */
function points(input: UiPageTemplateInput): UiPage {
  const s = input.strings;
  const p = input.pageId;
  const rowH = 64;
  const els: UiElement[] = [
    ...heading(p, s, 80),
    text(`${p}-pool`, t(s, "pool"), box(PAD, 214, COL, 28), box(DX, 186, DCOL, 28),
      { size: 16, desktopSize: 17, weight: 700, color: "var(--yc-send-bg, #d9a13f)" }),
  ];
  ATTRS.forEach((a, i) => {
    const py = 258 + i * rowH;
    const dy = 226 + i * 56;
    const group = `g-${p}-${a}`;
    els.push(
      { ...text(`${p}-${a}-label`, t(s, `attr_${a}`), box(PAD, py + 12, 150, 26), box(DX, dy + 10, 200, 26),
        { size: 16, desktopSize: 17, weight: 600 }), group },
      { ...text(`${p}-${a}-value`, `{{${a}}}`, box(PAD + 196, py + 10, 48, 30), box(DX + 330, dy + 8, 60, 30),
        { size: 22, desktopSize: 22, weight: 700, align: "center" }), group },
      {
        ...applyUiLook({
          id: `${p}-${a}-minus`, type: "button", group,
          x: PAD + 150, y: py + 6, w: 40, h: 40, desktop: box(DX + 280, dy + 4, 40, 40),
          label: { template: "−" },
          actions: [
            { kind: "set-variable", variableId: a, op: "subtract", value: 1 },
            { kind: "set-variable", variableId: "points_left", op: "add", value: 1 },
          ],
          style: { size: 18 },
        }, "button-outline"),
        visibleWhen: { variableId: a, operator: "gt", value: 1 },
      },
      {
        ...applyUiLook({
          id: `${p}-${a}-plus`, type: "button", group,
          x: PAD + 250, y: py + 6, w: 40, h: 40, desktop: box(DX + 400, dy + 4, 40, 40),
          label: { template: "+" },
          actions: [
            { kind: "set-variable", variableId: a, op: "add", value: 1 },
            { kind: "set-variable", variableId: "points_left", op: "subtract", value: 1 },
          ],
          style: { size: 18 },
        }, "button-soft"),
        visibleWhen: { variableId: "points_left", operator: "gt", value: 0 },
      },
    );
  });
  els.push(nextButton(p, t(s, "start"), input.nextPageId, 690, 470));
  return page(input, t(s, "pageName"), els, { panel: true });
}

// ── While playing ──────────────────────────────────────────────────────────
//
// Each is a page of its own with a way back, opened from a small button the
// template puts on the conversation page. Anything that has to show up WHILE
// the story runs (a popup when something is found) goes on the conversation
// page itself, through `chatParts`.

/** A back button and a heading: the top of every play page. */
function playTop(input: UiPageTemplateInput): UiElement[] {
  const s = input.strings;
  const p = input.pageId;
  return [
    applyUiLook({
      id: `${p}-back`, type: "button", name: t(s, "backName"),
      x: PAD - 4, y: 20, w: 40, h: 40, desktop: box(DX, 62, 40, 40),
      label: { template: "←" },
      actions: [{ kind: "go-page", pageId: input.nextPageId }],
      style: { size: 17 },
    }, "button-glass"),
    text(`${p}-title`, t(s, "title"), box(PAD, 76, COL, 36), box(DX + 54, 60, DCOL - 54, 40),
      { size: 24, desktopSize: 28, weight: 700, nowrap: true, lineHeight: 1.2 }),
    text(`${p}-sub`, t(s, "sub"), box(PAD, 116, COL, 44), box(DX + 54, 100, DCOL - 54, 24),
      { size: 13, desktopSize: 14, color: QUIET, lineHeight: 1.6 }),
  ];
}

const PLAY_TOP = 176;
const DESK_TOP = 146;
/** Where the column on the wide canvas ends — inside the panel. */
const DESK_BOTTOM = 588;

function popupOnChat(input: UiPageTemplateInput, variableId: string): UiElement {
  const s = input.strings;
  return applyUiLook({
    id: `${input.pageId}-popup`, type: "popup", variableId, name: t(s, "popupName"),
    x: 38, y: 250, w: W - 76, h: 250, desktop: box(UI_DESKTOP_W / 2 - 190, 170, 380, 260), z: 1000,
    title: { template: t(s, "popupTitle") },
    body: { template: "{{value}}" },
    buttonLabel: { template: t(s, "popupButton") },
  }, "popup-reward");
}

function listOf(
  input: UiPageTemplateInput,
  source: { kind: "variable"; variableId: string } | { kind: "static"; items: Array<Record<string, string>> },
  card: Record<string, unknown>,
  extra: Partial<UiElement> = {},
  top = PLAY_TOP,
): UiElement {
  return applyUiLook({
    id: `${input.pageId}-list`, type: "list", name: t(input.strings, "listName"),
    x: PAD, y: top, w: COL, h: H - top - 28, desktop: box(DX, DESK_TOP, DCOL, DESK_BOTTOM - DESK_TOP),
    source,
    item: { template: "{{item.name}}" },
    gap: 10,
    emptyText: { template: t(input.strings, "empty") },
    card,
    ...extra,
  } as UiElement, "list-tiles");
}

/** The card's own numbers and words, drawn as meters and lines. */
function status(input: UiPageTemplateInput): UiPage {
  const s = input.strings;
  const p = input.pageId;
  const stats = input.stats ?? [];
  const els: UiElement[] = [...playTop(input)];
  let py = PLAY_TOP;
  let dy = DESK_TOP;
  for (const st of stats) {
    const group = `g-${p}-${st.id}`;
    if (st.type === "number") {
      els.push(
        { ...text(`${p}-${st.id}-label`, st.label, box(PAD, py, COL - 60, 18), box(DX, dy, DCOL - 80, 20),
          { size: 13, desktopSize: 14, color: QUIET, nowrap: true }), group },
        { ...text(`${p}-${st.id}-value`, `{{${st.id}}}`, box(PAD + COL - 60, py - 2, 60, 22), box(DX + DCOL - 80, dy - 2, 80, 24),
          { size: 16, desktopSize: 17, weight: 700, align: "right", nowrap: true }), group },
        {
          id: `${p}-${st.id}-meter`, group, type: "meter",
          x: PAD, y: py + 24, w: COL, h: 8, desktop: box(DX, dy + 28, DCOL, 8),
          value: { kind: "variable", variableId: st.id, fallback: 0 },
          min: { kind: "literal", value: 0 },
          max: { kind: "literal", value: st.max ?? 100 },
          style: {
            track: [{ kind: "color", color: "color-mix(in srgb, var(--yc-text, #f1ece4) 10%, transparent)" }],
            fills: [{ kind: "color", color: "var(--yc-send-bg, #d9a13f)" }],
            radius: 999,
          },
        },
      );
      py += 60;
      dy += 56;
    } else {
      els.push(
        { ...text(`${p}-${st.id}-label`, st.label, box(PAD, py, COL, 18), box(DX, dy, DCOL, 20),
          { size: 13, desktopSize: 14, color: QUIET, nowrap: true }), group },
        { ...text(`${p}-${st.id}-value`, `{{${st.id}}}`, box(PAD, py + 20, COL, 26), box(DX, dy + 22, DCOL, 26),
          { size: 17, desktopSize: 18, weight: 700, nowrap: true }), group },
      );
      py += 60;
      dy += 56;
    }
  }
  if (stats.length === 0) {
    els.push(text(`${p}-none`, t(s, "none"), box(PAD, py, COL, 60), box(DX, dy, DCOL, 40),
      { size: 14, desktopSize: 15, color: QUIET, lineHeight: 1.6 }));
  }
  return page(input, t(s, "pageName"), els, { panel: true });
}

function bag(input: UiPageTemplateInput): UiPage {
  const s = input.strings;
  return page(input, t(s, "pageName"), [
    ...playTop(input),
    listOf(input, { kind: "variable", variableId: "bag" },
      { title: { template: "{{item.name}}" }, subtitle: { template: "{{item.note}}" } },
      {
        rowActions: [
          { kind: "go-page", pageId: input.nextPageId },
          { kind: "send-message", text: { template: t(s, "useMessage") } },
        ],
      } as Partial<UiElement>),
  ], { panel: true });
}

export const MAP_PLACES = ["home", "street", "market", "river", "outskirts"] as const;

function map(input: UiPageTemplateInput): UiPage {
  const s = input.strings;
  const p = input.pageId;
  const items = MAP_PLACES.map((id) => ({ id, name: t(s, `place_${id}`), note: t(s, `place_${id}_note`) }));
  return page(input, t(s, "pageName"), [
    ...playTop(input),
    text(`${p}-here`, t(s, "here"), box(PAD, PLAY_TOP - 16, COL, 22), box(DX, DESK_TOP - 4, DCOL, 20),
      { size: 13, desktopSize: 13.5, weight: 600, color: "var(--yc-send-bg, #d9a13f)", nowrap: true }),
    listOf(input, { kind: "static", items },
      {
        title: { template: "{{item.name}}" }, subtitle: { template: "{{item.note}}" },
        lockedUnless: { variableId: "unlocked_places", field: "id" },
        lockedText: { template: t(s, "locked") },
      },
      {
        rowActions: [
          { kind: "set-variable", variableId: "location", op: "set", value: "{{item.name}}" },
          { kind: "go-page", pageId: input.nextPageId },
          { kind: "send-message", text: { template: t(s, "goMessage") } },
        ],
        desktop: box(DX, DESK_TOP + 24, DCOL, DESK_BOTTOM - DESK_TOP - 24),
      } as Partial<UiElement>,
      PLAY_TOP + 16),
  ], { panel: true });
}

function phone(input: UiPageTemplateInput): UiPage {
  const s = input.strings;
  const p = input.pageId;
  return page(input, t(s, "pageName"), [
    ...playTop(input),
    listOf(input, { kind: "variable", variableId: "inbox" },
      { title: { template: "{{item.from}}" }, subtitle: { template: "{{item.text}}" } },
      { h: H - PLAY_TOP - 150, desktop: box(DX, DESK_TOP, DCOL, 330) } as Partial<UiElement>),
    applyUiLook({
      id: `${p}-reply`, type: "field", kind: "text", variableId: "reply_draft", name: t(s, "replyName"),
      x: PAD, y: H - 136, w: COL, h: 72, desktop: box(DX, 496, DCOL - 132, 72),
      label: { template: t(s, "replyLabel") }, placeholder: t(s, "replyPlaceholder"),
    }, "field-filled"),
    applyUiLook({
      id: `${p}-send`, type: "button", name: t(s, "sendName"),
      x: PAD, y: H - 58, w: COL, h: 44, desktop: box(DX + DCOL - 120, 516, 120, 48),
      label: { template: t(s, "send") },
      requires: ["reply_draft"],
      actions: [
        { kind: "go-page", pageId: input.nextPageId },
        { kind: "send-message", text: { template: t(s, "replyMessage") } },
        { kind: "set-variable", variableId: "reply_draft", op: "set", value: "" },
      ],
      style: { size: 15 },
    }, "button-solid"),
  ], { panel: true });
}

function relations(input: UiPageTemplateInput): UiPage {
  const s = input.strings;
  return page(input, t(s, "pageName"), [
    ...playTop(input),
    listOf(input, { kind: "variable", variableId: "relations" },
      { title: { template: "{{item.name}}" }, badge: { template: "{{item.level}}" }, subtitle: { template: "{{item.note}}" } }),
  ], { panel: true });
}

function schedule(input: UiPageTemplateInput): UiPage {
  const s = input.strings;
  const p = input.pageId;
  const acts = [1, 2, 3, 4].map((n) => t(s, `act${n}`));
  const els: UiElement[] = [
    ...playTop(input),
    text(`${p}-when`, t(s, "when"), box(PAD, PLAY_TOP, COL, 30), box(DX, DESK_TOP, DCOL, 32),
      { size: 20, desktopSize: 22, weight: 700, nowrap: true }),
    text(`${p}-left`, t(s, "left"), box(PAD, PLAY_TOP + 34, COL, 22), box(DX, DESK_TOP + 36, DCOL, 22),
      { size: 13.5, desktopSize: 14, color: QUIET, nowrap: true }),
  ];
  acts.forEach((act, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const bw = (COL - 12) / 2;
    els.push({
      ...applyUiLook({
        id: `${p}-act${i + 1}`, type: "button", name: act,
        x: PAD + col * (bw + 12), y: PLAY_TOP + 76 + row * 72, w: bw, h: 60,
        desktop: box(DX + col * (DCOL / 2 + 6), DESK_TOP + 80 + row * 76, DCOL / 2 - 6, 62),
        label: { template: act },
        actions: [
          { kind: "set-variable", variableId: "actions_left", op: "subtract", value: 1 },
          { kind: "go-page", pageId: input.nextPageId },
          { kind: "send-message", text: { template: t(s, "actMessage").replace("{act}", act) } },
        ],
        style: { size: 15 },
      }, "button-soft"),
      visibleWhen: { variableId: "actions_left", operator: "gt", value: 0 },
    });
  });
  els.push(applyUiLook({
    id: `${p}-end`, type: "button", name: t(s, "endName"),
    x: PAD, y: PLAY_TOP + 236, w: COL, h: 48, desktop: box(DX, DESK_TOP + 250, DCOL, 48),
    label: { template: t(s, "end") },
    actions: [
      { kind: "set-variable", variableId: "day", op: "add", value: 1 },
      { kind: "set-variable", variableId: "actions_left", op: "set", value: 3 },
      { kind: "go-page", pageId: input.nextPageId },
      { kind: "send-message", text: { template: t(s, "endMessage") } },
    ],
    style: { size: 15 },
  }, "button-outline"));
  return page(input, t(s, "pageName"), els, { panel: true });
}

function dice(input: UiPageTemplateInput): UiPage {
  const s = input.strings;
  const p = input.pageId;
  return page(input, t(s, "pageName"), [
    ...playTop(input),
    {
      id: `${p}-face`, type: "box", x: W / 2 - 70, y: 230, w: 140, h: 140, desktop: box(UI_DESKTOP_W / 2 - 80, 170, 160, 160),
      css: "border-radius: 22px;",
      style: {
        fills: [{ kind: "color", color: "color-mix(in srgb, var(--yc-send-bg, #d9a13f) 12%, transparent)" }],
        borderColor: "var(--yc-send-bg, #d9a13f)", borderWidth: 2,
      },
    },
    text(`${p}-roll`, "{{roll}}", box(W / 2 - 70, 272, 140, 60), box(UI_DESKTOP_W / 2 - 80, 216, 160, 70),
      { size: 48, desktopSize: 56, weight: 800, align: "center", lineHeight: 1 }),
    text(`${p}-hint`, t(s, "hint"), box(PAD, 390, COL, 44), box(DX, 346, DCOL, 40),
      { size: 13.5, desktopSize: 14, color: QUIET, align: "center", lineHeight: 1.6 }),
    applyUiLook({
      id: `${p}-throw`, type: "button", name: t(s, "throwName"),
      x: PAD, y: 470, w: COL, h: 52, desktop: box(DX, 410, DCOL, 52),
      label: { template: t(s, "throw") },
      actions: [
        { kind: "random", variableId: "roll", min: 1, max: 20 },
        { kind: "go-page", pageId: input.nextPageId },
        { kind: "send-message", text: { template: t(s, "rollMessage") } },
      ],
      style: { size: 16 },
    }, "button-solid"),
  ], { panel: true });
}

function clues(input: UiPageTemplateInput): UiPage {
  const s = input.strings;
  const p = input.pageId;
  const suspects = [1, 2, 3].map((n) => ({ id: `${p}-s${n}`, title: t(s, `suspect${n}`), value: t(s, `suspect${n}`) }));
  return page(input, t(s, "pageName"), [
    ...playTop(input),
    listOf(input, { kind: "variable", variableId: "clues" },
      { title: { template: "{{item.name}}" }, subtitle: { template: "{{item.where}}" } },
      { h: 300, desktop: box(DX, DESK_TOP, DCOL, 180) } as Partial<UiElement>),
    text(`${p}-accuse-label`, t(s, "accuseLabel"), box(PAD, 492, COL, 22), box(DX, DESK_TOP + 196, DCOL, 22),
      { size: 14, desktopSize: 15, weight: 700, nowrap: true }),
    applyUiLook({
      id: `${p}-accuse`, type: "choice", name: t(s, "accuseName"),
      x: PAD, y: 520, w: COL, h: 270, desktop: box(DX, DESK_TOP + 224, DCOL, DESK_BOTTOM - DESK_TOP - 224),
      layout: "list", gap: 8,
      variableId: "accused",
      options: suspects,
      confirm: {
        label: { template: t(s, "accuse") },
        actions: [
          { kind: "go-page", pageId: input.nextPageId },
          { kind: "send-message", text: { template: t(s, "accuseMessage") } },
        ],
      },
    }, "choice-default"),
  ], { panel: true });
}

export const COLLECTION_ITEM_IDS = ["photo", "letter", "key", "badge", "map", "musicbox"] as const;

function collection(input: UiPageTemplateInput): UiPage {
  const s = input.strings;
  const items = COLLECTION_ITEM_IDS.map((id) => ({
    id, name: t(s, `item_${id}`), note: t(s, `item_${id}_note`), hint: t(s, `item_${id}_hint`),
  }));
  return page(input, t(s, "pageName"), [
    ...playTop(input),
    listOf(input, { kind: "static", items },
      {
        title: { template: "{{item.name}}" }, subtitle: { template: "{{item.note}}" },
        lockedUnless: { variableId: "unlocked", field: "id" },
        lockedText: { template: "{{item.hint}}" },
      },
      { direction: "row", columns: 2 } as Partial<UiElement>),
  ], { panel: true });
}

/** Sample rows from `ex1_<field>`, `ex2_<field>`… — as many as the strings
 *  have, none when a language left them out. */
function exampleRows(strings: Record<string, string>, fields: string[]): Array<Record<string, string>> {
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i <= 4; i++) {
    if (!strings[`ex${i}_${fields[0]}`]) break;
    rows.push(Object.fromEntries(fields.map((f) => [f, strings[`ex${i}_${f}`] ?? ""])));
  }
  return rows;
}
const sampleList = (variableId: string, fields: string[]) => (strings: Record<string, string>) => {
  const rows = exampleRows(strings, fields);
  return rows.length ? { [variableId]: rows } : {};
};
const sampleHere = (strings: Record<string, string>): Record<string, UiEditorSample> =>
  strings.exHere ? { location: strings.exHere } : {};

export const UI_PAGE_TEMPLATES: UiPageTemplate[] = [
  // Openings, before the story.
  { id: "title-screen", place: "first", variables: [], build: titleScreen },
  { id: "pick-opening", place: "middle", minGreetings: 2, variables: [{ id: "opening", type: "string", defaultValue: "" }], build: pickOpening },
  {
    id: "enter-name", place: "middle",
    variables: [
      { id: "player_name", type: "string", defaultValue: "" },
      { id: "address", type: "string", defaultValue: "" },
    ],
    build: enterName,
  },
  {
    id: "profile", place: "middle",
    variables: [
      { id: "player_name", type: "string", defaultValue: "" },
      { id: "gender", type: "string", defaultValue: "" },
      { id: "age", type: "string", defaultValue: "" },
      { id: "looks", type: "string", defaultValue: "" },
      { id: "secret", type: "string", defaultValue: "" },
    ],
    build: profile,
  },
  { id: "pick-origin", place: "middle", variables: [{ id: "origin", type: "string", defaultValue: "" }], build: pickFromList("origin") },
  { id: "difficulty", place: "middle", variables: [{ id: "difficulty", type: "string", defaultValue: "" }], build: pickFromList("difficulty") },
  {
    id: "random-draw", place: "middle",
    variables: [
      { id: "draw", type: "string", defaultValue: "" },
      { id: "draws_left", type: "number", defaultValue: 3, min: 0 },
    ],
    build: randomDraw,
  },
  {
    id: "points", place: "middle",
    variables: [
      ...ATTRS.map((id) => ({ id, type: "number" as const, defaultValue: 1, min: 1, max: 10 })),
      { id: "points_left", type: "number", defaultValue: 6, min: 0 },
    ],
    build: points,
  },
  { id: "confirm", place: "last", variables: [], build: confirm },

  // While playing: a page each, opened from the conversation.
  { id: "status", place: "play", variables: [], build: status, samples: sampleHere },
  {
    id: "bag", place: "play",
    variables: [
      { id: "bag", type: "json", defaultValue: [] },
      { id: "new_item", type: "string", defaultValue: "" },
    ],
    build: bag,
    samples: sampleList("bag", ["name", "note"]),
    chatParts: (input) => [popupOnChat(input, "new_item")],
  },
  {
    id: "map", place: "play",
    variables: [
      { id: "location", type: "string", defaultValue: "" },
      { id: "unlocked_places", type: "json", defaultValue: ["home", "street", "market"] },
    ],
    build: map,
    samples: sampleHere,
  },
  {
    id: "phone", place: "play",
    variables: [
      { id: "inbox", type: "json", defaultValue: [] },
      { id: "new_message", type: "string", defaultValue: "" },
      { id: "reply_draft", type: "string", defaultValue: "", readOnly: true },
    ],
    build: phone,
    samples: sampleList("inbox", ["from", "text"]),
    chatParts: (input) => [popupOnChat(input, "new_message")],
  },
  { id: "relations", place: "play", variables: [{ id: "relations", type: "json", defaultValue: [] }], build: relations, samples: sampleList("relations", ["name", "level", "note"]) },
  {
    id: "schedule", place: "play",
    variables: [
      { id: "day", type: "number", defaultValue: 1, min: 1 },
      { id: "period", type: "string", defaultValue: "" },
      { id: "actions_left", type: "number", defaultValue: 3, min: 0, readOnly: true },
    ],
    build: schedule,
  },
  { id: "dice", place: "play", variables: [{ id: "roll", type: "number", defaultValue: 0, readOnly: true }], build: dice },
  {
    id: "clues", place: "play",
    variables: [
      { id: "clues", type: "json", defaultValue: [] },
      { id: "new_clue", type: "string", defaultValue: "" },
      { id: "accused", type: "string", defaultValue: "", readOnly: true },
    ],
    build: clues,
    samples: sampleList("clues", ["name", "where"]),
    chatParts: (input) => [popupOnChat(input, "new_clue")],
  },
  {
    id: "collection", place: "play",
    variables: [
      { id: "unlocked", type: "json", defaultValue: [] },
      { id: "unlock_note", type: "string", defaultValue: "" },
    ],
    build: collection,
    chatParts: (input) => [popupOnChat(input, "unlock_note")],
  },
];

export const getUiPageTemplate = (id: string): UiPageTemplate | undefined =>
  UI_PAGE_TEMPLATES.find((tpl) => tpl.id === id);

// ── The chain ──────────────────────────────────────────────────────────────

const STARTED = { variableId: UI_CHAT_STARTED, operator: "eq" as const, value: true };

/** Where a page's own buttons go, first found. */
function goTargets(page: UiPage): string[] {
  const out: string[] = [];
  for (const el of page.elements) {
    for (const a of elementActions(el)) if (a.kind === "go-page" && !out.includes(a.pageId)) out.push(a.pageId);
  }
  return out;
}

/**
 * The opening pages in the order a player meets them, and the page the chain
 * ends in (the conversation).
 *
 * An opening page is one that steps aside to another once the chat has
 * started. The chain starts at the entry page and follows each page's own
 * go-page buttons; a confirm page's "change it" points BACK into the chain,
 * so a target already visited is skipped.
 */
export function openingChain(doc: UiDoc): { chain: string[]; chatPageId: string } {
  const pages = doc.pages ?? [];
  const byId = new Map(pages.map((p) => [p.id, p]));
  const entry = byId.get(doc.entryPageId) ?? pages[0];
  if (!entry) return { chain: [], chatPageId: doc.entryPageId };
  const chain: string[] = [];
  let at: UiPage | undefined = entry;
  while (at && at.leaveWhen && !chain.includes(at.id)) {
    chain.push(at.id);
    const next: string | undefined = goTargets(at).find((id) => byId.has(id) && !chain.includes(id));
    if (!next) return { chain, chatPageId: at.leaveWhen.pageId };
    at = byId.get(next);
  }
  return { chain, chatPageId: at?.id ?? entry.id };
}

function retarget(page: UiPage, from: string, to: string): UiPage {
  return {
    ...page,
    elements: page.elements.map((el) =>
      elementActions(el).some((a) => a.kind === "go-page" && a.pageId === from)
        ? mapElementActions(el, (actions) => actions.map((a) => (a.kind === "go-page" && a.pageId === from ? { ...a, pageId: to } : a)))
        : el),
  };
}

/**
 * Build a template's page and splice it into the card's opening chain.
 *
 * Returns the new document and the page's id. The page is inserted where its
 * `place` says, the page before it now goes to it, and it goes on to what the
 * page before it used to go to.
 */
export function insertPageTemplate(
  doc: UiDoc,
  template: UiPageTemplate,
  input: Omit<UiPageTemplateInput, "pageId" | "nextPageId" | "firstPageId">,
  pageId: string,
  /** Template variable id → the card's own variable to use instead, when the
   *  card already tracks the same thing under another id (its 「当前位置」
   *  for the map's `location`). */
  varMap: Record<string, string> = {},
): UiDoc {
  const map = Object.entries(varMap).filter(([from, to]) => from && to && from !== to);
  const next = withSamples(insertRaw(doc, template, input, pageId), template, input.strings, varMap);
  if (map.length === 0) return next;
  const before = new Map((doc.pages ?? []).map((p) => [p.id, new Set(p.elements.map((el) => el.id))]));
  return {
    ...next,
    pages: next.pages.map((p) => {
      const old = before.get(p.id);
      return { ...p, elements: p.elements.map((el) => (old?.has(el.id) ? el : remapVariables(el, map))) };
    }),
  };
}

/** Add the template's editor-only samples, under the card's own variable ids,
 *  without replacing one the card already has. */
function withSamples(doc: UiDoc, template: UiPageTemplate, strings: Record<string, string>, varMap: Record<string, string>): UiDoc {
  const made = template.samples?.(strings) ?? {};
  const have = doc.editorSamples ?? {};
  const add = Object.entries(made)
    .map(([id, value]) => [varMap[id] || id, value] as const)
    .filter(([id]) => !(id in have));
  if (add.length === 0) return doc;
  return { ...doc, editorSamples: { ...have, ...Object.fromEntries(add) } };
}

/** Point an element's bindings, conditions, steps and `{{macros}}` at other
 *  variable ids. */
function remapVariables(el: UiElement, map: Array<[string, string]>): UiElement {
  let json = JSON.stringify(el);
  for (const [from, to] of map) {
    const f = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const safe = JSON.stringify(to).slice(1, -1).replace(/\$/g, "$$$$");
    json = json
      .replace(new RegExp(`("(?:variableId|valueRef)":)"${f}"`, "g"), `$1"${safe}"`)
      .replace(new RegExp(`\\{\\{\\s*${f}(\\s*\\}\\}|\\.)`, "g"), `{{${safe}$1`)
      .replace(new RegExp(`("requires":\\[[^\\]]*)"${f}"`, "g"), `$1"${safe}"`);
  }
  return JSON.parse(json) as UiElement;
}

function insertRaw(
  doc: UiDoc,
  template: UiPageTemplate,
  input: Omit<UiPageTemplateInput, "pageId" | "nextPageId" | "firstPageId">,
  pageId: string,
): UiDoc {
  const { chain, chatPageId } = openingChain(doc);
  if (template.place === "play") return insertPlayPage(doc, template, input, pageId, chatPageId);
  const pagesById = new Map((doc.pages ?? []).map((p) => [p.id, p]));
  const isConfirm = (id: string) => pagesById.has(id) && id.startsWith("confirm-");
  let at: number;
  if (template.place === "first") at = 0;
  else if (template.place === "last") at = chain.length;
  else {
    // Before a confirm page, which always comes last.
    const tail = chain.length > 0 && isConfirm(chain[chain.length - 1]!) ? chain.length - 1 : chain.length;
    at = tail;
  }
  const prev = at > 0 ? chain[at - 1] : undefined;
  const next = chain[at] ?? chatPageId;
  const first = at === 0 ? pageId : chain[0]!;
  const built = template.build({ ...input, pageId, nextPageId: next, firstPageId: first });
  const made: UiPage = { ...built, leaveWhen: { when: STARTED, pageId: chatPageId } };

  let pages = (doc.pages ?? []).map((p) => (p.id === prev ? retarget(p, next, pageId) : p));
  // In the list, the new page sits just before the page it leads to.
  const idx = pages.findIndex((p) => p.id === next);
  pages = idx >= 0 ? [...pages.slice(0, idx), made, ...pages.slice(idx)] : [...pages, made];
  return { ...doc, pages, entryPageId: at === 0 ? pageId : doc.entryPageId };
}

/**
 * Keep a confirm page's summary in step with the pages added after it: the
 * sheet lists every choice the opening pages now ask for. Only a summary that
 * still reads exactly as generated is rewritten — once the creator has edited
 * it, it is theirs.
 */
export function refreshConfirmSummary(
  doc: UiDoc,
  summary: UiPageTemplateInput["summary"],
  strings: Record<string, string>,
): UiDoc {
  const generated = /^(?:[^\n{}]+\{\{[\w.-]+\}\}(?:\n|$))+$/;
  let changed = false;
  const pages = (doc.pages ?? []).map((pg) => {
    if (!pg.id.startsWith("confirm-")) return pg;
    return {
      ...pg,
      elements: pg.elements.map((el) => {
        if (el.id !== `${pg.id}-summary` || el.type !== "text") return el;
        const now = el.text.template;
        if (now !== t(strings, "nothingYet") && !generated.test(now)) return el;
        const next = summaryText(summary, strings);
        if (next === now) return el;
        changed = true;
        return { ...el, text: { template: next } };
      }),
    };
  });
  return changed ? { ...doc, pages } : doc;
}

/**
 * Keep the opening pages when the rest of the screen is replaced.
 *
 * Switching the card's layout builds a new document from scratch. The pages a
 * player goes through before the story (asking their name, picking an
 * opening) are not part of any layout — they are the creator's sequence — so
 * they move across in front of the new layout's first page, leading to it and
 * stepping aside to it exactly as they led to the old one.
 */
export function carryOpeningChain(previous: UiDoc | undefined, next: UiDoc): UiDoc {
  if (!previous) return next;
  const { chain, chatPageId } = openingChain(previous);
  if (chain.length === 0) return next;
  const taken = new Set((next.pages ?? []).map((p) => p.id));
  const byId = new Map((previous.pages ?? []).map((p) => [p.id, p]));
  const moved = chain
    .map((id) => byId.get(id))
    .filter((p): p is UiPage => Boolean(p) && !taken.has(p!.id))
    .map((p) => ({
      ...retarget(p, chatPageId, next.entryPageId),
      leaveWhen: { when: STARTED, pageId: next.entryPageId },
    }));
  if (moved.length === 0) return next;
  return { ...next, pages: [...moved, ...(next.pages ?? [])], entryPageId: moved[0]!.id };
}

/** Parts a button must not be dropped on. Pictures and panels are surfaces —
 *  a button over the art is fine; one over words or another control is not. */
const blocks = (el: UiElement) =>
  el.type !== "messages" && el.type !== "composer" && el.type !== "chat"
  && el.type !== "image" && el.type !== "box" && el.type !== "popup";

type Rect = { x: number; y: number; w: number; h: number };
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Where the menu button goes: the first corner spot nothing readable or
 * pressable already occupies, trying the top corners before stepping down.
 * A layout's own chips and buttons are left alone; its art is not an obstacle.
 */
function cornerSpot(page: UiPage, canvas: "phone" | "desktop", w: number, h: number): Rect {
  const cw = canvas === "desktop" ? UI_DESKTOP_W : W;
  const m = canvas === "desktop" ? 20 : 12;
  const taken: Rect[] = page.elements.filter(blocks).flatMap((el) => {
    if (canvas === "desktop") return el.desktop ? [el.desktop] : [];
    return el.w > 0 && el.h > 0 ? [{ x: el.x, y: el.y, w: el.w, h: el.h }] : [];
  });
  for (let row = 0; row < 6; row++) {
    for (const x of [cw - m - w, m]) {
      const spot = { x, y: m + row * (h + 8), w, h };
      if (!taken.some((r) => overlaps(r, { x: spot.x - 4, y: spot.y - 4, w: spot.w + 8, h: spot.h + 8 }))) return spot;
    }
  }
  return freeSpotOn(page, canvas, w, h);
}

/**
 * The conversation is not an obstacle for the menu button (it fills the
 * page), but its first line must not sit under the button: a conversation the
 * button lands on starts below it instead, on each canvas.
 */
function clearUnder(elements: UiElement[], button: UiElement): UiElement[] {
  const below = (box: Rect, over: Rect | undefined): Rect | null => {
    if (!over || !overlaps(box, over)) return null;
    const top = over.y + over.h + 8;
    const h = box.y + box.h - top;
    return h >= 160 ? { ...box, y: top, h } : null;
  };
  return elements.map((el) => {
    if (el.type !== "messages" && el.type !== "chat") return el;
    const phone = below({ x: el.x, y: el.y, w: el.w, h: el.h }, button);
    const desk = el.desktop ? below(el.desktop, button.desktop ?? undefined) : null;
    if (!phone && !desk) return el;
    return { ...el, ...(phone ?? {}), ...(desk ? { desktop: { ...el.desktop!, ...desk } } : {}) };
  });
}

/**
 * A play template: its page goes at the end, reached from ONE menu.
 *
 * The first play page brings the menu with it — a page listing every play
 * function, and a single 「菜单」 button on the conversation. Every later one
 * only adds a row to that page, so the conversation never fills up with
 * buttons however many functions a card takes. Anything that must be on
 * screen while the story runs (a popup) goes on the conversation itself.
 */
function insertPlayPage(
  doc: UiDoc,
  template: UiPageTemplate,
  input: Omit<UiPageTemplateInput, "pageId" | "nextPageId" | "firstPageId">,
  pageId: string,
  chatPageId: string,
): UiDoc {
  const s = input.strings;
  const full: UiPageTemplateInput = { ...input, pageId, nextPageId: chatPageId, firstPageId: chatPageId };
  const built = template.build(full);
  let pages = [...(doc.pages ?? [])];
  const chat = pages.find((p) => p.id === chatPageId);
  if (!chat) return { ...doc, pages: [...pages, built] };

  // The menu, once.
  if (!pages.some((p) => p.id === PLAY_MENU_ID)) {
    const menuInput: UiPageTemplateInput = { ...full, pageId: PLAY_MENU_ID, strings: { ...s, title: t(s, "menuTitle"), sub: t(s, "menuSub"), backName: t(s, "backName") } };
    pages.push(page(menuInput, t(s, "menuTitle"), playTop(menuInput), { panel: true }));
    const pw = 76;
    const ph = 32;
    const opener: UiElement = applyUiLook({
      id: `${PLAY_MENU_ID}-opener`, type: "button", name: t(s, "menuTitle"),
      ...cornerSpot(chat, "phone", pw, ph), desktop: cornerSpot(chat, "desktop", 92, 36), z: 50,
      label: { template: t(s, "menuOpener") },
      actions: [{ kind: "go-page", pageId: PLAY_MENU_ID }],
      style: { size: 13 },
    }, "button-soft");
    pages = pages.map((p) => (p.id === chatPageId ? { ...p, elements: [...clearUnder(p.elements, opener), opener] } : p));
  }

  // This function's row on the menu.
  pages = pages.map((p) => {
    if (p.id !== PLAY_MENU_ID) return p;
    const k = p.elements.filter((el) => el.id.endsWith("-menuitem")).length;
    const item: UiElement = applyUiLook({
      id: `${pageId}-menuitem`, type: "button", name: t(s, "opener"),
      ...menuItemBox(k),
      label: { template: t(s, "opener") },
      actions: [{ kind: "go-page", pageId }],
      style: { size: 16 },
    }, "button-soft");
    return { ...p, elements: [...p.elements, item] };
  });

  const extras = template.chatParts ? template.chatParts(full) : [];
  if (extras.length) pages = pages.map((p) => (p.id === chatPageId ? { ...p, elements: [...p.elements, ...extras] } : p));
  return { ...doc, pages: [...pages, built] };
}
