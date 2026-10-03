import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Info, X } from "lucide-react";
import { formatTokensCompact, roundUpToThousand } from "@/lib/context-budget";

export interface WorldContextRequirement {
  requiredTokens: number;
  scaffoldTokens: number;
  loreTokens: number;
  greetingTokens: number;
  reserveTokens: number;
  // Added 2026-10 — absent from older servers, so the modal falls back to
  // treating all lore as every-turn (the old, strict reading).
  alwaysTokens?: number;
  triggeredTokens?: number;
  floorTokens?: number;
}

export interface ContextGateInfo {
  requirement: WorldContextRequirement;
  effective: number;
  planCap: number | null;
}

interface ContextGateModalProps {
  worldName: string;
  gate: ContextGateInfo;
  /** Proceed without changing anything. */
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
 * Pre-play notice shown when a card's full lore doesn't fit the user's context
 * setting. Two tiers:
 * - soft: everything sent every turn fits; only a turn that triggers lots of
 *   keyword entries at once drops a few. Starting as-is is the default.
 * - hard: even the every-turn content doesn't fit — raising is the default.
 */
export function ContextGateModal({ worldName, gate, onIgnore, onRaise, onUpgrade, onClose }: ContextGateModalProps) {
  const { t } = useTranslation("chat");
  const { requirement, effective, planCap } = gate;

  const full = requirement.requiredTokens;
  const always = requirement.alwaysTokens ?? requirement.loreTokens;
  const triggered = requirement.triggeredTokens ?? 0;
  const floor = requirement.floorTokens ?? full;
  const setup = requirement.scaffoldTokens + requirement.greetingTokens;
  const hard = effective < floor;

  // When the plan cap is below what we'd raise to, raising can't fix it — the
  // action becomes upgrading the plan instead.
  const raiseTarget = roundUpToThousand(full);
  const canRaise = planCap == null || planCap >= raiseTarget;
  // Segments are drawn on the raw sums; the labels use the rounded totals.
  const segments = [
    { key: "setup", label: t("contextGate.rowSetup"), value: setup, color: "bg-sub/55", dot: "bg-sub/55" },
    { key: "always", label: t("contextGate.rowAlways"), value: always, color: "bg-gold", dot: "bg-gold" },
    { key: "history", label: t("contextGate.rowHistory"), value: requirement.reserveTokens, color: "bg-sky-400/80", dot: "bg-sky-400" },
    {
      key: "triggered",
      label: t("contextGate.rowTriggered"),
      value: triggered,
      color: "bg-violet-400/45 bg-[repeating-linear-gradient(135deg,transparent_0_4px,rgba(255,255,255,0.12)_4px_7px)]",
      dot: "bg-violet-400",
      prefix: t("contextGate.upTo"),
    },
  ];
  const total = segments.reduce((sum, s) => sum + s.value, 0) || 1;
  const scale = Math.max(total, effective);
  const pct = (n: number) => `${Math.min(100, (n / scale) * 100)}%`;
  const floorRaw = total - triggered;

  const startBtn = (
    <button
      onClick={onIgnore}
      className={
        hard
          ? "min-h-11 flex-1 rounded-xl border border-gold/30 bg-gold/[0.06] px-4 text-sm font-semibold text-action-primary/90 transition-colors hover:border-gold/50 hover:bg-gold/15"
          : "min-h-11 flex-1 rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground transition-colors hover:bg-primary-hover"
      }
    >
      {t("contextGate.continueCurrent", { value: formatTokensCompact(effective) })}
    </button>
  );
  const fixBtn = (
    <button
      onClick={canRaise ? onRaise : onUpgrade}
      className={
        hard
          ? "min-h-11 flex-1 rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground transition-colors hover:bg-primary-hover"
          : "min-h-11 flex-1 rounded-xl border border-gold/30 bg-gold/[0.06] px-4 text-sm font-semibold text-action-primary/90 transition-colors hover:border-gold/50 hover:bg-gold/15"
      }
    >
      {canRaise
        ? t("contextGate.raise", { value: formatTokensCompact(raiseTarget) })
        : t("contextGate.upgrade")}
    </button>
  );

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl border border-gold/35 bg-card p-5 shadow-[0_24px_80px_rgba(0,0,0,0.35)] sm:p-6">
        <button
          onClick={onClose}
          className="absolute right-3 top-3 inline-flex h-10 w-10 items-center justify-center rounded-full text-sub/50 transition-colors hover:bg-gold/10 hover:text-action-primary focus:outline-none focus:ring-2 focus:ring-gold/50"
          aria-label={t("contextGate.close")}
        >
          <X className="h-4 w-4" />
        </button>

        <div className="mb-4 flex items-start gap-3 pr-8">
          <div
            className={
              hard
                ? "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-destructive/15 text-destructive"
                : "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gold/15 text-gold"
            }
          >
            {hard ? <AlertTriangle className="h-5 w-5" /> : <Info className="h-5 w-5" />}
          </div>
          <div>
            <h2 className="text-base font-bold text-action-primary">
              {t(hard ? "contextGate.hardTitle" : "contextGate.softTitle")}
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-sub/80">
              {hard
                ? t("contextGate.hardBody", { world: worldName, floor: formatTokensCompact(floor), current: formatTokensCompact(effective) })
                : t("contextGate.softBody", { world: worldName, current: formatTokensCompact(effective) })}
            </p>
          </div>
        </div>

        <div className="mb-4 rounded-xl border border-gold/20 bg-gold/[0.04] p-3">
          {/* Stacked bar: what the card needs, by kind. The line marks your setting;
              anything to its right won't fit. */}
          <div className="relative pt-6">
            <div
              className="absolute top-0 -translate-x-1/2 whitespace-nowrap text-[11px] font-semibold"
              style={{ left: `clamp(2.5rem, ${pct(effective)}, calc(100% - 2.5rem))` }}
            >
              <span className={hard ? "text-destructive" : "text-action-primary"}>
                {t("contextGate.yours", { value: formatTokensCompact(effective) })}
              </span>
            </div>
            <div className="flex h-3 overflow-hidden rounded-full bg-gold/10">
              {segments.map((seg) =>
                seg.value > 0 ? <div key={seg.key} className={`h-full ${seg.color}`} style={{ width: pct(seg.value) }} /> : null
              )}
            </div>
            {/* Dim what doesn't fit. */}
            <div
              className="absolute bottom-0 right-0 h-3 rounded-r-full bg-card/60"
              style={{ left: pct(effective) }}
            />
            <div
              className={`absolute bottom-[-4px] h-5 w-0.5 rounded ${hard ? "bg-destructive" : "bg-action-primary"}`}
              style={{ left: pct(effective) }}
            />
          </div>
          <div className="relative mt-1.5 h-4 text-[11px] text-sub/70">
            <span
              className="absolute -translate-x-1/2 whitespace-nowrap"
              style={{ left: `clamp(2.5rem, ${pct(floorRaw)}, calc(100% - 7rem))` }}
            >
              {t("contextGate.markFloor")} {formatTokensCompact(floor)}
            </span>
            <span className="absolute right-0 whitespace-nowrap">
              {t("contextGate.markFull")} {formatTokensCompact(full)}
            </span>
          </div>

          <div className="mt-3 space-y-1.5 border-t border-gold/15 pt-2.5 text-xs text-sub/80">
            {segments.map((seg) => (
              <div key={seg.key} className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 shrink-0 rounded-sm ${seg.dot}`} />
                <span className="flex-1">{seg.label}</span>
                <span className="tabular-nums text-action-primary/85">
                  {seg.prefix ? `${seg.prefix} ` : ""}~{seg.value.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>

        {!canRaise && planCap != null && (
          <p className="mb-4 text-xs leading-relaxed text-sub/70">
            {t("contextGate.planCapNote", { cap: formatTokensCompact(planCap) })}
          </p>
        )}

        <div className="flex flex-col gap-2 sm:flex-row">
          {hard ? <>{fixBtn}{startBtn}</> : <>{startBtn}{fixBtn}</>}
        </div>
      </div>
    </div>,
    document.body
  );
}
