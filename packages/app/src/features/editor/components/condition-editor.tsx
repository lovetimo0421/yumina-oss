import { Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Condition, Variable } from "@yumina/engine";
import {
  defaultConditionForVariable,
  normalizeConditionForVariable,
  operatorsForVariableType,
  parseJsonConditionValue,
  resolveVariableForCondition,
} from "../lib/entry-conditions";

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
}

export function ConditionEditor({
  conditions: rawConditions,
  variables: rawVariables,
  onChange,
  label,
}: ConditionEditorProps) {
  const conditions = rawConditions ?? [];
  const variables = rawVariables ?? [];
  const { t } = useTranslation("editor");

  function addCondition() {
    if (variables.length === 0) return;
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
          disabled={variables.length === 0}
          className="text-xs text-primary hover:underline disabled:opacity-40"
        >
          {t("conditionEditor.addCondition")}
        </button>
      </div>
      {conditions.length === 0 ? (
        <p className="text-xs text-muted-foreground/40">
          {t("conditionEditor.noConditions")}
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
                  {variables.map((v) => (
                    <option key={v.id} value={v.id}>
                      {`${v.name} (${v.type})`}
                    </option>
                  ))}
                </select>

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
                  <input
                    type="text"
                    value={
                      typeof cond.value === "object"
                        ? JSON.stringify(cond.value)
                        : String(cond.value ?? "")
                    }
                    onChange={(e) => {
                      try {
                        updateCondition(i, {
                          value: parseJsonConditionValue(e.target.value),
                        });
                      } catch {
                        updateCondition(i, { value: e.target.value });
                      }
                    }}
                    placeholder={t("conditionEditor.jsonPlaceholder")}
                    className="min-w-[8rem] flex-1 rounded border border-border bg-background px-2 py-1 font-mono text-xs text-foreground"
                  />
                ) : varType === "number" ? (
                  <input
                    type="number"
                    value={typeof cond.value === "number" ? cond.value : 0}
                    onChange={(e) => {
                      const num = parseFloat(e.target.value);
                      updateCondition(i, {
                        value: Number.isFinite(num) ? num : 0,
                      });
                    }}
                    className="w-20 rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
                  />
                ) : (
                  <input
                    type="text"
                    value={typeof cond.value === "string" ? cond.value : String(cond.value ?? "")}
                    onChange={(e) => updateCondition(i, { value: e.target.value })}
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
