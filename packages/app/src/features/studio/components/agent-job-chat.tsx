import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, FileText, Play } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * What the assistant says while doing a whole piece of work. These sit inside
 * its ordinary reply: a line to act on, not a card of its own; the work itself
 * shows on the canvas.
 */

const button = "inline-flex min-h-7 shrink-0 items-center gap-1 rounded-md px-2.5 text-xs font-medium transition-colors [@media(pointer:coarse)]:min-h-10";
const primary = cn(button, "bg-primary text-primary-foreground hover:brightness-110");

/** A line the creator acts on, under the assistant's reply: what it is on the
 *  left, the one thing to do on the right. */
function ActionLine({ children, actions, kind }: { children: ReactNode; actions?: ReactNode; kind: string }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border border-border/70 bg-muted/20 py-1.5 pl-3 pr-1.5" data-agent-job={kind}>
      <div className="min-w-0 flex-1 text-xs text-muted-foreground tabular-nums">{children}</div>
      {actions && <div className="flex items-center gap-1">{actions}</div>}
    </div>
  );
}

/** Only for a big job: what it will do, the time and the cost, then it
 *  starts. The plan used to hide behind 「看看计划」; when the reply above it
 *  had no words, a newcomer saw only 「9 分钟 · 开始」 and sat waiting. */
export function JobAsk({ plan, minutes, mushies, interactive, onStart }: {
  plan: string[];
  minutes: number;
  /** null when the creator's own key pays. */
  mushies: number | null;
  /** Only the newest proposal, not yet started, has buttons. */
  interactive: boolean;
  onStart: () => void;
}) {
  const { t } = useTranslation("editor");
  return (
    <>
      {plan.length > 0 && (
        <ol className="mt-2 list-decimal space-y-0.5 pl-4 text-xs text-muted-foreground">
          {plan.map((line, i) => <li key={i}>{line}</li>)}
        </ol>
      )}
      <ActionLine
        kind="ask"
        actions={interactive && (
          <button type="button" onClick={onStart} className={primary}>
            <Play className="h-3 w-3" aria-hidden="true" />{t("studio.job.start")}
          </button>
        )}
      >
        {mushies === null ? t("studio.job.askByKey", { minutes }) : t("studio.job.ask", { minutes, mushies })}
      </ActionLine>
    </>
  );
}

/** The advisor saved the creative brief; building from it is one press away. */
export function BriefReady({ onBuild }: { onBuild: () => void }) {
  const { t } = useTranslation("editor");
  return (
    <ActionLine
      kind="brief"
      actions={(
        <button type="button" onClick={onBuild} className={primary}>
          {t("studio.aiChat.mode.buildFromBrief")}<ArrowRight className="h-3 w-3" aria-hidden="true" />
        </button>
      )}
    >
      <span className="inline-flex items-center gap-1.5"><FileText className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{t("studio.aiChat.mode.briefSaved")}</span>
    </ActionLine>
  );
}

const DIGEST_PHASES = ["read", "merge", "check", "save"] as const;

/** While a book is being read into a reference: the four steps, the current
 *  one with its count. The run takes tens of minutes, so this is what the
 *  creator watches instead of a bare spinner. */
export function DigestProgress({ phase, source, done, total }: {
  phase: (typeof DIGEST_PHASES)[number];
  source: string;
  done: number;
  total: number;
}) {
  const { t } = useTranslation("editor");
  const at = DIGEST_PHASES.indexOf(phase);
  const share = total > 0 ? Math.min(1, done / total) : 0;
  return (
    <div className="mt-1.5 flex flex-col gap-2 text-xs" data-agent-job="digest">
      <p className="text-muted-foreground">{t("studio.job.digestIntro", { source })}</p>
      <ol className="space-y-1">
        {DIGEST_PHASES.map((p, i) => (
          <li key={p} className={cn("flex items-center gap-2", i > at && "text-muted-foreground/60", i < at && "text-muted-foreground")}>
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", i < at ? "bg-primary/60" : i === at ? "bg-primary animate-pulse" : "bg-muted-foreground/30")} />
            <span className={cn(i === at && "font-medium text-foreground")}>{t(`studio.job.digestStep.${p}` as never)}</span>
            {i === at && total > 0 && p !== "save" && <span className="tabular-nums text-muted-foreground">{done}/{total}</span>}
          </li>
        ))}
      </ol>
      {at < 3 && (
        <div className="h-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${Math.round(share * 100)}%` }} />
        </div>
      )}
    </div>
  );
}
