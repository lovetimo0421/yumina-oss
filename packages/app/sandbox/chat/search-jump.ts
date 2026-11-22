// Chat search → "take me there". The host holds only a recent window of the
// transcript; a hit further back is reached by loading earlier pages until its
// row is in `messages` (the same pages scrolling up would load), then the
// transcript scrolls to it.

export interface HistoryWindowState {
  sessionId: string;
  messages: readonly { id?: unknown }[];
  hasEarlierMessages: boolean;
  isLoadingEarlier: boolean;
  firstMessageNumber: number;
}

/** Page requests allowed to reach a message `position` from this window. A
 *  page holds up to 200 rows but fewer when they are large, so this budgets
 *  generously; every request still has to make progress. */
export function pageBudget(state: Pick<HistoryWindowState, "firstMessageNumber">, position: number): number {
  const missing = Math.max(0, state.firstMessageNumber - position);
  return Math.ceil(missing / 20) + 3;
}

/**
 * Load earlier pages until `messageId` is in the window. Resolves true once it
 * is, false when history runs out, a page fails, the session changes, or the
 * budget is spent.
 */
export async function loadUntilMessage(options: {
  messageId: string;
  position: number;
  current: () => HistoryWindowState;
  load: () => Promise<boolean>;
  /** Resolves once the host's answer to a page request reached `current()`. */
  committed: (previous: HistoryWindowState) => Promise<void>;
  signal?: AbortSignal;
}): Promise<boolean> {
  const start = options.current();
  const has = (state: HistoryWindowState) => state.messages.some((row) => row.id === options.messageId);
  if (has(start)) return true;
  const budget = pageBudget(start, options.position);
  for (let page = 0; page < budget; page++) {
    if (options.signal?.aborted) return false;
    const before = options.current();
    if (before.sessionId !== start.sessionId) return false;
    if (has(before)) return true;
    if (!before.hasEarlierMessages) return false;
    if (before.isLoadingEarlier) {
      // Someone else's page (the reader scrolled to the top): wait it out.
      await options.committed(before);
      continue;
    }
    if (!await options.load()) return false;
    await options.committed(before);
    const after = options.current();
    if (has(after)) return true;
    if (after.messages[0]?.id === before.messages[0]?.id && after.hasEarlierMessages) return false;
  }
  return has(options.current());
}

/** Poll `current()` until a page request has landed in it (or `timeoutMs`). */
export function waitForPage(
  current: () => HistoryWindowState,
  previous: HistoryWindowState,
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const check = () => {
      const now = current();
      const landed = now.sessionId !== previous.sessionId ||
        now.messages[0]?.id !== previous.messages[0]?.id ||
        !now.hasEarlierMessages ||
        (previous.isLoadingEarlier && !now.isLoadingEarlier);
      if (landed || Date.now() - startedAt > timeoutMs) resolve();
      else setTimeout(check, 40);
    };
    check();
  });
}

/** Split `text` around case-insensitive occurrences of `query`, for marking hits. */
export function splitHighlight(text: string, query: string): Array<{ text: string; hit: boolean }> {
  const q = query.trim().toLowerCase();
  if (!q) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  // Lowercasing can change length for a few scripts; fall back to unmarked then.
  if (lower.length !== text.length) return [{ text, hit: false }];
  const parts: Array<{ text: string; hit: boolean }> = [];
  let at = 0;
  for (;;) {
    const found = lower.indexOf(q, at);
    if (found < 0) break;
    if (found > at) parts.push({ text: text.slice(at, found), hit: false });
    parts.push({ text: text.slice(found, found + q.length), hit: true });
    at = found + q.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts;
}
