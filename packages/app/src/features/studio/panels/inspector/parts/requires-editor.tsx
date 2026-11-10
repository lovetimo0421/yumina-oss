import { useTranslation } from "react-i18next";
import type { Variable } from "@yumina/engine";
import { Section } from "./part-kit";

/**
 * 「这些填好了才能按」: the variables a button waits for. A form's 开始 stays
 * dim until the name is in; a 确认 waits for a pick. Checkboxes over the
 * card's variables, because the question is "which of these", not "type one".
 */
export function RequiresEditor({
  value, variables, onChange,
}: {
  value: string[];
  variables: Variable[];
  onChange: (next: string[]) => void;
}) {
  const { t } = useTranslation("editor");
  const offered = variables.filter((v) => !v.internal);
  // A required variable the card has since deleted is still shown, so it can
  // be unticked rather than silently keeping the button dim forever.
  const missing = value.filter((id) => !offered.some((v) => v.id === id));
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <Section label={t("studio.parts.requires.label")} hint={t("studio.parts.requires.hint")} testId="button-requires">
      {offered.length === 0 && missing.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{t("studio.parts.requires.noVariables")}</p>
      ) : (
        <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
          {[...offered.map((v) => ({ id: v.id, name: v.name })), ...missing.map((id) => ({ id, name: t("studio.parts.requires.gone") }))].map((v) => (
            <label key={v.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-accent/50">
              <input type="checkbox" checked={value.includes(v.id)} onChange={() => toggle(v.id)} className="h-3 w-3 accent-primary" />
              <span className="min-w-0 truncate">{v.name}</span>
            </label>
          ))}
        </div>
      )}
    </Section>
  );
}
