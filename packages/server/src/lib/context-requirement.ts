import {
  GameStateManager,
  PromptBuilder,
  estimateTokens,
  migrateWorldDefinition,
} from "@yumina/engine";
import type { WorldDefinition } from "@yumina/engine";

/**
 * Recommended room for the conversation itself, on top of the world's static
 * prompt content. Grounded in two sources (2026-06-11):
 *
 * - The story-compaction system keeps a 20k-token raw recent tail
 *   (STORY_COMPACTION_RECENT_TAIL_TOKENS) and reserves 3k for the injected
 *   [Summary of earlier events] block (STORY_SUMMARY_PROMPT_RESERVE_TOKENS).
 * - Real conversation sizes (12k-message sample): median assistant reply ≈ 874
 *   tokens, median user input ≈ 14 → a turn ≈ ~1k tokens, so 20k ≈ 20 recent
 *   turns of raw history.
 *
 * 20k tail + 3k summary + ~1k dynamic blocks (depth entries, variable summary,
 * post-history) ⇒ 24k. Below this the story still runs, but the model sees very
 * little recent history between compactions.
 */
export const STORY_ROOM_RESERVE_TOKENS = 24_000;

/** Personas are short user bios — allow a small flat budget for the injected block. */
const PERSONA_ALLOWANCE_TOKENS = 256;

export interface WorldContextRequirement {
  /** Minimum context (tokens) to play with no lore omitted + comfortable story room. */
  requiredTokens: number;
  /** System prompt + format/behavior scaffolding + persona allowance (no entries). */
  scaffoldTokens: number;
  /** All enabled non-greeting entries — alwaysSend and keyword-triggered lore. */
  loreTokens: number;
  /** Largest enabled greeting (it opens the chat history). */
  greetingTokens: number;
  /** Recommended room for chat history + story summary. */
  reserveTokens: number;
}

// Tokenizing a multi-hundred-KB schema is CPU-bound work — cache per world
// version. Insertion-order Map doubles as a simple LRU.
const cache = new Map<string, WorldContextRequirement>();
const CACHE_MAX = 300;

function roundUpToThousand(n: number): number {
  return Math.ceil(n / 1000) * 1000;
}

/**
 * Estimate the minimum context size needed to play a world card without
 * silently omitting lore. Uses the same engine prompt builders as the real
 * generation path so the scaffold measurement matches what is actually sent.
 * Token counts use the model-agnostic estimator (cl100k — conservative).
 *
 * Returns null when the schema is missing or can't be interpreted.
 */
export function computeWorldContextRequirement(
  rawSchema: unknown,
  cacheKey?: string
): WorldContextRequirement | null {
  if (!rawSchema || typeof rawSchema !== "object") return null;
  if (cacheKey) {
    const hit = cache.get(cacheKey);
    if (hit) {
      // refresh LRU position
      cache.delete(cacheKey);
      cache.set(cacheKey, hit);
      return hit;
    }
  }

  let result: WorldContextRequirement;
  try {
    const worldDef = migrateWorldDefinition(rawSchema as WorldDefinition);
    const promptBuilder = new PromptBuilder();
    const snapshot = new GameStateManager(worldDef).getSnapshot();

    // Entries are counted separately below — measure the bare scaffold with a
    // greetings-only entry list so nothing is double-counted.
    const bareDef: WorldDefinition = {
      ...worldDef,
      entries: worldDef.entries.filter((e) => e.role === "greeting"),
    };

    let scaffoldTokens = PERSONA_ALLOWANCE_TOKENS;
    for (const m of promptBuilder.buildSystemMessages(bareDef, snapshot)) {
      scaffoldTokens += estimateTokens(m.content);
    }
    scaffoldTokens += estimateTokens(promptBuilder.buildStaticFormatBlock(worldDef));
    scaffoldTokens += estimateTokens(promptBuilder.buildFormatBlock(worldDef, snapshot));

    let loreTokens = 0;
    let greetingTokens = 0;
    for (const entry of worldDef.entries) {
      if (!entry.enabled || !entry.content) continue;
      if (entry.role === "greeting") {
        greetingTokens = Math.max(greetingTokens, estimateTokens(entry.content));
        continue;
      }
      loreTokens += estimateTokens(entry.content);
    }

    result = {
      requiredTokens: roundUpToThousand(
        scaffoldTokens + loreTokens + greetingTokens + STORY_ROOM_RESERVE_TOKENS
      ),
      scaffoldTokens,
      loreTokens,
      greetingTokens,
      reserveTokens: STORY_ROOM_RESERVE_TOKENS,
    };
  } catch {
    return null;
  }

  if (cacheKey) {
    cache.set(cacheKey, result);
    if (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }
  return result;
}
