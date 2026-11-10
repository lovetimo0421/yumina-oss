import { useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, ArrowUp, ArrowDown, Trash2, Plus } from "lucide-react";
import {
  MESSAGE_RULE_PRESETS,
  MESSAGE_STYLE_PRESETS,
  defaultAiHint,
  messageBoxCss,
  messageTextCss,
  ruleExample,
  updateElements,
} from "@yumina/engine";
import type {
  UiBoxStyle,
  UiDoc,
  UiElement,
  UiMessageMatch,
  UiMessageRoleStyle,
  UiMessageRule,
  UiMessageRuleOptions,
  UiMessageShow,
  UiMessageStyle,
  UiTextStyle,
} from "@yumina/engine";
import { cn } from "@/lib/utils";
import { contentLanguage } from "@/lib/i18n";
import { ColorField, FontPicker, themeSwatches } from "./style-section";
import { ImageField, Section, Segmented, Toggle, fieldCls, smallCls } from "./parts/part-kit";
import { MoreSection } from "./page-variables";

/**
 * 消息样子 and 特殊写法 — the message layer of a transcript part.
 *
 * The first half is how a message looks (a bubble or bare text, its type,
 * its colours), for the AI, the player and the opening. The second is a list
 * of rules that find a written convention in a reply and draw it differently.
 * Both live on the part in the document; the preview draws them on a sample
 * exchange, and the store keeps the 「界面约定」 entry in step so the AI writes
 * what the rules look for.
 */

type MessagePart = Extract<UiElement, { type: "chat" | "messages" }>;
type Side = "assistant" | "user" | "greeting";

const STYLE_PRESET_IDS = ["bubbles", "novel", "letter", "terminal"] as const;
const RULE_PRESET_IDS = ["inner-thought", "scene-banner", "choice-buttons", "speaker-label", "special-card", "hide-meta"] as const;
const SHOWS: UiMessageShow[] = ["reveal", "banner", "choices", "speaker", "card", "hide"];
const MATCH_KINDS: Array<UiMessageMatch["kind"]> = ["wrap", "line-prefix", "contains", "regex"];

const newRuleId = () => `rule-${crypto.randomUUID().slice(0, 6)}`;

/** A number field that ignores the half-typed states (an empty box is the
 *  creator mid-retype, not a request for 0). */
function NumberField({ value, onChange, label, min, max, step, placeholder }: {
  value: number | undefined; onChange: (v: number | undefined) => void; label: string;
  min?: number; max?: number; step?: number; placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] text-muted-foreground/80">{label}</span>
      <input
        type="number"
        value={value ?? ""}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (raw === "") { onChange(undefined); return; }
          const n = Number(raw);
          if (!Number.isFinite(n)) return;
          onChange(Math.max(min ?? -Infinity, Math.min(max ?? Infinity, n)));
        }}
        className={smallCls}
      />
    </label>
  );
}

function FontSelect({ value, onChange, label }: { value: string | undefined; onChange: (v: string | undefined) => void; label: string }) {
  const { t } = useTranslation("editor");
  // The same list, with the same localized names, as every text part.
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[10px] text-muted-foreground/80">{label}</span>
      <FontPicker value={value} onChange={onChange} themeLabel={t("studio.messages.fontDefault")} />
    </div>
  );
}

/** The four looks, each drawn as a tiny exchange in its own style. */
function StyleGallery({ current, onPick }: { current: string | undefined; onPick: (id: string | null) => void }) {
  const { t } = useTranslation("editor");
  const swatch = (style: UiMessageStyle | null) => {
    const side = (s: UiMessageRoleStyle | undefined, user: boolean) => ({
      ...(s?.bubble ? messageBoxCss({ ...s.box, padding: 4, shadows: undefined }) : {}),
      ...messageTextCss({ ...s?.text, size: 9, lineHeight: 1.3 }),
      alignSelf: user ? "flex-end" : "stretch",
      maxWidth: user ? "70%" : undefined,
      borderRadius: s?.bubble ? 5 : undefined,
    }) as CSSProperties;
    return (
      <div className="flex h-12 w-full flex-col justify-center gap-1 overflow-hidden rounded bg-[#15131b] px-1.5">
        <div style={{ ...side(style?.assistant, false), color: side(style?.assistant, false).color ?? "rgba(255,255,255,0.85)" }} className="truncate">{t("studio.messages.sampleLine")}</div>
        <div style={{ ...side(style?.user, true), color: side(style?.user, true).color ?? "rgba(255,255,255,0.7)" }} className="truncate">{t("studio.messages.sampleReply")}</div>
      </div>
    );
  };
  const options: Array<{ id: string | null; label: string; style: UiMessageStyle | null }> = [
    { id: null, label: t("studio.messages.presets.default"), style: null },
    ...STYLE_PRESET_IDS.map((id) => ({ id, label: t(`studio.messages.presets.${id}`), style: MESSAGE_STYLE_PRESETS[id]! })),
  ];
  return (
    <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label={t("studio.messages.look")}>
      {options.map((o) => {
        const active = (current ?? null) === o.id;
        return (
          <button
            key={o.id ?? "default"}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onPick(o.id)}
            className={cn(
              "flex flex-col items-stretch gap-1 rounded-md border p-1 text-[10px] transition-colors",
              active ? "border-primary text-foreground ring-1 ring-primary/40" : "border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground",
            )}
          >
            {swatch(o.style)}
            <span className="truncate">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function RoleStyleFields({ value, onChange, swatches, side }: {
  value: UiMessageRoleStyle | undefined;
  onChange: (next: UiMessageRoleStyle) => void;
  swatches: string[];
  side: Side;
}) {
  const { t } = useTranslation("editor");
  const v = value ?? {};
  const box = v.box ?? {};
  const text = v.text ?? {};
  const setBox = (patch: Partial<UiBoxStyle>) => onChange({ ...v, box: { ...box, ...patch } });
  const setText = (patch: Partial<UiTextStyle>) => onChange({ ...v, text: { ...text, ...patch } });
  const fill = box.fills?.[0]?.kind === "color" ? box.fills[0].color : undefined;
  return (
    <div className="flex flex-col gap-2" data-testid={`message-side-${side}`}>
      <Toggle
        checked={!!v.bubble}
        label={t("studio.messages.bubble")}
        onChange={(bubble) => onChange({
          ...v,
          bubble,
          // A bubble switched on with no surface would be invisible; give it one.
          ...(bubble && !box.fills?.length ? { box: { ...box, fills: [{ kind: "color", color: side === "user" ? "rgba(217,161,63,0.18)" : "rgba(255,255,255,0.07)" }], radius: box.radius ?? 14, padding: box.padding ?? 12 } } : {}),
        })}
      />
      {v.bubble && (
        <>
          <div className="grid grid-cols-2 gap-1.5">
            <div className="flex flex-col gap-1">
              <span className="text-[10px] text-muted-foreground/80">{t("studio.messages.bubbleColor")}</span>
              <ColorField
                value={fill}
                swatches={swatches}
                allowNone
                label={t("studio.messages.bubbleColor")}
                editKey={`msg-${side}-fill`}
                onChange={(color) => setBox({ fills: color ? [{ kind: "color", color }, ...(box.fills ?? []).slice(1)] : (box.fills ?? []).slice(1) })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[10px] text-muted-foreground/80">{t("studio.messages.borderColor")}</span>
              <ColorField
                value={box.borderColor}
                swatches={swatches}
                allowNone
                label={t("studio.messages.borderColor")}
                editKey={`msg-${side}-border`}
                onChange={(borderColor) => setBox({ borderColor })}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <NumberField label={t("studio.messages.radius")} min={0} max={60} value={typeof box.radius === "number" ? box.radius : Array.isArray(box.radius) ? box.radius[1] : undefined} onChange={(radius) => setBox({ radius })} />
            <NumberField label={t("studio.messages.padding")} min={0} max={60} value={box.padding} onChange={(padding) => setBox({ padding })} />
          </div>
        </>
      )}
      <div className="grid grid-cols-2 gap-1.5">
        <FontSelect label={t("studio.messages.font")} value={text.family} onChange={(family) => setText({ family })} />
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-muted-foreground/80">{t("studio.messages.textColor")}</span>
          <ColorField value={text.color} swatches={swatches} allowNone label={t("studio.messages.textColor")} editKey={`msg-${side}-color`} onChange={(color) => setText({ color })} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <NumberField label={t("studio.messages.size")} min={10} max={32} value={text.size} placeholder="15" onChange={(size) => setText({ size })} />
        <NumberField label={t("studio.messages.lineHeight")} min={1} max={3} step={0.05} value={text.lineHeight} placeholder="1.7" onChange={(lineHeight) => setText({ lineHeight })} />
      </div>
      <Toggle checked={!!text.italic} label={t("studio.messages.italic")} onChange={(italic) => setText({ italic: italic || undefined })} />
    </div>
  );
}

// ── Rules ──────────────────────────────────────────────────────────────────

function MatchFields({ match, onChange }: { match: UiMessageMatch; onChange: (m: UiMessageMatch) => void }) {
  const { t } = useTranslation("editor");
  const switchKind = (kind: UiMessageMatch["kind"]) => {
    if (kind === match.kind) return;
    // Carry the marker over where it has a meaning in the new shape.
    const marker = match.kind === "wrap" ? match.open : match.kind === "line-prefix" ? match.prefix : match.kind === "contains" ? match.text : "";
    if (kind === "wrap") onChange({ kind, open: marker || "♡", close: match.kind === "wrap" ? match.close : marker || "♡" });
    else if (kind === "line-prefix") onChange({ kind, prefix: marker || "※" });
    else if (kind === "contains") onChange({ kind, text: marker || t("studio.messages.cardMarker") });
    else onChange({ kind, pattern: match.kind === "regex" ? match.pattern : "^(.+)$" });
  };
  let badPattern = false;
  if (match.kind === "regex") {
    try { new RegExp(match.pattern, "u"); } catch { try { new RegExp(match.pattern); } catch { badPattern = true; } }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Segmented
        label={t("studio.messages.find")}
        value={match.kind}
        options={MATCH_KINDS.map((k) => ({ value: k, label: t(`studio.messages.match.${k}`) }))}
        onChange={switchKind}
      />
      {match.kind === "wrap" && (
        <div className="grid grid-cols-2 gap-1.5">
          <label className="flex flex-col gap-1"><span className="text-[10px] text-muted-foreground/80">{t("studio.messages.open")}</span>
            <input value={match.open} maxLength={40} onChange={(e) => onChange({ ...match, open: e.target.value })} className={smallCls} /></label>
          <label className="flex flex-col gap-1"><span className="text-[10px] text-muted-foreground/80">{t("studio.messages.close")}</span>
            <input value={match.close} maxLength={40} onChange={(e) => onChange({ ...match, close: e.target.value })} className={smallCls} /></label>
        </div>
      )}
      {match.kind === "line-prefix" && (
        <label className="flex flex-col gap-1"><span className="text-[10px] text-muted-foreground/80">{t("studio.messages.prefix")}</span>
          <input value={match.prefix} maxLength={40} onChange={(e) => onChange({ ...match, prefix: e.target.value })} className={smallCls} /></label>
      )}
      {match.kind === "contains" && (
        <label className="flex flex-col gap-1"><span className="text-[10px] text-muted-foreground/80">{t("studio.messages.text")}</span>
          <input value={match.text} maxLength={200} onChange={(e) => onChange({ ...match, text: e.target.value })} className={smallCls} /></label>
      )}
      {match.kind === "regex" && (
        <label className="flex flex-col gap-1"><span className="text-[10px] text-muted-foreground/80">{t("studio.messages.pattern")}</span>
          <input value={match.pattern} maxLength={300} onChange={(e) => onChange({ ...match, pattern: e.target.value })} className={cn(smallCls, "font-mono", badPattern && "border-destructive")} />
          {badPattern && <span className="text-[10px] text-destructive">{t("studio.messages.badPattern")}</span>}
          <span className="text-[10px] leading-relaxed text-muted-foreground/70">{t("studio.messages.patternHint")}</span>
        </label>
      )}
    </div>
  );
}

function ShowOptions({ rule, onOptions, swatches, worldId }: {
  rule: UiMessageRule;
  onOptions: (patch: Partial<UiMessageRuleOptions>) => void;
  swatches: string[];
  worldId?: string | null;
}) {
  const { t } = useTranslation("editor");
  const o = rule.options ?? {};
  const fill = o.box?.fills?.[0]?.kind === "color" ? o.box.fills[0].color : undefined;
  const surface = (
    <div className="grid grid-cols-2 gap-1.5">
      <div className="flex flex-col gap-1">
        <span className="text-[10px] text-muted-foreground/80">{t("studio.messages.fill")}</span>
        <ColorField value={fill} swatches={swatches} allowNone label={t("studio.messages.fill")} editKey={`rule-${rule.id}-fill`}
          onChange={(color) => onOptions({ box: { ...o.box, fills: color ? [{ kind: "color", color }] : undefined } })} />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[10px] text-muted-foreground/80">{t("studio.messages.textColor")}</span>
        <ColorField value={o.text?.color} swatches={swatches} allowNone label={t("studio.messages.textColor")} editKey={`rule-${rule.id}-color`}
          onChange={(color) => onOptions({ text: { ...o.text, color } })} />
      </div>
    </div>
  );
  switch (rule.show) {
    case "reveal":
      return (
        <div className="flex flex-col gap-1.5">
          <Segmented
            label={t("studio.messages.cover")}
            value={o.cover ?? "ink"}
            options={(["ink", "blur", "sticker"] as const).map((c) => ({ value: c, label: t(`studio.messages.covers.${c}`) }))}
            onChange={(cover) => onOptions({ cover })}
          />
          <label className="flex flex-col gap-1"><span className="text-[10px] text-muted-foreground/80">{t("studio.messages.coverText")}</span>
            <input value={o.coverText ?? ""} maxLength={60} placeholder={t("studio.messages.coverTextPh")} onChange={(e) => onOptions({ coverText: e.target.value || undefined })} className={smallCls} /></label>
          <label className="flex flex-col gap-1">
            <span className="flex items-center justify-between text-[10px] text-muted-foreground/80">
              <span>{t("studio.messages.chance")}</span><span className="font-mono">{Math.round((o.revealChance ?? 1) * 100)}%</span>
            </span>
            <input type="range" min={0} max={100} step={5} value={Math.round((o.revealChance ?? 1) * 100)}
              onChange={(e) => { const v = Number(e.target.value) / 100; onOptions({ revealChance: v >= 1 ? undefined : v }); }}
              className="accent-primary" aria-label={t("studio.messages.chance")} />
          </label>
          {(o.revealChance ?? 1) < 1 && (
            <label className="flex flex-col gap-1"><span className="text-[10px] text-muted-foreground/80">{t("studio.messages.missText")}</span>
              <input value={o.missText ?? ""} maxLength={60} placeholder={t("studio.messages.missTextPh")} onChange={(e) => onOptions({ missText: e.target.value || undefined })} className={smallCls} /></label>
          )}
          <p className="text-[10px] leading-relaxed text-muted-foreground/70">{t("studio.messages.chanceHint")}</p>
        </div>
      );
    case "card":
      return (
        <div className="flex flex-col gap-1.5">
          <label className="flex flex-col gap-1"><span className="text-[10px] text-muted-foreground/80">{t("studio.messages.cardTitle")}</span>
            <input value={o.title ?? ""} maxLength={100} placeholder={t("studio.messages.cardTitlePh")} onChange={(e) => onOptions({ title: e.target.value || undefined })} className={smallCls} /></label>
          {surface}
        </div>
      );
    case "banner":
    case "choices":
      return surface;
    case "speaker": {
      const colors = o.colors ?? {};
      const avatars = o.avatars ?? {};
      const names = [...new Set([...Object.keys(colors), ...Object.keys(avatars)])];
      const rename = (from: string, to: string) => {
        const c = { ...colors }; const a = { ...avatars };
        if (from in c) { c[to] = c[from]!; delete c[from]; }
        if (from in a) { a[to] = a[from]!; delete a[from]; }
        onOptions({ colors: c, avatars: a });
      };
      return (
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] text-muted-foreground/80">{t("studio.messages.names")}</span>
          {names.map((name) => (
            <div key={name} className="flex items-center gap-1.5">
              <ImageField compact worldId={worldId} value={avatars[name]} onChange={(ref) => {
                const a = { ...avatars }; if (ref) a[name] = ref; else delete a[name];
                onOptions({ avatars: a, colors: { ...colors, [name]: colors[name] ?? "" } });
              }} />
              <input defaultValue={name} maxLength={60} aria-label={t("studio.messages.namePh")}
                onBlur={(e) => { const next = e.target.value.trim(); if (next && next !== name) rename(name, next); }}
                className={cn(smallCls, "w-20 flex-none")} />
              <ColorField value={colors[name] || undefined} swatches={swatches} allowNone label={name} editKey={`rule-${rule.id}-name-${name}`}
                onChange={(color) => onOptions({ colors: { ...colors, [name]: color ?? "" } })} />
              <button type="button" aria-label={t("studio.messages.remove")} className="rounded p-1 text-muted-foreground hover:text-destructive"
                onClick={() => { const c = { ...colors }; const a = { ...avatars }; delete c[name]; delete a[name]; onOptions({ colors: c, avatars: a }); }}>
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
          <button type="button" className="self-start text-[11px] text-primary hover:underline"
            onClick={() => {
              let n = 1; let name = t("studio.messages.namePh");
              while (name in colors) name = `${t("studio.messages.namePh")}${++n}`;
              onOptions({ colors: { ...colors, [name]: "" } });
            }}>
            + {t("studio.messages.addName")}
          </button>
          <p className="text-[10px] leading-relaxed text-muted-foreground/70">{t("studio.messages.nameHint")}</p>
        </div>
      );
    }
    default:
      return null;
  }
}

function RuleCard({ rule, index, count, open, onToggleOpen, onChange, onMove, onRemove, swatches, worldId, lang }: {
  rule: UiMessageRule; index: number; count: number; open: boolean; onToggleOpen: () => void;
  onChange: (next: UiMessageRule) => void; onMove: (delta: -1 | 1) => void; onRemove: () => void;
  swatches: string[]; worldId?: string | null; lang: string;
}) {
  const { t } = useTranslation("editor");
  const on = rule.enabled !== false;
  const onOptions = (patch: Partial<UiMessageRuleOptions>) => {
    const next = { ...(rule.options ?? {}), ...patch };
    // Empty maps and unset fields leave the document rather than lingering.
    for (const k of Object.keys(next) as Array<keyof UiMessageRuleOptions>) {
      const v = next[k];
      if (v === undefined || (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0)) delete next[k];
    }
    onChange({ ...rule, options: Object.keys(next).length ? next : undefined });
  };
  const matchLabel = rule.match.kind === "wrap" ? `${rule.match.open}…${rule.match.close}`
    : rule.match.kind === "line-prefix" ? `${rule.match.prefix}…`
    : rule.match.kind === "contains" ? rule.match.text : `/${rule.match.pattern.length > 18 ? `${rule.match.pattern.slice(0, 18)}…` : rule.match.pattern}/`;
  return (
    <div className={cn("rounded-md border border-border bg-background/40", !on && "opacity-60")} data-testid="message-rule">
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <button type="button" onClick={onToggleOpen} aria-expanded={open} aria-label={t("studio.messages.expand")} className="rounded p-0.5 text-muted-foreground hover:text-foreground">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        <button type="button" onClick={onToggleOpen} className="min-w-0 flex-1 text-left">
          <span className="block truncate text-xs font-medium">{rule.name || t(`studio.messages.shows.${rule.show}`)}</span>
          <span className="block truncate text-[10px] text-muted-foreground">
            <span className="font-mono">{matchLabel}</span> → {t(`studio.messages.shows.${rule.show}`)}
          </span>
        </button>
        <button type="button" role="switch" aria-checked={on} aria-label={t("studio.messages.enable")}
          onClick={() => onChange({ ...rule, enabled: on ? false : undefined })}
          className={cn("relative h-4 w-7 shrink-0 rounded-full transition-colors", on ? "bg-primary" : "bg-muted-foreground/30")}>
          <span className={cn("absolute top-0.5 h-3 w-3 rounded-full bg-background shadow transition-all", on ? "left-3.5" : "left-0.5")} />
        </button>
      </div>
      {open && (
        <div className="flex flex-col gap-2 border-t border-border/60 px-2 py-2">
          <label className="flex flex-col gap-1"><span className="text-[10px] text-muted-foreground/80">{t("studio.messages.ruleName")}</span>
            <input value={rule.name} maxLength={60} onChange={(e) => onChange({ ...rule, name: e.target.value })} className={smallCls} /></label>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-muted-foreground/80">{t("studio.messages.find")}</span>
            <MatchFields match={rule.match} onChange={(match) => onChange({ ...rule, match })} />
          </div>
          <label className="flex flex-col gap-1"><span className="text-[10px] text-muted-foreground/80">{t("studio.messages.show")}</span>
            <select value={rule.show} onChange={(e) => onChange({ ...rule, show: e.target.value as UiMessageShow })} className={smallCls}>
              {SHOWS.map((s) => <option key={s} value={s}>{t(`studio.messages.shows.${s}`)}</option>)}
            </select></label>
          <ShowOptions rule={rule} onOptions={onOptions} swatches={swatches} worldId={worldId} />
          <Toggle checked={!!rule.options?.applyToUser} label={t("studio.messages.applyToUser")} onChange={(v) => onOptions({ applyToUser: v || undefined })} />
          <div className="flex flex-col gap-1 rounded-md bg-accent/40 p-2">
            <Toggle checked={rule.teachAi !== false} label={t("studio.messages.teachAi")} onChange={(v) => onChange({ ...rule, teachAi: v ? undefined : false })} />
            {rule.teachAi !== false && (
              <>
                <textarea
                  value={rule.aiHint ?? ""}
                  maxLength={600}
                  rows={3}
                  placeholder={defaultAiHint(rule, lang)}
                  aria-label={t("studio.messages.aiHint")}
                  onChange={(e) => onChange({ ...rule, aiHint: e.target.value || undefined })}
                  className={cn(fieldCls, "resize-y text-[11px] leading-relaxed")}
                />
                <label className="flex flex-col gap-1"><span className="text-[10px] text-muted-foreground/80">{t("studio.messages.example")}</span>
                  <input value={rule.example ?? ""} maxLength={600} placeholder={ruleExample({ ...rule, example: undefined }, lang) ?? ""} onChange={(e) => onChange({ ...rule, example: e.target.value || undefined })} className={smallCls} /></label>
                <p className="text-[10px] leading-relaxed text-muted-foreground/70">{t("studio.messages.aiHintHint")}</p>
              </>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button type="button" disabled={index === 0} onClick={() => onMove(-1)} aria-label={t("studio.messages.moveUp")} title={t("studio.messages.moveUp")} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"><ArrowUp className="h-3 w-3" /></button>
            <button type="button" disabled={index === count - 1} onClick={() => onMove(1)} aria-label={t("studio.messages.moveDown")} title={t("studio.messages.moveDown")} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"><ArrowDown className="h-3 w-3" /></button>
            <span className="flex-1 text-[10px] text-muted-foreground/60">{t("studio.messages.orderHint")}</span>
            <button type="button" onClick={onRemove} className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
              <Trash2 className="h-3 w-3" />{t("studio.messages.remove")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A preset rule, named and worded in the creator's language. */
export function makePresetRule(presetId: string, t: (key: string) => string): UiMessageRule {
  const base = MESSAGE_RULE_PRESETS[presetId];
  const id = newRuleId();
  if (!base) {
    return { id, name: t("studio.messages.customName"), match: { kind: "wrap", open: "【", close: "】" }, show: "banner" };
  }
  const rule: UiMessageRule = { ...structuredClone(base), id, name: t(`studio.messages.rulePresets.${presetId}`) };
  if (presetId === "special-card") {
    rule.match = { kind: "contains", text: t("studio.messages.cardMarker") };
    rule.options = { ...rule.options, title: t("studio.messages.cardTitleDefault") };
  }
  return rule;
}

export function MessageDesignEditor({ lead, doc, pageId, edit, worldId }: {
  lead: MessagePart;
  doc: UiDoc;
  pageId: string;
  edit: (next: UiDoc) => void;
  worldId?: string | null;
}) {
  const { t, i18n } = useTranslation("editor");
  const lang = contentLanguage(i18n.language);
  const swatches = useMemo(() => themeSwatches(doc), [doc]);
  const [side, setSide] = useState<Side>("assistant");
  const [openRule, setOpenRule] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const style = lead.messageStyle ?? {};
  const rules = Array.isArray(lead.rules) ? lead.rules : [];

  const patch = (fn: (el: MessagePart) => MessagePart) =>
    edit(updateElements(doc, pageId, [lead.id], (el) => (el.type === "chat" || el.type === "messages" ? fn(el) : el)));
  const setStyle = (next: UiMessageStyle | undefined) => patch((el) => {
    const { messageStyle: _drop, ...rest } = el;
    return next && Object.keys(next).length ? { ...rest, messageStyle: next } as MessagePart : rest as MessagePart;
  });
  const setRules = (next: UiMessageRule[]) => patch((el) => {
    const { rules: _drop, ...rest } = el;
    return next.length ? { ...rest, rules: next } as MessagePart : rest as MessagePart;
  });
  const setRule = (i: number, next: UiMessageRule) => setRules(rules.map((r, j) => (j === i ? next : r)));

  return (
    <>
      <Section label={t("studio.messages.look")} testId="message-look">
        <StyleGallery
          current={style.preset}
          onPick={(id) => setStyle(id ? structuredClone(MESSAGE_STYLE_PRESETS[id]) : undefined)}
        />
      </Section>

      {/* A look is one pick above; the type, the bubbles and the special
          formats are there for whoever wants them, one line until then. */}
      <MoreSection label={t("studio.messages.fineTune")} storageKey="yumina-ui-message-finetune">
      <div className="border-b border-border/50 px-3 py-2.5" data-testid="message-fine">
        <div className="flex flex-col gap-2">
          <Segmented
            label={t("studio.messages.side")}
            value={side}
            options={(["assistant", "user", "greeting"] as const).map((s) => ({ value: s, label: t(`studio.messages.sides.${s}`) }))}
            onChange={setSide}
          />
          {side === "greeting" && <p className="text-[10px] leading-relaxed text-muted-foreground/70">{t("studio.messages.greetingHint")}</p>}
          <RoleStyleFields
            key={side}
            side={side}
            value={style[side]}
            swatches={swatches}
            onChange={(next) => setStyle({ ...style, [side]: next })}
          />
          <div className="mt-1 flex flex-col gap-2 border-t border-border/50 pt-2">
            <Toggle checked={style.showNames !== false} label={t("studio.messages.showNames")} onChange={(v) => setStyle({ ...style, showNames: v ? undefined : false })} />
            <div className="grid grid-cols-2 gap-1.5">
              <NumberField label={t("studio.messages.maxWidth")} min={200} max={4000} placeholder={t("studio.messages.maxWidthNone")} value={style.maxWidth} onChange={(maxWidth) => setStyle({ ...style, maxWidth })} />
              <NumberField label={t("studio.messages.gap")} min={0} max={200} value={style.gap} onChange={(gap) => setStyle({ ...style, gap })} />
            </div>
          </div>
        </div>
      </div>

      <Section label={t("studio.messages.rules")} hint={t("studio.messages.rulesHint")} testId="message-rules">
        <div className="flex flex-col gap-1.5">
          {rules.length === 0 && <p className="text-[11px] leading-relaxed text-muted-foreground">{t("studio.messages.empty")}</p>}
          {rules.map((rule, i) => (
            <RuleCard
              key={rule.id}
              rule={rule}
              index={i}
              count={rules.length}
              open={openRule === rule.id}
              onToggleOpen={() => setOpenRule((cur) => (cur === rule.id ? null : rule.id))}
              onChange={(next) => setRule(i, next)}
              onMove={(delta) => {
                const next = [...rules];
                const [moved] = next.splice(i, 1);
                next.splice(i + delta, 0, moved!);
                setRules(next);
              }}
              onRemove={() => setRules(rules.filter((_, j) => j !== i))}
              swatches={swatches}
              worldId={worldId}
              lang={lang}
            />
          ))}
          {adding ? (
            <div className="grid grid-cols-2 gap-1" data-testid="message-rule-presets">
              {[...RULE_PRESET_IDS, "custom" as const].map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    const rule = makePresetRule(id, t as unknown as (key: string) => string);
                    setRules([...rules, rule]);
                    setOpenRule(rule.id);
                    setAdding(false);
                  }}
                  className="rounded-md border border-dashed border-border px-1.5 py-1.5 text-[11px] text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
                >
                  {t(`studio.messages.rulePresets.${id}`)}
                </button>
              ))}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="flex items-center justify-center gap-1 rounded-md border border-dashed border-border py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
            >
              <Plus className="h-3 w-3" />{t("studio.messages.add")}
            </button>
          )}
        </div>
      </Section>
      </MoreSection>
    </>
  );
}
