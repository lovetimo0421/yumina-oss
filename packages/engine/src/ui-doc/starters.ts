import { applyUiLook } from "./looks.js";
import { UI_CANVAS_W, UI_CHAT_STARTED, UI_DESKTOP_H, UI_DESKTOP_W } from "./types.js";
import type { UiDoc, UiElement, UiPage, UiTextStyle } from "./types.js";
import type { UiThemeChoice } from "./themes.js";
import { buildUiTheme } from "./themes.js";

/**
 * Starters: whole first screens a new card can begin from, built ONLY out of
 * ordinary parts.
 *
 * The official layouts (templates.ts) arrange a conversation and the numbers
 * around it. These go one step earlier — the moment before the conversation:
 * pick where the story starts, say who you are, carry a pack, collect things.
 * They are deliberately not replicas of any card and not shaped after one
 * genre: each is a handful of parts (a choice, three fields, a list, a popup)
 * that a creator can drag, restyle, delete or copy onto another card, and the
 * remix is always "add or remove parts" — an opening picker grows a form page
 * by adding fields, a collection grows a status rail by adding meters.
 *
 * Variables are part of the starter because a screen bound to variables that
 * do not exist is a picture of a screen. Their ids are fixed, readable words
 * (`bag`, `unlocked`) because the AI writes them by id in its directives, and
 * a readable id is one the model gets right. Words — every label, title and
 * example — come from the caller in the creator's language.
 */

export interface UiStarterVariable {
  id: string;
  /** String key for the variable's display name. */
  nameKey: string;
  type: "string" | "number" | "json" | "boolean";
  defaultValue: string | number | boolean | unknown[];
  min?: number;
  max?: number;
  /** Survives an opening switch — what the player chose before the story. */
  setup?: boolean;
}

export interface UiStarterInput {
  strings: Record<string, string>;
  /** Replaces the starter's own theme when given. */
  theme?: UiThemeChoice;
}

export interface UiStarter {
  id: "openings" | "character-setup" | "adventure-panel" | "collection";
  /** The look it ships in — each starter wears a different official theme so
   *  the four read as four things in the chooser. */
  theme: UiThemeChoice;
  variables: UiStarterVariable[];
  /** Number of openings (greeting entries) the doc switches between, in order. */
  greetings: number;
  build(input: UiStarterInput): UiDoc;
}

// ── Shared geometry ────────────────────────────────────────────────────────

const W = UI_CANVAS_W;
const H = 812;
const PAD = 20;
const COL = W - PAD * 2;
const D_W = UI_DESKTOP_W;
const D_H = UI_DESKTOP_H;
const COMPOSER_H = 88;
const D_COMPOSER_H = 94;

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

const TEXT = "var(--yc-text, #f1ece4)";
const QUIET = "color-mix(in srgb, var(--yc-text, #f1ece4) 62%, transparent)";
const ACCENT = "var(--yc-send-bg, #d9a13f)";
const LINE = "color-mix(in srgb, var(--yc-text, #f1ece4) 12%, transparent)";
const SURFACE = "var(--yc-input-bg, rgba(255,255,255,0.06))";
/** Words on the page are set in the theme's own face — 素纸's serif, 终端's
 *  mono — the same one the parts and the chat already use. */
const FONT = "var(--yc-font, inherit)";

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

function rule(id: string, phone: { x: number; y: number; w: number }, desktop: { x: number; y: number; w: number } | null): UiElement {
  return {
    id, type: "box", ...phone, h: 1,
    desktop: desktop ? { ...desktop, h: 1 } : null,
    style: { fills: [{ kind: "color", color: LINE }] },
  };
}

/** Transcript and composer, the conversation every starter ends in. */
function conversation(
  prefix: string,
  phoneTop: number,
  desk: { x: number; w: number; top: number },
): UiElement[] {
  return [
    {
      id: `${prefix}-messages`, type: "messages",
      x: 0, y: phoneTop, w: W, h: H - COMPOSER_H - phoneTop,
      desktop: box(desk.x, desk.top, desk.w, D_H - D_COMPOSER_H - desk.top),
    },
    {
      id: `${prefix}-composer`, type: "composer",
      x: 0, y: H - COMPOSER_H, w: W, h: COMPOSER_H,
      desktop: box(desk.x, D_H - D_COMPOSER_H, desk.w, D_COMPOSER_H),
    },
  ];
}

/** A small pill: a box and the words on it, one thing to the editor. */
function pill(
  id: string,
  template: string,
  phone: { x: number; y: number; w: number },
  desktop: { x: number; y: number; w: number } | null,
  opts: { visibleWhen?: UiElement["visibleWhen"]; align?: "left" | "center" | "right" } = {},
): UiElement[] {
  const group = `g-${id}`;
  return [
    {
      id: `${id}-bg`, group, type: "box", ...phone, h: 26,
      desktop: desktop ? { ...desktop, h: 28 } : null,
      ...(opts.visibleWhen ? { visibleWhen: opts.visibleWhen } : {}),
      css: "border-radius: var(--yc-send-radius, 999px);",
      style: { fills: [{ kind: "color", color: "color-mix(in srgb, var(--yc-send-bg, #d9a13f) 16%, transparent)" }] },
    },
    {
      id, group, type: "text",
      x: phone.x + 10, y: phone.y + 6, w: phone.w - 20, h: 15,
      desktop: desktop ? box(desktop.x + 12, desktop.y + 6, desktop.w - 24, 17) : null,
      ...(opts.visibleWhen ? { visibleWhen: opts.visibleWhen } : {}),
      text: { template },
      style: {
        size: 11.5, desktopSize: 12.5, weight: 600, align: opts.align ?? "center", nowrap: true, lineHeight: 1.2, family: FONT,
        color: "color-mix(in srgb, var(--yc-send-bg, #d9a13f) 62%, var(--yc-text, #f1ece4))",
      },
    },
  ];
}

function meter(
  id: string,
  label: string,
  variableId: string,
  phone: { x: number; y: number; w: number },
  desktop: { x: number; y: number; w: number } | null,
  fill: string,
): UiElement[] {
  const group = `g-${id}`;
  const parts: UiElement[] = [
    text(`${id}-label`, label, box(phone.x, phone.y, phone.w - 34, 14), desktop ? box(desktop.x, desktop.y, desktop.w - 40, 16) : null,
      { size: 11, desktopSize: 12.5, color: QUIET, letterSpacing: 0.4, lineHeight: 1.15, nowrap: true }),
    text(`${id}-value`, `{{${variableId}}}`, box(phone.x + phone.w - 34, phone.y - 1, 34, 15), desktop ? box(desktop.x + desktop.w - 40, desktop.y - 1, 40, 17) : null,
      { size: 12, desktopSize: 13.5, weight: 700, align: "right", lineHeight: 1.1, nowrap: true }),
    {
      id, group, type: "meter",
      x: phone.x, y: phone.y + 20, w: phone.w, h: 5,
      desktop: desktop ? box(desktop.x, desktop.y + 24, desktop.w, 6) : null,
      value: { kind: "variable", variableId, fallback: 50 },
      min: { kind: "literal", value: 0 },
      max: { kind: "literal", value: 100 },
      style: {
        track: [{ kind: "color", color: "color-mix(in srgb, var(--yc-text, #f1ece4) 10%, transparent)" }],
        fills: [{ kind: "color", color: fill }],
        radius: 999,
      },
    },
  ];
  return parts.map((el) => ({ ...el, group }));
}

function doc(input: UiStarterInput, fallback: UiThemeChoice, entryPageId: string, pages: UiPage[]): UiDoc {
  const theme = buildUiTheme(input.theme ?? fallback);
  return { version: 1, entryPageId, pages, ...(theme ? { theme } : {}) };
}

const STARTED = { variableId: UI_CHAT_STARTED, operator: "eq" as const, value: true };

// ── 1. 开局卡片 ────────────────────────────────────────────────────────────
//
// A page of openings. Each card is one of the card's greetings; picking it
// switches to that greeting and goes to the conversation. The page is only
// there until the player has said something — after that the card opens
// straight on the chat.

function openings(input: UiStarterInput): UiDoc {
  const s = input.strings;
  const options = [1, 2, 3, 4].map((n, i) => ({
    id: `opening-${n}`,
    title: t(s, `opening${n}Title`),
    subtitle: t(s, `opening${n}Sub`),
    tags: [t(s, `opening${n}Mood`)],
    actions: [
      { kind: "switch-greeting" as const, index: i },
      { kind: "go-page" as const, pageId: "chat" },
    ],
  }));

  const pick: UiElement = applyUiLook({
    id: "open-cards", type: "choice", name: t(s, "cardsName"),
    x: PAD - 2, y: 176, w: COL + 4, h: 604,
    desktop: box(72, 212, D_W - 144, 392),
    // No column count: two on the phone, and the wide canvas fits all four
    // in a row. A set count would hold on both.
    layout: "grid", gap: 12,
    variableId: "opening",
    options,
  }, "choice-cover");

  const openPage: UiPage = {
    id: "open",
    name: t(s, "pageOpen"),
    height: H,
    leaveWhen: { when: STARTED, pageId: "chat" },
    elements: [
      // A wash of the accent behind the heading: the page's one piece of light.
      {
        id: "open-glow", type: "box", x: 0, y: 0, w: W, h: 320,
        // Phone only: on the wide canvas the band would end at the canvas
        // edge and draw a seam against the window's own ground.
        desktop: null,
        style: { fills: [{ kind: "gradient", angle: 180, stops: [
          { color: "color-mix(in srgb, var(--yc-send-bg, #d9a13f) 20%, transparent)", at: 0 },
          { color: "transparent", at: 100 },
        ] }] },
      },
      text("open-title", t(s, "openTitle"), box(PAD + 4, 64, COL - 8, 38), box(72, 72, 640, 48),
        { size: 28, desktopSize: 38, weight: 700, letterSpacing: 0.2, lineHeight: 1.15, nowrap: true }),
      text("open-sub", t(s, "openSub"), box(PAD + 4, 110, COL - 8, 48), box(72, 128, 560, 52),
        { size: 13.5, desktopSize: 15, color: QUIET, lineHeight: 1.6 }),
      { ...pick, z: 2 },
    ],
  };

  const chatPage: UiPage = {
    id: "chat",
    name: t(s, "pageChat"),
    height: H,
    elements: [
      text("chat-title", t(s, "title"), box(PAD, 20, COL - 132, 26), box(148, 24, 480, 30),
        { size: 18, desktopSize: 21, weight: 700, nowrap: true, lineHeight: 1.2 }),
      text("chat-sub", t(s, "chatSub"), box(PAD, 46, COL - 132, 18), box(148, 56, 480, 20),
        { size: 12, desktopSize: 13, color: QUIET, nowrap: true }),
      ...pill("chat-opening", "{{opening}}", { x: W - PAD - 118, y: 24, w: 118 }, { x: D_W - 148 - 150, y: 30, w: 150 },
        { visibleWhen: { variableId: "opening", operator: "neq", value: "" } }),
      rule("chat-rule", { x: PAD, y: 76, w: COL }, { x: 148, y: 92, w: D_W - 296 }),
      ...conversation("chat", 80, { x: 128, w: D_W - 256, top: 96 }),
    ],
  };

  return doc(input, UI_STARTERS_THEME.openings, "open", [openPage, chatPage]);
}

// ── 2. 建角开局 ────────────────────────────────────────────────────────────
//
// A form before the story: a name, who you are (a few to pick or your own),
// a line about yourself. The start button waits for the name and the role,
// then sends the player's introduction as their first message — so the AI's
// first real reply is already addressed to this person.

function characterSetup(input: UiStarterInput): UiDoc {
  const s = input.strings;
  const formX = 540;
  const formW = 400;
  const formPage: UiPage = {
    id: "form",
    name: t(s, "pageForm"),
    height: H,
    leaveWhen: { when: STARTED, pageId: "chat" },
    elements: [
      text("form-title", t(s, "formTitle"), box(PAD + 4, 58, COL - 8, 40), box(84, 92, 380, 52),
        { size: 30, desktopSize: 40, weight: 700, letterSpacing: 1, lineHeight: 1.15, nowrap: true }),
      text("form-sub", t(s, "formSub"), box(PAD + 4, 106, COL - 8, 48), box(84, 158, 360, 56),
        { size: 14, desktopSize: 15.5, color: QUIET, lineHeight: 1.65 }),
      rule("form-rule", { x: PAD + 4, y: 170, w: 48 }, { x: 84, y: 234, w: 48 }),
      // The gatekeeper's register, as the page's one object: what the form is
      // about to become. Wide canvas only — the phone has no room beside it.
      {
        id: "form-register", type: "box", x: 0, y: 0, w: 0, h: 0, desktop: box(84, 270, 360, 296),
        css: "border-radius: var(--yc-input-radius, 12px);",
        style: {
          fills: [{ kind: "color", color: "color-mix(in srgb, var(--yc-text, #2b2622) 4%, transparent)" }],
          borderColor: "color-mix(in srgb, var(--yc-text, #2b2622) 12%, transparent)", borderWidth: 1, borderStyle: "dashed",
        },
      },
      text("form-register-label", t(s, "whoLabel"), box(0, 0, 0, 0), box(108, 292, 312, 18),
        { size: 11, desktopSize: 12, color: QUIET, letterSpacing: 2, nowrap: true }),
      {
        ...text("form-register-empty", t(s, "registerEmpty"), box(0, 0, 0, 0), box(108, 330, 312, 30),
          { size: 16, desktopSize: 17, color: QUIET, italic: true, nowrap: true }),
        visibleWhen: { variableId: "player_name", operator: "eq", value: "" },
      },
      text("form-register-name", "{{player_name}}", box(0, 0, 0, 0), box(108, 322, 312, 44),
        { size: 30, desktopSize: 32, weight: 700, nowrap: true, lineHeight: 1.2 }),
      text("form-register-identity", "{{identity}}", box(0, 0, 0, 0), box(108, 374, 312, 24),
        { size: 15, desktopSize: 16, color: ACCENT, weight: 600, nowrap: true }),
      text("form-register-about", "{{about}}", box(0, 0, 0, 0), box(108, 410, 312, 136),
        { size: 13.5, desktopSize: 14, color: QUIET, lineHeight: 1.75 }),
      applyUiLook({
        id: "form-name", type: "field", kind: "text", variableId: "player_name",
        x: PAD + 4, y: 196, w: COL - 8, h: 80, desktop: box(formX, 92, formW, 80),
        label: { template: t(s, "nameLabel") }, placeholder: t(s, "namePlaceholder"),
      }, "field-underline"),
      applyUiLook({
        id: "form-identity", type: "field", kind: "chips", variableId: "identity",
        x: PAD + 4, y: 298, w: COL - 8, h: 108, desktop: box(formX, 196, formW, 92),
        label: { template: t(s, "identityLabel") },
        options: [1, 2, 3, 4, 5].map((n) => t(s, `identity${n}`)),
        allowCustom: true, placeholder: t(s, "identityCustom"),
      }, "field-underline"),
      applyUiLook({
        id: "form-about", type: "field", kind: "textarea", variableId: "about",
        x: PAD + 4, y: 428, w: COL - 8, h: 176, desktop: box(formX, 310, formW, 146),
        label: { template: t(s, "aboutLabel") }, placeholder: t(s, "aboutPlaceholder"),
      }, "field-underline"),
      applyUiLook({
        id: "form-start", type: "button",
        x: PAD + 4, y: 690, w: COL - 8, h: 52, desktop: box(formX, 484, formW, 52),
        label: { template: t(s, "startLabel") },
        requires: ["player_name", "identity"],
        actions: [
          { kind: "go-page", pageId: "chat" },
          { kind: "send-message", text: { template: t(s, "introMessage") } },
        ],
        style: { size: 16 },
      }, "button-solid"),
      text("form-hint", t(s, "startHint"), box(PAD + 4, 752, COL - 8, 18), box(formX, 548, formW, 18),
        { size: 12, desktopSize: 12.5, color: QUIET, align: "center", nowrap: true }),
    ],
  };
  // The hint says what the button is waiting for, and only while it waits.
  const hint = formPage.elements.find((el) => el.id === "form-hint")!;
  hint.visibleWhen = { variableId: "player_name", operator: "eq", value: "" };

  const railW = 300;
  const chatPage: UiPage = {
    id: "chat",
    name: t(s, "pageChat"),
    height: H,
    elements: [
      {
        id: "who-card", group: "g-who", type: "box",
        x: PAD - 6, y: 14, w: COL + 12, h: 70, desktop: box(24, 24, railW - 24, D_H - 48),
        css: "border-radius: var(--yc-input-radius, 14px);",
        style: { fills: [{ kind: "color", color: SURFACE }], borderColor: LINE, borderWidth: 1 },
      },
      text("who-label", t(s, "whoLabel"), box(PAD + 8, 24, 160, 14), box(48, 50, 220, 16),
        { size: 10.5, desktopSize: 12, color: QUIET, letterSpacing: 1.5, nowrap: true }),
      text("who-name", "{{player_name}}", box(PAD + 8, 42, COL - 140, 28), box(48, 74, railW - 72, 40),
        { size: 20, desktopSize: 28, weight: 700, nowrap: true, lineHeight: 1.2 }),
      ...pill("who-identity", "{{identity}}", { x: W - PAD - 112, y: 36, w: 104 }, { x: 48, y: 124, w: 132 },
        { visibleWhen: { variableId: "identity", operator: "neq", value: "" } }),
      // The paragraph about you has room only on the wide canvas.
      text("who-about", "{{about}}", box(0, 0, 0, 0), box(48, 172, railW - 72, 300),
        { size: 13, desktopSize: 14, color: QUIET, lineHeight: 1.75 }),
      ...conversation("chat", 92, { x: railW + 8, w: D_W - railW - 32, top: 24 }),
    ],
  };

  return doc(input, UI_STARTERS_THEME["character-setup"], "form", [formPage, chatPage]);
}

// ── 3. 冒险面板 ────────────────────────────────────────────────────────────
//
// The conversation with a status panel beside it: where you are, three
// meters, what you carry, and a popup the moment something new goes in the
// bag. Every value is a variable the AI writes — the card's rules entry and
// behaviours tell it how — so the panel moves as the story does.

function adventurePanel(input: UiStarterInput): UiDoc {
  const s = input.strings;
  // The rail floats: an inset panel reads as a panel at any window shape,
  // where a full-bleed one ends at the canvas edge and shows the seam.
  const railW = 300;
  const rx = 44;
  const rw = railW - rx - 20;
  const mW = Math.floor((COL - 24) / 3);

  const bag = (phone: { x: number; y: number; w: number; h: number }, desktop: { x: number; y: number; w: number; h: number } | null): UiElement => applyUiLook({
    id: "bag", type: "list",
    ...phone, desktop,
    source: { kind: "variable", variableId: "bag" },
    item: { template: "{{item.name}}" },
    direction: "row",
    gap: 8,
    emptyText: { template: t(s, "bagEmpty") },
    card: { title: { template: "{{item.name}}" }, subtitle: { template: "{{item.note}}" }, imageField: "icon" },
  }, "list-tiles");

  // The bag is two elements: a strip across on the phone, a column down the
  // rail on the wide canvas. Each hides on the other's canvas.
  const phoneBag = bag(box(PAD, 132, COL, 62), null);
  const deskBag = { ...bag(box(0, 0, 0, 0), box(rx, 306, rw, 290)), id: "bag-rail", direction: "column" } as UiElement;

  const elements: UiElement[] = [
    {
      id: "rail", type: "box", x: 0, y: 0, w: 0, h: 0, desktop: box(20, 20, railW - 20, D_H - 40),
      css: "border-radius: var(--yc-input-radius, 14px);",
      style: { fills: [{ kind: "color", color: SURFACE }], borderColor: LINE, borderWidth: 1 },
    },
    text("where-label", t(s, "whereLabel"), box(PAD, 18, 140, 14), box(rx, 44, rw, 16),
      { size: 10.5, desktopSize: 12, color: QUIET, letterSpacing: 1.5, nowrap: true }),
    text("where", "{{location}}", box(PAD, 34, COL - 90, 26), box(rx, 64, rw, 32),
      { size: 19, desktopSize: 24, weight: 700, nowrap: true, lineHeight: 1.2 }),
    ...meter("m-health", t(s, "healthLabel"), "health", { x: PAD, y: 76, w: mW }, { x: rx, y: 124, w: rw }, "#d0605a"),
    ...meter("m-stamina", t(s, "staminaLabel"), "stamina", { x: PAD + mW + 12, y: 76, w: mW }, { x: rx, y: 172, w: rw }, "#6fae6a"),
    ...meter("m-oil", t(s, "oilLabel"), "lamp_oil", { x: PAD + (mW + 12) * 2, y: 76, w: mW }, { x: rx, y: 220, w: rw }, ACCENT),
    text("bag-label", t(s, "bagLabel"), box(PAD, 112, 160, 14), box(rx, 280, rw, 16),
      { size: 10.5, desktopSize: 12, color: QUIET, letterSpacing: 1.5, nowrap: true }),
    phoneBag,
    deskBag,
    rule("main-rule", { x: PAD, y: 204, w: COL }, null),
    ...conversation("chat", 208, { x: railW + 8, w: D_W - railW - 32, top: 20 }),
    applyUiLook({
      id: "found", type: "popup", variableId: "new_item",
      x: 38, y: 250, w: W - 76, h: 250, desktop: box((D_W + railW) / 2 - 190, 170, 380, 260), z: 1000,
      title: { template: t(s, "foundTitle") },
      body: { template: "{{value}}" },
      buttonLabel: { template: t(s, "foundButton") },
    }, "popup-reward"),
  ];
  return doc(input, UI_STARTERS_THEME["adventure-panel"], "main", [
    { id: "main", name: t(s, "pageMain"), height: H, elements },
  ]);
}

// ── 4. 解锁收集 ────────────────────────────────────────────────────────────
//
// Things to find. The collection page lists every one of them from the start,
// greyed out until the story unlocks it — the AI pushes an id into
// `unlocked` and says what was found in `unlock_note`, and the popup tells
// the player the moment it happens.

export const COLLECTION_IDS = ["lamp", "letter", "key", "shell", "photo", "ticket", "bell", "map"] as const;

function collection(input: UiStarterInput): UiDoc {
  const s = input.strings;
  const rows = COLLECTION_IDS.map((id) => ({
    id,
    title: t(s, `item_${id}_title`),
    body: t(s, `item_${id}_body`),
    // Where to look, shown in place of the title until it is found: a locked
    // row that says "somewhere in the attic" is a lead, not a blank.
    hint: t(s, `item_${id}_hint`),
  }));
  const card = {
    title: { template: "{{item.title}}" },
    subtitle: { template: "{{item.body}}" },
    imageField: "icon",
    lockedUnless: { variableId: "unlocked", field: "id" },
    lockedText: { template: "{{item.hint}}" },
  };
  const railX = 684;
  const railW = D_W - railX - 44;

  const chatPage: UiPage = {
    id: "chat",
    name: t(s, "pageChat"),
    height: H,
    elements: [
      {
        id: "rail", type: "box", x: 0, y: 0, w: 0, h: 0, desktop: box(railX - 20, 20, D_W - railX, D_H - 40),
        css: "border-radius: var(--yc-input-radius, 14px);",
        style: { fills: [{ kind: "color", color: SURFACE }], borderColor: LINE, borderWidth: 1 },
      },
      text("chat-title", t(s, "title"), box(PAD, 20, COL - 120, 26), box(48, 24, 440, 30),
        { size: 18, desktopSize: 21, weight: 700, nowrap: true, lineHeight: 1.2 }),
      text("chat-sub", t(s, "chatSub"), box(PAD, 46, COL - 120, 18), box(48, 56, 440, 20),
        { size: 12, desktopSize: 13, color: QUIET, nowrap: true }),
      applyUiLook({
        id: "open-album", type: "button",
        x: W - PAD - 104, y: 22, w: 104, h: 36, desktop: null,
        label: { template: t(s, "albumButton") },
        actions: [{ kind: "go-page", pageId: "album" }],
        style: { size: 13 },
      }, "button-soft"),
      rule("chat-rule", { x: PAD, y: 76, w: COL }, { x: 48, y: 92, w: railX - 116 }),
      ...conversation("chat", 80, { x: 20, w: railX - 60, top: 96 }),
      text("rail-title", t(s, "albumTitle"), box(0, 0, 0, 0), box(railX, 44, railW, 26),
        { size: 17, desktopSize: 19, weight: 700, nowrap: true }),
      text("rail-sub", t(s, "albumSub"), box(0, 0, 0, 0), box(railX, 76, railW, 40),
        { size: 12, desktopSize: 12.5, color: QUIET, lineHeight: 1.55 }),
      applyUiLook({
        id: "rail-list", type: "list",
        x: 0, y: 0, w: 0, h: 0, desktop: box(railX, 128, railW, D_H - 168),
        source: { kind: "static", items: rows },
        item: { template: "{{item.title}}" },
        gap: 8,
        card,
      }, "list-tiles"),
      applyUiLook({
        id: "unlock-pop", type: "popup", variableId: "unlock_note",
        x: 38, y: 240, w: W - 76, h: 260, desktop: box((railX - 380) / 2, 160, 380, 270), z: 1000,
        title: { template: t(s, "unlockTitle") },
        body: { template: "{{value}}" },
        buttonLabel: { template: t(s, "unlockButton") },
      }, "popup-reward"),
    ],
  };
  // Phone-only parts carry no box on the wide canvas, wide-only parts no box
  // on the phone.
  for (const el of chatPage.elements) {
    if (el.w === 0 && el.h === 0 && el.desktop) Object.assign(el, { x: 0, y: 0 });
  }

  const albumPage: UiPage = {
    id: "album",
    name: t(s, "pageAlbum"),
    height: H,
    elements: [
      applyUiLook({
        id: "album-back", type: "button",
        x: PAD, y: 20, w: 40, h: 40, desktop: box(48, 28, 44, 44),
        label: { template: "←" },
        actions: [{ kind: "go-page", pageId: "chat" }],
        style: { size: 17 },
      }, "button-glass"),
      text("album-title", t(s, "albumTitle"), box(PAD, 76, COL, 36), box(112, 30, 600, 40),
        { size: 26, desktopSize: 30, weight: 700, nowrap: true, lineHeight: 1.2 }),
      text("album-sub", t(s, "albumSub"), box(PAD, 116, COL, 44), box(112, 74, 620, 46),
        { size: 13, desktopSize: 14, color: QUIET, lineHeight: 1.6 }),
      applyUiLook({
        id: "album-list", type: "list",
        x: PAD, y: 176, w: COL, h: H - 176 - 24, desktop: box(48, 136, D_W - 96, D_H - 160),
        source: { kind: "static", items: rows },
        item: { template: "{{item.title}}" },
        direction: "row", columns: 2, gap: 12,
        card: { ...card, imageRatio: 0.62 },
      }, "list-tiles"),
    ],
  };

  return doc(input, UI_STARTERS_THEME.collection, "chat", [chatPage, albumPage]);
}

const UI_STARTERS_THEME: Record<UiStarter["id"], UiThemeChoice> = {
  openings: { id: "night", accent: "#7a5cc4" },
  "character-setup": { id: "paper", accent: "#3a5478" },
  "adventure-panel": { id: "terminal", accent: "#d8a13f" },
  collection: { id: "blossom", accent: "#e5c07b" },
};

export const UI_STARTERS: UiStarter[] = [
  {
    id: "openings",
    theme: UI_STARTERS_THEME.openings,
    greetings: 4,
    variables: [{ id: "opening", nameKey: "varOpening", type: "string", defaultValue: "", setup: true }],
    build: openings,
  },
  {
    id: "character-setup",
    theme: UI_STARTERS_THEME["character-setup"],
    greetings: 1,
    variables: [
      { id: "player_name", nameKey: "varName", type: "string", defaultValue: "", setup: true },
      { id: "identity", nameKey: "varIdentity", type: "string", defaultValue: "", setup: true },
      { id: "about", nameKey: "varAbout", type: "string", defaultValue: "", setup: true },
    ],
    build: characterSetup,
  },
  {
    id: "adventure-panel",
    theme: UI_STARTERS_THEME["adventure-panel"],
    greetings: 1,
    variables: [
      { id: "location", nameKey: "varLocation", type: "string", defaultValue: "" },
      { id: "health", nameKey: "varHealth", type: "number", defaultValue: 90, min: 0, max: 100 },
      { id: "stamina", nameKey: "varStamina", type: "number", defaultValue: 75, min: 0, max: 100 },
      { id: "lamp_oil", nameKey: "varOil", type: "number", defaultValue: 100, min: 0, max: 100 },
      { id: "bag", nameKey: "varBag", type: "json", defaultValue: [] },
      { id: "new_item", nameKey: "varNewItem", type: "string", defaultValue: "" },
    ],
    build: adventurePanel,
  },
  {
    id: "collection",
    theme: UI_STARTERS_THEME.collection,
    greetings: 1,
    variables: [
      { id: "unlocked", nameKey: "varUnlocked", type: "json", defaultValue: [] },
      { id: "unlock_note", nameKey: "varUnlockNote", type: "string", defaultValue: "" },
    ],
    build: collection,
  },
];

export const getUiStarter = (id: string): UiStarter | undefined => UI_STARTERS.find((starter) => starter.id === id);
