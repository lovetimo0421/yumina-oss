import type { WorldEntry } from "../types/index.js";
import type {
  UiBoxStyle,
  UiDoc,
  UiElement,
  UiFill,
  UiMessageMatch,
  UiMessageRule,
  UiMessageShow,
  UiMessageStyle,
  UiTextStyle,
} from "./types.js";

/**
 * The message layer: written conventions in a reply, drawn differently.
 *
 * Everything here is pure and framework-free — the sandbox's React renderer
 * (sandbox/chat/designed-message.tsx) draws what `layoutMessage` decides, the
 * Studio preview draws the same thing off the same function, and the editor
 * and the Studio agent keep the AI's instructions in step through
 * `syncMessageRulesEntry`. One decision, three consumers.
 *
 * Two properties the layout holds no matter what the model writes:
 *
 *  - **Nothing becomes markup.** The output is plain strings sorted into
 *    blocks; the renderer escapes them (React text) or passes them through the
 *    chat's own sanitising markdown pipeline. A rule can change where a piece
 *    of text is drawn, never what it is allowed to be.
 *  - **Streaming never lays out a half-written marker.** An opened ♡ with no
 *    closing ♡ yet is a pending cover, not a paragraph that jumps into a cover
 *    two tokens later; a banner line still being written is held back until it
 *    closes; a dangling `<th` of a `<think>` marker is not shown.
 */

// ── Layout ─────────────────────────────────────────────────────────────────

export type MsgInline =
  | { kind: "text"; text: string }
  /** `n` counts this rule's covers in the message, so a remembered reveal
   *  survives the message being re-laid-out. `pending`: still being written. */
  | { kind: "reveal"; ruleId: string; n: number; text: string; pending?: boolean };

export type MsgBlock =
  | { kind: "text"; parts: MsgInline[] }
  | { kind: "banner"; ruleId: string; text: string }
  | { kind: "choices"; ruleId: string; items: string[] }
  | { kind: "speaker"; ruleId: string; name: string; parts: MsgInline[] };

export interface MessageLayout {
  /** The whole message is drawn as this rule's card. */
  card: { ruleId: string; title: string } | null;
  blocks: MsgBlock[];
  /** Whether any rule touched the text — an untouched message can take the
   *  plain markdown path unchanged. */
  touched: boolean;
}

export interface LayoutOptions {
  role: "assistant" | "user" | "system";
  streaming?: boolean;
}

const LINE_SHOWS = new Set<UiMessageShow>(["banner", "choices", "speaker"]);

/** A rule that can run: enabled, for this role, with a match that is whole. */
export function activeRules(rules: UiMessageRule[] | undefined, role: LayoutOptions["role"]): UiMessageRule[] {
  if (!Array.isArray(rules) || role === "system") return [];
  return rules.filter((r) =>
    r && typeof r.id === "string" && r.enabled !== false && matchIsUsable(r.match)
    && (role === "assistant" || r.options?.applyToUser === true));
}

function matchIsUsable(m: UiMessageMatch | undefined): boolean {
  if (!m || typeof m !== "object") return false;
  switch (m.kind) {
    case "wrap": return typeof m.open === "string" && m.open !== "" && typeof m.close === "string" && m.close !== "";
    case "line-prefix": return typeof m.prefix === "string" && m.prefix.trim() !== "";
    case "contains": return typeof m.text === "string" && m.text !== "";
    case "regex": return compileRegex(m, false) !== null;
    default: return false;
  }
}

/** Patterns are creator input and are compiled per message: a pattern that
 *  does not compile is a rule that does nothing, never a thrown render. */
const regexCache = new Map<string, RegExp | null>();
function compileRegex(m: { pattern: string; flags?: string }, global: boolean): RegExp | null {
  if (typeof m.pattern !== "string" || !m.pattern) return null;
  const flags = (typeof m.flags === "string" ? m.flags.replace(/[^imsu]/g, "") : "") + (global ? "g" : "");
  const key = `${flags}\u0000${m.pattern}`;
  if (regexCache.has(key)) {
    const cached = regexCache.get(key)!;
    if (cached) cached.lastIndex = 0;
    return cached;
  }
  let re: RegExp | null = null;
  try {
    re = new RegExp(m.pattern, flags.includes("u") ? flags : flags + "u");
  } catch {
    try { re = new RegExp(m.pattern, flags); } catch { re = null; }
  }
  if (regexCache.size > 200) regexCache.clear();
  regexCache.set(key, re);
  return re;
}

/** Every match of a global regex, guarded against the zero-length match that
 *  would otherwise spin forever. */
function regexMatches(re: RegExp, text: string): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(text)) !== null && guard++ < 500) {
    if (m[0] === "") { re.lastIndex++; continue; }
    out.push(m);
  }
  return out;
}

/** The first capture group that caught something, else the whole match. */
const firstGroup = (m: RegExpExecArray) => m.slice(1).find((g) => typeof g === "string" && g !== "") ?? m[0];

/** The text a line-oriented or card match stands for. Markdown emphasis is
 *  dropped: a banner or a button label is drawn as plain text. */
const plain = (text: string) => text.replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1").trim();

/** Does the text END with the first part of a marker (`<th` of `<think>`)?
 *  While streaming that tail is a marker on its way, not prose. */
function trailingPartial(text: string, marker: string): number {
  for (let len = Math.min(marker.length - 1, text.length); len > 0; len--) {
    if (text.endsWith(marker.slice(0, len))) return len;
  }
  return 0;
}

interface Span { start: number; end: number; order: number; rule: UiMessageRule; text: string; pending?: boolean }

/** Where a span rule (reveal, hide) finds its text in `text`. */
function spanMatches(rule: UiMessageRule, order: number, text: string, streaming: boolean): Span[] {
  const m = rule.match;
  const out: Span[] = [];
  switch (m.kind) {
    case "wrap": {
      let from = 0;
      while (from < text.length) {
        const open = text.indexOf(m.open, from);
        if (open === -1) break;
        const innerStart = open + m.open.length;
        const close = text.indexOf(m.close, innerStart);
        if (close === -1) {
          // Unclosed. Mid-stream it is a marker still being written, so it
          // covers what has arrived; a finished reply that never closed it
          // keeps the text as written rather than eating the rest.
          if (streaming) out.push({ start: open, end: text.length, order, rule, text: text.slice(innerStart), pending: true });
          break;
        }
        out.push({ start: open, end: close + m.close.length, order, rule, text: text.slice(innerStart, close) });
        from = close + m.close.length;
      }
      break;
    }
    case "line-prefix": {
      let at = 0;
      for (const line of text.split("\n")) {
        const lead = line.length - line.trimStart().length;
        if (line.trimStart().startsWith(m.prefix)) {
          out.push({ start: at + lead, end: at + line.length, order, rule, text: line.trimStart().slice(m.prefix.length).trim() });
        }
        at += line.length + 1;
      }
      break;
    }
    case "contains": {
      let from = 0;
      while (from <= text.length) {
        const i = text.indexOf(m.text, from);
        if (i === -1) break;
        out.push({ start: i, end: i + m.text.length, order, rule, text: m.text });
        from = i + m.text.length;
      }
      break;
    }
    case "regex": {
      const re = compileRegex(m, true);
      if (!re) break;
      for (const hit of regexMatches(re, text)) {
        out.push({ start: hit.index, end: hit.index + hit[0].length, order, rule, text: firstGroup(hit) });
      }
      break;
    }
  }
  return out;
}

/** Earlier position first; at the same position the earlier rule wins; a span
 *  overlapping one already taken is dropped. Deterministic, and it means the
 *  creator's rule order is the tie-breaker they can see and change. */
function pickSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.order - b.order || b.end - a.end);
  const taken: Span[] = [];
  let reach = -1;
  for (const s of sorted) {
    if (s.start < reach) continue;
    taken.push(s);
    reach = s.end;
  }
  return taken;
}

/** Remove what the hide rules match. */
function applyHides(text: string, rules: UiMessageRule[], streaming: boolean): { text: string; touched: boolean } {
  const spans = pickSpans(rules.flatMap((r, i) => spanMatches(r, i, text, streaming)));
  if (spans.length === 0) return { text, touched: false };
  let out = "";
  let at = 0;
  for (const s of spans) {
    out += text.slice(at, s.start);
    at = s.end;
    // A hidden whole line takes its line break with it.
    if (s.rule.match.kind === "line-prefix" && text[at] === "\n") at++;
  }
  out += text.slice(at);
  return { text: out.replace(/\n{3,}/g, "\n\n"), touched: true };
}

/** The first card rule that matches, and the text without its marker. */
function findCard(text: string, rules: UiMessageRule[], streaming: boolean): { card: MessageLayout["card"]; text: string } {
  for (const rule of rules) {
    const m = rule.match;
    const title = rule.options?.title;
    if (m.kind === "contains") {
      const i = text.indexOf(m.text);
      if (i === -1) continue;
      return { card: { ruleId: rule.id, title: title ?? plain(m.text) }, text: text.slice(0, i) + text.slice(i + m.text.length) };
    }
    if (m.kind === "line-prefix") {
      const lines = text.split("\n");
      const idx = lines.findIndex((l) => l.trimStart().startsWith(m.prefix));
      if (idx === -1) continue;
      const rest = lines[idx]!.trimStart().slice(m.prefix.length).trim();
      lines.splice(idx, 1);
      return { card: { ruleId: rule.id, title: title ?? plain(rest) }, text: lines.join("\n") };
    }
    if (m.kind === "wrap") {
      const open = text.indexOf(m.open);
      if (open === -1) continue;
      const close = text.indexOf(m.close, open + m.open.length);
      if (close === -1 && !streaming) continue;
      // The markers go, what they held stays: the card IS the wrapped text.
      const inner = close === -1 ? text.slice(open + m.open.length) : text.slice(open + m.open.length, close);
      const after = close === -1 ? "" : text.slice(close + m.close.length);
      return { card: { ruleId: rule.id, title: title ?? "" }, text: text.slice(0, open) + inner + after };
    }
    if (m.kind === "regex") {
      const re = compileRegex(m, false);
      const hit = re ? re.exec(text) : null;
      if (!hit || hit[0] === "") continue;
      const group = hit.slice(1).find((g) => typeof g === "string" && g !== "");
      return {
        card: { ruleId: rule.id, title: title ?? (group ? plain(group) : "") },
        text: text.slice(0, hit.index) + text.slice(hit.index + hit[0].length),
      };
    }
  }
  return { card: null, text };
}

type LineHit = { rule: UiMessageRule; text: string; name?: string } | "hold" | "drop" | null;

/** Speaker lines: 「名字：台词」 and 「【名字】台词」 are the shapes the regex
 *  preset reads; a prefix rule reads `@名字 台词` the same way. */
function splitName(rest: string): { name: string; text: string } | null {
  const m = /^\s*(?:【([^】]{1,24})】|([^\s：:]{1,24})\s*[：:])\s*(.*)$/u.exec(rest);
  if (!m) return null;
  const name = (m[1] ?? m[2] ?? "").trim();
  return name ? { name, text: m[3] ?? "" } : null;
}

function lineHit(rule: UiMessageRule, line: string, streamingTail: boolean): LineHit {
  const m = rule.match;
  const trimmed = line.trim();
  if (!trimmed) return null;
  let text: string | null = null;
  let name: string | undefined;
  switch (m.kind) {
    case "wrap":
      // A banner or a choice drawn from a wrap is a line that IS the wrap —
      // so 【第3天】 is a banner and 【艾拉】你好 is left for the speaker rule.
      if (trimmed.startsWith(m.open)) {
        if (trimmed.length >= m.open.length + m.close.length && trimmed.endsWith(m.close)) {
          text = trimmed.slice(m.open.length, trimmed.length - m.close.length);
        } else if (streamingTail && !trimmed.slice(m.open.length).includes(m.close)) {
          return "hold";
        }
      }
      break;
    case "line-prefix":
      if (trimmed.startsWith(m.prefix)) text = trimmed.slice(m.prefix.length);
      break;
    case "contains":
      if (trimmed.includes(m.text)) text = rule.show === "speaker" ? trimmed.replace(m.text, "") : trimmed;
      if (rule.show === "speaker" && text !== null) name = m.text;
      break;
    case "regex": {
      const re = compileRegex(m, false);
      const hit = re ? re.exec(trimmed) : null;
      if (!hit || hit[0] === "") break;
      const groups = hit.slice(1).filter((g): g is string => typeof g === "string" && g !== "");
      if (rule.show === "speaker") {
        if (groups.length >= 2) { name = groups[0]; text = groups[groups.length - 1]!; }
        else if (groups.length === 1) { name = groups[0]; text = trimmed.slice(hit.index + hit[0].length); }
        else { name = hit[0]; text = trimmed.slice(hit.index + hit[0].length); }
      } else {
        text = groups[0] ?? hit[0];
      }
      break;
    }
  }
  if (text === null) return null;
  if (rule.show === "speaker") {
    if (name === undefined) {
      const split = splitName(text);
      if (!split) return null;
      name = split.name;
      text = split.text;
    }
    name = plain(name);
    if (!name || name.length > 24) return null;
    return { rule, name, text: text.trim() };
  }
  const shown = plain(text);
  return shown ? { rule, text: shown } : m.kind === "wrap" || m.kind === "line-prefix" ? "drop" : null;
}

/** A tail that could still become a marker: `※` arriving one character of `※※`. */
function isMarkerTail(line: string, rules: UiMessageRule[]): boolean {
  const t = line.trim();
  if (!t) return false;
  return rules.some((r) => {
    const marker = r.match.kind === "line-prefix" ? r.match.prefix : r.match.kind === "wrap" ? r.match.open : "";
    return marker.length > t.length && marker.startsWith(t);
  });
}

/**
 * Lay a message out under a set of rules.
 *
 * Order: hide rules strip first (a meta line never becomes a banner); a card
 * rule then claims the whole message; line rules (banner, choices, speaker)
 * sort lines; reveal rules finally cover spans inside the prose and inside
 * speaker lines. The earlier rule wins wherever two claim the same text.
 */
export function layoutMessage(content: string, rules: UiMessageRule[] | undefined, opts: LayoutOptions): MessageLayout {
  const streaming = opts.streaming === true;
  const active = activeRules(rules, opts.role);
  let text = String(content ?? "").replace(/\r\n?/g, "\n");
  if (active.length === 0) return { card: null, blocks: [{ kind: "text", parts: [{ kind: "text", text }] }], touched: false };

  const hides = active.filter((r) => r.show === "hide");
  const cards = active.filter((r) => r.show === "card");
  const lineRules = active.filter((r) => LINE_SHOWS.has(r.show));
  const reveals = active.filter((r) => r.show === "reveal");

  let touched = false;
  if (hides.length) {
    const hidden = applyHides(text, hides, streaming);
    text = hidden.text;
    touched = hidden.touched;
  }
  const carded = findCard(text, cards, streaming);
  text = carded.text;
  if (carded.card) touched = true;

  // A marker's first characters at the very end of a stream are held back.
  if (streaming) {
    const markers = active.flatMap((r) =>
      r.match.kind === "wrap" ? [r.match.open] : r.match.kind === "line-prefix" ? [r.match.prefix] : []);
    let cut = 0;
    for (const marker of markers) cut = Math.max(cut, trailingPartial(text, marker));
    if (cut > 0) text = text.slice(0, text.length - cut);
  }

  const counters = new Map<string, number>();
  const inline = (chunk: string, tail: boolean): MsgInline[] => {
    const spans = pickSpans(reveals.flatMap((r, i) => spanMatches(r, i, chunk, streaming && tail)));
    if (spans.length === 0) return chunk ? [{ kind: "text", text: chunk }] : [];
    touched = true;
    const parts: MsgInline[] = [];
    let at = 0;
    for (const s of spans) {
      if (s.start > at) parts.push({ kind: "text", text: chunk.slice(at, s.start) });
      const n = counters.get(s.rule.id) ?? 0;
      counters.set(s.rule.id, n + 1);
      parts.push({ kind: "reveal", ruleId: s.rule.id, n, text: s.text, ...(s.pending ? { pending: true } : {}) });
      at = s.end;
    }
    if (at < chunk.length) parts.push({ kind: "text", text: chunk.slice(at) });
    return parts;
  };

  const lines = text.split("\n");
  const blocks: MsgBlock[] = [];
  let buffer: string[] = [];
  const flush = (tail: boolean) => {
    const chunk = buffer.join("\n").replace(/^\n+|\n+$/g, "");
    buffer = [];
    if (!chunk.trim()) return;
    blocks.push({ kind: "text", parts: inline(chunk, tail) });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const isTail = streaming && i === lines.length - 1;
    if (isTail && isMarkerTail(line, lineRules)) break;
    let hit: LineHit = null;
    for (const rule of lineRules) {
      hit = lineHit(rule, line, isTail);
      if (hit) break;
    }
    if (hit === "hold") break;
    // A bare marker with nothing after it (`※` alone) is dropped, not drawn.
    if (hit === "drop") { touched = true; continue; }
    if (!hit) {
      buffer.push(line);
      continue;
    }
    touched = true;
    const last = blocks[blocks.length - 1];
    // Blank lines between two choices do not split them into two groups.
    if (hit.rule.show === "choices" && last?.kind === "choices" && last.ruleId === hit.rule.id && buffer.every((l) => !l.trim())) {
      buffer = [];
      last.items.push(hit.text);
      continue;
    }
    flush(false);
    if (hit.rule.show === "banner") blocks.push({ kind: "banner", ruleId: hit.rule.id, text: hit.text });
    else if (hit.rule.show === "choices") blocks.push({ kind: "choices", ruleId: hit.rule.id, items: [hit.text] });
    else blocks.push({ kind: "speaker", ruleId: hit.rule.id, name: hit.name ?? "", parts: inline(hit.text, isTail) });
  }
  flush(true);

  return { card: carded.card, blocks, touched };
}

// ── Paint ──────────────────────────────────────────────────────────────────
//
// The same box and text vocabulary every other part takes, as a CSS object for
// a renderer that is not the compiler. Keys are React's camelCase.

export type CssObject = Record<string, string | number>;

function fillLayer(fill: UiFill, resolve: (ref: string) => string): string | null {
  switch (fill?.kind) {
    case "color":
      return typeof fill.color === "string" && fill.color ? fill.color : null;
    case "gradient": {
      const stops = (fill.stops ?? []).filter((st) => st && typeof st.color === "string");
      if (stops.length < 2) return null;
      const angle = Number.isFinite(fill.angle) ? fill.angle : 180;
      return `linear-gradient(${angle}deg, ${stops.map((st) => `${st.color} ${Number(st.at) || 0}%`).join(", ")})`;
    }
    case "image": {
      const ref = fill.src?.kind === "asset" ? fill.src.ref : "";
      if (!ref) return null;
      const size = fill.fit === "contain" ? "contain" : fill.fit === "fill" ? "100% 100%" : "cover";
      return `url(${JSON.stringify(resolve(ref))}) center/${size}${fill.repeat ? " repeat" : " no-repeat"}`;
    }
    default:
      return null;
  }
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function boxCss(style: UiBoxStyle | undefined, resolve: (ref: string) => string = (r) => r): CssObject {
  const out: CssObject = {};
  if (!style) return out;
  const layers = (style.fills ?? []).map((f) => fillLayer(f, resolve)).filter((l): l is string => !!l);
  if (layers.length) out.background = layers.join(", ");
  if (Array.isArray(style.radius)) out.borderRadius = style.radius.map((r) => `${Number(r) || 0}px`).join(" ");
  else if (num(style.radius)) out.borderRadius = style.radius;
  if (style.borderColor) out.border = `${num(style.borderWidth) ? style.borderWidth : 1}px ${style.borderStyle ?? "solid"} ${style.borderColor}`;
  if (style.shadows?.length) {
    out.boxShadow = style.shadows
      .map((sh) => `${sh.inset ? "inset " : ""}${Number(sh.x) || 0}px ${Number(sh.y) || 0}px ${Number(sh.blur) || 0}px${num(sh.spread) ? ` ${sh.spread}px` : ""} ${sh.color}`)
      .join(", ");
  }
  if (num(style.backdropBlur) && style.backdropBlur > 0) {
    out.backdropFilter = `blur(${style.backdropBlur}px)`;
    out.WebkitBackdropFilter = `blur(${style.backdropBlur}px)`;
  }
  if (num(style.padding)) out.padding = style.padding;
  return out;
}

export function textCss(style: UiTextStyle | undefined, fontMap?: Record<string, string>): CssObject {
  const out: CssObject = {};
  if (!style) return out;
  if (num(style.size)) out.fontSize = style.size;
  if (style.color) out.color = style.color;
  if (num(style.weight)) out.fontWeight = style.weight;
  if (style.family) out.fontFamily = fontMap?.[style.family] ?? style.family;
  if (num(style.letterSpacing)) out.letterSpacing = `${style.letterSpacing}px`;
  if (style.align) out.textAlign = style.align;
  if (num(style.lineHeight)) out.lineHeight = style.lineHeight;
  if (style.italic) out.fontStyle = "italic";
  if (style.transform) out.textTransform = style.transform;
  if (style.textShadow) {
    const sh = style.textShadow;
    out.textShadow = `${Number(sh.x) || 0}px ${Number(sh.y) || 0}px ${Number(sh.blur) || 0}px ${sh.color}`;
  }
  return out;
}

/** Speaker names that were not given a colour still get one, and the same
 *  name always gets the same one — a cast reads as a cast. */
const NAME_PALETTE = ["#f2a7c3", "#8ec5ff", "#f5c56b", "#9fe0b5", "#c6a8ff", "#ff9f8a", "#7fe0e0", "#e0b48a"];
export function speakerColor(name: string, colors?: Record<string, string>): string {
  const own = colors?.[name];
  if (own) return own;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return NAME_PALETTE[h % NAME_PALETTE.length]!;
}

// ── Where the design lives ───────────────────────────────────────────────────

type MessagePart = Extract<UiElement, { type: "chat" | "messages" }>;

const isMessagePart = (el: UiElement | undefined): el is MessagePart => el?.type === "chat" || el?.type === "messages";

/** Whether a messages/chat part draws its messages any differently. */
export function hasMessageDesign(el: UiElement): boolean {
  if (!isMessagePart(el)) return false;
  const style = el.messageStyle;
  const styled = !!style && Object.keys(style).some((k) => k !== "preset" && (style as Record<string, unknown>)[k] !== undefined);
  return styled || (Array.isArray(el.rules) && el.rules.length > 0);
}

/** Every rule on the card, first occurrence of an id winning — a card with a
 *  transcript on two pages usually shares one set. */
export function docMessageRules(doc: UiDoc | undefined): UiMessageRule[] {
  const out: UiMessageRule[] = [];
  const seen = new Set<string>();
  for (const page of doc?.pages ?? []) {
    for (const el of page?.elements ?? []) {
      if (!isMessagePart(el) || !Array.isArray(el.rules)) continue;
      for (const rule of el.rules) {
        if (!rule || typeof rule.id !== "string" || seen.has(rule.id)) continue;
        seen.add(rule.id);
        out.push(rule);
      }
    }
  }
  return out;
}

// ── Teaching the AI ──────────────────────────────────────────────────────────
//
// A rule that draws ♡…♡ as a cover is worth nothing if the model never writes
// ♡…♡. The rules are therefore also a set of instructions, kept as an ordinary
// lorebook entry (post-history, always sent) so the creator can see exactly
// what the AI is told, switch it off, or move it — and so the prompt pipeline
// needs to learn nothing new.

export const UI_RULES_ENTRY_ID = "ui-message-rules";
export const UI_RULES_ENTRY_TAG = "ui-rules";

type Lang = "zh" | "en";
const langOf = (lang: string | undefined): Lang => (lang && lang.toLowerCase().startsWith("zh") ? "zh" : "en");

function howToWrite(m: UiMessageMatch, lang: Lang): string {
  const zh = lang === "zh";
  switch (m.kind) {
    case "wrap": return zh ? `用 ${m.open}…${m.close} 包起来` : `wrap it in ${m.open}…${m.close}`;
    case "line-prefix": return zh ? `单独一行，以「${m.prefix}」开头` : `on its own line starting with "${m.prefix}"`;
    case "contains": return zh ? `在消息里写上「${m.text}」` : `include "${m.text}" in the message`;
    case "regex": return zh ? `按这个格式写：${m.pattern}` : `in this format: ${m.pattern}`;
  }
}

/** The sentence a rule teaches when the creator has not written their own. */
export function defaultAiHint(rule: UiMessageRule, lang?: string): string {
  const l = langOf(lang);
  const how = howToWrite(rule.match, l);
  const zh = l === "zh";
  switch (rule.show) {
    case "reveal":
      return zh ? `角色有没说出口的心里话时，${how}。` : `When a character has a thought they do not say aloud, ${how}.`;
    case "banner":
      return zh ? `场景或时间推进时，${rule.match.kind === "wrap" ? `单独一行，${how}` : how}。` : `When the scene or time moves on, ${rule.match.kind === "wrap" ? `on its own line, ${how}` : how}.`;
    case "choices":
      return zh ? `每次回复的结尾给玩家 2–4 个可选的行动，每个${rule.match.kind === "line-prefix" ? `单独一行，以「${rule.match.prefix}」开头` : how}。` : `End each reply with 2–4 actions the player could take, each ${rule.match.kind === "line-prefix" ? `on its own line starting with "${rule.match.prefix}"` : how}.`;
    case "speaker":
      return rule.match.kind === "regex"
        ? (zh ? "多个角色说话时，每句台词单独一行，写成「名字：台词」。" : `When several characters talk, put each line of dialogue on its own line as "Name: line".`)
        : (zh ? `多个角色说话时，每句台词单独一行，${how}，后面接「名字：台词」。` : `When several characters talk, put each line on its own line, ${how}, then "Name: line".`);
    case "card":
      return zh ? `出现特别的消息（广播、信件、通知）时，${how}。` : `For a special message (a broadcast, a letter, a notice), ${how}.`;
    case "hide":
      return zh ? `只给自己看的备注，${how}（玩家看不到）。` : `Notes meant only for yourself: ${how} (the player will not see them).`;
  }
}

/** A sample of the convention: the creator's own, else one made from it. */
export function ruleExample(rule: UiMessageRule, lang?: string): string | null {
  if (typeof rule.example === "string" && rule.example.trim()) return rule.example.trim();
  const zh = langOf(lang) === "zh";
  const m = rule.match;
  const wrapOr = (inner: string) =>
    m.kind === "wrap" ? `${m.open}${inner}${m.close}` : m.kind === "line-prefix" ? `${m.prefix}${inner}` : m.kind === "contains" ? m.text : null;
  switch (rule.show) {
    case "reveal": return wrapOr(zh ? "其实……有一点开心。" : "Actually… that made me a little happy.");
    case "banner": return wrapOr(zh ? "第1天·傍晚" : "Day 1 · Dusk");
    case "choices": {
      if (m.kind !== "wrap" && m.kind !== "line-prefix") return null;
      const items = zh ? ["跟上去", "先回家"] : ["Follow her", "Head home"];
      return items.map((i) => wrapOr(i)).join("\n");
    }
    case "speaker": {
      if (m.kind === "regex") return zh ? "艾拉：你来得正好。" : "Ella: You came just in time.";
      if (m.kind === "line-prefix") return zh ? `${m.prefix}艾拉：你来得正好。` : `${m.prefix}Ella: You came just in time.`;
      return null;
    }
    case "card": return wrapOr(zh ? "紧急广播" : "Emergency broadcast");
    case "hide": return null;
  }
}

/** Everything the AI is told, as one block; null when there is nothing. */
export function messageRulesPrompt(rules: UiMessageRule[], lang?: string): string | null {
  const l = langOf(lang);
  const zh = l === "zh";
  const lines: string[] = [];
  for (const rule of rules) {
    if (!rule || rule.enabled === false || rule.teachAi === false || !matchIsUsable(rule.match)) continue;
    const hint = (typeof rule.aiHint === "string" && rule.aiHint.trim()) ? rule.aiHint.trim() : defaultAiHint(rule, lang);
    const example = ruleExample(rule, lang);
    const name = rule.name?.trim();
    const exampleText = example ? (zh ? ` 例：${example.replace(/\n/g, " ／ ")}` : ` Example: ${example.replace(/\n/g, " / ")}`) : "";
    lines.push(`- ${name ? `${name}${zh ? "：" : ": "}` : ""}${hint}${exampleText}`);
  }
  if (lines.length === 0) return null;
  const head = zh
    ? "这张卡的界面会把下面几种写法显示成特别的样子。合适的时候照着写，符号原样写出，不要解释这些符号："
    : "This card's interface draws the writing conventions below in a special way. Use them where they fit, write the markers exactly as shown, and never explain them:";
  const tag = zh ? "界面约定" : "interface-conventions";
  return `<${tag}>\n${head}\n${lines.join("\n")}\n</${tag}>`;
}

const isRulesEntry = (e: WorldEntry) => e.id === UI_RULES_ENTRY_ID || (Array.isArray(e.tags) && e.tags.includes(UI_RULES_ENTRY_TAG));

/**
 * Keep the 「界面约定」 entry in step with the card's rules: created when the
 * first taught rule appears, its content rewritten when they change, removed
 * when none are left. Everything else about the entry — on/off, position,
 * section, name — is the creator's and is left alone. Returns the same array
 * when nothing changed, so callers can skip a commit.
 */
export function syncMessageRulesEntry(entries: WorldEntry[], doc: UiDoc | undefined, lang?: string): WorldEntry[] {
  const list = Array.isArray(entries) ? entries : [];
  const content = messageRulesPrompt(docMessageRules(doc), lang);
  const index = list.findIndex(isRulesEntry);
  if (content === null) return index === -1 ? list : list.filter((_, i) => i !== index);
  if (index !== -1) {
    const existing = list[index]!;
    if (existing.content === content) return list;
    const next = [...list];
    next[index] = { ...existing, content };
    return next;
  }
  const position = list.filter((e) => e.section === "post-history").reduce((max, e) => Math.max(max, e.position ?? 0), -1) + 1;
  const entry: WorldEntry = {
    id: UI_RULES_ENTRY_ID,
    name: langOf(lang) === "zh" ? "界面约定" : "Interface conventions",
    content,
    role: "style",
    apiRole: "system",
    alwaysSend: true,
    keywords: [],
    conditions: [],
    conditionLogic: "all",
    enabled: true,
    matchWholeWords: false,
    secondaryKeywords: [],
    secondaryKeywordLogic: "AND_ANY",
    preventRecursion: true,
    excludeRecursion: true,
    position,
    section: "post-history",
    tags: [UI_RULES_ENTRY_TAG],
    audience: "ai",
  };
  return [...list, entry];
}

// ── Presets ─────────────────────────────────────────────────────────────────

/** Starting points for a rule. The editor names them in the creator's language;
 *  the shape is the same everywhere. */
export const MESSAGE_RULE_PRESETS: Record<string, Omit<UiMessageRule, "id" | "name">> = {
  "inner-thought": {
    match: { kind: "wrap", open: "♡", close: "♡" },
    show: "reveal",
    options: { cover: "ink", revealChance: 1 },
  },
  "scene-banner": {
    match: { kind: "wrap", open: "【", close: "】" },
    show: "banner",
  },
  "choice-buttons": {
    match: { kind: "line-prefix", prefix: "※" },
    show: "choices",
  },
  "speaker-label": {
    match: { kind: "regex", pattern: "^(?:【([^】]{1,16})】|([^\\s：:，。！？「」“”\"]{1,10})[：:])\\s*(.+)$" },
    show: "speaker",
  },
  "special-card": {
    match: { kind: "contains", text: "【广播】" },
    show: "card",
    options: { title: "📻 广播" },
  },
  "hide-meta": {
    match: { kind: "wrap", open: "<!--", close: "-->" },
    show: "hide",
    teachAi: false,
  },
};

const INK = "rgba(20,18,28,0.92)";
/** The card's own ink and accent when it has a theme, the platform's when not
 *  — so a look reads on 素纸 as well as on night. */
const INK_TOKEN = "var(--yc-text, var(--color-foreground, #f1ece4))";
const ACCENT_TOKEN = "var(--yc-send-bg, var(--color-primary, #d9a13f))";

/** Whole looks for the conversation. Colours lean on the platform's theme
 *  variables with sensible fallbacks, so a look sits on any card. */
export const MESSAGE_STYLE_PRESETS: Record<string, UiMessageStyle> = {
  bubbles: {
    preset: "bubbles",
    assistant: {
      bubble: true,
      box: { fills: [{ kind: "color", color: `color-mix(in srgb, ${INK_TOKEN} 8%, transparent)` }], radius: [6, 18, 18, 18], borderColor: `color-mix(in srgb, ${INK_TOKEN} 10%, transparent)`, padding: 14 },
    },
    user: {
      bubble: true,
      box: { fills: [{ kind: "color", color: `color-mix(in srgb, ${ACCENT_TOKEN} 24%, transparent)` }], radius: [18, 6, 18, 18], padding: 12 },
      // The theme's player-line ink is meant for a SOLID accent bubble (dark
      // on a light accent); on this tint it would vanish.
      text: { color: INK_TOKEN },
    },
    showNames: true,
    gap: 6,
  },
  novel: {
    preset: "novel",
    assistant: { bubble: false, text: { family: "\"Noto Serif SC\", Georgia, \"Songti SC\", serif", size: 16, lineHeight: 1.95, letterSpacing: 0.3 } },
    user: {
      bubble: false,
      text: { family: "\"Noto Serif SC\", Georgia, \"Songti SC\", serif", size: 15, lineHeight: 1.8, italic: true, align: "left", color: `color-mix(in srgb, ${INK_TOKEN} 62%, transparent)` },
    },
    showNames: false,
    maxWidth: 680,
    gap: 10,
  },
  letter: {
    preset: "letter",
    assistant: {
      bubble: true,
      box: {
        fills: [{ kind: "gradient", angle: 180, stops: [{ color: "#fbf5e8", at: 0 }, { color: "#f1e5cc", at: 100 }] }],
        radius: 6,
        shadows: [{ x: 0, y: 8, blur: 24, color: "rgba(0,0,0,0.28)" }],
        borderColor: "rgba(120,90,50,0.25)",
        padding: 20,
      },
      text: { family: "\"Noto Serif SC\", Georgia, \"Songti SC\", serif", color: "#3b2f24", size: 15, lineHeight: 1.9 },
    },
    user: {
      bubble: true,
      box: { fills: [{ kind: "color", color: "rgba(251,245,232,0.12)" }], radius: 6, borderColor: "rgba(241,229,204,0.35)", borderStyle: "dashed", padding: 12 },
      text: { family: "\"Noto Serif SC\", Georgia, \"Songti SC\", serif", italic: true, size: 14, color: INK_TOKEN },
    },
    showNames: false,
    maxWidth: 620,
    gap: 12,
  },
  terminal: {
    preset: "terminal",
    assistant: {
      bubble: true,
      box: { fills: [{ kind: "color", color: "rgba(4,10,6,0.82)" }], radius: 6, borderColor: "rgba(110,255,150,0.28)", padding: 14, shadows: [{ x: 0, y: 0, blur: 18, color: "rgba(80,255,140,0.10)" }] },
      text: { family: "\"JetBrains Mono\", Consolas, \"Noto Sans SC\", monospace", size: 13, color: "#9dffb4", lineHeight: 1.7 },
    },
    user: {
      bubble: true,
      box: { fills: [{ kind: "color", color: INK }], radius: 6, borderColor: "rgba(120,200,255,0.3)", padding: 10 },
      text: { family: "\"JetBrains Mono\", Consolas, \"Noto Sans SC\", monospace", size: 13, color: "#8fd3ff", align: "left" },
    },
    showNames: false,
    gap: 8,
  },
};

// ── The preview's sample conversation ───────────────────────────────────────

/**
 * A short exchange that shows every rule at work, for the Studio preview of a
 * card that has not been played yet — a rule you cannot see is a rule you
 * cannot tell is working.
 */
export function sampleConversation(rules: UiMessageRule[], lang?: string): Array<{ role: "assistant" | "user"; content: string }> {
  const zh = langOf(lang) === "zh";
  const active = activeRules(rules, "assistant");
  const pick = (show: UiMessageShow) => active.filter((r) => r.show === show).map((r) => ruleExample(r, lang)).filter((x): x is string => !!x);
  const reply: string[] = [];
  reply.push(...pick("banner"));
  const reveal = pick("reveal")[0];
  reply.push(zh
    ? `她把伞往你那边偏了偏，雨声一下子远了。${reveal ? `\n${reveal}` : ""}`
    : `She tilts the umbrella your way, and the rain goes quiet.${reveal ? `\n${reveal}` : ""}`);
  const speakers = active.filter((r) => r.show === "speaker");
  if (speakers.length) {
    const first = ruleExample(speakers[0]!, lang);
    if (first) reply.push(first);
    if (speakers[0]!.match.kind === "regex") reply.push(zh ? "诺亚：……嗯，路上小心。" : "Noah: …Mm. Careful on the way.");
  }
  reply.push(...pick("choices"));
  const out: Array<{ role: "assistant" | "user"; content: string }> = [
    { role: "user", content: zh ? "我在门口等你。" : "I'll wait for you at the door." },
  ];
  // The card comes before the reply: choices are live only on the newest
  // message, and the preview should show them live.
  const card = pick("card")[0];
  if (card) {
    out.push({ role: "assistant", content: zh ? `${card}\n全体居民请注意：今晚八点后请勿外出。` : `${card}\nAll residents: stay indoors after eight tonight.` });
  }
  out.push({ role: "assistant", content: reply.join("\n\n") });
  return out;
}
