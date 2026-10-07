import { entryTrigger, type EntryTrigger, type WorldDefinition, estimateTokens, isTokenizerReady } from "@yumina/engine";

/**
 * What this card spends on EVERY turn, before the model writes a word.
 *
 * Across the stored library 61% of entries are always-on and only 3% carry a
 * condition — so on most cards the wiring says almost nothing and the real
 * question a creator has is "what am I shipping every single turn, and what
 * does it cost". That question has no home in the editor today; the canvas is
 * where it belongs, because it is the one place that shows the whole card at
 * once.
 *
 * Estimates, not billing. `estimateTokens` falls back to a character
 * heuristic when the tokenizer can't load (which is normal on slow networks),
 * so every number here is rendered with a `~`.
 */

export type { EntryTrigger };

export interface RowCost {
  tokens: number;
  alwaysOn: boolean;
  trigger: EntryTrigger;
  /** Always-on and large enough to be worth a second look. */
  hot: boolean;
}

export interface ContextBudget {
  /** Keyed by graph node id — "entry:<id>" / "greeting:<id>". */
  rows: Map<string, RowCost>;
  entryCount: number;
  alwaysOnCount: number;
  alwaysOnTokens: number;
  /** The `<game-state>` block the engine injects every turn. */
  stateTokens: number;
  stateVarCount: number;
  /** Node ids a block should surface first when nothing is wired. */
  preferred: Set<string>;
  /** Always-on tokens, split by which block they land in. An "always-on"
   *  block's own recurring cost is the number that block has to show. */
  tokensByTrigger: Record<EntryTrigger, number>;
  countByTrigger: Record<EntryTrigger, number>;
}

/** Tokenising the same unchanged entry on every keystroke is wasted work, and
 *  a card can carry ninety of them. Cache by exact text. */
const tokenCache = new Map<string, number>();
function cachedTokens(text: string): number {
  if (!text) return 0;
  const hit = tokenCache.get(text);
  if (hit !== undefined) return hit;
  const n = estimateTokens(text);
  // Only exact counts are kept; a pre-load heuristic would stick for the session.
  if (!isTokenizerReady()) return n;
  // Plain bound — this is a per-session cache, not a store.
  if (tokenCache.size > 4000) tokenCache.clear();
  tokenCache.set(text, n);
  return n;
}

/** Static approximation of the engine's AI-visibility gate. The real one also
 *  consults live state and module activation; the canvas has neither, and says
 *  "~" for exactly this reason. */
function aiReadable(v: { internal?: boolean; aiAccess?: "write" | "read" | "none" }): boolean {
  return !v.internal && (v.aiAccess ?? "write") !== "none";
}

/** How many always-on rows the board should nominate when nothing is wired. */
const PREFERRED_LIMIT = 8;

export function computeContextBudget(world: WorldDefinition): ContextBudget {
  const rows = new Map<string, RowCost>();
  const entries = world.entries ?? [];

  let entryCount = 0;
  let alwaysOnCount = 0;
  let alwaysOnTokens = 0;
  const alwaysOn: Array<{ nodeId: string; tokens: number }> = [];

  const tokensByTrigger: Record<EntryTrigger, number> = { always: 0, keywords: 0, conditions: 0, manual: 0 };
  const countByTrigger: Record<EntryTrigger, number> = { always: 0, keywords: 0, conditions: 0, manual: 0 };

  for (const e of entries) {
    if (e.role === "greeting") {
      // An opening ships once, at the start — never a recurring cost. It still
      // gets a size, because "how long is my opening" is a real question and
      // the board is where the opening is read.
      rows.set(`greeting:${e.id}`, {
        tokens: cachedTokens(e.content ?? ""),
        alwaysOn: false,
        trigger: "manual",
        hot: false,
      });
      continue;
    }
    entryCount++;
    const tokens = cachedTokens(e.content ?? "");
    const trigger = entryTrigger(e);
    tokensByTrigger[trigger] += tokens;
    countByTrigger[trigger]++;
    const on = trigger === "always" && e.enabled !== false;
    if (on) {
      alwaysOnCount++;
      alwaysOnTokens += tokens;
      alwaysOn.push({ nodeId: `entry:${e.id}`, tokens });
    }
    rows.set(`entry:${e.id}`, { tokens, alwaysOn: on, trigger, hot: false });
  }

  // "Expensive" only means anything relative to this card's own budget: 2k
  // tokens is most of a small card and a rounding error on a large one.
  const hotFloor = Math.max(800, alwaysOnTokens * 0.12);
  for (const { nodeId, tokens } of alwaysOn) {
    if (tokens >= hotFloor) {
      const row = rows.get(nodeId);
      if (row) rows.set(nodeId, { ...row, hot: true });
    }
  }

  // The `<game-state>` block: one "id: value" line per AI-readable variable.
  const variables = (world.variables ?? []).filter(aiReadable);
  const stateText = variables
    .map((v) => {
      const value = v.defaultValue;
      const rendered =
        value === undefined || value === null
          ? ""
          : typeof value === "string"
            ? value
            : JSON.stringify(value);
      return `${v.id}: ${rendered}`;
    })
    .join("\n");

  const preferred = new Set(
    alwaysOn
      .slice()
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, PREFERRED_LIMIT)
      .map((x) => x.nodeId),
  );

  return {
    rows,
    entryCount,
    alwaysOnCount,
    alwaysOnTokens,
    stateTokens: cachedTokens(stateText),
    stateVarCount: variables.length,
    preferred,
    tokensByTrigger,
    countByTrigger,
  };
}

/** 37421 → "37.4k". Budgets are read at a glance, not audited. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return (k >= 10 ? Math.round(k) : Math.round(k * 10) / 10) + "k";
}
