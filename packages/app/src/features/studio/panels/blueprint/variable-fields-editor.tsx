import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import type { VariableField } from "@yumina/engine";

const control = "rounded-md border border-white/10 bg-background px-2 py-1 text-[11.5px] outline-none focus:border-sky-400/60";

/**
 * The named parts of a json variable, as a small table the creator fills in.
 *
 * Nothing here changes play. It changes what can be SEEN: the canvas draws a
 * json variable as one lump, and a card that keeps its whole world in one
 * (`still_state`, `unperson-room`) showed one thick wire and no detail. With
 * fields declared, the inspector, the card's page and the creation assistant
 * can all say what is in there and who moves it.
 */
export function VariableFieldsEditor({ fields, onChange, readOnly }: {
  fields: VariableField[];
  onChange: (fields: VariableField[]) => void;
  readOnly?: boolean;
}) {
  const { t } = useTranslation("editor");
  const set = (i: number, patch: Partial<VariableField>) => onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const remove = (i: number) => onChange(fields.filter((_, j) => j !== i));
  const writers = ["", "ui", "ai", "behavior", "ai-call"] as const;
  return (
    <div className="space-y-1.5" data-var-fields="">
      {fields.map((f, i) => (
        <div key={i} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-1.5" data-var-field={f.path}>
          <input
            value={f.path}
            readOnly={readOnly}
            placeholder={t("blueprint.insp.varFieldPath")}
            onChange={(e) => set(i, { path: e.target.value })}
            className={`${control} min-w-0 font-mono`}
          />
          <select value={f.type ?? ""} disabled={readOnly} onChange={(e) => set(i, { type: (e.target.value || undefined) as VariableField["type"] })} className={control} aria-label={t("blueprint.insp.varFieldType")}>
            <option value="">—</option>
            {(["number", "string", "boolean", "json"] as const).map((ty) => (
              <option key={ty} value={ty}>{t(`blueprint.row.varType.${ty}` as never) as string}</option>
            ))}
          </select>
          <select value={f.writer ?? ""} disabled={readOnly} onChange={(e) => set(i, { writer: (e.target.value || undefined) as VariableField["writer"] })} className={control} aria-label={t("blueprint.insp.varFieldWriter")}>
            {writers.map((w) => (
              <option key={w} value={w}>{w ? t(`blueprint.insp.varFieldWriter_${w}` as never) as string : t("blueprint.insp.varFieldWriterAny")}</option>
            ))}
          </select>
          {readOnly ? <span /> : (
            <button type="button" title={t("blueprint.insp.varFieldRemove")} onClick={() => remove(i)} className="rounded p-1 text-foreground/40 hover:bg-white/[0.08] hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      ))}
      {!readOnly && (
        <button
          type="button"
          data-var-field-add=""
          onClick={() => onChange([...fields, { path: "" }])}
          className="inline-flex items-center gap-1 rounded-md border border-dashed border-white/15 px-2 py-1 text-[11px] text-foreground/70 hover:border-white/30 hover:text-foreground"
        >
          <Plus className="h-3 w-3" />
          {t("blueprint.insp.varFieldAdd")}
        </button>
      )}
    </div>
  );
}
