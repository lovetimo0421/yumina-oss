import type { UiDoc, UiElement } from "./types.js";
import { LIT_EDGE } from "./edit.js";
import {
  COL, D_H, D_PAD, D_W, DETAIL_KEYS, HALF_W, METER_BLOCK_H, METER_GAP, NEED, OPENER_KEYS, PAD,
  PAGE_H, ROSTER_KEYS, TOOL_KEYS, UI_CANVAS_W, GLASS_FILL, GLASS_TEXT, CONTROL_RADIUS, bodyText, box, conversation,
  artSlot, chipFill, detailsButton, doc, fillTemplateMacros, listPage, meter, quietText, readout,
} from "./layout-kit.js";
import type { UiTemplateInput, UiTemplatePreset } from "./layout-kit.js";
import { SHOWCASE_TEMPLATES } from "./showcase-layouts.js";

export { fillTemplateMacros } from "./layout-kit.js";
export type { UiTemplateInput, UiTemplateNeed, UiTemplatePreset, UiTemplateStrings, UiTemplateVariableIds } from "./layout-kit.js";


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
    // Placeholder shown while the portrait variable is empty.
    ...artSlot("tpl-portrait-empty", "g-tpl-portrait", art, strings.portraitEmpty!,
      { x: 0, y: 0, w: UI_CANVAS_W, h: ART_H }, { x: 0, y: 0, w: artW, h: D_H }),
    {
      id: "tpl-portrait",
      group: "g-tpl-portrait",
      name: strings.title,
      type: "image",
      x: 0, y: 0, w: UI_CANVAS_W, h: ART_H,
      desktop: box(0, 0, artW, D_H),
      fit: "cover",
      // Bound to a variable so behaviors can swap it mid-story. Starts empty;
      // the image panel's picker writes the chosen picture into the variable.
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
  ...SHOWCASE_TEMPLATES,
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
