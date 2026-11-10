import { HISTORY_LIMIT_MAX, type WorldSettings } from "@yumina/engine";

/**
 * How much of the past the story AI reads, as three choices: everything the
 * budget allows, the latest N messages, or a rolling summary plus the latest
 * N. Two settings hold it (`historyLimit` and `storySummary`), and the card
 * form and the Context form each used to write them their own way — 「全部」
 * on the card cleared the limit and left the summary on, which the Context
 * form then read as 「摘要」 over a window of 0. Every place that shows or
 * sets the choice goes through these two functions, so they cannot disagree.
 */
export type HistoryMode = "all" | "latest" | "summary";

export const DEFAULT_LATEST = 20;
export const DEFAULT_SUMMARY_LATEST = 30;

type HistorySettings = Pick<WorldSettings, "historyLimit" | "storySummary"> | undefined;

/** The window as stored: which mode, and N when one is set. */
export function historyWindowOf(settings: HistorySettings): { mode: HistoryMode; count: number | undefined } {
  const limit = settings?.historyLimit;
  const count = typeof limit === "number" && limit >= 1 ? Math.min(HISTORY_LIMIT_MAX, Math.floor(limit)) : undefined;
  if (settings?.storySummary?.enabled) return { mode: "summary", count };
  return { mode: count ? "latest" : "all", count };
}

/** What to write for a mode, from what is there now: both settings, always,
 *  so no choice leaves the other's half behind. */
export function historyModeSettings(settings: HistorySettings, next: HistoryMode): Pick<WorldSettings, "historyLimit" | "storySummary"> {
  const { count } = historyWindowOf(settings);
  if (next === "all") return { historyLimit: undefined, storySummary: undefined };
  if (next === "latest") return { historyLimit: count ?? DEFAULT_LATEST, storySummary: undefined };
  return {
    historyLimit: count ?? DEFAULT_SUMMARY_LATEST,
    storySummary: { enabled: true, ...(settings?.storySummary?.focus ? { focus: settings.storySummary.focus } : {}) },
  };
}
