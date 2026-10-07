import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, Check as CheckIcon, ChevronDown, Plus, Variable as VariableIcon, X } from "lucide-react";
import type { AudioTrack, Condition, Reaction, ReactionEffect, Variable, WorldEntry } from "@yumina/engine";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { WhenEditor, RandomValueEditor, getWhenPresets } from "@/features/editor/sections/behaviors-section";
import { extractFieldValues, getDoPresets, identifyPreset, parseSmartValue, type DoField, type DoPreset } from "@/features/editor/lib/behavior-effect-presets";
import { preserveLegacyEffect } from "@/features/editor/lib/editable-behaviors";
import { buildWhenForPreset, resolveWhenPreset } from "@/features/editor/lib/when-preset-logic";
import {
  defaultConditionForVariable,
  normalizeConditionForVariable,
  operatorsForVariableType,
  parseJsonConditionValue,
  resolveVariableForCondition,
} from "@/features/editor/lib/entry-conditions";
import { useEditorStore } from "@/stores/editor";

/**
 * A behaviour, read as sentences.
 *
 * The full editor lays a behaviour out as a form: a labelled field for the
 * trigger, a boxed card per condition with four selects in it, a boxed card
 * per effect with a labelled field per parameter. In a 400px column that is
 * a wall. Here each part is the sentence a person would say — "变量 好感
 * ≥ 80", "把 好感 设为 100" — with the words as quiet text and the
 * changeable parts as small glass slots in the line. Nothing is boxed; a
 * line is a line.
 *
 * The data never changes shape: the same presets, the same build/extract
 * round trip, the same normalisers as the classic editor, so a behaviour
 * opened here and saved is the behaviour that was there.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TFn = (key: any, opts?: any) => string;
type SetEffect = Extract<ReactionEffect, { type: "set" }>;
type ValueMode = "const" | "var" | "random";

const OP_GLYPH: Record<Condition["operator"], string> = { eq: "=", neq: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤", contains: "∋" };
const CHANGE_OPS = ["set", "add", "subtract", "multiply", "toggle", "append"] as const;
const VARIABLE_TYPES: Variable["type"][] = ["number", "string", "boolean", "json"];
const NEW_VARIABLE = "__new__";

/* ── The words and the slots ─────────────────────────────────────────── */

/** A word of the sentence: quiet, never wraps mid-word. */
const word = "shrink-0 whitespace-nowrap text-xs text-foreground/55";
/** A slot: one small sheet of glass in the line of text. */
const slot = "studio-control h-[26px] min-w-0 rounded-md border px-2 text-xs text-foreground focus:studio-control-focus focus:outline-none disabled:opacity-40";
const selectSlot = cn(slot, "max-w-full appearance-none pr-6 [&>optgroup]:bg-[#181a24] [&>option]:bg-[#181a24]");

function Word({ text }: { text: string }) {
  return text ? <span className={word}>{text}</span> : null;
}

/** A text or number slot that keeps its own draft and commits when the
 *  author leaves it, so a half-typed "1" never writes 1 into the world. */
function TextSlot({ value, onCommit, type = "text", placeholder, width = "w-[72px]", label }: {
  value: string; onCommit: (next: string) => void; type?: "text" | "number"; placeholder?: string; width?: string; label?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const commit = () => { if (draft !== value) onCommit(draft); };
  return (
    <input
      type={type}
      value={draft}
      aria-label={label}
      title={label}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); (e.target as HTMLInputElement).blur(); } if (e.key === "Escape") setDraft(value); }}
      className={cn(slot, width, type === "number" && "tabular-nums")}
    />
  );
}

function SelectSlot({ value, onChange, children, label, width }: { value: string; onChange: (v: string) => void; children: ReactNode; label?: string; width?: string }) {
  return (
    <span className={cn("relative inline-flex min-w-0", width)}>
      <select value={value} aria-label={label} title={label} onChange={(e) => onChange(e.target.value)} className={cn(selectSlot, "w-full")}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-foreground/45" />
    </span>
  );
}

/** One sentence: an optional glyph at the head, the words and slots wrapping
 *  as one line of text, and a way to take the sentence out at the end. */
function Sentence({ icon, children, onRemove, removeLabel, below, className }: {
  icon?: ReactNode; children: ReactNode; onRemove?: () => void; removeLabel?: string; below?: ReactNode; className?: string;
}) {
  return (
    <div className={cn("group/sentence py-1", className)}>
      <div className="flex items-start gap-1.5">
        {icon && <span className="mt-[6px] shrink-0 text-foreground/40">{icon}</span>}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1.5">{children}</div>
        {onRemove && (
          <button type="button" onClick={onRemove} aria-label={removeLabel} title={removeLabel}
            className="mt-[5px] shrink-0 rounded p-0.5 text-foreground/30 transition-colors hover:bg-white/[0.06] hover:text-foreground">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {below && <div className={cn("mt-1.5", icon && "pl-[22px]")}>{below}</div>}
    </div>
  );
}

/** "+ add" as a quiet line under the list, not a button in a box. */
function AddLine({ label, onClick, disabled }: { label: string; onClick?: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className="flex h-7 items-center gap-1 rounded-md px-1 -ml-1 text-xs text-foreground/50 transition-colors hover:bg-white/[0.05] hover:text-foreground disabled:opacity-40">
      <Plus className="h-3.5 w-3.5" />{label}
    </button>
  );
}

function EmptyLine({ text }: { text: ReactNode }) {
  return <p className="py-1 text-xs text-foreground/40">{text}</p>;
}

/** A variable made right here. The picker's last option is "new…"; picking
 *  it swaps the slot for this line, and Enter puts the new variable in. */
function NewVariableLine({ onCreate, onCancel }: { onCreate: (draft: { name: string; type: Variable["type"] }) => void; onCancel: () => void }) {
  const { t } = useTranslation("editor");
  const [name, setName] = useState("");
  const [type, setType] = useState<Variable["type"]>("number");
  const finish = () => { const n = name.trim(); if (n) onCreate({ name: n, type }); };
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-condition-new-variable>
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("conditionEditor.newVariableName")}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); finish(); } if (e.key === "Escape") onCancel(); }}
        className={cn(slot, "w-[120px] flex-1")} />
      <SelectSlot value={type} onChange={(v) => setType(v as Variable["type"])} label={t("variables.type")}>
        {VARIABLE_TYPES.map((k) => <option key={k} value={k}>{t(`variables.types.${k}` as never)}</option>)}
      </SelectSlot>
      <button type="button" onClick={finish} disabled={!name.trim()} title={t("conditionEditor.createVariable")} aria-label={t("conditionEditor.createVariable")}
        className="studio-button-lit flex h-[26px] items-center gap-1 rounded-md border px-2 text-[11px] font-medium disabled:opacity-40">
        <CheckIcon className="h-3 w-3" />{t("conditionEditor.createVariable")}
      </button>
      <button type="button" onClick={onCancel} aria-label={t("conditionEditor.cancel")} className="rounded p-0.5 text-foreground/40 hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
    </div>
  );
}

/** The variable picker every sentence uses: the list, and "new…" at the end
 *  when the caller can make one. */
function VariablePick({ value, variables, onPick, onNew, label, placeholder }: {
  value: string; variables: Variable[]; onPick: (id: string) => void; onNew?: () => void; label: string; placeholder?: string;
}) {
  const { t } = useTranslation("editor");
  const known = variables.some((v) => v.id === value);
  return (
    <SelectSlot value={known ? value : ""} onChange={(v) => (v === NEW_VARIABLE ? onNew?.() : v && onPick(v))} label={label} width="max-w-[160px]">
      {!known && <option value="" disabled>{placeholder ?? t("behaviors.selectVariable")}</option>}
      {variables.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
      {onNew && <option value={NEW_VARIABLE}>{t("conditionEditor.newVariable")}</option>}
    </SelectSlot>
  );
}

/* ── When ────────────────────────────────────────────────────────────── */

export function WhenSentence({ reaction, variables, onUpdate }: { reaction: Reaction; variables: Variable[]; onUpdate: (u: Partial<Reaction>) => void }) {
  const { t } = useTranslation("editor");
  const tx = t as TFn;
  const presets = useMemo(() => getWhenPresets(tx), [tx]);
  const current = useMemo(() => resolveWhenPreset(presets, reaction.when), [presets, reaction.when]);
  const categories = useMemo(() => [...new Set(presets.map((p) => p.category))], [presets]);

  // A trigger written by the old rule editor keeps its old fields: they have
  // no sentence, so the classic form stands in for this one line.
  if (reaction.when._legacyTrigger) {
    return <div className="studio-classic"><WhenEditor reaction={reaction} variables={variables} onUpdate={onUpdate} /></div>;
  }

  const match = reaction.when.match ?? {};
  const setMatch = (name: string, next: { operator: string; value: string | number } | null) => {
    const nextMatch = { ...match } as Record<string, { operator: string; value: unknown }>;
    if (next) nextMatch[name] = next; else delete nextMatch[name];
    onUpdate({ when: { ...reaction.when, match: Object.keys(nextMatch).length ? (nextMatch as Reaction["when"]["match"]) : undefined } });
  };

  return (
    <Sentence>
      <SelectSlot value={current?.id ?? "_custom"} label={t("behaviors.selectEvent")} width="max-w-[200px]"
        onChange={(id) => { const p = presets.find((x) => x.id === id); if (p) onUpdate({ when: buildWhenForPreset(p) }); }}>
        {!current && <option value="_custom">{t("behaviors.customEvent", { event: reaction.when.eventType })}</option>}
        {categories.map((cat) => (
          <optgroup key={cat} label={cat}>
            {presets.filter((p) => p.category === cat).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </optgroup>
        ))}
      </SelectSlot>
      {current?.fields?.map((field) => {
        const raw = match[field.name]?.value;
        const value = raw === undefined ? "" : String(raw);
        if (field.type === "variable") {
          return <VariablePick key={field.name} value={value} variables={variables} label={field.label}
            onPick={(id) => setMatch(field.name, { operator: "eq", value: id })} />;
        }
        if (field.type === "select") {
          return (
            <SelectSlot key={field.name} value={value} label={field.label} onChange={(v) => setMatch(field.name, { operator: "eq", value: v })}>
              {!value && <option value="" disabled>{field.label}</option>}
              {field.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </SelectSlot>
          );
        }
        if (field.type === "number") {
          return (
            <span key={field.name} className="flex items-center gap-1.5">
              {field.operator === "every" && <Word text={t("blueprint.sentence.every")} />}
              <TextSlot type="number" value={value} label={field.label} placeholder={field.placeholder} width="w-[64px]"
                onCommit={(v) => setMatch(field.name, { operator: field.operator ?? "eq", value: Number(v) || 0 })} />
              {field.operator === "every" && <Word text={t("blueprint.sentence.turns")} />}
            </span>
          );
        }
        // keyword / text: "attack, fight" — the same comma-joined string the
        // full editor's chip input writes.
        return (
          <TextSlot key={field.name} value={value} label={field.label} placeholder={field.placeholder ?? field.label} width="w-[160px] flex-1"
            onCommit={(v) => setMatch(field.name, v.trim() ? { operator: field.operator ?? (field.type === "keyword" || field.type === "text" ? "contains" : "eq"), value: v } : null)} />
        );
      })}
    </Sentence>
  );
}

/* ── Conditions ──────────────────────────────────────────────────────── */

export function ConditionSentences({ conditions: raw, variables, onChange, onCreateVariable, onJumpToVariable, empty }: {
  conditions: Condition[] | undefined;
  variables: Variable[];
  onChange: (next: Condition[]) => void;
  onCreateVariable?: (draft: { name: string; type: Variable["type"] }) => Variable | undefined;
  onJumpToVariable?: (id: string) => void;
  empty: ReactNode;
}) {
  const { t } = useTranslation("editor");
  const conditions = raw ?? [];
  // Which line is being replaced by the new-variable line: an index, or -1
  // for a condition on a variable that does not exist yet.
  const [creating, setCreating] = useState<number | null>(null);

  const create = (draft: { name: string; type: Variable["type"] }) => {
    const made = onCreateVariable?.(draft);
    if (made && creating !== null) {
      const condition = defaultConditionForVariable(made);
      onChange(creating < 0 ? [...conditions, condition] : conditions.map((c, i) => (i === creating ? condition : c)));
    }
    setCreating(null);
  };
  const update = (index: number, patch: Partial<Condition>) =>
    onChange(conditions.map((c, i) => (i === index ? normalizeConditionForVariable({ ...c, ...patch }, variables) : c)));
  const add = () => {
    if (variables.length === 0) { if (onCreateVariable) setCreating(-1); return; }
    onChange([...conditions, defaultConditionForVariable(variables[0]!)]);
  };

  return (
    <div>
      {conditions.length === 0 && creating === null && <EmptyLine text={empty} />}
      {conditions.map((cond, i) => {
        if (creating === i) return <div key={i} className="py-1"><NewVariableLine onCreate={create} onCancel={() => setCreating(null)} /></div>;
        const variable = resolveVariableForCondition(cond.variableId, variables);
        const type = variable?.type ?? "number";
        const operators = operatorsForVariableType(type);
        const refVars = variable && variable.type !== "number" ? variables.filter((v) => v.type === variable.type) : variables.filter((v) => v.type === "number");
        const canRef = type === "number" || type === "string";
        const isRef = cond.valueRef !== undefined;
        return (
          <Sentence key={i} onRemove={() => onChange(conditions.filter((_, j) => j !== i))} removeLabel={t("blueprint.sentence.remove")}>
            <VariablePick value={cond.variableId} variables={variables} label={t("behaviors.whenFields.variable")}
              onPick={(id) => { const next = variables.find((v) => v.id === id); if (next) onChange(conditions.map((c, j) => (j === i ? defaultConditionForVariable(next) : c))); }}
              onNew={onCreateVariable ? () => setCreating(i) : undefined} />
            {onJumpToVariable && variable && (
              <button type="button" onClick={() => onJumpToVariable(variable.id)} title={t("conditionEditor.jumpToVariable")} aria-label={t("conditionEditor.jumpToVariable")}
                data-condition-jump={variable.id} className="-ml-1 rounded p-0.5 text-foreground/35 hover:text-foreground">
                <ArrowUpRight className="h-3 w-3" />
              </button>
            )}
            <SelectSlot value={cond.operator} label={t("blueprint.sentence.operator")} onChange={(v) => update(i, { operator: v as Condition["operator"] })}>
              {operators.map((op) => <option key={op} value={op}>{op === "contains" ? t("conditionEditor.contains") : OP_GLYPH[op]}</option>)}
            </SelectSlot>
            {isRef ? (
              <SelectSlot value={cond.valueRef ?? ""} label={t("behaviors.operandVariable")} onChange={(v) => update(i, { valueRef: v })} width="max-w-[140px]">
                {refVars.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </SelectSlot>
            ) : type === "boolean" ? (
              <SelectSlot value={cond.value === true ? "true" : "false"} label={t("behaviors.doFields.value")} onChange={(v) => update(i, { value: v === "true" })}>
                <option value="true">{t("conditionEditor.trueValue")}</option>
                <option value="false">{t("conditionEditor.falseValue")}</option>
              </SelectSlot>
            ) : type === "number" ? (
              // A number, or what a button passed in ({参数.价格}).
              <TextSlot value={typeof cond.value === "number" ? String(cond.value) : typeof cond.value === "string" ? cond.value : "0"} label={t("behaviors.doFields.value")}
                onCommit={(v) => { if (/^\{(?:参数|param)\.[^}]+\}$/.test(v.trim())) { update(i, { value: v.trim() }); return; } const n = parseFloat(v); update(i, { value: Number.isFinite(n) ? n : 0 }); }} />
            ) : type === "json" && cond.operator !== "contains" ? (
              <TextSlot value={typeof cond.value === "object" ? JSON.stringify(cond.value) : String(cond.value ?? "")} label={t("behaviors.doFields.value")}
                placeholder={t("conditionEditor.jsonPlaceholder")} width="w-[140px] flex-1 font-mono"
                onCommit={(v) => { try { update(i, { value: parseJsonConditionValue(v) }); } catch { update(i, { value: v }); } }} />
            ) : (
              <TextSlot value={typeof cond.value === "string" ? cond.value : String(cond.value ?? "")} label={t("behaviors.doFields.value")}
                placeholder={type === "json" ? t("conditionEditor.containsPlaceholder") : undefined} width="w-[120px] flex-1"
                onCommit={(v) => update(i, { value: v })} />
            )}
            {canRef && (
              <button type="button" aria-pressed={isRef}
                title={isRef ? t("blueprint.sentence.compareConstant") : t("blueprint.sentence.compareVariable")}
                aria-label={isRef ? t("blueprint.sentence.compareConstant") : t("blueprint.sentence.compareVariable")}
                onClick={() => update(i, isRef ? { valueRef: undefined } : { valueRef: refVars[0]?.id ?? "" })}
                className={cn("rounded p-1 transition-colors", isRef ? "text-[#f5d48a] shadow-[0_0_10px_rgba(240,198,116,0.25)]" : "text-foreground/30 hover:text-foreground")}>
                <VariableIcon className="h-3.5 w-3.5" />
              </button>
            )}
          </Sentence>
        );
      })}
      {creating === -1 && <div className="py-1"><NewVariableLine onCreate={create} onCancel={() => setCreating(null)} /></div>}
      <AddLine label={t("blueprint.sentence.addCondition")} onClick={add} disabled={variables.length === 0 && !onCreateVariable} />
    </div>
  );
}

/* ── Effects ─────────────────────────────────────────────────────────── */

function valueModeOf(e: SetEffect): ValueMode {
  if (e.valueRandom) return "random";
  if (e.valueRef) return "var";
  return "const";
}

/** "把 好感 设为 100": the one effect with its own grammar, because its value
 *  can be a number, another variable, or a roll of the dice. */
function ChangeVariableSentence({ effect, variables, onUpdate, onRemove, onCreateVariable }: {
  effect: SetEffect; variables: Variable[]; onUpdate: (e: ReactionEffect) => void; onRemove: () => void;
  onCreateVariable?: (draft: { name: string; type: Variable["type"] }) => Variable | undefined;
}) {
  const { t } = useTranslation("editor");
  const tx = t as TFn;
  const ensureVariableByName = useEditorStore((s) => s.ensureVariableByName);
  const [creating, setCreating] = useState(false);
  const patch = (u: Partial<SetEffect>) => onUpdate({ ...effect, ...u });
  const mode = valueModeOf(effect);
  const targetName = variables.find((v) => v.id === effect.path)?.name ?? "";
  const listRandom = mode === "random" && effect.valueRandom?.kind === "list";

  const setMode = (m: ValueMode) => {
    if (m === "const") {
      const keep = typeof effect.value === "number" || typeof effect.value === "string" ? effect.value : 0;
      patch({ valueRef: undefined, valueRandom: undefined, value: keep });
    } else if (m === "var") patch({ valueRef: variables[0]?.id ?? "", valueRandom: undefined });
    else patch({ valueRandom: { kind: "range", min: 1, max: 6 }, valueRef: undefined, operation: effect.operation ?? "set" });
  };
  const ensureHistory = (base: string) =>
    ensureVariableByName(`${base || tx("behaviors.randomPick.historyBase", { defaultValue: "rotation" })} · ${tx("behaviors.randomPick.historySuffix", { defaultValue: "recent" })}`, "json", [], true);

  const modes: ValueMode[] = ["const", "var", "random"];
  return (
    <Sentence
      onRemove={onRemove}
      removeLabel={t("blueprint.sentence.remove")}
      below={mode === "random" && effect.valueRandom ? (
        <div className="studio-classic">
          <RandomValueEditor spec={effect.valueRandom} variables={variables} targetName={targetName} ensureHistory={ensureHistory}
            onChange={(spec) => patch({ valueRandom: spec, operation: spec.kind === "list" ? "set" : (effect.operation ?? "set") })} />
        </div>
      ) : undefined}
    >
      <Word text={t("blueprint.sentence.setPrefix")} />
      {creating ? (
        <NewVariableLine onCancel={() => setCreating(false)} onCreate={(draft) => { const made = onCreateVariable?.(draft); if (made) patch({ path: made.id }); setCreating(false); }} />
      ) : (
        <VariablePick value={effect.path} variables={variables} label={t("behaviors.doFields.variable")} onPick={(id) => patch({ path: id })}
          onNew={onCreateVariable ? () => setCreating(true) : undefined} />
      )}
      {!listRandom && (
        <SelectSlot value={effect.operation ?? "set"} label={t("behaviors.doFields.operation")} onChange={(v) => patch({ operation: v as SetEffect["operation"] })}>
          {CHANGE_OPS.map((op) => <option key={op} value={op}>{t(`blueprint.sentence.ops.${op}` as never)}</option>)}
        </SelectSlot>
      )}
      {mode === "const" && (
        <TextSlot value={String(effect.value ?? "")} label={t("behaviors.doFields.value")} placeholder="10" width="w-[72px]"
          onCommit={(v) => patch({ value: parseSmartValue(v) })} />
      )}
      {mode === "var" && (
        <SelectSlot value={effect.valueRef ?? ""} label={t("behaviors.operandVariable")} onChange={(v) => patch({ valueRef: v })} width="max-w-[140px]">
          {!effect.valueRef && <option value="" disabled>{t("behaviors.selectVariable")}</option>}
          {variables.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </SelectSlot>
      )}
      {/* What the value is: three words, the chosen one lit. */}
      <span role="radiogroup" aria-label={t("behaviors.doFields.value")} className="ml-auto flex items-center gap-0.5 text-[11px]">
        {modes.map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}
            className={cn("rounded px-1.5 py-0.5 transition-colors", mode === m ? "text-[#f5d48a]" : "text-foreground/35 hover:text-foreground/70")}>
            {t(`behaviors.valueMode.${m}` as never)}
          </button>
        ))}
      </span>
    </Sentence>
  );
}

/** A slot for one parameter of a preset effect. */
function PresetSlot({ field, value, variables, entries, audioTracks, allReactions, onChange }: {
  field: DoField; value: string; variables: Variable[]; entries: WorldEntry[]; audioTracks: AudioTrack[]; allReactions: Reaction[]; onChange: (v: string) => void;
}) {
  const { t } = useTranslation("editor");
  const pickable = (options: Array<{ value: string; label: string }>, placeholder: string) => (
    <SelectSlot value={value} label={field.label} onChange={onChange} width="max-w-[180px]">
      {!options.some((o) => o.value === value) && <option value="" disabled>{placeholder}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </SelectSlot>
  );
  switch (field.type) {
    case "variable": return pickable(variables.map((v) => ({ value: v.id, label: v.name })), t("behaviors.selectVariable"));
    case "entry": return pickable(entries.map((e) => ({ value: e.id, label: e.name })), t("behaviors.selectEntry"));
    case "audio": return pickable(audioTracks.length ? audioTracks.map((a) => ({ value: a.id, label: a.name })) : [{ value: "", label: t("behaviors.noAudioTracks") }], t("behaviors.selectTrack"));
    case "behavior": return pickable(allReactions.map((r) => ({ value: r.id, label: r.name })), t("behaviors.selectBehavior"));
    case "select": return pickable(field.options ?? [], field.label);
    case "textarea":
      return (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder} rows={2} aria-label={field.label}
          className="studio-control w-full resize-y rounded-md border px-2.5 py-1.5 text-xs leading-relaxed text-foreground placeholder:text-foreground/30 focus:studio-control-focus focus:outline-none" />
      );
    case "operand": {
      const isRef = value.startsWith("@ref:");
      return (
        <>
          {isRef ? (
            <SelectSlot value={value.slice(5)} label={field.label} onChange={(id) => onChange(`@ref:${id}`)} width="max-w-[140px]">
              {variables.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </SelectSlot>
          ) : (
            <TextSlot value={value} label={field.label} placeholder={field.placeholder} onCommit={onChange} />
          )}
          <button type="button" aria-pressed={isRef} title={isRef ? t("blueprint.sentence.compareConstant") : t("blueprint.sentence.compareVariable")}
            onClick={() => onChange(isRef ? "" : `@ref:${variables[0]?.id ?? ""}`)}
            className={cn("rounded p-1 transition-colors", isRef ? "text-[#f5d48a]" : "text-foreground/30 hover:text-foreground")}>
            <VariableIcon className="h-3.5 w-3.5" />
          </button>
        </>
      );
    }
    case "number": return <TextSlot type="number" value={value} label={field.label} placeholder={field.placeholder} onCommit={onChange} />;
    default: return <TextSlot value={value} label={field.label} placeholder={field.placeholder ?? field.label} width="w-[160px] flex-1" onCommit={onChange} />;
  }
}

export function EffectSentences({ effects, variables, entries, audioTracks, allReactions, onChange, onCreateVariable }: {
  effects: ReactionEffect[]; variables: Variable[]; entries: WorldEntry[]; audioTracks: AudioTrack[]; allReactions: Reaction[];
  onChange: (next: ReactionEffect[]) => void;
  onCreateVariable?: (draft: { name: string; type: Variable["type"] }) => Variable | undefined;
}) {
  const { t } = useTranslation("editor");
  const tx = t as TFn;
  const presets = useMemo(() => getDoPresets(tx), [tx]);
  const categories = useMemo(() => [...new Set(presets.map((p) => p.category))], [presets]);

  const add = (preset: DoPreset) => {
    const defaults: Record<string, string> = {};
    for (const f of preset.fields) {
      // A variable slot starts empty on purpose (an empty path is a no-op in
      // the engine); the others take the first thing that exists.
      if (f.type === "variable") defaults[f.name] = "";
      else if (f.type === "entry" && entries[0]) defaults[f.name] = entries[0].id;
      else if (f.type === "audio" && audioTracks[0]) defaults[f.name] = audioTracks[0].id;
      else if (f.type === "behavior" && allReactions[0]) defaults[f.name] = allReactions[0].id;
      else if (f.options?.[0]) defaults[f.name] = f.options[0].value;
      else defaults[f.name] = "";
    }
    onChange([...effects, preset.build(defaults)]);
  };
  const replace = (i: number, next: ReactionEffect) => onChange(effects.map((e, j) => (j === i ? next : e)));
  const remove = (i: number) => onChange(effects.filter((_, j) => j !== i));

  return (
    <div>
      {effects.length === 0 && <EmptyLine text={t("behaviors.noActionsYet")} />}
      {effects.map((effect, i) => {
        if (effect.type === "set" && !effect.path.startsWith("@")) {
          return <ChangeVariableSentence key={i} effect={effect} variables={variables} onUpdate={(e) => replace(i, e)} onRemove={() => remove(i)} onCreateVariable={onCreateVariable} />;
        }
        const preset = identifyPreset(effect, presets);
        const fields = extractFieldValues(effect, preset);
        if (!preset) {
          return (
            <Sentence key={i} onRemove={() => remove(i)} removeLabel={t("blueprint.sentence.remove")}>
              <span className={word}>{t("behaviors.customEffect")}</span>
              <code className="truncate text-[11px] text-foreground/60">
                {effect.type === "set" ? `${effect.path} = ${JSON.stringify(effect.value)}` : JSON.stringify(effect.event)}
              </code>
            </Sentence>
          );
        }
        const Icon = preset.icon;
        const inline = preset.fields.filter((f) => f.type !== "textarea");
        const blocks = preset.fields.filter((f) => f.type === "textarea");
        const set = (name: string, v: string) => replace(i, preserveLegacyEffect(effect, preset.build({ ...fields, [name]: v })));
        return (
          <Sentence key={i} icon={<Icon className="h-3.5 w-3.5" />} onRemove={() => remove(i)} removeLabel={t("blueprint.sentence.remove")}
            below={blocks.length ? blocks.map((f) => (
              <PresetSlot key={f.name} field={f} value={fields[f.name] ?? ""} variables={variables} entries={entries} audioTracks={audioTracks} allReactions={allReactions} onChange={(v) => set(f.name, v)} />
            )) : undefined}>
            <span className="shrink-0 text-xs font-medium text-foreground">{preset.label}</span>
            {inline.map((f) => (
              <span key={f.name} className="flex min-w-0 items-center gap-1.5">
                {inline.length > 1 && <span className={word}>{f.label}</span>}
                <PresetSlot field={f} value={fields[f.name] ?? ""} variables={variables} entries={entries} audioTracks={audioTracks} allReactions={allReactions} onChange={(v) => set(f.name, v)} />
              </span>
            ))}
          </Sentence>
        );
      })}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="flex h-7 items-center gap-1 rounded-md px-1 -ml-1 text-xs text-foreground/50 transition-colors hover:bg-white/[0.05] hover:text-foreground data-[state=open]:text-foreground">
            <Plus className="h-3.5 w-3.5" />{t("blueprint.sentence.addEffect")}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="studio-pill max-h-[360px] min-w-[200px] overflow-y-auto rounded-xl p-1.5">
          {categories.map((cat) => (
            <div key={cat}>
              <DropdownMenuLabel className="px-2 pb-0.5 pt-1.5 text-[10px] font-medium text-foreground/40">{cat}</DropdownMenuLabel>
              {presets.filter((p) => p.category === cat).map((p) => (
                <DropdownMenuItem key={p.id} onSelect={() => add(p)} className="gap-2 rounded-md px-2 py-1.5 text-xs text-foreground/85 focus:bg-white/[0.06] focus:text-foreground">
                  <p.icon className="h-3.5 w-3.5 text-foreground/50" />{p.label}
                </DropdownMenuItem>
              ))}
            </div>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
