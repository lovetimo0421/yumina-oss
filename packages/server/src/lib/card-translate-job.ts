/**
 * "Translate my card into another language": a background job a creator starts from Studio
 * (language menu, or the assistant's translate_card tool).
 *
 * Flow: quote -> start (balance must cover the quote) -> translateCard() -> a DRAFT language
 * variant in the same group, created the way create-variant does -> charge the real cost
 * (x STUDIO_AGENT_MARKUP), never more than the quote. Nothing is charged when it fails.
 *
 * Restarts: the runner holds a lease it renews every 20 s. When an instance goes away (a deploy),
 * the lease lapses and a sweeper on any instance picks the job up and runs it again; model calls
 * the job already made are cached, so the second run replays them instead of paying twice.
 *
 * Job state lives in Redis (24h) so any instance can answer the polling request; without Redis
 * (local dev) it falls back to this process's memory.
 */
import { createHash } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { estimateTokens } from "@yumina/engine";
import { clampWorldTags } from "@yumina/shared";
import { db } from "../db/index.js";
import { assetReferences, worldReviewSubmissions, worlds } from "../db/schema.js";
import { CARD_TRANSLATE_LANGS, isTruncation, translateCard, type CardLang, type ChatFn, type ChatResult, type TranslateProblem } from "./card-translate.js";
import { hasVisibleProse } from "./card-translate-tsx.js";
import { checkBalance, deductCredits, deductCreditsUpToBalance, ensureWallet, refundCredits, STUDIO_AGENT_MARKUP } from "./credit-service.js";
import { env } from "./env.js";
import { notify } from "./notify.js";
import { applyHoldPlan, getPendingEdit, planMaterialHold, resolveWorldCopyMaterial } from "./pending-edit.js";
import { captureEditCheckpoint } from "./world-version-history.js";
import { versionMetadata } from "./world-version-content.js";
import { stampCompiledLater } from "./card-code/stamp.js";
import { redis } from "./redis.js";
import { buildTranslationProviderOptions } from "./translate.js";
import { recordUsageLog } from "./usage-log.js";
import { usageObservation } from "./usage-observation.js";
import { estimateWorldCopyTokens } from "./world-copy-material.js";

export type TranslateJobStatus = "running" | "succeeded" | "failed";
export interface TranslateJob {
  id: string;
  userId: string;
  sourceWorldId: string;
  sourceLang: CardLang;
  targetLang: CardLang;
  status: TranslateJobStatus;
  step: string;
  done: number;
  total: number;
  quoteMushies: number;
  /** Held from the wallet when the job started (the quote); settled to the real cost once, at the end. */
  heldMushies?: number;
  /** How much of the hold came from purchased (non-expiring) mushies, so a refund puts it back there. */
  addonHeld?: number;
  settled?: boolean;
  /** Runs so far (1 = the first); a restart resumes the job and counts another. */
  attempts?: number;
  sourceName?: string;
  /** Set when the job refreshes an existing version instead of creating one. */
  updateVariantId?: string;
  chargedMushies?: number;
  variantId?: string;
  variantName?: string;
  issues?: string[];
  problems?: TranslateProblem[];
  warnings?: string[];
  error?: string;
  startedAt: number;
  updatedAt: number;
}

export class TranslateJobError extends Error {
  constructor(public code: "not_found" | "bad_language" | "no_source_language" | "same_language" | "exists" | "running" | "too_many" | "insufficient_credits" | "unavailable", message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

/** Why a started job ended without a version. Nothing is charged for any of these. */
export type TranslateFailReason = "refused" | "model_error" | "save_failed" | "not_found" | "interrupted" | "unavailable";
class TranslateJobFailure extends Error {
  constructor(public reason: TranslateFailReason, message: string) { super(message); }
}

/** For the assistant: what each failure means and what retrying can do. */
const FAIL_MEANING: Record<TranslateFailReason, string> = {
  refused: "The models refused most of this card. Retrying usually gives the same result; the creator can translate it by hand or with the write tools.",
  model_error: "The translation models failed or timed out on most of the text. Retrying usually works.",
  save_failed: "The translation finished but the draft could not be saved. Retry.",
  not_found: "The card was deleted during the translation.",
  interrupted: "The server restarted during the translation. Retry.",
  unavailable: "Translation is not available right now.",
};

/**
 * Order the translator tries models in. Picked by a refusal benchmark (2026-11-18, card-factory/stage/i18n-pilot/bench):
 * 30 of the most explicit / dark passages from adult cards, en->zh and zh->en, with the product prompt.
 *  - DeepSeek V4.1 Flash 1017: 29/30 (1 network error, no refusal), median 8 s, $0.027; prose close to GLM.
 *  - GLM-5.3: 28/30 (1 refusal), median 31 s, $0.51; the most idiomatic prose, so the first fallback.
 *  - Grok 4.3: 30/30, median 18 s, $0.12; more translationese, so the last resort that never refuses.
 * Whole-card run (Kayla, en->zh): $0.018 in 77 s with DeepSeek first vs $0.085-0.147 in ~10 min with GLM first.
 */
export const CARD_TRANSLATE_MODELS = ["deepseek/deepseek-v4.1-flash-1017", "z-ai/glm-5.3", "x-ai/grok-4.3"] as const;
/**
 * Models asked not to think. Probe 2026-11-22 on DanMachi's 15k-char narrator prompt: with reasoning on, DeepSeek
 * spent 11.6k of 16.4k output tokens thinking and hit the output cap under the full rules, so the batch fell back to
 * GLM; off, 5.1k tokens, a third of the cost, same translation.
 */
export const REASONING_OFF: ReadonlySet<string> = new Set(["deepseek/deepseek-v4.1-flash-1017"]);

const JOB_TTL_S = 24 * 3600;
const LOCK_TTL_S = 45 * 60;
const memory = new Map<string, string>();

async function kvGet(key: string): Promise<string | null> {
  if (redis) return redis.get(key);
  return memory.get(key) ?? null;
}
async function kvSet(key: string, value: string, ttlS: number, onlyIfAbsent = false): Promise<boolean> {
  if (redis) return (onlyIfAbsent ? await redis.set(key, value, "EX", ttlS, "NX") : await redis.set(key, value, "EX", ttlS)) === "OK";
  if (onlyIfAbsent && memory.has(key)) return false;
  memory.set(key, value);
  setTimeout(() => memory.delete(key), ttlS * 1000).unref?.();
  return true;
}
async function kvDel(key: string): Promise<void> {
  if (redis) await redis.del(key); else memory.delete(key);
}
const jobKey = (id: string) => `card-translate:job:${id}`;
const lockKey = (worldId: string, lang: string) => `card-translate:lock:${worldId}:${lang}`;

// ---------------------------------------------------------------------------
// billing: hold, settle once, running cap, sweep

const MAX_RUNNING_PER_USER = 2;
const runningKey = (userId: string) => `card-translate:running:${userId}`;

async function takeRunningSlot(userId: string): Promise<boolean> {
  if (redis) {
    const n = await redis.incr(runningKey(userId));
    await redis.expire(runningKey(userId), LOCK_TTL_S);
    if (n > MAX_RUNNING_PER_USER) { await redis.decr(runningKey(userId)); return false; }
    return true;
  }
  const n = Number(memory.get(runningKey(userId)) ?? 0) + 1;
  if (n > MAX_RUNNING_PER_USER) return false;
  memory.set(runningKey(userId), String(n));
  return true;
}
async function releaseRunningSlot(userId: string): Promise<void> {
  if (redis) { const n = await redis.decr(runningKey(userId)); if (n < 0) await redis.set(runningKey(userId), "0", "EX", LOCK_TTL_S); return; }
  memory.set(runningKey(userId), String(Math.max(0, Number(memory.get(runningKey(userId)) ?? 0) - 1)));
}

/**
 * Settle a job's hold exactly once: keep `charge` and give the rest back (the whole hold when charge is 0).
 * The once-only guard is a Redis NX key, so two instances (the job's own and a sweeper) cannot both refund.
 */
/** Returns false when the hold had already been settled elsewhere (nothing was done here). */
async function settleHold(job: TranslateJob, charge: number, description: string): Promise<boolean> {
  if (job.settled) return false;
  const held = job.heldMushies ?? 0;
  if (!(await kvSet(`card-translate:settled:${job.id}`, "1", JOB_TTL_S * 2, true))) { job.settled = true; return false; }
  const refund = Math.max(0, held - Math.max(0, charge));
  if (refund > 0) await refundCredits(job.userId, refund, `card-translate-settle:${job.id}`, description, undefined, Math.min(refund, job.addonHeld ?? 0));
  job.chargedMushies = held - refund;
  job.settled = true;
  return true;
}

// ---------------------------------------------------------------------------
// surviving a restart: a lease, a call cache, a sweeper that resumes

/** The runner that owns a job renews this lease; a running job whose lease lapsed lost its instance. */
const LEASE_MS = 60_000;
const HEARTBEAT_MS = 20_000;
/** Runs per job before it fails as interrupted (and is refunded). */
const MAX_ATTEMPTS = 3;
const leaseKey = (id: string) => `card-translate:lease:${id}`;
const cacheKey = (id: string, hash: string) => `card-translate:cache:${id}:${hash}`;
const RENEW_LEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";

async function claimLease(jobId: string, token: string): Promise<boolean> {
  return kvSet(leaseKey(jobId), token, Math.ceil(LEASE_MS / 1000), true);
}
/** Extend the lease if it is still ours; false means another runner owns the job now. */
async function renewLease(jobId: string, token: string): Promise<boolean> {
  if (redis) return Number(await redis.eval(RENEW_LEASE, 1, leaseKey(jobId), token, String(LEASE_MS))) === 1;
  if (memory.get(leaseKey(jobId)) !== token) return false;
  await kvSet(leaseKey(jobId), token, Math.ceil(LEASE_MS / 1000));
  return true;
}
async function ownsLease(jobId: string, token: string): Promise<boolean> {
  return (await kvGet(leaseKey(jobId))) === token;
}

class LeaseLost extends Error {}

/** Model calls this job already paid for are kept 2 hours, so a resumed run replays them instead of paying again. */
export function cachedChat(jobId: string, chat: ChatFn, stillOwner: () => boolean): ChatFn {
  return async (messages, opts) => {
    if (!stillOwner()) throw new LeaseLost("another runner owns this job");
    const hash = createHash("sha256").update(JSON.stringify([messages, opts.json ?? false, opts.maxTokens ?? null])).digest("hex").slice(0, 32);
    const hit = await kvGet(cacheKey(jobId, hash)).catch(() => null);
    if (hit) return JSON.parse(hit) as ChatResult;
    const result = await chat(messages, opts);
    await kvSet(cacheKey(jobId, hash), JSON.stringify(result), 2 * 3600).catch(() => {});
    return result;
  };
}

let sweeper: ReturnType<typeof setInterval> | null = null;
/** Started at boot: resumes running jobs whose instance went away. Claiming the lease makes it once-only across instances. */
export function startCardTranslateSweeper(): void {
  if (sweeper || !redis) return;
  const r = redis;
  sweeper = setInterval(async () => {
    try {
      let cursor = "0";
      do {
        const [next, keys] = await r.scan(cursor, "MATCH", "card-translate:job:*", "COUNT", 200);
        cursor = next;
        for (const key of keys) {
          const raw = await r.get(key);
          if (!raw) continue;
          const job = JSON.parse(raw) as TranslateJob;
          if (job.status !== "running" || Date.now() - job.updatedAt < LEASE_MS) continue;
          if (await r.exists(leaseKey(job.id))) continue;
          const token = crypto.randomUUID();
          if (await claimLease(job.id, token)) await resumeJob(job.id, token);
        }
      } while (cursor !== "0");
    } catch (e) { console.warn("[card-translate] sweep failed:", (e as Error).message); }
  }, 30_000);
  sweeper.unref?.();
}

async function resumeJob(jobId: string, token: string): Promise<void> {
  // Re-read under the lease: it may have finished between the scan and the claim.
  const raw = await kvGet(jobKey(jobId));
  const job = raw ? (JSON.parse(raw) as TranslateJob) : null;
  if (!job || job.status !== "running") { await kvDel(leaseKey(jobId)); return; }
  job.attempts = (job.attempts ?? 1) + 1;
  if (job.attempts > MAX_ATTEMPTS) {
    await finishFailed(job, "interrupted", "the server restarted too many times");
    await releaseJob(job, token);
    return;
  }
  console.log(`[card-translate] resuming job ${job.id} (run ${job.attempts})`);
  await kvSet(lockKey(job.sourceWorldId, job.targetLang), job.id, LOCK_TTL_S);
  await saveJob(job);
  void runTranslateJob(job, token);
}

async function releaseJob(job: TranslateJob, token: string): Promise<void> {
  if (!(await ownsLease(job.id, token))) return;
  await kvDel(lockKey(job.sourceWorldId, job.targetLang));
  await releaseRunningSlot(job.userId);
  await kvDel(leaseKey(job.id));
}

/** Fail a job: refund its hold (once), save, and tell the creator. */
async function finishFailed(job: TranslateJob, reason: string, detail: string): Promise<void> {
  job.status = "failed";
  job.error = reason;
  console.warn(`[card-translate] job ${job.id} failed (${reason}):`, detail);
  await settleHold(job, 0, "Card translation refund (failed)").catch((err) => console.error(`[card-translate] refund for ${job.id} failed:`, err));
  await saveJob(job);
  await notifyFinished(job);
}

/** A bell notification, so a creator who closed the page learns how it went. */
async function notifyFinished(job: TranslateJob): Promise<void> {
  try {
    if (job.status === "succeeded") {
      await notify(job.userId, "card_translation_completed", {
        worldId: job.variantId, worldName: job.variantName ?? "", sourceWorldId: job.sourceWorldId,
        targetLang: job.targetLang, jobId: job.id, problemCount: job.problems?.length ?? 0,
      }, { dedupeKey: `card-translate:${job.id}` });
    } else if (job.status === "failed") {
      await notify(job.userId, "card_translation_failed", {
        worldId: job.sourceWorldId, worldName: job.sourceName ?? "", targetLang: job.targetLang, jobId: job.id, reason: job.error ?? "model_error",
      }, { dedupeKey: `card-translate:${job.id}` });
    }
  } catch (e) { console.error(`[card-translate] notification for ${job.id} failed:`, e); }
}

async function saveJob(job: TranslateJob): Promise<void> {
  job.updatedAt = Date.now();
  await kvSet(jobKey(job.id), JSON.stringify(job), JOB_TTL_S);
}

export async function getTranslateJob(userId: string, jobId: string): Promise<TranslateJob | null> {
  const raw = await kvGet(jobKey(jobId));
  if (!raw) return null;
  const job = JSON.parse(raw) as TranslateJob;
  if (job.userId !== userId) return null;
  return job;
}

// ---------------------------------------------------------------------------
// price

/** What the model reads and writes: prose (text fields) and interface code (files with visible text). */
export function translatableChars(row: { name: string; description: string | null; extendedDescription?: string | null }, schema: Record<string, any>, sourceLang: CardLang): { prose: number; code: number } {
  let prose = (row.name?.length ?? 0) + (row.description?.length ?? 0) + (row.extendedDescription?.length ?? 0);
  for (const e of schema.entries ?? []) prose += String(e.content ?? "").length + String(e.name ?? "").length;
  for (const v of schema.variables ?? []) prose += String(v.description ?? "").length + String(v.behaviorRules ?? "").length;
  if (schema.settings?.greeting && !(schema.entries ?? []).some((e: any) => e.content === schema.settings.greeting)) prose += String(schema.settings.greeting).length;
  let code = 0;
  for (const f of Object.values(schema.rootComponent?.files ?? {}) as any[]) {
    const text = typeof f === "string" ? f : f?.content ?? "";
    if (hasVisibleProse(text, sourceLang)) code += text.length;
  }
  return { prose, code };
}

/**
 * What a card usually costs with CARD_TRANSLATE_MODELS (DeepSeek first). Least-squares fit on 14 whole-card
 * runs (2026-11-18): prose dominates, interface code is cheap per char. A Chinese source costs ~2.3x per
 * char (English output runs longer and goes in smaller batches): 夏日三分线 33k + 26k chars, $0.157.
 * Examples: Kayla 12k prose + 17k code $0.018 (fit $0.023); Party Foul 12k + 193k $0.071 (fit $0.065).
 */
export function typicalTranslateUsd(chars: { prose: number; code: number }, sourceLang: CardLang = "en"): number {
  const base = chars.prose * 2.04e-6 + chars.code * 2.5e-7;
  // Korean sources share Chinese's small batches and longer output; no fitted runs yet, so priced the same.
  // Cyrillic takes about 1.5x the tokens per char of Latin text; no fitted Russian runs yet either.
  return Math.max(0.01, base * (sourceLang === "zh" || sourceLang === "ko" ? 2.3 : sourceLang === "ru" ? 1.5 : 1));
}

/**
 * The quote's upper bound, which the charge never exceeds: 4x the typical cost plus a floor. The worst run
 * so far was 1.2x its fit. If a run falls back to the pricier GLM-5.3 for most of the card it can cost
 * more than this; the platform absorbs the difference rather than charging past the quote.
 */
export function estimateTranslateUsd(chars: { prose: number; code: number }, sourceLang: CardLang = "en"): number {
  return 0.05 + 4 * typicalTranslateUsd(chars, sourceLang);
}

export const mushiesFor = (usd: number) => Math.max(1, Math.ceil((usd * STUDIO_AGENT_MARKUP) / 0.001));

/** existingVariantId: a version in the target language already exists. updatable: that version can be
 *  refreshed from this card (it is not the group's original and not waiting in first-publish review). */
export interface TranslateQuote { sourceLang: CardLang; targetLang: CardLang; chars: { prose: number; code: number }; estimateMushies: number; quoteMushies: number; balance: number; existingVariantId: string | null; updatable: boolean }

async function loadSource(userId: string, worldId: string) {
  const [source] = await db.select().from(worlds).where(and(eq(worlds.id, worldId), eq(worlds.creatorId, userId))).limit(1);
  if (!source) throw new TranslateJobError("not_found", "World not found or not authorized");
  const copy = await resolveWorldCopyMaterial(source, userId);
  return { source, copy };
}

async function existingVariant(groupId: string | null, lang: CardLang) {
  if (!groupId) return null;
  const [row] = await db.select({ id: worlds.id, status: worlds.status })
    .from(worlds).where(and(eq(worlds.languageGroupId, groupId), eq(worlds.language, lang)))
    .orderBy(desc(worlds.isPrimaryVariant), asc(worlds.createdAt)).limit(1);
  return row ?? null;
}

/** The group's original: its oldest version, the one the others were translated from. */
async function isGroupOriginal(source: { id: string; languageGroupId: string | null }, exec: Pick<typeof db, "select"> = db): Promise<boolean> {
  if (!source.languageGroupId) return true;
  const [first] = await exec.select({ id: worlds.id }).from(worlds)
    .where(eq(worlds.languageGroupId, source.languageGroupId)).orderBy(asc(worlds.createdAt), asc(worlds.id)).limit(1);
  return first?.id === source.id;
}

/** Refreshing overwrites a version's text, so only from the original (never translate a translation
 *  over another version, or over the original itself), and never into a version whose first publish
 *  is in review (withdraw it first). */
const isUpdatable = (v: { status: string } | null, fromOriginal: boolean) => !!v && fromOriginal && v.status !== "pending_review";

export async function quoteTranslation(userId: string, worldId: string, targetLang: string): Promise<TranslateQuote> {
  if (!(CARD_TRANSLATE_LANGS as readonly string[]).includes(targetLang)) throw new TranslateJobError("bad_language", "Translation supports en, zh, es, ko, id and ru");
  const { source, copy } = await loadSource(userId, worldId);
  const sourceLang = source.language as CardLang | null;
  if (!sourceLang || !(CARD_TRANSLATE_LANGS as readonly string[]).includes(sourceLang)) throw new TranslateJobError("no_source_language", "Set this card's language (en, zh, es, ko, id or ru) first");
  if (sourceLang === targetLang) throw new TranslateJobError("same_language", "The card is already in that language");
  const chars = translatableChars({ name: source.name, description: source.description, extendedDescription: source.extendedDescription }, copy.schema as Record<string, any>, sourceLang);
  const { balance } = await checkBalance(userId);
  const existing = await existingVariant(source.languageGroupId, targetLang as CardLang);
  return { sourceLang, targetLang: targetLang as CardLang, chars, estimateMushies: mushiesFor(typicalTranslateUsd(chars, sourceLang)), quoteMushies: mushiesFor(estimateTranslateUsd(chars, sourceLang)), balance, existingVariantId: existing?.id ?? null, updatable: isUpdatable(existing, !!existing && await isGroupOriginal(source)) };
}

// ---------------------------------------------------------------------------
// model calls (platform key, same models and routing as community translation)

function platformChat(userId: string): ChatFn {
  return async (messages, { json, maxTokens = 16000 }) => {
    if (!env.YUMINA_OPENROUTER_KEY) throw new TranslateJobError("unavailable", "Translation is not configured");
    let last: Error | null = null;
    for (const model of CARD_TRANSLATE_MODELS) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const started = Date.now();
        try {
          const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            signal: AbortSignal.timeout(240_000),
            headers: { Authorization: `Bearer ${env.YUMINA_OPENROUTER_KEY}`, "Content-Type": "application/json", "X-Title": "Yumina card translation" },
            body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.3, usage: { include: true }, provider: buildTranslationProviderOptions(model), ...(REASONING_OFF.has(model) ? { reasoning: { enabled: false } } : {}), ...(json ? { response_format: { type: "json_object" } } : {}) }),
          });
          const data = (await res.json()) as any;
          const usage = data.usage ?? {};
          if (usage.prompt_tokens || usage.completion_tokens) {
            void recordUsageLog({
              ...usageObservation({ promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0, totalTokens: (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0), providerCostUsd: usage.cost, providerRequestId: data.id }),
              userId, model, promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0,
              totalTokens: (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0), endpoint: "card-translation", apiKeyTier: "internal", generationTimeMs: Date.now() - started,
            }).catch(() => {});
          }
          const text: string = data.choices?.[0]?.message?.content ?? "";
          const finish = data.choices?.[0]?.finish_reason;
          if (!res.ok || data.error || !text.trim() || finish === "length") throw new Error(`${model}: ${res.status} ${finish ?? ""}`);
          if (text.length < 400 && /(I can(?:'|no)t|I'm sorry|unable to (?:help|assist|translate)|无法(?:协助|提供|翻译)|抱歉)/i.test(text)) throw new Error(`${model}: refused`);
          return { text, costUsd: Number(usage.cost ?? 0), model };
        } catch (e) {
          last = e as Error;
          // Cut off at the output cap: the text is too long, not the model at fault. Hand it back so the
          // translator splits the batch instead of trying the same length on every model.
          if (isTruncation(last.message)) throw last;
        }
      }
    }
    throw last ?? new Error("translation model failed");
  };
}

// ---------------------------------------------------------------------------
// start / run

export async function startTranslateJob(userId: string, worldId: string, targetLang: string, opts: { update?: boolean } = {}): Promise<TranslateJob> {
  const quote = await quoteTranslation(userId, worldId, targetLang);
  // update: re-translate this card into the existing version (its text becomes a draft update there).
  if (quote.existingVariantId && !(opts.update && quote.updatable)) {
    throw new TranslateJobError("exists", "This card already has a version in that language", { variantId: quote.existingVariantId, updatable: quote.updatable });
  }
  if (quote.balance < quote.quoteMushies) throw new TranslateJobError("insufficient_credits", "Not enough mushies", { quoteMushies: quote.quoteMushies, balance: quote.balance });
  const id = crypto.randomUUID();
  if (!(await kvSet(lockKey(worldId, targetLang), id, LOCK_TTL_S, true))) {
    const running = await kvGet(lockKey(worldId, targetLang));
    throw new TranslateJobError("running", "A translation into that language is already running", { jobId: running });
  }
  // At most MAX_RUNNING_PER_USER translations at once per creator: failed runs are free to them, so
  // this bounds what repeated failing runs can spend on the platform.
  if (!(await takeRunningSlot(userId))) {
    await kvDel(lockKey(worldId, targetLang));
    throw new TranslateJobError("too_many", "Too many translations running", { max: MAX_RUNNING_PER_USER });
  }
  // Hold the quote now, atomically (two jobs cannot both pass on the same balance); settle to the real cost at the end.
  let heldMushies = 0, addonHeld = 0;
  try {
    const before = await ensureWallet(userId);
    const d = await deductCredits(userId, quote.quoteMushies, `card-translate-hold:${id}`, `Card translation hold (${quote.sourceLang}→${quote.targetLang})`);
    heldMushies = d.creditsDeducted;
    // Read outside the wallet lock, so clamp: a refund can never move more than the hold into the purchased pile.
    addonHeld = Math.min(heldMushies, Math.max(0, before.addonBalance - d.newAddonBalance));
  } catch (e) {
    await kvDel(lockKey(worldId, targetLang));
    await releaseRunningSlot(userId);
    if ((e as Error).message === "INSUFFICIENT_CREDITS") throw new TranslateJobError("insufficient_credits", "Not enough mushies", { quoteMushies: quote.quoteMushies, balance: quote.balance });
    throw e;
  }
  const job: TranslateJob = {
    id, userId, sourceWorldId: worldId, sourceLang: quote.sourceLang, targetLang: quote.targetLang,
    status: "running", step: "glossary", done: 0, total: 1, quoteMushies: quote.quoteMushies, heldMushies, addonHeld,
    attempts: 1, startedAt: Date.now(), updatedAt: Date.now(),
    ...(quote.existingVariantId ? { updateVariantId: quote.existingVariantId } : {}),
  };
  const token = crypto.randomUUID();
  await claimLease(id, token);
  await saveJob(job);
  void runTranslateJob(job, token);
  return job;
}

async function runTranslateJob(job: TranslateJob, token: string): Promise<void> {
  // Renew the lease (and show we are alive) every 20 s. Losing it means another instance resumed
  // this job: stop spending and write nothing.
  let lost = false;
  const heartbeat = setInterval(() => {
    void renewLease(job.id, token).then((ok) => { if (!ok) lost = true; else void saveJob(job); }).catch(() => {});
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    const { source, copy } = await loadSource(job.userId, job.sourceWorldId).catch(async (e) => {
      if (e instanceof TranslateJobError && e.code === "not_found") job.sourceName = "";
      throw e;
    });
    job.sourceName = source.name;
    let lastSave = 0;
    const result = await translateCard(
      { name: source.name, description: source.description ?? "", extendedDescription: source.extendedDescription, announcement: source.announcement, schema: copy.schema as Record<string, any>, sourceLang: job.sourceLang, targetLang: job.targetLang },
      cachedChat(job.id, platformChat(job.userId), () => !lost),
      (step, done, total) => {
        job.step = step; job.done = done; job.total = total;
        if (!lost && (Date.now() - lastSave > 3000 || done === total)) { lastSave = Date.now(); void saveJob(job); }
      },
    );
    // A version with a quarter of its text still in the source language is not worth handing over:
    // fail (free) and say whether the model refused or simply errored, so the creator knows what retrying can do.
    const r = result.report;
    if (r.unitsTotal && (r.unitsMissing / r.unitsTotal > 0.25 || !result.name.trim())) {
      throw new TranslateJobFailure(r.unitsRefused * 2 >= r.unitsMissing ? "refused" : "model_error", `${r.unitsMissing}/${r.unitsTotal} texts missing (${r.unitsRefused} refused)`);
    }
    if (lost || !(await ownsLease(job.id, token))) throw new LeaseLost("another runner owns this job");

    let variant: { id: string; name: string; updatedAt: Date | null; held?: boolean };
    try {
      variant = job.updateVariantId
        ? await writeTranslatedUpdate(source, result, job.targetLang, job.updateVariantId)
        : await createTranslatedVariant(source, copy, result, job.targetLang);
    } catch (e) {
      throw new TranslateJobFailure("save_failed", (e as Error).message);
    }
    // Translated interface files lost their precompiled bundle; compile them on the server like any other write.
    // A held update is not the live row: the editor compiles it the way it compiles any held edit.
    if (!variant.held) stampCompiledLater({ id: variant.id, updatedAt: variant.updatedAt, schema: result.schema });
    const charge = Math.min(job.heldMushies ?? 0, mushiesFor(r.costUsd));
    const settledHere = await settleHold(job, charge, `Card translation (${job.sourceLang}→${job.targetLang}): ${source.name}`);
    if (!settledHere && charge > 0) {
      // The hold was settled elsewhere already: charge the real cost now, under its own reference.
      const late = await deductCreditsUpToBalance(job.userId, charge, `card-translate-late:${job.id}`, `Card translation (${job.sourceLang}→${job.targetLang}): ${source.name}`).catch(() => null);
      job.chargedMushies = late?.creditsDeducted ?? 0;
    }
    Object.assign(job, {
      status: "succeeded", step: "done", variantId: variant.id, variantName: variant.name,
      issues: r.issues, problems: r.problems, warnings: r.warnings,
    });
    await saveJob(job);
    await notifyFinished(job);
  } catch (e) {
    if (e instanceof LeaseLost || lost) {
      console.log(`[card-translate] job ${job.id}: another instance took it over, this run stops`);
      return;
    }
    const reason = e instanceof TranslateJobFailure ? e.reason
      : e instanceof TranslateJobError ? e.code
      : /refus/i.test(String((e as Error).message)) ? "refused" : "model_error";
    await finishFailed(job, reason, (e as Error).message);
  } finally {
    clearInterval(heartbeat);
    if (!lost) await releaseJob(job, token).catch(() => {});
  }
}

/** Same row create-variant writes, with the translated text: a draft the creator reviews and publishes. */
async function createTranslatedVariant(
  source: typeof worlds.$inferSelect,
  copy: Awaited<ReturnType<typeof resolveWorldCopyMaterial>>,
  t: { name: string; description: string; extendedDescription: string | null; announcement: string | null; schema: Record<string, any> },
  lang: CardLang,
) {
  const groupId = source.languageGroupId ?? crypto.randomUUID();
  return db.transaction(async (tx) => {
    if (!source.languageGroupId) await tx.update(worlds).set({ languageGroupId: groupId, updatedAt: new Date() }).where(eq(worlds.id, source.id));
    const sibling = await tx.select({ id: worlds.id }).from(worlds)
      .where(and(eq(worlds.languageGroupId, groupId), sql`coalesce(${worlds.language},'') = ${lang}`)).limit(1);
    const [row] = await tx.insert(worlds).values({
      creatorId: source.creatorId,
      name: t.name.slice(0, 200),
      description: t.description,
      extendedDescription: t.extendedDescription,
      announcement: t.announcement,
      schema: t.schema,
      retained: source.retained,
      sealedContent: source.sealedContent,
      ...(source.sealedContent || source.retained ? { allowCustomApi: false } : {}),
      thumbnailUrl: copy.thumbnailUrl,
      tags: clampWorldTags(source.tags ?? []),
      language: lang,
      languageGroupId: groupId,
      variantLabel: null,
      isPrimaryVariant: sibling.length === 0,
      status: "draft",
      isPublished: false,
      isNsfw: copy.isNsfw ?? false,
      allowEdit: source.allowEdit ?? true,
      allowReviews: source.allowReviews ?? true,
      ageRating: copy.ageRating,
      blurCover: source.blurCover,
      visibility: source.visibility,
      galleryImages: source.galleryImages,
      approxTime: source.approxTime,
      totalTokens: estimateWorldCopyTokens(t.schema) || (t.schema.entries ?? []).reduce((s: number, e: any) => s + estimateTokens(e.content ?? ""), 0),
    }).returning();
    const refs = await tx.select({ assetId: assetReferences.assetId }).from(assetReferences).where(eq(assetReferences.worldId, source.id));
    if (refs.length) await tx.insert(assetReferences).values(refs.map((r) => ({ worldId: row!.id, assetId: r.assetId })));
    return { id: row!.id, name: row!.name, updatedAt: row!.updatedAt };
  });
}

/**
 * Refresh an existing language version with a fresh translation of the source, the way a Studio save
 * would: a published version gets it as a held update (players keep the live one until the creator
 * publishes it and it passes review); an unpublished one is overwritten. Either way the text it had
 * is kept as a version-history checkpoint first.
 */
async function writeTranslatedUpdate(
  source: typeof worlds.$inferSelect,
  t: { name: string; description: string; extendedDescription: string | null; announcement: string | null; schema: Record<string, any> },
  lang: CardLang,
  variantId: string,
) {
  return db.transaction(async (tx) => {
    const [target] = await tx.select().from(worlds).where(eq(worlds.id, variantId)).for("update").limit(1);
    if (!target || target.creatorId !== source.creatorId || target.id === source.id
      || !source.languageGroupId || target.languageGroupId !== source.languageGroupId || target.language !== lang
      || !isUpdatable(target, await isGroupOriginal(source, tx))) {
      throw new Error("the version to update changed during the translation");
    }
    const existing = target.status === "published" ? await getPendingEdit(target.id, tx) : null;
    // The version keeps its own title: it is how players already know it, and a fresh title pass
    // can drift (a test refresh turned "七日" into "4 days"). The creator renames it if they want.
    const name = (existing?.metadata?.name ?? target.name).slice(0, 200);
    const schema: Record<string, any> = { ...t.schema, name };
    const working = existing ?? target;
    await captureEditCheckpoint(tx, target, {
      schema: working.schema as Record<string, unknown>,
      thumbnailUrl: working.thumbnailUrl ?? null,
      ageRating: working.ageRating ?? "all",
    });

    if (target.status === "published") {
      const plan = planMaterialHold({
        worldId: target.id,
        creatorId: target.creatorId,
        live: { schema: target.schema, thumbnailUrl: target.thumbnailUrl, ageRating: target.ageRating ?? "all", languageGroupId: target.languageGroupId, updatedAt: target.updatedAt },
        proposedSchema: schema,
        liveMetadata: versionMetadata(target),
        proposedMetadata: versionMetadata({ ...target, ...existing?.metadata, name, description: t.description, announcement: t.announcement }),
        proposedThumbnailUrl: existing ? existing.thumbnailUrl ?? null : target.thumbnailUrl,
        proposedAgeRating: existing?.ageRating ?? target.ageRating ?? "all",
        existing: existing ? { ...existing, status: "draft" } : null,
      });
      // A submitted update goes back to draft: what is in review is no longer the latest.
      if (existing?.status === "pending") {
        await tx.update(worldReviewSubmissions)
          .set({ decision: "withdrawn", decidedBy: target.creatorId, decidedAt: new Date() })
          .where(and(eq(worldReviewSubmissions.worldId, target.id), eq(worldReviewSubmissions.decision, "pending"), eq(worldReviewSubmissions.submissionType, "edit")));
      }
      await applyHoldPlan(plan, tx);
      // The long description is not held (same as a Studio save): it changes on the live row.
      const [row] = await tx.update(worlds).set({ extendedDescription: t.extendedDescription, updatedAt: new Date() }).where(eq(worlds.id, target.id)).returning();
      return { id: row!.id, name, updatedAt: row!.updatedAt, held: !!plan.upsert };
    }

    const [row] = await tx.update(worlds).set({
      name,
      description: t.description,
      extendedDescription: t.extendedDescription,
      announcement: t.announcement,
      schema,
      totalTokens: estimateWorldCopyTokens(schema) || (schema.entries ?? []).reduce((s: number, e: any) => s + estimateTokens(e.content ?? ""), 0),
      updatedAt: new Date(),
    }).where(eq(worlds.id, target.id)).returning();
    return { id: row!.id, name: row!.name, updatedAt: row!.updatedAt };
  });
}

// ---------------------------------------------------------------------------
// assistant / MCP tool

export async function runTranslateCardTool(userId: string, worldId: string, args: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  try {
    if (typeof args.jobId === "string" && args.jobId) {
      const job = await getTranslateJob(userId, args.jobId);
      if (!job) return { ok: false, error: "No such translation job." };
      return { ok: true, result: {
        status: job.status, step: job.step, progress: `${job.done}/${job.total}`,
        ...(job.status === "succeeded" ? { variantId: job.variantId, name: job.variantName, chargedMushies: job.chargedMushies, problems: (job.problems ?? []).slice(0, 30).map((p) => ({ kind: p.kind, field: p.field, where: p.where })), note: "A draft. Tell the creator; they open it from the language menu, check it and publish it. You can fix the listed issues with variant: \"" + job.targetLang + "\" on the write tools." } : {}),
        ...(job.status === "failed" ? { error: job.error, charged: 0, meaning: FAIL_MEANING[job.error as TranslateFailReason] ?? FAIL_MEANING.model_error } : {}),
        ...(job.status === "running" ? { note: "Usually 3-10 minutes. Check again later; do not start it again." } : {}),
      } };
    }
    const language = String(args.language ?? "");
    if (args.confirm !== true) {
      const q = await quoteTranslation(userId, worldId, language);
      if (q.existingVariantId && !(args.update === true && q.updatable)) return { ok: true, result: { exists: true, variantId: q.existingVariantId, note: q.updatable
        ? "This card already has a version in that language. To refresh it from this card after edits, call again with update: true (same price; the version gets the new translation as a draft update the creator publishes). For small fixes, edit it with variant instead."
        : "This card already has a version in that language and it cannot be refreshed from here (it is the original, or its first publish is in review); edit it with variant instead." } };
      return { ok: true, result: { ...(q.existingVariantId ? { updates: q.existingVariantId } : {}), priceMushies: `about ${q.estimateMushies}, at most ${q.quoteMushies}`, balance: q.balance, from: q.sourceLang, to: q.targetLang, note: "Nothing has run. Ask the creator; call again with confirm: true once they agree." } };
    }
    const job = await startTranslateJob(userId, worldId, language, { update: args.update === true });
    return { ok: true, result: { jobId: job.id, status: job.status, maxMushies: job.quoteMushies, note: "Started. It takes a few minutes; check with jobId." } };
  } catch (e) {
    if (e instanceof TranslateJobError) return { ok: false, error: `${e.message}${e.extra ? ` ${JSON.stringify(e.extra)}` : ""}` };
    return { ok: false, error: "Translation failed to start." };
  }
}
