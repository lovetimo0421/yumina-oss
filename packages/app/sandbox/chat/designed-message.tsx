/**
 * The message layer's renderer: a card's message style and 特殊写法 rules,
 * drawn inside the platform's own transcript.
 *
 * A card built in the visual editor hands its transcript a `design` (data —
 * see `designProps` in engine/ui-doc/compile.ts), and this draws every message
 * through it. The decisions live in the engine (`layoutMessage`); this file
 * only paints them, so the Studio preview (which imports this same component)
 * and the played card can never disagree.
 *
 * Safety is structural: the layout hands over plain strings. Banner, choice,
 * name and title text is rendered as React text (escaped); prose, covered
 * thoughts and speaker lines go through `renderMarkdown`, the chat's own
 * sanitising pipeline. No rule can turn model text into markup.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  layoutMessage,
  messageBoxCss,
  messageTextCss,
  speakerColor,
  type MsgBlock,
  type MsgInline,
  type UiMessageRoleStyle,
  type UiMessageRule,
  type UiMessageStyle,
} from "@yumina/engine";

export interface MessageDesign {
  style?: UiMessageStyle;
  rules?: UiMessageRule[];
}

/** What the renderer needs from wherever it runs — the sandbox API in play,
 *  the preview's stand-in in the Studio. */
export interface DesignedMessageHost {
  sendMessage: (text: string) => void;
  resolveAssetUrl: (ref: string) => string;
  storage?: { get: (key: string) => Promise<string | null>; set: (key: string, value: string) => Promise<void> } | null;
  /** False while a reply streams or the session is read-only. */
  canSend: () => boolean;
}

export interface DesignedMessageProps {
  design: MessageDesign;
  fontMap?: Record<string, string>;
  host: DesignedMessageHost;
  content: string;
  role: "user" | "assistant" | "system";
  isStreaming?: boolean;
  messageId?: string;
  swipeIndex?: number;
  isLastMessage?: boolean;
  isGreeting?: boolean;
  renderMarkdown: (text: string) => string;
}

// ── Reveal memory ──────────────────────────────────────────────────────────
//
// Kept per message (one storage key holds every cover in it) and per swipe:
// a regenerated reply is a different text with different secrets. Synthetic
// messages (the greeting before play, the live stream, the Studio preview)
// have no stable id and remember only for as long as the page lives.

type RevealState = "covered" | "revealed" | "missed";
const memory = new Map<string, Record<string, "r" | "m">>();
const loading = new Map<string, Promise<Record<string, "r" | "m">>>();

const persistable = (messageId: string | undefined): messageId is string => !!messageId && !messageId.startsWith("__");
const storeKey = (messageId: string) => `yc-reveal:${messageId}`;

function loadMemory(host: DesignedMessageHost, messageId: string): Promise<Record<string, "r" | "m">> {
  const hit = memory.get(messageId);
  if (hit) return Promise.resolve(hit);
  let pending = loading.get(messageId);
  if (!pending) {
    pending = (async () => {
      let parsed: Record<string, "r" | "m"> = {};
      try {
        const raw = host.storage && persistable(messageId) ? await host.storage.get(storeKey(messageId)) : null;
        const value = raw ? JSON.parse(raw) : null;
        if (value && typeof value === "object") parsed = value as Record<string, "r" | "m">;
      } catch {
        /* unreadable memory is no memory */
      }
      // A tap that landed while the read was in flight wins over what was read.
      const merged = { ...parsed, ...(memory.get(messageId) ?? {}) };
      memory.set(messageId, merged);
      return merged;
    })();
    loading.set(messageId, pending);
  }
  return pending;
}

function remember(host: DesignedMessageHost, messageId: string | undefined, slot: string, state: "r" | "m") {
  const id = messageId || "__anon__";
  const next = { ...(memory.get(id) ?? {}), [slot]: state };
  memory.set(id, next);
  if (host.storage && persistable(messageId)) {
    void host.storage.set(storeKey(messageId), JSON.stringify(next)).catch(() => {});
  }
}

/** Test seam: forget what this page remembers. */
export function __resetRevealMemory() {
  memory.clear();
  loading.clear();
}

// ── Pieces ─────────────────────────────────────────────────────────────────

function Markdown({ text, render, className }: { text: string; render: (t: string) => string; className?: string }) {
  const html = useMemo(() => render(text), [text, render]);
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

function Reveal({
  part, rule, host, messageId, swipeIndex, render,
}: {
  part: Extract<MsgInline, { kind: "reveal" }>;
  rule: UiMessageRule | undefined;
  host: DesignedMessageHost;
  messageId?: string;
  swipeIndex: number;
  render: (t: string) => string;
}) {
  const slot = `${swipeIndex}:${part.ruleId}:${part.n}`;
  const id = messageId || "__anon__";
  const [state, setState] = useState<RevealState>(() => {
    const known = memory.get(id)?.[slot];
    return known === "r" ? "revealed" : known === "m" ? "missed" : "covered";
  });
  useEffect(() => {
    if (!persistable(messageId)) return;
    let live = true;
    void loadMemory(host, messageId).then((mem) => {
      if (!live) return;
      const known = mem[slot];
      if (known) setState(known === "r" ? "revealed" : "missed");
    });
    return () => { live = false; };
  }, [host, messageId, slot]);

  const cover = rule?.options?.cover ?? "ink";
  const chance = typeof rule?.options?.revealChance === "number" ? Math.max(0, Math.min(1, rule.options.revealChance)) : 1;

  if (state === "revealed") {
    return <Markdown className="yc-reveal yc-reveal--open" text={part.text} render={render} />;
  }
  if (state === "missed") {
    return <span className="yc-reveal yc-reveal--missed">{rule?.options?.missText || "……"}</span>;
  }
  const tap = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    if (part.pending) return;
    const hit = chance >= 1 || Math.random() < chance;
    const next = hit ? "r" : "m";
    remember(host, messageId, slot, next);
    setState(hit ? "revealed" : "missed");
  };
  const label = rule?.options?.coverText;
  return (
    <span
      role="button"
      tabIndex={part.pending ? -1 : 0}
      aria-label={label || rule?.name || "reveal"}
      data-cover={cover}
      data-pending={part.pending ? "" : undefined}
      className={`yc-reveal yc-reveal--${cover}`}
      onClick={tap}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); tap(e); } }}
    >
      {cover === "sticker"
        ? <span className="yc-reveal-sticker">{label || "✦"}</span>
        : <>
            {label ? <span className="yc-reveal-label">{label}</span> : cover === "ink" ? <span className="yc-reveal-label" aria-hidden="true">✦</span> : null}
            <Markdown className="yc-reveal-text" text={part.text} render={render} />
          </>}
    </span>
  );
}

function Inline({ parts, ...ctx }: { parts: MsgInline[] } & Omit<Parameters<typeof Reveal>[0], "part" | "rule"> & { rules: Map<string, UiMessageRule> }) {
  const { rules, render, ...rest } = ctx;
  return (
    <>
      {parts.map((p, i) =>
        p.kind === "text"
          ? <Markdown key={i} text={p.text} render={render} />
          : <Reveal key={`${p.ruleId}:${p.n}`} part={p} rule={rules.get(p.ruleId)} render={render} {...rest} />)}
    </>
  );
}

function roleStyleFor(style: UiMessageStyle | undefined, role: string, greeting: boolean): UiMessageRoleStyle | undefined {
  if (!style) return undefined;
  if (role === "user") return style.user;
  if (!greeting || !style.greeting) return style.assistant;
  const base = style.assistant ?? {};
  const over = style.greeting;
  return {
    bubble: over.bubble ?? base.bubble,
    box: { ...(base.box ?? {}), ...(over.box ?? {}) },
    text: { ...(base.text ?? {}), ...(over.text ?? {}) },
  };
}

// ── The message ────────────────────────────────────────────────────────────

export function DesignedMessage({
  design, fontMap, host, content, role, isStreaming = false, messageId, swipeIndex = 0,
  isLastMessage = false, isGreeting = false, renderMarkdown,
}: DesignedMessageProps) {
  const rules = useMemo(() => (Array.isArray(design.rules) ? design.rules : []), [design.rules]);
  const byId = useMemo(() => new Map(rules.map((r) => [r.id, r])), [rules]);
  const layout = useMemo(
    () => layoutMessage(content ?? "", rules, { role, streaming: isStreaming }),
    [content, rules, role, isStreaming],
  );
  const [sent, setSent] = useState<string | null>(null);
  const lastContent = useRef(content);
  if (lastContent.current !== content) {
    lastContent.current = content;
    if (sent) setSent(null);
  }

  const own = roleStyleFor(design.style, role, isGreeting);
  const resolve = host.resolveAssetUrl;
  const surface: React.CSSProperties = {
    ...(own?.bubble ? { ...(messageBoxCss(own.box, resolve) as React.CSSProperties) } : {}),
    ...(messageTextCss(own?.text, fontMap) as React.CSSProperties),
  };
  // A player's bubble hugs its words and sits right, the way the stock
  // transcript places their line; the words inside it read left to right.
  if (role === "user" && own?.bubble) {
    surface.display = "inline-block";
    surface.maxWidth = "100%";
    if (!own.text?.align) surface.textAlign = "left";
  }
  if (own?.bubble && surface.padding === undefined) surface.padding = 12;

  const ctx = { rules: byId, host, messageId, swipeIndex, render: renderMarkdown };
  const choicesLive = role === "assistant" && isLastMessage && !isStreaming;

  const drawBlock = (block: MsgBlock, i: number) => {
    const rule = "ruleId" in block ? byId.get(block.ruleId) : undefined;
    const box = rule?.options?.box ? (messageBoxCss(rule.options.box, resolve) as React.CSSProperties) : undefined;
    const text = rule?.options?.text ? (messageTextCss(rule.options.text, fontMap) as React.CSSProperties) : undefined;
    switch (block.kind) {
      case "text":
        return <div key={i} className="yc-msg-prose"><Inline parts={block.parts} {...ctx} /></div>;
      case "banner":
        return (
          <div key={i} className="yc-msg-banner" style={box}>
            <span className="yc-msg-banner-rule" aria-hidden="true" />
            <span className="yc-msg-banner-text" style={text}>{block.text}</span>
            <span className="yc-msg-banner-rule" aria-hidden="true" />
          </div>
        );
      case "choices":
        if (!choicesLive) return null;
        return (
          <div key={i} className="yc-msg-choices" role="group">
            {block.items.map((item, j) => (
              <button
                key={j}
                type="button"
                className="yc-msg-choice"
                data-picked={sent === item ? "" : undefined}
                disabled={sent !== null}
                style={{ ...box, ...text }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (sent !== null || !host.canSend()) return;
                  setSent(item);
                  host.sendMessage(item);
                }}
              >
                <span className="yc-msg-choice-text">{item}</span>
                <span className="yc-msg-choice-arrow" aria-hidden="true">›</span>
              </button>
            ))}
          </div>
        );
      case "speaker": {
        const color = speakerColor(block.name, rule?.options?.colors);
        const avatar = rule?.options?.avatars?.[block.name];
        return (
          <div key={i} className="yc-msg-speaker" style={{ ["--yc-speaker" as string]: color, ...box }}>
            <div className="yc-msg-speaker-head">
              {avatar ? <img className="yc-msg-speaker-avatar" src={resolve(avatar)} alt="" draggable={false} /> : null}
              <span className="yc-msg-speaker-name" style={text}>{block.name}</span>
            </div>
            <div className="yc-msg-speaker-line"><Inline parts={block.parts} {...ctx} /></div>
          </div>
        );
      }
    }
  };

  const body = layout.touched
    ? layout.blocks.map(drawBlock)
    : <div className="yc-msg-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(content ?? "") }} />;

  let inner: React.ReactNode = body;
  if (layout.card) {
    const rule = byId.get(layout.card.ruleId);
    const box = rule?.options?.box ? (messageBoxCss(rule.options.box, resolve) as React.CSSProperties) : undefined;
    const text = rule?.options?.text ? (messageTextCss(rule.options.text, fontMap) as React.CSSProperties) : undefined;
    inner = (
      <div className="yc-msg-card" style={{ ...box, ...text }}>
        {layout.card.title ? (
          <div className="yc-msg-card-title">
            <span className="yc-msg-card-dot" aria-hidden="true" />
            {layout.card.title}
          </div>
        ) : null}
        <div className="yc-msg-card-body">{body}</div>
      </div>
    );
  }

  return (
    <div className={`yc-msg yc-msg--${role}${isGreeting ? " yc-msg--greeting" : ""}${own?.bubble ? " yc-msg--bubble" : ""}`} style={surface}>
      {inner}
    </div>
  );
}

/**
 * The look of the pieces. Colours come from the platform theme variables with
 * fallbacks, so the defaults sit on a dark card, a light card and a themed one
 * without per-card work — and every piece can still be overridden by the rule's
 * own box/text style (inline) or the card's free CSS (these are plain classes).
 */
export const DESIGNED_MESSAGE_CSS = `
.yc-msg { box-sizing: border-box; min-width: 0; overflow-wrap: anywhere; }
.yc-msg--bubble { border-radius: 14px; }
.yc-msg-prose { white-space: normal; }
.yc-msg > .yc-msg-prose + *, .yc-msg > * + .yc-msg-prose, .yc-msg-card-body > * + * { margin-top: 0.55em; }
.yc-msg > * + * { margin-top: 0.55em; }
.yc-msg-banner { display: flex; align-items: center; gap: 10px; margin: 0.9em 0; font-size: 0.78em; letter-spacing: 0.18em; color: color-mix(in srgb, var(--color-primary, #d9a13f) 85%, var(--color-foreground, #fff)); font-weight: 600; text-align: center; }
.yc-msg-banner-text { flex: 0 1 auto; white-space: pre-wrap; }
.yc-msg-banner-rule { flex: 1 1 0; height: 1px; min-width: 16px; background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--color-primary, #d9a13f) 55%, transparent), transparent); }
.yc-msg-choices { display: flex; flex-direction: column; gap: 8px; margin-top: 0.9em; }
.yc-msg-choice { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 10px 14px; border-radius: 12px; border: 1px solid color-mix(in srgb, var(--color-primary, #d9a13f) 38%, transparent); background: color-mix(in srgb, var(--color-primary, #d9a13f) 9%, transparent); color: inherit; font: inherit; font-size: 0.94em; line-height: 1.45; cursor: pointer; transition: background 160ms ease, transform 160ms ease, border-color 160ms ease; animation: ycRise 260ms ease both; -webkit-user-select: none; user-select: none; }
.yc-msg-choice:nth-child(2) { animation-delay: 60ms; } .yc-msg-choice:nth-child(3) { animation-delay: 120ms; } .yc-msg-choice:nth-child(4) { animation-delay: 180ms; }
.yc-msg-choice:hover:not(:disabled) { background: color-mix(in srgb, var(--color-primary, #d9a13f) 18%, transparent); border-color: color-mix(in srgb, var(--color-primary, #d9a13f) 65%, transparent); transform: translateX(2px); }
.yc-msg-choice:disabled { cursor: default; opacity: 0.45; }
.yc-msg-choice[data-picked] { opacity: 1; border-color: var(--color-primary, #d9a13f); }
.yc-msg-choice-text { flex: 1 1 auto; min-width: 0; }
.yc-msg-choice-arrow { flex: 0 0 auto; opacity: 0.6; font-size: 1.2em; line-height: 1; }
.yc-msg-speaker { margin: 0.35em 0; }
.yc-msg-speaker-head { display: flex; align-items: center; gap: 8px; margin-bottom: 3px; }
.yc-msg-speaker-avatar { width: 26px; height: 26px; border-radius: 999px; object-fit: cover; border: 1.5px solid var(--yc-speaker); flex: 0 0 auto; }
.yc-msg-speaker-name { display: inline-block; font-size: 0.76em; font-weight: 700; letter-spacing: 0.06em; color: var(--yc-speaker); padding: 1px 9px; border-radius: 999px; background: color-mix(in srgb, var(--yc-speaker) 16%, transparent); }
.yc-msg-speaker-line { padding-left: 11px; border-left: 2px solid color-mix(in srgb, var(--yc-speaker) 60%, transparent); }
.yc-msg-card { border-radius: 14px; padding: 14px 16px; border: 1px solid color-mix(in srgb, var(--color-primary, #d9a13f) 45%, transparent); background: linear-gradient(160deg, color-mix(in srgb, var(--color-primary, #d9a13f) 16%, transparent), color-mix(in srgb, var(--color-primary, #d9a13f) 4%, transparent)); box-shadow: 0 10px 30px rgba(0,0,0,0.18); }
.yc-msg-card-title { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 0.74em; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: color-mix(in srgb, var(--color-primary, #d9a13f) 90%, var(--color-foreground, #fff)); }
.yc-msg-card-dot { width: 7px; height: 7px; border-radius: 999px; background: var(--color-primary, #d9a13f); box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-primary, #d9a13f) 60%, transparent); animation: ycPing 1.8s ease-out infinite; }
.yc-reveal { border-radius: 5px; padding: 0 3px; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
.yc-reveal[role="button"] { cursor: pointer; -webkit-user-select: none; user-select: none; }
.yc-reveal--ink { padding: 1px 6px; background: repeating-linear-gradient(-35deg, rgba(255,255,255,0.035) 0 2px, transparent 2px 7px), linear-gradient(100deg, #1b1824 0%, #30283f 50%, #1b1824 100%); background-size: auto, 200% 100%; color: transparent; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-primary, #d9a13f) 22%, transparent); transition: filter 160ms ease, box-shadow 160ms ease; }
.yc-reveal--ink:hover { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-primary, #d9a13f) 55%, transparent); }
.yc-reveal--ink .yc-reveal-text, .yc-reveal--ink .yc-reveal-text * { color: transparent !important; }
.yc-reveal--ink:hover { filter: brightness(1.35); }
.yc-reveal--blur .yc-reveal-text { filter: blur(5px); opacity: 0.85; transition: filter 200ms ease; }
.yc-reveal--blur { background: color-mix(in srgb, var(--color-foreground, #fff) 6%, transparent); }
.yc-reveal--blur:hover .yc-reveal-text { filter: blur(3.5px); }
.yc-reveal--sticker { display: inline-block; padding: 1px 10px; transform: rotate(-2deg); background: linear-gradient(135deg, #ffd6e7, #ffc2da); color: #a23a6b; font-size: 0.82em; font-weight: 700; box-shadow: 0 2px 6px rgba(0,0,0,0.25); }
.yc-reveal--sticker:hover { transform: rotate(0deg) scale(1.04); }
.yc-reveal-label { font-size: 0.72em; font-weight: 700; letter-spacing: 0.08em; color: color-mix(in srgb, var(--color-primary, #d9a13f) 85%, #fff); margin-right: 4px; }
.yc-reveal[data-pending] { animation: ycShimmer 1.4s linear infinite; cursor: default; }
.yc-reveal--open { background: color-mix(in srgb, var(--color-primary, #d9a13f) 12%, transparent); font-style: italic; animation: ycInk 420ms ease both; }
.yc-reveal--missed { font-style: italic; opacity: 0.55; }
@keyframes ycInk { from { opacity: 0; filter: blur(4px); } to { opacity: 1; filter: blur(0); } }
@keyframes ycShimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
@keyframes ycRise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
@keyframes ycPing { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-primary, #d9a13f) 55%, transparent); } 80%, 100% { box-shadow: 0 0 0 7px transparent; } }
`;

/** Without the host's sanitiser there is no markup at all — text stays text. */
const escapeOnly = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\n/g, "<br />");

/**
 * A message renderer for MessageList's `rendererComponent` slot, bound to a
 * design. Its identity follows the design's CONTENT — a design written inline
 * in JSX is a new object every render, and a new renderer type would remount
 * the whole transcript mid-stream.
 */
export function useDesignRenderer(
  design: MessageDesign | undefined | null,
  fontMap: Record<string, string> | undefined,
  host: DesignedMessageHost,
): React.ComponentType<Record<string, unknown>> | null {
  const key = design ? JSON.stringify([design, fontMap ?? null]) : "";
  const hostRef = useRef(host);
  hostRef.current = host;
  // The host object is recreated by callers; the renderer reads the latest one.
  const stableHost = useMemo<DesignedMessageHost>(() => ({
    sendMessage: (text) => hostRef.current.sendMessage(text),
    resolveAssetUrl: (ref) => hostRef.current.resolveAssetUrl(ref),
    storage: {
      get: (k) => hostRef.current.storage?.get(k) ?? Promise.resolve(null),
      set: (k, v) => hostRef.current.storage?.set(k, v) ?? Promise.resolve(),
    },
    canSend: () => hostRef.current.canSend(),
  }), []);
  return useMemo(() => {
    if (!key) return null;
    const [parsedDesign, parsedFonts] = JSON.parse(key) as [MessageDesign, Record<string, string> | null];
    const Renderer = (props: Record<string, unknown>) => (
      <DesignedMessage
        design={parsedDesign}
        fontMap={parsedFonts ?? undefined}
        host={stableHost}
        content={String(props.content ?? "")}
        role={(props.role as DesignedMessageProps["role"]) ?? "assistant"}
        isStreaming={!!props.isStreaming}
        messageId={typeof props.messageId === "string" ? props.messageId : undefined}
        swipeIndex={typeof props.swipeIndex === "number" ? props.swipeIndex : 0}
        isLastMessage={!!props.isLastMessage}
        isGreeting={!!props.isGreeting}
        renderMarkdown={(props.renderMarkdown as (t: string) => string) ?? escapeOnly}
      />
    );
    Renderer.displayName = "DesignedMessageRenderer";
    return Renderer;
  }, [key, stableHost]);
}
