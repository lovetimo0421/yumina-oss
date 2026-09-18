import { useTranslation } from "react-i18next";
import type { Variable } from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";
import { cn } from "@/lib/utils";
import { jsonDefaultText, jsonDefaultUpdate, parseJsonDefault } from "../lib/json-default";

export function JsonDefaultValueEditor({ variable, onChange, expanded, onExpandedChange }: {
  variable: Variable;
  onChange: (update: Partial<Variable>) => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const { t } = useTranslation("editor");
  const canUndo = useEditorStore((s) => s.canUndo);
  const canRedo = useEditorStore((s) => s.canRedo);
  const text = jsonDefaultText(variable);
  let invalid = false;
  try { parseJsonDefault(text); } catch { invalid = true; }
  const controlClass = "rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-40";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" disabled={!canUndo} className={controlClass} onClick={() => useEditorStore.getState().undo()}>{t("variables.jsonUndo")}</button>
        <button type="button" disabled={!canRedo} className={controlClass} onClick={() => useEditorStore.getState().redo()}>{t("variables.jsonRedo")}</button>
        <button type="button" aria-expanded={expanded} className={controlClass} onClick={() => onExpandedChange(!expanded)}>{t(expanded ? "variables.jsonCollapse" : "variables.jsonExpand")}</button>
      </div>
      <textarea
        aria-label={t("variables.defaultValue")}
        aria-invalid={invalid}
        aria-describedby="json-default-status"
        value={text}
        onChange={(event) => onChange(jsonDefaultUpdate(event.target.value))}
        rows={expanded ? 22 : 9}
        spellCheck={false}
        className={cn("w-full resize-y rounded-xl border border-border bg-card px-4 py-3 font-mono text-sm leading-relaxed text-foreground shadow-inner transition-colors focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50", expanded ? "h-[530px] min-h-[320px]" : "h-[220px] min-h-[180px]")}
      />
      <p id="json-default-status" aria-live="polite" className={cn("text-xs", invalid ? "text-destructive" : "text-muted-foreground")}>
        {t(invalid ? "variables.jsonInvalidDraft" : "variables.jsonPreserved")}
      </p>
    </div>
  );
}
