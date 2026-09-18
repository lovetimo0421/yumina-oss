import type {
  WorldEntry,
  Condition,
  GameState,
  WorldSettings,
  LoreUiBinding,
} from "../types/index.js";
import { checkConditions, evaluateCondition } from "../state/condition-evaluator.js";
import {
  getEntryBoundSlotId,
  isLoreSlotActive,
  isUiBoundEntry,
  isVariableBoundEntry,
} from "./entry-triggers.js";
import { keywordMatches } from "./keyword-matcher.js";
import { estimateTokens } from "../prompts/token-utils.js";

export interface LorebookMatchResult {
  /** Entries that always inject (alwaysSend=true), not subject to token budget */
  alwaysSend: WorldEntry[];
  /** Entries matched by keyword/condition, trimmed to fit token budget */
  triggered: WorldEntry[];
  /** Total estimated tokens used by triggered entries */
  triggeredTokens: number;
}

interface ScoredEntry {
  entry: WorldEntry;
  score: number;
}

/**
 * Matches world entries against recent messages and game state.
 * Supports fuzzy matching, whole-word matching, secondary keywords,
 * entry groups, and recursive cascading triggers.
 */
export class LorebookMatcher {
  /**
   * Full match with token budgeting.
   * @param entries All entries for this world (filters out greeting/disabled internally)
   * @param recentMessages Recent message texts to scan for keywords
   * @param state Current game state for condition evaluation
   * @param tokenBudget Max tokens for triggered entries (default Infinity — include all)
   * @param settings Optional world settings (for recursion depth)
   * @param modelId Optional model id so the budget uses the right tokenizer
   *                (CJK-aware for Gemini/Claude, cl100k_base otherwise)
   */
  matchWithBudget(
    entries: WorldEntry[],
    recentMessages: string[],
    state: GameState,
    tokenBudget = Infinity,
    settings?: Partial<Pick<WorldSettings, "lorebookRecursionDepth">>,
    modelId?: string,
    loreUiBindings?: LoreUiBinding[],
  ): LorebookMatchResult {
    const recursionDepth = Math.min(
      Math.max(settings?.lorebookRecursionDepth ?? 0, 0),
      10
    );

    // 1. SEPARATE: alwaysSend vs candidates
    const alwaysSend: WorldEntry[] = [];
    const candidates: WorldEntry[] = [];

    for (const entry of entries) {
      if (entry.role === "greeting") continue;
      const variableBound = isVariableBoundEntry(entry);
      if (!entry.enabled && !variableBound) continue;

      const uiBound = isUiBoundEntry(entry.id, loreUiBindings);
      if (entry.alwaysSend && !variableBound && !uiBound) {
        alwaysSend.push(entry);
      } else {
        candidates.push(entry);
      }
    }

    if (candidates.length === 0) {
      return { alwaysSend, triggered: [], triggeredTokens: 0 };
    }

    // 2. ITERATIVE SCAN with recursion
    let textToScan = recentMessages.join(" ");
    const activatedIds = new Set<string>();
    const scoredEntries: ScoredEntry[] = [];

    for (let depth = 0; depth <= recursionDepth; depth++) {
      const newlyActivated: ScoredEntry[] = [];

      for (const entry of candidates) {
        if (activatedIds.has(entry.id)) continue;

        // Skip entries excluded from recursion (depth > 0 = recursion scan)
        if (depth > 0 && entry.excludeRecursion) continue;

        const boundSlotId = getEntryBoundSlotId(entry.id, loreUiBindings);
        if (boundSlotId && !isLoreSlotActive(boundSlotId, state)) continue;

        // Check state conditions first (cheap)
        if (
          entry.conditions.length > 0 &&
          !this.checkConditions(state, entry.conditions, entry.conditionLogic)
        ) {
          continue;
        }

        // Check primary keywords
        const wholeWord = entry.matchWholeWords ?? false;

        if (entry.keywords.length === 0) {
          if (entry.conditions.length === 0 && !boundSlotId) continue;
          newlyActivated.push({ entry, score: 0 });
          continue;
        }

        let matchedPrimaryCount = 0;
        for (const kw of entry.keywords) {
          if (keywordMatches(textToScan, kw, wholeWord)) {
            matchedPrimaryCount++;
          }
        }

        if (matchedPrimaryCount === 0) continue;

        // Check secondary keywords
        const secondaryKws = entry.secondaryKeywords ?? [];
        const secondaryLogic = entry.secondaryKeywordLogic ?? "AND_ANY";

        if (secondaryKws.length > 0) {
          const secondaryMatches = secondaryKws.filter((kw) =>
            keywordMatches(textToScan, kw, wholeWord)
          );
          const matchedCount = secondaryMatches.length;
          const totalCount = secondaryKws.length;

          let secondaryPass = false;
          switch (secondaryLogic) {
            case "AND_ANY":
              secondaryPass = matchedCount > 0;
              break;
            case "AND_ALL":
              secondaryPass = matchedCount === totalCount;
              break;
            case "NOT_ANY":
              secondaryPass = matchedCount === 0;
              break;
            case "NOT_ALL":
              secondaryPass = matchedCount < totalCount;
              break;
          }

          if (!secondaryPass) continue;
        }

        // Score: primary match count + secondary bonus
        const secondaryScore = secondaryKws.length > 0 ? 1 : 0;
        const score = matchedPrimaryCount + secondaryScore;

        newlyActivated.push({ entry, score });
      }

      if (newlyActivated.length === 0) break; // Stop recursion early

      // Record activations
      for (const scored of newlyActivated) {
        activatedIds.add(scored.entry.id);
        scoredEntries.push(scored);
      }

      // Append activated content to scan text for next recursion depth
      // (unless entry has preventRecursion)
      if (depth < recursionDepth) {
        const newContent = newlyActivated
          .filter((s) => !s.entry.preventRecursion)
          .map((s) => s.entry.content)
          .join(" ");
        if (newContent) {
          textToScan = textToScan + " " + newContent;
        }
      }
    }

    // 3. SORT: position ascending, then score desc for tiebreak
    const resolved = scoredEntries;
    resolved.sort((a, b) => {
      const aPos = a.entry.position ?? 0;
      const bPos = b.entry.position ?? 0;
      if (aPos !== bPos) return aPos - bPos;
      return b.score - a.score;
    });

    // 4. BUDGET: fill from top until token budget exhausted
    const budgeted: WorldEntry[] = [];
    let usedTokens = 0;

    for (const { entry } of resolved) {
      const entryTokens = estimateTokens(entry.content, modelId);
      if (usedTokens + entryTokens > tokenBudget && budgeted.length > 0) {
        break;
      }
      budgeted.push(entry);
      usedTokens += entryTokens;
    }

    return {
      alwaysSend,
      triggered: budgeted,
      triggeredTokens: usedTokens,
    };
  }

  /**
   * Legacy match method — returns flat array (always-send + triggered combined).
   */
  match(
    entries: WorldEntry[],
    recentMessages: string[],
    state: GameState
  ): WorldEntry[] {
    const result = this.matchWithBudget(entries, recentMessages, state);
    return [...result.alwaysSend, ...result.triggered];
  }

  checkConditions(
    state: GameState,
    conditions: Condition[],
    logic: "all" | "any",
  ): boolean {
    return checkConditions(state, conditions, logic);
  }

  /** @internal Exposed for tests that assert on single-condition evaluation. */
  evaluateCondition(state: GameState, condition: Condition): boolean {
    return evaluateCondition(state, condition);
  }
}
