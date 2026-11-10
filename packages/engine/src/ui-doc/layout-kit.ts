import { LIT_EDGE, METER_TRACK_FILLS, METER_TRACK_H as TRACK_H, meterFillsFor } from "./edit.js";
import { UI_CANVAS_W, UI_DESKTOP_H, UI_DESKTOP_W } from "./types.js";
export { UI_CANVAS_W } from "./types.js";
import type { UiAction, UiButtonStyle, UiDoc, UiElement, UiPage, UiTheme } from "./types.js";
import type { UiThemeChoice } from "./themes.js";

/** Shared geometry and parts for the official layouts (templates.ts, showcase-layouts.ts). */
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

export const PAGE_H = 812;
export const PAD = 18;
export const COL = UI_CANVAS_W - PAD * 2;

export const COMPOSER_H = 88;
export const CHIP_H = 32;
/** The row of message actions is smaller than the openers on purpose: one is
 *  the card talking, the other is the machinery. */
export const TOOL_H = 26;
export const GAP = 8;
/**
 * Labels and readouts are drawn in boxes sized to the TYPE, but CSS lays out a
 * LINE BOX — half again as tall at the default 1.5 — and `overflow: hidden`
 * takes the difference off the bottom of the characters. Chinese shows it
 * worst, because the ink fills the em. So every one of them carries a line
 * height that fits its box, and anything holding a value the story writes
 * stays on one line and ends in an ellipsis rather than losing a second.
 */


export const METER_LABEL_H = 14;
export const METER_TRACK_H = TRACK_H;
export const METER_BLOCK_H = METER_LABEL_H + 6 + METER_TRACK_H;
export const METER_GAP = 14;
export const HALF_W = Math.round((COL - METER_GAP) / 2);

export const COMPOSER_Y = PAGE_H - COMPOSER_H;
export const CHIPS_Y = COMPOSER_Y - GAP - CHIP_H;
export const TOOLS_Y = CHIPS_Y - 6 - TOOL_H;

// ── The wide canvas ────────────────────────────────────────────────────────
//
// A phone stacks; a desktop divides. Every layout below puts its standing
// information down one side or across the top and gives the conversation the
// rest — and holds the transcript to a readable measure rather than letting a
// line of dialogue run the full width of a monitor.

export const D_W = UI_DESKTOP_W;
export const D_H = UI_DESKTOP_H;
export const D_PAD = 28;
// Two rows: the text line and the row of buttons under it. Measured against
// the REAL composer in the sandbox, not against the Studio's one-line stub,
// which is what 76 was fitted to and what let it clip off the canvas.
export const D_COMPOSER_H = 94;
export const D_COMPOSER_Y = D_H - D_COMPOSER_H;
export const D_CHIPS_Y = D_COMPOSER_Y - GAP - CHIP_H;
export const D_TOOLS_Y = D_CHIPS_Y - 6 - TOOL_H;

/** A box on the wide canvas. Written out because every call site reads better
 *  as four numbers than as an object literal repeated eighty times. */
export const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

/** Glass: a translucent dark plate with its own white text. The one material
 *  legible over art the layout has never seen, under every theme. */
export const GLASS_FILL = { kind: "color" as const, color: "rgba(12,12,16,0.46)" };
export const GLASS_TEXT = "#ffffff";

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
export const CONTROL_RADIUS = "border-radius: var(--yc-send-radius, 999px) !important;";

export const hairline = { kind: "color" as const, color: "var(--yc-chip-bg, rgba(255,255,255,0.10))" };
export const chipFill = { kind: "color" as const, color: "var(--yc-chip-bg, rgba(255,255,255,0.08))" };
export const chipText = "var(--yc-chip-fg, #e8e4df)";
export const bodyText = "var(--yc-text, #f4f1ea)";
export const quietText = "var(--yc-name, rgba(255,255,255,0.55))";
export const ACCENT = "var(--yc-send-bg, #d9a13f)";

// ── Parts ──────────────────────────────────────────────────────────────────

/** One meter, as a labelled pair: name left, live value right, track under
 *  both. Every layout in the set draws its meters this way. */
export function meter(
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
export function readout(
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
export function tool(
  id: string,
  index: number,
  label: string,
  action: UiAction,
  d: DesktopConversation,
): UiElement[] {
  const w = 74;
  const right = UI_CANVAS_W - PAD;
  const dRight = d.x + d.w - D_PAD;
  const { toolsY } = desktopRows(d);
  return [{
    id,
    type: "button",
    x: right - w * (3 - index) - 6 * (2 - index), y: TOOLS_Y, w, h: TOOL_H,
    desktop: box(dRight - w * (3 - index) - 6 * (2 - index), toolsY, w, TOOL_H),
    label: { template: label },
    actions: [action],
    css: CONTROL_RADIUS + (d.skin?.css ?? ""),
    style: { fills: [chipFill], textColor: quietText, size: 11, desktopSize: 12, ...d.skin?.tool },
  }];
}

export interface DesktopConversation {
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
  /** Bottom edge of the composer on desktop. Defaults to the canvas bottom. */
  bottom?: number;
  /** Font and shape overrides for the opener and tool buttons. */
  skin?: ConversationSkin;
}

export interface ConversationSkin {
  chip?: Partial<UiButtonStyle>;
  tool?: Partial<UiButtonStyle>;
  /** Extra css appended to each button. */
  css?: string;
}

/** Desktop y of the composer, opener row and tool row. */
export function desktopRows(d: DesktopConversation): { composerY: number; chipsY: number; toolsY: number } {
  const composerY = (d.bottom ?? D_H) - D_COMPOSER_H;
  const chipsY = composerY - GAP - CHIP_H;
  return { composerY, chipsY, toolsY: chipsY - 6 - TOOL_H };
}

export function conversation(strings: UiTemplateStrings, topY: number, d: DesktopConversation): UiElement[] {
  const chipW = Math.round((COL - GAP * 2) / 3);
  const messagesY = topY + 10;
  const opener = (label: string, says: string) => ({
    label: { template: label },
    actions: [{ kind: "send-message" as const, text: { template: says } }],
    css: CONTROL_RADIUS + (d.skin?.css ?? ""),
    style: { fills: [chipFill], textColor: chipText, size: 12, desktopSize: 13, weight: 600, shadows: LIT_EDGE, ...d.skin?.chip },
  });
  const rows = desktopRows(d);
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
      desktop: box(d.x, dMessagesY, d.w, rows.toolsY - GAP - dMessagesY),
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
      desktop: box(dInner, rows.chipsY, dChipW, CHIP_H),
      ...opener(strings.actionLook!, strings.actionLookSays!),
    },
    {
      id: "tpl-action-ask", type: "button",
      x: PAD + chipW + GAP, y: CHIPS_Y, w: chipW, h: CHIP_H,
      desktop: box(dInner + dChipW + GAP, rows.chipsY, dChipW, CHIP_H),
      ...opener(strings.actionAsk!, strings.actionAskSays!),
    },
    {
      id: "tpl-action-wait", type: "button",
      x: PAD + (chipW + GAP) * 2, y: CHIPS_Y, w: chipW, h: CHIP_H,
      desktop: box(dInner + (dChipW + GAP) * 2, rows.chipsY, dChipW, CHIP_H),
      ...opener(strings.actionWait!, strings.actionWaitSays!),
    },
    {
      id: "tpl-composer", type: "composer",
      x: 0, y: COMPOSER_Y, w: UI_CANVAS_W, h: COMPOSER_H,
      desktop: box(d.x, rows.composerY, d.w, D_COMPOSER_H),
    },
  ];
}

export const OPENER_KEYS = ["actionLook", "actionLookSays", "actionAsk", "actionAskSays", "actionWait", "actionWaitSays"];

/** A page of lists behind a button — where the things that will not fit beside
 *  the conversation go. It ships with the layout rather than as an example
 *  because the moment a creator wants one they need the back button, the page
 *  id and the return trip to already be right, and those are the three things a
 *  first attempt gets wrong. */
export function listPage(
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
export function detailsButton(
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

export const doc = (input: UiTemplateInput, pages: UiPage[]): UiDoc => ({
  version: 1,
  entryPageId: "page-1",
  // No page background: the theme owns the ground.
  pages,
  ...(input.theme ? { theme: input.theme } : {}),
});

export const DETAIL_KEYS = ["detailsOpen", "detailsTitle", "detailsBack", "inventoryTitle", "inventoryEmpty"];
export const TOOL_KEYS = ["toolRewind", "toolRegenerate", "toolCopy"];
export const ROSTER_KEYS = ["rosterTitle", "rosterEmpty"];

export const NEED = {
  portrait: { key: "portrait", type: "string", defaultValue: "" },
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
  mood: { key: "mood", type: "string", defaultValue: "" },
  rank: { key: "rank", type: "string", defaultValue: "" },
} as const satisfies Record<string, UiTemplateNeed>;

// ── The empty picture ──────────────────────────────────────────────────────

type SlotRect = { x: number; y: number; w: number; h: number };

/**
 * Placeholder for an empty portrait: dashed frame, a plus, and the label
 * ("title
hint"). Shown only while the variable is empty. Uses the image's
 * group so deleting the image deletes it too. `compact` drops the label for
 * small frames.
 */
export function artSlot(
  prefix: string, group: string, variableId: string, label: string,
  phone: SlotRect | null, desk: SlotRect | null,
  { inset = 12, compact = false }: { inset?: number; compact?: boolean } = {},
): UiElement[] {
  const empty = { variableId, operator: "eq" as const, value: "" };
  const ink = "color-mix(in srgb, var(--yc-text, #f4f1ea) 45%, transparent)";
  const accent = "var(--yc-send-bg, #d9a13f)";
  const [title = "", hint = ""] = label.split("\n");
  const at = (r: SlotRect | null, f: (r: SlotRect) => SlotRect) => (r ? f(r) : null);
  const place = (p: SlotRect | null, d: SlotRect | null) => ({
    ...(p ?? { x: 0, y: 0, w: 0, h: 0 }),
    desktop: d ? box(d.x, d.y, d.w, d.h) : null,
  });
  const frame = (r: SlotRect) => ({ x: r.x + inset, y: r.y + inset, w: r.w - inset * 2, h: r.h - inset * 2 });
  const ring = compact ? 36 : 56;
  const ringAt = (r: SlotRect) => {
    const cy = compact ? r.y + r.h / 2 : r.y + r.h / 2 - 34;
    return { x: Math.round(r.x + r.w / 2 - ring / 2), y: Math.round(cy - ring / 2), w: ring, h: ring };
  };
  const titleAt = (r: SlotRect) => ({ x: r.x + inset + 12, y: Math.round(r.y + r.h / 2 + 6), w: r.w - (inset + 12) * 2, h: 22 });
  const hintAt = (r: SlotRect) => ({ x: r.x + inset + 12, y: Math.round(r.y + r.h / 2 + 32), w: r.w - (inset + 12) * 2, h: 40 });
  const parts: UiElement[] = [
    {
      id: prefix, group, type: "box",
      ...place(at(phone, frame), at(desk, frame)),
      visibleWhen: empty,
      css: `border-radius: 14px; border: 2px dashed ${ink};`,
      style: { fills: [{ kind: "color", color: "color-mix(in srgb, var(--yc-text, #f4f1ea) 5%, transparent)" }] },
    },
  ];
  // Label before the plus: the side panel edits a group's first text element.
  if (!compact) {
    parts.push({
      id: `${prefix}-label`, group, type: "text",
      ...place(at(phone, titleAt), at(desk, titleAt)),
      visibleWhen: empty,
      text: { template: title },
      style: { size: 14, desktopSize: 15, weight: 700, color: bodyText, align: "center", lineHeight: 1.3, nowrap: true },
    });
    if (hint) {
      parts.push({
        id: `${prefix}-hint`, group, type: "text",
        ...place(at(phone, hintAt), at(desk, hintAt)),
        visibleWhen: empty,
        text: { template: hint },
        style: { size: 11, desktopSize: 12, color: quietText, align: "center", lineHeight: 1.6 },
      });
    }
  }
  parts.push(
    {
      id: `${prefix}-ring`, group, type: "box",
      ...place(at(phone, ringAt), at(desk, ringAt)),
      visibleWhen: empty,
      css: `border-radius: 999px; border: 2px solid ${accent};`,
      style: { fills: [{ kind: "color", color: `color-mix(in srgb, ${accent} 16%, transparent)` }] },
    },
    {
      id: `${prefix}-plus`, group, type: "text",
      ...place(at(phone, ringAt), at(desk, ringAt)),
      visibleWhen: empty,
      text: { template: "+" },
      style: { size: compact ? 22 : 32, weight: 400, color: accent, align: "center", lineHeight: compact ? 1.5 : 1.65 },
    }
  );
  return parts;
}
