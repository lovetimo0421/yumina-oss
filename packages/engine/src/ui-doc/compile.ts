import { readableThemeTokens } from "./contrast.js";
import { planInk } from "./ink.js";
import type { InkPlan } from "./ink.js";
import { buildUiTheme } from "./themes.js";
import type { Condition } from "../types/index.js";
import { fitFontWeight, fontWeightsOf, webFontsHref } from "./fonts.js";
import {
  UI_CANVAS_W,
  UI_DESKTOP_H,
  UI_DESKTOP_W,
  UI_CHAT_STARTED,
  buttonActionsOf,
  type UiAction,
  type UiDoc,
  type UiElement,
  type UiFill,
  type UiImageSrc,
  type UiNumber,
  type UiPage,
  type UiRadius,
  type UiShadow,
  type UiText,
  type UiTextStyle,
} from "./types.js";
import { PARTS_CSS, PARTS_RUNTIME } from "./compile-parts.js";
import { hasMessageDesign } from "./message-rules.js";
import { withDesktopConversation } from "./desktop-conversation.js";

/**
 * uiDoc → TSX.
 *
 * The doc is the source of truth; this turns it into the thing the sandbox
 * already knows how to run, so the interface builder needs no renderer of its
 * own. Everything downstream — the shadow-root host, the board's live preview,
 * the save-time precompile, the asset resolution — keeps working unchanged
 * because the output is an ordinary card frontend.
 *
 * Three rules govern what comes out:
 *
 * 1. **Real JSX, not an interpreter.** Emitting a data blob plus a generic
 *    walker would be shorter and easier to get right, but "export to code" is
 *    the promised escape hatch, and handing someone a JSON array is not
 *    handing them their code. Every element compiles to the element it is.
 *
 * 2. **Deterministic.** Same doc, same string, byte for byte — nothing here
 *    reads a clock or a random, and every map that could iterate in insertion
 *    order (style tokens) is sorted first. Save-time stamps
 *    `compiled.filesHash`, and a hash that changed because the compiler felt
 *    like it would recompile every card on every save.
 *
 * 3. **A doc is data — with two declared exceptions.** Every creator string
 *    reaches the output through `JSON.stringify`, so no value in the document
 *    can become code. The exceptions are `theme.css` / `element.css`, which are
 *    stylesheets by definition, and `custom.code`, which is a block of TSX the
 *    creator wrote on purpose. Neither grants anything that writing the card's
 *    `rootComponent` by hand did not already grant, and both land inside the
 *    same sandbox that has always contained hand-written card frontends.
 *
 * The generated body runs inside `new Function(React, useYumina, ..., Chat,
 * MessageList, MessageInput, useAssetFont, ...)`, so it may not use bare hooks
 * (`React.useState`, never `useState`) and may not import anything.
 */

const GENERATED_HEADER = `/**
 * Generated from this card's interface document. Edit the interface, not this
 * file — regenerating overwrites it. "Export to code" hands you ownership and
 * stops the regeneration.
 */`;

/** JS string literal, escaping included. */
const s = (value: string) => JSON.stringify(value);

/** A number the emitter is sure about — guards against NaN slipping into style. */
const n = (value: number | undefined, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Quoted only when it has to be. Custom properties (`--yc-input-bg`) are not
 *  identifiers and would be a syntax error bare; everything else stays
 *  unquoted, because the generated file is what "export to code" hands over
 *  and reads worse with every key in quotes. */
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Later pairs override earlier ones, which is what a JS object literal does
 * anyway — the difference is that the duplicate never reaches the output.
 * Emitters layer a shared base (a box's paint) under their own defaults, so
 * `background` legitimately arrives twice; writing both is harmless and reads
 * like a bug, and this file's product is code somebody may take ownership of.
 * The first occurrence keeps its position so the emitted order stays stable.
 */
function styleObject(pairs: Array<[string, string | number | undefined]>): string {
  const order: string[] = [];
  const seen = new Map<string, string | number>();
  for (const [k, v] of pairs) {
    if (v === undefined || v === "") continue;
    if (!seen.has(k)) order.push(k);
    seen.set(k, v);
  }
  // "..." is a spread, not a property — how an element's geometry arrives as
  // one call instead of four keys that would each need a conditional.
  const body = order
    .map((k) => (k === "..." ? `...${seen.get(k)}` : `${IDENT.test(k) ? k : JSON.stringify(k)}: ${seen.get(k)}`))
    .join(", ");
  return `{ ${body} }`;
}

/** `{{id}}` interpolation is resolved at runtime, so the template travels as a
 *  literal and the helper does the lookup against live variables. */
function textExpr(text: UiText | undefined): string {
  return `interpolate(vars, ${s(text?.template ?? "")})`;
}

function numberExpr(value: UiNumber | undefined, fallback = 0): string {
  if (!value) return String(fallback);
  if (value.kind === "literal") return String(n(value.value, fallback));
  return `readNumber(vars, ${s(value.variableId)}, ${n(value.fallback, fallback)})`;
}

function imageExpr(src: UiImageSrc | undefined): string {
  if (!src) return "null";
  // Unbound stays null at compile time rather than trusting every sandbox's
  // resolveAssetUrl to map "" to something falsy — an <img src=""> would
  // request the page itself.
  if (src.kind === "asset") return src.ref === "" ? "null" : `api.resolveAssetUrl(${s(src.ref)})`;
  // A variable holding a ref: the value may already be a resolved URL or an
  // "@asset:" ref, and resolveAssetUrl passes plain URLs through untouched.
  return `resolveMaybe(api, vars, ${s(src.variableId)}, ${s(src.fallback ?? "")})`;
}

/** Conditions compile to the comparison they are, inline, rather than to a
 *  call into a rules interpreter — same reason the elements do.
 *
 *  `?? null` is not defensive noise. A condition whose `value` is missing makes
 *  `JSON.stringify` return the *value* undefined, which emits a literal
 *  `JSON.parse(undefined)` into the card and throws on first render. The schema
 *  forbids that shape; persisted JSON does not care what the schema forbids. */
function conditionExpr(cond: Condition): string {
  // "Has the player said anything yet" is read off the live message list, not
  // the variable bag — see UI_CHAT_STARTED.
  const left = cond.variableId === UI_CHAT_STARTED ? "chatStarted(api)" : `readVar(vars, ${s(cond.variableId ?? "")})`;
  const right = cond.valueRef ? `readVar(vars, ${s(cond.valueRef)})` : s(JSON.stringify(cond.value ?? null));
  const rightValue = cond.valueRef ? right : `JSON.parse(${right})`;
  switch (cond.operator) {
    case "eq":
      return `looseEq(${left}, ${rightValue})`;
    case "neq":
      return `!looseEq(${left}, ${rightValue})`;
    case "gt":
      return `Number(${left}) > Number(${rightValue})`;
    case "gte":
      return `Number(${left}) >= Number(${rightValue})`;
    case "lt":
      return `Number(${left}) < Number(${rightValue})`;
    case "lte":
      return `Number(${left}) <= Number(${rightValue})`;
    case "contains":
      return `contains(${left}, ${rightValue})`;
    default:
      return "true";
  }
}

/** A creator-authored value as a JS literal. Numbers, strings, booleans and
 *  null all round-trip through JSON.stringify into valid, inert JS — which is
 *  also the escaping boundary this compiler leans on everywhere: a doc is
 *  data, and no string in it may become code. */
function literal(value: number | string | boolean | null | undefined): string {
  if (value === undefined) return "null";
  return JSON.stringify(value);
}

// ── Paint ──────────────────────────────────────────────────────────────────

function radiusCss(radius: UiRadius | undefined): string | undefined {
  if (radius === undefined) return undefined;
  if (Array.isArray(radius)) return s(radius.map((r) => `${n(r)}px`).join(" "));
  return String(n(radius));
}

function shadowsCss(shadows: UiShadow[] | undefined): string | undefined {
  if (!shadows || shadows.length === 0) return undefined;
  const parts = shadows.map((sh) => {
    const spread = sh.spread === undefined ? "" : ` ${n(sh.spread)}px`;
    return `${sh.inset ? "inset " : ""}${n(sh.x)}px ${n(sh.y)}px ${n(sh.blur)}px${spread} ${sh.color}`;
  });
  return s(parts.join(", "));
}

/** One background layer as a JS expression. Colour and gradient resolve at
 *  compile time; an image cannot, because its URL comes from an asset ref or a
 *  live variable. */
function fillLayerExpr(fill: UiFill): string {
  switch (fill.kind) {
    case "color":
      return s(fill.color);
    case "gradient": {
      const angle = n(fill.angle, 180);
      const stops = (fill.stops ?? []).filter((st) => st && typeof st.color === "string");
      // A gradient needs two ends. One or none is not a paintable layer, and
      // emitting `linear-gradient(180deg, )` would take the whole background
      // declaration down with it.
      if (stops.length < 2) return "null";
      return s(`linear-gradient(${angle}deg, ${stops.map((st) => `${st.color} ${n(st.at)}%`).join(", ")})`);
    }
    case "image":
      return `imageLayer(${imageExpr(fill.src)}, ${s(fill.fit ?? "cover")}, ${fill.repeat ? "true" : "false"})`;
    default:
      return "null";
  }
}

/** The whole stack as one `background` value. Index 0 paints on top, matching
 *  the CSS shorthand, so the emitted order is the doc order. */
function fillsExpr(fills: UiFill[] | undefined): string | undefined {
  if (!fills || fills.length === 0) return undefined;
  return `bg([${fills.map(fillLayerExpr).join(", ")}])`;
}

interface Ctx {
  /** family name → index into the generated `__font<i>` constants. */
  fonts: Map<string, number>;
}

/** A font is either one this doc loads (and then it is the resolved,
 *  asset-scoped family the hook handed back) or a raw stack the creator typed. */
function familyExpr(family: string | undefined, ctx: Ctx): string | undefined {
  if (!family) return undefined;
  const index = ctx.fonts.get(family);
  return index === undefined ? s(family) : `fonts[${index}]`;
}

/**
 * A weight the font can really draw. A curated web font ships a few faces
 * (a display face often only 400); asking it for 700 made the browser smear
 * the 400 face into a fake bold. So the weight snaps to the nearest face the
 * font has, and `fontSynthesisWeight: none` stops the smear for the weights a
 * class rule sets (a part's title) that never pass through here.
 */
function weightExpr(family: string | undefined, weight: number | undefined, fallback: number | undefined): string | undefined {
  if (weight === undefined && fallback === undefined) return undefined;
  return String(fitFontWeight(family, n(weight, fallback ?? 400)));
}

function synthesisExpr(family: string | undefined): string | undefined {
  return family && fontWeightsOf(family) ? `"none"` : undefined;
}

/**
 * A text outline that stays an outline. `-webkit-text-stroke` is drawn
 * centred on the glyph edge, OVER the fill — a 2px stroke on a 32px title ate
 * a pixel into every stroke of every letter and left striped, hollow text.
 * Painted under the fill (`paint-order: stroke fill`) only its outer half
 * shows, so the width is doubled, and it scales with the letters (em) inside
 * a floor and a ceiling so 细 stays visible on small text and 粗 never turns
 * a headline into a sticker.
 */
function strokeCss(stroke: { width: number; color: string }): string {
  const w = Math.max(0.5, Math.min(4, n(stroke.width, 1)));
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return `clamp(${round(w * 1.5)}px, ${round(w * 0.07)}em, ${round(w * 3)}px) ${stroke.color}`;
}

/** Shared frame + paint properties, so a box, a button and a chat surface all
 *  take the same style vocabulary. */
function boxPaint(
  style:
    | {
        fills?: UiFill[];
        radius?: UiRadius;
        borderColor?: string;
        borderWidth?: number;
        borderStyle?: "solid" | "dashed" | "dotted";
        shadows?: UiShadow[];
        backdropBlur?: number;
        padding?: number;
      }
    | undefined
): Array<[string, string | number | undefined]> {
  if (!style) return [];
  return [
    ["background", fillsExpr(style.fills)],
    ["borderRadius", radiusCss(style.radius)],
    [
      "border",
      style.borderColor
        ? s(`${n(style.borderWidth, 1)}px ${style.borderStyle ?? "solid"} ${style.borderColor}`)
        : undefined,
    ],
    ["boxShadow", shadowsCss(style.shadows)],
    ["backdropFilter", style.backdropBlur ? s(`blur(${n(style.backdropBlur)}px)`) : undefined],
    ["WebkitBackdropFilter", style.backdropBlur ? s(`blur(${n(style.backdropBlur)}px)`) : undefined],
    ["padding", style.padding === undefined ? undefined : n(style.padding)],
  ];
}

// ── Actions ────────────────────────────────────────────────────────────────

/** Acts on the last assistant message rather than on a message id the doc could
 *  not know, and routes through the very calls the bubble's hover toolbar makes
 *  (message-actions.tsx) so there is one behaviour, not two. */
const LAST_MESSAGE_ACTIONS = new Set<UiAction["kind"]>(["regenerate", "copy-message", "rewind"]);

/**
 * How long a button waits after switching the opening before it runs its next
 * step, when the host does not say when the switch is done.
 *
 * Switching the opening restores that opening's starting variables. A button
 * that switches and then writes a variable ("pick this route, remember who was
 * picked") must write AFTER the restore or the write is thrown away — which is
 * the race hand-written opening pickers paper over with a setTimeout. When
 * `api.switchGreeting` returns a promise the button waits for it instead.
 */
const GREETING_SETTLE_MS = 600;

/**
 * Where a step's texts come from. A button's steps read the variables; a step
 * run by a picked option also reads `{{choice}}`, and one run by a list row
 * reads `{{item}}` — those scope tokens are resolved first, then the ordinary
 * `{{var}}` pass. `text` takes the template as a JS string literal and returns
 * the expression that yields the pre-interpolation string.
 */
interface ActionScope {
  text: (template: string) => string;
  /** A picked option's steps always wait for an opening switch, because the
   *  part writes its own variable again once they are done. */
  alwaysWait?: boolean;
}

const PLAIN_SCOPE: ActionScope = { text: (template) => template };
const CHOICE_SCOPE: ActionScope = { text: (template) => `bindText(${template}, "choice", choice)`, alwaysWait: true };
const ROW_SCOPE: ActionScope = { text: (template) => `itemText(${template}, item, index)` };

/** How long a button waits at most for a host that promised to say when an
 *  opening switch is done and never did. */
const GREETING_CAP_MS = 15000;

/** The same cap for a behaviour a button sets off: what comes after it waits
 *  for its changes, but never on a host that does not answer. */
const BEHAVIOR_CAP_MS = 8000;

/** One step of a button, as an awaited statement. Steps run in the order the
 *  creator listed them, and each waits for the one before it: every call is
 *  passed through `settle`, which waits on a returned promise and is a no-op
 *  for a call that returns nothing. */
function actionStatement(action: UiAction, isLast = true, scope: ActionScope = PLAIN_SCOPE): string {
  const text = (value: UiText | undefined) => `interpolate(vars, ${scope.text(s(value?.template ?? ""))})`;
  switch (action.kind) {
    case "set-variable": {
      const id = s(action.variableId);
      // The write also lands in the handler's own copy of the variables, so a
      // later step reads the new value ("好感 +1，现在是 {{好感}}") rather than
      // the one the button was rendered with.
      if (action.op === "toggle") return `await settle(api.setVariable(${id}, vars[${id}] = !readVar(vars, ${id})));`;
      if (action.op === "set") {
        // A text value is written as it reads NOW: "欢迎你，{{名字}}" stores
        // the name, not the macro — and inside a pick or a row, "set 当前角色
        // to {{choice}}" is the point.
        const value = typeof action.value === "string" && action.value.includes("{{")
          ? text({ template: action.value })
          : literal(action.value ?? null);
        return `await settle(api.setVariable(${id}, vars[${id}] = ${value}));`;
      }
      const delta = Number(action.value ?? 0);
      const expr = action.op === "add" ? `+ ${n(delta)}` : `- ${n(delta)}`;
      return `await settle(api.setVariable(${id}, vars[${id}] = Number(readVar(vars, ${id}) || 0) ${expr}));`;
    }
    case "random": {
      const id = s(action.variableId);
      const from = (Array.isArray(action.from) ? action.from : []).filter((x) => typeof x === "string" && x.trim());
      if (from.length > 0) {
        return `await settle(api.setVariable(${id}, vars[${id}] = ${JSON.stringify(from)}[Math.floor(Math.random() * ${from.length})]));`;
      }
      const lo = Math.round(Number.isFinite(action.min) ? action.min! : 1);
      const hi = Math.max(lo, Math.round(Number.isFinite(action.max) ? action.max! : 20));
      return `await settle(api.setVariable(${id}, vars[${id}] = ${lo} + Math.floor(Math.random() * ${hi - lo + 1})));`;
    }
    case "send-message":
      return `await settle(api.sendMessage(${text(action.text)}));`;
    case "go-page":
      return `go(${s(action.pageId)});`;
    case "switch-greeting":
      // The host answers with a promise that settles once the switch has been
      // applied; a host that answers nothing gets a fixed pause instead, and
      // the wait only matters when something comes after it.
      return `await settle(api.switchGreeting && api.switchGreeting(${n(action.index)}), ${isLast && !scope.alwaysWait ? 0 : GREETING_SETTLE_MS}, ${GREETING_CAP_MS});`;
    case "play-audio":
      return `await settle(api.playAudio && api.playAudio(${s(action.trackId)}));`;
    case "stop-audio":
      return action.trackId
        ? `await settle(api.stopAudio && api.stopAudio(${s(action.trackId)}));`
        : `await settle(api.stopAudio && api.stopAudio());`;
    case "toast":
      return `await settle(api.showToast && api.showToast(${text(action.text)}));`;
    case "run-behavior": {
      const params = (action.params ?? []).filter((p) => p && p.name);
      const arg = params.length ? `, { ${params.map((p) => `${s(p.name)}: ${text(p.value)}`).join(", ")} }` : "";
      return `await settle(runBehavior(api, ${s(action.actionId)}${arg}), 0, ${BEHAVIOR_CAP_MS});`;
    }
    case "run-ai":
      // Fire and forget: its answer arrives in the story like any reply.
      return `api.callAi && api.callAi(${s(action.aiId)});`;
    case "rewind":
      return `rewindLast(api);`;
    case "regenerate":
      return `regenerateLast(api);`;
    case "copy-message":
      return `copyLast(api);`;
    default:
      return "";
  }
}

/** A list of steps as a function the parts runtime calls. `params` follow the
 *  handler's own copy of the variables. `null` when there is nothing to run. */
function stepsFn(actions: UiAction[] | undefined, params: string, scope: ActionScope, indent: string): string {
  const list = (Array.isArray(actions) ? actions : []).filter((a) => a && typeof a.kind === "string");
  const lines = list
    .map((a, i) => actionStatement(a, i === list.length - 1, scope))
    .filter(Boolean)
    .map((line) => `${indent}  ${line}`);
  if (lines.length === 0) return "null";
  return `async function (vars${params}) {\n${lines.join("\n")}\n${indent}}`;
}

const switches = (actions: UiAction[] | undefined) =>
  Array.isArray(actions) && actions.some((a) => a && a.kind === "switch-greeting");

/** A text style as an inline style object, for the parts' titles and labels.
 *  Absent fields stay absent so the theme-derived class rules show through. */
function textStyleExpr(style: UiTextStyle | undefined, ctx: Ctx): string {
  if (!style) return "undefined";
  return styleObject([
    ["fontSize", style.size === undefined && style.desktopSize === undefined ? undefined : sizeExpr(style, 14)],
    ["color", style.color === undefined ? undefined : s(style.color)],
    ["fontWeight", weightExpr(style.family, style.weight, undefined)],
          ["fontSynthesisWeight", synthesisExpr(style.family)],
    ["fontFamily", familyExpr(style.family, ctx)],
    ["letterSpacing", style.letterSpacing === undefined ? undefined : s(`${n(style.letterSpacing)}px`)],
    ["textAlign", style.align ? s(style.align) : undefined],
    ["textTransform", style.transform ? s(style.transform) : undefined],
    ["lineHeight", style.lineHeight === undefined ? undefined : n(style.lineHeight, 1.5)],
    ["fontStyle", style.italic ? `"italic"` : undefined],
    ["textShadow", style.textShadow ? shadowTextCss(style.textShadow) : undefined],
  ]);
}

/** A box style (plus the text colour and size an input or chip carries) as an
 *  inline style object; `undefined` when the creator set nothing. */
function boxStyleExpr(style: (Parameters<typeof boxPaint>[0] & { textColor?: string; size?: number }) | undefined): string {
  if (!style) return "undefined";
  const out = styleObject([
    ...boxPaint(style),
    ["color", style.textColor ? s(style.textColor) : undefined],
    ["fontSize", style.size === undefined ? undefined : n(style.size, 14)],
  ]);
  return out === "{  }" ? "undefined" : out;
}

function animationStyle(el: UiElement): Array<[string, string | number | undefined]> {
  if (!el.animation) return [];
  const name = el.animation.kind === "fade" ? "uiFade" : el.animation.kind === "rise" ? "uiRise" : "uiPulse";
  const duration = Math.max(1, n(el.animation.durationMs, 300));
  const delay = Math.max(0, n(el.animation.delayMs, 0));
  const iteration = el.animation.kind === "pulse" ? "infinite" : "1";
  return [["animation", `"${name} ${duration}ms ease ${delay}ms ${iteration} both"`]];
}

function frameStyle(
  el: UiElement,
  extra: Array<[string, string | number | undefined]>,
  opacityExpr?: string
): string {
  // Geometry is resolved at RENDER time, not here: the same element has a box
  // on the phone canvas and a box on the wide one, and which is in force is a
  // property of the window the card landed in. Everything else about the
  // element — its colour, its binding, its text — is identical either way.
  const d = el.desktop;
  const desktopArg = d === null ? "null" : d ? `{ left: ${n(d.x)}, top: ${n(d.y)}, width: ${n(d.w)}, height: ${n(d.h)} }` : "undefined";
  return styleObject([
    ["position", `"absolute"`],
    ["...", `__box(__m, { left: ${n(el.x)}, top: ${n(el.y)}, width: ${n(el.w)}, height: ${n(el.h)} }, ${desktopArg})`],
    // Border-box so a border or padding does not grow an element past the size
    // it was dragged to. On a canvas, the handles are the truth.
    ["boxSizing", `"border-box"`],
    ["zIndex", el.z === undefined ? undefined : n(el.z)],
    ["opacity", opacityExpr ?? (el.opacity === undefined ? undefined : n(el.opacity, 1))],
    ["transform", el.rotation ? `"rotate(${n(el.rotation)}deg)"` : undefined],
    ...animationStyle(el),
    ...extra,
    ...liftStyle(el),
    ...inkVars(el),
  ]);
}

// ── Ink on the page (see ink.ts) ───────────────────────────────────────────
//
// Set for the duration of one compileUiDoc call: which parts' words had to
// change colour for the ground they sit on, per canvas.
let INK: InkPlan["elements"] | null = null;

/** One value per canvas, as an expression; undefined when neither has one. */
function perCanvas(phone: string | undefined, desktop: string | undefined): string | undefined {
  if (phone === undefined && desktop === undefined) return undefined;
  const p = phone === undefined ? "undefined" : s(phone);
  const d = desktop === undefined ? "undefined" : s(desktop);
  return p === d ? p : `(__m === "desktop" ? ${d} : ${p})`;
}

/** An element's text colour: its own, unless it does not read where it sits. */
function inkColor(el: UiElement, own: string): string {
  const info = INK?.get(el);
  if (!info || (!info.phone?.color && !info.desktop?.color)) return s(own);
  return perCanvas(info.phone?.color ?? own, info.desktop?.color ?? own)!;
}

/** A part's on-page ink, as custom properties on its root. */
function inkVars(el: UiElement): Array<[string, string | number | undefined]> {
  const info = INK?.get(el);
  if (!info || (!info.phone?.vars && !info.desktop?.vars)) return [];
  const names = [...new Set([...Object.keys(info.phone?.vars ?? {}), ...Object.keys(info.desktop?.vars ?? {})])].sort();
  return names.map((name) => [name, perCanvas(info.phone?.vars?.[name], info.desktop?.vars?.[name])]);
}

// ── The composer grows; what sits on it makes room ─────────────────────────
//
// The platform's composer is taller than the box a layout gives it (its card,
// toolbar and padding come to ~100 design px against an 88px box), and it
// grows again with every line the player types. Clipped to its box, the
// toolbar lost its bottom edge at rest and half of itself after a newline.
// So a composer is drawn from its box's BOTTOM edge up: the box is its
// minimum, never its maximum, and a taller composer rises instead of being
// cut. How far it rose is published on the page as `--ui-lift-<id>`, and the
// parts stacked on top of it follow — the transcript above gives up that much
// of its height, a row of quick buttons rides up with it. This is decided per
// canvas from where the parts already are, so cards saved long before this
// fix get it too.

/** How a part reacts to a composer growing under it, on one canvas. */
interface LiftRole {
  role: "ride" | "shrink";
  /** CSS-safe name of the composer it follows. */
  src: string;
}
const LIFT = new WeakMap<UiElement, { phone?: LiftRole; desktop?: LiftRole }>();

/** A composer's custom-property name: its id, restricted to what CSS allows. */
const liftName = (el: UiElement) => el.id.replace(/[^A-Za-z0-9_-]/g, "_");

type Rect = { x: number; y: number; w: number; h: number };
function rectOn(el: UiElement, canvas: "phone" | "desktop"): Rect | null {
  const b = canvas === "phone" || el.desktop === undefined
    ? { x: n(el.x), y: n(el.y), w: n(el.w), h: n(el.h) }
    : el.desktop === null ? null : { x: n(el.desktop.x), y: n(el.desktop.y), w: n(el.desktop.w), h: n(el.desktop.h) };
  return b && b.w > 0 && b.h > 0 ? b : null;
}

/**
 * The strip across the top of a page that a stock-chat card's own parts
 * take — a status line, a meter, a title — in design pixels, or 0.
 *
 * The platform's chat is drawn full-bleed under the design, and the two
 * layers knew nothing of each other: a meter added at the top sat on the
 * first lines of the story. The chat now starts below this strip. Only
 * parts that live in the top quarter count; a picture that fills the page
 * is a backdrop, not a bar, and the chat parts themselves are the chat.
 */
export function stockChatTopBand(page: UiPage, canvas: "phone" | "desktop"): number {
  const canvasH = canvas === "desktop" ? n(page.desktopHeight, UI_DESKTOP_H) : n(page.height, 812);
  let bottom = 0;
  for (const el of page.elements ?? []) {
    if (!el || typeof el.type !== "string") continue;
    if (el.type === "chat" || el.type === "messages" || el.type === "composer" || el.type === "popup") continue;
    const r = rectOn(el, canvas);
    if (!r || r.y > canvasH * 0.25 || r.y + r.h > canvasH * 0.3) continue;
    bottom = Math.max(bottom, r.y + r.h);
  }
  return bottom > 0 ? Math.ceil(bottom + 8) : 0;
}

/** How far above a part's top the bottom of the one on it may end and still
 *  count as stacked on it (the layouts leave 8–12px between rows). */
const STACK_BAND = 24;

function markLift(page: UiPage): void {
  const els = (page.elements ?? []).filter((el) => el && typeof el.type === "string" && typeof el.id === "string");
  // Marks are keyed by the element object, and an editor recompiles the same
  // unchanged objects over and over. A rider marked last time was skipped this
  // time and so never joined the frontier — the chain stopped at the buttons
  // and the transcript above them was no longer shrunk: it ran under them.
  for (const el of els) LIFT.delete(el);
  for (const canvas of ["phone", "desktop"] as const) {
    const canvasH = canvas === "desktop" ? n(page.desktopHeight, UI_DESKTOP_H) : n(page.height, 812);
    for (const composer of els.filter((el) => el.type === "composer")) {
      const base = rectOn(composer, canvas);
      if (!base) continue;
      const src = liftName(composer);
      let frontier: Rect[] = [base];
      // A few rows deep: quick buttons on the composer, a caption on them.
      for (let depth = 0; depth < 3 && frontier.length; depth++) {
        const next: Rect[] = [];
        for (const el of els) {
          if (el === composer || el.type === "composer" || el.type === "popup") continue;
          const info = LIFT.get(el) ?? {};
          if (info[canvas]) continue;
          const b = rectOn(el, canvas);
          if (!b || (b.h >= canvasH * 0.5 && el.type !== "messages" && el.type !== "chat")) continue;
          const bottom = b.y + b.h;
          const onIt = frontier.some((f) =>
            Math.min(b.x + b.w, f.x + f.w) - Math.max(b.x, f.x) > 0
            && b.y < f.y && bottom >= f.y - STACK_BAND && bottom <= f.y + 4);
          if (!onIt) continue;
          // A transcript gives up height (it scrolls); anything else moves.
          const role: LiftRole["role"] = el.type === "messages" || el.type === "chat" || el.type === "list" ? "shrink" : "ride";
          LIFT.set(el, { ...info, [canvas]: { role, src } });
          if (role === "ride") next.push(b);
        }
        frontier = next;
      }
    }
  }
}

function liftStyle(el: UiElement): Array<[string, string | number | undefined]> {
  const info = LIFT.get(el);
  if (!info) return [];
  const expr = (role: LiftRole["role"]) => {
    const value = (r: LiftRole | undefined) =>
      r?.role !== role ? "undefined"
      : role === "ride" ? s(`0 calc(-1 * var(--ui-lift-${r.src}, 0px))`)
      : s(`var(--ui-lift-${r.src}, 0px)`);
    const phone = value(info.phone);
    const desktop = value(info.desktop);
    if (phone === "undefined" && desktop === "undefined") return undefined;
    return phone === desktop ? phone : `(__m === "desktop" ? ${desktop} : ${phone})`;
  };
  return [["translate", expr("ride")], ["paddingBottom", expr("shrink")]];
}

/** A font size that may differ per canvas, resolved where the box is.
 *
 *  The two canvases are 375 and 1024 design-px across, so one number is a
 *  different size relative to the card: a 24px name is a heading on a phone and
 *  a caption on a monitor. */
function sizeExpr(style: { size?: number; desktopSize?: number } | undefined, fallback: number): string {
  const phone = n(style?.size, fallback);
  if (style?.desktopSize === undefined) return String(phone);
  return `(__m === "desktop" ? ${n(style.desktopSize, phone)} : ${phone})`;
}

/** An authored list row: a string stays a string, a record stays a record (so
 *  `{{item.title}}` reads it), anything else is printed. */
function staticRow(item: unknown): string | Record<string, string> {
  if (typeof item === "string") return item;
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(item as Record<string, unknown>)) out[k] = v === null || v === undefined ? "" : String(v);
    return out;
  }
  return String(item ?? "");
}

/** Every element carries its id so `element.css` has something to select. */
const elAttr = (el: UiElement) => `data-ui-el=${s(el.id)}`;

function emitElement(el: UiElement, indent: string, ctx: Ctx, fnName: string): string {
  const body = (() => {
    switch (el.type) {
      case "box":
        return `${indent}<div ${elAttr(el)} style={${frameStyle(el, boxPaint(el.style))}} />`;

      case "text": {
        const style = frameStyle(el, [
          ["fontSize", sizeExpr(el.style, 14)],
          ["color", inkColor(el, el.style?.color ?? "#ffffff")],
          ["fontWeight", weightExpr(el.style?.family, el.style?.weight, undefined)],
          ["fontSynthesisWeight", synthesisExpr(el.style?.family)],
          ["fontFamily", familyExpr(el.style?.family, ctx)],
          ["letterSpacing", el.style?.letterSpacing === undefined ? undefined : s(`${n(el.style.letterSpacing)}px`)],
          ["textAlign", el.style?.align ? s(el.style.align) : undefined],
          ["textTransform", el.style?.transform ? s(el.style.transform) : undefined],
          ["lineHeight", el.style?.lineHeight === undefined ? undefined : n(el.style.lineHeight, 1.5)],
          ["fontStyle", el.style?.italic ? `"italic"` : undefined],
          ["textShadow", el.style?.textShadow ? shadowTextCss(el.style.textShadow) : undefined],
          ["WebkitTextStroke", el.style?.stroke ? s(strokeCss(el.style.stroke)) : undefined],
          ["paintOrder", el.style?.stroke ? `"stroke fill"` : undefined],
          ["overflow", `"hidden"`],
          ["whiteSpace", el.style?.nowrap ? `"nowrap"` : `"pre-wrap"`],
          ["textOverflow", el.style?.nowrap ? `"ellipsis"` : undefined],
        ]);
        if (el.style?.markdown) {
          // Markdown goes through the host's pipeline, which sanitises. When
          // the host does not expose one there is no sanitiser in reach, so
          // the text renders as text — a template can interpolate a variable
          // whose value came from the AI, and raw innerHTML on that path would
          // be an XSS hole dressed up as a fallback.
          return `${indent}<Markdown api={api} elId={${s(el.id)}} text={${textExpr(el.text)}} style={${style}} />`;
        }
        return `${indent}<div ${elAttr(el)} style={${style}}>{${textExpr(el.text)}}</div>`;
      }

      case "image":
        return `${indent}<div ${elAttr(el)} style={${frameStyle(el, [["overflow", `"hidden"`], ["borderRadius", radiusCss(el.radius)]])}}>
${indent}  ${el.media === "video"
          ? `<Vid src={${imageExpr(el.src)}} fit={${s(el.fit ?? "cover")}} loop={${el.loop !== false}} sound={${el.sound === true}} />`
          : `<Img src={${imageExpr(el.src)}} fit={${s(el.fit ?? "cover")}} />`}
${indent}</div>`;

      case "meter": {
        const pct = `pct(${numberExpr(el.value)}, ${numberExpr(el.min, 0)}, ${numberExpr(el.max, 100)})`;
        const width = el.style?.reverse ? `(100 - ${pct})` : pct;
        const track = fillsExpr(el.style?.track) ?? s("rgba(255,255,255,0.14)");
        const fill = fillsExpr(el.style?.fills) ?? s("#d9a13f");
        const radius = radiusCss(el.style?.radius) ?? "999";
        return `${indent}<div ${elAttr(el)} style={${frameStyle(el, [
          ["background", track],
          ["borderRadius", radius],
          ["overflow", `"hidden"`],
        ])}}>
${indent}  <div style={{ width: ${width} + "%", height: "100%", background: ${fill}, transition: "width 260ms ease" }} />
${indent}</div>`;
      }

      case "button": {
        const actions = buttonActionsOf(el);
        const statements = actions
          .map((a, i) => actionStatement(a, i === actions.length - 1))
          .filter(Boolean)
          .map((line) => `${indent}        ${line}`)
          .join("\n");
        // Async so each step can wait for the one before it (switching the
        // opening has to land before a variable is written over it). One try
        // around the lot: a step that throws stops the steps after it rather
        // than leaving an unhandled rejection in the card.
        const handler = statements
          ? `async () => {
${indent}    try {
${indent}      await (async function (vars) {
${statements}
${indent}      })(Object.assign({}, vars));
${indent}    } catch (err) {
${indent}      if (typeof console !== "undefined") console.warn("[card] button action failed", err);
${indent}    }
${indent}  }`
          : `() => {
${indent}    /* no actions */
${indent}  }`;
        // A button that acts on the last AI message dims and stops responding
        // while there is no such message, or while one is still streaming. It
        // does not disappear: on a fixed layout a vanishing control shifts
        // nothing and simply reads as a hole.
        const needsMessage = actions.some((a) => LAST_MESSAGE_ACTIONS.has(a.kind));
        // 「这些填好了才能按」: the same dim-not-vanish rule, over variables.
        const required = (Array.isArray(el.requires) ? el.requires : []).filter((id) => typeof id === "string" && id);
        const ready = [
          ...(needsMessage ? ["canActOnLast(api)"] : []),
          ...(required.length ? [`hasAll(vars, ${JSON.stringify(required)})`] : []),
        ].join(" && ");
        const base = el.opacity === undefined ? 1 : n(el.opacity, 1);
        const opacity = ready ? `(${ready} ? ${base} : ${base * 0.4})` : undefined;
        const paint = boxPaint(el.style);
        return `${indent}<button
${indent}  ${elAttr(el)}
${indent}  type="button"
${indent}  disabled={${!ready ? "false" : ready.includes("&&") ? `!(${ready})` : `!${ready}`}}
${indent}  onClick={${handler}}
${indent}  style={${frameStyle(
          el,
          [
            ...paint,
            ["background", fillsExpr(el.style?.fills) ?? s("rgba(255,255,255,0.10)")],
            ["color", s(el.style?.textColor ?? "#ffffff")],
            ["fontSize", sizeExpr(el.style, 13)],
            ["fontWeight", weightExpr(el.style?.family, el.style?.weight, 600)],
          ["fontSynthesisWeight", synthesisExpr(el.style?.family)],
            ["fontFamily", familyExpr(el.style?.family, ctx)],
            ["letterSpacing", el.style?.letterSpacing === undefined ? undefined : s(`${n(el.style.letterSpacing)}px`)],
            ["borderRadius", radiusCss(el.style?.radius) ?? `"var(--yc-send-radius, 10px)"`],
            ["border", el.style?.borderColor ? s(`${n(el.style.borderWidth, 1)}px ${el.style.borderStyle ?? "solid"} ${el.style.borderColor}`) : `"none"`],
            ["cursor", ready ? `(${ready} ? "pointer" : "default")` : `"pointer"`],
          ],
          opacity
        )}}
${indent}>{${textExpr(el.label)}}</button>`;
      }

      // The three chat surfaces. `Chat` is the pair together; `MessageList` and
      // `MessageInput` are the same two halves the platform already exports
      // separately (sandbox/building-blocks/index.ts) and already injects into
      // this scope — so placing them apart costs a case each and no new
      // contract. The `typeof` guard is for hosts that inject a narrower set.
      case "chat":
        return emitChatSurface(el, indent, "Chat", hasMessageDesign(el) ? `<Chat${designProps(el, ctx)} />` : "<Chat />");
      case "messages":
        return emitChatSurface(el, indent, "MessageList", hasMessageDesign(el)
          ? `<MessageList rendererComponent={null}${designProps(el, ctx)} />`
          : "<MessageList rendererComponent={null} />");
      case "composer":
        return emitChatSurface(el, indent, "MessageInput", "<MessageInput />");

      case "list": {
        // Persisted JSON, not the type system, is the contract here — a doc
        // can arrive with source missing or misshapen and must render as an
        // empty list rather than a crash.
        const src = el.source && typeof el.source === "object" ? el.source : { kind: "static" as const, items: [] };
        const rowsExpr =
          src.kind === "variable"
            ? `(Array.isArray(readVar(vars, ${s(String(src.variableId ?? ""))})) ? readVar(vars, ${s(String(src.variableId ?? ""))}) : [])`
            : src.kind === "entries"
              ? `entryRows(api, ${s(typeof src.role === "string" ? src.role : "")}, ${s(typeof src.folderId === "string" ? src.folderId : "")})`
              : JSON.stringify(Array.isArray(src.items) ? src.items.map(staticRow) : []);
        // Guarded past the schema's min(1): a draft can hold 0 or a negative
        // while the creator is mid-edit, and slice(0, -1) would silently eat
        // the LAST row instead of limiting.
        const maxed = el.maxItems && el.maxItems > 0 ? `.slice(0, ${n(el.maxItems)})` : "";
        const template = s(el.item?.template ?? "{{item}}");
        const itemStyle = styleObject([
          ...boxPaint(el.itemStyle),
          ["flex", `"none"`],
          ["fontSize", sizeExpr(el.textStyle, 12)],
          ["color", inkColor(el, el.textStyle?.color ?? "#ffffff")],
          ["fontWeight", weightExpr(el.textStyle?.family, el.textStyle?.weight, undefined)],
          ["fontSynthesisWeight", synthesisExpr(el.textStyle?.family)],
          ["fontFamily", familyExpr(el.textStyle?.family, ctx)],
          ["lineHeight", el.textStyle?.lineHeight === undefined ? undefined : n(el.textStyle.lineHeight, 1.5)],
          ["letterSpacing", el.textStyle?.letterSpacing === undefined ? undefined : s(`${n(el.textStyle.letterSpacing)}px`)],
          ["whiteSpace", `"pre-wrap"`],
          ["overflowWrap", `"anywhere"`],
        ]);
        // The empty line is the list's only voice when there is nothing in it,
        // so it is drawn in the colour and size the ROWS were given. Left to
        // inherit at 0.45 it came out a ghost on a light theme — the one state
        // where the list has something to say and nobody could read it.
        const empty = el.emptyText?.template
          ? `<div style={${styleObject([
              ["opacity", "0.6"],
              ["fontSize", sizeExpr(el.textStyle, 12)],
              ["color", el.textStyle?.color === undefined ? undefined : inkColor(el, el.textStyle.color)],
            ])}}>{${textExpr(el.emptyText)}}</div>`
          : "null";
        const onRow = stepsFn(el.rowActions, ", item, index", ROW_SCOPE, `${indent}  `);
        if (el.card && typeof el.card === "object") {
          // Rows drawn as cards. The templates travel as data and are resolved
          // per row at runtime, exactly like the plain row template.
          const card = el.card;
          const cardData = JSON.stringify({
            title: card.title?.template,
            subtitle: card.subtitle?.template,
            badge: card.badge?.template,
            imageField: card.imageField || undefined,
            imageRatio: typeof card.imageRatio === "number" && Number.isFinite(card.imageRatio) ? card.imageRatio : undefined,
          });
          const lock = card.lockedUnless && card.lockedUnless.variableId ? card.lockedUnless : null;
          return `${indent}<UiCardList
${indent}  api={api}
${indent}  vars={vars}
${indent}  elId={${s(el.id)}}
${indent}  frame={${frameStyle(el, [])}}
${indent}  rows={${rowsExpr}${maxed}}
${indent}  item={${template}}
${indent}  card={${cardData}}
${indent}  lockVar={${lock ? s(lock.variableId) : "null"}}
${indent}  lockField={${lock ? s(lock.field ?? "") : "null"}}
${indent}  lockedText={${s(card.lockedText?.template ?? "")}}
${indent}  direction={${s(el.direction === "row" ? "row" : "column")}}
${indent}  columns={${n(el.columns, 0)}}
${indent}  gap={${n(el.gap, 8)}}
${indent}  itemStyle={${boxStyleExpr(el.itemStyle)}}
${indent}  empty={${el.emptyText?.template ? textExpr(el.emptyText) : "null"}}
${indent}  onRow={${onRow}}
${indent}/>`;
        }
        // A row that does something is a real button; one that does not
        // stays a plain row, so a list without row steps compiles as before.
        const row = onRow === "null"
          ? `<div key={i} style={${itemStyle}}>{interpolate(vars, itemText(${template}, item, i))}</div>`
          : `<button type="button" key={i} className="yp-rowbtn" onClick={function () { runSteps(onRow, [Object.assign({}, vars), item, i]); }} style={${itemStyle}}>{interpolate(vars, itemText(${template}, item, i))}</button>`;
        const across = el.direction === "row" && !!el.columns && el.columns > 0;
        return `${indent}<div ${elAttr(el)} style={${frameStyle(el, [
          ["display", across ? `"grid"` : `"flex"`],
          ["flexDirection", across ? undefined : s(el.direction === "row" ? "row" : "column")],
          ["gridTemplateColumns", across ? s(`repeat(${n(el.columns, 1)}, minmax(0, 1fr))`) : undefined],
          ["alignContent", across ? `"start"` : undefined],
          ["gap", n(el.gap, 6)],
          ["overflow", `"auto"`],
        ])}}>
${indent}  {(function () {
${indent}    const rows = ${rowsExpr}${maxed};
${indent}    if (rows.length === 0) return ${empty};${onRow === "null" ? "" : `\n${indent}    const onRow = ${onRow};`}
${indent}    return rows.map(function (item, i) {
${indent}      return ${row};
${indent}    });
${indent}  })()}
${indent}</div>`;
      }

      case "choice": {
        const options = (Array.isArray(el.options) ? el.options : []).filter((o) => o && typeof o.id === "string");
        const optionLines = options.map((o) => {
          const fields: string[] = [
            `id: ${s(o.id)}`,
            `title: ${s(String(o.title ?? ""))}`,
          ];
          if (o.subtitle) fields.push(`subtitle: ${s(o.subtitle)}`);
          if (o.detail) fields.push(`detail: ${s(o.detail)}`);
          if (Array.isArray(o.tags) && o.tags.length) fields.push(`tags: ${JSON.stringify(o.tags.filter((t) => typeof t === "string" && t))}`);
          if (o.value !== undefined && o.value !== "") fields.push(`value: ${s(String(o.value))}`);
          if (o.image) fields.push(`image: ${imageExpr(o.image)}`);
          if (switches(o.actions)) fields.push("sw: true");
          fields.push(`run: ${stepsFn(o.actions, ", choice", CHOICE_SCOPE, `${indent}    `)}`);
          return `${indent}    { ${fields.join(", ")} },`;
        });
        const st = el.style ?? {};
        const confirm = el.confirm
          ? `{ label: ${textExpr(el.confirm.label)}, style: ${boxStyleExpr(el.confirm.style)}${switches(el.confirm.actions) ? ", sw: true" : ""}, run: ${stepsFn(el.confirm.actions, ", choice", CHOICE_SCOPE, `${indent}  `)} }`
          : "null";
        const ratio = typeof st.imageRatio === "number" && Number.isFinite(st.imageRatio) ? st.imageRatio : el.layout === "list" ? 1 : 0.72;
        return `${indent}<UiChoice
${indent}  api={api}
${indent}  vars={vars}
${indent}  elId={${s(el.id)}}
${indent}  frame={${frameStyle(el, [])}}
${indent}  wide={__m === "desktop"}
${indent}  layout={${s(el.layout === "carousel" || el.layout === "list" ? el.layout : "grid")}}
${indent}  columns={${n(el.columns, 0)}}
${indent}  gap={${n(el.gap, 10)}}
${indent}  multi={${el.multi ? "true" : "false"}}
${indent}  maxPick={${el.multi ? n(el.maxPick, 0) : 1}}
${indent}  variableId={${s(el.variableId ?? "")}}
${indent}  tagFilter={${el.tagFilter ? "true" : "false"}}
${indent}  imageRatio={${ratio}}
${indent}  cardStyle={${boxStyleExpr(st.card)}}
${indent}  selectedStyle={${boxStyleExpr(st.selected)}}
${indent}  titleStyle={${textStyleExpr(st.title, ctx)}}
${indent}  subStyle={${textStyleExpr(st.subtitle, ctx)}}
${indent}  confirm={${confirm}}
${indent}  options={[
${optionLines.join("\n")}
${indent}  ]}
${indent}/>`;
      }

      case "field": {
        const st = el.style ?? {};
        const kinds = ["text", "textarea", "chips", "number", "slider"];
        const num = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) ? String(v) : "undefined");
        return `${indent}<UiField
${indent}  api={api}
${indent}  vars={vars}
${indent}  elId={${s(el.id)}}
${indent}  frame={${frameStyle(el, [])}}
${indent}  kind={${s(kinds.includes(el.kind) ? el.kind : "text")}}
${indent}  variableId={${s(el.variableId ?? "")}}
${indent}  label={${el.label?.template ? textExpr(el.label) : "null"}}
${indent}  placeholder={${s(el.placeholder ?? "")}}
${indent}  options={${JSON.stringify((Array.isArray(el.options) ? el.options : []).filter((o) => typeof o === "string" && o))}}
${indent}  allowCustom={${el.allowCustom ? "true" : "false"}}
${indent}  min={${num(el.min)}}
${indent}  max={${num(el.max)}}
${indent}  step={${num(el.step)}}
${indent}  labelStyle={${textStyleExpr(st.label, ctx)}}
${indent}  inputStyle={${boxStyleExpr(st.input)}}
${indent}  chipStyle={${boxStyleExpr(st.chip)}}
${indent}  chipOnStyle={${boxStyleExpr(st.chipSelected)}}
${indent}/>`;
      }

      case "popup": {
        const st = el.style ?? {};
        const button = st.button;
        const buttonStyle = button
          ? styleObject([
              ...boxPaint(button),
              ["color", button.textColor ? s(button.textColor) : undefined],
              ["fontSize", button.size === undefined ? undefined : sizeExpr(button, 15)],
              ["fontWeight", weightExpr(button.family, button.weight, undefined)],
          ["fontSynthesisWeight", synthesisExpr(button.family)],
              ["fontFamily", familyExpr(button.family, ctx)],
            ])
          : "undefined";
        return `${indent}<UiPopup
${indent}  api={api}
${indent}  vars={vars}
${indent}  elId={${s(el.id)}}
${indent}  frame={${frameStyle(el, [])}}
${indent}  z={${1000 + n(el.z, 0)}}
${indent}  variableId={${s(el.variableId ?? "")}}
${indent}  title={${s(el.title?.template ?? "")}}
${indent}  body={${s(el.body?.template ?? "")}}
${indent}  buttonLabel={${s(el.buttonLabel?.template ?? "")}}
${indent}  image={${imageExpr(el.image)}}
${indent}  clearOnClose={${el.clearOnClose === false ? "false" : "true"}}
${indent}  scrim={${st.scrim ? s(st.scrim) : "null"}}
${indent}  cardStyle={${boxStyleExpr(st.card)}}
${indent}  titleStyle={${textStyleExpr(st.title, ctx)}}
${indent}  bodyStyle={${textStyleExpr(st.body, ctx)}}
${indent}  buttonStyle={${buttonStyle === "{  }" ? "undefined" : buttonStyle}}
${indent}/>`;
      }

      case "custom":
        return `${indent}<div ${elAttr(el)} style={${frameStyle(el, [...boxPaint(el.style), ["overflow", `"hidden"`]])}}>
${indent}  <ElBoundary><${fnName} api={api} vars={vars} go={go} /></ElBoundary>
${indent}</div>`;

      default:
        return `${indent}{null}`;
    }
  })();

  if (!el.visibleWhen) return body;
  // Hidden elements stay reachable in the visual editor: there they render
  // faded instead of vanishing, or a part shown only "after the chat starts"
  // could never be clicked again to edit it. A played card never ghosts.
  return `${indent}{(function () {
${indent}  const shown = ${conditionExpr(el.visibleWhen)};
${indent}  if (!shown && !editorGhosts()) return null;
${indent}  const node = (<React.Fragment>
${body}
${indent}  </React.Fragment>);
${indent}  return shown ? node : <div data-ui-ghost="" style={{ opacity: 0.35 }}>{node}</div>;
${indent}})()}`;
}

function shadowTextCss(sh: UiShadow): string {
  return s(`${n(sh.x)}px ${n(sh.y)}px ${n(sh.blur)}px ${sh.color}`);
}

/**
 * The message layer travels as data to the platform's own transcript, which
 * owns the drawing (sandbox/chat/designed-message.tsx): the same renderer the
 * Studio preview uses, the same escaping, the same reveal memory. A part with
 * no design passes nothing, so a card without rules compiles byte for byte as
 * it did before the layer existed.
 */
function designProps(el: UiElement, ctx: Ctx): string {
  if (el.type !== "chat" && el.type !== "messages") return "";
  const design = JSON.stringify({ style: el.messageStyle ?? {}, rules: Array.isArray(el.rules) ? el.rules : [] });
  // Families the card loads itself resolve to their asset-scoped names at
  // runtime; the renderer swaps them in by name.
  const fontMap = ctx.fonts.size
    ? ` fontMap={{ ${[...ctx.fonts.entries()].map(([family, i]) => `${s(family)}: fonts ? fonts[${i}] : ${s(family)}`).join(", ")} }}`
    : "";
  return ` design={${design}}${fontMap}`;
}

/** Transcript-level CSS a design asks for: labels off, a readable measure,
 *  the space between messages. Scoped to the part. */
function messageDesignCss(el: UiElement): string[] {
  if ((el.type !== "chat" && el.type !== "messages") || !hasMessageDesign(el) || typeof el.id !== "string") return [];
  const style = el.messageStyle ?? {};
  const scope = `[data-ui-el="${cssAttrValue(el.id)}"]`;
  const out: string[] = [];
  // A side the design draws owns its surface. The theme's bubble tokens (and
  // the platform's right-hand column for the player) paint the transcript's
  // own message box, which sits AROUND the designed message — left alone, a
  // 小说排版 reply still sat in the theme's tinted bubble and the player's
  // line in its accent pill. The design's own box (when it has one) is drawn
  // inside, on the message itself.
  const bare = "background: transparent; padding: 0; border: 0; border-radius: 0; box-shadow: none;";
  if (style.assistant) {
    out.push(`${scope} .play-message-content:not(.play-user-message-content) { ${bare} }`);
  }
  if (style.user) {
    out.push(`${scope} .play-user-message-content { ${bare} }`);
    if (!style.user.bubble) {
      // No bubble: the player's line is prose in the column, not a pill
      // pinned right — laid out by its own alignment.
      out.push(`${scope} .play-user-message-shell { align-items: stretch; }`);
      out.push(`${scope} :is(.play-user-message-content, .play-user-message-shell .play-message-role) { width: auto; margin-left: 0; text-align: ${style.user.text?.align ?? "left"}; }`);
    }
  }
  if (style.showNames === false) out.push(`${scope} :is(.play-message-role, .play-message-speaker) { display: none; }`);
  if (typeof style.maxWidth === "number" && Number.isFinite(style.maxWidth)) {
    out.push(`${scope} .play-message-stack { max-width: min(100%, ${Math.round(style.maxWidth)}px); margin-inline: auto; }`);
  }
  if (typeof style.gap === "number" && Number.isFinite(style.gap)) {
    out.push(`${scope} .play-message-block { padding-block: ${Math.round(style.gap / 2)}px; }`);
  }
  return out;
}

function emitChatSurface(el: UiElement, indent: string, guard: string, jsx: string): string {
  const style = el.type === "chat" || el.type === "messages" || el.type === "composer" ? el.style : undefined;
  // A flex column, so the platform component inside (whose root is a
  // `flex-1 min-h-0` scroller) is held to this box. As a plain block the
  // message list grew to its full height, the box clipped it, and it had
  // nothing to scroll: new replies arrived out of sight.
  const frame = frameStyle(el, [...boxPaint(style), ["overflow", `"hidden"`], ["display", `"flex"`], ["flexDirection", `"column"`]]);
  // The composer is anchored at its box's bottom edge and grows upward (see
  // markLift); its ref publishes how far.
  const open = el.type === "composer"
    ? `<div ${elAttr(el)} ref={__liftRef(${s(liftName(el))})} style={__grow(${frame})}>`
    : `<div ${elAttr(el)} style={${frame}}>`;
  return `${indent}${open}
${indent}  {typeof ${guard} !== "undefined" ? ${jsx} : null}
${indent}</div>`;
}

/** `custom` blocks become real components rather than inline JSX so a creator's
 *  hooks are legal and a thrown render takes down one element instead of the
 *  card. */
function customFnName(pageIndex: number, elIndex: number): string {
  return `Custom_${pageIndex}_${elIndex}`;
}

function emitPage(page: UiPage, index: number, ctx: Ctx): { fn: string; customFns: string } {
  markLift(page);
  const bg = page.background;
  // A colour ground is painted once, full-bleed, by the stage (see
  // backdropSwitch); painting it again on the canvas drew its edge as a seam.
  const bgStyle = styleObject([
    ["position", `"absolute"`],
    ["inset", 0],
    ["overflow", `"hidden"`],
  ]);
  const bgImage =
    bg?.kind === "image"
      ? `\n      <div style={{ position: "absolute", inset: 0 }}>
        <Img src={${imageExpr(bg.src)}} fit={${s(bg.fit ?? "cover")}} />${n(bg.dim) > 0 ? `
        <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,${Math.min(0.9, n(bg.dim))})" }} />` : ""}
      </div>`
      : "";
  const ordered = (page.elements ?? [])
    .filter((el) => el && typeof el.type === "string" && typeof el.id === "string")
    .slice()
    .sort((a, b) => n(a.z) - n(b.z));
  const elements = ordered
    .map((el, i) => emitElement(el, "      ", ctx, customFnName(index, i)))
    .join("\n");
  const customFns = ordered
    .map((el, i) =>
      el.type === "custom"
        ? // A body that is missing or blank would emit a function returning
          //  nothing, and React treats that as an error rather than as empty.
          `function ${customFnName(index, i)}({ api, vars, go }) {\n${el.code?.trim() ? el.code : "  return null;"}\n}`
        : ""
    )
    .filter(Boolean)
    .join("\n\n");
  return {
    fn: `function Page${index}({ api, vars, go, fonts, __m }) {
  return (
    <div style={${bgStyle}}>${bgImage}
${elements || "      {null}"}
    </div>
  );
}`,
    customFns,
  };
}

// ── Stylesheet ─────────────────────────────────────────────────────────────

const KEYFRAMES =
  "@keyframes uiFade{from{opacity:0}to{opacity:1}}@keyframes uiRise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}@keyframes uiPulse{0%,100%{opacity:1}50%{opacity:.55}}";

/**
 * How a card restyles the platform's own chat components.
 *
 * The obvious approach — rewrite every hardcoded value in `message-input.tsx`
 * and friends as `var(--yc-…, <original>)` — puts 4000+ existing cards one
 * forgotten fallback away from a changed composer. This does it the other way
 * round: a rule is emitted ONLY for a token the card actually declared, so a
 * card that declares none gets no CSS and cannot be affected. The safety is
 * structural rather than a matter of getting every fallback right, and the
 * platform components stay untouched.
 *
 * The selectors are the sandbox's own hand-written `play-*` hooks, which is
 * also what makes them a contract from here on: renaming one silently breaks
 * every card that styled it.
 */
const TOKEN_RULES: Record<string, Array<[selector: string, property: string]>> = {
  "--yc-font": [
    [".play-message-content", "font-family"],
    [".play-message-role", "font-family"],
    [".play-composer-textarea", "font-family"],
    [".play-choice-chip", "font-family"],
  ],
  "--yc-text": [[".play-message-content", "color"]],
  "--yc-text-size": [[".play-message-content", "font-size"]],
  "--yc-line-height": [[".play-message-content", "line-height"]],
  "--yc-name": [[".play-message-role", "color"]],
  // Bubbles are bare text by default, so these ADD a surface rather than
  // recolour one — which is exactly what a creator asking for bubbles wants.
  "--yc-bubble-bg": [[".play-message-content:not(.play-user-message-content)", "background"]],
  "--yc-user-bubble-bg": [[".play-user-message-content", "background"]],
  "--yc-user-text": [[".play-user-message-content", "color"]],
  "--yc-bubble-radius": [[".play-message-content", "border-radius"]],
  "--yc-bubble-padding": [[".play-message-content", "padding"]],
  "--yc-input-bg": [[".play-composer-card", "background"]],
  // Everything the composer writes in follows the input's ink: the model
  // pill and the tool buttons were a fixed near-white, invisible on 素纸.
  "--yc-input-fg": [
    [".play-composer-textarea", "color"],
    [".play-composer-model", "color"],
    [".play-composer-icon-button", "color"],
  ],
  "--yc-input-border": [[".play-composer-card", "border"]],
  "--yc-input-radius": [[".play-composer-card", "border-radius"]],
  "--yc-send-bg": [[".play-composer-send", "background"]],
  "--yc-send-fg": [[".play-composer-send", "color"]],
  "--yc-send-radius": [[".play-composer-send", "border-radius"]],
  "--yc-chip-bg": [[".play-choice-chip", "background"]],
  "--yc-chip-fg": [[".play-choice-chip", "color"]],
};

/** The tokens a creator can set, for the editor to offer. */
export const UI_THEME_TOKENS = Object.keys(TOKEN_RULES);

/** One rule per declared token. Descendant of `[data-ui-stage]` so it outranks
 *  the single-class utilities it is overriding and reaches only this card. */
function tokenRules(doc: UiDoc): string[] {
  const declared = new Set(
    Object.keys(drawnTokens(doc) ?? {}).map((k) => (k.startsWith("--") ? k : `--${k}`))
  );
  const out: string[] = [];
  for (const token of Object.keys(TOKEN_RULES).sort()) {
    if (!declared.has(token)) continue;
    for (const [selector, property] of TOKEN_RULES[token]!) {
      out.push(`[data-ui-stage] ${selector} { ${property}: var(${token}); }`);
    }
  }
  // The composer's hint text is the input's ink, faded — not the platform's
  // light grey, which disappears on a light theme.
  if (declared.has("--yc-input-fg")) {
    out.push(`[data-ui-stage] .play-composer-textarea::placeholder { color: color-mix(in srgb, var(--yc-input-fg) 48%, transparent); }`);
  }
  return out;
}

/** Where each part's words land and the ink they need there (ink.ts), for
 *  the editor and for tests; compileUiDoc applies the same plan. */
export function uiDocInk(doc: UiDoc): InkPlan {
  return planInk(doc, drawnTokens(doc), doc.theme?.tokens);
}

/** The theme tokens as drawn: any ink below 4.5:1 on its surface moved to
 *  read (contrast.ts), except pairs still exactly as their preset made them. */
function drawnTokens(doc: UiDoc): Record<string, string> | undefined {
  const preset = doc.theme?.preset;
  const designed = preset
    ? buildUiTheme({ id: preset.id, accent: preset.accent, font: preset.font as never, radius: preset.radius as never })?.tokens
    : undefined;
  return readableThemeTokens(doc.theme?.tokens, designed);
}

/** An id inside an attribute selector. Ids are creator-editable, so the two
 *  characters that would end the selector early are dropped rather than
 *  escaped — an id containing them selects nothing either way, and a mangled
 *  selector is easier to read than a mangled escape. */
const cssAttrValue = (id: string) => id.replace(/["\\]/g, "");

/** Whether any page draws a part that needs the shared parts runtime — so a
 *  card without one compiles to exactly what it compiled to before. */
function usesParts(pages: UiPage[]): boolean {
  return pages.some((page) =>
    (page?.elements ?? []).some((el) =>
      el?.type === "choice" || el?.type === "field" || el?.type === "popup"
      || (el?.type === "list" && (!!el.card || (Array.isArray(el.rowActions) && el.rowActions.length > 0)))));
}

function usesComposer(pages: UiPage[]): boolean {
  return pages.some((page) => (page?.elements ?? []).some((el) => el?.type === "composer"));
}

/** Runtime for a composer drawn from its bottom edge up (see markLift). */
const COMPOSER_RUNTIME = String.raw`/** A composer's box is its minimum: anchored at the box's bottom edge, it grows
 *  upward to hold its toolbar and every line typed into it, up to the top of
 *  the page, instead of being clipped by its box. */
function __grow(style) {
  if (!style || style.display === "none" || typeof style.top !== "number" || typeof style.height !== "number") return style;
  if (!(style.height > 0) || !(style.width > 0)) return style;
  var out = Object.assign({}, style);
  out.top = "auto";
  out.height = "auto";
  out.bottom = "calc(100% - " + (style.top + style.height) + "px)";
  out.minHeight = style.height;
  out.maxHeight = style.top + style.height;
  out.justifyContent = "flex-end";
  return out;
}

/** Publishes how far a composer rose above its box, as --ui-lift-<name> on
 *  its page, for the parts stacked on it. One stable callback per composer. */
var __liftRefs = {};
function __liftRef(name) {
  if (__liftRefs[name]) return __liftRefs[name];
  __liftRefs[name] = function (el) {
    if (!el || typeof ResizeObserver === "undefined") return;
    var host = el.parentElement;
    if (!host) return;
    var prop = "--ui-lift-" + name;
    var measure = function () {
      var min = parseFloat(el.style.minHeight) || 0;
      host.style.setProperty(prop, Math.max(0, Math.round(el.offsetHeight - min)) + "px");
    };
    measure();
    var observer = new ResizeObserver(measure);
    observer.observe(el);
    return function () { observer.disconnect(); host.style.removeProperty(prop); };
  };
  return __liftRefs[name];
}`;

function buildStylesheet(doc: UiDoc, ink?: InkPlan): string {
  // Order is the escalation order of the three freedom grades: the token rules
  // are the properties panel, card CSS is the card-wide escape hatch, and the
  // per-element block is the most specific instruction, so each grade wins a
  // tie against the one below it.
  const parts: string[] = [KEYFRAMES, ...(usesParts(doc.pages ?? []) ? [PARTS_CSS, ...(ink?.css ?? [])] : []), ...tokenRules(doc)];
  for (const page of doc.pages ?? []) for (const el of page?.elements ?? []) if (el) parts.push(...messageDesignCss(el));
  if (doc.theme?.css) parts.push(doc.theme.css);
  for (const page of doc.pages ?? []) {
    for (const el of page?.elements ?? []) {
      if (!el?.css || typeof el.id !== "string") continue;
      // Native CSS nesting does the scoping, so a bare `.play-composer-card`
      // inside means "within this element" and `&:hover` means the element
      // itself — with no CSS parser here to get subtly wrong. Tailwind 4
      // already sets this browser floor, so nesting is not a new requirement.
      parts.push(`[data-ui-el="${cssAttrValue(el.id)}"] { ${el.css} }`);
    }
  }
  return parts.join("\n");
}

/**
 * The stylesheet the EDITOR canvas can inject, as opposed to the one the
 * compiled card ships. The difference is scoping: token rules live under
 * `[data-ui-stage]` and element CSS under `[data-ui-el]`, so they cannot reach
 * outside a canvas that carries those attributes — but `theme.css` is unscoped
 * BY DESIGN (portalled popovers render outside the stage subtree), which in
 * the sandbox costs nothing and in the editor's document would restyle the
 * app. So the editor gets exactly the structurally-scoped parts and no more.
 */
export function uiDocEditCss(doc: UiDoc): string {
  const parts = tokenRules(doc);
  for (const page of doc.pages ?? []) {
    for (const el of page?.elements ?? []) {
      if (!el?.css || typeof el.id !== "string") continue;
      parts.push(`[data-ui-el="${cssAttrValue(el.id)}"] { ${el.css} }`);
    }
  }
  return parts.join("\n");
}

/** Stage-root custom properties: the declared tokens plus one per loaded font,
 *  so free CSS can say `font-family: var(--font-cinzel)` without knowing which
 *  asset-scoped name the loader minted. Keys are sorted — an object that
 *  iterated in insertion order would make the output depend on how the doc was
 *  edited, and `filesHash` would churn. */
function tokenStyle(doc: UiDoc, ink?: InkPlan): string {
  const pairs: Array<[string, string | number | undefined]> = [];
  // Drawn readable: an ink below 4.5:1 on its surface is moved toward black
  // or white here, whichever path set the tokens (see contrast.ts). The page
  // and panel inks (ink.ts) join them only when something had to move.
  const tokens = { ...(drawnTokens(doc) ?? {}), ...(ink?.tokens ?? {}) };
  for (const key of Object.keys(tokens).sort()) {
    const name = key.startsWith("--") ? key : `--${key}`;
    pairs.push([name, s(tokens[key]!)]);
  }
  (doc.theme?.fonts ?? [])
    .filter((face) => face && typeof face.family === "string" && typeof face.ref === "string")
    .forEach((face, i) => {
      pairs.push([`--font-${fontSlug(face.family)}`, `__font${i}`]);
    });
  return styleObject(pairs);
}

const fontSlug = (family: string) =>
  family.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "card";

export interface CompiledUi {
  entryFile: string;
  files: Record<string, string>;
}

/**
 * With a base, the overlay wrapper eats no clicks but its elements must —
 * every compiled element root carries data-ui-el, which is the hook.
 */
const BASE_POINTER_RULE = "\n[data-ui-stage] [data-ui-el] { pointer-events: auto; }";

/** Loads the picked web fonts once per document. On the head, not in the
 *  card: `@font-face` inside the editor preview's shadow root never applies. */
const WEB_FONT_HOOK = `function useWebFonts(href) {
  React.useEffect(function () {
    try {
      if (typeof document === "undefined" || !document.head) return;
      var links = document.head.querySelectorAll("link[data-ui-webfont]");
      for (var i = 0; i < links.length; i++) if (links[i].getAttribute("href") === href) return;
      var link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.setAttribute("data-ui-webfont", "");
      document.head.appendChild(link);
    } catch (_e) {}
  }, [href]);
}`;

/** Compile a uiDoc into the files a RootComponent carries. */
/** The document's editor-only samples as a literal, or `null` — persisted
 *  JSON, so anything but a string or a list of rows is dropped. */
function editorSamplesJson(samples: UiDoc["editorSamples"]): string {
  if (!samples || typeof samples !== "object") return "null";
  const out: Record<string, string | Array<string | Record<string, string>>> = {};
  for (const [key, value] of Object.entries(samples)) {
    if (typeof value === "string") out[key] = value;
    else if (Array.isArray(value)) out[key] = value.map(staticRow);
  }
  return Object.keys(out).length ? JSON.stringify(out) : "null";
}


export function compileUiDoc(doc: UiDoc): CompiledUi {
  const usable = (doc.pages ?? []).filter((p) => p && typeof p.id === "string").map(withDesktopConversation);
  const pages: UiPage[] =
    usable.length > 0 ? usable : [{ id: "page-1", name: "Page 1", height: 812, elements: [] }];
  const entryIndex = Math.max(0, pages.findIndex((p) => p.id === doc.entryPageId));
  const designH = Math.max(1, n(pages[entryIndex]?.height, 812));
  const desktopH = Math.max(1, n(pages[entryIndex]?.desktopHeight, UI_DESKTOP_H));

  // The preserved frontend, rendered unscaled underneath the design overlay.
  // Same shape rule as the schema: subfolders fine, ".." dropped — a missing
  // base layer is visible, a mangled specifier is not.
  const baseFile =
    doc.base && typeof doc.base.file === "string" && /^(?!\.)(?!.*\.\.)[\w./-]+$/.test(doc.base.file)
      ? doc.base.file
      : null;
  // A card that never had a frontend can still have a theme. Its bottom layer
  // is the platform's own chat, rendered exactly as `<Chat/>` rendered before
  // — unscaled, full bleed — with the theme's tokens on the stage around it.
  // Same layer, same rules as a preserved frontend; the only difference is
  // that there is no file to import.
  const stockBase = !baseFile && doc.surface === "chat";
  const hasBase = Boolean(baseFile) || stockBase;
  const baseLayer = baseFile ? "<__Base />" : `{typeof Chat !== "undefined" ? <Chat /> : null}`;
  // A stock chat makes room for the bars a page puts across its top (see
  // stockChatTopBand). Emitted only when a page has one, so every other card
  // compiles exactly as before.
  const topBands = stockBase
    ? pages.map((p) => ({ id: p.id, phone: stockChatTopBand(p, "phone"), desktop: stockChatTopBand(p, "desktop") })).filter((b) => b.phone || b.desktop)
    : [];
  const topBandTable = topBands.length
    ? `/** How much of each page's top its own bars take, in design pixels; the
 *  stock chat starts below them. */
const CHAT_TOP_BAND = {
${topBands.map((b) => `  ${s(b.id)}: { phone: ${b.phone}, desktop: ${b.desktop} },`).join("\n")}
};

`
    : "";

  const faces = (doc.theme?.fonts ?? []).filter((f) => f && typeof f.family === "string" && typeof f.ref === "string");
  const ctx: Ctx = { fonts: new Map(faces.map((f, i) => [f.family, i])) };

  const ink = planInk({ ...doc, pages }, drawnTokens(doc), doc.theme?.tokens);
  let emitted: Array<{ fn: string; customFns: string }>;
  INK = ink.elements;
  try {
    emitted = pages.map((page, i) => emitPage(page, i, ctx));
  } finally {
    INK = null;
  }
  const pageFns = emitted.map((e) => e.fn).join("\n\n");
  const customFns = emitted.map((e) => e.customFns).filter(Boolean).join("\n\n");
  // Fonts load in CardInterface's hook scope. Page functions are module-level
  // components, so their styles must receive those resolved values as props.
  const fontProps = faces.length ? ` fonts={[${faces.map((_, i) => `__font${i}`).join(", ")}]}` : "";
  // Pages that step aside by themselves: an opening screen that gives way to
  // the chat once the player has started. Emitted only when a page asks, so a
  // card without one compiles byte-for-byte as before.
  const pageIdSet = new Set(pages.map((p) => p.id));
  const leaves = pages.filter((p) =>
    p.leaveWhen && typeof p.leaveWhen === "object" && p.leaveWhen.when
    && pageIdSet.has(p.leaveWhen.pageId) && p.leaveWhen.pageId !== p.id);
  const leaveTable = leaves.length
    ? `/** Pages that give way by themselves once their condition holds. */
const PAGE_LEAVE = {
${leaves.map((p) => `  ${s(p.id)}: function (api, vars) { return ${conditionExpr(p.leaveWhen!.when)} ? ${s(p.leaveWhen!.pageId)} : null; },`).join("\n")}
};

`
    : "";
  const leaveLines = leaves.length
    ? `  // Never in the editor: a creator arranging the opening page must be able
  // to stay on it after the chat has started.
  const __leave = PAGE_LEAVE[page];
  const __to = __leave && !editorGhosts() ? __leave(api, vars) : null;
  const __page = __to || page;
  React.useEffect(function () { if (__page !== page) go(__page); }, [__page, page]);
`
    : "";
  const pageVar = leaves.length ? "__page" : "page";
  const pageSwitch = pages
    .map((page, i) => `        {${pageVar} === ${s(page.id)} ? <Page${i} api={api} vars={vars} go={go} __m={__m}${fontProps} /> : null}`)
    .join("\n");

  // The page's own ground, full-bleed behind the scaled canvas. The canvas is
  // a fixed 1024×640 (or 375-wide) design scaled to fit; on any screen not of
  // exactly that shape the rest of the stage was bare, and every page sat in
  // a band between two dark bars. A colour (or gradient) fills the stage; a
  // picture fills it too, softened, so the sharp one stays the canvas's.
  const backdropSwitch = pages
    .map((page) => {
      const bg = page.background;
      if (bg?.kind === "color" && bg.color) return `      {${pageVar} === ${s(page.id)} ? <div style={{ position: "absolute", inset: 0, background: ${s(bg.color)} }} /> : null}`;
      if (bg?.kind === "image") return `      {${pageVar} === ${s(page.id)} ? <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}><div style={{ position: "absolute", inset: -32, filter: "blur(22px) brightness(0.72)" }}><Img src={${imageExpr(bg.src)}} fit="cover" /></div></div> : null}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");

  // Fonts load through the platform's own loader, which scopes the family name
  // per asset so two cards shipping different files under one family cannot
  // collide. The call count is fixed at compile time, so hook order is stable.
  const fontLines = faces
    .map(
      (face, i) =>
        `  const __font${i} = typeof useAssetFont === "function" ? useAssetFont(${s(face.ref)}, { family: ${s(face.family)}, fallback: ${s(face.fallback ?? "inherit")}, weight: ${n(face.weight, 400)}, style: ${s(face.style ?? "normal")} }) : ${s(face.fallback ?? "inherit")};`
    )
    .join("\n");

  // Picked web fonts (see fonts.ts for why they load on the document head).
  const webFontHref = webFontsHref(doc);

  const source = `${GENERATED_HEADER}
${baseFile ? `\nimport __Base from ${s("./" + baseFile)};\n` : ""}
const DESIGN_W = ${UI_CANVAS_W};
const DESIGN_H = ${designH};
const DESKTOP_W = ${UI_DESKTOP_W};
const DESKTOP_H = ${desktopH};
const PAGE_IDS = ${JSON.stringify(pages.map((p) => p.id))};
const EDITOR_SAMPLES = ${editorSamplesJson(doc.editorSamples)};

/**
 * The page the visual editor is looking at. The editor previews a card in the
 * same window (a shadow root, not an iframe) and remounts it on every edit, so
 * without this an edit made on page 2 would throw the preview back to page 1.
 * A played card runs in its own iframe where none of this is ever set, and it
 * opens on the entry page as it always has.
 */
function editorPage(ids) {
  try {
    const id = typeof window !== "undefined" ? window.__yuminaUiEditPage : null;
    return typeof id === "string" && ids.indexOf(id) >= 0 ? id : null;
  } catch (_e) { return null; }
}

function followEditorPage(ids, setPage, redraw) {
  if (typeof window === "undefined") return undefined;
  const onPage = function (event) {
    const id = event && event.detail;
    if (typeof id === "string" && ids.indexOf(id) >= 0) setPage(id);
    // The editor also flips whether hidden parts show faded; a redraw is how
    // an already-mounted card notices.
    redraw(function (n) { return n + 1; });
  };
  window.addEventListener("yumina:ui-edit-page", onPage);
  return function () { window.removeEventListener("yumina:ui-edit-page", onPage); };
}

/** True only inside the visual editor, which sets the flag while it is open. */
function editorGhosts() {
  try { return typeof window !== "undefined" && window.__yuminaUiEditing === true; } catch (_e) { return false; }
}

/** In the editor, an empty variable reads as its sample (a bag with two
 *  things in it); in play, never. */
function withEditorSamples(vars) {
  if (!EDITOR_SAMPLES || !editorGhosts()) return vars;
  let out = null;
  for (const key in EDITOR_SAMPLES) {
    const now = vars[key];
    const empty = now === undefined || now === null || now === "" || (Array.isArray(now) && now.length === 0);
    if (!empty) continue;
    if (!out) out = Object.assign({}, vars);
    out[key] = EDITOR_SAMPLES[key];
  }
  return out || vars;
}

/**
 * Which canvas the visual editor is arranging, when it says. The stage
 * otherwise picks by the shape of its box, and in a narrow editor column the
 * PHONE canvas can sit in a box wider than it is tall — the editor asked for
 * the phone and got the desktop, drawn at a third of its size. A played card
 * never sees the flag and keeps choosing by shape.
 */
function editorCanvas() {
  try {
    if (typeof window === "undefined" || window.__yuminaUiEditing !== true) return null;
    const c = window.__yuminaUiEditCanvas;
    return c === "phone" || c === "desktop" ? c : null;
  } catch (_e) { return null; }
}

/** Tells the editor a button changed the page, so its page picker follows. */
function announcePage(id) {
  try {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("yumina:ui-page-shown", { detail: id }));
  } catch (_e) {}
}

/** Live variable bag is keyed by variable id (GameStateManager resolves an id
 *  first and only then falls back to a display name), so bindings travel as ids
 *  and survive a rename. */
function readVar(vars, id) {
  if (!vars) return undefined;
  return vars[id];
}

/** Which box an element occupies on the canvas in force. A desktop box of null
 *  takes the element off the wide canvas entirely; an absent one means it sits
 *  in the same place on both. */
function __box(mode, phone, desktop) {
  if (mode !== "desktop") return phone;
  if (desktop === null) return { display: "none" };
  return desktop || phone;
}

${usesComposer(pages) ? `${COMPOSER_RUNTIME}

` : ""}function readNumber(vars, id, fallback) {
  const raw = readVar(vars, id);
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function resolveMaybe(api, vars, id, fallback) {
  const raw = readVar(vars, id);
  const ref = typeof raw === "string" && raw ? raw : fallback;
  if (!ref) return null;
  return api.resolveAssetUrl ? api.resolveAssetUrl(ref) : ref;
}

function interpolate(vars, template) {
  if (!template) return "";
  return String(template).replace(/\\{\\{\\s*([^}]+?)\\s*\\}\\}/g, function (_m, key) {
    const value = readVar(vars, String(key).trim());
    return value === undefined || value === null ? "" : String(value);
  });
}

/** A list row's own tokens, resolved BEFORE the ordinary {{var}} pass:
 *  {{item}} is the row itself, {{item.field.sub}} walks into it, {{index}} is
 *  1-based because it faces the player. Missing fields become "" — a template
 *  should never print its own plumbing. */
function itemText(template, item, index) {
  let out = String(template).replace(/\\{\\{\\s*item((?:\\.[\\w$]+)*)\\s*\\}\\}/g, function (_m, path) {
    // A list of plain words ("钥匙") drawn by a card that expects records:
    // the word is its name.
    if ((path === ".name" || path === ".title") && item !== null && typeof item !== "object") return String(item);
    let value = item;
    if (path) {
      const segs = path.slice(1).split(".");
      for (let i = 0; i < segs.length; i++) {
        if (value === null || value === undefined) break;
        value = value[segs[i]];
      }
    }
    if (value === null || value === undefined) return "";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  });
  out = out.replace(/\\{\\{\\s*index\\s*\\}\\}/g, String(index + 1));
  return out;
}

function looseEq(a, b) {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a) === String(b);
}

function contains(haystack, needle) {
  if (Array.isArray(haystack)) return haystack.some(function (item) { return looseEq(item, needle); });
  if (haystack === null || haystack === undefined) return false;
  return String(haystack).indexOf(String(needle)) !== -1;
}

function pct(value, min, max) {
  const span = max - min;
  if (!Number.isFinite(span) || span === 0) return 0;
  const ratio = ((value - min) / span) * 100;
  return Math.max(0, Math.min(100, ratio));
}

/** One background layer for an image. JSON.stringify quotes the URL, which is
 *  also the escaping — a ref carrying a quote cannot end the url() early. */
function imageLayer(url, fit, repeat) {
  if (!url) return null;
  const size = fit === "contain" ? "contain" : fit === "fill" ? "100% 100%" : "cover";
  return "url(" + JSON.stringify(String(url)) + ") center/" + size + (repeat ? " repeat" : " no-repeat");
}

/** Stacked backgrounds as one value; undefined when nothing paints, so React
 *  leaves the property alone rather than writing an empty string. */
function bg(layers) {
  const parts = [];
  for (let i = 0; i < layers.length; i++) if (layers[i]) parts.push(layers[i]);
  return parts.length ? parts.join(", ") : undefined;
}

/** The last thing the AI said. Buttons that regenerate or copy act on this,
 *  because a document written before the conversation existed cannot name a
 *  message id. */
function lastAssistant(api) {
  const msgs = (api && api.messages) || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i] && msgs[i].role === "assistant") return msgs[i];
  }
  return null;
}

/** Has the player sent anything in this session yet. Drives the built-in
 *  "还没开始聊" condition that opening pickers hide themselves with. */
function chatStarted(api) {
  const msgs = (api && api.messages) || [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i] && msgs[i].role === "user") return true;
  }
  return false;
}

/** Wait for a button step to finish: on its promise when it returns one,
 *  otherwise for ms milliseconds (0 = not at all). */
function settle(result, ms, cap) {
  if (result && typeof result.then === "function") {
    // A host that promised an answer and never gave one does not get to
    // freeze the button: past the cap, the next step runs anyway.
    if (!cap) return result;
    return Promise.race([result, new Promise(function (resolve) { setTimeout(resolve, cap); })]);
  }
  if (!ms) return undefined;
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/** Whether a variable holds something. Empty text, an empty list, an empty
 *  record, null and false are all "not filled yet"; 0 is a real number. */
function filled(value) {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** A list's rows from the card's own entries: one role (the characters) or
 *  one folder, each row the entry's name, picture and, for an entry the
 *  player may read, its first line. What was written only for the AI never
 *  reaches a row. */
function entryRows(api, role, folderId) {
  const list = (api && api.entries) || [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e || e.enabled === false || e.role === "greeting") continue;
    if (role && e.role !== role) continue;
    if (folderId && e.folderId !== folderId) continue;
    const first = e.audience === "ai" ? "" : String(e.content || "").trim().split("\\n")[0].slice(0, 80);
    out.push({ id: e.id, title: e.name || "", body: first, image: e.portrait || "" });
  }
  return out;
}

/** A button's 「这些填好了才能按」. */
function hasAll(vars, ids) {
  for (let i = 0; i < ids.length; i++) if (!filled(readVar(vars, ids[i]))) return false;
  return true;
}

function canActOnLast(api) {
  if (!api || api.isStreaming) return false;
  return !!lastAssistant(api);
}

/** Back to before the last exchange. revertToMessage takes the id of the
 *  message to return TO, which is the player's own last turn. */
function rewindLast(api) {
  const list = (api && api.messages) || [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] && list[i].role === "user") {
      if (typeof api.revertToMessage === "function") api.revertToMessage(list[i].id);
      return;
    }
  }
}

/** A behaviour the creator wrote, set off by name: the same \`action:fired\`
 *  a card's own code sends. It waits for the behaviour to be applied when the
 *  host can say so; a view with no game behind it (the editor's preview)
 *  refuses, and the button goes on to its next step. */
function runBehavior(api, id, params) {
  try {
    const result = api && typeof api.executeActionAndWait === "function"
      ? api.executeActionAndWait(id, params)
      : api && typeof api.executeAction === "function" ? api.executeAction(id) : undefined;
    return result && typeof result.then === "function" ? result.catch(function () {}) : result;
  } catch (e) {
    return undefined;
  }
}

function regenerateLast(api) {
  if (!canActOnLast(api) || !api.regenerateMessage) return;
  api.regenerateMessage(lastAssistant(api).id);
}

function copyLast(api) {
  if (!canActOnLast(api) || !api.copyToClipboard) return;
  api.copyToClipboard(lastAssistant(api).content);
}

/** Images fade in on load. An @asset ref resolves through a redirect, and a
 *  visible <img> with a not-yet-resolved src paints as a black rectangle —
 *  cards shipped that way before. Resetting on src change matters as much as
 *  the reveal: the same element reused for a new background would otherwise
 *  stay hidden behind a stale "ready". */
/**
 * Sources that have finished loading at least once on this page.
 *
 * It lives on the window because the card's MODULE does not survive: editing
 * anything recompiles it, and a fresh module means fresh module state. The set
 * is what lets a remount tell "this picture is already here" apart from "this
 * picture is on its way".
 */
var imgSeen = (function () {
  var scope = typeof window !== "undefined" ? window : globalThis;
  if (!scope.__ycImgSeen) scope.__ycImgSeen = {};
  return scope.__ycImgSeen;
})();

function Img({ src, fit }) {
  // The fade is for art that is still arriving, and ONLY for that.
  //
  // Every recompile remounts the whole card, so a picture that starts from
  // transparent starts from transparent again on every keystroke: change a
  // colour in the editor and the portrait blinks, once per press. Asking the
  // element whether it is complete does not help — a cached image reports
  // false at the moment its src is assigned — so remember the source instead.
  const [ready, setReady] = React.useState(function () { return !!src && !!imgSeen[src]; });
  React.useEffect(function () { setReady(!!src && !!imgSeen[src]); }, [src]);
  if (!src) return null;
  return (
    <img
      key={src}
      src={src}
      alt=""
      draggable={false}
      onLoad={() => { imgSeen[src] = true; setReady(true); }}
      style={{
        width: "100%",
        height: "100%",
        objectFit: fit || "cover",
        opacity: ready ? 1 : 0,
        transition: "opacity 220ms ease",
      }}
    />
  );
}

/**
 * A video clip in an image frame. Muted loops autoplay (browsers allow that);
 * a clip with sound starts muted and unmutes on the player's first tap
 * anywhere, since a page may not start sound by itself. Remounts on every
 * recompile like Img does, so it keeps no state worth losing.
 */
function Vid({ src, fit, loop, sound }) {
  const ref = React.useRef(null);
  React.useEffect(function () {
    const el = ref.current;
    if (!el || !sound) return;
    const unmute = function () { el.muted = false; el.play().catch(function () {}); };
    window.addEventListener("pointerdown", unmute, { once: true });
    return function () { window.removeEventListener("pointerdown", unmute); };
  }, [src, sound]);
  if (!src) return null;
  return (
    <video
      key={src}
      ref={ref}
      src={src}
      autoPlay
      muted
      loop={loop}
      playsInline
      preload="auto"
      style={{ width: "100%", height: "100%", objectFit: fit || "cover", display: "block" }}
    />
  );
}

/** Markdown text. The host's renderer sanitises (DOMPurify); without it the
 *  same string renders as plain text rather than as innerHTML. */
function Markdown({ api, text, style, elId }) {
  const html = api.renderMarkdown ? api.renderMarkdown(text) : null;
  if (html === null) return <div data-ui-el={elId} style={style}>{text}</div>;
  return <div data-ui-el={elId} style={style} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** A thrown render inside one hand-written block takes down that block, not the
 *  card. The rest of the interface is still the creator's arrangement and is
 *  still worth showing. */
class ElBoundary extends React.Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) {
      return <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "rgba(255,255,255,0.5)" }}>—</div>;
    }
    return this.props.children;
  }
}

/** The stage scales to whatever box it lands in, preserving aspect, so the
 *  arrangement the creator made is the arrangement every player sees. */
function useStageScale() {
  const ref = React.useRef(null);
  const [box, setBox] = React.useState({ scale: 1, mode: "phone" });
  // Before paint, not after.
  //
  // The first render has to guess, and it guesses phone. With a plain effect
  // that guess is PAINTED: every mount shows one frame of the phone layout
  // before the measurement corrects it — and in the editor every keystroke
  // remounts the card, so arranging a desktop layout meant watching it snap
  // to a phone and back. A layout effect runs in the same frame as the render
  // that caused it, so nobody ever sees the guess.
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      // Which canvas fits the window better, measured rather than guessed from
      // a breakpoint: a tall narrow box is a phone whatever its pixel width,
      // and a short wide one is a desktop even in a small window. The tie goes
      // to the phone so a near-square box does not flicker between the two.
      const mode = editorCanvas() || (rect.width / rect.height > 1.15 ? "desktop" : "phone");
      const w = mode === "desktop" ? DESKTOP_W : DESIGN_W;
      const h = mode === "desktop" ? DESKTOP_H : DESIGN_H;
      setBox({ scale: Math.min(rect.width / w, rect.height / h), mode: mode });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // The editor flips canvases without the box changing size.
    window.addEventListener("yumina:ui-edit-page", measure);
    return () => { observer.disconnect(); window.removeEventListener("yumina:ui-edit-page", measure); };
  }, []);
  return [ref, box.scale, box.mode];
}

${webFontHref ? `${WEB_FONT_HOOK}

` : ""}${usesParts(pages) ? `${PARTS_RUNTIME}

` : ""}${customFns ? `${customFns}

` : ""}${leaveTable}${topBandTable}${pageFns}

export default function CardInterface() {
  const api = useYumina();
  const vars = withEditorSamples(api.variables || {});
  const [page, setPage] = React.useState(function () { return editorPage(PAGE_IDS) || ${s(pages[entryIndex]?.id ?? pages[0]!.id)}; });
  const go = React.useCallback((next) => { setPage(next); announcePage(next); }, []);
  const [, redraw] = React.useState(0);
  React.useEffect(function () { return followEditorPage(PAGE_IDS, setPage, redraw); }, []);
${leaveLines}  const [stageRef, scale, __m] = useStageScale();
  const __w = __m === "desktop" ? DESKTOP_W : DESIGN_W;
  const __h = __m === "desktop" ? DESKTOP_H : DESIGN_H;
${fontLines ? `${fontLines}\n` : ""}${webFontHref ? `  useWebFonts(${s(webFontHref)});\n` : ""}
  return (
    <div ref={stageRef} data-ui-stage="" style={${stageRootStyle(doc, ink)}}>
      <style>{${s(buildStylesheet(doc, ink) + (hasBase ? BASE_POINTER_RULE : ""))}}</style>
${backdropSwitch ? `${backdropSwitch}\n` : ""}${hasBase ? `      <div style={${topBands.length
        // The canvas is centred on the stage, so a bar's bottom edge sits at
        // half the stage minus (half the canvas minus the bar) at this scale.
        ? `{ position: "absolute", left: 0, right: 0, bottom: 0, top: (function () { var __b = CHAT_TOP_BAND[${pageVar}]; var __t = __b ? (__m === "desktop" ? __b.desktop : __b.phone) : 0; return __t ? "max(0px, calc(50% - " + ((__h / 2 - __t) * scale) + "px))" : 0; })() }`
        : `{ position: "absolute", inset: 0 }`}}>
        ${baseLayer}
      </div>
      <div style={{ position: "absolute", inset: 0, zIndex: 1, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
        <div style={{ position: "relative", width: __w, height: __h, transform: "scale(" + scale + ")", transformOrigin: "center center", flex: "0 0 auto", pointerEvents: "none" }}>
${pageSwitch}
        </div>
      </div>` : `      <div style={{ position: "relative", zIndex: 1, width: __w, height: __h, transform: "scale(" + scale + ")", transformOrigin: "center center", flex: "0 0 auto" }}>
${pageSwitch}
      </div>`}
    </div>
  );
}
`;

  const files: Record<string, string> = { "index.tsx": source };

  // Style knobs decomposed out of the base code. The base file reads
  // `import K from "./_knobs"` — regenerating THIS file is how a knob edit
  // reaches the player without the base code being touched again. Values are
  // JSON literals: a hostile string stays a string.
  //
  // Emitted whenever a base exists, even with no groups yet: a decomposition
  // in progress (code rewritten, groups not yet installed) must degrade to
  // undefined knob values, never to a missing-module white screen.
  if (baseFile) {
    const lines: string[] = [];
    for (const group of doc.base?.groups ?? []) {
      if (!group || !Array.isArray(group.knobs)) continue;
      for (const knob of group.knobs) {
        if (!knob || typeof knob.id !== "string") continue;
        const value = typeof knob.value === "number" && Number.isFinite(knob.value) ? knob.value : String(knob.value ?? "");
        lines.push(`  ${JSON.stringify(knob.id)}: ${JSON.stringify(value)},`);
      }
    }
    files["_knobs.tsx"] = `${GENERATED_HEADER}
/** Style knobs the visual editor decomposed out of the base frontend.
 *  The base code reads these instead of hardcoding its visual constants. */
const K = {
${lines.join("\n")}
};
export default K;
`;
  }

  return { entryFile: "index.tsx", files };
}

/** The stage root carries the theme tokens, which is how a card restyles the
 *  platform's own chat components: they read `var(--yc-*, <original>)`, so a
 *  token set here reaches inside them and an absent token leaves them exactly
 *  as they render today. */
function stageRootStyle(doc: UiDoc, ink?: InkPlan): string {
  const tokens = tokenStyle(doc, ink);
  // `--yc-bg` is the one token whose target is the stage itself rather than
  // something inside it, so it is painted here instead of through TOKEN_RULES.
  // A theme needs it: the platform's chat is transparent, and without a ground
  // of its own a light theme's dark text lands on the app's dark background.
  const painted = doc.theme?.tokens && ("--yc-bg" in doc.theme.tokens || "yc-bg" in doc.theme.tokens)
    ? `, background: "var(--yc-bg)"` : "";
  const base = `{ position: "relative", width: "100%", height: "100%", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center"${painted} }`;
  return tokens === "{  }" ? base : `{ ...${base}, ...${tokens} }`;
}
