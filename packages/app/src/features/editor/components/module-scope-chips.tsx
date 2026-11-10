import { useTranslation } from "react-i18next";
import { Monitor } from "lucide-react";
import type { Worldbook } from "@yumina/engine";
import { cn } from "@/lib/utils";
import { scopeForModule, type ModuleScope } from "../lib/module-scope";

/**
 * One row of chips that narrows a page to the card's shared objects or to one
 * module's own. The lorebook, variables and behaviours pages all wear it, and
 * the module page hands the same value over when it jumps to an object.
 *
 * A filter, nothing more: no switches, no activation, no settings. Those
 * belong to the module, on the module page — putting them on a list of
 * entries is what made a module read as "another lorebook".
 */
export function ModuleScopeChips({
  value,
  onChange,
  books,
  counts,
  bindingsCount = 0,
  className,
  dataTour,
}: {
  value: ModuleScope;
  onChange: (scope: ModuleScope) => void;
  books: Worldbook[];
  /** Per-scope object counts, when the page knows them. */
  counts?: (scope: ModuleScope) => number | undefined;
  /** Entries page only: the frontend-controlled view, shown when the card
   *  wires any lore controls. */
  bindingsCount?: number;
  className?: string;
  dataTour?: string;
}) {
  const { t } = useTranslation("editor");
  const chips: Array<{ scope: ModuleScope; label: string; tone: "all" | "core" | "module" | "bindings"; muted?: boolean }> = [
    { scope: "all", label: t("modules.scope.all"), tone: "all" },
    { scope: "core", label: t("modules.scope.core"), tone: "core" },
    ...books.map((b) => ({
      scope: scopeForModule(b.id),
      label: b.name || t("modules.untitled"),
      tone: "module" as const,
      muted: b.enabled === false,
    })),
    ...(bindingsCount > 0
      ? [{ scope: "bindings", label: t("kb.bindingsTab"), tone: "bindings" as const }]
      : []),
  ];
  const ON: Record<string, string> = {
    all: "border-amber-400 bg-amber-500/10 text-amber-300",
    core: "border-zinc-300 bg-zinc-400/10 text-zinc-200",
    module: "border-primary bg-primary/10 text-primary",
    bindings: "border-emerald-400 bg-emerald-500/10 text-emerald-400",
  };
  return (
    <div
      data-tour={dataTour}
      className={cn("flex items-center gap-1.5 overflow-x-auto", className)}
      style={{ scrollbarWidth: "none" } as React.CSSProperties}
    >
      {chips.map((chip) => {
        const on = value === chip.scope;
        const n = counts?.(chip.scope);
        return (
          <button
            key={chip.scope}
            type="button"
            onClick={() => onChange(chip.scope)}
            className={cn(
              "flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-bold transition-colors",
              on ? ON[chip.tone] : "border-transparent text-muted-foreground hover:text-foreground",
              chip.muted && !on && "opacity-50",
            )}
          >
            {chip.tone === "bindings" && <Monitor className="h-3 w-3" />}
            {chip.label}
            {typeof n === "number" && (
              <span className={cn("text-[10px] font-semibold tabular-nums", on ? "opacity-80" : "opacity-60")}>{n}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
