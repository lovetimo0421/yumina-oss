import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { UI_CHAT_STARTED } from "@yumina/engine";
import type { AudioTrack, Condition, UiAction, UiPage, Variable } from "@yumina/engine";
import { templateFromDisplay, templateToDisplay } from "./template-names";

/**
 * What a button does and when a part shows — the two things that turn an
 * arranged card into one a player can act on.
 *
 * Both are thin over the document: a button holds an ordered list of steps
 * (`UiAction[]`) and every element holds at most one `visibleWhen`. The panel
 * speaks the creator's language about them — 改变量, 切换开场白, 还没开始聊 —
 * and writes the plain data the compiler already understands.
 */

const field = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary";
const smallField = "w-full rounded border border-border bg-background px-1.5 py-1 text-[11px] outline-none focus:border-primary";

/** The steps a creator can pick, in the order the menu offers them. */
export const ACTION_KINDS = [
  "send-message",
  "set-variable",
  "run-behavior",
  "run-ai",
  "switch-greeting",
  "random",
  "go-page",
  "toast",
  "play-audio",
  "stop-audio",
  "regenerate",
  "rewind",
] as const satisfies readonly UiAction["kind"][];

export interface GreetingOption {
  /** Index into the card's openings as the player's chat orders them. */
  index: number;
  /** The opening's entry id, stored on the step so it survives reordering. */
  id?: string;
  label: string;
}

export interface ActionContext {
  variables: Variable[];
  pages: UiPage[];
  /** The page the button is on — "跳到页面" defaults to a different one. */
  pageId: string;
  greetings: GreetingOption[];
  tracks: AudioTrack[];
  /** The card's behaviours a button can set off (see button-behaviors.ts). */
  behaviors?: Array<{ id: string; name: string; actionId: string }>;
  /** Make a new one under this name; returns the action id it listens for. */
  newBehavior?: (name: string) => string;
  /** Show one on the canvas. */
  openBehavior?: (reactionId: string) => void;
  /** What a list can show of the card's entries: its characters, and each of
   *  the creator's folders, with how many each holds. */
  entrySources?: Array<{ key: string; source: { role?: string; folderId?: string }; label: string }>;
  /** Make a new character entry under this name. */
  newCharacter?: (name: string) => void;
  /** The card's UI-based AIs: the ones a button can call. */
  ais?: Array<{ id: string; name: string }>;
  /** Make a new UI-based AI on the card; returns its id. */
  newAi?: () => string | null;
}

const NEW_BEHAVIOR = "__new__";
const NEW_AI = "__new_ai__";

/** Which behaviour a step sets off: one the card has, or a new one named on
 *  the spot. The one picked opens on the canvas, where what it does is set. */
function BehaviorPick({ value, ctx, onPick }: { value: string; ctx: ActionContext; onPick: (actionId: string) => void }) {
  const { t } = useTranslation("editor");
  const list = ctx.behaviors ?? [];
  const [naming, setNaming] = useState<string | null>(null);
  const current = list.find((b) => b.actionId === value);
  const create = () => {
    const name = naming?.trim();
    if (!name || !ctx.newBehavior) return;
    const actionId = ctx.newBehavior(name);
    setNaming(null);
    onPick(actionId);
  };
  return (
    <div className="flex flex-col gap-1" data-behavior-pick="">
      <div className="flex gap-1.5">
        <select
          value={naming !== null ? NEW_BEHAVIOR : value}
          aria-label={t("studio.element.behaviorPick")}
          onChange={(e) => {
            if (e.target.value === NEW_BEHAVIOR) { setNaming(""); return; }
            setNaming(null);
            onPick(e.target.value);
          }}
          className={`${smallField} min-w-0 flex-1`}
        >
          {!value && naming === null && <option value="" disabled>{t("studio.element.behaviorPick")}</option>}
          {value && !current && <option value={value}>{t("studio.element.behaviorMissing", { id: value })}</option>}
          {list.map((b) => <option key={b.id} value={b.actionId}>{b.name}</option>)}
          {ctx.newBehavior && <option value={NEW_BEHAVIOR}>{t("studio.element.behaviorNew")}</option>}
        </select>
        {current && naming === null && ctx.openBehavior && (
          <button
            type="button"
            data-open-behavior=""
            onClick={() => ctx.openBehavior?.(current.id)}
            className="shrink-0 rounded border border-border px-1.5 text-[11px] text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
          >
            {t("studio.element.behaviorOpen")}
          </button>
        )}
      </div>
      {naming !== null && (
        <div className="flex gap-1.5">
          <input
            autoFocus
            value={naming}
            onChange={(e) => setNaming(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") create(); if (e.key === "Escape") setNaming(null); }}
            placeholder={t("studio.element.behaviorNewName")}
            className={`${smallField} min-w-0 flex-1`}
          />
          <button type="button" onClick={create} disabled={!naming.trim()}
            className="rounded-md bg-primary px-2.5 text-[11px] font-semibold text-primary-foreground disabled:opacity-40">
            {t("studio.element.newVariableCreate")}
          </button>
        </div>
      )}
    </div>
  );
}

/** A value typed into a field, as the variable it is for would hold it. */
export function parseValueFor(variable: Variable | undefined, raw: string): number | string | boolean {
  if (variable?.type === "number") {
    const value = Number(raw);
    return Number.isFinite(value) ? value : 0;
  }
  if (variable?.type === "boolean") return raw === "true";
  return raw;
}

/** A fresh step of one kind, filled in with the most likely target so it does
 *  something the moment it is added. */
export function defaultAction(kind: UiAction["kind"], ctx: ActionContext): UiAction {
  switch (kind) {
    case "send-message":
      return { kind, text: { template: "" } };
    case "set-variable": {
      const v = ctx.variables[0];
      if (!v) return { kind, variableId: "", op: "set", value: "" };
      if (v.type === "boolean") return { kind, variableId: v.id, op: "toggle" };
      if (v.type === "number") return { kind, variableId: v.id, op: "add", value: 1 };
      return { kind, variableId: v.id, op: "set", value: v.options?.[0] ?? "" };
    }
    case "switch-greeting":
      return { kind, index: ctx.greetings[0]?.index ?? 0, ...(ctx.greetings[0]?.id ? { greetingId: ctx.greetings[0].id } : {}) };
    case "random": {
      const v = ctx.variables[0];
      return v?.type === "number" ? { kind, variableId: v.id, min: 1, max: 20 } : { kind, variableId: v?.id ?? "", from: [] };
    }
    case "go-page":
      return { kind, pageId: ctx.pages.find((p) => p.id !== ctx.pageId)?.id ?? ctx.pages[0]?.id ?? "" };
    case "toast":
      return { kind, text: { template: "" } };
    case "run-behavior":
      return { kind, actionId: ctx.behaviors?.[0]?.actionId ?? "" };
    case "run-ai":
      return { kind, aiId: ctx.ais?.[0]?.id ?? "" };
    case "play-audio":
      return { kind, trackId: ctx.tracks[0]?.id ?? "" };
    case "stop-audio":
      return { kind };
    case "regenerate":
      return { kind };
    case "copy-message":
      return { kind };
    case "rewind":
      return { kind };
  }
}

/** Which ways a variable of this type can be changed. */
function opsFor(variable: Variable | undefined): Array<"set" | "add" | "subtract" | "toggle"> {
  if (variable?.type === "number") return ["set", "add", "subtract"];
  if (variable?.type === "boolean") return ["set", "toggle"];
  return ["set"];
}

/** A value field shaped by the variable: a number box, 是/否, or the options a
 *  string variable is limited to. */
function ValueInput({
  variable, value, onChange, className,
}: {
  variable: Variable | undefined;
  value: unknown;
  onChange: (value: number | string | boolean) => void;
  className: string;
}) {
  const { t } = useTranslation("editor");
  if (variable?.type === "boolean") {
    return (
      <select value={String(value === true)} onChange={(e) => onChange(e.target.value === "true")} className={className}>
        <option value="true">{t("studio.element.valueTrue")}</option>
        <option value="false">{t("studio.element.valueFalse")}</option>
      </select>
    );
  }
  if (variable?.type === "string" && variable.options && variable.options.length > 0) {
    const current = typeof value === "string" ? value : "";
    return (
      <select value={current} onChange={(e) => onChange(e.target.value)} className={className}>
        {!variable.options.includes(current) && <option value={current}>{current || "—"}</option>}
        {variable.options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  return (
    <input
      type={variable?.type === "number" ? "number" : "text"}
      value={value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value)}
      placeholder={t("studio.element.valuePlaceholder")}
      onChange={(e) => onChange(parseValueFor(variable, e.target.value))}
      className={className}
    />
  );
}

/** Text a step says, with a picker that drops `{{变量}}` in for the creator
 *  who does not know the macro exists. */
function TextWithVariables({
  value, onChange, placeholder, variables, rows = 2,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  variables: Variable[];
  rows?: number;
}) {
  const { t } = useTranslation("editor");
  // The document keeps `{{id}}`; the box shows the variable's name — and a
  // picked option's `{{choice}}` shows as the words the hint above uses.
  const named = [...variables, { id: "choice", name: t("studio.parts.choice.theChoice") }];
  return (
    <div className="flex flex-col gap-1">
      <textarea
        rows={rows}
        // Shown with variable NAMES; stored with ids (see template-names.ts).
        value={templateToDisplay(value, named)}
        placeholder={placeholder}
        onChange={(e) => onChange(templateFromDisplay(e.target.value, named))}
        className={`${field} resize-none`}
      />
      {variables.length > 0 && (
        <select
          value=""
          onChange={(e) => { if (e.target.value) onChange(`${value}{{${e.target.value}}}`); }}
          className={`${smallField} text-muted-foreground`}
          aria-label={t("studio.element.insertVariable")}
        >
          <option value="">{t("studio.element.insertVariable")}</option>
          {variables.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      )}
    </div>
  );
}

function ActionFields({ action, ctx, onChange }: { action: UiAction; ctx: ActionContext; onChange: (next: UiAction) => void }) {
  const { t } = useTranslation("editor");
  switch (action.kind) {
    case "send-message":
      return (
        <TextWithVariables
          value={action.text.template}
          onChange={(template) => onChange({ ...action, text: { template } })}
          placeholder={t("studio.element.saysPlaceholder")}
          variables={ctx.variables}
        />
      );
    case "toast":
      return (
        <TextWithVariables
          rows={1}
          value={action.text.template}
          onChange={(template) => onChange({ ...action, text: { template } })}
          placeholder={t("studio.element.toastPlaceholder")}
          variables={ctx.variables}
        />
      );
    case "set-variable": {
      if (ctx.variables.length === 0) return <p className="text-[11px] text-muted-foreground">{t("studio.element.noVariables")}</p>;
      const variable = ctx.variables.find((v) => v.id === action.variableId);
      const ops = opsFor(variable);
      return (
        <div className="grid grid-cols-[1fr_auto] gap-1.5">
          <select
            value={action.variableId}
            onChange={(e) => {
              const next = ctx.variables.find((v) => v.id === e.target.value);
              const nextOps = opsFor(next);
              const op = nextOps.includes(action.op) ? action.op : nextOps[0]!;
              const value = next?.type === "number" ? 1 : next?.type === "boolean" ? true : next?.options?.[0] ?? "";
              onChange({ kind: "set-variable", variableId: e.target.value, op, ...(op === "toggle" ? {} : { value }) });
            }}
            className={smallField}
          >
            {!variable && <option value={action.variableId}>{action.variableId || "—"}</option>}
            {ctx.variables.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
          <select
            value={action.op}
            onChange={(e) => {
              const op = e.target.value as typeof action.op;
              onChange(op === "toggle" ? { kind: "set-variable", variableId: action.variableId, op } : { ...action, op });
            }}
            className={smallField}
          >
            {ops.map((op) => <option key={op} value={op}>{t(`studio.element.op.${op}` as never)}</option>)}
          </select>
          {action.op !== "toggle" && (
            <div className="col-span-2">
              <ValueInput
                variable={variable}
                value={action.value}
                onChange={(value) => onChange({ ...action, value })}
                className={smallField}
              />
            </div>
          )}
        </div>
      );
    }
    case "switch-greeting":
      if (ctx.greetings.length === 0) return <p className="text-[11px] text-muted-foreground">{t("studio.element.noGreetings")}</p>;
      return (
        <div className="flex flex-col gap-1">
          <select value={String(action.index)} onChange={(e) => {
            const index = Number(e.target.value);
            const id = ctx.greetings.find((g) => g.index === index)?.id;
            const { greetingId: _old, ...rest } = action;
            onChange(id ? { ...rest, index, greetingId: id } : { ...rest, index });
          }} className={smallField}>
            {!ctx.greetings.some((g) => g.index === action.index) && (
              <option value={String(action.index)}>{t("studio.element.greetingN", { n: action.index + 1 })}</option>
            )}
            {ctx.greetings.map((g) => <option key={g.index} value={String(g.index)}>{g.label}</option>)}
          </select>
          <p className="text-[10px] leading-relaxed text-muted-foreground/70">{t("studio.element.greetingHint")}</p>
        </div>
      );
    case "random": {
      if (ctx.variables.length === 0) return <p className="text-[11px] text-muted-foreground">{t("studio.element.noVariables")}</p>;
      const variable = ctx.variables.find((v) => v.id === action.variableId);
      const numeric = variable?.type === "number";
      return (
        <div className="flex flex-col gap-1.5">
          <select
            value={action.variableId}
            onChange={(e) => {
              const next = ctx.variables.find((v) => v.id === e.target.value);
              onChange(next?.type === "number"
                ? { kind: "random", variableId: e.target.value, min: action.min ?? 1, max: action.max ?? 20 }
                : { kind: "random", variableId: e.target.value, from: action.from ?? [] });
            }}
            className={smallField}
          >
            {!variable && <option value={action.variableId}>{action.variableId || "—"}</option>}
            {ctx.variables.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
          {numeric ? (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <input type="number" value={action.min ?? 1} onChange={(e) => onChange({ ...action, min: Math.round(Number(e.target.value) || 0) })} className={smallField} aria-label={t("studio.element.randomMin")} />
              <span className="shrink-0">~</span>
              <input type="number" value={action.max ?? 20} onChange={(e) => onChange({ ...action, max: Math.round(Number(e.target.value) || 0) })} className={smallField} aria-label={t("studio.element.randomMax")} />
            </div>
          ) : (
            <textarea
              rows={4}
              value={(action.from ?? []).join("\n")}
              placeholder={t("studio.element.randomFromPlaceholder")}
              onChange={(e) => onChange({ ...action, from: e.target.value.split("\n") })}
              className={`${smallField} resize-y`}
            />
          )}
          <p className="text-[10px] leading-relaxed text-muted-foreground/70">{t(numeric ? "studio.element.randomNumberHint" : "studio.element.randomFromHint")}</p>
        </div>
      );
    }
    case "run-behavior": {
      const params = action.params ?? [];
      const setParams = (next: typeof params) => onChange({ ...action, params: next.length ? next : undefined });
      return (
        <div className="space-y-1.5">
          <BehaviorPick value={action.actionId} ctx={ctx} onPick={(actionId) => onChange({ ...action, actionId })} />
          {/* What the button passes in: the behaviour reads it as {参数.名字}. */}
          {params.map((p, i) => (
            <div key={i} className="flex items-center gap-1" data-step-param={p.name}>
              <input value={p.name} placeholder={t("studio.element.paramName")} onChange={(e) => setParams(params.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} className={`${smallField} w-20`} />
              <input value={p.value.template} placeholder={t("studio.element.paramValue")} onChange={(e) => setParams(params.map((x, j) => (j === i ? { ...x, value: { template: e.target.value } } : x)))} className={smallField} />
              <button type="button" aria-label={t("studio.element.removeStep")} onClick={() => setParams(params.filter((_, j) => j !== i))} className="shrink-0 text-muted-foreground hover:text-foreground">×</button>
            </div>
          ))}
          <button type="button" data-step-param-add="" onClick={() => setParams([...params, { name: "", value: { template: "" } }])} className="text-[11px] text-muted-foreground hover:text-foreground">
            {t("studio.element.addParam")}
          </button>
        </div>
      );
    }
    case "run-ai": {
      const ais = ctx.ais ?? [];
      return (
        <select
          value={action.aiId}
          data-step-ai=""
          onChange={(e) => {
            if (e.target.value !== NEW_AI) { onChange({ kind: "run-ai", aiId: e.target.value }); return; }
            const id = ctx.newAi?.();
            if (id) onChange({ kind: "run-ai", aiId: id });
          }}
          className={smallField}
        >
          {!ais.some((a) => a.id === action.aiId) && <option value={action.aiId}>—</option>}
          {ais.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          {ctx.newAi && <option value={NEW_AI}>{t("studio.element.newAi")}</option>}
        </select>
      );
    }
    case "go-page":
      return (
        <select value={action.pageId} onChange={(e) => onChange({ ...action, pageId: e.target.value })} className={smallField}>
          {!ctx.pages.some((p) => p.id === action.pageId) && <option value={action.pageId}>—</option>}
          {ctx.pages.map((p) => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}
        </select>
      );
    case "play-audio":
      if (ctx.tracks.length === 0) return <p className="text-[11px] text-muted-foreground">{t("studio.element.noTracks")}</p>;
      return (
        <select value={action.trackId} onChange={(e) => onChange({ ...action, trackId: e.target.value })} className={smallField}>
          {!ctx.tracks.some((tr) => tr.id === action.trackId) && <option value={action.trackId}>—</option>}
          {ctx.tracks.map((tr) => <option key={tr.id} value={tr.id}>{tr.name || tr.id}</option>)}
        </select>
      );
    case "stop-audio":
      return (
        <select
          value={action.trackId ?? ""}
          onChange={(e) => onChange(e.target.value ? { kind: "stop-audio", trackId: e.target.value } : { kind: "stop-audio" })}
          className={smallField}
        >
          <option value="">{t("studio.element.stopAll")}</option>
          {ctx.tracks.map((tr) => <option key={tr.id} value={tr.id}>{tr.name || tr.id}</option>)}
        </select>
      );
    default:
      return null;
  }
}

/**
 * The button's steps, top to bottom, run in that order when it is pressed. A
 * step that has to finish first (switching the opening) is waited for before
 * the next one starts — the compiler owns that; the list only owns the order.
 */
export function ActionListEditor({
  actions, ctx, onChange, label, hint, bare = false,
}: {
  actions: UiAction[];
  ctx: ActionContext;
  onChange: (next: UiAction[]) => void;
  /** The heading; a button's is 「按下时，依次做」, a card's 「选了以后」. */
  label?: string;
  /** A line under the heading — what `{{choice}}` / `{{item}}` mean here. */
  hint?: string;
  /** Inside another box (a card's row in a table) — no section frame of its own. */
  bare?: boolean;
}) {
  const { t } = useTranslation("editor");
  const replace = (i: number, next: UiAction) => onChange(actions.map((a, j) => (j === i ? next : a)));
  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= actions.length) return;
    const next = actions.slice();
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  return (
    <div className={bare ? undefined : "border-b border-border/50 px-3 py-2.5"} data-testid="button-actions">
      <span className="mb-1.5 block text-[11px] font-medium text-muted-foreground">{label ?? t("studio.element.onPress")}</span>
      {hint && <p className="mb-1.5 text-[10px] leading-relaxed text-muted-foreground/70">{hint}</p>}
      {actions.length === 0 && <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground/70">{t("studio.element.noActions")}</p>}
      <ol className="flex flex-col gap-1.5">
        {actions.map((action, i) => {
          const offered = (ACTION_KINDS as readonly string[]).includes(action.kind);
          return (
            <li key={i} className="rounded-md border border-border/60 bg-background/40 p-2">
              <div className="mb-1.5 flex items-center gap-1">
                <span className="w-4 shrink-0 text-center text-[10px] font-semibold text-muted-foreground/70">{i + 1}</span>
                <select
                  value={action.kind}
                  aria-label={t("studio.element.stepKind")}
                  onChange={(e) => replace(i, defaultAction(e.target.value as UiAction["kind"], ctx))}
                  className={`${smallField} min-w-0 flex-1`}
                >
                  {!offered && <option value={action.kind}>{t(`studio.element.action.${action.kind}` as never)}</option>}
                  {ACTION_KINDS.map((kind) => <option key={kind} value={kind}>{t(`studio.element.action.${kind}` as never)}</option>)}
                </select>
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} title={t("studio.element.moveUp")} aria-label={t("studio.element.moveUp")} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30">
                  <ArrowUp className="h-3 w-3" />
                </button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === actions.length - 1} title={t("studio.element.moveDown")} aria-label={t("studio.element.moveDown")} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30">
                  <ArrowDown className="h-3 w-3" />
                </button>
                <button type="button" onClick={() => onChange(actions.filter((_, j) => j !== i))} title={t("studio.element.removeStep")} aria-label={t("studio.element.removeStep")} className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                  <X className="h-3 w-3" />
                </button>
              </div>
              <ActionFields action={action} ctx={ctx} onChange={(next) => replace(i, next)} />
            </li>
          );
        })}
      </ol>
      <button
        type="button"
        onClick={() => onChange([...actions, defaultAction(actions.length === 0 ? "send-message" : "set-variable", ctx)])}
        className="mt-2 flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
      >
        <Plus className="h-3 w-3" />
        {t("studio.element.addStep")}
      </button>
    </div>
  );
}

// ── When a part shows ──────────────────────────────────────────────────────

type ShowMode = "always" | "notStarted" | "started" | "variable";

export function showModeOf(cond: Condition | undefined): ShowMode {
  if (!cond) return "always";
  if (cond.variableId === UI_CHAT_STARTED) {
    const wantsStarted = cond.operator === "neq" ? cond.value !== true : cond.value === true;
    return wantsStarted ? "started" : "notStarted";
  }
  return "variable";
}

const OPERATORS: Condition["operator"][] = ["eq", "neq", "gt", "gte", "lt", "lte", "contains"];

function operatorsFor(variable: Variable | undefined): Condition["operator"][] {
  if (variable?.type === "number") return ["eq", "neq", "gt", "gte", "lt", "lte"];
  if (variable?.type === "boolean") return ["eq", "neq"];
  if (variable?.type === "json") return ["contains", "eq", "neq"];
  return ["eq", "neq", "contains"];
}

/** 满足条件才显示: one condition per part, plus the two that opening flows are
 *  built from and no variable holds — before and after the first message. */
export function ConditionEditor({
  condition, variables, onChange,
}: {
  condition: Condition | undefined;
  variables: Variable[];
  onChange: (next: Condition | undefined) => void;
}) {
  const { t } = useTranslation("editor");
  const mode = showModeOf(condition);
  const setMode = (next: ShowMode) => {
    if (next === "always") return onChange(undefined);
    if (next === "notStarted") return onChange({ variableId: UI_CHAT_STARTED, operator: "eq", value: false });
    if (next === "started") return onChange({ variableId: UI_CHAT_STARTED, operator: "eq", value: true });
    const v = variables[0];
    onChange({
      variableId: v?.id ?? "",
      operator: "eq",
      value: v?.type === "number" ? 0 : v?.type === "boolean" ? true : v?.options?.[0] ?? "",
    });
  };
  const variable = condition && mode === "variable" ? variables.find((v) => v.id === condition.variableId) : undefined;
  const ops = operatorsFor(variable);
  return (
    <div className="border-b border-border/50 px-3 py-2.5" data-testid="visible-when">
      <span className="mb-1.5 block text-[11px] font-medium text-muted-foreground">{t("studio.element.showWhen")}</span>
      <select value={mode} onChange={(e) => setMode(e.target.value as ShowMode)} className={field}>
        <option value="always">{t("studio.element.show.always")}</option>
        <option value="notStarted">{t("studio.element.show.notStarted")}</option>
        <option value="started">{t("studio.element.show.started")}</option>
        <option value="variable" disabled={variables.length === 0}>{t("studio.element.show.variable")}</option>
      </select>
      {mode === "variable" && condition && (
        <div className="mt-1.5 grid grid-cols-[1fr_auto] gap-1.5">
          <select
            value={condition.variableId}
            onChange={(e) => {
              const next = variables.find((v) => v.id === e.target.value);
              const nextOps = operatorsFor(next);
              onChange({
                variableId: e.target.value,
                operator: nextOps.includes(condition.operator) ? condition.operator : nextOps[0]!,
                value: next?.type === "number" ? 0 : next?.type === "boolean" ? true : next?.options?.[0] ?? "",
              });
            }}
            className={smallField}
          >
            {!variable && <option value={condition.variableId}>{condition.variableId || "—"}</option>}
            {variables.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
          <select
            value={condition.operator}
            onChange={(e) => onChange({ ...condition, operator: e.target.value as Condition["operator"] })}
            className={smallField}
          >
            {(ops.includes(condition.operator) ? ops : [condition.operator, ...ops]).filter((op) => OPERATORS.includes(op)).map((op) => (
              <option key={op} value={op}>{t(`studio.element.cmp.${op}` as never)}</option>
            ))}
          </select>
          <div className="col-span-2">
            <ValueInput
              variable={variable}
              value={condition.value}
              onChange={(value) => {
                const { valueRef: _drop, ...rest } = condition;
                onChange({ ...rest, value });
              }}
              className={smallField}
            />
          </div>
        </div>
      )}
      {mode !== "always" && <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground/70">{t("studio.element.showHint")}</p>}
    </div>
  );
}
