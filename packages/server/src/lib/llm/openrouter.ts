import type { LLMProvider, GenerateParams, StreamChunk, Model, ChatMessage, ToolCall } from "./types.js";
import { LLM_CONNECTION_TIMEOUT_MS, LLM_REQUEST_TIMEOUT_MS, LLM_STREAM_INACTIVITY_TIMEOUT_MS } from "./constants.js";
import { clampTemperatureForModel, clampTopKForModel, repetitionPenaltyForModel } from "./sampling-limits.js";
import { parseClaudeVersion } from "./anthropic-thinking.js";
import { normalizeProviderCostUsd } from "../provider-cost.js";
import { OPENROUTER_APP_HEADERS } from "./openrouter-attribution.js";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

/** OpenRouter's built-in context-compression plugin. Guarantees the request
 *  fits the *routed endpoint's* real context window: if our own history trim
 *  still leaves the prompt over the limit (tokenizer-estimate drift, or an
 *  endpoint with a smaller window than the model's advertised max), OpenRouter
 *  drops the least-attended middle messages to fit instead of returning the
 *  400 "maximum context length is 163840 … you requested 236054". It is
 *  default-on only for ≤8K endpoints, so we opt in explicitly for all models.
 *  This is OpenRouter's own answer to the overflow and needs no hardcoded
 *  per-model window from us. (DeepSeek 163840 overflow investigation 2026-06-05.)
 *
 *  Applied ONLY to tool-free (chat) requests. Compression drops middle messages;
 *  on a tool-using request (the Studio agent) that could split a tool_call from
 *  its tool result and make the message sequence invalid. The agent has its own
 *  context trimming (getContextBudget) and never overflows, so it doesn't need
 *  this anyway. */
const CONTEXT_COMPRESSION_PLUGIN = [{ id: "context-compression" }];

const GEMINI_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" },
];

const PROVIDER_TERMS_MESSAGE =
  "The selected upstream provider rejected this request under its Terms of Service. Try another model or revise the request.";

export function kimiRepetitionSamplingParam(params: GenerateParams): Record<string, number> {
  const repetitionPenalty = repetitionPenaltyForModel(params.model, params.repetitionPenalty);
  return repetitionPenalty === undefined ? {} : { repetition_penalty: repetitionPenalty };
}
function isGeminiModel(model: string): boolean {
  return model.startsWith("google/");
}

function isClaudeModel(model: string): boolean {
  return model.startsWith("anthropic/");
}

/** Legacy Claude 3 SKUs (claude-3-haiku, claude-3-opus, claude-3-sonnet) are
 *  retired on api.anthropic.com and only available via Bedrock/Vertex AI on
 *  OpenRouter. Bedrock 400s with `system.N.cache_control: Extra inputs are not
 *  permitted` for these older SKUs, so we skip the annotation entirely. Matches
 *  the legacy prefixes only — does NOT match claude-3.5-*, claude-3-5-*, or
 *  the newer claude-{tier}-X.Y naming, all of which DO support caching. */
function isLegacyClaude3(model: string): boolean {
  return /^anthropic\/claude-3-(haiku|opus|sonnet)(-\d{8})?$/.test(model);
}

/** Token headroom to add on top of the caller's requested `maxTokens` when a
 *  reasoning/thinking budget is active. Most upstreams (DeepSeek V4 Flash/Pro,
 *  Gemini 2.5 thinking, OpenAI o-series) count reasoning_tokens as part of
 *  completion_tokens — sharing the same max_tokens budget. Without headroom,
 *  `reasoningEffort: "high"` on DeepSeek V4 routinely burns the entire
 *  user-visible budget on `reasoning_content`, leaving `content` empty
 *  (see 2026-05-16 investigation: 6.23% empty-response rate on v4-flash).
 *
 *  Headroom values are conservative upper bounds — models that finish
 *  reasoning earlier simply don't use the extra space. Caller-supplied
 *  `maxTokens` therefore represents the *visible output* the user expects. */
function reasoningHeadroom(effort: string | undefined): number {
  switch (effort) {
    case "minimal": return 1024;
    case "low": return 4096;
    case "medium": return 12288;
    case "high": return 32768;
    case "xhigh": return 65536;
    default: return 0; // unrecognized / undefined / "none" → no headroom
  }
}

/** Hard cap on the effective `max_tokens` we send upstream. Most models accept
 *  64K-128K output; capping at 64K keeps us inside outlier providers with tighter
 *  limits without measurably hurting reasoning headroom. */
const MAX_EFFECTIVE_OUTPUT_TOKENS = 65536;

/** Combine user-visible maxTokens with reasoning headroom, applying the hard cap. */
export function effectiveMaxTokens(userMax: number | undefined, effort: string | undefined): number {
  const base = userMax ?? 4096;
  const headroom = effort && effort !== "none" ? reasoningHeadroom(effort) : 0;
  return Math.min(base + headroom, MAX_EFFECTIVE_OUTPUT_TOKENS);
}

/** Amazon Bedrock returns HTTP 400 "did not allow prompt caching" when it
 *  receives `cache_control` for non-Claude models. Other upstreams (Moonshot,
 *  DeepSeek, Google AI Studio, xAI, etc.) either honor the hint or ignore it,
 *  and even when they only auto-cache, OpenRouter's own cache layer benefits
 *  from the explicit breakpoint signal. So: keep sending `cache_control`
 *  everywhere (Gemini docs explicitly recommend it: "cache_control inside the
 *  first system or developer message can cache the normalized system prompt"),
 *  but for non-Claude models we steer routing away from Bedrock so the
 *  breakpoint never reaches a provider that errors on it. Claude on Bedrock
 *  DOES support `cache_control`, so we don't ignore Bedrock there. */
const BEDROCK_SLUG = "amazon-bedrock";
function shouldIgnoreBedrockForCaching(model: string): boolean {
  return !isClaudeModel(model);
}

/** Modern Claude (Opus 4.7, Sonnet 4.6, Haiku 4.5) is multi-homed on OpenRouter
 *  across Anthropic (first-party), Amazon Bedrock, and Google Vertex. We pin the
 *  first-party Anthropic route as the preference — `allow_fallbacks: true` keeps
 *  resilience if it is briefly unavailable — for three reasons:
 *    1. Correctness: the `google-vertex/europe` deployment intermittently 400s with
 *       "Location in request path (europe-west1) does not match multi-region
 *       endpoint location (eu)". Because that is a 4xx, OpenRouter does NOT fail it
 *       over (only 5xx/timeouts trigger provider fallback), so it surfaces as a hard
 *       error to the user. Confirmed in prod on Opus 4.7 (2026-05-27).
 *    2. Reliability: Bedrock's Opus 4.7 endpoints have run at 43–58% 1-day uptime;
 *       first-party Anthropic sits at ~99.9%.
 *    3. Caching: we send explicit 1h cache_control breakpoints — first-party
 *       Anthropic honors them most consistently, maximizing prompt-cache hits.
 *  Legacy Claude 3 SKUs are excluded — they are retired on api.anthropic.com and
 *  only served via Bedrock/Vertex on OpenRouter (see isLegacyClaude3), so pinning
 *  the "anthropic" provider would force a fallback anyway. */
const CLAUDE_PROVIDER_ROUTING = { order: ["anthropic"], allow_fallbacks: true };
function shouldPinAnthropicFirstParty(model: string): boolean {
  return isClaudeModel(model) && !isLegacyClaude3(model);
}

/** Gemini is multi-homed on OpenRouter across Google Vertex and Google AI
 *  Studio at identical pricing. AI Studio is the consistently healthier half
 *  (99%+ 30-min uptime across Gemini SKUs vs 90–97% on Vertex, 2026-07-10
 *  endpoint data), and Vertex is where provider incidents keep landing
 *  (Vertex-EU Claude 400s 2026-05-27; llmixer Vertex 404s 2026-07-09). Prefer
 *  AI Studio; `allow_fallbacks: true` keeps resilience if it blips. */
const GEMINI_PROVIDER_ORDER = ["google-ai-studio"];
const GOOGLE_VERTEX_SLUG = "google-vertex";

/** Model slugs whose Google Vertex endpoint is currently broken on OpenRouter.
 * Keep this empty when there is no active incident; entries hard-ban Vertex
 * even when OpenRouter's normal provider fallback is enabled. */
const VERTEX_BROKEN_MODELS = new Set<string>();

/** Build the `provider` routing preferences for one request attempt, merging
 *  the static per-model rules (Claude first-party pin, Bedrock cache_control
 *  avoidance, Gemini AI-Studio preference) with dynamic exclusions collected
 *  by the retry loop from previous failed attempts. Returns undefined when
 *  there is nothing to send. Exported for tests. */
export function providerRoutingFor(
  model: string,
  hasCacheBreakpoints: boolean,
  excludeProviders?: readonly string[],
  preserveAccountRouting = false,
): Record<string, unknown> | undefined {
  // A user-owned OpenRouter key may have BYOK providers (for example Vertex AI)
  // configured on the OpenRouter account. Any request-level provider object
  // overrides that account routing, so BYOK requests must omit it entirely.
  if (preserveAccountRouting) return undefined;

  const ignore = new Set<string>(excludeProviders);
  let order: string[] | undefined;

  if (shouldPinAnthropicFirstParty(model)) {
    order = CLAUDE_PROVIDER_ROUTING.order;
  } else {
    if (hasCacheBreakpoints && shouldIgnoreBedrockForCaching(model)) ignore.add(BEDROCK_SLUG);
    if (isGeminiModel(model)) {
      order = GEMINI_PROVIDER_ORDER;
      if (VERTEX_BROKEN_MODELS.has(model)) ignore.add(GOOGLE_VERTEX_SLUG);
    }
  }

  if (!order && ignore.size === 0) return undefined;
  return {
    ...(order && { order, allow_fallbacks: true }),
    ...(ignore.size > 0 && { ignore: [...ignore] }),
  };
}

/** Map an OpenRouter provider identifier (routing slug, endpoint tag like
 *  "google-vertex/global", or display name like "Google AI Studio") to the
 *  slug accepted by `provider.ignore`. Returns undefined for anything that
 *  doesn't look like a valid slug — the caller then skips the dynamic
 *  exclusion rather than risk sending garbage routing preferences. */
const PROVIDER_NAME_TO_SLUG: Record<string, string> = {
  // "Google" is the display name of the Vertex storefront; AI Studio spells
  // itself out. Only names that don't normalize 1:1 to their slug need a row.
  google: "google-vertex",
};
export function normalizeProviderSlug(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  const base = raw.split("/")[0]!.trim().toLowerCase().replace(/\s+/g, "-");
  const slug = PROVIDER_NAME_TO_SLUG[base] ?? base;
  return /^[a-z0-9][a-z0-9.-]*$/.test(slug) ? slug : undefined;
}

/** Best-effort extraction of the provider that failed a request, from the
 *  `openrouter_metadata` object attached when the X-OpenRouter-Metadata
 *  header is enabled (`attempts[]` carries one entry per provider tried with
 *  its HTTP status; `endpoints.available[]` marks the selected storefront).
 *  The field names are not contractual — parse defensively and return
 *  undefined when unsure; the retry loop then falls back to a plain retry.
 *  Exported for tests. */
export function extractFailedProviderSlug(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const meta = (payload as Record<string, unknown>).openrouter_metadata;
  if (!meta || typeof meta !== "object") return undefined;
  const m = meta as Record<string, unknown>;

  const slugFrom = (entry: unknown): string | undefined => {
    if (!entry || typeof entry !== "object") return undefined;
    const rec = entry as Record<string, unknown>;
    return (
      normalizeProviderSlug(rec.provider_slug) ??
      normalizeProviderSlug(rec.provider) ??
      normalizeProviderSlug(rec.provider_name) ??
      normalizeProviderSlug(rec.tag) ??
      normalizeProviderSlug(rec.endpoint)
    );
  };

  // attempts[]: one entry per provider tried — the last one is the failure
  // that ended the request.
  const attempts = Array.isArray(m.attempts) ? m.attempts : [];
  for (let i = attempts.length - 1; i >= 0; i--) {
    const slug = slugFrom(attempts[i]);
    if (slug) return slug;
  }

  // endpoints.available[] with selected:true — the storefront that took the
  // request when no attempts array is present.
  const endpoints = (m.endpoints as Record<string, unknown> | undefined)?.available;
  if (Array.isArray(endpoints)) {
    for (const e of endpoints) {
      if (e && typeof e === "object" && (e as Record<string, unknown>).selected) {
        const slug = slugFrom(e);
        if (slug) return slug;
      }
    }
  }
  return undefined;
}

/** Which upstream provider actually served a SUCCESSFUL response.
 *
 *  Needed because a turn can come back HTTP 200 and still be worthless: the
 *  DeepSeek V4 endpoints return `done` with ~1 completion token in ~6s at a
 *  14% rate on v4-flash / 6% on v4-pro, against <=0.9% for every other model
 *  on the platform (prod, 2026-09-02). That path yields no error chunk, so the
 *  provider-exclusion machinery added for 4xx failures never fired and all
 *  three attempts could re-roll the same dead endpoint.
 *
 *  Two sources, both best-effort:
 *   - `provider`, OpenRouter's non-standard top-level field on chat completions
 *     and on each SSE chunk (a display name like "DeepInfra").
 *   - `openrouter_metadata` (we send X-OpenRouter-Metadata: enabled). On a
 *     SUCCESS payload the last `attempts[]` entry / the selected endpoint is
 *     the provider that served us, which is exactly what we want here — so the
 *     same walk as extractFailedProviderSlug applies, only the meaning of the
 *     answer differs. Reused rather than duplicated.
 *
 *  Returns undefined when nothing parses; callers then behave as before. */
export function extractServedProviderSlug(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const direct = normalizeProviderSlug((payload as Record<string, unknown>).provider);
  if (direct) return direct;
  return extractFailedProviderSlug(payload);
}

/** Parse a (possibly JSON) error payload and log + extract the failing
 *  provider. `source` labels the log line so prod logs teach us the real
 *  metadata shape across error modes. */
function failedProviderFromPayload(payload: unknown, model: string, source: string): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const meta = (payload as Record<string, unknown>).openrouter_metadata;
  if (meta && typeof meta === "object") {
    // One line: what was asked, what OpenRouter says about it, which attempt.
    // The full endpoint list (600 chars per failure on the free pool) drowned
    // the log without ever being read.
    const m = meta as Record<string, unknown>;
    const endpoints = m.endpoints as { total?: number; available?: unknown[] } | undefined;
    console.warn(
      `[OpenRouter] ${source} error for ${model}: ${String(m.summary ?? "")}` +
      ` attempt=${String(m.attempt ?? "?")} region=${String(m.region ?? "?")}` +
      (endpoints ? ` endpoints=${endpoints.available?.length ?? "?"}/${endpoints.total ?? "?"}` : ""),
    );
  }
  return extractFailedProviderSlug(payload);
}

function isProviderTermsError(status: number, body: string): boolean {
  return status === 403 && /provider terms of service|provider tos|terms of service/i.test(body);
}

/** OpenRouter's account-wide daily cap on the free-models pool, which backs
 *  `openrouter/free` (Yumina Free). Observed in prod as:
 *    429 "Rate limit exceeded: free-models-per-day-high-balance."
 *  The cap is per-ACCOUNT, not per-user, so once it trips every free player is
 *  locked out for the rest of the UTC day — retrying the same model can never
 *  succeed. Falling back to a paid-but-near-free model keeps them playing;
 *  see FREE_ROUTER_FALLBACK_MODEL in routes/messages.ts for who eats the cost. */
export function isFreePoolExhaustedError(status: number, body: string): boolean {
  return status === 429 && /free-models-per-day/i.test(body);
}

/** OpenRouter retires model ids without notice: the model page survives but
 *  every provider endpoint disappears, and the id starts 404ing. Seen 2026-08-25
 *  on inclusionai/ling-2.6-flash, then the first rung of the free chain — it
 *  lost its sole provider (Novita) and every exhausted-pool free turn died with
 *  "Ling-2.6-flash is no longer available as a free model" instead of descending
 *  to the healthy second rung, which made the rung below it dead weight.
 *
 *  Matched on status alone. OpenRouter words this several ways ("no endpoints
 *  found", "no longer available as a free model", "not a valid model ID") and
 *  the only cost of a false positive is one extra call on the next model, so
 *  there is nothing to gain by parsing the sentence. */
export function isModelUnavailableError(status: number): boolean {
  return status === 404;
}

/** Deterministic refusals — re-sending the same model is guaranteed to fail
 *  again, so switching models is the only thing that can help. Plus, for chains
 *  that opt in, transient upstream failures (see fallbackOnTransientErrors). */
export function shouldFallbackToAnotherModel(
  status: number,
  body: string,
  allowTransient: boolean | undefined,
): boolean {
  if (isProviderTermsError(status, body)) return true;
  if (isFreePoolExhaustedError(status, body)) return true;
  if (isModelUnavailableError(status)) return true;
  return Boolean(allowTransient) && (status === 429 || status >= 500);
}

/** A stable reason for the consent UI, without exposing the upstream payload. */
export function modelFallbackReason(status: number, body: string): StreamChunk["fallbackReason"] {
  if (isProviderTermsError(status, body)) return "policy";
  if (isModelUnavailableError(status)) return "unavailable";
  if (status === 429 || status >= 500) return "capacity";
  return undefined;
}

/** Names the reason in the fallback log line — prod logs are how we tell an
 *  exhausted free pool (expected, daily) from a ToS rejection (rare, per-model)
 *  from a throttled fallback model (capacity, needs a bigger chain). */
function fallbackReasonLabel(status: number, body: string): string {
  if (isFreePoolExhaustedError(status, body)) return "Free pool exhausted";
  if (isProviderTermsError(status, body)) return "Provider ToS rejection";
  if (isModelUnavailableError(status)) return "Model unavailable upstream (404 — retired id?)";
  return `Transient upstream failure (${status})`;
}

function nextFallbackModel(params: GenerateParams): string | null {
  const fallback = params.fallbackModels?.find((candidate) => candidate && candidate !== params.model);
  return fallback ?? null;
}

function remainingFallbackModels(params: GenerateParams, usedFallback: string): string[] | undefined {
  const remaining = params.fallbackModels?.filter(
    (candidate) => candidate && candidate !== params.model && candidate !== usedFallback,
  );
  return remaining && remaining.length > 0 ? remaining : undefined;
}

/** OpenRouter collapses every upstream rejection into the opaque
 *  `"Provider returned error"` and parks the real reason in
 *  `error.metadata.raw` (a JSON string, an object, or plain text) alongside the
 *  storefront in `error.metadata.provider_name`. Surfacing only the wrapper
 *  teaches nobody anything: the Claude 5 400s reported on 2026-07-30 landed in
 *  PostHog as "OpenRouter error (400): Provider returned error", which named
 *  neither the provider nor the cause and cost a full prod investigation.
 *  Returns "<provider>: <upstream message>" when we can dig it out. */
export function upstreamErrorDetail(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const err = (payload as Record<string, unknown>).error;
  if (!err || typeof err !== "object") return undefined;
  const meta = (err as Record<string, unknown>).metadata;
  if (!meta || typeof meta !== "object") return undefined;
  const m = meta as Record<string, unknown>;

  const provider = typeof m.provider_name === "string" && m.provider_name ? m.provider_name : undefined;
  const message = rawUpstreamMessage(m.raw);
  if (!message) return provider ? `upstream provider ${provider}` : undefined;
  return provider ? `${provider}: ${message}` : message;
}

/** `metadata.raw` is whatever the upstream returned — Anthropic sends
 *  `{"type":"error","error":{"message":…}}`, Bedrock sends `{"message":…}`,
 *  others send bare text. Peel each shape down to a human sentence. */
function rawUpstreamMessage(raw: unknown): string | undefined {
  if (raw && typeof raw === "object") return pickMessage(raw);
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    return pickMessage(JSON.parse(trimmed)) ?? trimmed.slice(0, 300);
  } catch {
    return trimmed.slice(0, 300);
  }
}

function pickMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.message === "string" && obj.message) return obj.message;
  const nested = obj.error;
  if (nested && typeof nested === "object") {
    const inner = (nested as Record<string, unknown>).message;
    if (typeof inner === "string" && inner) return inner;
  }
  return undefined;
}

/** OpenRouter's own wrapper text carries no information once we have the
 *  upstream detail — replace it rather than printing both. */
const GENERIC_WRAPPER = /^(provider returned error|internal server error)\.?$/i;

/** Single formatter for every OpenRouter failure shape (HTTP status, SSE
 *  mid-stream `error`, and 200-with-error-body), so all three surface the
 *  upstream cause identically. */
export function composeOpenRouterError(
  code: number | string,
  message: string | undefined,
  detail: string | undefined,
): string {
  const head = message?.trim() || "unknown upstream error";
  let body = head;
  if (detail && !head.includes(detail)) {
    body = GENERIC_WRAPPER.test(head) ? detail : `${head} — ${detail}`;
  }
  return `OpenRouter error (${code}): ${body}`;
}

function formatOpenRouterError(status: number, body: string): string {
  if (isProviderTermsError(status, body)) return PROVIDER_TERMS_MESSAGE;

  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    const message = parsed.error?.message;
    const detail = upstreamErrorDetail(parsed);
    if (message || detail) return composeOpenRouterError(status, message, detail);
  } catch {
    // Fall back to a trimmed text body.
  }

  const trimmed = body.trim();
  return trimmed ? `OpenRouter error (${status}): ${trimmed.slice(0, 500)}` : `OpenRouter error (${status})`;
}

/** Compact, content-free description of the request we sent, logged whenever
 *  OpenRouter rejects it. Names the message role sequence, the cache-breakpoint
 *  count and every top-level parameter — enough to tell an upstream schema
 *  rejection apart from a routing failure without ever logging prompt text. */
function requestSignature(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
  const roles = messages.map((m) => String(m.role ?? "?")[0]).join("");
  const cached = messages.filter(
    (m) => Array.isArray(m.content) && (m.content as Record<string, unknown>[]).some((p) => p?.cache_control),
  ).length;
  const params = Object.keys(body).filter((k) => k !== "messages" && k !== "tools").join(",");
  const effort = (body.reasoning as { effort?: string } | undefined)?.effort ?? "none";
  return (
    `msgs=${messages.length} roles=${roles} cacheBlocks=${cached} ` +
    `max_tokens=${body.max_tokens} effort=${effort} params=[${params}]`
  );
}

export class OpenRouterProvider implements LLMProvider {
  private apiKey: string;
  private preserveAccountRouting: boolean;

  constructor(apiKey: string, options?: { preserveAccountRouting?: boolean }) {
    this.apiKey = apiKey;
    this.preserveAccountRouting = options?.preserveAccountRouting ?? false;
  }

  /**
   * Public streaming entry. Wraps `streamOnce` with one retry when the upstream
   * yields an error before any user-visible content (text or tool call) was
   * emitted. Gemini SAFETY / content_filter / RECITATION outcomes are non-
   * deterministic and frequently pass on a fresh attempt; retrying here is
   * transparent to the caller and avoids users seeing a "卡住" experience.
   *
   * Reasoning chunks do not count as user-visible — a thinking model that
   * reasons then trips a filter still retries.
   */
  async *generateStream(params: GenerateParams): AsyncIterable<StreamChunk> {
    // 2 retries (3 attempts): post-retry residual was still ~3.6k user-visible
    // "Generation stopped unexpectedly" errors per 14d (2026-07-06 triage),
    // almost all transient Gemini upstream failures that pass on a fresh
    // attempt. Retries only fire before any visible output, so the extra
    // attempt costs latency on doomed turns, never duplicated content.
    const MAX_RETRIES = params.singleAttempt ? 0 : 2;
    let lastError: StreamChunk | null = null;
    let lastDone: StreamChunk | null = null;
    // Providers identified as the failure source on earlier attempts. Excluded
    // from routing on subsequent attempts so the retry doesn't re-roll the same
    // broken upstream (OpenRouter does not fail 4xx over on its own — the
    // llmixer Vertex 404s of 2026-07-09 surfaced to users through 3 attempts).
    const failedProviders: string[] = [];

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (params.signal?.aborted) return;

      let visibleYielded = false;
      let errorChunk: StreamChunk | null = null;
      let doneChunk: StreamChunk | null = null;

      for await (const chunk of this.streamOnce(params, failedProviders)) {
        if (chunk.type === "error") {
          // Auth/credit failures and hard rate limits re-fail identically on an
          // immediate retry — surface them now instead of adding dead latency.
          const nonRetryable = /\((401|402|429)\)/.test(chunk.content);
          if (!visibleYielded && attempt < MAX_RETRIES && !nonRetryable) {
            errorChunk = chunk;
            break;
          }
          yield chunk;
          return;
        }
        // Buffer the terminal chunk so we can decide whether to retry an EMPTY
        // completion BEFORE the consumer finalizes and saves a blank reply.
        // Empty-reply investigation (2026-05-31): ~2.9% of sends (DeepSeek
        // reasoners worst) finish "successfully" with no visible text.
        if (chunk.type === "done") {
          doneChunk = chunk;
          break;
        }
        if (
          chunk.type === "text" ||
          chunk.type === "tool_call_start" ||
          chunk.type === "tool_call_delta" ||
          chunk.type === "tool_call_end"
        ) {
          visibleYielded = true;
        }
        yield chunk;
      }

      // Early upstream error before any visible output — retry, excluding the
      // provider that failed when we could identify it.
      if (errorChunk) {
        lastError = errorChunk;
        const slug = errorChunk.failedProviderSlug;
        if (slug && !failedProviders.includes(slug) && failedProviders.length < 3) {
          failedProviders.push(slug);
          console.warn(`[OpenRouter] Excluding failed provider "${slug}" on retry for ${params.model}`);
        }
        console.warn(
          `[OpenRouter] Early upstream error on attempt ${attempt + 1}/${MAX_RETRIES + 1}, retrying: ${errorChunk.content}`,
        );
        continue;
      }

      // Completed via `done`. If the model produced NO visible text or tool
      // calls (burned the turn on hidden reasoning, or returned nothing),
      // retry once — manual regenerate recovers ~87% of these, so a silent
      // retry fixes most before the user ever sees a blank. Reasoning chunks
      // already streamed are harmless to repeat; the consumer only accumulates
      // `text`, so the retry's content wins cleanly.
      if (doneChunk && !visibleYielded && attempt < MAX_RETRIES && !params.signal?.aborted) {
        lastDone = doneChunk;
        // An empty turn is a provider failure dressed as success: HTTP 200, a
        // `done` chunk, no error to parse. Until now the retry re-rolled with
        // the same routing and could land on the same dead endpoint all three
        // times — which is how deepseek-v4-flash reached a 14% empty rate on
        // the platform key while the same model on a user's own key sat at
        // 0.11% (prod, 2026-09-02). Exclude the provider that just served us,
        // same as the error path. Best-effort: when it can't be identified the
        // retry is exactly the plain retry it has always been.
        const slug = doneChunk.servedProviderSlug;
        if (slug && !failedProviders.includes(slug) && failedProviders.length < 3) {
          failedProviders.push(slug);
        }
        console.warn(
          `[OpenRouter] Empty completion (no visible output) on attempt ${attempt + 1}/${MAX_RETRIES + 1}` +
            `${slug ? `, excluding provider "${slug}"` : " (provider unidentified)"}, retrying.`,
        );
        continue;
      }

      // Have visible content, or retries exhausted — emit the terminal chunk.
      if (doneChunk) {
        yield doneChunk;
        return;
      }
      // streamOnce ended without a terminal chunk (shouldn't happen).
      return;
    }

    // Retries exhausted. Surface the last error if any; otherwise emit the last
    // (still-empty) done so the consumer can finalize — the server-side empty
    // guard turns that into a clear "try again" instead of a blank bubble.
    if (lastError) { yield lastError; return; }
    if (lastDone) { yield lastDone; return; }
  }

  /** Single-attempt streaming pass — see `generateStream` for the retry wrapper.
   *  `excludeProviders` carries routing slugs of providers that already failed
   *  earlier attempts of this same request. */
  private async *streamOnce(params: GenerateParams, excludeProviders?: readonly string[]): AsyncIterable<StreamChunk> {
    // Non-streaming branch: user explicitly disabled streaming (e.g. to bypass
    // filters on upstream proxies that moderate stream chunks differently).
    // Delegates to generateNonStream which yields equivalent StreamChunk events
    // all at once after the LLM finishes.
    if (params.stream === false) {
      yield* this.generateNonStream(params, excludeProviders);
      return;
    }

    const serialized = normalizeSystemPlacement(
      avoidClaudePrefill(params.messages.map(serializeMessage), params.model),
      params.model,
    );

    // Apply explicit cache breakpoints for supported providers
    if (params.cacheBreakpoints?.length) {
      applyCacheBreakpoints(serialized, params.model, params.cacheBreakpoints);
    }

    // 60-second timeout for the initial connection only.
    // Cleared as soon as fetch() returns (headers received) so long streaming
    // responses are never cut off — only truly hung connections are aborted.
    const connAbort = new AbortController();
    const connTimer = setTimeout(() => connAbort.abort(new Error("Connection timeout")), LLM_CONNECTION_TIMEOUT_MS);
    const fetchSignal = params.signal
      ? AbortSignal.any([connAbort.signal, params.signal])
      : connAbort.signal;

    const providerRouting = providerRoutingFor(
      params.model,
      !!params.cacheBreakpoints?.length,
      excludeProviders,
      this.preserveAccountRouting,
    );

    const requestBody: Record<string, unknown> = {
        model: params.model,
        messages: serialized,
        max_tokens: effectiveMaxTokens(
          params.maxTokens,
          params.disableReasoning ? "none" : params.reasoningEffort,
        ),
        temperature: clampTemperatureForModel(params.model, params.temperature),
        stream: true,
        // Only on tool-free (chat) requests — see CONTEXT_COMPRESSION_PLUGIN note.
        ...(!(params.tools && params.tools.length) && { plugins: CONTEXT_COMPRESSION_PLUGIN }),
        ...(params.topP !== undefined && { top_p: params.topP }),
        ...(params.frequencyPenalty !== undefined && { frequency_penalty: params.frequencyPenalty }),
        ...(params.presencePenalty !== undefined && { presence_penalty: params.presencePenalty }),
        ...kimiRepetitionSamplingParam(params),
        ...(params.topK !== undefined && params.topK > 0 && { top_k: clampTopKForModel(params.model, params.topK) }),
        ...(params.minP !== undefined && params.minP > 0 && { min_p: params.minP }),
        ...(params.responseFormat && {
          response_format: { type: params.responseFormat.type },
        }),
        // Tool use parameters (with cache_control on last tool for Claude — caches all tool definitions)
        // 1-hour TTL: tool definitions are static within a session, worth the 2x write cost
        // to survive long user-approval gaps between iterations.
        ...(params.tools && params.tools.length > 0 && {
          tools: (isClaudeModel(params.model) && !isLegacyClaude3(params.model))
            ? annotateLast(params.tools, { cache_control: { type: "ephemeral", ttl: "1h" } })
            : params.tools,
        }),
        ...(params.toolChoice !== undefined && { tool_choice: params.toolChoice }),
        // Background summaries explicitly disable reasoning; ordinary turns
        // retain the existing semantics where a stored "none" means provider
        // default and an active effort opts into reasoning headroom.
        ...(params.disableReasoning
          ? { reasoning: { effort: "none" } }
          : params.reasoningEffort && params.reasoningEffort !== "none"
            ? { reasoning: { effort: params.reasoningEffort } }
            : {}),
        // Provider routing: Claude first-party pin, Bedrock cache_control
        // avoidance, Gemini AI-Studio preference, plus dynamic exclusion of
        // providers that failed earlier attempts (see providerRoutingFor).
        ...(providerRouting && { provider: providerRouting }),
        // Gemini: disable configurable safety filters
        ...(isGeminiModel(params.model) && { safety_settings: GEMINI_SAFETY_SETTINGS }),
    };

    const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...OPENROUTER_APP_HEADERS,
        // Attach routing metadata (attempts[], selected endpoint) to responses —
        // including error responses — so failures can name the provider that
        // caused them (see extractFailedProviderSlug).
        "X-OpenRouter-Metadata": "enabled",
      },
      signal: fetchSignal,
      body: JSON.stringify(requestBody),
    });

    clearTimeout(connTimer); // connection established — timer no longer needed

    if (!response.ok) {
      const error = await response.text();
      console.warn(
        `[OpenRouter] ${response.status} for ${params.model} — ${requestSignature(requestBody)}`,
      );
      const fallbackModel = shouldFallbackToAnotherModel(response.status, error, params.fallbackOnTransientErrors) ? nextFallbackModel(params) : null;
      if (fallbackModel) {
        console.warn(
          `[OpenRouter] ${fallbackReasonLabel(response.status, error)} for ${params.model}; retrying with fallback ${fallbackModel}`,
        );
        for await (const chunk of this.generateStream({
          ...params,
          model: fallbackModel,
          fallbackModels: remainingFallbackModels(params, fallbackModel),
        })) {
          yield { ...chunk, model: chunk.model ?? fallbackModel };
        }
        return;
      }
      let errorPayload: unknown;
      try { errorPayload = JSON.parse(error); } catch { /* non-JSON body */ }
      yield {
        type: "error",
        content: formatOpenRouterError(response.status, error),
        fallbackReason: modelFallbackReason(response.status, error),
        failedProviderSlug: failedProviderFromPayload(errorPayload, params.model, "http"),
      };
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      yield { type: "error", content: "No response body" };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    // Accumulate streaming tool call argument deltas
    const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();
    let lastFinishReason: string | null = null;
    // Who served this stream, latched from the first chunk that names it, so a
    // turn that ends empty can tell the retry loop which endpoint to skip.
    let servedProviderSlug: string | undefined;
    let observedRequestId: string | undefined;

    try {
      while (true) {
        if (params.signal?.aborted) return;

        // Race between reader and inactivity timeout
        let timeoutId: ReturnType<typeof setTimeout>;
        const timeoutPromise = new Promise<{ done: true; value: undefined; timedOut: true }>((resolve) => {
          timeoutId = setTimeout(() => resolve({ done: true, value: undefined, timedOut: true }), LLM_STREAM_INACTIVITY_TIMEOUT_MS);
        });

        const result = await Promise.race([
          reader.read().then((r) => { clearTimeout(timeoutId!); return { ...r, timedOut: false as const }; }),
          timeoutPromise,
        ]);

        if (result.timedOut) {
          console.warn(`[OpenRouter] Stream inactivity timeout after ${LLM_STREAM_INACTIVITY_TIMEOUT_MS}ms for model ${params.model}`);
          yield { type: "error", content: "Stream timed out — the model stopped responding. Try regenerating." };
          return;
        }

        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6);
          if (data === "[DONE]") {
            // Emit any accumulated tool calls before done
            yield* flushToolCalls(toolCallBuffers);
            yield {
              type: "done",
              content: "",
              servedProviderSlug,
              stopReason: lastFinishReason === "length" ? "max_tokens" : lastFinishReason ?? undefined,
            };
            return;
          }

          try {
            const parsed = JSON.parse(data);
            if (typeof parsed.id === "string") observedRequestId = parsed.id;

            // Latch once — OpenRouter repeats `provider` on every chunk.
            servedProviderSlug ??= extractServedProviderSlug(parsed);

            // Detect mid-stream errors from OpenRouter (arrives as SSE with HTTP 200)
            if (parsed.error) {
              yield {
                type: "error",
                content: composeOpenRouterError(
                  typeof parsed.error.code === "number" ? parsed.error.code : "stream",
                  parsed.error.message,
                  upstreamErrorDetail(parsed),
                ),
                failedProviderSlug: failedProviderFromPayload(parsed, params.model, "sse"),
                fallbackReason: modelFallbackReason(Number(parsed.error.code), JSON.stringify(parsed)),
              };
              return;
            }

            const choice = parsed.choices?.[0];
            const delta = choice?.delta;

            // Reasoning/thinking content (streamed before text for thinking models)
            if (delta?.reasoning_details) {
              for (const detail of delta.reasoning_details as Array<{ type: string; text?: string; summary?: string }>) {
                const reasoningText = detail.type === "reasoning.text" ? detail.text
                  : detail.type === "reasoning.summary" ? detail.summary
                  : null;
                if (reasoningText) {
                  yield { type: "reasoning", content: reasoningText };
                }
              }
            }

            // Text content
            if (delta?.content) {
              yield { type: "text", content: delta.content, providerRequestId: observedRequestId };
            }

            // Tool call deltas (OpenAI-compatible streaming format)
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls as Array<{
                index: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>) {
                const idx = tc.index;

                if (!toolCallBuffers.has(idx)) {
                  // New tool call starting
                  toolCallBuffers.set(idx, {
                    id: tc.id ?? "",
                    name: tc.function?.name ?? "",
                    args: tc.function?.arguments ?? "",
                  });
                  yield {
                    type: "tool_call_start",
                    content: "",
                    toolCallIndex: idx,
                    toolCallId: tc.id ?? "",
                    toolCallName: tc.function?.name ?? "",
                  };
                  // Emit initial args fragment if present (some models send data in the first chunk)
                  if (tc.function?.arguments) {
                    yield {
                      type: "tool_call_delta",
                      content: tc.function.arguments,
                      toolCallIndex: idx,
                    };
                  }
                } else {
                  // Accumulate argument fragments
                  const buf = toolCallBuffers.get(idx)!;
                  if (tc.id) buf.id = tc.id;
                  if (tc.function?.name) buf.name = tc.function.name;
                  const argChunk = tc.function?.arguments;
                  if (argChunk != null) {
                    buf.args += argChunk;
                    yield {
                      type: "tool_call_delta",
                      content: argChunk,
                      toolCallIndex: idx,
                    };
                  }
                }
              }
            }

            // Gemini/OpenRouter safety or content filter interrupted generation
            const fr = choice?.finish_reason;
            if (fr === "SAFETY" || fr === "content_filter") {
              yield {
                type: "error",
                content:
                  "Response blocked by safety/content filter. Try regenerating — the filter is non-deterministic and may pass on retry.",
              };
              return;
            }

            // Other non-standard termination reasons (Gemini: RECITATION, OTHER, etc.)
            if (fr && fr !== "stop" && fr !== "length" && fr !== "tool_calls") {
              console.warn(`[OpenRouter] Unexpected finish_reason "${fr}" for model ${params.model}`);
              yield {
                type: "error",
                content: `Generation stopped unexpectedly (reason: ${fr}) — ${params.model}'s provider failed upstream. Try regenerating, or switch models if it keeps happening.`,
              };
              return;
            }

            // finish_reason === "tool_calls" means all tool calls are complete
            if (fr === "tool_calls") {
              yield* flushToolCalls(toolCallBuffers);
            }

            // Track stop reason for truncation detection
            if (fr) lastFinishReason = fr;

            // Usage info comes in the final chunk
            if (parsed.usage) {
              // Log cache metrics when available (Anthropic prompt caching)
              const details = parsed.usage.prompt_tokens_details;
              if (details?.cached_tokens || details?.cache_write_tokens) {
                console.log(
                  `[OpenRouter] Cache: ${details.cached_tokens ?? 0} read, ${details.cache_write_tokens ?? 0} write, ${parsed.usage.prompt_tokens} total prompt tokens (model: ${params.model})`
                );
              }

              yield* flushToolCalls(toolCallBuffers);
              yield {
                type: "done",
                content: "",
                servedProviderSlug,
                // Map OpenAI "length" to Anthropic "max_tokens" for consistent handling
                stopReason: lastFinishReason === "length" ? "max_tokens" : lastFinishReason ?? undefined,
                usage: {
                  promptTokens: parsed.usage.prompt_tokens,
                  completionTokens: parsed.usage.completion_tokens,
                  totalTokens: parsed.usage.total_tokens,
                  reasoningTokens: parsed.usage.completion_tokens_details?.reasoning_tokens,
                  providerCostUsd: normalizeProviderCostUsd(parsed.usage.cost),
                  providerRequestId: observedRequestId,
                },
              };
              return;
            }
          } catch {
            // Skip unparseable lines
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }

    // Stream ended — flush any remaining tool calls
    yield* flushToolCalls(toolCallBuffers);
    yield { type: "done", content: "", servedProviderSlug };
  }

  /**
   * Non-streaming request path. Invoked when `params.stream === false`.
   * POSTs with `stream: false`, awaits the full JSON response, and yields
   * equivalent StreamChunk events so the caller's consumption loop doesn't
   * need to know the difference. All chunks arrive in a single burst after
   * the upstream finishes generating.
   *
   * Used to bypass filters on proxies/providers that moderate stream chunks
   * differently from full responses.
   */
  private async *generateNonStream(params: GenerateParams, excludeProviders?: readonly string[]): AsyncIterable<StreamChunk> {
    const serialized = normalizeSystemPlacement(
      avoidClaudePrefill(params.messages.map(serializeMessage), params.model),
      params.model,
    );
    if (params.cacheBreakpoints?.length) {
      applyCacheBreakpoints(serialized, params.model, params.cacheBreakpoints);
    }

    const providerRouting = providerRoutingFor(
      params.model,
      !!params.cacheBreakpoints?.length,
      excludeProviders,
      this.preserveAccountRouting,
    );

    // Non-streaming responses only send headers AFTER the upstream finishes
    // generating, so the timer covers the entire generation time (not just
    // connection). Thinking/reasoning models can take several minutes.
    const connAbort = new AbortController();
    const connTimer = setTimeout(() => connAbort.abort(new Error("Request timeout")), LLM_REQUEST_TIMEOUT_MS);
    const fetchSignal = params.signal
      ? AbortSignal.any([connAbort.signal, params.signal])
      : connAbort.signal;

    const requestBody: Record<string, unknown> = {
          model: params.model,
          messages: serialized,
          max_tokens: effectiveMaxTokens(
            params.maxTokens,
            params.disableReasoning ? "none" : params.reasoningEffort,
          ),
          temperature: clampTemperatureForModel(params.model, params.temperature),
          stream: false,
          // Only on tool-free (chat) requests — see CONTEXT_COMPRESSION_PLUGIN note.
          ...(!(params.tools && params.tools.length) && { plugins: CONTEXT_COMPRESSION_PLUGIN }),
          ...(params.topP !== undefined && { top_p: params.topP }),
          ...(params.frequencyPenalty !== undefined && { frequency_penalty: params.frequencyPenalty }),
          ...(params.presencePenalty !== undefined && { presence_penalty: params.presencePenalty }),
          ...kimiRepetitionSamplingParam(params),
          ...(params.topK !== undefined && params.topK > 0 && { top_k: clampTopKForModel(params.model, params.topK) }),
          ...(params.minP !== undefined && params.minP > 0 && { min_p: params.minP }),
          ...(params.responseFormat && { response_format: { type: params.responseFormat.type } }),
          ...(params.tools && params.tools.length > 0 && {
            tools: (isClaudeModel(params.model) && !isLegacyClaude3(params.model))
              ? annotateLast(params.tools, { cache_control: { type: "ephemeral", ttl: "1h" } })
              : params.tools,
          }),
          ...(params.toolChoice !== undefined && { tool_choice: params.toolChoice }),
          ...(params.disableReasoning
            ? { reasoning: { effort: "none" } }
            : params.reasoningEffort && params.reasoningEffort !== "none"
              ? { reasoning: { effort: params.reasoningEffort } }
              : {}),
          // Mirror the streaming path — see providerRoutingFor.
          ...(providerRouting && { provider: providerRouting }),
          ...(isGeminiModel(params.model) && { safety_settings: GEMINI_SAFETY_SETTINGS }),
    };

    let response: Response;
    try {
      response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...OPENROUTER_APP_HEADERS,
          // See streaming path — lets error responses name the failing provider.
          "X-OpenRouter-Metadata": "enabled",
        },
        signal: fetchSignal,
        body: JSON.stringify(requestBody),
      });
    } catch (err) {
      clearTimeout(connTimer);
      if (params.signal?.aborted) return;
      yield { type: "error", content: `OpenRouter request failed: ${(err as Error).message}` };
      return;
    }
    clearTimeout(connTimer);

    if (!response.ok) {
      const error = await response.text().catch(() => "");
      console.warn(
        `[OpenRouter] ${response.status} for ${params.model} (non-stream) — ${requestSignature(requestBody)}`,
      );
      const fallbackModel = shouldFallbackToAnotherModel(response.status, error, params.fallbackOnTransientErrors) ? nextFallbackModel(params) : null;
      if (fallbackModel) {
        console.warn(
          `[OpenRouter] ${fallbackReasonLabel(response.status, error)} for ${params.model}; retrying with fallback ${fallbackModel} (non-stream)`,
        );
        for await (const chunk of this.generateNonStream({
          ...params,
          model: fallbackModel,
          fallbackModels: remainingFallbackModels(params, fallbackModel),
        })) {
          yield { ...chunk, model: chunk.model ?? fallbackModel };
        }
        return;
      }
      let errorPayload: unknown;
      try { errorPayload = JSON.parse(error); } catch { /* non-JSON body */ }
      yield {
        type: "error",
        content: formatOpenRouterError(response.status, error),
        fallbackReason: modelFallbackReason(response.status, error),
        failedProviderSlug: failedProviderFromPayload(errorPayload, params.model, "http-nonstream"),
      };
      return;
    }

    let parsed: {
      id?: string;
      error?: { message?: string; code?: number | string };
      choices?: Array<{
        message?: {
          content?: string;
          reasoning?: string;
          reasoning_details?: Array<{ type: string; text?: string; summary?: string }>;
          tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
        };
        finish_reason?: string;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        cost?: number;
        prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };
    try {
      parsed = (await response.json()) as typeof parsed;
    } catch (err) {
      yield { type: "error", content: `OpenRouter: failed to parse response (${(err as Error).message})` };
      return;
    }

    // OpenRouter can answer HTTP 200 with an error body instead of choices
    // (upstream provider failure, moderation). Before this check, those landed
    // as a misleading "empty response (no choices)" that hid the real cause.
    if (parsed.error) {
      yield {
        type: "error",
        content: composeOpenRouterError(
          parsed.error.code ?? "upstream",
          parsed.error.message,
          upstreamErrorDetail(parsed),
        ),
        failedProviderSlug: failedProviderFromPayload(parsed, params.model, "body-nonstream"),
        fallbackReason: modelFallbackReason(Number(parsed.error.code), JSON.stringify(parsed)),
      };
      return;
    }

    const choice = parsed.choices?.[0];
    if (!choice) {
      yield { type: "error", content: `OpenRouter: empty response (no choices) from ${params.model}. Try regenerating.` };
      return;
    }

    const message = choice.message ?? {};
    const fr = choice.finish_reason ?? null;

    // Safety/content filter — same handling as streaming path
    if (fr === "SAFETY" || fr === "content_filter") {
      yield {
        type: "error",
        content:
          "Response blocked by safety/content filter. Try regenerating — the filter is non-deterministic and may pass on retry.",
      };
      return;
    }

    // Reasoning — prefer structured reasoning_details, fall back to reasoning string
    if (message.reasoning_details?.length) {
      for (const detail of message.reasoning_details) {
        const reasoningText =
          detail.type === "reasoning.text" ? detail.text
          : detail.type === "reasoning.summary" ? detail.summary
          : null;
        if (reasoningText) yield { type: "reasoning", content: reasoningText };
      }
    } else if (typeof message.reasoning === "string" && message.reasoning.length > 0) {
      yield { type: "reasoning", content: message.reasoning };
    }

    // Text content — emit as a single chunk
    if (typeof message.content === "string" && message.content.length > 0) {
      yield { type: "text", content: message.content };
    }

    // Tool calls — synthesize start + delta + end events for each
    if (message.tool_calls?.length) {
      for (let i = 0; i < message.tool_calls.length; i++) {
        const tc = message.tool_calls[i]!;
        const id = tc.id ?? "";
        const name = tc.function?.name ?? "";
        const args = tc.function?.arguments ?? "";
        yield {
          type: "tool_call_start",
          content: "",
          toolCallIndex: i,
          toolCallId: id,
          toolCallName: name,
        };
        if (args) yield { type: "tool_call_delta", content: args, toolCallIndex: i };
        yield {
          type: "tool_call_end",
          content: "",
          toolCallIndex: i,
          toolCall: { id, type: "function", function: { name, arguments: args } },
        };
      }
    }

    // Non-standard termination (Gemini: RECITATION, OTHER, etc.) — treat as error
    if (fr && fr !== "stop" && fr !== "length" && fr !== "tool_calls") {
      console.warn(`[OpenRouter] Unexpected finish_reason "${fr}" for model ${params.model} (non-stream)`);
      yield { type: "error", content: `Generation stopped unexpectedly (reason: ${fr}) — ${params.model}'s provider failed upstream. Try regenerating, or switch models if it keeps happening.` };
      return;
    }

    // Log cache metrics when available (Anthropic prompt caching)
    const usage = parsed.usage;
    if (usage) {
      const details = usage.prompt_tokens_details;
      if (details?.cached_tokens || details?.cache_write_tokens) {
        console.log(
          `[OpenRouter] Cache: ${details.cached_tokens ?? 0} read, ${details.cache_write_tokens ?? 0} write, ${usage.prompt_tokens ?? 0} total prompt tokens (model: ${params.model}, non-stream)`
        );
      }
    }

    yield {
      type: "done",
      content: "",
      servedProviderSlug: extractServedProviderSlug(parsed),
      stopReason: fr === "length" ? "max_tokens" : fr ?? undefined,
      ...(usage && {
        usage: {
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
          totalTokens: usage.total_tokens ?? 0,
          reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
          providerCostUsd: normalizeProviderCostUsd(usage.cost),
          providerRequestId: typeof parsed.id === "string" ? parsed.id : undefined,
        },
      }),
    };
  }

  async listModels(): Promise<Model[]> {
    const response = await fetch(`${OPENROUTER_BASE}/models`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to list models: ${response.status}`);
    }

    const json = (await response.json()) as {
      data: Array<{
        id: string;
        name: string;
        context_length: number;
        pricing?: { prompt: string; completion: string };
      }>;
    };

    return json.data.map((m) => ({
      id: m.id,
      name: m.name,
      contextLength: m.context_length,
      pricing: m.pricing
        ? {
            prompt: parseFloat(m.pricing.prompt),
            completion: parseFloat(m.pricing.completion),
          }
        : undefined,
    }));
  }

  /** Quick validation call to check if the API key works */
  async verify(): Promise<boolean> {
    try {
      const response = await fetch(`${OPENROUTER_BASE}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

// ── Helpers ──

/**
 * Claude no longer accepts a request whose last message is `assistant`.
 * EVERY Anthropic storefront on OpenRouter (Anthropic, Amazon Bedrock, Azure,
 * Google Vertex) answers 400 with "This model does not support assistant
 * message prefill. The conversation must end with a user message." — verified
 * against Sonnet 4.6, Opus 4.7, Sonnet 5 and Opus 5 on 2026-07-30. Because it
 * is a 4xx, OpenRouter does not fail it over: it just burns every provider and
 * surfaces a hard error to the player.
 *
 * We produce that shape legitimately in two places:
 *   1. a post-history entry authored with `apiRole: "assistant"` (the
 *      SillyTavern-style prefill jailbreak) — 91 worlds in prod, 8 published,
 *      every Claude turn on them fails; and
 *   2. the `/continue` endpoint, which appends the partial assistant turn on
 *      purpose so the model resumes from it.
 *
 * Re-role it to `user` for Claude. The content still reaches the model (so the
 * jailbreak/partial text keeps steering the reply) and the request is legal.
 * That is strictly better than the status quo, where both cases hard-fail —
 * a degraded continuation beats no reply at all.
 *
 * Non-Claude upstreams still accept prefill, so they are left untouched.
 */
export function avoidClaudePrefill(
  messages: Record<string, unknown>[],
  model: string,
): Record<string, unknown>[] {
  if (!isClaudeModel(model)) return messages;
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return messages;
  // Tool-call turns are a different shape and never end a chat request; leave
  // them alone rather than mangling the agent loop.
  if ("tool_calls" in last) return messages;
  console.warn(
    `[OpenRouter] Trailing assistant message re-roled to user for ${model} — Claude rejects prefill.`,
  );
  return [...messages.slice(0, -1), { ...last, role: "user" }];
}

/**
 * Claude 5 restricts where an inline `system` message may sit; Claude 4.x does
 * not. Measured against Opus 4.7, Opus 5 and Sonnet 5 on 2026-07-30 — 4.7
 * accepted all twelve shapes below, Claude 5 rejected three:
 *
 *     s,u,s      s,u,s,s     s,u,a,u     s,u,a,u,s   s,u,a,u,s,s   ✓ both
 *     s,u,s,u    s,u,s,u,s   s,u,a,u,s,u,s                         ✗ Claude 5
 *     s,u,a,s,u                                                    ✗ Claude 5
 *
 * The rule those observations fit exactly: a run of inline system messages is
 * legal only when it directly FOLLOWS a user message and either ENDS the array
 * or is followed by an assistant message. Anthropic says so in the 400 itself —
 * "role 'system' must follow a 'user' message …; must precede an 'assistant'
 * message or end the array".
 *
 * Yumina's prompt assembly breaks that routinely: the format block is pushed as
 * system right after the newest user turn, and post-history entries authored
 * with `apiRole: "user"` (the CoT-bypass preset) then follow it — leaving a
 * system message with a user after it. On Claude 4.x that has always been fine,
 * which is why Opus 4.7 kept working while Sonnet 5 / Opus 5 hard-failed on the
 * very same card (@kljws, 2026-07-30).
 *
 * Fix: re-role only the ILLEGALLY placed system messages to `user`. Content,
 * order and message count are preserved (so cache-breakpoint indices still
 * line up), legally-placed trailing system blocks keep their role, and Claude
 * 4.x is left completely untouched — no behaviour change for the models that
 * work today.
 *
 * Leading system messages (before the first non-system message) are exempt:
 * OpenRouter hoists those into Anthropic's top-level `system` field, so they
 * never become inline messages at all.
 */
export function normalizeSystemPlacement(
  messages: Record<string, unknown>[],
  model: string,
): Record<string, unknown>[] {
  if (!needsStrictSystemPlacement(model)) return messages;

  const firstInline = messages.findIndex((m) => m.role !== "system");
  if (firstInline === -1) return messages; // all-system: hoisted wholesale

  const illegal = new Set<number>();
  for (let i = firstInline; i < messages.length; i++) {
    if (messages[i]!.role !== "system") continue;
    const start = i;
    while (i + 1 < messages.length && messages[i + 1]!.role === "system") i++;
    const before = messages[start - 1]?.role;
    const after = messages[i + 1]?.role; // undefined → the run ends the array
    if (before === "user" && (after === undefined || after === "assistant")) continue;
    for (let j = start; j <= i; j++) illegal.add(j);
  }
  if (illegal.size === 0) return messages;

  console.warn(
    `[OpenRouter] Re-roled ${illegal.size} misplaced system message(s) to user for ${model} — ` +
      `Claude 5 requires an inline system block to follow a user turn and end the array.`,
  );
  return messages.map((m, i) => (illegal.has(i) ? { ...m, role: "user" } : m));
}

/** True for the Claude generations that enforce the inline-system placement
 *  rule above (5.x and later). Claude 4.x accepts any placement — do NOT widen
 *  this to the whole family, or every working 4.6/4.7 prompt silently changes
 *  shape. Revisit when Anthropic backports the restriction. */
function needsStrictSystemPlacement(model: string): boolean {
  if (!isClaudeModel(model)) return false;
  const version = parseClaudeVersion(model);
  return !!version && version.major >= 5;
}

/** Serialize a ChatMessage to the OpenAI-compatible API format */
function serializeMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
  }
  if (m.role === "assistant" && "tool_calls" in m && m.tool_calls && m.tool_calls.length > 0) {
    return {
      role: "assistant",
      content: m.content ?? "",
      tool_calls: m.tool_calls,
    };
  }
  return { role: m.role, content: m.content };
}

/**
 * Apply cache_control breakpoints to serialized messages.
 * Converts message content to array format with cache_control annotation.
 * Uses 1-hour TTL for Claude (explicit breakpoints mark static content like system prompts
 * that should survive long user-approval gaps). Costs 2x write vs 1.25x for 5-min,
 * but avoids cache misses during extended editing sessions.
 *
 * MUST NOT mutate inputs: serializeMessage returns wrappers whose .content field
 * still references the caller's original array. Mutating an element of that array
 * (e.g. adding cache_control to an image part) persists into the caller's message
 * history and accumulates across agent iterations — eventually exceeding the
 * 4-block cache_control limit on Anthropic/Vertex Claude.
 */
function applyCacheBreakpoints(
  messages: Record<string, unknown>[],
  model: string,
  breakpoints: number[]
): void {
  // Legacy Claude 3 (haiku/opus/sonnet) only routes via Bedrock/Vertex AI on
  // OpenRouter, neither of which accepts cache_control for these SKUs — skip
  // the annotation entirely (see isLegacyClaude3).
  if (isLegacyClaude3(model)) return;
  // Apply to every other model. Bedrock's "unsupported … prompt caching" 400 is
  // avoided via provider routing (see shouldIgnoreBedrockForCaching) rather
  // than by withholding the annotation — that lost cache hits on every
  // non-Claude upstream that DOES honor it.
  const cacheControl = isClaudeModel(model)
    ? { type: "ephemeral", ttl: "1h" }
    : { type: "ephemeral" };

  for (const idx of breakpoints) {
    if (idx < 0 || idx >= messages.length) continue;
    const msg = messages[idx]!;
    const content = msg.content;

    if (typeof content === "string") {
      msg.content = [
        { type: "text", text: content, cache_control: cacheControl },
      ];
    } else if (Array.isArray(content) && content.length > 0) {
      // Clone the last part (don't mutate — see function doc).
      const last = content[content.length - 1];
      if (last && typeof last === "object") {
        msg.content = [
          ...content.slice(0, -1),
          { ...(last as Record<string, unknown>), cache_control: cacheControl },
        ];
      }
    }
  }
}

/** Add extra fields to the last element of an array (shallow copy). Used to annotate the last tool with cache_control. */
function annotateLast<T>(arr: T[], extra: Record<string, unknown>): (T & Record<string, unknown>)[] {
  if (arr.length === 0) return arr as (T & Record<string, unknown>)[];
  return [...arr.slice(0, -1), { ...arr[arr.length - 1]!, ...extra }] as (T & Record<string, unknown>)[];
}

/** Yield tool_call_end events for all accumulated tool calls and clear the buffer */
function* flushToolCalls(
  buffers: Map<number, { id: string; name: string; args: string }>
): Generator<StreamChunk> {
  for (const [idx, buf] of buffers) {
    // Default empty args to "{}" (some providers omit arguments for no-param tools)
    const args = buf.args || "{}";
    const toolCall: ToolCall = {
      id: buf.id,
      type: "function",
      function: { name: buf.name, arguments: args },
    };
    yield {
      type: "tool_call_end",
      content: "",
      toolCallIndex: idx,
      toolCall,
    };
  }
  buffers.clear();
}
