import { Loader2, Pause } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { StudioCreditPause } from "../lib/types";

interface CreditPauseCardProps {
  pause: StudioCreditPause;
  resuming: boolean;
  refreshing: boolean;
  error: string | null;
  onTopUp: () => void;
  onResume: () => void;
  onRefresh: () => void;
}

/** The approved inline recovery card. Budget estimates never imply a debit;
 * saved generations distinguish unpaid results from already settled work. */
export function CreditPauseCard({ pause, resuming, refreshing, error, onTopUp, onResume, onRefresh }: CreditPauseCardProps) {
  const { t, i18n } = useTranslation("editor");
  const format = (value: number) => new Intl.NumberFormat(i18n.language, {
    maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
  }).format(value);
  const generated = pause.phase === "generated";
  const settled = generated && pause.settled === true;
  const stale = pause.reason === "STALE_WORLD";
  const waiting = pause.resumable === false && !pause.billingUnavailable && !stale;
  const budgetUnavailable = !generated && pause.requiredCredits <= 0;
  const blocked = pause.billingUnavailable || budgetUnavailable || stale || waiting;
  const available = pause.availableCredits;
  const knowsBalance = typeof available === "number" && Number.isFinite(available);
  const enough = settled || (knowsBalance && available >= pause.requiredCredits);
  const shortfall = knowsBalance ? Math.max(0, pause.requiredCredits - available) : 0;
  const cost = generated ? pause.cost ?? pause.requiredCredits : pause.requiredCredits;
  const canContinue = !blocked && enough;
  const title = pause.billingUnavailable ? t("studio.aiChat.creditPause.billing")
    : stale || budgetUnavailable || waiting ? t("studio.aiChat.creditPause.unavailable")
      : canContinue ? t("studio.aiChat.creditPause.ready")
        : generated ? t("studio.aiChat.creditPause.saved") : t("studio.aiChat.creditPause.paused");
  const detail = pause.billingUnavailable ? t("studio.aiChat.creditPause.billingDetail")
    : stale ? t("studio.aiChat.creditPause.errorStale")
      : waiting ? t("studio.aiChat.creditPause.errorActive")
        : budgetUnavailable ? t("studio.aiChat.creditPause.budgetDetail")
        : generated && !settled ? t("studio.aiChat.creditPause.savedDetail")
          : canContinue ? t("studio.aiChat.creditPause.readyDetail") : t("studio.aiChat.creditPause.detail");
  const busy = resuming || refreshing;
  const buttonClass = "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 [@media(pointer:coarse)]:min-h-11";

  return (
    <section
      className={cn("min-w-0 rounded-xl border border-primary/25 bg-primary/5 p-3 text-xs min-[420px]:ml-[30px]", canContinue && "border-emerald-500/20 bg-emerald-500/5")}
      aria-live="polite"
      aria-label={title}
      data-credit-pause-run={pause.runId}
    >
      <div className="flex items-center gap-2 font-medium text-foreground" role="status">
        {resuming ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden="true" /> : <Pause className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
        <span>{resuming ? t("studio.aiChat.creditPause.resuming") : title}</span>
      </div>
      <p className="mt-1 break-words text-muted-foreground">{detail}</p>
      <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 tabular-nums">
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-muted-foreground">{t("studio.aiChat.creditPause.available")}</dt>
          <dd className="font-medium text-foreground">{knowsBalance ? t("studio.aiChat.creditPause.amount", { amount: format(available) }) : "—"}</dd>
        </div>
        {!pause.billingUnavailable && !budgetUnavailable && (
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-muted-foreground">{settled ? t("studio.aiChat.creditPause.settled") : generated ? t("studio.aiChat.creditPause.actual") : t("studio.aiChat.creditPause.budget")}</dt>
            <dd className="font-medium text-foreground">{t("studio.aiChat.creditPause.amount", { amount: format(cost) })}</dd>
          </div>
        )}
      </dl>
      {!blocked && (
        <p className="mt-1 text-muted-foreground">
          {settled ? t("studio.aiChat.creditPause.settledNote")
            : generated ? t("studio.aiChat.creditPause.settleNote", { amount: format(cost) })
              : t("studio.aiChat.creditPause.estimateNote")}
        </p>
      )}
      {error && error !== detail && <p className="mt-2 break-words text-destructive" role="alert">{error}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {blocked || (!knowsBalance && !settled) ? (
          <button type="button" onClick={budgetUnavailable && !stale && !waiting ? onResume : onRefresh} disabled={busy} className={cn(buttonClass, "border-border bg-background text-foreground hover:bg-muted")}>
            {refreshing && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {budgetUnavailable && !stale && !waiting ? t("studio.aiChat.creditPause.retryStep") : t("studio.aiChat.creditPause.refresh")}
          </button>
        ) : (
          <>
            <button type="button" onClick={canContinue ? onResume : onTopUp} disabled={busy} className={cn(buttonClass, "border-transparent bg-primary text-primary-foreground hover:brightness-110")}>
              {resuming && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              {resuming ? t("studio.aiChat.creditPause.resuming")
                : !canContinue ? t("studio.aiChat.creditPause.topUp")
                  : generated && !settled ? t("studio.aiChat.creditPause.settleResume") : t("studio.aiChat.creditPause.resume")}
            </button>
            {!canContinue && <button type="button" disabled className={cn(buttonClass, "border-border bg-background text-muted-foreground")}>{t("studio.aiChat.creditPause.resume")}</button>}
            {!canContinue && shortfall > 0 && <span className="ml-auto text-primary tabular-nums">{t("studio.aiChat.creditPause.shortfall", { amount: format(shortfall) })}</span>}
          </>
        )}
      </div>
    </section>
  );
}
