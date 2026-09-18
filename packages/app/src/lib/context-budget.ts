import { useConfigStore } from "@/stores/config";
import { useCreditStore } from "@/edition/slots.state";

/** Matches the settings page upper bound. */
export const CONTEXT_HARD_MAX = 2_000_000;

export interface EffectiveContextInfo {
  /** Context the next generation will actually get (plan cap applied). */
  effective: number;
  /** Plan memory cap when it applies (official-key Free/Gold users), else null. */
  planCap: number | null;
}

export function getEffectiveContextInfo(): EffectiveContextInfo {
  const { maxContext } = useConfigStore.getState();
  const { memoryCap, provider } = useCreditStore.getState();
  const capApplies = provider !== "private" && memoryCap != null && memoryCap > 0;
  return {
    effective: capApplies ? Math.min(maxContext, memoryCap) : maxContext,
    planCap: capApplies ? memoryCap : null,
  };
}

export function roundUpToThousand(n: number): number {
  return Math.ceil(n / 1000) * 1000;
}

/** Compact display for token counts: 152k / 1.5M / 800. */
export function formatTokensCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/**
 * Raise the user's context setting to fit `neededTokens`, clamped to the plan
 * cap and global bounds. Returns the value actually set (may be below the need
 * when the plan cap is lower).
 */
export function raiseMaxContext(neededTokens: number): number {
  const { planCap } = getEffectiveContextInfo();
  const target = Math.min(roundUpToThousand(neededTokens), planCap ?? CONTEXT_HARD_MAX);
  const clamped = Math.max(4096, Math.min(target, CONTEXT_HARD_MAX));
  useConfigStore.getState().setConfig("maxContext", clamped);
  return clamped;
}
