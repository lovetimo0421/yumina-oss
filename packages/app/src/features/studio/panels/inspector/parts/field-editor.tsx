import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { UiElement, UiFieldKind, Variable } from "@yumina/engine";
import { nameFromQuestion } from "@yumina/engine";
import { NamedText, Section, Toggle, VariableSelect, fieldCls, smallCls, useMakeVariable, useSyncAutoName } from "./part-kit";

type Field = Extract<UiElement, { type: "field" }>;

const KINDS: UiFieldKind[] = ["text", "textarea", "chips", "number", "slider"];
const numeric = (kind: UiFieldKind) => kind === "number" || kind === "slider";

/** A number box that lets the creator clear it (no bound) rather than turning
 *  an empty field into 0. */
function NumberBox({ label, value, onChange }: { label: string; value: number | undefined; onChange: (next: number | undefined) => void }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <input
        type="number"
        value={value ?? ""}
        onChange={(e) => {
          const raw = e.target.value.trim();
          const n = Number(raw);
          onChange(raw === "" || !Number.isFinite(n) ? undefined : n);
        }}
        className={smallCls}
      />
    </label>
  );
}

/**
 * 填写项: one question on a form. The kind decides the control; the variable
 * is where the answer goes, written as the player types, so any text on the
 * page can echo it and a 开始 button can wait for it.
 */
export function FieldEditor({
  el, onPatch, variables,
}: {
  el: Field;
  onPatch: (fn: (el: Field) => Field) => void;
  variables: Variable[];
}) {
  const { t } = useTranslation("editor");
  const make = useMakeVariable();
  const syncName = useSyncAutoName();
  const rule = (name: string) => t("studio.parts.field.aiRule", { name });
  // The question, as a variable name: 「今晚的暗号是？」 → 「今晚的暗号」.
  const suggested = nameFromQuestion(el.label?.template ?? "") || t("studio.parts.field.newVariableName");
  // The chip list is edited as lines; kept as typed while focused so an empty
  // line being started is not dropped under the cursor.
  const [optionsDraft, setOptionsDraft] = useState<string | null>(null);
  const kindLabel = (k: UiFieldKind) => t(`studio.parts.field.kind_${k}` as never);
  const set = <K extends keyof Field>(key: K, value: Field[K] | undefined) =>
    onPatch((f) => {
      const next = { ...f, [key]: value } as Field;
      if (value === undefined || value === "") delete (next as unknown as Record<string, unknown>)[key as string];
      return next;
    });

  return (
    <div data-testid="field-editor">
      <Section label={t("studio.parts.field.kind")}>
        <select
          value={el.kind}
          aria-label={t("studio.parts.field.kind")}
          onChange={(e) => {
            const kind = e.target.value as UiFieldKind;
            // A number question writes a number variable, a text one a string
            // variable — switching across brings one of the right kind.
            const wants = numeric(kind) ? "number" : "string";
            const current = variables.find((v) => v.id === el.variableId);
            const variableId = current && current.type !== wants
              ? make(suggested, wants, wants === "number" ? 0 : "", { rule }).id
              : el.variableId;
            onPatch((f) => ({
              ...f,
              kind,
              variableId,
              ...(kind === "slider" && f.min === undefined && f.max === undefined ? { min: 0, max: 100, step: 1 } : {}),
              ...(kind === "chips" && !(f.options?.length) ? { options: t("studio.parts.field.newOptions").split("\n") } : {}),
            }));
          }}
          className={fieldCls}
        >
          {KINDS.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
        </select>
      </Section>

      <Section label={t("studio.parts.field.label")}>
        <NamedText
          label={t("studio.parts.field.label")}
          value={el.label?.template ?? ""}
          variables={variables}
          onChange={(template) => {
            const before = el.label?.template ?? "";
            set("label", template ? { template } : undefined);
            // The answer's variable follows the question while it is still
            // the one the editor made and named.
            syncName(el.variableId, before, template, t("studio.parts.field.newVariableName"), rule);
          }}
        />
      </Section>

      {el.kind !== "slider" && (
        <Section label={t(el.kind === "chips" ? "studio.parts.field.customPlaceholder" : "studio.parts.field.placeholder")}>
          <input
            value={el.placeholder ?? ""}
            aria-label={t("studio.parts.field.placeholder")}
            onChange={(e) => set("placeholder", e.target.value)}
            className={fieldCls}
          />
        </Section>
      )}

      <Section label={t("studio.parts.field.variable")} hint={t("studio.parts.field.variableHint")}>
        <VariableSelect
          label={t("studio.parts.field.variable")}
          value={el.variableId}
          variables={variables}
          types={numeric(el.kind) ? ["number"] : ["string"]}
          newName={t("studio.parts.field.newVariableName")}
          suggestName={suggested}
          rule={rule}
          newType={numeric(el.kind) ? "number" : "string"}
          newDefault={numeric(el.kind) ? 0 : ""}
          onChange={(variableId) => onPatch((f) => ({ ...f, variableId }))}
        />
      </Section>

      {el.kind === "chips" && (
        <Section label={t("studio.parts.field.options")}>
          <textarea
            rows={4}
            aria-label={t("studio.parts.field.options")}
            value={optionsDraft ?? (el.options ?? []).join("\n")}
            onFocus={() => setOptionsDraft((el.options ?? []).join("\n"))}
            onBlur={() => setOptionsDraft(null)}
            onChange={(e) => {
              setOptionsDraft(e.target.value);
              const options = e.target.value.split("\n").map((o) => o.trim()).filter(Boolean);
              set("options", options.length ? options : undefined);
            }}
            className={`${fieldCls} resize-y`}
          />
          <div className="mt-2">
            <Toggle
              label={t("studio.parts.field.allowCustom")}
              checked={!!el.allowCustom}
              onChange={(on) => set("allowCustom", on ? true : undefined)}
            />
          </div>
        </Section>
      )}

      {numeric(el.kind) && (
        <Section label={t("studio.parts.field.range")}>
          <div className="grid grid-cols-3 gap-1.5">
            <NumberBox label={t("studio.parts.field.min")} value={el.min} onChange={(v) => set("min", v)} />
            <NumberBox label={t("studio.parts.field.max")} value={el.max} onChange={(v) => set("max", v)} />
            <NumberBox label={t("studio.parts.field.step")} value={el.step} onChange={(v) => set("step", v !== undefined && v > 0 ? v : undefined)} />
          </div>
        </Section>
      )}
    </div>
  );
}
