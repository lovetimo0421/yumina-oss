import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Circle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StudioPlanStep } from "../lib/types";

/**
 * The checklist the assistant keeps while it works (update_plan), above the
 * status bar: one line with how far it is and the step under way; a press
 * shows every step.
 */
export function AgentPlan({ plan }: { plan: StudioPlanStep[] }) {
  const { t } = useTranslation("editor");
  const [open, setOpen] = useState(false);
  const done = plan.filter((s) => s.status === "completed").length;
  const current = plan.find((s) => s.status === "in_progress") ?? plan.find((s) => s.status === "pending");
  return (
    <div className="border-t border-primary/10 bg-primary/[0.03] px-3 py-1" data-agent-plan>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2 text-left text-[11px] text-muted-foreground hover:text-foreground"
      >
        <span className="shrink-0 font-medium text-muted-foreground tabular-nums">{t("studio.aiChat.plan.progress", { done, total: plan.length })}</span>
        {current && <span className="min-w-0 truncate">{current.step}</span>}
        <ChevronDown className={cn("ml-auto h-3 w-3 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <ol className="mt-1 space-y-0.5 pb-0.5">
          {plan.map((s, i) => (
            <li key={i} className="flex items-start gap-1.5 text-[11px] leading-snug">
              {s.status === "completed"
                ? <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400" />
                : s.status === "in_progress"
                ? <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-primary" />
                : <Circle className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/50" />}
              <span className={cn(s.status === "completed" ? "text-muted-foreground line-through" : s.status === "in_progress" ? "text-foreground" : "text-muted-foreground")}>
                {s.step}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
