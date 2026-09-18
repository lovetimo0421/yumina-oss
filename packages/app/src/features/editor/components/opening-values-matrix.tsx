import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/stores/editor";
import type { Variable, WorldEntry } from "@yumina/engine";

/**
 * Opening-values matrix — the SINGLE editing entry point for per-greeting
 * variable seed values (greeting.initialVariables). Rows = variables,
 * columns = the default (read-only reference) + one per opening (greeting).
 *
 * Editing a cell writes `greeting.initialVariables[varId]`. The First Message
 * panel reads the same field, so it stays a synced read-only mirror — there is
 * exactly one place that mutates this data, which removes the lost-update /
 * two-writer class of bug. Writes read the LIVE store state (not the render
 * closure) before merging, so rapid edits across cells can't clobber each other.
 */
function setOpeningValue(greetingId: string, varId: string, value: number | string | boolean) {
  const store = useEditorStore.getState();
  const g = store.worldDraft.entries.find((e) => e.id === greetingId);
  if (!g) return;
  store.updateEntry(greetingId, {
    initialVariables: { ...(g.initialVariables ?? {}), [varId]: value },
  });
}

function clearOpeningValue(greetingId: string, varId: string) {
  const store = useEditorStore.getState();
  const g = store.worldDraft.entries.find((e) => e.id === greetingId);
  if (!g?.initialVariables || !(varId in g.initialVariables)) return;
  const next = { ...g.initialVariables };
  delete next[varId];
  store.updateEntry(greetingId, { initialVariables: next });
}

function defaultFor(v: Variable): number | string | boolean {
  return v.type === "boolean" ? false : v.type === "number" ? 0 : "";
}

function renderDefault(v: Variable, t: TFunction<"editor">): string {
  const d = v.defaultValue;
  if (d === undefined || d === null || d === "") return t("variables.openingValues.unset");
  if (typeof d === "boolean") return d ? t("firstMessage.true") : t("firstMessage.false");
  if (typeof d === "object") return JSON.stringify(d);
  return String(d);
}

/** A single editable cell: shows the override editor when set, otherwise a
 *  muted "use default" affordance that seeds an override on click. */
function Cell({
  v,
  greeting,
}: {
  v: Variable;
  greeting: WorldEntry;
}) {
  const { t } = useTranslation("editor");
  const has = !!greeting.initialVariables && v.id in greeting.initialVariables;
  const value = has ? greeting.initialVariables![v.id] : undefined;

  if (v.type === "json") {
    return <span className="text-xs text-muted-foreground/40">—</span>;
  }

  if (!has) {
    return (
      <button
        type="button"
        onClick={() => setOpeningValue(greeting.id, v.id, defaultFor(v))}
        className="rounded-md border border-dashed border-border/70 px-2.5 py-1 text-xs text-muted-foreground/50 transition-colors hover:border-primary/40 hover:text-primary"
        title={t("variables.openingValues.setOverride")}
      >
        {t("variables.openingValues.useDefault")}
      </button>
    );
  }

  const revert = (
    <button
      type="button"
      onClick={() => clearOpeningValue(greeting.id, v.id)}
      className="shrink-0 rounded p-1 text-muted-foreground/50 transition-colors hover:text-destructive"
      title={t("variables.openingValues.revertToDefault")}
    >
      <RotateCcw className="h-3 w-3" />
    </button>
  );

  return (
    <div className="flex items-center gap-1">
      {v.type === "boolean" ? (
        <button
          type="button"
          onClick={() => setOpeningValue(greeting.id, v.id, !(value as boolean))}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
            value ? "bg-primary text-primary-foreground" : "bg-accent text-muted-foreground"
          )}
        >
          {value ? t("firstMessage.true") : t("firstMessage.false")}
        </button>
      ) : v.type === "number" ? (
        <input
          type="number"
          value={typeof value === "number" ? value : Number(value) || 0}
          onChange={(e) => setOpeningValue(greeting.id, v.id, Number(e.target.value))}
          className="w-24 rounded-md border border-primary/25 bg-primary/[0.04] px-2 py-1 text-xs text-foreground focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/40"
        />
      ) : (
        <input
          type="text"
          value={String(value)}
          onChange={(e) => setOpeningValue(greeting.id, v.id, e.target.value)}
          className="w-32 rounded-md border border-primary/25 bg-primary/[0.04] px-2 py-1 text-xs text-foreground focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/40"
        />
      )}
      {revert}
    </div>
  );
}

export function OpeningValuesMatrix() {
  const { t } = useTranslation("editor");
  const variables = useEditorStore((s) => s.worldDraft.variables);
  const entries = useEditorStore((s) => s.worldDraft.entries);

  const greetings = entries
    .filter((e) => e.role === "greeting")
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  if (greetings.length === 0 || variables.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 pb-20 text-center opacity-60">
        <h2 className="mb-2 text-lg font-bold text-foreground">{t("variables.openingValues.emptyTitle")}</h2>
        <p className="max-w-sm text-sm text-muted-foreground">{t("variables.openingValues.emptyDesc")}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="shrink-0 px-6 pt-6">
        <h2 className="text-base font-bold text-foreground">{t("variables.openingValues.title")}</h2>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t("variables.openingValues.hint")}</p>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-6">
        <table className="w-full border-separate border-spacing-0 text-left">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-20 border-b border-border bg-sidebar px-3 py-2.5 text-xs font-bold text-foreground">
                {t("variables.openingValues.variable")}
              </th>
              <th className="sticky top-0 z-10 border-b border-border bg-sidebar px-3 py-2.5 text-xs font-semibold text-muted-foreground">
                {t("variables.openingValues.default")}
              </th>
              {greetings.map((g, i) => (
                <th
                  key={g.id}
                  className="sticky top-0 z-10 border-b border-border bg-sidebar px-3 py-2.5 text-xs font-semibold text-foreground"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-bold text-primary">
                      {t("variables.openingValues.openingShort")}{i + 1}
                    </span>
                    <span className="max-w-[10rem] truncate text-muted-foreground" title={g.content || g.name}>
                      {g.content?.trim() || g.name || t("variables.openingValues.untitledOpening")}
                    </span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {variables.map((v) => (
              <tr key={v.id} className="group">
                <td className="sticky left-0 z-10 whitespace-nowrap border-b border-border/60 bg-background px-3 py-2 group-hover:bg-accent/40">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] font-bold text-muted-foreground/60">{v.type[0].toUpperCase()}</span>
                    <span className="text-sm font-semibold text-foreground">{v.name || v.id}</span>
                  </div>
                </td>
                <td className="whitespace-nowrap border-b border-border/60 px-3 py-2 text-xs text-muted-foreground/70 group-hover:bg-accent/40">
                  {renderDefault(v, t)}
                </td>
                {greetings.map((g) => (
                  <td key={g.id} className="border-b border-border/60 px-3 py-2 align-middle group-hover:bg-accent/40">
                    <Cell v={v} greeting={g} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
