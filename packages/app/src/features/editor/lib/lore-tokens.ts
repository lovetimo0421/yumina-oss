import { estimateTokens, isTokenizerReady, type WorldEntry } from "@yumina/engine";

// PERF: cache token estimates keyed by the entry OBJECT. updateEntry replaces
// only the edited entry's object (others keep identity), so on each keystroke
// the token summary recomputes just the one changed entry and reuses cached
// counts for the rest — turning an O(total-content) re-tokenize per keystroke
// into O(1). A WeakMap means stale entries are GC'd automatically, no eviction.
const entryTokenCache = new WeakMap<WorldEntry, number>();

export function entryTokens(entry: WorldEntry): number {
  const cached = entryTokenCache.get(entry);
  if (cached !== undefined) return cached;
  const tokens = estimateTokens(entry.content);
  // A pre-load heuristic must not outlive the tokenizer: the entry object
  // would keep answering the estimate until it happened to be replaced.
  if (isTokenizerReady()) entryTokenCache.set(entry, tokens);
  return tokens;
}

export type LoreTokenHealth = "healthy" | "caution" | "heavy";

export interface LoreTokenSummary {
  greeting: number;
  alwaysSent: number;
  keywordTriggered: number;
  dormant: number;
  disabled: number;
  greetingCount: number;
  /** The predictable per-turn floor: only lore sent every turn fires every turn. */
  perTurn: number;
  total: number;
  health: LoreTokenHealth;
}

/**
 * The card's lore split into cost-meaningful buckets. Categorization mirrors
 * the runtime gating in lorebook-matcher.ts + prompt-builder.ts so each bucket
 * maps to a distinct cost behavior:
 *   greeting          — role=greeting; sent once per session (alwaysSend has
 *                       no effect on greetings, runtime filters them out)
 *   alwaysSent        — alwaysSend=true; every turn, predictable baseline
 *   keywordTriggered  — keywords or conditions; fires when they match,
 *                       capped by `lorebookTokenBudget` setting (variable)
 *   dormant           — !alwaysSend, no keywords, no conditions: never sent
 *                       on its own. Standby lore (待命设定) is this on purpose —
 *                       a behaviour switches it on (isStandbyOn); otherwise a
 *                       setup slip. Labelled 待命 to match the canvas.
 *   disabled          — enabled=false; zero cost until re-enabled
 * Sums every entry — a tag or scope filter must not change the totals.
 */
export function summarizeLoreTokens(entries: readonly WorldEntry[]): LoreTokenSummary {
  const s = { greeting: 0, alwaysSent: 0, keywordTriggered: 0, dormant: 0, disabled: 0 };
  let greetingCount = 0;
  let total = 0;
  for (const e of entries) {
    const tk = entryTokens(e);
    total += tk;
    if (e.enabled === false) { s.disabled += tk; continue; }
    if (e.role === "greeting") { s.greeting += tk; greetingCount++; continue; }
    if (e.alwaysSend) { s.alwaysSent += tk; continue; }
    if ((e.keywords?.length ?? 0) > 0 || (e.conditions?.length ?? 0) > 0) s.keywordTriggered += tk;
    else s.dormant += tk;
  }
  // Health bands nudge creators toward concise lorebooks — past ~60k the
  // model starts losing fidelity on early-prompt details.
  const health: LoreTokenHealth = total < 30_000 ? "healthy" : total < 60_000 ? "caution" : "heavy";
  return { ...s, greetingCount, perTurn: s.alwaysSent, total, health };
}

/** The health dot's look, shared by every surface that shows it. */
export const LORE_HEALTH_DOT: Record<LoreTokenHealth, string> = {
  healthy: "bg-emerald-400/80 shadow-[0_0_6px_rgba(52,211,153,0.55)]",
  caution: "bg-amber-400/90 shadow-[0_0_6px_rgba(251,191,36,0.6)]",
  heavy: "bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.7)] animate-pulse",
};
