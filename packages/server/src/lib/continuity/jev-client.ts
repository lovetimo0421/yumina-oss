/**
 * Decision-model client for the continuity judge.
 *
 * Speaks the typed-question protocol (state + questions → answers with
 * probabilities). Default transport is OpenRouter's decisions endpoint with
 * the platform key, so no separate vendor account is needed; the official
 * TypeSafe endpoint uses the same request shape and is one env var away.
 *
 * A player in OpenRouter BYOK mode is asked on their own key first (only
 * when the endpoint is OpenRouter's). A fast failure on it — rejected, no
 * access to the alpha endpoint, out of balance — retries on the platform key
 * inside the same deadline; a timeout is just a timeout (the caller skips).
 */
import type { JevAnswer, JevQuestion } from "@yumina/engine";
import { env } from "../env.js";
import {
  isKeyRefusalStatus,
  isOpenRouterUrl,
  markPlayerKeyDenied,
  playerKeyDenied,
  type PlayerSideKey,
  type SideCallKeySource,
} from "../side-call-key.js";

export interface DecisionRequest {
  state: Record<string, unknown>;
  questions: Record<string, JevQuestion>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** The player's own OpenRouter key (OpenRouter BYOK mode only). */
  playerKey?: PlayerSideKey | null;
}

export interface DecisionResponse {
  answers: Record<string, JevAnswer | undefined>;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  ms: number;
  /** Whose key paid: usage_logs tier "byok" vs platform free-by-design. */
  keySource: SideCallKeySource;
  /** Set when the player's key was tried and failed (the error code). */
  byokFallback?: string;
}

export class DecisionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "DecisionError";
  }
}

export const DEFAULT_DECISION_URL = "https://openrouter.ai/api/alpha/decisions";
export const DEFAULT_DECISION_MODEL = "typesafe/jev-1.13";

export function decisionModelConfigured(): boolean {
  return Boolean(env.CONTINUITY_JEV_KEY || env.YUMINA_OPENROUTER_KEY);
}

function errorCodeFor(status: number): string {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream";
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "insufficient_balance";
  if (status === 404) return "not_found";
  return "bad_request";
}

class HttpDecisionError extends DecisionError {
  constructor(code: string, message: string, public readonly status: number) {
    super(code, message);
  }
}

export async function decide(req: DecisionRequest): Promise<DecisionResponse> {
  if (req.signal?.aborted) throw new DecisionError("cancelled", "continuity: turn cancelled");
  const platformKey = env.CONTINUITY_JEV_KEY || env.YUMINA_OPENROUTER_KEY;
  const url = env.CONTINUITY_JEV_URL || DEFAULT_DECISION_URL;
  const model = env.CONTINUITY_JEV_MODEL || DEFAULT_DECISION_MODEL;
  // Never send a player's key anywhere but OpenRouter.
  const player = req.playerKey && req.playerKey.apiKey && isOpenRouterUrl(url) && !playerKeyDenied(req.playerKey, "decisions")
    ? req.playerKey : null;
  if (!platformKey && !player) throw new DecisionError("no_key", "continuity: no decision-model key configured");
  const controller = new AbortController();
  const onAbort = () => controller.abort(req.signal?.reason);
  req.signal?.addEventListener("abort", onAbort, { once: true });
  // One deadline for both attempts: a fallback never makes the turn wait longer.
  const timer = setTimeout(() => controller.abort(new DecisionError("timeout", "continuity: decision timed out")), req.timeoutMs ?? 1500);
  const t0 = Date.now();

  const ask = async (key: string): Promise<Omit<DecisionResponse, "keySource" | "byokFallback">> => {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, state: req.state, questions: req.questions }),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* handled below */ }
    if (!res.ok || json.error) {
      const status = res.ok ? 400 : res.status;
      throw new HttpDecisionError(errorCodeFor(status), `continuity: decision endpoint ${res.status}: ${text.slice(0, 200)}`, status);
    }
    const answers = (json.answers && typeof json.answers === "object" ? json.answers : {}) as Record<string, JevAnswer | undefined>;
    const usage = (json.usage ?? {}) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    return {
      answers,
      usage: { inputTokens: num(usage.input_tokens ?? usage.prompt_tokens), outputTokens: num(usage.output_tokens ?? usage.completion_tokens) },
      model: typeof json.model === "string" ? json.model : model,
      ms: Date.now() - t0,
    };
  };

  const normalize = (err: unknown): DecisionError => {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      return reason instanceof DecisionError ? reason : new DecisionError("cancelled", "continuity: turn cancelled");
    }
    if (err instanceof DecisionError) return err;
    return new DecisionError("network", `continuity: ${err instanceof Error ? err.message : String(err)}`);
  };

  try {
    let byokFallback: string | undefined;
    if (player) {
      try {
        return { ...(await ask(player.apiKey)), keySource: "byok" };
      } catch (err) {
        const e = normalize(err);
        // Out of time (or the turn was cancelled): skip, as on the platform key.
        if (e.code === "timeout" || e.code === "cancelled") throw e;
        if (err instanceof HttpDecisionError && isKeyRefusalStatus(err.status)) markPlayerKeyDenied(player, "decisions");
        byokFallback = e.code;
        console.warn(`[Jev] player key failed (${e.code}); using the platform key for this call`);
        if (!platformKey) throw e;
      }
    }
    return { ...(await ask(platformKey)), keySource: "platform", ...(byokFallback ? { byokFallback } : {}) };
  } catch (err) {
    throw normalize(err);
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", onAbort);
  }
}
