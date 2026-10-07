import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Variable, WorldDefinition } from "@yumina/engine";
import { getVariableIdUsage, variableUsageInputs } from "../lib/variable-id-references";

/** A technical identifier needs an explicit commit boundary. A rejected edit
 * stays in the field, with its reason; typing never changes world references. */
export function VariableIdEditor({ world, variable, onCommit }: {
  world: WorldDefinition;
  variable: Variable;
  /** Return the ID actually assigned (the store may resolve a collision). */
  onCommit: (id: string) => string;
}) {
  const { t } = useTranslation("editor");
  const fieldId = useId();
  const [draft, setDraft] = useState(variable.id);
  const [error, setError] = useState<"used" | "empty" | "rejected" | null>(null);
  const [assigned, setAssigned] = useState<string | null>(null);
  // Memo on the fields the scan actually reads, not the whole world: every
  // commit anywhere replaces `world`, and the scan walks all entries and every
  // interface file. The parent mounts this only while its <details> is open.
  const usageInputs = variableUsageInputs(world);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const usage = useMemo(() => getVariableIdUsage(world, variable), [variable.id, variable.name, ...usageInputs]);
  useEffect(() => { setDraft(variable.id); setError(null); setAssigned((current) => current === variable.id ? current : null); }, [variable.id]);
  const commit = () => {
    const next = draft.trim();
    if (next === variable.id) { setDraft(next); setError(null); return; }
    if (!next) { setError("empty"); return; }
    if (usage.references.length) { setError("used"); return; }
    const actual = onCommit(next);
    if (actual === variable.id) { setError("rejected"); return; }
    setDraft(actual);
    setError(null);
    setAssigned(actual !== next ? actual : null);
  };

  return <div className="min-w-0 space-y-2 text-xs">
    <label htmlFor={fieldId} className="font-medium text-foreground">{t("variables.id")}</label>
    <div className="flex min-w-0 items-start gap-2">
      <input id={fieldId} value={draft} spellCheck={false} aria-invalid={Boolean(error)} aria-describedby={`${fieldId}-hint`}
        onChange={(event) => { setDraft(event.target.value); setError(null); setAssigned(null); }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); commit(); }
          if (event.key === "Escape") { event.preventDefault(); setDraft(variable.id); setError(null); }
        }}
        className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 py-2 font-mono text-xs text-foreground focus:border-primary/50 focus:outline-none aria-invalid:border-destructive" />
      <button type="button" disabled={draft.trim() === variable.id} onMouseDown={(event) => event.preventDefault()} onClick={commit}
        className="shrink-0 rounded-lg border border-border px-2.5 py-2 font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-40">
        {t("variables.editing.applyId", { defaultValue: "Apply" })}
      </button>
    </div>
    <p id={`${fieldId}-hint`} className="text-[11px] leading-relaxed text-muted-foreground">
      {t("variables.editing.idReferences", { defaultValue: "Conditions, behaviors and templates use this ID. Referenced IDs are protected from direct changes." })}
      {" "}<code className="text-primary">{`{{${variable.id}}}`}</code>
    </p>
    {(error || usage.references.length > 0) && <p role={error ? "alert" : "status"} className="text-[11px] leading-relaxed text-amber-500">
      {error === "empty"
        ? t("variables.editing.idEmpty", { defaultValue: "Enter an ID. The current ID has been kept." })
        : error === "rejected"
          ? t("variables.editing.idRejected", { defaultValue: "The ID could not be changed. The current ID has been kept." })
          : t("variables.editing.idInUse", { defaultValue: "This ID is in use. Resolve the references below before changing it; the display name can still be edited." })}
    </p>}
    {assigned && <p role="status" className="text-[11px] text-muted-foreground">{t("variables.idTaken", { id: assigned })}</p>}
    {usage.references.length > 0 && <ul aria-label={t("variables.editing.idUsages", { defaultValue: "ID references" })} className="max-h-52 space-y-2 overflow-y-auto rounded-lg border border-border/60 p-2">
      {usage.references.map((reference) => <li key={reference.path} className="min-w-0">
        <p className="break-words text-[11px] text-foreground">{t(`variables.editing.referenceAreas.${reference.area}` as never, { defaultValue: reference.area })} · {reference.owner}</p>
        <code className="block break-all text-[10px] text-muted-foreground">{reference.path}</code>
      </li>)}
    </ul>}
    {usage.codeReviews.length > 0 && <details className="rounded-lg border border-border/60 p-2 text-[11px] text-muted-foreground">
      <summary className="cursor-pointer font-medium">{t("variables.editing.codeReview", { defaultValue: "Frontend code needs review" })}</summary>
      <p className="my-2 leading-relaxed">{t("variables.editing.codeReviewHint", { defaultValue: "Code is not rewritten. These are review hints, not confirmed ID references; dynamic access cannot be checked completely. The frontend normally uses display names, so review it after changing a name." })}</p>
      <ul className="space-y-2">{usage.codeReviews.map((review) => <li key={`${review.file}:${review.reason}`}>
        <code className="break-all text-foreground">{review.file}</code>
        <p>{t(`variables.editing.codeReasons.${review.reason}` as never, { defaultValue: review.reason })}</p>
      </li>)}</ul>
    </details>}
  </div>;
}

/** Frontend authors bind api.variables by display name, independently of ID. */
export function VariableNameReferenceHint({ world, variable }: { world: WorldDefinition; variable: Variable }) {
  const { t } = useTranslation("editor");
  const usageInputs = variableUsageInputs(world);
  const hasFrontendUse = useMemo(
    () => getVariableIdUsage(world, variable).codeReviews.some((review) => review.reason === "name" || review.reason === "dynamic"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [variable.id, variable.name, ...usageInputs],
  );
  if (!hasFrontendUse) return null;
  return <p className="text-[11px] leading-relaxed text-muted-foreground">{t("variables.editing.nameReferences", { defaultValue: "The frontend may use this display name. After renaming it, check the corresponding interface code." })}</p>;
}
