import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Info, X } from "lucide-react";
import { formatTokensCompact, roundUpToThousand } from "@/lib/context-budget";

export interface WorldContextRequirement {
  requiredTokens: number;
  scaffoldTokens: number;
  loreTokens: number;
  greetingTokens: number;
  reserveTokens: number;
}

export interface ContextGateInfo {
  requirement: WorldContextRequirement;
  effective: number;
  planCap: number | null;
}

interface ContextGateModalProps {
  worldName: string;
  gate: ContextGateInfo;
  /** Proceed without changing anything (red option). */
  onIgnore: () => void;
  /** Raise the context setting, then proceed. */
  onRaise: () => void;
  /** Leave the play flow and open the plans page (shown when the card needs
   * more context than the user's plan allows). */
  onUpgrade: () => void;
  /** Abandon the play flow entirely. */
  onClose: () => void;
}

/**
 * Pre-play warning shown when a card's estimated context requirement exceeds
 * the user's current context setting — meaning lore would be silently omitted
 * during play.
 */
export function ContextGateModal({ worldName, gate, onIgnore, onRaise, onUpgrade, onClose }: ContextGateModalProps) {
  const { t } = useTranslation("chat");
  const { requirement, effective, planCap } = gate;

  const required = requirement.requiredTokens;
  // When the plan cap is below the card's need, raising the setting can't fix
  // it — the primary action becomes upgrading the plan instead.
  const cappedBelowNeed = planCap != null && planCap < required;
  const raiseTarget = roundUpToThousand(required);
  const setupTokens = requirement.scaffoldTokens + requirement.greetingTokens;
  const currentPercent = Math.min(100, Math.max(4, (effective / required) * 100));

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl border border-gold/35 bg-card p-5 shadow-[0_24px_80px_rgba(201,162,94,0.16)] sm:p-6">
        <button
          onClick={onClose}
          className="absolute right-3 top-3 inline-flex h-10 w-10 items-center justify-center rounded-full text-sub/50 transition-colors hover:bg-gold/10 hover:text-action-primary focus:outline-none focus:ring-2 focus:ring-gold/50"
          aria-label={t("contextGate.close")}
        >
          <X className="h-4 w-4" />
        </button>

        <div className="mb-4 flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-gold/35 bg-gold/15">
            <Info className="h-5 w-5 text-gold" />
          </div>
          <div>
            <h2 className="text-base font-bold text-action-primary">{t("contextGate.title")}</h2>
            <p className="mt-1 text-xs leading-relaxed text-sub/75">
              {t("contextGate.body", {
                world: worldName,
                required: required.toLocaleString(),
                current: effective.toLocaleString(),
              })}
            </p>
          </div>
        </div>

        <div className="mb-4 rounded-xl border border-gold/25 bg-gold/[0.05] p-3">
          <div className="mb-2 flex items-center justify-between text-[11px]">
            <span className="text-sub/60">{t("contextGate.currentShort", { value: formatTokensCompact(effective) })}</span>
            <span className="font-semibold text-gold">{t("contextGate.recommendedShort", { value: formatTokensCompact(required) })}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-gold/20">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300"
              style={{ width: `${currentPercent}%` }}
            />
          </div>

          <div className="mt-3 grid gap-2 rounded-lg bg-gold/[0.07] p-3 text-xs sm:grid-cols-2">
            <div>
              <p className="text-gold/65">{t("contextGate.retainsLabel")}</p>
              <p className="mt-1 font-semibold leading-relaxed text-action-primary/90">{t("contextGate.retainsValue")}</p>
            </div>
            <div>
              <p className="text-gold/65">{t("contextGate.impactLabel")}</p>
              <p className="mt-1 font-semibold leading-relaxed text-action-primary/90">{t("contextGate.impactValue")}</p>
            </div>
          </div>

          <details className="mt-3 text-xs text-gold/70">
            <summary className="cursor-pointer select-none py-1 transition-colors hover:text-action-primary">
              {t("contextGate.usageDetails")}
            </summary>
            <div className="mt-2 space-y-1.5 border-t border-gold/20 pt-2">
              <div className="flex items-center justify-between"><span>{t("contextGate.loreLabel")}</span><span className="tabular-nums text-action-primary/85">~{requirement.loreTokens.toLocaleString()}</span></div>
              <div className="flex items-center justify-between"><span>{t("contextGate.setupLabel")}</span><span className="tabular-nums text-action-primary/85">~{setupTokens.toLocaleString()}</span></div>
              <div className="flex items-center justify-between"><span>{t("contextGate.storyRoomLabel")}</span><span className="tabular-nums text-action-primary/85">~{requirement.reserveTokens.toLocaleString()}</span></div>
            </div>
          </details>
        </div>

        {cappedBelowNeed && (
          <p className="mb-4 rounded-lg border border-gold/25 bg-gold/[0.08] px-3 py-2 text-xs leading-relaxed text-action-primary/90">
            {t("contextGate.planCapNote", { cap: planCap.toLocaleString() })}
          </p>
        )}

        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            onClick={onIgnore}
            className="min-h-11 flex-1 rounded-xl border border-gold/30 bg-gold/[0.06] px-4 text-sm font-semibold text-action-primary/90 transition-colors hover:border-gold/50 hover:bg-gold/15 hover:text-action-primary"
          >
            {t("contextGate.continueCurrent", { value: formatTokensCompact(effective) })}
          </button>
          {cappedBelowNeed ? (
            <button
              onClick={onUpgrade}
              className="min-h-11 flex-1 rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground shadow-[0_8px_24px_rgba(201,162,94,0.22)] transition-colors hover:bg-primary-hover"
            >
              {t("contextGate.upgrade")}
            </button>
          ) : (
            <button
              onClick={onRaise}
              className="min-h-11 flex-1 rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground shadow-[0_8px_24px_rgba(201,162,94,0.22)] transition-colors hover:bg-primary-hover"
            >
              {t("contextGate.raise", { value: formatTokensCompact(raiseTarget) })}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
