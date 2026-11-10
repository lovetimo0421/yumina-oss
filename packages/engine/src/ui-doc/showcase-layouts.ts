import type { UiBoxStyle, UiButtonStyle, UiDoc, UiElement, UiFill, UiTextStyle } from "./types.js";
import { meterFillsFor, METER_TRACK_FILLS } from "./edit.js";
import {
  ACCENT, COL, D_H, D_PAD, D_W, DETAIL_KEYS, GLASS_FILL, HALF_W, NEED, OPENER_KEYS, PAD, PAGE_H, ROSTER_KEYS,
  TOOL_KEYS, UI_CANVAS_W, artSlot, bodyText, box, chipFill, chipText, conversation, detailsButton, doc, fillTemplateMacros,
  hairline, listPage, quietText,
} from "./layout-kit.js";
import type { UiTemplateInput, UiTemplatePreset, UiTemplateStrings, UiTemplateVariableIds } from "./layout-kit.js";

/**
 * Eight more whole-screen layouts, modelled on the hand-written frontends of
 * the most-played cards in the library. Built from ordinary parts, so they can
 * be edited like anything else on the canvas.
 *
 * Display fonts are set on the parts (a theme only carries a body font).
 * Colours use theme tokens: --yc-text for text on the page, --yc-name for
 * labels, --yc-send-fg for text on the accent. Paper, the cassette shell and
 * the parchment card use fixed colours for both fill and text, so they read
 * the same under any theme.
 *
 * Backdrops are named tpl-ground-* or tpl-art-* so the overlap checks in
 * templates.test.ts skip them.
 */

// ── Parts ──────────────────────────────────────────────────────────────────

type Spot = { x: number; y: number; w: number };
type Rect = { x: number; y: number; w: number; h: number };

/** Hidden on this canvas: a zero box on the phone, `desktop: null` on desktop. */
const OFF: Rect = { x: 0, y: 0, w: 0, h: 0 };

/** One element placed on both canvases. `null` takes it off that canvas. */
function placed(phone: Rect | null, desk: Rect | null): Pick<UiElement, "x" | "y" | "w" | "h" | "desktop"> {
  const p = phone ?? OFF;
  return { x: p.x, y: p.y, w: p.w, h: p.h, desktop: desk ? box(desk.x, desk.y, desk.w, desk.h) : null };
}

const display = (family: string, cjk = "Noto Serif SC") => `"${family}", "${cjk}", serif`;
const CINZEL = display("Cinzel");
const CORMORANT = display("Cormorant Garamond");
const PLAYFAIR = display("Playfair Display");
const MONO = `"JetBrains Mono", "Noto Sans SC", monospace`;
const BEBAS = `"Bebas Neue", "Noto Sans SC", sans-serif`;
const ANTON = `"Anton", "Noto Sans SC", sans-serif`;
const TYPEWRITER = `"Special Elite", "Noto Serif SC", monospace`;
const HAND = `"Caveat", "Long Cang", cursive`;
const LORA = display("Lora");

interface GaugeLook {
  label?: Partial<UiTextStyle>;
  value?: Partial<UiTextStyle>;
  /** `{v}` is the variable; "{v} / 100" reads as a readout, "{v}" as a figure. */
  valueFormat?: string;
  trackH?: number;
  radius?: number;
  fills?: UiFill[];
  track?: UiFill[];
}

/** A meter with its label and value, grouped so they select and delete together. */
function gauge(
  id: string, label: string, variableId: string,
  phone: Spot | null, desk: Spot | null, look: GaugeLook = {},
): UiElement[] {
  const group = `g-${id}`;
  const valueW = look.valueFormat?.includes("/") ? 72 : 40;
  const trackH = look.trackH ?? 4;
  const at = (s: Spot | null, dy: number, h: number, dx = 0, w?: number): Rect | null =>
    s ? { x: s.x + dx, y: s.y + dy, w: w ?? s.w, h } : null;
  return [
    {
      id: `${id}-label`, group, type: "text",
      ...placed(at(phone, 0, 14, 0, phone ? phone.w - valueW : 0), at(desk, 0, 14, 0, desk ? desk.w - valueW : 0)),
      text: { template: label },
      style: { size: 11, desktopSize: 12, color: quietText, letterSpacing: 0.6, lineHeight: 1.15, nowrap: true, ...look.label },
    },
    {
      id: `${id}-value`, group, type: "text",
      ...placed(
        at(phone, -2, 16, phone ? phone.w - valueW : 0, valueW),
        at(desk, -2, 16, desk ? desk.w - valueW : 0, valueW),
      ),
      text: { template: (look.valueFormat ?? "{v}").replace("{v}", `{{${variableId}}}`) },
      style: { size: 13, desktopSize: 14, weight: 700, color: bodyText, align: "right", lineHeight: 1.05, nowrap: true, ...look.value },
    },
    {
      id, group, type: "meter",
      ...placed(at(phone, 20, trackH), at(desk, 20, trackH)),
      value: { kind: "variable", variableId, fallback: 50 },
      min: { kind: "literal", value: 0 },
      max: { kind: "literal", value: 100 },
      style: { track: look.track ?? METER_TRACK_FILLS, fills: look.fills ?? meterFillsFor(ACCENT), radius: look.radius ?? 999 },
    },
  ];
}

/** A text element. */
function words(
  id: string, template: string, phone: Rect | null, desk: Rect | null, style: UiTextStyle, extra: Partial<UiElement> = {},
): UiElement {
  return { id, type: "text", ...placed(phone, desk), text: { template }, style: { lineHeight: 1.15, ...style }, ...extra } as UiElement;
}

/** A box drawn under other parts. */
function ground(id: string, phone: Rect | null, desk: Rect | null, style: UiBoxStyle, css?: string, extra: Partial<UiElement> = {}): UiElement {
  return { id, type: "box", ...placed(phone, desk), style, ...(css ? { css } : {}), ...extra } as UiElement;
}

/** The roster on one row. */
function castRow(id: string, variableId: string, phone: Rect | null, desk: Rect | null, empty: string, text: UiTextStyle, gap = 20): UiElement {
  return {
    id, type: "list", ...placed(phone, desk),
    source: { kind: "variable", variableId },
    item: { template: "{{item}}" },
    direction: "row", gap, maxItems: 6,
    emptyText: { template: empty },
    textStyle: { size: 12, desktopSize: 13, nowrap: true, ...text },
  } as UiElement;
}

/** The roster in a column. */
function castColumn(id: string, variableId: string, phone: Rect | null, desk: Rect | null, empty: string, text: UiTextStyle, itemStyle?: UiBoxStyle): UiElement {
  return {
    id, type: "list", ...placed(phone, desk),
    source: { kind: "variable", variableId },
    item: { template: "{{item}}" },
    gap: 6, maxItems: 6,
    emptyText: { template: empty },
    textStyle: { size: 12, desktopSize: 13, ...text },
    ...(itemStyle ? { itemStyle } : {}),
  } as UiElement;
}

/** The button to the details page, with a per-layout style. */
function details(label: string, phone: Rect | null, desk: Rect | null, style?: Partial<UiButtonStyle>, css?: string): UiElement {
  const base = detailsButton(label, 0, 0, 0, 0, false);
  return {
    ...base,
    ...placed(phone, desk),
    ...(css ? { css: `${base.css ?? ""}${css}` } : {}),
    style: { ...(base.type === "button" ? base.style : {}), ...style },
  } as UiElement;
}

const pages = (input: UiTemplateInput, elements: UiElement[], withRoster: boolean) => doc(input, [
  { id: "page-1", name: "Main", height: PAGE_H, elements },
  listPage(input.strings, [
    { id: "tpl-d-list", title: input.strings.inventoryTitle!, variableId: input.variableIds.inventory!, empty: input.strings.inventoryEmpty! },
    ...(withRoster
      ? [{ id: "tpl-d-list-2", title: input.strings.rosterTitle!, variableId: input.variableIds.roster!, empty: input.strings.rosterEmpty! }]
      : []),
  ]),
]);

const fill = (strings: UiTemplateStrings, key: string, ids: UiTemplateVariableIds) => fillTemplateMacros(strings[key]!, ids);

/** Text colour on an accent fill (the theme pairs it with the send button). */
const ON_ACCENT = "var(--yc-send-fg, #1a1206)";

// ── 1. Chapter portrait (velvet) ─────────────────────────────────────────────
//
// Chapter ribbon across the top, portrait panel on the right with name, mood
// and three meters.

function chapterPortrait(input: UiTemplateInput): UiDoc {
  const { strings: s, variableIds: v } = input;
  const art = v.portrait!;
  const panelX = 704;
  const panelW = D_W - panelX;
  const inX = panelX + D_PAD;
  const inW = panelW - D_PAD * 2;
  const artH = 300;

  const elements: UiElement[] = [
    // Panel background first so the rest draws on top of it.
    ground("tpl-ground-panel", null, { x: panelX, y: 0, w: panelW, h: D_H },
      { fills: [{ kind: "color", color: "var(--yc-bg-solid, #150b10)" }] },
      "border-left: 1px solid var(--yc-chip-bg, rgba(255,255,255,0.08));"),
    ...artSlot("tpl-art-empty", "g-tpl-art", art, s.portraitEmpty!, null, { x: panelX, y: 0, w: panelW, h: artH }, { inset: 16 }),
    {
      id: "tpl-art-portrait", group: "g-tpl-art", type: "image", name: s.title,
      ...placed(null, { x: panelX, y: 0, w: panelW, h: artH }),
      fit: "cover", src: { kind: "variable", variableId: art },
      animation: { kind: "fade", durationMs: 420 },
    } as UiElement,
    ground("tpl-art-fade", null, { x: panelX, y: artH - 120, w: panelW, h: 120 },
      { fills: [{ kind: "gradient", angle: 180, stops: [
        { color: "rgba(0,0,0,0)", at: 0 }, { color: "var(--yc-bg-solid, #150b10)", at: 100 },
      ] }] }, undefined, { visibleWhen: { variableId: art, operator: "neq", value: "" } }),

    ground("tpl-chapter-ribbon", { x: PAD, y: 14, w: COL, h: 30 }, { x: D_PAD, y: 22, w: panelX - D_PAD * 2, h: 34 },
      { fills: [{ kind: "gradient", angle: 90, stops: [
        { color: "color-mix(in srgb, var(--yc-send-bg, #e39bb0) 82%, #000000)", at: 0 },
        { color: "var(--yc-send-bg, #e39bb0)", at: 50 },
        { color: "color-mix(in srgb, var(--yc-send-bg, #e39bb0) 70%, #f3d39a)", at: 100 },
      ] }] }, "border-radius: var(--yc-input-radius, 10px);", { group: "g-tpl-ribbon" }),
    words("tpl-ribbon-text", fill(s, "ribbonFormat", v), { x: PAD + 12, y: 21, w: COL - 24, h: 16 }, { x: D_PAD + 16, y: 31, w: panelX - D_PAD * 2 - 32, h: 16 },
      { size: 11, desktopSize: 13, weight: 700, color: ON_ACCENT, align: "center", letterSpacing: 2.4, transform: "uppercase", family: CINZEL, nowrap: true },
      { group: "g-tpl-ribbon" }),

    // Phone: a small portrait next to the name.
    ground("tpl-ground-card", { x: PAD, y: 54, w: COL, h: 124 }, null,
      { fills: [chipFill] }, "border-radius: var(--yc-input-radius, 12px);"),
    ...artSlot("tpl-art-thumb-empty", "g-tpl-art-thumb", art, "", { x: PAD + 10, y: 64, w: 78, h: 104 }, null, { inset: 0, compact: true }),
    {
      id: "tpl-art-thumb", group: "g-tpl-art-thumb", type: "image",
      ...placed({ x: PAD + 10, y: 64, w: 78, h: 104 }, null),
      fit: "cover", radius: 8, src: { kind: "variable", variableId: art },
    } as UiElement,

    words("tpl-name", s.title!, { x: PAD + 100, y: 66, w: COL - 182, h: 30 }, { x: inX, y: artH + 2, w: inW, h: 38 },
      { size: 22, desktopSize: 30, weight: 700, color: bodyText, family: CORMORANT, lineHeight: 1.1, nowrap: true }),
    words("tpl-mood", "{{" + v.mood + "}}", { x: PAD + 100, y: 98, w: COL - 112, h: 16 }, { x: inX, y: artH + 44, w: inW, h: 18 },
      { size: 12, desktopSize: 14, italic: true, color: ACCENT, family: CORMORANT, nowrap: true },
      { visibleWhen: { variableId: v.mood!, operator: "neq", value: "" } }),
    words("tpl-place", "{{" + v.location + "}}", null, { x: inX, y: artH + 66, w: inW, h: 16 },
      { size: 12, color: quietText, letterSpacing: 0.4, nowrap: true }),
    ...gauge("tpl-meter-1", s.meterPrimary!, v.affinity!, { x: PAD + 100, y: 126, w: 108 }, { x: inX, y: artH + 100, w: inW }),
    ...gauge("tpl-meter-2", s.meterSecondary!, v.stamina!, { x: PAD + 220, y: 126, w: COL - 232 }, { x: inX, y: artH + 144, w: inW }),
    ...gauge("tpl-meter-3", s.meterThird!, v.energy!, null, { x: inX, y: artH + 188, w: inW }),
    details(s.detailsOpen!, { x: UI_CANVAS_W - PAD - 70, y: 66, w: 60, h: 26 }, { x: inX, y: D_H - D_PAD - 32, w: inW, h: 32 }),
    ...conversation(s, 190, { x: 0, w: panelX, topY: 70, rule: false }),
  ];
  return pages(input, elements, false);
}

// ── 2. Masthead (harbor) ─────────────────────────────────────────────────────
//
// Title, four meters and the cast in a band across the top.

function masthead(input: UiTemplateInput): UiDoc {
  const { strings: s, variableIds: v } = input;
  const bandH = 192;
  const cellW = 224;
  const cellGap = Math.floor((D_W - D_PAD * 2 - cellW * 4) / 3);
  const cx = (i: number) => D_PAD + i * (cellW + cellGap);
  const readout = { valueFormat: "{v} / 100", value: { family: MONO, size: 12, desktopSize: 13 }, label: { family: MONO, transform: "uppercase" as const, letterSpacing: 1.2, size: 10, desktopSize: 11 }, radius: 0, trackH: 3 };
  const elements: UiElement[] = [
    ground("tpl-ground-band", { x: 0, y: 0, w: UI_CANVAS_W, h: 182 }, { x: 0, y: 0, w: D_W, h: bandH },
      { fills: [chipFill] }, "border-bottom: 1px solid var(--yc-chip-bg, rgba(255,255,255,0.10));"),
    words("tpl-masthead", s.title!, { x: PAD, y: 18, w: COL - 90, h: 28 }, { x: D_PAD, y: 24, w: 600, h: 36 },
      { size: 20, desktopSize: 28, weight: 700, color: bodyText, family: MONO, letterSpacing: 0.4, lineHeight: 1.1, nowrap: true }),
    details(s.detailsOpen!, { x: UI_CANVAS_W - PAD - 76, y: 18, w: 76, h: 28 }, { x: D_W - D_PAD - 96, y: 24, w: 96, h: 30 },
      { family: MONO, size: 11, letterSpacing: 1 }),
    words("tpl-sub", "{{" + v.phase + "}}", { x: PAD, y: 50, w: COL, h: 16 }, { x: D_PAD, y: 64, w: 600, h: 18 },
      { size: 12, desktopSize: 14, color: quietText, nowrap: true }),
    words("tpl-when", fill(s, "whenFormat", v), { x: PAD, y: 72, w: 190, h: 16 }, { x: 640, y: 66, w: 200, h: 16 },
      { size: 11, desktopSize: 12, color: chipText, family: MONO, nowrap: true }),
    words("tpl-gold", fill(s, "goldFormat", v), { x: PAD + 190, y: 72, w: COL - 190, h: 16 }, { x: 848, y: 66, w: D_W - D_PAD - 848, h: 16 },
      { size: 11, desktopSize: 12, color: ACCENT, family: MONO, align: "right", nowrap: true }),
    ground("tpl-ground-rule", { x: PAD, y: 96, w: COL, h: 1 }, { x: D_PAD, y: 96, w: D_W - D_PAD * 2, h: 1 }, { fills: [hairline] }),
    ...gauge("tpl-meter-1", s.meterPrimary!, v.stamina!, { x: PAD, y: 108, w: HALF_W }, { x: cx(0), y: 110, w: cellW }, readout),
    ...gauge("tpl-meter-2", s.meterSecondary!, v.energy!, { x: PAD + HALF_W + 13, y: 108, w: HALF_W }, { x: cx(1), y: 110, w: cellW }, readout),
    ...gauge("tpl-meter-3", s.meterThird!, v.affinity!, { x: PAD, y: 146, w: HALF_W }, { x: cx(2), y: 110, w: cellW }, readout),
    ...gauge("tpl-meter-4", s.meterFourth!, v.progress!, { x: PAD + HALF_W + 13, y: 146, w: HALF_W }, { x: cx(3), y: 110, w: cellW }, readout),
    words("tpl-cast-label", s.castLabel!, null, { x: D_PAD, y: 156, w: 72, h: 14 },
      { size: 10, desktopSize: 11, weight: 700, color: ACCENT, family: MONO, letterSpacing: 1.6, transform: "uppercase", nowrap: true }),
    castRow("tpl-cast", v.roster!, null, { x: D_PAD + 80, y: 152, w: D_W - D_PAD * 2 - 80, h: 24 }, s.rosterEmpty!,
      { color: chipText }, 26),
    ...conversation(s, 192, { x: 132, w: 760, topY: bandH + 14, rule: false,
      skin: { chip: { family: MONO, size: 11, desktopSize: 12, letterSpacing: 0.6 }, tool: { family: MONO } } }),
  ];
  return pages(input, elements, true);
}

// ── 3. Margin notes (linen) ──────────────────────────────────────────────────
//
// Light theme. Three note cards on the right: title, meters, roster.

function marginNotes(input: UiTemplateInput): UiDoc {
  const { strings: s, variableIds: v } = input;
  const nx = 716;
  const nw = D_W - 24 - nx;
  const ix = nx + 20;
  const iw = nw - 40;
  const paper: UiBoxStyle = {
    fills: [{ kind: "color", color: "var(--yc-input-bg, #fbfaf7)" }],
    shadows: [{ x: 0, y: 6, blur: 18, color: "rgba(30,20,40,0.10)" }],
  };
  const tilt = (deg: number) => `border-radius: 3px; transform: rotate(${deg}deg);`;
  const label: Partial<UiTextStyle> = { transform: "uppercase", letterSpacing: 1.4, size: 10, desktopSize: 11 };
  const elements: UiElement[] = [
    ground("tpl-ground-note-1", { x: PAD, y: 14, w: COL, h: 138 }, { x: nx, y: 28, w: nw, h: 150 }, paper, tilt(-0.6)),
    words("tpl-notes-title", s.title!, { x: PAD + 16, y: 28, w: COL - 120, h: 30 }, { x: ix, y: 44, w: iw, h: 36 },
      { size: 22, desktopSize: 28, weight: 700, color: bodyText, family: PLAYFAIR, lineHeight: 1.1, nowrap: true }),
    words("tpl-note-place", "{{" + v.location + "}}", { x: PAD + 16, y: 62, w: COL - 32, h: 18 }, { x: ix, y: 86, w: iw, h: 18 },
      { size: 13, desktopSize: 14, italic: true, color: quietText, family: PLAYFAIR, nowrap: true }),
    words("tpl-note-when", fill(s, "whenFormat", v), null, { x: ix, y: 108, w: iw, h: 16 },
      { size: 12, color: quietText, letterSpacing: 0.4, nowrap: true }),
    details(s.detailsOpen!, { x: UI_CANVAS_W - PAD - 16 - 76, y: 28, w: 76, h: 28 }, { x: ix, y: 136, w: 96, h: 28 }),
    ...gauge("tpl-meter-1", s.meterPrimary!, v.affinity!, { x: PAD + 16, y: 98, w: 146 }, { x: ix, y: 214, w: iw }, { label }),
    ...gauge("tpl-meter-2", s.meterSecondary!, v.stamina!, { x: PAD + 178, y: 98, w: COL - 194 }, { x: ix, y: 258, w: iw }, { label }),

    ground("tpl-ground-note-2", null, { x: nx, y: 194, w: nw, h: 210 }, paper, tilt(0.5)),
    ...gauge("tpl-meter-3", s.meterThird!, v.energy!, null, { x: ix, y: 302, w: iw }, { label }),
    ...gauge("tpl-meter-4", s.meterFourth!, v.progress!, null, { x: ix, y: 346, w: iw }, { label }),

    ground("tpl-ground-note-3", null, { x: nx, y: 420, w: nw, h: 192 }, paper, tilt(-0.4)),
    words("tpl-note-cast-title", s.rosterTitle!, null, { x: ix, y: 436, w: iw, h: 16 },
      { size: 11, weight: 700, color: ACCENT, letterSpacing: 1.4, transform: "uppercase", nowrap: true }),
    castColumn("tpl-note-cast", v.roster!, null, { x: ix, y: 460, w: iw, h: 138 }, s.rosterEmpty!,
      { color: bodyText, family: PLAYFAIR }),
    ...conversation(s, 164, { x: 0, w: 696, topY: 24, rule: false }),
  ];
  // On desktop meters 1 and 2 sit on the second card, so draw that card first.
  const n2 = elements.findIndex((el) => el.id === "tpl-ground-note-2");
  const [note2] = elements.splice(n2, 1);
  elements.splice(elements.findIndex((el) => el.id === "tpl-meter-1-label"), 0, note2!);
  return pages(input, elements, true);
}

// ── 4. Status strip (coolant) ────────────────────────────────────────────────
//
// Conversation on top; a strip below the composer with time, gold, place, two
// meters and the roster.

function statusStrip(input: UiTemplateInput): UiDoc {
  const { strings: s, variableIds: v } = input;
  const top = 470;
  const strip = { x: 0, y: top, w: D_W, h: D_H - top };
  const cellLabel: UiTextStyle = { size: 9, desktopSize: 10, color: quietText, family: MONO, letterSpacing: 1.4, transform: "uppercase", nowrap: true };
  const cellValue: UiTextStyle = { size: 14, desktopSize: 16, weight: 700, color: bodyText, family: MONO, nowrap: true, lineHeight: 1.05 };
  const cell = (id: string, label: string, template: string, phone: Spot | null, desk: Spot | null): UiElement[] => [
    words(`${id}-label`, label, phone && { ...phone, h: 12 }, desk && { ...desk, h: 12 }, cellLabel, { group: `g-${id}` }),
    words(id, template, phone && { x: phone.x, y: phone.y + 16, w: phone.w, h: 18 }, desk && { x: desk.x, y: desk.y + 16, w: desk.w, h: 20 }, cellValue, { group: `g-${id}` }),
  ];
  const meterLook: GaugeLook = { label: cellLabel, value: { family: MONO }, radius: 0, trackH: 4 };
  const elements: UiElement[] = [
    ground("tpl-ground-strip", { x: 0, y: 0, w: UI_CANVAS_W, h: 168 }, strip,
      { fills: [{ kind: "color", color: "var(--yc-input-bg, #0d1b20)" }] }, "border-top: 2px solid var(--yc-send-bg, #4fd1a5); border-bottom: 2px solid var(--yc-send-bg, #4fd1a5);"),
    words("tpl-strip", s.title!, { x: PAD, y: 14, w: COL - 92, h: 34 }, { x: D_PAD, y: top + 16, w: 330, h: 40 },
      { size: 30, desktopSize: 36, color: bodyText, family: BEBAS, letterSpacing: 1.2, transform: "uppercase", lineHeight: 1, nowrap: true }),
    words("tpl-strip-sub", "{{" + v.phase + "}}", { x: PAD, y: 50, w: COL, h: 16 }, { x: D_PAD + 346, y: top + 30, w: 520, h: 18 },
      { size: 12, desktopSize: 13, color: quietText, nowrap: true }),
    details(s.detailsOpen!, { x: UI_CANVAS_W - PAD - 76, y: 18, w: 76, h: 28 }, { x: D_W - D_PAD - 96, y: top + 22, w: 96, h: 30 },
      { family: MONO, size: 11, letterSpacing: 1 }),
    ...cell("tpl-cell-when", s.whenLabel!, fill(s, "whenFormat", v), { x: PAD, y: 76, w: 160 }, { x: D_PAD, y: top + 72, w: 190 }),
    ...cell("tpl-cell-gold", s.goldLabel!, "{{" + v.gold + "}}", { x: PAD + 176, y: 76, w: COL - 176 }, { x: D_PAD + 206, y: top + 72, w: 110 }),
    ...cell("tpl-cell-place", s.placeLabel!, "{{" + v.location + "}}", null, { x: D_PAD + 332, y: top + 72, w: 230 }),
    ...gauge("tpl-meter-1", s.meterPrimary!, v.stamina!, { x: PAD, y: 124, w: HALF_W }, { x: 600, y: top + 74, w: 178 }, meterLook),
    ...gauge("tpl-meter-2", s.meterSecondary!, v.energy!, { x: PAD + HALF_W + 13, y: 124, w: HALF_W }, { x: 794, y: top + 74, w: D_W - D_PAD - 794 }, meterLook),
    ground("tpl-ground-strip-rule", null, { x: D_PAD, y: top + 118, w: D_W - D_PAD * 2, h: 1 }, { fills: [hairline] }),
    words("tpl-cast-label", s.castLabel!, null, { x: D_PAD, y: top + 134, w: 70, h: 14 }, { ...cellLabel, color: ACCENT, weight: 700 }),
    castRow("tpl-cast", v.roster!, null, { x: D_PAD + 78, y: top + 130, w: D_W - D_PAD * 2 - 78, h: 22 }, s.rosterEmpty!,
      { color: chipText, family: MONO, size: 12 }, 24),
    ...conversation(s, 176, { x: 132, w: 760, topY: 16, rule: false, bottom: top - 8,
      skin: { chip: { family: MONO, size: 11, desktopSize: 12, letterSpacing: 0.8 }, tool: { family: MONO } } }),
  ];
  return pages(input, elements, true);
}

// ── 5. Night card (moss) ─────────────────────────────────────────────────────
//
// Large day counter top right, character card with four meters bottom right.

function nightCard(input: UiTemplateInput): UiDoc {
  const { strings: s, variableIds: v } = input;
  const cx = 728;
  const cw = D_W - 20 - cx;
  const ix = cx + 20;
  const iw = cw - 40;
  const cardY = 214;
  const look: GaugeLook = { valueFormat: "{v} / 100", value: { family: MONO, size: 11, desktopSize: 12, weight: 400 }, label: { family: MONO, size: 10, desktopSize: 11, letterSpacing: 0.4 }, trackH: 2, radius: 0 };
  const elements: UiElement[] = [
    words("tpl-clock", fill(s, "clockFormat", v), null, { x: ix, y: 44, w: iw, h: 56 },
      { size: 40, desktopSize: 46, weight: 400, color: bodyText, family: CORMORANT, lineHeight: 1.05, nowrap: true }),
    words("tpl-clock-time", "{{" + v.timeOfDay + "}}", null, { x: ix, y: 104, w: iw, h: 18 },
      { size: 12, desktopSize: 13, color: quietText, letterSpacing: 3, transform: "uppercase", nowrap: true }),
    ground("tpl-ground-clock-rule", null, { x: ix, y: 134, w: 36, h: 2 }, { fills: [{ kind: "color", color: ACCENT }] }),

    ground("tpl-ground-card", { x: PAD, y: 14, w: COL, h: 148 }, { x: cx, y: cardY, w: cw, h: D_H - 24 - cardY },
      { fills: [chipFill], borderColor: "var(--yc-chip-bg, rgba(255,255,255,0.10))", borderWidth: 1,
        shadows: [{ x: 0, y: 12, blur: 32, color: "rgba(0,0,0,0.35)" }] },
      "border-radius: var(--yc-input-radius, 8px);"),
    words("tpl-corner-name", s.title!, { x: PAD + 16, y: 26, w: COL - 120, h: 30 }, { x: ix, y: cardY + 18, w: iw, h: 36 },
      { size: 24, desktopSize: 30, weight: 600, color: bodyText, family: CORMORANT, lineHeight: 1.1, nowrap: true }),
    details(s.detailsOpen!, { x: UI_CANVAS_W - PAD - 16 - 76, y: 28, w: 76, h: 26 }, { x: ix, y: D_H - 24 - 18 - 28, w: 96, h: 28 }),
    words("tpl-corner-mood", "{{" + v.mood + "}}", { x: PAD + 16, y: 58, w: 150, h: 16 }, { x: ix, y: cardY + 56, w: iw, h: 16 },
      { size: 12, color: ACCENT, letterSpacing: 1, nowrap: true }, { visibleWhen: { variableId: v.mood!, operator: "neq", value: "" } }),
    words("tpl-corner-when", fill(s, "whenFormat", v), { x: PAD + 170, y: 58, w: COL - 186, h: 16 }, null,
      { size: 12, color: quietText, align: "right", nowrap: true }),
    words("tpl-corner-place", "{{" + v.location + "}}", null, { x: ix, y: cardY + 78, w: iw, h: 34 },
      { size: 13, italic: true, color: quietText, family: CORMORANT, lineHeight: 1.3 }),
    ...gauge("tpl-meter-1", s.meterPrimary!, v.affinity!, { x: PAD + 16, y: 90, w: 146 }, { x: ix, y: cardY + 122, w: iw }, look),
    ...gauge("tpl-meter-2", s.meterSecondary!, v.stamina!, { x: PAD + 177, y: 90, w: COL - 193 }, { x: ix, y: cardY + 160, w: iw }, look),
    ...gauge("tpl-meter-3", s.meterThird!, v.energy!, { x: PAD + 16, y: 124, w: 146 }, { x: ix, y: cardY + 198, w: iw }, look),
    ...gauge("tpl-meter-4", s.meterFourth!, v.progress!, { x: PAD + 177, y: 124, w: COL - 193 }, { x: ix, y: cardY + 236, w: iw }, look),
    words("tpl-corner-cast-title", s.rosterTitle!, null, { x: ix, y: cardY + 278, w: iw, h: 14 },
      { size: 10, desktopSize: 11, color: quietText, family: MONO, letterSpacing: 1.2, transform: "uppercase", nowrap: true }),
    castColumn("tpl-corner-cast", v.roster!, null, { x: ix, y: cardY + 298, w: iw, h: 50 }, s.rosterEmpty!,
      { color: bodyText, size: 12, nowrap: true }),
    ...conversation(s, 174, { x: 0, w: 712, topY: 24, rule: false }),
  ];
  return pages(input, elements, true);
}

// ── 6. Cassette (tape) ───────────────────────────────────────────────────────
//
// A strip under the composer: cassette with the card name, a track list with
// the current chapter, and a note with the mood.

function cassette(input: UiTemplateInput): UiDoc {
  const { strings: s, variableIds: v } = input;
  const top = 486;
  const shell: UiBoxStyle = {
    fills: [{ kind: "gradient", angle: 180, stops: [{ color: "#3b2b20", at: 0 }, { color: "#271b13", at: 100 }] }],
    borderColor: "rgba(255,255,255,0.08)", borderWidth: 1,
    shadows: [{ x: 0, y: 8, blur: 20, color: "rgba(0,0,0,0.45)" }],
  };
  const LABEL = "#efe2c8";
  const INK = "#2a1d12";
  const FADED = "#7a614a";
  const reel = (id: string, phone: Rect, desk: Rect): UiElement =>
    ground(id, phone, desk, { fills: [{ kind: "color", color: "#140d08" }], borderColor: "#d8c4a0", borderWidth: 5 },
      "border-radius: 999px;", { group: "g-tpl-cassette" });
  const paperInk: GaugeLook = {
    label: { color: FADED, family: TYPEWRITER, size: 10, desktopSize: 11 },
    value: { color: INK, family: TYPEWRITER },
    track: [{ kind: "color", color: "#2a1d121f" }],
    radius: 0, trackH: 4,
  };
  const elements: UiElement[] = [
    ground("tpl-ground-strip", { x: 0, y: 0, w: UI_CANVAS_W, h: 158 }, { x: 0, y: top, w: D_W, h: D_H - top },
      { fills: [{ kind: "color", color: "rgba(0,0,0,0.28)" }] }, "border-top: 1px solid var(--yc-chip-bg, rgba(255,255,255,0.08));"),

    ground("tpl-cassette", { x: PAD, y: 14, w: 156, h: 96 }, { x: D_PAD, y: top + 14, w: 236, h: 126 }, shell,
      "border-radius: 10px;", { group: "g-tpl-cassette" }),
    ground("tpl-cassette-label", { x: PAD + 8, y: 22, w: 140, h: 30 }, { x: D_PAD + 12, y: top + 24, w: 212, h: 44 },
      { fills: [{ kind: "color", color: LABEL }] }, "border-radius: 3px;", { group: "g-tpl-cassette" }),
    words("tpl-cassette-title", s.title!, { x: PAD + 14, y: 24, w: 128, h: 22 }, { x: D_PAD + 20, y: top + 26, w: 196, h: 26 },
      { size: 18, desktopSize: 22, weight: 700, color: INK, family: HAND, lineHeight: 1.1, nowrap: true }, { group: "g-tpl-cassette" }),
    words("tpl-cassette-side", fill(s, "sideFormat", v), null, { x: D_PAD + 20, y: top + 52, w: 196, h: 12 },
      { size: 10, color: FADED, family: TYPEWRITER, nowrap: true }, { group: "g-tpl-cassette" }),
    reel("tpl-reel-1", { x: PAD + 30, y: 64, w: 30, h: 30 }, { x: D_PAD + 46, y: top + 80, w: 44, h: 44 }),
    ground("tpl-reel-window", { x: PAD + 64, y: 74, w: 28, h: 10 }, { x: D_PAD + 96, y: top + 94, w: 44, h: 16 },
      { fills: [{ kind: "color", color: "#120b07" }] }, "border-radius: 3px;", { group: "g-tpl-cassette" }),
    reel("tpl-reel-2", { x: PAD + 96, y: 64, w: 30, h: 30 }, { x: D_PAD + 146, y: top + 80, w: 44, h: 44 }),

    ground("tpl-ground-tracks", null, { x: 284, y: top + 14, w: 400, h: 126 }, { fills: [{ kind: "color", color: LABEL }] }, "border-radius: 4px;"),
    words("tpl-tracks-head", fill(s, "sideFormat", v), null, { x: 300, y: top + 24, w: 368, h: 14 },
      { size: 10, desktopSize: 11, color: FADED, family: TYPEWRITER, letterSpacing: 1, nowrap: true }),
    ground("tpl-track-now-bg", { x: PAD + 168, y: 14, w: COL - 168, h: 24 }, { x: 292, y: top + 42, w: 384, h: 26 },
      { fills: [{ kind: "color", color: ACCENT }] }, "border-radius: 3px;", { group: "g-tpl-track-now" }),
    words("tpl-track-now", "▶ {{" + v.phase + "}}", { x: PAD + 176, y: 18, w: COL - 184, h: 16 }, { x: 302, y: top + 46, w: 364, h: 18 },
      { size: 12, desktopSize: 13, weight: 700, color: ON_ACCENT, family: TYPEWRITER, nowrap: true }, { group: "g-tpl-track-now" }),
    words("tpl-track-where", fill(s, "whereFormat", v), null, { x: 302, y: top + 74, w: 364, h: 16 },
      { size: 12, color: INK, family: TYPEWRITER, nowrap: true }),
    words("tpl-track-where-strip", fill(s, "whereFormat", v), { x: PAD + 168, y: 44, w: COL - 168, h: 16 }, null,
      { size: 11, color: chipText, family: TYPEWRITER, nowrap: true }),
    // Two copies of the meter: dark text on paper (desktop), theme text on the
    // strip (phone). One element can only have one text colour.
    ...gauge("tpl-meter-1", s.meterPrimary!, v.affinity!, null, { x: 302, y: top + 100, w: 364 }, paperInk),
    ...gauge("tpl-meter-1-strip", s.meterPrimary!, v.affinity!, { x: PAD, y: 124, w: COL }, null,
      { label: { family: TYPEWRITER, size: 10 }, value: { family: TYPEWRITER }, radius: 0, trackH: 4 }),

    ground("tpl-ground-note", null, { x: 700, y: top + 16, w: D_W - D_PAD - 700, h: 122 },
      { fills: [{ kind: "color", color: "#f6eedd" }], shadows: [{ x: 0, y: 6, blur: 14, color: "rgba(0,0,0,0.35)" }] },
      "border-radius: 2px; transform: rotate(0.8deg);"),
    words("tpl-note-head", s.noteTitle!, null, { x: 716, y: top + 28, w: D_W - D_PAD - 732, h: 14 },
      { size: 10, desktopSize: 11, color: FADED, family: TYPEWRITER, letterSpacing: 1, transform: "uppercase", nowrap: true }),
    words("tpl-note-mood", "{{" + v.mood + "}}", { x: PAD + 168, y: 66, w: COL - 168 - 84, h: 24 }, { x: 716, y: top + 48, w: D_W - D_PAD - 732, h: 30 },
      { size: 20, desktopSize: 26, weight: 700, color: ACCENT, family: HAND, lineHeight: 1.1, nowrap: true }),
    details(s.detailsOpen!, { x: UI_CANVAS_W - PAD - 76, y: 66, w: 76, h: 26 }, { x: 716, y: top + 96, w: 100, h: 28 },
      { family: TYPEWRITER, size: 11, fills: [{ kind: "color", color: LABEL }], textColor: INK, borderColor: "#2a1d1240", borderWidth: 1, shadows: [] }),
    ...conversation(s, 168, { x: 132, w: 760, topY: 16, rule: false, bottom: top - 6,
      skin: { chip: { family: TYPEWRITER, size: 12, desktopSize: 13 }, tool: { family: TYPEWRITER } } }),
  ];
  return pages(input, elements, false);
}

// ── 7. Art split (gilded) ────────────────────────────────────────────────────
//
// Portrait on the right half; title and two meters over its bottom.

function artSplit(input: UiTemplateInput): UiDoc {
  const { strings: s, variableIds: v } = input;
  const art = v.portrait!;
  const ax = 560;
  const aw = D_W - ax;
  // Tall enough that the title and meters fit on the darkened bottom of the
  // art on the phone too, so they use the same text colours on both canvases.
  const artPhoneH = 340;
  const capText = "#f3e9d6";
  const capQuiet = "#d6c8ae";
  const onArt: GaugeLook = {
    label: { color: capQuiet, letterSpacing: 1.2, transform: "uppercase", size: 10, desktopSize: 11 },
    value: { color: capText },
    track: [{ kind: "color", color: "rgba(0,0,0,0.35)" }, { kind: "color", color: "rgba(255,255,255,0.12)" }],
    trackH: 3,
  };
  const elements: UiElement[] = [
    ...artSlot("tpl-art-empty", "g-tpl-art", art, s.portraitEmpty!,
      { x: 0, y: 0, w: UI_CANVAS_W, h: artPhoneH - 110 }, { x: ax, y: 0, w: aw, h: D_H - 190 }, { inset: 16 }),
    {
      id: "tpl-art-split", group: "g-tpl-art", type: "image", name: s.title,
      ...placed({ x: 0, y: 0, w: UI_CANVAS_W, h: artPhoneH }, { x: ax, y: 0, w: aw, h: D_H }),
      fit: "cover", src: { kind: "variable", variableId: art },
      animation: { kind: "fade", durationMs: 520 },
    } as UiElement,
    // Fade the art into the page on the left; darken its bottom for the title.
    ground("tpl-art-fade-side", null, { x: ax, y: 0, w: 200, h: D_H },
      { fills: [{ kind: "gradient", angle: 90, stops: [
        { color: "var(--yc-bg-solid, #0d0a08)", at: 0 }, { color: "rgba(0,0,0,0)", at: 100 },
      ] }] }),
    ground("tpl-art-foot", { x: 0, y: artPhoneH - 170, w: UI_CANVAS_W, h: 170 }, { x: ax, y: D_H - 300, w: aw, h: 300 },
      { fills: [{ kind: "gradient", angle: 180, stops: [
        { color: "rgba(0,0,0,0)", at: 0 }, { color: "rgba(0,0,0,0.62)", at: 38 }, { color: "rgba(0,0,0,0.86)", at: 72 }, { color: "rgba(0,0,0,0.9)", at: 100 },
      ] }] }),
    {
      ...detailsButton(s.detailsOpen!, UI_CANVAS_W - PAD - 76, 18, 76, 30, true),
      desktop: box(D_W - D_PAD - 96, D_PAD, 96, 30),
    },
    ground("tpl-place-chip", { x: PAD, y: 18, w: 150, h: 30 }, { x: ax + D_PAD, y: D_PAD, w: 190, h: 30 },
      { fills: [GLASS_FILL], backdropBlur: 8, borderColor: "rgba(255,255,255,0.16)", borderWidth: 1 },
      "border-radius: var(--yc-send-radius, 999px);",
      { group: "g-tpl-place-chip", visibleWhen: { variableId: v.location!, operator: "neq", value: "" } }),
    words("tpl-place-text", "{{" + v.location + "}}", { x: PAD + 10, y: 26, w: 130, h: 16 }, { x: ax + D_PAD + 12, y: D_PAD + 8, w: 166, h: 16 },
      { size: 11, align: "center", color: capText, letterSpacing: 0.4, nowrap: true },
      { group: "g-tpl-place-chip", visibleWhen: { variableId: v.location!, operator: "neq", value: "" } }),
    words("tpl-split-title", s.title!, { x: PAD, y: artPhoneH - 108, w: COL, h: 34 }, { x: ax + 40, y: D_H - 176, w: aw - 80, h: 42 },
      { size: 24, desktopSize: 32, weight: 700, color: ACCENT, family: CINZEL, align: "center", letterSpacing: 1.5, lineHeight: 1.1, nowrap: true,
        textShadow: { x: 0, y: 2, blur: 14, color: "rgba(0,0,0,0.85)" } }),
    words("tpl-split-sub", "{{" + v.phase + "}}", { x: PAD, y: artPhoneH - 72, w: COL, h: 16 }, { x: ax + 40, y: D_H - 130, w: aw - 80, h: 18 },
      { size: 12, desktopSize: 14, italic: true, color: capQuiet, family: CORMORANT, align: "center", nowrap: true }),
    ...gauge("tpl-meter-1", s.meterPrimary!, v.affinity!, { x: PAD + 24, y: artPhoneH - 40, w: 140 }, { x: ax + 40, y: D_H - 88, w: 180 }, onArt),
    ...gauge("tpl-meter-2", s.meterSecondary!, v.stamina!, { x: UI_CANVAS_W - PAD - 24 - 140, y: artPhoneH - 40, w: 140 }, { x: D_W - 40 - 180, y: D_H - 88, w: 180 }, onArt),
    ...conversation(s, artPhoneH + 8, { x: 0, w: ax, topY: 24, rule: false }),
  ];
  return pages(input, elements, true);
}

// ── 8. Guild card (tavern) ───────────────────────────────────────────────────
//
// Parchment card on the left with the player's name, class, rank, gold and
// two meters.

function guildCard(input: UiTemplateInput): UiDoc {
  const { strings: s, variableIds: v } = input;
  const PARCHMENT = "#efe4cc";
  const INK = "#2b2116";
  const FADED = "#7d6a4c";
  const BAND = "#2f5a43";
  const ON_BAND = "#f3ead2";
  const cardX = D_PAD;
  const cardW = 320;
  const ix = cardX + 18;
  const iw = cardW - 36;
  const fieldLabel: UiTextStyle = { size: 9, desktopSize: 10, weight: 700, color: FADED, letterSpacing: 1.6, transform: "uppercase", nowrap: true };
  const fieldValue: UiTextStyle = { size: 15, desktopSize: 18, color: INK, family: LORA, nowrap: true, lineHeight: 1.1 };
  const field = (id: string, label: string, template: string, phone: Spot, desk: Spot): UiElement[] => [
    words(`${id}-label`, label, { ...phone, h: 12 }, { ...desk, h: 12 }, fieldLabel, { group: `g-${id}` }),
    words(id, template, { x: phone.x, y: phone.y + 14, w: phone.w, h: 20 }, { x: desk.x, y: desk.y + 16, w: desk.w, h: 24 }, fieldValue, { group: `g-${id}` }),
    ground(`${id}-rule`, null, { x: desk.x, y: desk.y + 42, w: desk.w, h: 1 }, { fills: [{ kind: "color", color: "#2b211624" }] }, undefined, { group: `g-${id}` }),
  ];
  const inkGauge: GaugeLook = {
    label: { ...fieldLabel },
    value: { color: INK, family: LORA },
    fills: [{ kind: "color", color: BAND }],
    track: [{ kind: "color", color: "#2b21161f" }],
    radius: 2, trackH: 5,
  };
  const elements: UiElement[] = [
    ground("tpl-ground-parchment", { x: PAD, y: 14, w: COL, h: 190 }, { x: cardX, y: D_PAD, w: cardW, h: D_H - D_PAD * 2 },
      { fills: [
        { kind: "gradient", angle: 160, stops: [{ color: "rgba(255,250,235,0.18)", at: 0 }, { color: "rgba(120,90,40,0.10)", at: 100 }] },
        { kind: "color", color: PARCHMENT },
      ], shadows: [{ x: 0, y: 14, blur: 34, color: "rgba(0,0,0,0.45)" }] },
      "border-radius: 6px;"),
    ground("tpl-guild-band", { x: PAD, y: 14, w: COL, h: 40 }, { x: cardX, y: D_PAD, w: cardW, h: 58 },
      { fills: [{ kind: "color", color: BAND }] }, "border-radius: 6px 6px 0 0;", { group: "g-tpl-guild-band" }),
    words("tpl-guild-head", s.guildTitle!, { x: PAD + 14, y: 22, w: COL - 120, h: 26 }, { x: ix, y: D_PAD + 14, w: iw, h: 32 },
      { size: 20, desktopSize: 26, color: ON_BAND, family: ANTON, letterSpacing: 1.4, transform: "uppercase", lineHeight: 1, nowrap: true },
      { group: "g-tpl-guild-band" }),
    details(s.detailsOpen!, { x: UI_CANVAS_W - PAD - 10 - 76, y: 20, w: 76, h: 28 }, { x: ix, y: D_H - D_PAD - 18 - 34, w: iw, h: 34 },
      { fills: [{ kind: "color", color: BAND }], textColor: ON_BAND, borderColor: "rgba(255,255,255,0.18)", borderWidth: 1, shadows: [], family: LORA, size: 12, desktopSize: 14 }),
    words("tpl-guild-sub", fill(s, "guildSubFormat", v), null, { x: ix, y: D_PAD + 72, w: iw, h: 18 },
      { size: 13, italic: true, color: FADED, family: LORA, nowrap: true }),
    ...field("tpl-guild-name", s.nameLabel!, "{{" + v.playerName + "}}", { x: PAD + 14, y: 64, w: 150 }, { x: ix, y: D_PAD + 104, w: iw }),
    ...field("tpl-guild-role", s.roleLabel!, "{{" + v.playerRole + "}}", { x: PAD + 176, y: 64, w: COL - 190 }, { x: ix, y: D_PAD + 158, w: iw }),
    ...field("tpl-guild-rank", s.rankLabel!, "{{" + v.rank + "}}", { x: PAD + 14, y: 106, w: 150 }, { x: ix, y: D_PAD + 212, w: iw }),
    ...field("tpl-guild-gold", s.goldLabel!, "{{" + v.gold + "}}", { x: PAD + 176, y: 106, w: COL - 190 }, { x: ix, y: D_PAD + 266, w: iw }),
    ...gauge("tpl-meter-1", s.meterPrimary!, v.stamina!, { x: PAD + 14, y: 154, w: 150 }, { x: ix, y: D_PAD + 334, w: iw }, inkGauge),
    ...gauge("tpl-meter-2", s.meterSecondary!, v.energy!, { x: PAD + 176, y: 154, w: COL - 190 }, { x: ix, y: D_PAD + 380, w: iw }, inkGauge),
    words("tpl-guild-cast-title", s.rosterTitle!, null, { x: ix, y: D_PAD + 430, w: iw, h: 12 }, fieldLabel),
    castColumn("tpl-guild-cast", v.roster!, null, { x: ix, y: D_PAD + 448, w: iw, h: 72 }, s.rosterEmpty!,
      { color: INK, family: LORA, size: 13, nowrap: true }),
    ...conversation(s, 216, { x: cardX + cardW + 8, w: D_W - cardX - cardW - 8, topY: D_PAD, rule: false }),
  ];
  return pages(input, elements, true);
}

// ── The set ──────────────────────────────────────────────────────────────────

export const SHOWCASE_TEMPLATES: UiTemplatePreset[] = [
  {
    id: "chapter-portrait",
    signature: "tpl-chapter-ribbon",
    look: { id: "velvet" },
    needs: [NEED.portrait, NEED.phase, NEED.mood, NEED.location, NEED.affinity, NEED.stamina, NEED.energy, NEED.inventory],
    stringKeys: ["portraitEmpty", "ribbonFormat", "meterPrimary", "meterSecondary", "meterThird", ...DETAIL_KEYS, ...OPENER_KEYS, ...TOOL_KEYS],
    build: chapterPortrait,
  },
  {
    id: "masthead",
    signature: "tpl-masthead",
    look: { id: "harbor" },
    needs: [NEED.phase, NEED.day, NEED.timeOfDay, NEED.gold, NEED.stamina, NEED.energy, NEED.affinity, NEED.progress, NEED.roster, NEED.inventory],
    stringKeys: ["whenFormat", "goldFormat", "castLabel", "meterPrimary", "meterSecondary", "meterThird", "meterFourth",
      ...DETAIL_KEYS, ...ROSTER_KEYS, ...OPENER_KEYS, ...TOOL_KEYS],
    build: masthead,
  },
  {
    id: "margin-notes",
    signature: "tpl-notes-title",
    look: { id: "linen" },
    needs: [NEED.location, NEED.day, NEED.timeOfDay, NEED.affinity, NEED.stamina, NEED.energy, NEED.progress, NEED.roster, NEED.inventory],
    stringKeys: ["whenFormat", "meterPrimary", "meterSecondary", "meterThird", "meterFourth",
      ...DETAIL_KEYS, ...ROSTER_KEYS, ...OPENER_KEYS, ...TOOL_KEYS],
    build: marginNotes,
  },
  {
    id: "status-strip",
    signature: "tpl-strip",
    look: { id: "coolant" },
    needs: [NEED.phase, NEED.location, NEED.day, NEED.timeOfDay, NEED.gold, NEED.stamina, NEED.energy, NEED.roster, NEED.inventory],
    stringKeys: ["whenLabel", "whenFormat", "goldLabel", "placeLabel", "castLabel", "meterPrimary", "meterSecondary",
      ...DETAIL_KEYS, ...ROSTER_KEYS, ...OPENER_KEYS, ...TOOL_KEYS],
    build: statusStrip,
  },
  {
    id: "night-card",
    signature: "tpl-corner-name",
    look: { id: "moss" },
    needs: [NEED.mood, NEED.location, NEED.day, NEED.timeOfDay, NEED.affinity, NEED.stamina, NEED.energy, NEED.progress, NEED.roster, NEED.inventory],
    stringKeys: ["clockFormat", "whenFormat", "meterPrimary", "meterSecondary", "meterThird", "meterFourth",
      ...DETAIL_KEYS, ...ROSTER_KEYS, ...OPENER_KEYS, ...TOOL_KEYS],
    build: nightCard,
  },
  {
    id: "cassette",
    signature: "tpl-cassette",
    look: { id: "tape" },
    needs: [NEED.phase, NEED.mood, NEED.location, NEED.day, NEED.timeOfDay, NEED.affinity, NEED.inventory],
    stringKeys: ["sideFormat", "whereFormat", "noteTitle", "meterPrimary", ...DETAIL_KEYS, ...OPENER_KEYS, ...TOOL_KEYS],
    build: cassette,
  },
  {
    id: "art-split",
    signature: "tpl-art-split",
    look: { id: "gilded" },
    needs: [NEED.portrait, NEED.phase, NEED.location, NEED.affinity, NEED.stamina, NEED.roster, NEED.inventory],
    stringKeys: ["portraitEmpty", "meterPrimary", "meterSecondary", ...DETAIL_KEYS, ...ROSTER_KEYS, ...OPENER_KEYS, ...TOOL_KEYS],
    build: artSplit,
  },
  {
    id: "guild-card",
    signature: "tpl-guild-band",
    look: { id: "tavern" },
    needs: [NEED.playerName, NEED.playerRole, NEED.rank, NEED.location, NEED.gold, NEED.stamina, NEED.energy, NEED.roster, NEED.inventory],
    stringKeys: ["guildTitle", "guildSubFormat", "nameLabel", "roleLabel", "rankLabel", "goldLabel", "meterPrimary", "meterSecondary",
      ...DETAIL_KEYS, ...ROSTER_KEYS, ...OPENER_KEYS, ...TOOL_KEYS],
    build: guildCard,
  },
];
