import { useTranslation } from "react-i18next";
import type { Variable } from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";
import { templateFromDisplay, templateToDisplay } from "./template-names";

/** Macros the engine fills in itself, so they are never "missing". */
const BUILT_IN = new Set(["user", "char"]);

/**
 * A part's words, with the card's variables one pick away.
 *
 * The document keeps `{{id}}`; the box shows the variable's name. Before this,
 * showing 当前位置 in a text part meant knowing the `{{…}}` macro existed, and a
 * name typed wrong looked fine here and printed nothing in play. Now the
 * picker drops the macro in, and a name the card has no variable for is said
 * out loud, with the one click that makes it.
 */
export function VariableTextField({
  value, onChange, variables, label, starter,
}: {
  /** The stored template, `{{id}}` form. */
  value: string;
  onChange: (template: string) => void;
  variables: Variable[];
  label: string;
  /** The words a new part arrives with ("新文字"): a variable picked while
   *  they are still there replaces them instead of trailing after them. */
  starter?: string;
}) {
  const { t } = useTranslation("editor");
  const ensureVariableByName = useEditorStore((s) => s.ensureVariableByName);
  const display = templateToDisplay(value, variables);
  const known = new Set(variables.flatMap((v) => [v.name.trim(), v.id]));
  const missing = [...new Set([...display.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((m) => m[1]!.trim()))]
    .filter((name) => name && !known.has(name) && !BUILT_IN.has(name.toLowerCase()));

  return (
    <label className="block border-b border-border/50 px-3 py-2.5">
      <span className="mb-1.5 block text-[11px] font-medium text-muted-foreground">{label}</span>
      <input
        value={display}
        onChange={(e) => onChange(templateFromDisplay(e.target.value, variables))}
        className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary"
      />
      {variables.length > 0 && (
        <select
          value=""
          data-testid="insert-variable"
          onChange={(e) => {
            if (!e.target.value) return;
            const macro = `{{${e.target.value}}}`;
            onChange(starter && value.trim() === starter ? macro : `${value}${macro}`);
          }}
          aria-label={t("studio.element.insertVariable")}
          className="mt-1.5 w-full rounded-md border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground outline-none focus:border-primary"
        >
          <option value="">{t("studio.element.insertVariable")}</option>
          {variables.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      )}
      {missing.map((name) => (
        <span key={name} className="mt-1.5 flex items-center gap-2 text-[11px] text-amber-400/90">
          <span className="min-w-0 flex-1">{t("studio.element.unknownVariable", { name })}</span>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              const id = ensureVariableByName(name, "string", "");
              onChange(templateFromDisplay(display, [...variables, { id, name }]));
            }}
            className="shrink-0 rounded border border-amber-400/40 px-1.5 py-0.5 font-medium hover:bg-amber-400/10"
          >
            {t("studio.element.createVariable")}
          </button>
        </span>
      ))}
    </label>
  );
}
