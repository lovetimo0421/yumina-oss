import { useRef } from "react";
import { useTranslation } from "react-i18next";
import type { Variable, VariableActivation, WorldEntry } from "@yumina/engine";
import { cn } from "@/lib/utils";
import { ConditionEditor } from "./condition-editor";

type Mode = VariableActivation["mode"];
type ActivationDrafts = Partial<Record<Mode, VariableActivation>>;

/** The same exposure controls in the small inspector and full variable editor. */
export function VariableActivationEditor({
  variable,
  variables,
  greetings,
  onChange,
}: {
  variable: Variable;
  variables: Variable[];
  greetings: WorldEntry[];
  onChange: (updates: Pick<Partial<Variable>, "activation" | "enabled">) => void;
}) {
  const { t } = useTranslation("editor");
  const activation: VariableActivation = variable.activation ?? { mode: "always" };
  // A mode detour should not discard a condition the creator was working on.
  // This is editor-local memory, keyed by object, never extra saved card data.
  const remembered = useRef<{ id: string; drafts: ActivationDrafts }>({ id: variable.id, drafts: {} });
  if (remembered.current.id !== variable.id) remembered.current = { id: variable.id, drafts: {} };
  remembered.current.drafts[activation.mode] = activation;
  const setMode = (mode: Mode) => {
    const cached = remembered.current.drafts[mode];
    const next: VariableActivation | undefined = mode === "always" ? undefined
      : cached ?? (mode === "conditions" ? { mode, conditions: [], conditionLogic: "all" }
        : mode === "greeting" ? { mode, greetingIds: [] } : { mode: "manual" });
    onChange({ activation: next });
  };
  const missingGreetings = activation.mode === "greeting"
    ? activation.greetingIds.filter((id) => !greetings.some((greeting) => greeting.id === id))
    : [];

  return (
    <div className="space-y-3" data-variable-activation={variable.id}>
      <div className="flex flex-wrap gap-1" role="group" aria-label={t("variables.activationLabel")}>
        {(["always", "conditions", "greeting", "manual"] as const).map((mode) => (
          <button key={mode} type="button" onClick={() => setMode(mode)} aria-pressed={activation.mode === mode}
            className={cn("rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors", activation.mode === mode
              ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent hover:text-foreground")}>
            {t(`variables.activationModes.${mode}`)}
          </button>
        ))}
      </div>

      {activation.mode === "conditions" && (
        <div className="space-y-3 rounded-lg border border-sky-500/20 bg-sky-500/5 p-2.5 [&_select]:max-w-full">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" role="group" aria-label={t("blueprint.insp.logicLabel")}>
            <span>{t("blueprint.insp.logicLabel")}</span>
            {(["all", "any"] as const).map((logic) => (
              <button key={logic} type="button" aria-pressed={activation.conditionLogic === logic}
                onClick={() => onChange({ activation: { ...activation, conditionLogic: logic } })}
                className={cn("rounded px-2 py-1 font-medium", activation.conditionLogic === logic ? "bg-primary/15 text-primary" : "bg-card hover:text-foreground")}>
                {t(`blueprint.logic.${logic}`)}
              </button>
            ))}
          </div>
          <ConditionEditor conditions={activation.conditions} variables={variables}
            emptyHint={<span className="text-xs leading-relaxed text-amber-400" role="status">{t("variables.editing.emptyConditions", { defaultValue: "No condition has been added yet. This currently adds no restriction; add a condition below." })}</span>}
            onChange={(conditions) => onChange({ activation: { ...activation, conditions } })} />
          <p className="text-[11px] leading-relaxed text-muted-foreground">{t("variables.conditionsHint")}</p>
        </div>
      )}

      {activation.mode === "greeting" && (
        <div className="space-y-2 rounded-lg border border-violet-500/20 bg-violet-500/5 p-2.5">
          <p className="text-[11px] leading-relaxed text-muted-foreground">{t("variables.greetingHint")}</p>
          {greetings.length === 0 ? <p className="text-xs text-amber-400">{t("blueprint.insp.noOpenings")}</p> : (
            <div className="space-y-1">
              {greetings.map((greeting, index) => (
                <label key={greeting.id} className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 text-xs hover:bg-white/5">
                  <input type="checkbox" checked={activation.greetingIds.includes(greeting.id)}
                    onChange={() => onChange({ activation: { ...activation, greetingIds: activation.greetingIds.includes(greeting.id)
                      ? activation.greetingIds.filter((id) => id !== greeting.id) : [...activation.greetingIds, greeting.id] } })}
                    className="mt-0.5 shrink-0 accent-violet-400" />
                  <span className="min-w-0 break-words text-foreground"><span className="mr-1.5 text-violet-300">#{index + 1}</span>{greeting.name || greeting.content.slice(0, 80) || "—"}</span>
                </label>
              ))}
            </div>
          )}
          {activation.greetingIds.length === 0 && <p className="text-xs leading-relaxed text-amber-400" role="status">{t("variables.editing.emptyGreetings", { defaultValue: "No opening is selected. This variable will stay inactive until you choose one." })}</p>}
          {missingGreetings.map((id) => <label key={id} className="flex items-start gap-2 text-xs text-amber-400">
            <input type="checkbox" checked onChange={() => onChange({ activation: { ...activation, greetingIds: activation.greetingIds.filter((other) => other !== id) } })} className="mt-0.5 shrink-0 accent-amber-400" />
            <span className="min-w-0 break-all">{t("variables.editing.missingGreeting", { id, defaultValue: "Missing opening: {{id}}" })}</span>
          </label>)}
        </div>
      )}

      {activation.mode === "always" && <p className="text-[11px] leading-relaxed text-muted-foreground">{t("variables.alwaysHint")}</p>}
      {(activation.mode === "manual" || variable.enabled === false) && (
        <div className="space-y-2 rounded-lg border border-border p-2.5">
          <label className="flex items-center justify-between gap-3 text-xs">
            <span className="text-muted-foreground">{t("variables.enabledDefaultLabel")}</span>
            <input type="checkbox" checked={variable.enabled !== false} onChange={(event) => onChange({ enabled: event.target.checked ? undefined : false })} className="accent-primary" />
          </label>
          <p className="text-[11px] leading-relaxed text-muted-foreground">{activation.mode === "manual"
            ? t("variables.manualHint", { path: `@vars.enabled.${variable.id}` })
            : t("variables.editing.disabledHint", { defaultValue: "The initial switch is off, so this variable stays inactive even when its activation rule matches." })}</p>
        </div>
      )}
    </div>
  );
}
