/**
 * Settle a generation the user stopped mid-stream.
 *
 * Until 2026-09-14 an explicit stop discarded the turn, logged nothing and
 * charged nothing, while OpenRouter still billed the prompt plus every token
 * generated up to the abort. This module closes that gap without guessing:
 *
 *   1. If the provider's final usage chunk had already arrived (the user hit
 *      stop as the reply finished), its reported cost is used directly.
 *   2. Otherwise the generation record is fetched from OpenRouter
 *      (`GET /api/v1/generation?id=`), which carries the exact post-cache
 *      `total_cost` and native token counts. The record appears a few
 *      seconds after the stream ends, so the lookup retries with backoff.
 *   3. If neither is available the turn is logged with estimated tokens and
 *      NOT charged — we never charge a list-price estimate for a stop,
 *      because on cache-heavy Claude turns that estimate runs 3-5x the real
 *      cost.
 *
 * Every path records a usage_logs row so the cost stays visible in the
 * reconciliation against the OpenRouter bill. Charging goes through the same
 * calculateCost/deductCredits pair as a completed turn, keyed on the new
 * usage-log id, so it is idempotent under the ledger's reference check.
 */
import { randomUUID } from "node:crypto";
import { flagWrite } from "../db/index.js";
import { calculateCost, deductCredits, estimateTokensFromChars } from "./credit-service.js";
import { env } from "./env.js";
import type { StreamChunk } from "./llm/types.js";
import { captureServerError } from "./posthog.js";
import { recordUsageLog } from "./usage-log.js";

export interface OpenRouterGenerationCost {
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
}

const DEFAULT_LOOKUP_DELAYS_MS = [1500, 4000, 10000];

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Fetch the billed cost of a generation from OpenRouter. Returns null when the
 * record never became available or the response was unusable. Exported for
 * tests; callers pass the same key the generation ran on.
 */
export async function fetchOpenRouterGenerationCost(
  requestId: string,
  apiKeys: string[],
  options?: { delaysMs?: number[]; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> },
): Promise<OpenRouterGenerationCost | null> {
  const keys = apiKeys.filter((k) => typeof k === "string" && k.length > 0);
  if (!requestId || keys.length === 0) return null;
  const delays = options?.delaysMs ?? DEFAULT_LOOKUP_DELAYS_MS;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const sleep = options?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const url = `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(requestId)}`;

  for (const delay of delays) {
    await sleep(delay);
    for (const key of keys) {
      let res: Response;
      try {
        res = await fetchImpl(url, { headers: { Authorization: `Bearer ${key}` } });
      } catch {
        continue;
      }
      if (res.status === 404) continue; // record not indexed yet, or not this key's account
      if (!res.ok) continue;
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        continue;
      }
      const data = (body as { data?: Record<string, unknown> } | null)?.data;
      if (!data) continue;
      const costUsd = readNumber(data.total_cost);
      if (costUsd === undefined) continue;
      const promptTokens = readNumber(data.native_tokens_prompt) ?? readNumber(data.tokens_prompt) ?? 0;
      const completionTokens = readNumber(data.native_tokens_completion) ?? readNumber(data.tokens_completion) ?? 0;
      return { costUsd, promptTokens: Math.round(promptTokens), completionTokens: Math.round(completionTokens) };
    }
  }
  return null;
}

function officialKeysFor(apiKeyTier: string): string[] {
  const invite = env.YUMINA_INVITE_OPENROUTER_KEY;
  const base = env.YUMINA_OPENROUTER_KEY;
  // Paid tiers run on the invite key when configured (resolve-provider.ts);
  // try that first, then the base key. Both keys usually live on one account.
  const ordered = apiKeyTier !== "free" && apiKeyTier !== "regular" ? [invite, base] : [base, invite];
  return ordered.filter((k): k is string => typeof k === "string" && k.length > 0);
}

export interface StoppedGenerationInput {
  userId: string;
  sessionId: string;
  worldId: string | null | undefined;
  endpoint: "send" | "regenerate" | "continue";
  model: string;
  apiKeyTier: string;
  /** OpenRouter generation id observed on the stream, when any chunk arrived. */
  providerRequestId?: string;
  promptChars: number;
  outputChars: number;
  generationTimeMs: number;
  /** False for BYOK, unlimited plans, trial-covered turns and free-pool fallbacks. */
  chargeable: boolean;
  /** Present when the provider's final usage chunk arrived before the stop. */
  knownUsage?: StreamChunk["usage"];
  /** Test seam. */
  lookup?: typeof fetchOpenRouterGenerationCost;
}

export interface StoppedGenerationResult {
  usageLogId: string;
  costUsd: number | null;
  creditsCharged: number;
  measurement: "provider" | "estimated";
}

/**
 * Log and, when the real cost is known, charge a stopped generation.
 * Never throws; failures are reported to PostHog and swallowed because this
 * runs after the client has already been answered.
 */
export async function settleStoppedGeneration(input: StoppedGenerationInput): Promise<StoppedGenerationResult | null> {
  const usageLogId = randomUUID();
  try {
    let costUsd: number | undefined = readNumber(input.knownUsage?.providerCostUsd);
    let promptTokens = input.knownUsage?.promptTokens ?? 0;
    let completionTokens = input.knownUsage?.completionTokens ?? 0;
    let requestId = input.knownUsage?.providerRequestId ?? input.providerRequestId;

    if (costUsd === undefined && requestId && input.apiKeyTier !== "byok") {
      const lookup = input.lookup ?? fetchOpenRouterGenerationCost;
      const found = await lookup(requestId, officialKeysFor(input.apiKeyTier));
      if (found) {
        costUsd = found.costUsd;
        promptTokens = found.promptTokens;
        completionTokens = found.completionTokens;
      }
    }

    const measurement: "provider" | "estimated" = costUsd !== undefined ? "provider" : "estimated";
    if (measurement === "estimated") {
      promptTokens = estimateTokensFromChars(input.promptChars);
      completionTokens = estimateTokensFromChars(input.outputChars);
    }

    await recordUsageLog({
      id: usageLogId,
      userId: input.userId,
      sessionId: input.sessionId,
      analyticsWorldId: input.worldId ?? null,
      model: input.model,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      endpoint: input.endpoint,
      apiKeyTier: input.apiKeyTier,
      generationTimeMs: input.generationTimeMs,
      providerCostUsd: costUsd !== undefined ? costUsd.toFixed(12) : null,
      providerRequestId: requestId?.slice(0, 200) || null,
      tokenMeasurement: measurement,
    });

    let creditsCharged = 0;
    if (input.chargeable && costUsd !== undefined && costUsd > 0) {
      const credits = await calculateCost(input.model, promptTokens, completionTokens, { providerCostUsd: costUsd });
      if (credits > 0) {
        await deductCredits(
          input.userId,
          credits,
          usageLogId,
          `${input.model} — ${promptTokens + completionTokens} tokens (stopped)`,
        );
        creditsCharged = credits;
        await flagWrite(input.userId).catch(() => {});
      }
    }
    return { usageLogId, costUsd: costUsd ?? null, creditsCharged, measurement };
  } catch (err) {
    captureServerError("stopped-generation", err, {
      userId: input.userId,
      sessionId: input.sessionId,
      endpoint: input.endpoint,
      model: input.model,
      providerRequestId: input.providerRequestId ?? null,
    });
    console.error("[StoppedGeneration] settle failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
