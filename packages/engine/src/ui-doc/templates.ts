import { LIT_EDGE, METER_TRACK_FILLS, METER_TRACK_H as TRACK_H, meterFillsFor } from "./edit.js";
import { UI_CANVAS_W, UI_DESKTOP_H, UI_DESKTOP_W } from "./types.js";
import type { UiAction, UiDoc, UiElement, UiPage, UiTheme } from "./types.js";
import type { UiThemeChoice } from "./themes.js";

/**
 * Official layouts: an arrangement a creator picks, rather than one they place.
 *
 * ── What the set is for ──
 *
 * Measured against the live library (1,675 published cards, 16,051 drafts):
 * 75% of published cards carry a hand-written frontend whose median size is
 * 24KB of TSX, and 57% of drafts carry none at all. Nobody is in between,
 * because there was nothing in between to be in. These layouts are that middle
 * rung, and which ones exist is decided by what the library's variables
 * actually say people are tracking:
 *
 *   place / scene .... 31% of cards with variables   (当前位置 alone: 1,323 drafts)
 *   player profile ... 24%   (name, role, gender, age, background)
 *   a 0-100 meter .... 23%   (好感度/Trust/Affinity/Bond dominate, then 体力/HP)
 *   roster of NPCs ... 18%
 *   day / time ....... 16%   (Day is the single commonest number variable)
 *   money ............  8%   inventory 8%   story phase 8%
 *
 * So: one layout for the character card (portrait), one for the card that
 * tracks where and when you are (the largest need, and the one a text
 * adventure has), one for the card that tracks numbers, and one for the card
 * about who the PLAYER is. Between them they cover every need above.
 *
 * ── Why the name is never written on the art ──
 *
 * The obvious arrangement puts a character's name over their portrait, and it
 * is a trap: the name is drawn in `--yc-text`, which is near-white under three
 * themes and near-black under 素纸, over art whose brightness the layout cannot
 * know. One of those four combinations is always unreadable, and the one that
 * broke was the commonest — white name on bright art.
 *
 * So art carries only GLASS: a translucent dark plate with its own white text,
 * legible over anything because it brings its own ground. Every themed word
 * lives on the theme's own background, where `--yc-text` is the colour it was
 * chosen to be. Art fades into that ground through `--yc-bg-solid` (themes.ts)
 * so the join is a gradient rather than a cut.
 *
 * ── On composing with themes ──
 *
 * A layout paints no ground of its own and names no literal colour a theme
 * should own: every surface is a token, so 素纸's cream and 终端's black both
 * reach it. Each layout still arrives in one theme of its own (`look`): there
 * is no separate colour picker for a creator to find, so picking the layout is
 * picking its colours, and every part stays recolourable by hand after.
 */

/** The words a layout ships with, by key. They belong to the creator's
 *  language, so the caller passes them in rather than the engine holding a copy
 *  of anything. `title` is filled from the card's own name. */
export type UiTemplateStrings = Record<string, string>;

/** Variable ids the caller has already ensured exist, under the same keys the
 *  preset's `needs` declares. */
export type UiTemplateVariableIds = Record<string, string>;

/**
 * Turns `{key}` in a shipped string into the `{{id}}` macro the compiler
 * interpolates, so a caller writes "Day {day} · {timeOfDay}" in their own
 * language and the layout binds it to the variables it was given.
 *
 * Single braces in, double braces out — deliberately different shapes. A
 * string that already said `{{...}}` would be naming a variable id directly,
 * which a translator has no way to know, so the two syntaxes cannot collide.
 */
export function fillTemplateMacros(text: string, variableIds: UiTemplateVariableIds): string {
  // The first branch swallows an already-written `{{id}}` whole, so the second
  // never sees its inner braces. Without it, `{{already}}` matched as `{already}`
  // and came back `{{{v1}}}` — the exact collision this shape is meant to avoid.
  return text.replace(/\{\{[^{}]*\}\}|\{([A-Za-z][A-Za-z0-9_]*)\}/g, (whole, key?: string) => {
    if (key === undefined) return whole;
    const id = variableIds[key];
    return id ? `{{${id}}}` : whole;
  });
}

export interface UiTemplateInput {
  strings: UiTemplateStrings;
  variableIds: UiTemplateVariableIds;
  /** The colours the layout arrives in (built from the preset's `look`). */
  theme?: UiTheme;
}

export interface UiTemplateNeed {
  key: string;
  type: "string" | "number" | "json";
  min?: number;
  max?: number;
  defaultValue: string | number | unknown[];
  /** Seed this one from the card's cover image when it has one. */
  fromCover?: boolean;
}

export interface UiTemplatePreset {
  id: string;
  /** Variables the layout needs, created by the caller if the card lacks them. */
  needs: UiTemplateNeed[];
  /** String keys this layout asks for, so the editor can fetch exactly those. */
  stringKeys: string[];
  /** One element id this layout alone installs — how a document says which
   *  layout it is on after the creator has moved things around. */
  signature: string;
  /** The theme it arrives in. Absent = the platform's own look. */
  look?: UiThemeChoice;
  build(input: UiTemplateInput): UiDoc;
}

// ── Geometry ───────────────────────────────────────────────────────────────
//
// One column, one gutter, one rhythm, shared by every layout — so two of them
// side by side in the picker read as one family rather than four attempts.

const PAGE_H = 812;
const PAD = 18;
const COL = UI_CANVAS_W - PAD * 2;

const COMPOSER_H = 88;
const CHIP_H = 32;
/** The row of message actions is smaller than the openers on purpose: one is
 *  the card talking, the other is the machinery. */
const TOOL_H = 26;
const GAP = 8;
/**
 * Labels and readouts are drawn in boxes sized to the TYPE, but CSS lays out a
 * LINE BOX — half again as tall at the default 1.5 — and `overflow: hidden`
 * takes the difference off the bottom of the characters. Chinese shows it
 * worst, because the ink fills the em. So every one of them carries a line
 * height that fits its box, and anything holding a value the story writes
 * stays on one line and ends in an ellipsis rather than losing a second.
 */


const METER_LABEL_H = 14;
const METER_TRACK_H = TRACK_H;
const METER_BLOCK_H = METER_LABEL_H + 6 + METER_TRACK_H;
const METER_GAP = 14;
const HALF_W = Math.round((COL - METER_GAP) / 2);

const COMPOSER_Y = PAGE_H - COMPOSER_H;
const CHIPS_Y = COMPOSER_Y - GAP - CHIP_H;
const TOOLS_Y = CHIPS_Y - 6 - TOOL_H;

// ── The wide canvas ────────────────────────────────────────────────────────
//
// A phone stacks; a desktop divides. Every layout below puts its standing
// information down one side or across the top and gives the conversation the
// rest — and holds the transcript to a readable measure rather than letting a
// line of dialogue run the full width of a monitor.

const D_W = UI_DESKTOP_W;
const D_H = UI_DESKTOP_H;
const D_PAD = 28;
// Two rows: the text line and the row of buttons under it. Measured against
// the REAL composer in the sandbox, not against the Studio's one-line stub,
// which is what 76 was fitted to and what let it clip off the canvas.
const D_COMPOSER_H = 94;
const D_COMPOSER_Y = D_H - D_COMPOSER_H;
const D_CHIPS_Y = D_COMPOSER_Y - GAP - CHIP_H;
const D_TOOLS_Y = D_CHIPS_Y - 6 - TOOL_H;

/** A box on the wide canvas. Written out because every call site reads better
 *  as four numbers than as an object literal repeated eighty times. */
const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

/** Glass: a translucent dark plate with its own white text. The one material
 *  legible over art the layout has never seen, under every theme. */
const GLASS_FILL = { kind: "color" as const, color: "rgba(12,12,16,0.46)" };
const GLASS_TEXT = "#ffffff";

/**
 * Corners come from the theme, not from here.
 *
 * `UiRadius` is a number, so a literal 999 is a capsule under 终端 too — square
 * ground, square bubbles, square input, then a row of pill buttons the theme
 * never asked for. So elements leave `radius` unset and name the theme's token.
 *
 * `!important` because a button compiles with `border-radius: 10` inline even
 * when its style names none (the button case in compile.ts), and inline
 * outranks any stylesheet. Changing that default would re-corner every button
 * in every uiDoc card already saved, so the layout works around it.
 */
const CONTROL_RADIUS = "border-radius: var(--yc-send-radius, 999px) !important;";

const hairline = { kind: "color" as const, color: "var(--yc-chip-bg, rgba(255,255,255,0.10))" };
const chipFill = { kind: "color" as const, color: "var(--yc-chip-bg, rgba(255,255,255,0.08))" };
const chipText = "var(--yc-chip-fg, #e8e4df)";
const bodyText = "var(--yc-text, #f4f1ea)";
const quietText = "var(--yc-name, rgba(255,255,255,0.55))";
const ACCENT = "var(--yc-send-bg, #d9a13f)";

// ── Parts ──────────────────────────────────────────────────────────────────

/** One meter, as a labelled pair: name left, live value right, track under
 *  both. Every layout in the set draws its meters this way. */
function meter(
  id: string,
  x: number,
  y: number,
  w: number,
  label: string,
  variableId: string,
  size = 11,
  /** Where the same meter sits on the wide canvas. */
  d?: { x: number; y: number; w: number },
): UiElement[] {
  const valueW = 38;
  // Label, value and track are one thing to the person editing: selecting any
  // of them selects the meter, and deleting it takes the label with it.
  const group = `g-${id}`;
  return [
    {
      id: `${id}-label`,
      group,
      type: "text",
      x, y, w: w - valueW, h: METER_LABEL_H,
      ...(d ? { desktop: box(d.x, d.y, d.w - valueW, METER_LABEL_H) } : {}),
      text: { template: label },
      style: { size, desktopSize: size + 1, color: quietText, letterSpacing: 0.6, lineHeight: 1.15 },
    },
    {
      id: `${id}-value`,
      group,
      type: "text",
      // Two points larger and a notch heavier than its label, and lifted so the
      // two sit on one line: the number is the thing being read, and at the
      // same weight as the word beside it neither of them leads.
      x: x + w - valueW, y: y - 2, w: valueW, h: METER_LABEL_H + 2,
      ...(d ? { desktop: box(d.x + d.w - valueW, d.y - 2, valueW, METER_LABEL_H + 2) } : {}),
      text: { template: `{{${variableId}}}` },
      style: { size: size + 2, desktopSize: size + 4, weight: 700, color: bodyText, align: "right", lineHeight: 1.05, nowrap: true },
    },
    {
      id,
      group,
      type: "meter",
      x, y: y + METER_LABEL_H + 6, w, h: METER_TRACK_H,
      ...(d ? { desktop: box(d.x, d.y + METER_LABEL_H + 6, d.w, METER_TRACK_H) } : {}),
      value: { kind: "variable", variableId, fallback: 50 },
      min: { kind: "literal", value: 0 },
      max: { kind: "literal", value: 100 },
      style: { track: METER_TRACK_FILLS, fills: meterFillsFor(ACCENT), radius: 999 },
    },
  ];
}

/** A labelled readout on a chip: what it is, and what it currently says. Used
 *  for the values that are not 0-100 — a place, a day, a purse. */
function readout(
  id: string,
  x: number,
  y: number,
  w: number,
  label: string,
  template: string,
  align: "left" | "center" = "left",
  d?: { x: number; y: number; w: number },
): UiElement[] {
  const inset = align === "center" ? 0 : 12;
  const group = `g-${id}`;
  return [
    {
      id: `${id}-chip`, group, type: "box",
      x, y, w, h: 46,
      ...(d ? { desktop: box(d.x, d.y, d.w, 46) } : {}),
      css: "border-radius: var(--yc-input-radius, 12px);",
      style: { fills: [chipFill], shadows: LIT_EDGE },
    },
    {
      id: `${id}-label`,
      group,
      type: "text",
      x: x + inset, y: y + 8, w: w - inset * 2, h: 13,
      ...(d ? { desktop: box(d.x + inset, d.y + 8, d.w - inset * 2, 13) } : {}),
      text: { template: label },
      style: { size: 10, desktopSize: 11, color: quietText, letterSpacing: 0.9, align, nowrap: true, lineHeight: 1.15 },
    },
    {
      id,
      group,
      type: "text",
      x: x + inset, y: y + 22, w: w - inset * 2, h: 20,
      ...(d ? { desktop: box(d.x + inset, d.y + 22, d.w - inset * 2, 20) } : {}),
      text: { template },
      // One line, always. The value is whatever the story put in the variable,
      // and a 46px chip has no room for a second line — "Somewhere unnamed"
      // in English was already losing two thirds of itself on the phone.
      style: { size: 16, desktopSize: 19, weight: 600, color: bodyText, align, lineHeight: 1.05, nowrap: true },
    },
  ];
}

/** The conversation and everything the player touches: a rule to separate it
 *  from whatever is above, the transcript, three openers, the composer. Every
 *  layout ends with this, which is what makes them one family. */
/**
 * One message-action button, sized down and right-aligned in a row of three.
 *
 * Right-aligned because they are not choices the card is offering — they are
 * controls, and controls belong at the edge where the eye does not have to
 * read them before reaching the conversation.
 */
function tool(
  id: string,
  index: number,
  label: string,
  action: UiAction,
  d: DesktopConversation,
): UiElement[] {
  const w = 74;
  const right = UI_CANVAS_W - PAD;
  const dRight = d.x + d.w - D_PAD;
  return [{
    id,
    type: "button",
    x: right - w * (3 - index) - 6 * (2 - index), y: TOOLS_Y, w, h: TOOL_H,
    desktop: box(dRight - w * (3 - index) - 6 * (2 - index), D_TOOLS_Y, w, TOOL_H),
    label: { template: label },
    actions: [action],
    css: CONTROL_RADIUS,
    style: { fills: [chipFill], textColor: quietText, size: 11, desktopSize: 12 },
  }];
}

interface DesktopConversation {
  /** Left edge and width of the column the conversation lives in. */
  x: number;
  w: number;
  /** Where the rule above the transcript sits. */
  topY: number;
  /**
   * Whether the wide canvas draws that rule at all. A layout that puts its
   * standing information on a RAIL has already separated the two with an edge,
   * and a second line at the top of the column separates the conversation from
   * nothing.
   */
  rule?: boolean;
}

function conversation(strings: UiTemplateStrings, topY: number, d: DesktopConversation): UiElement[] {
  const chipW = Math.round((COL - GAP * 2) / 3);
  const messagesY = topY + 10;
  const opener = (label: string, says: string) => ({
    label: { template: label },
    actions: [{ kind: "send-message" as const, text: { template: says } }],
    css: CONTROL_RADIUS,
    style: { fills: [chipFill], textColor: chipText, size: 12, desktopSize: 13, weight: 600, shadows: LIT_EDGE },
  });
  // The wide canvas gives the controls their own gutter inside the column, so
  // the transcript can run full-bleed while the chips line up with the text.
  const dInner = d.x + D_PAD;
  const dInnerW = d.w - D_PAD * 2;
  const dChipW = Math.round((dInnerW - GAP * 2) / 3);
  const dMessagesY = d.topY + 10;
  return [
    {
      id: "tpl-rule", type: "box",
      x: PAD, y: topY, w: COL, h: 1,
      desktop: d.rule === false ? null : box(dInner, d.topY, dInnerW, 1),
      style: { fills: [hairline] },
    },
    {
      id: "tpl-messages", type: "messages",
      x: 0, y: messagesY, w: UI_CANVAS_W, h: TOOLS_Y - GAP - messagesY,
      desktop: box(d.x, dMessagesY, d.w, D_TOOLS_Y - GAP - dMessagesY),
    },
    // What the platform's bubble toolbar has always offered, on the card
    // instead of behind a hover: a player on a phone never found it there.
    // Each dims itself while there is no assistant message to act on.
    ...tool("tpl-tool-rewind", 0, strings.toolRewind!, { kind: "rewind" }, d),
    ...tool("tpl-tool-regen", 1, strings.toolRegenerate!, { kind: "regenerate" }, d),
    ...tool("tpl-tool-copy", 2, strings.toolCopy!, { kind: "copy-message" }, d),
    {
      id: "tpl-action-look", type: "button",
      x: PAD, y: CHIPS_Y, w: chipW, h: CHIP_H,
      desktop: box(dInner, D_CHIPS_Y, dChipW, CHIP_H),
      ...opener(strings.actionLook!, strings.actionLookSays!),
    },
    {
      id: "tpl-action-ask", type: "button",
      x: PAD + chipW + GAP, y: CHIPS_Y, w: chipW, h: CHIP_H,
      desktop: box(dInner + dChipW + GAP, D_CHIPS_Y, dChipW, CHIP_H),
      ...opener(strings.actionAsk!, strings.actionAskSays!),
    },
    {
      id: "tpl-action-wait", type: "button",
      x: PAD + (chipW + GAP) * 2, y: CHIPS_Y, w: chipW, h: CHIP_H,
      desktop: box(dInner + (dChipW + GAP) * 2, D_CHIPS_Y, dChipW, CHIP_H),
      ...opener(strings.actionWait!, strings.actionWaitSays!),
    },
    {
      id: "tpl-composer", type: "composer",
      x: 0, y: COMPOSER_Y, w: UI_CANVAS_W, h: COMPOSER_H,
      desktop: box(d.x, D_COMPOSER_Y, d.w, D_COMPOSER_H),
    },
  ];
}

const OPENER_KEYS = ["actionLook", "actionLookSays", "actionAsk", "actionAskSays", "actionWait", "actionWaitSays"];

/** A page of lists behind a button — where the things that will not fit beside
 *  the conversation go. It ships with the layout rather than as an example
 *  because the moment a creator wants one they need the back button, the page
 *  id and the return trip to already be right, and those are the three things a
 *  first attempt gets wrong. */
function listPage(
  strings: UiTemplateStrings,
  lists: Array<{ id: string; title: string; variableId: string; empty: string }>,
): UiPage {
  const backY = PAGE_H - 62;
  const top = 78;
  const each = Math.floor((backY - top - 18 - (lists.length - 1) * 22) / lists.length);
  const elements: UiElement[] = [
    {
      id: "tpl-d-back",
      type: "button",
      x: PAD, y: 22, w: 34, h: 34,
      // An arrow rather than a word: 34px holds one glyph, and this one means
      // the same thing in all five languages the card ships in.
      label: { template: "←" },
      actions: [{ kind: "go-page", pageId: "page-1" }],
      css: CONTROL_RADIUS,
      style: { fills: [chipFill], textColor: chipText, size: 15 },
    },
    {
      id: "tpl-d-title",
      type: "text",
      x: PAD + 46, y: 30, w: COL - 46, h: 20,
      text: { template: strings.detailsTitle! },
      style: { size: 14, desktopSize: 16, weight: 600, color: bodyText, letterSpacing: 0.6, lineHeight: 1.15 },
    },
    { id: "tpl-d-rule", type: "box", x: PAD, y: 68, w: COL, h: 1, style: { fills: [hairline] } },
  ];
  lists.forEach((list, i) => {
    const y = top + i * (each + 22);
    elements.push({
      id: `${list.id}-title`,
      type: "text",
      x: PAD, y, w: COL, h: 18,
      text: { template: list.title },
      style: { size: 12, desktopSize: 13, weight: 600, color: quietText, letterSpacing: 0.6, lineHeight: 1.15 },
    });
    elements.push({
      id: list.id,
      type: "list",
      x: PAD, y: y + 26, w: COL, h: each - 26,
      source: { kind: "variable", variableId: list.variableId },
      item: { template: "{{item}}" },
      gap: 8,
      emptyText: { template: list.empty },
      // A row is a card, not a control, so its corner is its own — the theme's
      // radius control is about the things a player presses.
      itemStyle: { fills: [chipFill], radius: 10, padding: 12, shadows: LIT_EDGE },
      // Named rather than left to the default: an unstyled row is drawn in
      // literal white, which under 素纸 is invisible text on cream.
      textStyle: { size: 13, desktopSize: 14, color: bodyText },
    });
  });
  elements.push({
    id: "tpl-d-back-wide",
    type: "button",
    x: PAD, y: backY, w: COL, h: 44,
    label: { template: strings.detailsBack! },
    actions: [{ kind: "go-page", pageId: "page-1" }],
    css: CONTROL_RADIUS,
    style: { fills: [chipFill], textColor: chipText, size: 13, weight: 600 },
  });
  return { id: "page-details", name: "Details", height: PAGE_H, elements };
}

/** The button that opens the second page. Glass when it sits on art, a plain
 *  chip when it sits on the theme's own ground. */
function detailsButton(
  label: string, x: number, y: number, w: number, h: number, glass: boolean,
  d?: { x: number; y: number; w: number; h: number },
): UiElement {
  return {
    id: "tpl-details-open",
    type: "button",
    x, y, w, h,
    ...(d ? { desktop: box(d.x, d.y, d.w, d.h) } : {}),
    label: { template: label },
    actions: [{ kind: "go-page", pageId: "page-details" }],
    css: CONTROL_RADIUS,
    style: glass
      ? { fills: [GLASS_FILL], textColor: GLASS_TEXT, size: 12, weight: 600, backdropBlur: 8,
          borderColor: "rgba(255,255,255,0.16)", borderWidth: 1 }
      : { fills: [chipFill], textColor: chipText, size: 12, weight: 600, shadows: LIT_EDGE },
  };
}

const doc = (input: UiTemplateInput, pages: UiPage[]): UiDoc => ({
  version: 1,
  entryPageId: "page-1",
  // No page background: the theme owns the ground.
  pages,
  ...(input.theme ? { theme: input.theme } : {}),
});

// ── 1. Portrait scene ──────────────────────────────────────────────────────
//
// The character card. Art is 52% of hand-written frontends and the meter under
// it is the commonest number variable in the library.

const ART_H = 300;
const FADE_H = 96;

function portraitScene(input: UiTemplateInput): UiDoc {
  const { strings, variableIds } = input;
  const art = variableIds.portrait!;
  const place = variableIds.location!;
  const nameY = ART_H + 14;
  const meterY = nameY + 44;
  const ruleY = meterY + METER_BLOCK_H + 16;

  // Wide: the art is a full-height panel down the left and the conversation
  // sits beside it — the arrangement a phone cannot have, and the whole reason
  // a second canvas is worth carrying.
  const artW = 396;
  const rightX = artW;
  const rightW = D_W - artW;
  const textX = rightX + D_PAD;
  const textW = rightW - D_PAD * 2;
  const dMeterW = Math.round((textW - METER_GAP) / 2);
  const dMeterY = 112;
  const dRuleY = dMeterY + METER_BLOCK_H + 20;

  const elements: UiElement[] = [
    // Behind the portrait, and only while there is none: a layout whose biggest
    // element is a blank rectangle reads as broken rather than as unfinished.
    {
      id: "tpl-portrait-empty",
      group: "g-tpl-portrait",
      type: "box",
      x: 0, y: 0, w: UI_CANVAS_W, h: ART_H,
      desktop: box(0, 0, artW, D_H),
      visibleWhen: { variableId: art, operator: "eq", value: "" },
      style: { fills: [{ kind: "gradient", angle: 160, stops: [
        { color: "var(--yc-chip-bg, rgba(255,255,255,0.10))", at: 0 },
        { color: "transparent", at: 100 },
      ] }] },
    },
    {
      id: "tpl-portrait-empty-label",
      group: "g-tpl-portrait",
      type: "text",
      // Three lines of room, not one. The sentence is a whole instruction
      // ("upload one here, or point the variable at an asset") and it does not
      // fit on one line in any language: text elements clip at their box, so a
      // 20px-tall one delivered half a sentence with no sign there was more.
      x: PAD, y: ART_H / 2 - 32, w: COL, h: 64,
      desktop: box(D_PAD, D_H / 2 - 32, artW - D_PAD * 2, 64),
      visibleWhen: { variableId: art, operator: "eq", value: "" },
      text: { template: strings.portraitEmpty! },
      style: { size: 12, align: "center", color: quietText, lineHeight: 1.7 },
    },
    {
      id: "tpl-portrait",
      group: "g-tpl-portrait",
      name: strings.title,
      type: "image",
      x: 0, y: 0, w: UI_CANVAS_W, h: ART_H,
      desktop: box(0, 0, artW, D_H),
      fit: "cover",
      // A variable, so a behaviour can change who is on screen mid-story. The
      // caller seeds it with the card's cover, so a card that has art shows it
      // without anybody binding anything.
      src: { kind: "variable", variableId: art },
      animation: { kind: "fade", durationMs: 420 },
    },
    // Shades the top of the art just enough to seat the glass. Literal black
    // rather than a token: it is shading the ART, not the page.
    // The three shades below exist to seat glass on ART and to join art to the
    // page. With no art they were shading an empty rectangle — and, drawn
    // after the placeholder label, they lay over it: the side fade covered the
    // last third of "put a portrait here…" so the sentence appeared cut off.
    // They show only once there is a picture to shade.
    {
      id: "tpl-art-top-shade",
      type: "box",
      x: 0, y: 0, w: UI_CANVAS_W, h: 84,
      desktop: box(0, 0, artW, 110),
      visibleWhen: { variableId: art, operator: "neq", value: "" },
      style: { fills: [{ kind: "gradient", angle: 180, stops: [
        { color: "rgba(0,0,0,0.38)", at: 0 },
        { color: "rgba(0,0,0,0)", at: 100 },
      ] }] },
    },
    // The art meets the page in the page's own colour. `--yc-bg-solid` rather
    // than `--yc-bg` because two themes paint their ground with a gradient, and
    // a gradient substituted into a colour stop voids the whole declaration —
    // which is exactly how this fade used to silently not happen.
    {
      id: "tpl-art-fade",
      type: "box",
      x: 0, y: ART_H - FADE_H, w: UI_CANVAS_W, h: FADE_H,
      visibleWhen: { variableId: art, operator: "neq", value: "" },
      // On a phone the art fades DOWN into the page. On a desktop it fades
      // SIDEWAYS into the column beside it — the same join turned ninety
      // degrees, which a re-box cannot express, so the wide one is its own
      // element and each hides on the other's canvas.
      desktop: null,
      style: { fills: [{ kind: "gradient", angle: 180, stops: [
        { color: "rgba(0,0,0,0)", at: 0 },
        { color: "var(--yc-bg-solid, #0b0a0f)", at: 100 },
      ] }] },
    },
    {
      id: "tpl-art-fade-side",
      type: "box",
      x: 0, y: 0, w: 0, h: 0,
      desktop: box(artW - 220, 0, 220, D_H),
      visibleWhen: { variableId: art, operator: "neq", value: "" },
      style: {
        fills: [{ kind: "gradient", angle: 90, stops: [
          { color: "rgba(0,0,0,0)", at: 0 },
          { color: "var(--yc-bg-solid, #0b0a0f)", at: 72 },
          { color: "var(--yc-bg-solid, #0b0a0f)", at: 100 },
        ] }],
      },
    },
    {
      id: "tpl-place-chip",
      group: "g-tpl-place-chip",
      type: "box",
      x: PAD, y: 20, w: 132, h: 30,
      desktop: box(D_PAD, D_PAD, 150, 32),
      // Only while the place variable says something. An empty glass pill
      // floating on the art is worse than no pill at all.
      visibleWhen: { variableId: place, operator: "neq", value: "" },
      css: CONTROL_RADIUS,
      style: { fills: [GLASS_FILL], backdropBlur: 8, borderColor: "rgba(255,255,255,0.16)", borderWidth: 1 },
    },
    {
      id: "tpl-place-text",
      group: "g-tpl-place-chip",
      type: "text",
      x: PAD, y: 27, w: 132, h: 16,
      desktop: box(D_PAD, D_PAD + 8, 150, 16),
      visibleWhen: { variableId: place, operator: "neq", value: "" },
      text: { template: `{{${place}}}` },
      style: { size: 11, align: "center", color: GLASS_TEXT, letterSpacing: 0.4, lineHeight: 1.15 },
    },
    {
      ...detailsButton(strings.detailsOpen!, UI_CANVAS_W - PAD - 76, 20, 76, 30, true),
      // Glass on the phone, where it sits on the art. On the wide canvas it
      // moves off the art into the column, where a plain chip belongs.
      desktop: box(D_W - D_PAD - 76, 54, 76, 30),
    },
    {
      id: "tpl-title",
      type: "text",
      x: PAD, y: nameY, w: COL, h: 30,
      desktop: box(textX, 52, textW - 90, 34),
      text: { template: strings.title! },
      // A heading's box is barely taller than its type, and the default
      // line-height of 1.5 centres the glyphs in a line box half again as
      // tall as the box itself — so the bottom of every character is cut off
      // by `overflow: hidden`, which is most visible in Chinese, where the ink
      // fills the em. Pull the line box in to the type, and keep the card's
      // name on one line: it is whatever the creator called their card.
      style: { size: 24, desktopSize: 30, weight: 700, color: bodyText, letterSpacing: 0.2, lineHeight: 1.1, nowrap: true },
      animation: { kind: "rise", durationMs: 420, delayMs: 80 },
    },
    ...meter("tpl-meter-1", PAD, meterY, HALF_W, strings.meterPrimary!, variableIds.affinity!, 11,
      { x: textX, y: dMeterY, w: dMeterW }),
    ...meter("tpl-meter-2", PAD + HALF_W + METER_GAP, meterY, HALF_W, strings.meterSecondary!, variableIds.stamina!, 11,
      { x: textX + dMeterW + METER_GAP, y: dMeterY, w: dMeterW }),
    ...conversation(strings, ruleY, { x: rightX, w: rightW, topY: dRuleY }),
  ];

  return doc(input, [
    { id: "page-1", name: "Main", height: PAGE_H, elements },
    listPage(strings, [
      { id: "tpl-d-list", title: strings.inventoryTitle!, variableId: variableIds.inventory!, empty: strings.inventoryEmpty! },
    ]),
  ]);
}

// ── 2. Adventure HUD ───────────────────────────────────────────────────────
//
// Where and when you are, which is the largest single need in the library
// (当前位置 appears in 1,323 drafts on its own) and the one a text adventure
// has. No art: this is the layout for a card that is a place rather than a
// person, and it gives the transcript the whole rest of the screen.

function adventureHud(input: UiTemplateInput): UiDoc {
  const { strings, variableIds } = input;
  const cardY = 20;
  const cardH = 108;
  const inner = PAD + 14;
  const innerW = COL - 28;
  const meterW = Math.round((innerW - METER_GAP) / 2);
  const ruleY = cardY + cardH + 16;

  // Wide: the HUD becomes a band across the top and the conversation is held to
  // a column in the middle. A line of dialogue run the full width of a monitor
  // is a line nobody finishes.
  const dCardY = 24;
  const dCardH = 92;
  const dInner = D_PAD + 22;
  const dCardW = D_W - D_PAD * 2;
  // The band reads left to right: where you are, when it is, how you are, and
  // the way in. Laid out from the LEFT in one run, because measuring the place
  // from one edge and the meters from the other is how they met in the middle.
  const dPlaceW = 260;
  const dWhenX = dInner + dPlaceW + 20;
  const dWhenW = 200;
  const dMeterW = 150;
  const dMetersX = dWhenX + dWhenW + 30;
  const dDetailsX = D_W - D_PAD - 22 - 84;
  const colW = 760;
  const colX = Math.round((D_W - colW) / 2);

  const elements: UiElement[] = [
    {
      id: "tpl-hud", type: "box",
      x: PAD, y: cardY, w: COL, h: cardH,
      desktop: box(D_PAD, dCardY, dCardW, dCardH),
      css: "border-radius: var(--yc-input-radius, 14px);",
      style: { fills: [chipFill], shadows: LIT_EDGE },
    },
    {
      id: "tpl-place-label",
      type: "text",
      x: inner, y: cardY + 13, w: innerW - 120, h: 13,
      desktop: box(dInner, dCardY + 22, dPlaceW, 13),
      text: { template: strings.placeLabel! },
      style: { size: 10, desktopSize: 11, color: quietText, letterSpacing: 0.6, lineHeight: 1.15 },
    },
    {
      id: "tpl-place",
      type: "text",
      x: inner, y: cardY + 28, w: innerW - 120, h: 22,
      desktop: box(dInner, dCardY + 40, dPlaceW, 26),
      text: { template: `{{${variableIds.location}}}` },
      style: { size: 19, desktopSize: 24, weight: 700, color: bodyText, lineHeight: 1.05, nowrap: true },
    },
    // Day and time read as one line, right-aligned: they are the same fact.
    {
      id: "tpl-when",
      type: "text",
      // Below the details button, not beside it: at 30 the two shared a band
      // and the day sat half under the chip.
      x: inner + innerW - 120, y: cardY + 42, w: 120, h: 18,
      desktop: box(dWhenX, dCardY + 45, dWhenW, 18),
      text: { template: fillTemplateMacros(strings.whenFormat!, variableIds) },
      style: { size: 12, desktopSize: 14, color: quietText, align: "right", lineHeight: 1.15, nowrap: true },
    },
    ...meter("tpl-meter-1", inner, cardY + 60, meterW, strings.meterPrimary!, variableIds.stamina!, 11,
      { x: dMetersX, y: dCardY + 30, w: dMeterW }),
    ...meter("tpl-meter-2", inner + meterW + METER_GAP, cardY + 60, meterW, strings.meterSecondary!, variableIds.energy!, 11,
      { x: dMetersX + dMeterW + METER_GAP, y: dCardY + 30, w: dMeterW }),
    detailsButton(strings.detailsOpen!, PAD + COL - 76 - 14, cardY + 10, 76, 28, false,
      { x: dDetailsX, y: dCardY + 32, w: 84, h: 30 }),
    ...conversation(strings, ruleY, { x: colX, w: colW, topY: dCardY + dCardH + 20 }),
  ];

  return doc(input, [
    { id: "page-1", name: "Main", height: PAGE_H, elements },
    listPage(strings, [
      { id: "tpl-d-list", title: strings.inventoryTitle!, variableId: variableIds.inventory!, empty: strings.inventoryEmpty! },
      { id: "tpl-d-list-2", title: strings.rosterTitle!, variableId: variableIds.roster!, empty: strings.rosterEmpty! },
    ]),
  ]);
}

// ── 3. Stat panel ──────────────────────────────────────────────────────────
//
// The card that tracks numbers: raising, managing, surviving. Four meters,
// because 0-100 meters are 23% of cards with variables and the top four number
// names in the library are an affection meter, a body meter, a progress
// percentage and a purse.

function statPanel(input: UiTemplateInput): UiDoc {
  const { strings, variableIds } = input;
  const titleY = 22;
  const readY = 58;
  const gridY = 118;
  const rowGap = METER_BLOCK_H + 18;
  const ruleY = gridY + rowGap + METER_BLOCK_H + 16;

  // Wide: the numbers become a rail down the left, which is where a panel of
  // standing figures belongs when there is a column to spare, and the
  // conversation takes the rest.
  const railW = 330;
  const railX = D_PAD;
  const railInner = railW - D_PAD;
  const dMeterY = 224;
  const dRowGap = METER_BLOCK_H + 26;
  const rightX = railW + D_PAD;
  const rightW = D_W - rightX;

  const elements: UiElement[] = [
    // First, so it is the ground: listed after the title it was painted
    // over it and the card's name vanished on the wide canvas.
    {
      id: "tpl-rail", type: "box",
      x: 0, y: 0, w: 0, h: 0,
      // A rail needs a ground of its own, or the figures on it float in the
      // middle of nothing with the conversation's edge as their only boundary.
      desktop: box(0, 0, railW + D_PAD / 2, D_H),
      style: { fills: [{ kind: "color", color: "var(--yc-chip-bg, rgba(255,255,255,0.05))" }] },
    },
    {
      id: "tpl-title",
      type: "text",
      x: PAD, y: titleY, w: COL - 80, h: 26,
      desktop: box(railX, 36, railInner - 90, 32),
      text: { template: strings.title! },
      // A heading's box is barely taller than its type, and the default
      // line-height of 1.5 centres the glyphs in a line box half again as
      // tall as the box itself — so the bottom of every character is cut off
      // by `overflow: hidden`, which is most visible in Chinese, where the ink
      // fills the em. Pull the line box in to the type, and keep the card's
      // name on one line: it is whatever the creator called their card.
      style: { size: 23, desktopSize: 28, weight: 700, color: bodyText, lineHeight: 1.1, nowrap: true },
    },
    detailsButton(strings.detailsOpen!, PAD + COL - 76, titleY, 76, 28, false,
      { x: railX + railInner - 76, y: 36, w: 76, h: 28 }),
    // Stacked on the wide canvas rather than paired: half a rail is 120px of
    // text, and a day-and-time line does not fit in 120px at desktop size.
    ...readout("tpl-when", PAD, readY, HALF_W, strings.whenLabel!, fillTemplateMacros(strings.whenFormat!, variableIds), "left",
      { x: railX, y: 88, w: railInner }),
    ...readout("tpl-gold", PAD + HALF_W + METER_GAP, readY, HALF_W, strings.goldLabel!, `{{${variableIds.gold}}}`, "left",
      { x: railX, y: 146, w: railInner }),
    ...meter("tpl-meter-1", PAD, gridY, HALF_W, strings.meterPrimary!, variableIds.affinity!, 11,
      { x: railX, y: dMeterY, w: railInner }),
    ...meter("tpl-meter-2", PAD + HALF_W + METER_GAP, gridY, HALF_W, strings.meterSecondary!, variableIds.stamina!, 11,
      { x: railX, y: dMeterY + dRowGap, w: railInner }),
    ...meter("tpl-meter-3", PAD, gridY + rowGap, HALF_W, strings.meterThird!, variableIds.energy!, 11,
      { x: railX, y: dMeterY + dRowGap * 2, w: railInner }),
    ...meter("tpl-meter-4", PAD + HALF_W + METER_GAP, gridY + rowGap, HALF_W, strings.meterFourth!, variableIds.progress!, 11,
      { x: railX, y: dMeterY + dRowGap * 3, w: railInner }),
    ...conversation(strings, ruleY, { x: rightX, w: rightW, topY: 36, rule: false }),
  ];

  return doc(input, [
    { id: "page-1", name: "Main", height: PAGE_H, elements },
    listPage(strings, [
      { id: "tpl-d-list", title: strings.inventoryTitle!, variableId: variableIds.inventory!, empty: strings.inventoryEmpty! },
    ]),
  ]);
}

// ── 4. Character sheet ─────────────────────────────────────────────────────
//
// Who the PLAYER is. A quarter of cards with variables carry a player profile —
// name, role, gender, age, background — and until now every one of them had to
// be written by hand or kept invisible in the prompt.

function characterSheet(input: UiTemplateInput): UiDoc {
  const { strings, variableIds } = input;
  const nameY = 24;
  const traitY = 56;
  const readY = 86;
  const meterY = 148;
  const ruleY = meterY + METER_BLOCK_H + 16;

  // Wide: who you are is a standing fact, so it gets a rail and stays put
  // while the conversation scrolls beside it.
  const railW = 330;
  const railX = D_PAD;
  const railInner = railW - D_PAD;
  const rightX = railW + D_PAD;
  const rightW = D_W - rightX;

  const elements: UiElement[] = [
    // First, so it is the ground: listed after the title it was painted
    // over it and the card's name vanished on the wide canvas.
    {
      id: "tpl-rail", type: "box",
      x: 0, y: 0, w: 0, h: 0,
      // A rail needs a ground of its own, or the figures on it float in the
      // middle of nothing with the conversation's edge as their only boundary.
      desktop: box(0, 0, railW + D_PAD / 2, D_H),
      style: { fills: [{ kind: "color", color: "var(--yc-chip-bg, rgba(255,255,255,0.05))" }] },
    },
    {
      id: "tpl-title",
      type: "text",
      x: PAD, y: nameY, w: COL - 80, h: 28,
      desktop: box(railX, 40, railInner, 30),
      text: { template: `{{${variableIds.playerName}}}` },
      // A heading's box is barely taller than its type, and the default
      // line-height of 1.5 centres the glyphs in a line box half again as
      // tall as the box itself — so the bottom of every character is cut off
      // by `overflow: hidden`, which is most visible in Chinese, where the ink
      // fills the em. Pull the line box in to the type, and keep the card's
      // name on one line: it is whatever the creator called their card.
      style: { size: 21, desktopSize: 26, weight: 700, color: bodyText, lineHeight: 1.1, nowrap: true },
    },
    detailsButton(strings.detailsOpen!, PAD + COL - 76, nameY + 1, 76, 28, false,
      { x: railX, y: D_H - D_PAD - 34, w: 96, h: 30 }),
    // Role, gender and age on one line: three short facts, read together.
    // Three elements rather than one "{role} · {gender} · {age}" string,
    // because gender and age start EMPTY — they are the player's to fill in,
    // and the one-string version either printed "旅人 ·  · " or, seeded with
    // "gender TBD", showed the creator's placeholder to every player. Each
    // fact brings its own separator and hides while it has nothing to say.
    {
      id: "tpl-traits",
      type: "text",
      x: PAD, y: traitY, w: 120, h: 18,
      desktop: box(railX, 76, 112, 18),
      text: { template: fillTemplateMacros(strings.traitFormat!, variableIds) },
      style: { size: 12, desktopSize: 13, color: quietText, lineHeight: 1.15, nowrap: true },
    },
    {
      id: "tpl-traits-gender",
      type: "text",
      x: PAD + 124, y: traitY, w: 84, h: 18,
      desktop: box(railX + 116, 76, 80, 18),
      visibleWhen: { variableId: variableIds.gender!, operator: "neq", value: "" },
      text: { template: `· {{${variableIds.gender}}}` },
      style: { size: 12, desktopSize: 13, color: quietText, lineHeight: 1.15, nowrap: true },
    },
    {
      id: "tpl-traits-age",
      type: "text",
      x: PAD + 212, y: traitY, w: COL - 212, h: 18,
      desktop: box(railX + 200, 76, railInner - 200, 18),
      visibleWhen: { variableId: variableIds.age!, operator: "neq", value: "" },
      text: { template: `· {{${variableIds.age}}}` },
      style: { size: 12, desktopSize: 13, color: quietText, lineHeight: 1.15, nowrap: true },
    },
    ...readout("tpl-place", PAD, readY, HALF_W, strings.placeLabel!, `{{${variableIds.location}}}`, "left",
      { x: railX, y: 120, w: railInner }),
    ...readout("tpl-phase", PAD + HALF_W + METER_GAP, readY, HALF_W, strings.phaseLabel!, `{{${variableIds.phase}}}`, "left",
      { x: railX, y: 178, w: railInner }),
    ...meter("tpl-meter-1", PAD, meterY, HALF_W, strings.meterPrimary!, variableIds.affinity!, 11,
      { x: railX, y: 256, w: railInner }),
    ...meter("tpl-meter-2", PAD + HALF_W + METER_GAP, meterY, HALF_W, strings.meterSecondary!, variableIds.stamina!, 11,
      { x: railX, y: 256 + METER_BLOCK_H + 26, w: railInner }),
    ...conversation(strings, ruleY, { x: rightX, w: rightW, topY: 36, rule: false }),
  ];

  return doc(input, [
    { id: "page-1", name: "Main", height: PAGE_H, elements },
    listPage(strings, [
      { id: "tpl-d-list", title: strings.inventoryTitle!, variableId: variableIds.inventory!, empty: strings.inventoryEmpty! },
      { id: "tpl-d-list-2", title: strings.rosterTitle!, variableId: variableIds.roster!, empty: strings.rosterEmpty! },
    ]),
  ]);
}

// ── The set ────────────────────────────────────────────────────────────────
//
// Variable KEYS are shared across layouts on purpose. A creator who tries
// 立绘对话 and then switches to 冒险状态 keeps the same 好感度 and 背包 rather
// than collecting a second one of each, because the store matches on the name
// these keys resolve to.

const DETAIL_KEYS = ["detailsOpen", "detailsTitle", "detailsBack", "inventoryTitle", "inventoryEmpty"];
const TOOL_KEYS = ["toolRewind", "toolRegenerate", "toolCopy"];
const ROSTER_KEYS = ["rosterTitle", "rosterEmpty"];

const NEED = {
  portrait: { key: "portrait", type: "string", defaultValue: "", fromCover: true },
  location: { key: "location", type: "string", defaultValue: "" },
  day: { key: "day", type: "number", defaultValue: 1 },
  timeOfDay: { key: "timeOfDay", type: "string", defaultValue: "" },
  affinity: { key: "affinity", type: "number", min: 0, max: 100, defaultValue: 50 },
  stamina: { key: "stamina", type: "number", min: 0, max: 100, defaultValue: 80 },
  energy: { key: "energy", type: "number", min: 0, max: 100, defaultValue: 70 },
  progress: { key: "progress", type: "number", min: 0, max: 100, defaultValue: 0 },
  gold: { key: "gold", type: "number", defaultValue: 0 },
  inventory: { key: "inventory", type: "json", defaultValue: [] },
  roster: { key: "roster", type: "json", defaultValue: [] },
  playerName: { key: "playerName", type: "string", defaultValue: "" },
  playerRole: { key: "playerRole", type: "string", defaultValue: "" },
  gender: { key: "gender", type: "string", defaultValue: "" },
  age: { key: "age", type: "string", defaultValue: "" },
  phase: { key: "phase", type: "string", defaultValue: "" },
} as const satisfies Record<string, UiTemplateNeed>;

export const UI_TEMPLATES: UiTemplatePreset[] = [
  {
    id: "portrait-scene",
    signature: "tpl-portrait",
    look: { id: "blossom" },
    needs: [NEED.portrait, NEED.location, NEED.affinity, NEED.stamina, NEED.inventory],
    stringKeys: ["portraitEmpty", "meterPrimary", "meterSecondary", ...DETAIL_KEYS, ...OPENER_KEYS, ...TOOL_KEYS],
    build: portraitScene,
  },
  {
    id: "adventure-hud",
    signature: "tpl-hud",
    look: { id: "night" },
    needs: [NEED.location, NEED.day, NEED.timeOfDay, NEED.stamina, NEED.energy, NEED.inventory, NEED.roster],
    stringKeys: ["placeLabel", "whenFormat", "meterPrimary", "meterSecondary", ...DETAIL_KEYS, ...ROSTER_KEYS, ...OPENER_KEYS, ...TOOL_KEYS],
    build: adventureHud,
  },
  {
    id: "stat-panel",
    signature: "tpl-gold-chip",
    look: { id: "terminal" },
    needs: [NEED.day, NEED.timeOfDay, NEED.gold, NEED.affinity, NEED.stamina, NEED.energy, NEED.progress, NEED.inventory],
    stringKeys: [
      "whenLabel", "whenFormat", "goldLabel",
      "meterPrimary", "meterSecondary", "meterThird", "meterFourth",
      ...DETAIL_KEYS, ...OPENER_KEYS, ...TOOL_KEYS,
    ],
    build: statPanel,
  },
  {
    id: "character-sheet",
    signature: "tpl-traits",
    look: { id: "paper" },
    needs: [
      NEED.playerName, NEED.playerRole, NEED.gender, NEED.age,
      NEED.location, NEED.phase, NEED.affinity, NEED.stamina, NEED.inventory, NEED.roster,
    ],
    stringKeys: [
      "traitFormat", "placeLabel", "phaseLabel", "meterPrimary", "meterSecondary",
      ...DETAIL_KEYS, ...ROSTER_KEYS, ...OPENER_KEYS, ...TOOL_KEYS,
    ],
    build: characterSheet,
  },
];

export const getUiTemplate = (id: string): UiTemplatePreset | undefined =>
  UI_TEMPLATES.find((template) => template.id === id);

/**
 * Which official layout a document is on, if any.
 *
 * Read off the ids a layout installs rather than off its shape: a creator is
 * free to drag, restyle and delete the parts afterwards, and the picker still
 * has to show them where they started.
 */
export const detectUiTemplate = (doc: UiDoc | undefined): string | null => {
  const ids = new Set((doc?.pages ?? []).flatMap((page) => (page.elements ?? []).map((el) => el.id)));
  return UI_TEMPLATES.find((template) => ids.has(template.signature))?.id ?? null;
};
