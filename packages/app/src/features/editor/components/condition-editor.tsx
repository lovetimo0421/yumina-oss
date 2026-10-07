import { Check, ExternalLink, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Condition, Variable } from "@yumina/engine";
import {
  defaultConditionForVariable,
  normalizeConditionForVariable,
  operatorsForVariableType,
  parseJsonConditionValue,
  resolveVariableForCondition,
} from "../lib/entry-conditions";
import { FLUSH_PENDING_EDITS_EVENT } from "./flush-pending-edits";

/**
 * Text field that types into local state and commits after a short pause, on
 * blur or on IME composition end — never per keystroke (each commit rebuilds
 * the whole world). Deliberately store-free, unlike DebouncedInput, so this
 * file stays importable from lightweight component tests; it keeps the same
 * promises, though: typed text goes to the callback that was current when it
 * was typed, a save or an unmount commits it rather than dropping it, and a
 * value changed from outside (another row, undo) is not overwritten by stale
 * text on the next blur.
 */
function DraftTextInput({
  value,
  onCommit,
  onBlur,
  ...rest
}: Omit<ComponentPropsWithoutRef<"input">, "value" | "onChange"> & {
  value: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const composing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ next: string; commit: (next: string) => void } | null>(null);
  const committed = useRef(value);
  const runPending = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const p = pending.current;
    pending.current = null;
    if (!p) return;
    committed.current = p.next;
    p.commit(p.next);
  };
  const schedule = (next: string, delay: number) => {
    pending.current = { next, commit: onCommit };
    if (timer.current) clearTimeout(timer.current);
    if (delay === 0) runPending();
    else timer.current = setTimeout(runPending, delay);
  };
  useEffect(() => {
    // Our own commit echoing back through props changes nothing.
    if (value === committed.current) return;
    // Anything else came from outside: finish what was typed where it was
    // typed, then show the new value.
    runPending();
    committed.current = value;
    setDraft(value);
  }, [value]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => runPending(), []);
  useEffect(() => {
    window.addEventListener(FLUSH_PENDING_EDITS_EVENT, runPending);
    return () => window.removeEventListener(FLUSH_PENDING_EDITS_EVENT, runPending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <input
      {...rest}
      value={draft}
      onChange={(e) => {
        const next = e.target.value;
        setDraft(next);
        if (composing.current) return;
        schedule(next, 300);
      }}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={(e) => { composing.current = false; schedule((e.target as HTMLInputElement).value, 0); }}
      onBlur={(e) => { runPending(); onBlur?.(e); }}
    />
  );
}

/**
 * A number field that keeps what's typed as text and only commits a valid
 * number on blur / Enter. Binding a store number straight to an input made
 * "0." snap to "0", "-" to 0, and a cleared field jump back to a default
 * before the next digit could land. Blank or invalid text on blur either
 * calls `onEmpty` (when given) or reverts to the stored value. A save or an
 * unmount commits what is typed, like the other editor fields.
 */
export function DraftNumberInput({
  value,
  onCommit,
  onEmpty,
  onBlur,
  onKeyDown,
  ...rest
}: Omit<ComponentPropsWithoutRef<"input">, "value" | "onChange" | "type"> & {
  value: number | null | undefined;
  onCommit: (next: number) => void;
  onEmpty?: () => void;
}) {
  const shown = value === null || value === undefined || !Number.isFinite(value) ? "" : String(value);
  const [draft, setDraft] = useState(shown);
  const edited = useRef(false);
  const commit = () => {
    if (!edited.current) return;
    edited.current = false;
    const trimmed = draft.trim();
    if (trimmed === "") {
      if (onEmpty) onEmpty();
      else setDraft(shown);
      return;
    }
    const num = Number(trimmed);
    if (!Number.isFinite(num)) { setDraft(shown); return; }
    setDraft(String(num));
    if (num !== value) onCommit(num);
  };
  // The commit of the render the typing happened in: its onCommit is the one
  // bound to the row being edited.
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const previousCommit = useRef(commit);
  // Follow external changes (undo, another row): what was typed goes to the
  // row it was typed into first, then the field shows the new value.
  useEffect(() => {
    previousCommit.current();
    edited.current = false;
    setDraft(shown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);
  // Updated after the effect above has run, so that effect still sees the
  // previous render's commit — the one bound to the row being left.
  useEffect(() => { previousCommit.current = commit; });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => commitRef.current(), []);
  useEffect(() => {
    const onFlush = () => commitRef.current();
    window.addEventListener(FLUSH_PENDING_EDITS_EVENT, onFlush);
    return () => window.removeEventListener(FLUSH_PENDING_EDITS_EVENT, onFlush);
  }, []);
  return (
    <input
      {...rest}
      type="text"
      inputMode={rest.inputMode ?? "decimal"}
      value={draft}
      onChange={(e) => { edited.current = true; setDraft(e.target.value); }}
      onBlur={(e) => { commit(); onBlur?.(e); }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) (e.target as HTMLInputElement).blur();
        onKeyDown?.(e);
      }}
    />
  );
}

const OP_LABELS: Record<Condition["operator"], string> = {
  eq: "=",
  neq: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  contains: "∋",
};

interface ConditionEditorProps {
  conditions: Condition[];
  variables: Variable[];
  onChange: (conditions: Condition[]) => void;
  label?: string;
  /** Explain what an empty list means for this particular rule. */
  emptyHint?: ReactNode;
  /** Make a variable right here and use it — the picker used to offer only
   *  what already existed, and a card with no variables could not add a
   *  condition at all. Returns the created (or reused) variable. */
  onCreateVariable?: (draft: { name: string; type: Variable["type"] }) => Variable | undefined;
  /** Go to the variable a condition reads, wherever it is edited. */
  onJumpToVariable?: (variableId: string) => void;
}

const NEW_VARIABLE = "__new__";
const VARIABLE_TYPES: Variable["type"][] = ["number", "string", "boolean", "json"];

export function ConditionEditor({
  conditions: rawConditions,
  variables: rawVariables,
  onChange,
  label,
  emptyHint,
  onCreateVariable,
  onJumpToVariable,
}: ConditionEditorProps) {
  const conditions = rawConditions ?? [];
  const variables = rawVariables ?? [];
  const { t } = useTranslation("editor");
  // Which row is being replaced by the "new variable" form: an index, or -1
  // for "add a condition on a variable that does not exist yet".
  const [creating, setCreating] = useState<number | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftType, setDraftType] = useState<Variable["type"]>("number");
  const beginCreate = (index: number) => { setDraftName(""); setDraftType("number"); setCreating(index); };
  const finishCreate = () => {
    const name = draftName.trim();
    if (!name || !onCreateVariable || creating === null) return;
    const made = onCreateVariable({ name, type: draftType });
    if (made) {
      const condition = defaultConditionForVariable(made);
      onChange(creating < 0 ? [...conditions, condition] : conditions.map((c, idx) => (idx === creating ? condition : c)));
    }
    setCreating(null);
  };
  // A card with fifty variables turned the picker into a fifty-line list to
  // scroll by eye. Past a dozen, a filter box sits beside each picker; the
  // option already chosen always stays listed so the select never goes blank.
  const [variableFilter, setVariableFilter] = useState("");
  const filterable = variables.length > 12;
  const pickable = (currentId: string) => {
    const q = variableFilter.trim().toLowerCase();
    if (!filterable || !q) return variables;
    return variables.filter((v) => v.id === currentId || v.name.toLowerCase().includes(q));
  };

  function addCondition() {
    if (variables.length === 0) {
      if (onCreateVariable) beginCreate(-1);
      return;
    }
    onChange([...conditions, defaultConditionForVariable(variables[0]!)]);
  }

  function updateCondition(index: number, updates: Partial<Condition>) {
    const next = conditions.map((c, i) => {
      if (i !== index) return c;
      const merged = { ...c, ...updates };
      return normalizeConditionForVariable(merged, variables);
    });
    onChange(next);
  }

  function removeCondition(index: number) {
    onChange(conditions.filter((_, i) => i !== index));
  }

  function compatibleValueRefVariables(lhs: Condition): Variable[] {
    const source = resolveVariableForCondition(lhs.variableId, variables);
    if (!source) return variables;
    if (source.type === "number") {
      return variables.filter((v) => v.type === "number");
    }
    return variables.filter((v) => v.type === source.type);
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <label className="text-sm font-medium text-foreground">
          {label ?? t("conditionEditor.conditions")}
        </label>
        <button
          type="button"
          onClick={addCondition}
          disabled={variables.length === 0 && !onCreateVariable}
          className="text-xs text-primary hover:underline disabled:opacity-40"
        >
          {t("conditionEditor.addCondition")}
        </button>
      </div>
      {filterable && conditions.length > 0 && (
        <input
          type="text"
          value={variableFilter}
          onChange={(e) => setVariableFilter(e.target.value)}
          placeholder={t("modules.filterVariables")}
          aria-label={t("modules.filterVariables")}
          className="mb-2 w-full rounded border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary/50 focus:outline-none"
        />
      )}
      {creating !== null && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 p-2" data-condition-new-variable>
          <input
            autoFocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); finishCreate(); } if (e.key === "Escape") setCreating(null); }}
            placeholder={t("conditionEditor.newVariableName")}
            className="min-w-[8rem] flex-1 rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
          />
          <select value={draftType} onChange={(e) => setDraftType(e.target.value as Variable["type"])}
            className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground">
            {VARIABLE_TYPES.map((type) => <option key={type} value={type}>{t(`variables.types.${type}` as never)}</option>)}
          </select>
          <button type="button" onClick={finishCreate} disabled={!draftName.trim()}
            className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-40">
            <Check className="h-3 w-3" />{t("conditionEditor.createVariable")}
          </button>
          <button type="button" onClick={() => setCreating(null)} className="text-muted-foreground/60 hover:text-foreground" aria-label={t("conditionEditor.cancel")}>
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      {conditions.length === 0 ? (
        <p className="text-xs text-muted-foreground/40">
          {emptyHint ?? t("conditionEditor.noConditions")}
        </p>
      ) : (
        <div className="space-y-2">
          {conditions.map((cond, i) => {
            const variable = resolveVariableForCondition(cond.variableId, variables);
            const varType = variable?.type ?? "number";
            const operators = operatorsForVariableType(varType);
            const valueRefVars = compatibleValueRefVariables(cond);

            return (
              <div
                key={i}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-accent/50 p-2"
              >
                <select
                  value={cond.variableId}
                  onChange={(e) => {
                    if (e.target.value === NEW_VARIABLE) { beginCreate(i); return; }
                    const nextVar = variables.find((v) => v.id === e.target.value);
                    if (!nextVar) return;
                    onChange(
                      conditions.map((c, idx) =>
                        idx === i ? defaultConditionForVariable(nextVar) : c,
                      ),
                    );
                  }}
                  className="min-w-[7rem] rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
                >
                  {pickable(cond.variableId).map((v) => (
                    <option key={v.id} value={v.id}>
                      {`${v.name} (${t(`variables.types.${v.type}` as never)})`}
                    </option>
                  ))}
                  {onCreateVariable && <option value={NEW_VARIABLE}>{t("conditionEditor.newVariable")}</option>}
                </select>
                {onJumpToVariable && variable && (
                  <button type="button" onClick={() => onJumpToVariable(variable.id)} title={t("conditionEditor.jumpToVariable")} aria-label={t("conditionEditor.jumpToVariable")}
                    data-condition-jump={variable.id}
                    className="text-muted-foreground/50 hover:text-primary">
                    <ExternalLink className="h-3 w-3" />
                  </button>
                )}

                <select
                  value={cond.operator}
                  onChange={(e) =>
                    updateCondition(i, {
                      operator: e.target.value as Condition["operator"],
                    })
                  }
                  className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
                >
                  {operators.map((op) => (
                    <option key={op} value={op}>
                      {op === "contains"
                        ? t("conditionEditor.contains")
                        : OP_LABELS[op]}
                    </option>
                  ))}
                </select>

                {(varType === "number" || varType === "string") && (
                  <select
                    value={cond.valueRef !== undefined ? "var" : "const"}
                    onChange={(e) =>
                      updateCondition(
                        i,
                        e.target.value === "var"
                          ? { valueRef: valueRefVars[0]?.id ?? "" }
                          : { valueRef: undefined },
                      )
                    }
                    className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
                  >
                    <option value="const">{t("behaviors.operandConstant")}</option>
                    <option value="var">{t("behaviors.operandVariable")}</option>
                  </select>
                )}

                {cond.valueRef !== undefined ? (
                  <select
                    value={cond.valueRef}
                    onChange={(e) => updateCondition(i, { valueRef: e.target.value })}
                    className="min-w-[6rem] rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
                  >
                    {valueRefVars.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                ) : varType === "boolean" ? (
                  <select
                    value={cond.value === true ? "true" : "false"}
                    onChange={(e) =>
                      updateCondition(i, { value: e.target.value === "true" })
                    }
                    className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
                  >
                    <option value="true">{t("conditionEditor.trueValue")}</option>
                    <option value="false">{t("conditionEditor.falseValue")}</option>
                  </select>
                ) : varType === "json" && cond.operator !== "contains" ? (
                  <DraftTextInput
                    type="text"
                    value={
                      typeof cond.value === "object"
                        ? JSON.stringify(cond.value)
                        : String(cond.value ?? "")
                    }
                    onCommit={(raw) => {
                      try {
                        updateCondition(i, {
                          value: parseJsonConditionValue(raw),
                        });
                      } catch {
                        updateCondition(i, { value: raw });
                      }
                    }}
                    placeholder={t("conditionEditor.jsonPlaceholder")}
                    className="min-w-[8rem] flex-1 rounded border border-border bg-background px-2 py-1 font-mono text-xs text-foreground"
                  />
                ) : varType === "number" ? (
                  <DraftNumberInput
                    value={typeof cond.value === "number" ? cond.value : 0}
                    onCommit={(num) => updateCondition(i, { value: num })}
                    className="w-20 rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
                  />
                ) : (
                  <DraftTextInput
                    type="text"
                    value={typeof cond.value === "string" ? cond.value : String(cond.value ?? "")}
                    onCommit={(value) => updateCondition(i, { value })}
                    placeholder={
                      varType === "json"
                        ? t("conditionEditor.containsPlaceholder")
                        : undefined
                    }
                    className="min-w-[6rem] flex-1 rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
                  />
                )}

                <button
                  type="button"
                  onClick={() => removeCondition(i)}
                  className="ml-auto text-muted-foreground/40 hover:text-destructive"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
