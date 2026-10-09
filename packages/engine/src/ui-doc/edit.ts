import { UI_CANVAS_W, UI_DESKTOP_H, UI_DESKTOP_W } from "./types.js";
import { tidyPlayMenu } from "./play-menu.js";
import { withDesktopConversation } from "./desktop-conversation.js";
import type { UiAction, UiChoiceOption, UiDoc, UiElement, UiFieldKind, UiFill, UiPage } from "./types.js";

/**
 * Editing a uiDoc as the person editing thinks of it.
 *
 * The document is a flat list of absolutely-positioned elements, which is the
 * right shape to render and the wrong shape to edit. Three things stand
 * between the two, and they all live here rather than in the panel, because
 * they are decisions about the document and the panel is a set of controls:
 *
 *  - **Groups.** A meter is a label, a live value and a track. Nobody thinks of
 *    that as three things, so selecting, recolouring and deleting all act on
 *    the group (see `UiElementBase.group`).
 *
 *  - **Reflow.** Absolute positions mean an inserted row lands ON something.
 *    But every official layout has the same spine — a header area, then the
 *    transcript, then the composer — and the transcript is the one part whose
 *    height is arbitrary. So it is the part that gives up space when a row is
 *    added and takes it back when one is removed, and nothing below it ever
 *    moves. That keeps the composer where the player's thumb expects it.
 *
 *  - **What a colour means.** The layouts paint in theme tokens, so "the
 *    accent" is `var(--yc-send-bg)` rather than a hex. An edit that sets a
 *    literal is a deliberate override; one that sets a token is a return to
 *    the theme. Both have to be expressible, so both are plain strings and the
 *    panel decides which it is offering.
 */

/**
 * Vertical space one meter row occupies, gap included: the 22px that separates
 * it from the row above, then its label, the gap under that, and the track.
 *
 * Derived rather than typed, because it has to equal what `addMeterRow`
 * actually consumes. When it was 7px short the new row still fitted, but it
 * landed 7px nearer the rule below it than every row the template laid down —
 * the kind of wrongness nobody can name and everybody can see.
 */
export const METER_ROW_H = 22 + 14 + 6 + 6;

// ── Materials ──────────────────────────────────────────────────────────────
//
// Flat colour on flat colour is what "unstyled" looks like, and it is what the
// first pass at these layouts looked like. Three materials fix most of it, and
// all three are the same trick: say where the light is.
//
// They live here rather than in templates.ts because "add a meter" has to
// produce the same object the layout produced. A row added in the panel that
// is visibly flatter than the rows beside it is worse than no panel.

/** A track is a groove: dark at the top where the light does not reach, and
 *  the theme's own chip colour underneath. */
export const METER_TRACK_FILLS: UiFill[] = [
  { kind: "gradient", angle: 180, stops: [
    { color: "rgba(0,0,0,0.22)", at: 0 },
    { color: "rgba(0,0,0,0.04)", at: 100 },
  ] },
  { kind: "color", color: "var(--yc-chip-bg, rgba(255,255,255,0.10))" },
];

/** …and what fills it is lit from above: a sheen across the top two-thirds and
 *  a hairline of shadow where it meets the groove. Low alpha on purpose — this
 *  has to read as light on 素纸's deep green as well as on 夜色's blue. */
export const meterFillsFor = (color: string): UiFill[] => [
  { kind: "gradient", angle: 180, stops: [
    { color: "rgba(255,255,255,0.20)", at: 0 },
    { color: "rgba(255,255,255,0.02)", at: 62 },
    { color: "rgba(0,0,0,0.07)", at: 100 },
  ] },
  { kind: "color", color },
];

/** A panel catches the light on its top edge. One inset hairline, which is the
 *  cheapest thing that makes a surface read as a surface. */
export const LIT_EDGE = [{ x: 0, y: 1, blur: 0, color: "rgba(255,255,255,0.07)", inset: true }];

/** The height a track needs to read as a groove rather than a rule. */
export const METER_TRACK_H = 6;

const PAD = 18;

/** Words in the theme's own colour — a light theme (素纸) is dark ink on
 *  paper, and a hard-coded white on it is a part nobody can see. */
export const THEME_TEXT = "var(--yc-text, #f4f1ea)";
const LABEL_H = 14;
const TRACK_H = METER_TRACK_H;

export interface UiEditTarget {
  pageId: string;
  /** Every element the edit applies to: a group, or one ungrouped element. */
  elementIds: string[];
}

const pageOf = (doc: UiDoc, pageId: string): UiPage | undefined =>
  (doc.pages ?? []).find((page) => page.id === pageId);

/** The element ids that make up the same THING as this one. */
export function groupOf(doc: UiDoc, pageId: string, elementId: string): string[] {
  const page = pageOf(doc, pageId);
  const el = page?.elements.find((e) => e.id === elementId);
  if (!page || !el) return [];
  if (!el.group) return [el.id];
  return page.elements.filter((e) => e.group === el.group).map((e) => e.id);
}

/** Which page an element is on. The panel is handed a DOM id and nothing else. */
export function findElementPage(doc: UiDoc, elementId: string): string | null {
  for (const page of doc.pages ?? []) {
    if (page.elements.some((el) => el.id === elementId)) return page.id;
  }
  return null;
}

function mapPage(doc: UiDoc, pageId: string, fn: (elements: UiElement[]) => UiElement[]): UiDoc {
  return {
    ...doc,
    pages: (doc.pages ?? []).map((page) =>
      page.id === pageId ? { ...page, elements: fn(page.elements) } : page),
  };
}

/** Apply a patch to named elements, leaving the rest of the document alone. */
export function updateElements(
  doc: UiDoc,
  pageId: string,
  elementIds: readonly string[],
  patch: (el: UiElement) => UiElement,
): UiDoc {
  const ids = new Set(elementIds);
  return mapPage(doc, pageId, (elements) => elements.map((el) => (ids.has(el.id) ? patch(el) : el)));
}

/** Replace the first colour fill, keeping any texture or gradient stacked with
 *  it. A layout's meter is one colour fill; a creator's might not be. */
export function withFillColor(fills: UiFill[] | undefined, color: string): UiFill[] {
  const list = fills ?? [];
  const index = list.findIndex((fill) => fill.kind === "color");
  if (index === -1) return [{ kind: "color", color }, ...list];
  return list.map((fill, i) => (i === index ? { kind: "color" as const, color } : fill));
}

/** The first colour a fill stack paints, for the panel to show as current. */
export const fillColorOf = (fills: UiFill[] | undefined): string | null => {
  const found = (fills ?? []).find((fill) => fill.kind === "color");
  return found && found.kind === "color" ? found.color : null;
};

// ── Reflow ─────────────────────────────────────────────────────────────────

/** Which arrangement is being edited. A card is laid out twice, and a row
 *  inserted into one of them says nothing about where it goes in the other. */
export type UiCanvas = "phone" | "desktop";

interface Box { x: number; y: number; w: number; h: number }

/** An element's box on one canvas. `null` means the layout takes it off that
 *  canvas, and nothing there can be moved or measured. */
export function boxOn(el: UiElement, canvas: UiCanvas): Box | null {
  if (canvas === "phone") return { x: el.x, y: el.y, w: el.w, h: el.h };
  if (el.desktop === null) return null;
  return el.desktop ?? { x: el.x, y: el.y, w: el.w, h: el.h };
}

const withBox = (el: UiElement, canvas: UiCanvas, b: Box): UiElement =>
  canvas === "desktop" ? { ...el, desktop: b } : { ...el, x: b.x, y: b.y, w: b.w, h: b.h };

/** The element whose height is arbitrary, and therefore the one that pays for
 *  a row being added. */
const transcriptOf = (page: UiPage): UiElement | undefined =>
  page.elements.find((el) => el.type === "messages" || el.type === "chat");

/**
 * Make `delta` px of room at `insertY`, taking it out of the transcript.
 *
 * Anything between the insertion point and the transcript slides down; the
 * transcript slides down and shortens by the same amount, so its bottom edge —
 * and everything under it — does not move. A negative delta is the same
 * operation run backwards, which is what makes adding and removing a row
 * symmetrical rather than two behaviours that drift apart.
 */
export function reflow(page: UiPage, insertY: number, delta: number, canvas: UiCanvas = "phone"): UiElement[] {
  const transcript = transcriptOf(page);
  const tBox = transcript && boxOn(transcript, canvas);
  if (!transcript || !tBox) return page.elements;
  const top = tBox.y;
  return page.elements.map((el) => {
    const b = boxOn(el, canvas);
    if (b === null) return el;
    if (el.id === transcript.id) return withBox(el, canvas, { ...b, y: b.y + delta, h: Math.max(80, b.h - delta) });
    if (b.y >= insertY && b.y < top) return withBox(el, canvas, { ...b, y: b.y + delta });
    return el;
  });
}

/** Whether the transcript can give up that much and still be worth reading. */
export const canReflow = (doc: UiDoc, pageId: string, delta: number): boolean => {
  const page = pageOf(doc, pageId);
  const transcript = page && transcriptOf(page);
  if (!page || !transcript) return false;
  // Both canvases have to have the room, because one row is added to both.
  return (["phone", "desktop"] as const).every((canvas) => {
    const b = boxOn(transcript, canvas);
    return b === null || b.h - delta >= 80;
  });
};

// ── Meter rows ─────────────────────────────────────────────────────────────

/** Where a new meter row goes on one canvas: under the lowest existing one, or
 *  at the top of the transcript when the creator has deleted them all. */
function nextMeterY(page: UiPage, canvas: UiCanvas): number {
  // On the wide canvas only a meter's own wide box counts: one without just
  // repeats its phone coordinates, which are no place on the desktop.
  const boxes = page.elements
    .filter((el) => el.type === "meter" && (canvas === "phone" || el.desktop))
    .map((el) => boxOn(el, canvas))
    .filter((b): b is Box => b !== null);
  if (boxes.length > 0) return Math.max(...boxes.map((b) => b.y + b.h)) + 22;
  const transcript = transcriptOf(page);
  const b = transcript && boxOn(transcript, canvas);
  return b ? b.y : 20;
}

/**
 * The panel the meters sit inside, if there is one.
 *
 * 冒险状态 draws its figures on a card; 养成面板 draws them on a rail. A row
 * added to either has to land INSIDE that frame, so the frame has to grow —
 * otherwise the new row hangs off the bottom of the box it belongs to, which
 * is what it did.
 *
 * Found by containment rather than by id: any box that wraps every meter is
 * acting as their panel, including one a creator drew themselves. A panel
 * already reaching the bottom of the page is left alone — growing it would
 * push it off the canvas, and a full-height rail has room for the row anyway.
 */
function panelAround(page: UiPage, canvas: UiCanvas, grow: number): UiElement | null {
  const meters = page.elements
    .filter((el) => el.type === "meter")
    .map((el) => boxOn(el, canvas))
    .filter((b): b is Box => b !== null);
  if (meters.length === 0) return null;
  const wraps = page.elements.filter((el) => {
    if (el.type !== "box") return false;
    const b = boxOn(el, canvas);
    if (b === null || b.w === 0 || b.h === 0) return false;
    // Measured against the canvas in question: the wide one is 640 tall, and
    // judging a rail on it by the phone's 812 lets it grow off the screen.
    const limit = canvas === "desktop" ? (page.desktopHeight ?? UI_DESKTOP_H) : page.height;
    if (b.y + b.h + grow > limit) return false;
    return meters.every((m) => b.x <= m.x && b.y <= m.y && b.x + b.w >= m.x + m.w && b.y + b.h >= m.y + m.h);
  });
  // The tightest one: a full-bleed backdrop wraps the meters too, and growing
  // THAT would just make the background taller.
  return wraps.sort((a, b) => (boxOn(a, canvas)!.h - boxOn(b, canvas)!.h))[0] ?? null;
}

/** The column a new row lines up with on the wide canvas: the one the last
 *  meter is in. A desktop layout is divided into rails and columns, so a row
 *  spanning the whole canvas would cross them; on a phone there is only one
 *  column and full width is the only sensible answer. */
function desktopColumn(page: UiPage): { x: number; w: number } | null {
  const meters = page.elements
    .filter((el) => el.type === "meter" && el.desktop)
    .map((el) => boxOn(el, "desktop"))
    .filter((b): b is Box => b !== null);
  if (meters.length === 0) {
    // The first row goes in the conversation's own column, above it.
    const wide = transcriptOf(page)?.desktop;
    return wide ? { x: wide.x + PAD, w: Math.max(40, wide.w - PAD * 2) } : null;
  }
  const lowest = meters.reduce((a, b) => (b.y > a.y ? b : a));
  return { x: lowest.x, w: lowest.w };
}

export interface NewMeterRow {
  /** Unique within the page; the caller owns id generation. */
  id: string;
  label: string;
  variableId: string;
  /** Defaults to the theme's accent, which is what the other rows use. */
  color?: string;
}

/**
 * Add a labelled meter the full width of the column.
 *
 * Full width rather than half: a row added next to an existing one would have
 * to guess whether that one was meant to be halved, and a creator who wants
 * two across can narrow them. Starting wide is the choice that is undoable by
 * dragging; starting narrow leaves a hole nobody asked for.
 */
export function addMeterRow(doc: UiDoc, pageId: string, row: NewMeterRow): UiDoc {
  const placed = pageOf(doc, pageId);
  if (!placed) return doc;
  // The conversation's place on the wide canvas first: a page that only ever
  // placed it on the phone gets its centred column, and the row lines up in
  // it. Reading the phone box as the wide one put the row, and then the
  // transcript itself, in a strip down the left of a desktop window.
  const page = withDesktopConversation(placed);
  const y = nextMeterY(page, "phone");
  const w = UI_CANVAS_W - PAD * 2;
  const valueW = 38;
  const group = `g-${row.id}`;
  const track = METER_TRACK_FILLS;
  const fills = meterFillsFor(row.color ?? "var(--yc-send-bg, #d9a13f)");

  // The same row, placed on the wide canvas too. Without this it would inherit
  // the phone's coordinates there and land across whatever the desktop layout
  // put at x=18 — a rail, a portrait, the edge of the screen.
  const col = desktopColumn(page);
  const dy = nextMeterY(page, "desktop");
  const dBox = col
    ? {
        label: { x: col.x, y: dy, w: col.w - valueW, h: LABEL_H },
        value: { x: col.x + col.w - valueW, y: dy - 2, w: valueW, h: LABEL_H + 2 },
        track: { x: col.x, y: dy + LABEL_H + 6, w: col.w, h: TRACK_H },
      }
    : null;

  const added: UiElement[] = [
    {
      id: `${row.id}-label`, group, type: "text",
      x: PAD, y, w: w - valueW, h: LABEL_H,
      ...(dBox ? { desktop: dBox.label } : {}),
      text: { template: row.label },
      style: { size: 11, color: "var(--yc-name, rgba(255,255,255,0.55))", letterSpacing: 0.6 },
    },
    {
      id: `${row.id}-value`, group, type: "text",
      x: PAD + w - valueW, y: y - 2, w: valueW, h: LABEL_H + 2,
      ...(dBox ? { desktop: dBox.value } : {}),
      text: { template: `{{${row.variableId}}}` },
      style: { size: 13, weight: 700, color: "var(--yc-text, #f4f1ea)", align: "right" },
    },
    {
      id: row.id, group, type: "meter",
      x: PAD, y: y + LABEL_H + 6, w, h: TRACK_H,
      ...(dBox ? { desktop: dBox.track } : {}),
      value: { kind: "variable", variableId: row.variableId, fallback: 50 },
      min: { kind: "literal", value: 0 },
      max: { kind: "literal", value: 100 },
      style: { track, fills, radius: 999 },
    },
  ];

  // Each canvas opens its own gap, at its own insertion point, and each grows
  // whatever panel the meters live inside.
  const panels = {
    phone: panelAround(page, "phone", METER_ROW_H),
    desktop: dBox ? panelAround(page, "desktop", METER_ROW_H) : null,
  };
  let elements = reflow(page, y, METER_ROW_H, "phone");
  if (dBox) elements = reflow({ ...page, elements }, dy, METER_ROW_H, "desktop");
  elements = elements.map((el) => {
    let next = el;
    for (const canvas of ["phone", "desktop"] as const) {
      if (panels[canvas]?.id !== el.id) continue;
      const b = boxOn(next, canvas);
      if (b) next = withBox(next, canvas, { ...b, h: b.h + METER_ROW_H });
    }
    return next;
  });
  return mapPage(doc, pageId, () => [...elements, ...added]);
}

/**
 * Put a part in as a row of its own, just above the transcript, on both
 * canvases — the transcript shortens to make the room. A text or a list added
 * to a chat page used to be placed in the first free spot, which on a page
 * that is mostly conversation was on top of the conversation.
 *
 * Returns null when the page has no transcript or it cannot give up the room
 * (see `canReflow`); the caller places the part the ordinary way then.
 */
export function addStackedRow(doc: UiDoc, pageId: string, el: UiElement, gap = 8): UiDoc | null {
  const stored = pageOf(doc, pageId);
  // As for a meter row: the conversation's wide column first (see addMeterRow).
  const page = stored && withDesktopConversation(stored);
  const transcript = page && transcriptOf(page);
  if (!page || !transcript || !canReflow(doc, pageId, el.h + gap)) return null;
  const phone = boxOn(transcript, "phone")!;
  const wide = boxOn(transcript, "desktop");
  const placed: UiElement = {
    ...el,
    x: phone.x + PAD, y: phone.y, w: Math.max(40, phone.w - PAD * 2),
    ...(wide ? { desktop: { x: wide.x + PAD, y: wide.y, w: Math.max(40, wide.w - PAD * 2), h: el.h } } : {}),
  };
  let elements = reflow(page, phone.y, el.h + gap, "phone");
  if (wide) elements = reflow({ ...page, elements }, wide.y, el.h + gap, "desktop");
  return mapPage(doc, pageId, () => [...elements, placed]);
}

/**
 * Remove every element of a group, and close the gap it leaves.
 *
 * The space only comes back when the group was a stack of rows above the
 * transcript — deleting a portrait or a glass chip leaves its hole, because
 * those sit in a composition rather than a column and sliding the rest up
 * would rearrange a card the creator did not ask to rearrange.
 */
export function removeGroup(doc: UiDoc, pageId: string, elementIds: readonly string[]): UiDoc {
  const page = pageOf(doc, pageId);
  if (!page) return doc;
  const ids = new Set(elementIds);
  const going = page.elements.filter((el) => ids.has(el.id));
  if (going.length === 0) return doc;

  const isMeterRow = going.some((el) => el.type === "meter");
  const isManagedRow = going.every(el => !!el.variableDisplay)
    && new Set(going.map(el => el.group ?? el.id)).size === 1;
  const kept = page.elements.filter((el) => !ids.has(el.id));
  if (!isMeterRow && !isManagedRow) return mapPage(doc, pageId, () => kept);

  // Each canvas closes its own gap: the row may be alone on the phone and
  // shoulder to shoulder with another on the desktop, or the other way round.
  let elements = kept;
  for (const canvas of ["phone", "desktop"] as const) {
    const boxes = going.map((el) => boxOn(el, canvas)).filter((b): b is Box => b !== null);
    if (boxes.length === 0) continue;
    const top = Math.min(...boxes.map((b) => b.y));
    const bottom = Math.max(...boxes.map((b) => b.y + b.h));
    if (!isMeterRow) {
      const transcript = transcriptOf(page);
      const tBox = transcript && boxOn(transcript, canvas);
      // A managed part moved into the composition no longer owns a row
      // above the transcript. Removing it must not rearrange that layout.
      if (!tBox || bottom + 8 > tBox.y) continue;
    }

    // Two meters side by side share a row. Removing one of them empties half
    // the row and frees no vertical space at all — reclaiming it would drag
    // the survivor up into whatever sits above, which is how deleting 体力 slid
    // 精力 into the details button.
    const rowStillStands = elements.some((el) => {
      if (isMeterRow ? el.type !== "meter" : !el.variableDisplay) return false;
      const b = boxOn(el, canvas);
      return b !== null && b.y < bottom && b.y + b.h > top;
    });
    if (rowStillStands) continue;

    // The panel shrinks back with the row it was holding.
    const panel = isMeterRow ? panelAround({ ...page, elements: page.elements }, canvas, 0) : null;
    // Measured from the BOTTOM of what left, so nothing that merely starts at
    // the same y — a label beside the track — counts as being below it.
    const rowHeight = isMeterRow ? METER_ROW_H : bottom - top + 8;
    elements = reflow({ ...page, elements }, bottom, -rowHeight, canvas);
    if (panel) {
      elements = elements.map((el) => {
        if (el.id !== panel.id) return el;
        const b = boxOn(el, canvas);
        return b ? withBox(el, canvas, { ...b, h: Math.max(1, b.h - METER_ROW_H) }) : el;
      });
    }
  }
  return mapPage(doc, pageId, () => elements);
}

/**
 * Copy a group, offset so the copy is visibly a copy rather than a thing that
 * appears to have done nothing.
 *
 * Ids have to be new and they have to stay INTERNALLY consistent: a meter's
 * label and track are one group, and a copy sharing the original's group name
 * would make selecting either select all six elements. The caller supplies the
 * fresh stem because id generation belongs to the app.
 */
export function duplicateGroup(
  doc: UiDoc,
  pageId: string,
  elementIds: readonly string[],
  stem: string,
  canvas: UiCanvas = "phone",
): UiDoc {
  const page = pageOf(doc, pageId);
  if (!page) return doc;
  const ids = new Set(elementIds);
  const source = page.elements.filter((el) => ids.has(el.id));
  if (source.length === 0) return doc;

  const OFFSET = 12;
  const group = source[0]!.group ? `g-${stem}` : undefined;
  const copies = source.map((el, i) => {
    const copy: UiElement = { ...el, id: `${stem}-${i}`, ...(group ? { group } : {}) };
    const b = boxOn(copy, canvas);
    return b ? withBox(copy, canvas, { ...b, x: b.x + OFFSET, y: b.y + OFFSET }) : copy;
  });
  return mapPage(doc, pageId, (elements) => [...elements, ...copies]);
}

/** Which variable an element reads, for the panel to show and rebind. */
export function boundVariableOf(el: UiElement): string | null {
  if (el.type === "meter" && el.value.kind === "variable") return el.value.variableId;
  if (el.type === "image" && el.src.kind === "variable") return el.src.variableId;
  if (el.type === "list" && el.source.kind === "variable") return el.source.variableId;
  if (el.type === "text") {
    const match = /\{\{([^}]+)\}\}/.exec(el.text?.template ?? "");
    return match ? match[1]!.trim() : null;
  }
  return null;
}

/** Point an element at a different variable, in whatever way its type binds. */
export function rebindVariable(el: UiElement, variableId: string): UiElement {
  if (el.type === "meter") return { ...el, value: { kind: "variable", variableId, fallback: 50 } };
  if (el.type === "image") return { ...el, src: { kind: "variable", variableId } };
  if (el.type === "list") return { ...el, source: { kind: "variable", variableId } };
  if (el.type === "text") {
    const previous = boundVariableOf(el);
    // Swap the macro in place so "Day {{old}} · dusk" keeps its sentence.
    const template = previous
      ? (el.text?.template ?? "").replace(`{{${previous}}}`, `{{${variableId}}}`)
      : `{{${variableId}}}`;
    return { ...el, text: { template } };
  }
  return el;
}

// ── Adding any element ─────────────────────────────────────────────────────

/** What the "add" menu offers. Chat surfaces are the card, not decoration, and
 *  a custom code block is not a no-code thing — neither is on it. */
export type UiAddableType = "text" | "button" | "image" | "box" | "meter" | "list" | "choice" | "field" | "popup";

/** A size that reads as the thing it is the moment it lands. */
const DEFAULT_SIZE: Record<UiAddableType, { w: number; h: number }> = {
  text: { w: 220, h: 32 },
  button: { w: 160, h: 44 },
  image: { w: 160, h: 160 },
  box: { w: 240, h: 120 },
  meter: { w: 220, h: 8 },
  list: { w: 240, h: 140 },
  // A set of cards is a screen's worth of content, so it takes the column —
  // gutter to gutter on the phone — rather than landing as a small box the
  // creator has to stretch before the cards inside can be read.
  choice: { w: 339, h: 390 },
  field: { w: 300, h: 74 },
  popup: { w: 300, h: 300 },
};

/** On the wide canvas a few parts want a different shape, not just a place:
 *  four opening cards side by side instead of a phone's two-by-two. */
const DESKTOP_SIZE: Partial<Record<UiAddableType, { w: number; h: number }>> = {
  choice: { w: 720, h: 360 },
  field: { w: 360, h: 74 },
  popup: { w: 400, h: 320 },
};

/** A popup floats over the page, so it is centred rather than stepped past
 *  whatever is already there. */
function centreOn(page: UiPage, canvas: UiCanvas, w: number, h: number): Box {
  const canvasW = canvas === "desktop" ? UI_DESKTOP_W : UI_CANVAS_W;
  const canvasH = canvas === "desktop" ? (page.desktopHeight ?? UI_DESKTOP_H) : page.height;
  return { x: Math.round((canvasW - w) / 2), y: Math.max(0, Math.round((canvasH - h) / 2)), w, h };
}

/** Chat, transcript and composer: the card itself. A new part is never
 *  dropped on them while there is anywhere else to go. */
const LOAD_BEARING = new Set<UiElement["type"]>(["chat", "messages", "composer"]);
/** Parts the player presses, picks or types into. Covering one breaks the
 *  screen, so a new part pays as much to cover it as to cover the chat. */
const INTERACTIVE = new Set<UiElement["type"]>(["choice", "field", "list", "button", "custom"]);
/** Parts that can be a screen's backdrop: drawn under everything else. */
const BACKDROP = new Set<UiElement["type"]>(["box", "image"]);
/** Parts that say something — a title, a picture, a number. Cheaper to cover
 *  than something the player uses, but a new part on top of a heading is
 *  still a part on top of a heading. */
const CONTENT = new Set<UiElement["type"]>(["text", "image", "meter"]);

/** Whether an element is drawn on a canvas at all. A desktop box of `null`
 *  takes it off the wide canvas; a phone box of zero size is how a layout
 *  keeps a part (a rail, a register card) on the desktop only. */
export function isOnCanvas(el: UiElement, canvas: UiCanvas): boolean {
  const b = boxOn(el, canvas);
  return b !== null && b.w > 0 && b.h > 0;
}

/** Which canvases a part is drawn on. */
export function presenceOf(el: UiElement): "both" | "phone" | "desktop" | "none" {
  const phone = isOnCanvas(el, "phone");
  const desktop = isOnCanvas(el, "desktop");
  return phone && desktop ? "both" : phone ? "phone" : desktop ? "desktop" : "none";
}

const overlapArea = (a: Box, b: Box): number => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};

/** Clearance a new part keeps from its neighbours, in design px. */
const GAP = 10;

/** Covering the chat or something the player uses. */
const COST_USED = 8;
/** Covering words, a picture or a number. */
const COST_WORDS = 3;
/** Covering a decorative panel. */
const COST_DECOR = 1;

/** Something a new part should keep off, and what covering it costs. */
interface Obstacle {
  box: Box;
  weight: number;
}

function obstaclesOn(page: UiPage, canvas: UiCanvas, ignoreId?: string): Obstacle[] {
  const canvasW = canvas === "desktop" ? UI_DESKTOP_W : UI_CANVAS_W;
  const canvasH = canvas === "desktop" ? (page.desktopHeight ?? UI_DESKTOP_H) : page.height;
  const out: Obstacle[] = [];
  for (const el of page.elements) {
    if (el.type === "popup" || el.id === ignoreId) continue;
    const b = boxOn(el, canvas);
    if (!b || b.w <= 0 || b.h <= 0) continue;
    // Only a picture or panel spanning half the canvas is a backdrop that
    // parts sit on. A big part the player uses — the opening cards fill two
    // thirds of a phone — is still something a new part must not cover.
    if (BACKDROP.has(el.type) && b.w * b.h >= canvasW * canvasH * 0.5) continue;
    const weight = LOAD_BEARING.has(el.type) || INTERACTIVE.has(el.type) ? COST_USED
      : CONTENT.has(el.type) ? COST_WORDS : COST_DECOR;
    out.push({ box: b, weight });
  }
  return out;
}

/**
 * What a box would sit on top of: the chat, anything the player uses, words,
 * pictures and meters — not a backdrop or a decorative panel. Empty when the
 * box is in real empty space. The editor uses it to say so when a crowded
 * page left a new part nowhere better to go.
 */
export function coveredOn(page: UiPage, canvas: UiCanvas, box: Box, ignoreId?: string): Box[] {
  return obstaclesOn(page, canvas, ignoreId)
    .filter((o) => o.weight >= COST_WORDS && overlapArea(box, o.box) > 0)
    .map((o) => o.box);
}

/**
 * Where a new part lands on one canvas: in real empty space.
 *
 * It used to land a third of the way down and centred — on a finished screen
 * that is on top of whatever is there. Every spot on the canvas is scored by
 * what it would cover: the chat, the transcript, the composer and anything the
 * player presses or types into cost the most; words, pictures and meters
 * less; a decorative panel little; a backdrop (a panel or picture spanning
 * half the canvas) or a popup (it floats) nothing. Coming within a gap's width
 * of a neighbour costs a fifth of covering it, so a strip just tall enough for
 * the part still counts as empty space.
 *
 * A page with no empty space left used to get the part over its title, the
 * cheapest thing to cover. Now it goes near the end of the content instead —
 * never over words, and over as little of what the player uses as it can —
 * and the editor says it had nowhere better to put it (see coveredOn).
 *
 * Of the spots that cost the same, the one nearest "just below the parts
 * already placed" wins, so a second part lands under the first rather than
 * somewhere random. The same size on both canvases rather than stretched: a
 * 160px button is a button on both.
 */
export function freeSpotOn(page: UiPage, canvas: UiCanvas, w: number, h: number): Box {
  const canvasW = canvas === "desktop" ? UI_DESKTOP_W : UI_CANVAS_W;
  const canvasH = canvas === "desktop" ? (page.desktopHeight ?? UI_DESKTOP_H) : page.height;
  const margin = canvas === "desktop" ? 24 : 16;
  const bw = Math.max(1, Math.min(w, canvasW - margin * 2));
  const bh = Math.max(1, Math.min(h, canvasH - margin * 2));
  const obstacles = obstaclesOn(page, canvas).map((o) => ({
    ...o,
    halo: { x: o.box.x - GAP, y: o.box.y - GAP, w: o.box.w + GAP * 2, h: o.box.h + GAP * 2 },
  }));
  // The next line of the screen: just below the lowest part that is not the
  // conversation or a backdrop, or a third of the way down an empty page.
  const bottoms = page.elements
    .filter((el) => el.type !== "popup" && !LOAD_BEARING.has(el.type))
    .map((el) => boxOn(el, canvas))
    .filter((b): b is Box => !!b && b.w > 0 && b.h > 0 && b.w * b.h < canvasW * canvasH * 0.5)
    .map((b) => b.y + b.h);
  const next = bottoms.length ? Math.max(...bottoms) + GAP + 2 : Math.round(canvasH * 0.3);
  const anchorY = Math.max(margin, Math.min(next, canvasH - margin - bh));
  const anchorX = Math.round((canvasW - bw) / 2);
  const step = canvas === "desktop" ? 8 : 4;
  const xs = new Set<number>([anchorX]);
  const ys = new Set<number>([anchorY]);
  for (let x = margin; x <= canvasW - margin - bw; x += step) xs.add(x);
  for (let y = margin; y <= canvasH - margin - bh; y += step) ys.add(y);

  interface Scored { box: Box; cost: number; onWords: number; onUsed: number; distance: number }
  let best: Scored | null = null;
  // Where it goes when there is no empty space: off every word, over as little
  // of what the player uses as possible.
  let fallback: Scored | null = null;
  for (const y of ys) {
    for (const x of xs) {
      const box = { x, y, w: bw, h: bh };
      let cost = 0;
      let onWords = 0;
      let onUsed = 0;
      for (const o of obstacles) {
        const raw = overlapArea(box, o.box);
        cost += o.weight * (raw + (overlapArea(box, o.halo) - raw) * 0.2);
        if (o.weight === COST_WORDS) onWords += raw;
        else if (o.weight === COST_USED) onUsed += raw;
      }
      // Below the anchor reads as "next"; above it, as squeezed in.
      const distance = Math.abs(y - anchorY) * (y < anchorY ? 1.5 : 1) + Math.abs(x - anchorX) * 0.5;
      const scored = { box, cost, onWords, onUsed, distance };
      if (!best || cost < best.cost || (cost === best.cost && distance < best.distance)) best = scored;
      // Covering a sliver less of the cards is not worth landing far from the
      // end of the content: only a tenth of the part's own size counts.
      const slack = bw * bh * 0.1;
      if (onWords === 0 && (!fallback || onUsed < fallback.onUsed - slack
        || (onUsed <= fallback.onUsed + slack && distance < fallback.distance))) {
        fallback = scored;
      }
    }
  }
  if (best && best.onWords + best.onUsed === 0) return best.box;
  return fallback?.box ?? { x: anchorX, y: anchorY, w: bw, h: bh };
}

export interface NewElementInput {
  id: string;
  type: UiAddableType;
  /** Creator-language defaults the engine cannot know. */
  text?: string;
  /** For a meter: the variable it shows. For a choice, field or popup: the
   *  variable it writes (or, for a popup, watches). */
  variableId?: string;
  /** For a choice: its cards. */
  options?: UiChoiceOption[];
  /** For a field: its question. For a popup: its title. */
  label?: string;
  /** For a field: the grey hint inside the box. */
  placeholder?: string;
  /** For a field: which kind of answer. */
  fieldKind?: UiFieldKind;
  /** For a popup: its close button. */
  buttonLabel?: string;
}

/**
 * A fresh element of one of the no-code types, placed on the page at a spot a
 * creator can see and drag from, on top of what is already there.
 */
export function newElement(page: UiPage, input: NewElementInput): UiElement {
  const size = DEFAULT_SIZE[input.type];
  const dSize = DESKTOP_SIZE[input.type] ?? size;
  const place = input.type === "popup" ? centreOn : freeSpotOn;
  const phone = place(page, "phone", size.w, size.h);
  const desk = place(page, "desktop", dSize.w, dSize.h);
  const z = Math.max(0, ...page.elements.map((el) => el.z ?? 0)) + 1;
  const base = { id: input.id, x: phone.x, y: phone.y, w: phone.w, h: phone.h, z, desktop: desk };
  const text = input.text ?? "";
  switch (input.type) {
    case "text":
      return { ...base, type: "text", text: { template: text }, style: { size: 16, color: THEME_TEXT } };
    case "button":
      return {
        ...base,
        type: "button",
        label: { template: text },
        actions: [],
        style: { fills: [{ kind: "color", color: "var(--yc-send-bg, #d9a13f)" }], textColor: "#ffffff", radius: 10 },
      };
    case "image":
      return { ...base, type: "image", src: { kind: "asset", ref: "" }, fit: "cover", radius: 12 };
    case "box":
      return { ...base, type: "box", style: { fills: [{ kind: "color", color: "rgba(0,0,0,0.45)" }], radius: 12 } };
    case "meter":
      return {
        ...base,
        type: "meter",
        value: { kind: "variable", variableId: input.variableId ?? "", fallback: 50 },
        min: { kind: "literal", value: 0 },
        max: { kind: "literal", value: 100 },
        style: { fills: meterFillsFor("var(--yc-send-bg, #d9a13f)"), track: METER_TRACK_FILLS, radius: 999 },
      };
    case "list":
      return {
        ...base,
        type: "list",
        source: { kind: "static", items: text ? text.split("\n").filter(Boolean) : [] },
        item: { template: "{{item}}" },
        gap: 6,
        textStyle: { size: 14, color: THEME_TEXT },
      };
    case "choice":
      return {
        ...base,
        type: "choice",
        layout: "grid",
        columns: 2,
        gap: 10,
        options: input.options ?? [],
        ...(input.variableId ? { variableId: input.variableId } : {}),
      };
    case "field":
      return {
        ...base,
        type: "field",
        kind: input.fieldKind ?? "text",
        variableId: input.variableId ?? "",
        ...(input.label ? { label: { template: input.label } } : {}),
        ...(input.placeholder ? { placeholder: input.placeholder } : {}),
      };
    case "popup":
      return {
        ...base,
        // Over everything on the page, including parts added after it.
        z: base.z + 1000,
        type: "popup",
        variableId: input.variableId ?? "",
        ...(input.label ? { title: { template: input.label } } : {}),
        body: { template: input.text ?? "{{value}}" },
        ...(input.buttonLabel ? { buttonLabel: { template: input.buttonLabel } } : {}),
      };
  }
}

/**
 * Every list of steps an element carries: a button's, each card's in a
 * choice, the choice's confirm button, a list's row steps. Anything that
 * rewrites steps (removing a page) has to reach all of them, or a card that
 * jumps to a deleted page survives the button that did.
 */
export function mapElementActions(el: UiElement, fn: (actions: UiAction[]) => UiAction[]): UiElement {
  switch (el.type) {
    case "button":
      return Array.isArray(el.actions) ? { ...el, actions: fn(el.actions) } : el;
    case "choice":
      return {
        ...el,
        options: (el.options ?? []).map((o) => (Array.isArray(o.actions) ? { ...o, actions: fn(o.actions) } : o)),
        ...(el.confirm && Array.isArray(el.confirm.actions) ? { confirm: { ...el.confirm, actions: fn(el.confirm.actions) } } : {}),
      };
    case "list":
      return Array.isArray(el.rowActions) ? { ...el, rowActions: fn(el.rowActions) } : el;
    default:
      return el;
  }
}

/**
 * Recount every opening step that names its opening. `greetingIds` is the
 * card's openings in the order the player's chat counts them (PromptBuilder
 * `buildGreetingEntries`). A step whose opening is gone keeps its index.
 * Returns the same document when nothing moved.
 */
export function syncGreetingActions(doc: UiDoc, greetingIds: readonly string[]): UiDoc {
  let changed = false;
  const pages = (doc.pages ?? []).map((p) => {
    let pageChanged = false;
    const elements = (p.elements ?? []).map((el) => {
      let elChanged = false;
      const next = mapElementActions(el, (actions) => {
        let listChanged = false;
        const out = actions.map((a) => {
          if (a.kind !== "switch-greeting" || !a.greetingId) return a;
          const at = greetingIds.indexOf(a.greetingId);
          if (at < 0 || at === a.index) return a;
          listChanged = true;
          return { ...a, index: at };
        });
        if (!listChanged) return actions;
        elChanged = true;
        return out;
      });
      if (!elChanged) return el;
      pageChanged = true;
      return next;
    });
    if (!pageChanged) return p;
    changed = true;
    return { ...p, elements };
  });
  return changed ? { ...doc, pages } : doc;
}

/** Every step an element can run, for checks that read rather than rewrite. */
export function elementActions(el: UiElement): UiAction[] {
  const out: UiAction[] = [];
  mapElementActions(el, (actions) => { out.push(...actions); return actions; });
  return out;
}

/** Put an element on a page. */
export function addElement(doc: UiDoc, pageId: string, el: UiElement): UiDoc {
  if (!pageOf(doc, pageId)) return doc;
  return mapPage(doc, pageId, (elements) => [...elements, el]);
}

// ── Pages ──────────────────────────────────────────────────────────────────

/**
 * A new, empty page. It borrows the entry page's height and background so it
 * looks like part of the same card when a button first jumps to it, rather
 * than a blank sheet the creator has to restyle before it is presentable.
 */
export function addPage(doc: UiDoc, page: { id: string; name: string }): UiDoc {
  const pages = doc.pages ?? [];
  const model = pages.find((p) => p.id === doc.entryPageId) ?? pages[0];
  const next: UiPage = {
    id: page.id,
    name: page.name,
    height: model?.height ?? 812,
    ...(model?.desktopHeight ? { desktopHeight: model.desktopHeight } : {}),
    ...(model?.background ? { background: model.background } : {}),
    elements: [],
  };
  return { ...doc, pages: [...pages, next] };
}

export function renamePage(doc: UiDoc, pageId: string, name: string): UiDoc {
  return { ...doc, pages: (doc.pages ?? []).map((p) => (p.id === pageId ? { ...p, name } : p)) };
}

/**
 * Remove a page. The last page cannot go — a card with no page has no
 * interface. The entry moves to the first page left, and every "跳到页面" step
 * that pointed at the removed page is dropped: a button that jumps nowhere is
 * the failure `validateUiDoc` exists to catch.
 */
export function removePage(doc: UiDoc, pageId: string): UiDoc {
  const next = removePageRaw(doc, pageId);
  return next === doc ? doc : tidyPlayMenu(next);
}

function removePageRaw(doc: UiDoc, pageId: string): UiDoc {
  const pages = doc.pages ?? [];
  const removed = pages.find((p) => p.id === pageId);
  if (pages.length <= 1 || !removed) return doc;
  // A page in a sequence (an opening screen whose button goes on to the next
  // one) closes the gap it leaves: whatever led to it now leads where it led.
  const onward = removed.leaveWhen
    ? removed.elements.flatMap(elementActions)
      .find((a): a is Extract<UiAction, { kind: "go-page" }> => a.kind === "go-page" && a.pageId !== pageId && pages.some((p) => p.id === a.pageId))
      ?.pageId
    : undefined;
  if (onward) {
    const relinked = pages
      .filter((p) => p.id !== pageId)
      .map((p) => ({
        ...p,
        elements: p.elements.map((el) =>
          elementActions(el).some((a) => a.kind === "go-page" && a.pageId === pageId)
            ? mapElementActions(el, (actions) => actions.map((a) => (a.kind === "go-page" && a.pageId === pageId ? { ...a, pageId: onward } : a)))
            : el),
      }));
    return { ...doc, pages: relinked, entryPageId: doc.entryPageId === pageId ? onward : doc.entryPageId };
  }
  const kept = pages
    .filter((p) => p.id !== pageId)
    .map((p) => {
      // A page that stepped aside to the removed one now simply stays.
      if (p.leaveWhen?.pageId !== pageId) return p;
      const { leaveWhen: _gone, ...rest } = p;
      return rest;
    })
    .map((p) => ({
      ...p,
      elements: p.elements.map((el) =>
        elementActions(el).some((a) => a.kind === "go-page" && a.pageId === pageId)
          ? mapElementActions(el, (actions) => actions.filter((a) => !(a.kind === "go-page" && a.pageId === pageId)))
          : el),
    }));
  return { ...doc, pages: kept, entryPageId: doc.entryPageId === pageId ? kept[0]!.id : doc.entryPageId };
}

/**
 * Make a page the one the card opens on.
 *
 * Only the entry moves. Every page keeps its `leaveWhen`, and that is exactly
 * right: an opening page that steps aside to the chat once the player has
 * spoken still steps aside, wherever it now sits in the list, because the
 * step is named by page id rather than by position.
 */
export function setEntryPage(doc: UiDoc, pageId: string): UiDoc {
  if (!(doc.pages ?? []).some((p) => p.id === pageId) || doc.entryPageId === pageId) return doc;
  return { ...doc, entryPageId: pageId };
}

/**
 * Move a page to a new place in the list. The list order is only the order
 * the creator sees them in — which page opens is `entryPageId`, and where a
 * button goes is a page id — so reordering never changes how the card plays.
 */
export function movePage(doc: UiDoc, pageId: string, toIndex: number): UiDoc {
  const pages = [...(doc.pages ?? [])];
  const from = pages.findIndex((p) => p.id === pageId);
  if (from === -1) return doc;
  const to = Math.max(0, Math.min(pages.length - 1, Math.round(toIndex)));
  if (to === from) return doc;
  const [page] = pages.splice(from, 1);
  pages.splice(to, 0, page!);
  return { ...doc, pages };
}

// ── Variables the editor made on the creator's behalf ──────────────────────
//
// Adding a form question or a popup makes a variable for it, so the part works
// before a single setting is touched. Those variables belong to the part: when
// the part goes (or is pointed at another variable), a variable nothing else
// reads is litter. The doc remembers which ones it made, so only those are
// ever cleaned up — a variable the creator made by hand is never touched.

/** Remember that the editor made this variable for a part. */
export function withAutoVariable(doc: UiDoc, variableId: string): UiDoc {
  if (!variableId || (doc.autoVariables ?? []).includes(variableId)) return doc;
  return { ...doc, autoVariables: [...(doc.autoVariables ?? []), variableId] };
}

/** Forget variables (they were deleted, or the creator adopted them). */
export function withoutAutoVariables(doc: UiDoc, variableIds: readonly string[]): UiDoc {
  if (!doc.autoVariables?.length) return doc;
  const gone = new Set(variableIds);
  const kept = doc.autoVariables.filter((id) => !gone.has(id));
  if (kept.length === doc.autoVariables.length) return doc;
  if (kept.length === 0) {
    const { autoVariables: _drop, ...rest } = doc;
    return rest;
  }
  return { ...doc, autoVariables: kept };
}

/**
 * A variable name from the question a form part asks: 「今晚的暗号是？」 is
 * about 今晚的暗号, "What is your name?" about "your name". A variable is
 * named for what it HOLDS, so the question's grammar comes off — the closing
 * punctuation, a trailing 是 / 是什么 / 叫什么, a leading "What is". Macros are
 * dropped (they read another variable, not this one). Empty when nothing is
 * left, so the caller falls back to its own default.
 */
export function nameFromQuestion(question: string): string {
  let s = String(question ?? "")
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const trailing = /[\s?？!！。.,，:：;；~～…、]+$/;
  s = s.replace(trailing, "").replace(/^[\s?？!！。.,，:：;；~～…、]+/, "");
  s = s.replace(/(是什么|叫什么|是多少|是哪个|是哪位|是谁|有哪些|是)$/, "");
  s = s.replace(/^(请(问|输入|填写|选择)?|what(?:'s| is| are)|who(?:'s| is| are)|which|enter|choose|pick|請(問|輸入|填寫|選擇)?)\s*/i, "");
  s = s.replace(trailing, "").trim();
  // Long enough to say what it is, short enough to read on a variable row.
  return [...s].slice(0, 24).join("").trim();
}

// ── Text boxes that fit their words ────────────────────────────────────────
//
// A text part clips at its box (there is no scrollbar on a card), so raising
// the size of a title from 38 to 52 used to cut the tops of its letters off
// with nothing to say so. Like a slide editor's autofit, the box now grows to
// hold the text whenever its size, line height or spacing changes. It only
// grows: a box drawn taller on purpose is left alone.

/** Rough advance of one character, as a share of the font size. Generous on
 *  purpose — a box a few px too tall is invisible, one too short clips. */
function charAdvance(ch: string): number {
  const c = ch.codePointAt(0) ?? 0;
  if ((c >= 0x1100 && c <= 0x11ff) || (c >= 0x2e80 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af)
    || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xffef)
    || (c >= 0x20000 && c <= 0x3134f) || (c >= 0x1f300 && c <= 0x1faff)) return 1;
  if (ch === " ") return 0.3;
  if (/[A-Z0-9@#%&MWmw]/.test(ch)) return 0.7;
  return 0.56;
}

/** How tall a text part's box must be to show all of its words on one
 *  canvas, in design px. An estimate: the engine has no fonts to measure. */
export function textHeightNeeded(el: UiElement, canvas: UiCanvas): number | null {
  if (el.type !== "text") return null;
  const b = boxOn(el, canvas);
  if (!b || b.w <= 0) return null;
  const style = el.style ?? {};
  const size = (canvas === "desktop" ? style.desktopSize ?? style.size : style.size) ?? 14;
  const lineHeight = style.lineHeight ?? 1.5;
  const spacing = style.letterSpacing ?? 0;
  const weight = (style.weight ?? 400) >= 600 ? 1.06 : 1;
  // A variable's value is unknown until play: count it as a short word.
  const text = String(el.text?.template ?? "").replace(/\{\{[^}]*\}\}/g, "000000");
  const width = b.w * 0.94;
  let lines = 0;
  for (const paragraph of style.nowrap ? [text.replace(/\n/g, " ")] : text.split("\n")) {
    if (style.nowrap) { lines += 1; continue; }
    let line = 0;
    let count = 1;
    for (const ch of paragraph) {
      const adv = charAdvance(ch) * size * weight + spacing;
      if (line > 0 && line + adv > width) { count++; line = 0; }
      line += adv;
    }
    lines += count;
  }
  return Math.ceil(Math.max(1, lines) * size * lineHeight + 2);
}

/** How wide a one-line (nowrap) text part must be to show all of its words
 *  on one canvas, in design px. Same estimate as textHeightNeeded. */
export function textWidthNeeded(el: UiElement, canvas: UiCanvas): number | null {
  if (el.type !== "text") return null;
  const style = el.style ?? {};
  const size = (canvas === "desktop" ? style.desktopSize ?? style.size : style.size) ?? 14;
  const spacing = style.letterSpacing ?? 0;
  const weight = (style.weight ?? 400) >= 600 ? 1.06 : 1;
  const text = String(el.text?.template ?? "").replace(/\{\{[^}]*\}\}/g, "000000").replace(/\n/g, " ");
  let width = 0;
  for (const ch of text) width += charAdvance(ch) * size * weight + spacing;
  return Math.ceil(width / 0.94 + 2);
}

/**
 * Widen a one-line text box on one canvas toward what its words need, into
 * the free room beside it: up to the canvas margin or the next part along
 * the same row, growing the way it is aligned (a centred title grows both
 * ways). Returns the box and whether the words now fit.
 */
function widenOneLine(el: UiElement, canvas: UiCanvas, need: number, page: UiPage | undefined): { box: Box; fits: boolean } {
  const b = boxOn(el, canvas)!;
  const canvasW = canvas === "desktop" ? UI_DESKTOP_W : UI_CANVAS_W;
  const margin = canvas === "desktop" ? 24 : 16;
  // A title set closer to the edge than the margin keeps its own edge.
  let left = Math.min(b.x, margin);
  let right = Math.max(b.x + b.w, canvasW - margin);
  for (const other of page?.elements ?? []) {
    if (other.id === el.id || other.type === "popup") continue;
    const o = boxOn(other, canvas);
    if (!o || o.w <= 0 || o.h <= 0) continue;
    if (Math.min(o.y + o.h, b.y + b.h) - Math.max(o.y, b.y) <= 0) continue; // not on this row
    if (BACKDROP.has(other.type) && o.w * o.h >= canvasW * (canvas === "desktop" ? UI_DESKTOP_H : 812) * 0.5) continue;
    if (o.x >= b.x + b.w - 1) right = Math.min(right, o.x - 8);
    else if (o.x + o.w <= b.x + 1) left = Math.max(left, o.x + o.w + 8);
  }
  const align = el.type === "text" ? el.style?.align ?? "left" : "left";
  const grow = need - b.w;
  let x = b.x;
  let w = b.w;
  if (align === "right") {
    x = Math.max(left, b.x - grow);
    w = b.x + b.w - x;
  } else if (align === "center") {
    const each = Math.ceil(grow / 2);
    const nx = Math.max(left, b.x - each);
    const nr = Math.min(right, b.x + b.w + each);
    x = nx;
    w = nr - nx;
  } else {
    w = Math.min(right, b.x + need) - b.x;
  }
  w = Math.max(b.w, Math.round(w));
  return { box: { ...b, x: Math.round(x), w }, fits: w >= need };
}

/**
 * Grow a text part's box(es) to hold its words, after its size, line height,
 * spacing or text changed. Every other part, and a box that already fits,
 * comes back unchanged (the same object).
 *
 * A one-line title (nowrap) that no longer fits its width first widens into
 * the free room beside it — pass the page so it knows where the neighbours
 * are. If even the full row is too narrow it stops being one line: it wraps,
 * and the box grows taller instead, which is what a slide editor's title
 * does. Cutting it off with an ellipsis (「从哪一刻开…」) is never the answer.
 */
export function fitTextBox(el: UiElement, page?: UiPage, opts: { hug?: boolean } = {}): UiElement {
  if (el.type !== "text") return el;
  let next: UiElement = el;
  if (el.style?.nowrap) {
    let fitsEverywhere = true;
    // The phone box is drawn on both canvases when there is no desktop box of
    // its own, so it must hold the words at both sizes.
    const shared = el.desktop === undefined;
    const phoneNeed = Math.max(textWidthNeeded(el, "phone") ?? 0, shared ? textWidthNeeded(el, "desktop") ?? 0 : 0);
    if (el.w > 0 && phoneNeed > el.w) {
      const { box, fits } = widenOneLine(next, "phone", phoneNeed, page);
      next = withBox(next, "phone", box);
      fitsEverywhere &&= fits;
    }
    if (el.desktop) {
      const need = textWidthNeeded(el, "desktop") ?? 0;
      if (need > el.desktop.w) {
        const { box, fits } = widenOneLine(next, "desktop", need, page);
        next = withBox(next, "desktop", box);
        fitsEverywhere &&= fits;
      }
    }
    if (!fitsEverywhere && next.type === "text") next = { ...next, style: { ...next.style, nowrap: false } };
  }
  const phoneNeed = textHeightNeeded(next, "phone");
  const sharedNeed = next.desktop === undefined ? textHeightNeeded(next, "desktop") : null;
  const need = Math.max(phoneNeed ?? 0, sharedNeed ?? 0);
  // `hug`: the box is as tall as its words, the way a slide editor's text
  // box is — it shrinks as well as grows, so the outline a creator grabs is
  // the text they see. Without it a box only ever grows (a template's taller
  // box is kept until the words are edited).
  // A hugging box also leaves the glyphs their overhang: a big font's letters
  // reach past the line box, and at 64px a box of exactly lines × size ×
  // line height clipped the bottom of the last line.
  const room = (canvas: "phone" | "desktop") => {
    const st = next.type === "text" ? next.style ?? {} : {};
    return opts.hug ? Math.ceil(((canvas === "desktop" ? st.desktopSize ?? st.size : st.size) ?? 14) * 0.1) : 0;
  };
  const grows = (have: number, want: number) => (opts.hug ? want !== have : want > have);
  const want = need > 0 ? need + room(sharedNeed !== null && (sharedNeed ?? 0) > (phoneNeed ?? 0) ? "desktop" : "phone") : 0;
  if (next.w > 0 && want > 0 && grows(next.h, want)) next = { ...next, h: want };
  if (next.desktop) {
    const dNeed = textHeightNeeded(next, "desktop");
    const dWant = dNeed !== null && dNeed > 0 ? dNeed + room("desktop") : 0;
    if (dWant > 0 && grows(next.desktop.h, dWant)) next = { ...next, desktop: { ...next.desktop, h: dWant } };
  }
  return next;
}

/** Whether a text-style change can change how much room the words take. */
export function textStyleAffectsHeight(patch: object | undefined): boolean {
  if (!patch) return false;
  return ["size", "desktopSize", "lineHeight", "letterSpacing", "nowrap", "weight"].some((k) => k in patch);
}

// ── A box that grew pushes what is under it ────────────────────────────────
//
// Growing a title's box to fit bigger words is half of autofit. The other
// half: the subtitle and the cards under it move down by as much as it grew,
// or the bigger title lands on top of them. Each canvas on its own — the
// phone and the wide layout are different arrangements of the same parts.

/** Parts whose content scrolls or stretches: at the page's bottom they give
 *  up height rather than being pushed off the canvas. */
const STRETCHY = new Set<UiElement["type"]>(["messages", "chat", "choice", "list", "box", "image", "custom"]);

/**
 * After `before` became the element with the same id on `page` (its box grew),
 * push the parts that sit directly under it down by the growth, on each canvas
 * separately. "Under" means starting at or below its old bottom edge and
 * sharing some of its width; whatever sits under a pushed part is pushed too,
 * and a group moves as one. A part pinned to the page's bottom edge (the
 * composer) stays; what would run into it or off the canvas gives up height
 * if it can (a transcript, the opening cards) and otherwise moves only as far
 * as there is room. Returns the same page when nothing needed to move.
 */
export function pushBelowGrown(page: UiPage, before: UiElement): UiPage {
  const after = page.elements.find((el) => el.id === before.id);
  if (!after) return page;
  let elements = page.elements;
  const byId = () => new Map(elements.map((el) => [el.id, el]));
  for (const canvas of ["phone", "desktop"] as const) {
    const ob = boxOn(before, canvas);
    const nb = boxOn(after, canvas);
    if (!ob || !nb || ob.w <= 0 || ob.h <= 0) continue;
    const delta = nb.y + nb.h - (ob.y + ob.h);
    if (delta <= 0) continue;
    // On the wide canvas a part without its own box already moved with its
    // phone box — unless the grown part has a wide box of its own, in which
    // case the two canvases part ways here.
    const sharedGrow = canvas === "desktop" && after.desktop === undefined && before.desktop === undefined;
    const canvasH = canvas === "desktop" ? (page.desktopHeight ?? UI_DESKTOP_H) : page.height;
    const current = byId();
    const candidates = elements.filter((el) => {
      if (el.id === after.id || el.type === "popup") return false;
      if (canvas === "desktop" && el.desktop === undefined && sharedGrow) return false;
      const b = boxOn(el, canvas);
      return !!b && b.w > 0 && b.h > 0;
    });
    const boxOf = (el: UiElement) => boxOn(el, canvas)!;
    const overlapX = (a: Box, b: Box) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0;
    const pinned = (b: Box) => b.y + b.h >= canvasH - 1;
    // Everything under the grown part, and under whatever that moves.
    const pushed = new Set<string>();
    const floors: Box[] = [];
    const queue: Box[] = [ob];
    while (queue.length) {
      const above = queue.shift()!;
      for (const el of candidates) {
        if (pushed.has(el.id)) continue;
        const b = boxOf(el);
        if (b.y < above.y + above.h - 2 || !overlapX(b, above === ob ? { ...ob, x: Math.min(ob.x, nb.x), w: Math.max(ob.x + ob.w, nb.x + nb.w) - Math.min(ob.x, nb.x) } : above)) continue;
        if (pinned(b)) { floors.push(b); continue; }
        const members = el.group ? candidates.filter((m) => m.group === el.group) : [el];
        for (const m of members) {
          if (pushed.has(m.id) || pinned(boxOf(m))) continue;
          pushed.add(m.id);
          queue.push(boxOf(m));
        }
      }
    }
    if (!pushed.size) continue;
    elements = elements.map((el) => {
      if (!pushed.has(el.id)) return el;
      const b = boxOf(current.get(el.id)!);
      // The room below: the canvas edge, or a pinned part it sits over,
      // keeping the gap it had (up to a margin's worth).
      let limit = canvasH - Math.min(Math.max(0, canvasH - (b.y + b.h)), 16);
      for (const f of floors) {
        if (overlapX(b, f) && f.y >= b.y + b.h - 2) limit = Math.min(limit, f.y - Math.min(Math.max(0, f.y - (b.y + b.h)), 8));
      }
      let y = b.y + delta;
      let h = b.h;
      if (y + h > limit) {
        const minH = Math.min(b.h, Math.max(48, Math.round(b.h * 0.4)));
        if (STRETCHY.has(el.type) && limit - y >= minH) h = limit - y;
        else y = Math.max(b.y, limit - h);
      }
      let moved: UiElement = el;
      // Its wide box was its phone box: freeze that before the phone box moves.
      if (canvas === "phone" && el.desktop === undefined && after.desktop !== undefined) moved = { ...moved, desktop: { ...b } };
      if (canvas === "desktop" && el.desktop === undefined) moved = { ...moved, desktop: { x: el.x, y: el.y, w: el.w, h: el.h } };
      return withBox(moved, canvas, { ...b, y: Math.round(y), h: Math.round(h) });
    });
  }
  return elements === page.elements ? page : { ...page, elements };
}

/**
 * Autofit on a page: re-fit the text part `id` after its style changed
 * (widening a one-line title into free room, wrapping it when there is none,
 * growing the box to hold its lines) and push the parts under it down by
 * however much it grew, on each canvas. The editor's style controls and the
 * assistant's `update_part` both come through here, so neither leaves a
 * bigger title sitting on the subtitle under it.
 */
export function fitTextOnPage(page: UiPage, id: string, before?: UiElement, opts: { hug?: boolean } = {}): UiPage {
  const el = page.elements.find((e) => e.id === id);
  if (!el || el.type !== "text") return page;
  const fitted = fitTextBox(el, page, opts);
  const withFit = fitted === el ? page : { ...page, elements: page.elements.map((e) => (e.id === id ? fitted : e)) };
  return pushBelowGrown(withFit, before ?? el);
}

/**
 * A copy of a page, right after it: every part copied with a fresh id (groups
 * kept together), everything else — background, heights, what it steps aside
 * to — as the original. Returns the document and the copy's id.
 */
export function duplicatePage(doc: UiDoc, pageId: string, copy: { id: string; name: string }): UiDoc {
  const pages = doc.pages ?? [];
  const at = pages.findIndex((p) => p.id === pageId);
  if (at < 0 || pages.some((p) => p.id === copy.id)) return doc;
  const source = pages[at]!;
  const suffix = copy.id.replace(/[^\w-]/g, "").slice(-6) || "copy";
  const ids = new Map(source.elements.map((el) => [el.id, `${el.id}-${suffix}`]));
  const groups = new Map<string, string>();
  const elements = source.elements.map((el) => {
    const next = { ...el, id: ids.get(el.id)! };
    if (el.group) {
      if (!groups.has(el.group)) groups.set(el.group, `${el.group}-${suffix}`);
      next.group = groups.get(el.group)!;
    }
    return next as UiElement;
  });
  const made: UiPage = { ...source, id: copy.id, name: copy.name, elements };
  return { ...doc, pages: [...pages.slice(0, at + 1), made, ...pages.slice(at + 1)] };
}
