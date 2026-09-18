import { usageObservation } from "./usage-observation.js";
import { createHash } from "node:crypto";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  communityEvents,
  contentTranslations,
  posts,
  reviewReplies,
  reviews,
  threads,
  translationAttempts,
} from "../db/schema.js";
import { recordUsageLog } from "./usage-log.js";

import { env } from "./env.js";
import { hasTranslatableProse } from "@yumina/shared";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

/**
 * Quality primary for community translation.
 *
 * Picked by bakeoff over 37 real community posts x 5 models on 2026-08-27
 * (scripts/translation-bakeoff/ — re-run it before the next swap). It beat the
 * incumbent qwen3-235b on every measured axis: echo 1 vs 4, zero corrupted
 * URLs, zero refusals.
 *
 * The finding that decided it: the prompt below says `Never use em dashes`, and
 * qwen3-235b broke that rule in 8 of 37 outputs (17 occurrences) while all four
 * challengers broke it zero times. That is a model ignoring an explicit
 * instruction, and it tracks what the prose reads like — qwen3-235b rendered the
 * casual Chinese "往正能量上拉" as the stiff "steer storylines toward a more
 * positive tone", where this model gives "drags the plot toward wholesome
 * territory".
 *
 * It is a reasoning model: ~150-250 hidden reasoning tokens per call, billed
 * against the same max_tokens as the answer. Priced in (~$4/month at current
 * volume), but it is not free headroom.
 */
export const TRANSLATION_PRIMARY_MODEL = "z-ai/glm-5.3";

/**
 * Retried when the primary refuses. MUST be an unmoderated model — the whole
 * point of this rung is to be more permissive than the primary, and a moderated
 * one refuses exactly what the primary already refused.
 *
 * Was `google/gemini-2.0-flash-lite-001`, which OpenRouter retired. It returned
 * 404 "No endpoints found" for every refusal from 2026-05-21 until 2026-08-27
 * — three months during which refused posts had no fallback at all, just an
 * `api_error` in the ledger. Both ids are now covered by
 * scripts/check-model-ids-live.ts so the next retirement fails a build.
 *
 * Smoke-tested 2026-08-27 on zh/en adult roleplay, dark framings and engine
 * directives: 6/6, zero refusals. Worth stating because its larger sibling
 * deepseek-v4-pro DID refuse a community thread in the same day's bakeoff
 * ("contains explicit sexual material") despite both being `is_moderated: false`
 * in the catalog. The flag is not evidence, and permissiveness does not travel
 * across a model family.
 */
export const TRANSLATION_FALLBACK_MODEL = "deepseek/deepseek-v4-flash-0731";
/** Deadline for one model call. See the fetch in requestTranslationRaw. */
const REQUEST_TIMEOUT_MS = 180_000;

export const SUPPORTED_LANGS = ["zh", "en", "es", "ja"] as const;
export type SupportedLang = (typeof SUPPORTED_LANGS)[number];

const LANG_NAMES: Record<SupportedLang, string> = {
  zh: "Chinese",
  en: "English",
  es: "Spanish",
  ja: "Japanese",
};

type TranslationSourceType = "thread" | "post" | "review" | "review_reply" | "event";

/**
 * Identity of the exact source text a translation was produced from.
 *
 * Callers hand us a content snapshot, then we spend several seconds in the
 * model. In that window the author may edit the post. Both the cache-hit check
 * and the final write compare this hash so a translation is only ever stored
 * against the revision it actually describes.
 */
export function sourceTextHash(content: string, title?: string): string {
  return createHash("sha256")
    .update(`${title ?? ""}\u0000${content}`)
    .digest("hex");
}

/**
 * Is a cached row a translation of the revision we were asked to translate?
 *
 * A NULL hash is a row written before hashing existed — treat it as stale so
 * the next write regenerates it rather than serving a possibly-pre-edit
 * translation forever.
 */
export function isCacheFresh(
  existingHash: string | null | undefined,
  requestHash: string,
): boolean {
  return existingHash != null && existingHash === requestHash;
}

/**
 * At write time, should we throw away what the model produced?
 *
 * True when the source row changed while we were in the model, i.e. the author
 * edited during the several seconds a translation takes. Writing then would
 * pin a pre-edit translation onto post-edit content, which is exactly what
 * users saw as "I edited it but the translation is still the old text".
 *
 * Events are exempt: they carry multi-field content and translateEventOne owns
 * its own overwrite semantics, so existence is their only guard.
 */
export function shouldDiscardStaleResult(
  liveHash: string | null,
  requestHash: string,
  sourceType: TranslationSourceType,
): boolean {
  if (liveHash === null) return true; // source deleted while translating
  if (sourceType === "event") return false;
  return liveHash !== requestHash;
}

/** Re-read a source row so the write can verify it still holds the text we translated. */
async function currentSourceHash(
  tx: typeof db,
  sourceId: string,
  sourceType: TranslationSourceType,
  withTitle: boolean,
): Promise<string | null> {
  switch (sourceType) {
    case "thread": {
      const [row] = await tx
        .select({ content: threads.content, title: threads.title })
        .from(threads)
        .where(eq(threads.id, sourceId))
        .for("key share")
        .limit(1);
      return row ? sourceTextHash(row.content ?? "", withTitle ? row.title : undefined) : null;
    }
    case "post": {
      const [row] = await tx
        .select({ content: posts.content })
        .from(posts)
        .where(eq(posts.id, sourceId))
        .for("key share")
        .limit(1);
      return row ? sourceTextHash(row.content ?? "") : null;
    }
    case "review": {
      const [row] = await tx
        .select({ content: reviews.content })
        .from(reviews)
        .where(eq(reviews.id, sourceId))
        .for("key share")
        .limit(1);
      return row ? sourceTextHash(row.content ?? "") : null;
    }
    case "review_reply": {
      const [row] = await tx
        .select({ content: reviewReplies.content })
        .from(reviewReplies)
        .where(eq(reviewReplies.id, sourceId))
        .for("key share")
        .limit(1);
      return row ? sourceTextHash(row.content ?? "") : null;
    }
    case "event": {
      const [row] = await tx
        .select({ id: communityEvents.id })
        .from(communityEvents)
        .where(eq(communityEvents.id, sourceId))
        .for("key share")
        .limit(1);
      // Events carry multi-field content and run through translateEventOne,
      // which owns its own overwrite semantics. Existence is the only guard.
      return row ? "" : null;
    }
  }
}

/**
 * Why a translation attempt produced no cache row.
 *
 * `no_prose` is terminal: the source carries nothing to translate (an invite
 * code, "+1", a bare URL, emoji), so retrying just burns tokens to reach the
 * same conclusion. Everything else is transient and worth several retries.
 *
 * `echo` used to be terminal too, on the theory that a second verbatim answer
 * means the source is language-neutral. hasTranslatableProse() now settles
 * the language-neutral sources before any model call, so what reaches echo
 * detection is prose the model failed on — and it does fail on real prose:
 * thread 7a7a08c8's Spanish translation sat exhausted at 2/2 echoes on
 * 2026-09-06 while the same text translated cleanly 24/24 when re-asked. Two
 * tries is the wrong budget for a model glitch.
 *
 * `placeholder` and `wrong_language` are the same shape: the model answered
 * with something other than a translation, which says nothing about the
 * source. All three ride the transient backoff.
 */
export type TranslationSkipReason =
  | "no_api_key"
  | "api_error"
  | "empty_response"
  | "parse_error"
  | "refused"
  | "echo"
  | "placeholder"
  | "wrong_language"
  | "no_prose"
  | "source_changed"
  | "source_deleted";

const TERMINAL_REASONS: readonly TranslationSkipReason[] = ["no_prose"];

export const MAX_ATTEMPTS_TERMINAL = 2;
export const MAX_ATTEMPTS_TRANSIENT = 5;
/** First retry after 30 min, then 1h, 2h, 4h, 8h. */
export const RETRY_BASE_MINUTES = 30;

export function maxAttemptsFor(reason: TranslationSkipReason | null | undefined): number {
  return reason != null && (TERMINAL_REASONS as readonly string[]).includes(reason)
    ? MAX_ATTEMPTS_TERMINAL
    : MAX_ATTEMPTS_TRANSIENT;
}

/**
 * Is this (source, revision, language) still owed another try?
 *
 * The sweeper's candidate SQL mirrors this predicate so exhausted pairs stop
 * consuming its LIMIT. Keep the two in sync — see translation-sweeper.ts.
 */
export function shouldRetryAttempt(
  ledger: { attempts: number; lastReason: string | null; sourceHash: string; lastAttemptAt: Date } | null,
  requestHash: string,
  now: Date,
): boolean {
  if (!ledger) return true;
  // A new revision of the source is a clean slate.
  if (ledger.sourceHash !== requestHash) return true;
  const max = maxAttemptsFor(ledger.lastReason as TranslationSkipReason | null);
  if (ledger.attempts >= max) return false;
  const waitMs = RETRY_BASE_MINUTES * 60_000 * Math.pow(2, Math.min(ledger.attempts, 6));
  return now.getTime() - ledger.lastAttemptAt.getTime() >= waitMs;
}

/**
 * Re-exported from @yumina/shared, where the client can reach it too.
 *
 * The client needs the same verdict to know whether "translating..." is a true
 * statement: a source with no prose never gets a translation row, so without
 * this the UI promises a translation that is never coming. Reasoning for the
 * predicate itself lives in shared/utils/translatable-prose.ts.
 */
export { hasTranslatableProse };

async function readAttemptLedger(
  sourceId: string,
  sourceType: TranslationSourceType,
  targetLang: SupportedLang,
) {
  const [row] = await db
    .select({
      attempts: translationAttempts.attempts,
      lastReason: translationAttempts.lastReason,
      sourceHash: translationAttempts.sourceHash,
      lastAttemptAt: translationAttempts.lastAttemptAt,
    })
    .from(translationAttempts)
    .where(
      and(
        eq(translationAttempts.sourceId, sourceId),
        eq(translationAttempts.sourceType, sourceType),
        eq(translationAttempts.targetLang, targetLang),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Record that this attempt produced nothing, so the sweeper knows the pair is
 * outstanding and how hard we have already tried. Counting restarts whenever
 * the source hash changes.
 */
async function recordSkip(
  sourceId: string,
  sourceType: TranslationSourceType,
  targetLang: SupportedLang,
  requestHash: string,
  reason: TranslationSkipReason,
  attemptsOverride?: number,
): Promise<void> {
  try {
    await db
      .insert(translationAttempts)
      .values({
        sourceId,
        sourceType,
        targetLang,
        sourceHash: requestHash,
        attempts: attemptsOverride ?? 1,
        lastReason: reason,
        lastAttemptAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          translationAttempts.sourceType,
          translationAttempts.sourceId,
          translationAttempts.targetLang,
        ],
        set: {
          sourceHash: requestHash,
          attempts:
            attemptsOverride != null
              ? sql`${attemptsOverride}`
              : sql`CASE WHEN ${translationAttempts.sourceHash} = ${requestHash} THEN ${translationAttempts.attempts} + 1 ELSE 1 END`,
          lastReason: reason,
          lastAttemptAt: new Date(),
        },
      });
  } catch (err) {
    // The ledger is observability, never a gate on translating. A missing
    // table (fresh DB before self-heal) must not break the write path.
    console.warn(
      `[translate] could not record skip for ${sourceType}/${sourceId} → ${targetLang}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** A cache row landed — the pair is no longer outstanding. */
async function clearSkip(
  sourceId: string,
  sourceType: TranslationSourceType,
  targetLang: SupportedLang,
): Promise<void> {
  try {
    await db
      .delete(translationAttempts)
      .where(
        and(
          eq(translationAttempts.sourceId, sourceId),
          eq(translationAttempts.sourceType, sourceType),
          eq(translationAttempts.targetLang, targetLang),
        ),
      );
  } catch {
    /* best-effort */
  }
}

async function requestTranslationRaw(
  systemMessage: string,
  userMessage: string,
  triggeredByUserId: string,
  jsonMode: boolean,
  model: string,
): Promise<string | null> {
  const apiKey = env.YUMINA_OPENROUTER_KEY;
  if (!apiKey) {
    console.warn("[translate] YUMINA_OPENROUTER_KEY not set, skipping translation");
    return null;
  }

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemMessage },
      { role: "user", content: userMessage },
    ],
    temperature: 0.1,
    // Qwen3 235B is served by multiple OpenRouter providers at varying
    // prices ($0.07-$0.88/M output). Force routing to the cheapest one —
    // translation is a single-turn, latency-tolerant workload so the cheapest
    // provider is fine; without this OpenRouter sometimes routes to the VL
    // variant via Parasail/Novita at ~9x the headline output price.
    provider: { sort: "price" },
    // ZH→EN expands ~2.5x in length, so the cap has to clear 2.5x the longest
    // post we accept, not the average one. At 8192 the longest community
    // threads truncated mid-string and failed JSON.parse — four of them sat
    // permanently untranslated in the ledger as `parse_error`. Both models
    // above allow >=131072 output tokens, so this is a ceiling rather than a
    // reservation: a short comment still bills only the tokens it emits.
    max_tokens: 32768,
  };
  // json_object mode forces the model to emit valid JSON — no markdown
  // fences, no unescaped newlines inside string values. Without this Gemini
  // Flash occasionally writes literal line breaks inside strings and the
  // response fails JSON.parse.
  if (jsonMode) body.response_format = { type: "json_object" };

  const startTime = Date.now();
  let res: Response;
  try {
    res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      // A translation that hasn't answered in three minutes is not going to.
      // Without a deadline a single stalled connection blocks the caller
      // forever: on the write path that leaks a request, and in the sweeper it
      // wedges the whole pass, so later ticks pile up behind a dead socket.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // Network-level failures (timeout, DNS, reset) must return null rather than
    // throw: the caller turns null into a recorded, retryable skip, whereas a
    // throw would escape without a ledger row and leave the pair looping.
    const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "network error";
    console.error(`[translate] ${reason} after ${Date.now() - startTime}ms:`, err instanceof Error ? err.message : err);
    return null;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`[translate] API error ${res.status}: ${text}`);
    return null;
  }

  const data = await res.json() as {
    choices?: { message?: { content?: string } }[];
    id?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };
  };
  const raw = data.choices?.[0]?.message?.content?.trim();
  if (!raw) {
    console.error("[translate] Empty response from API");
    return null;
  }

  const promptTokens = data.usage?.prompt_tokens ?? 0;
  const completionTokens = data.usage?.completion_tokens ?? 0;
  if (promptTokens || completionTokens) {
    await recordUsageLog({
      ...usageObservation({promptTokens,completionTokens,totalTokens:promptTokens+completionTokens,providerCostUsd:data.usage?.cost,providerRequestId:data.id}),
      userId: triggeredByUserId,
      model,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      endpoint: "translation",
      apiKeyTier: "internal",
      generationTimeMs: Date.now() - startTime,
    });
  }

  return raw;
}

/**
 * The instructions every community translation is produced under.
 *
 * Exported because a model bakeoff that retypes this prompt measures the copy,
 * not what production actually sends — and the two would drift on the first
 * prompt tweak. scripts/translation-bakeoff/ imports it for that reason.
 *
 * Note the deliberate tension in the tone rule: the goal is prose that reads as
 * idiomatic in the target language while staying as casual and as messy as the
 * source. Translating a throwaway comment into polished copy is a failure here,
 * not an improvement (see the 08b6f2661 regression).
 *
 * The JSON clause used to show a fillable skeleton — `{"title": "<title in
 * Chinese>", ...}`. Community thread 7a7a08c8 was published to every Chinese
 * reader with exactly that skeleton as its translation on 2026-09-06: the
 * model echoed the source, the echo-retry prompt on top told it not to copy
 * the source, and with nothing else in front of it, it copied the template
 * instead. Name the keys, never hand the model a slot it can return unfilled.
 */
export function buildTranslationSystemPrompt(targetLang: SupportedLang, isJson: boolean): string {
  const targetLangName = LANG_NAMES[targetLang];
  return (
    `You are a professional translator. Translate the user's text into ${targetLangName}.\n` +
    `CRITICAL: Never return the source text unchanged. Output must be written in ${targetLangName}.\n` +
    `Preserve markdown, emoji, URLs, and code blocks verbatim — translate the prose around them.\n` +
    `Preserve proper nouns exactly as they appear in the source: character names, product names, place names, brand names, game terms (e.g. "VP", "KP", "S&P 500"). Do NOT invent or substitute names.\n` +
    `This is informal community / roleplay / gaming content — translate idioms and slang into natural target-language equivalents, not literal word-for-word.\n` +
    `Match the original tone, register, and structure. If the source is casual, short, or messy, the translation should feel the same. Do not polish, formalize, or clean up the writing style. A quick comment should still read like a quick comment.\n` +
    `Never use em dashes (—).\n` +
    (isJson
      ? `Respond with JSON only, no preamble: a JSON object with exactly the keys "title" and "content". ` +
        `Both values must be the ${targetLangName} translation of the corresponding source field, written out in full. ` +
        `Never answer with a description of the text, a field name, or bracketed placeholder text such as <...>.`
      : `Respond with the translated text only, no preamble or explanation.`)
  );
}

/** The source half of a translation request. Paired with the prompt above. */
export function buildTranslationUserMessage(content: string, title?: string): string {
  return title ? `Source title:\n${title}\n\nSource content:\n${content}` : content;
}

/**
 * Above this many source characters, one request cannot hold the answer.
 *
 * ZH->EN roughly doubles the character count and English runs ~4 chars/token,
 * so 20k source characters is already ~10k output tokens against a 32768
 * ceiling that also has to cover a reasoning model's hidden tokens. Production
 * has exactly one source over this line (a 106,810-char thread; the next
 * longest is 11,641), so raising the ceiling would have been a fix aimed at a
 * document that needs splitting, not more room.
 *
 * Everything under the threshold takes the single-request path unchanged —
 * splitting costs cross-chunk coherence, so it is not the default.
 */
export const CHUNK_THRESHOLD_CHARS = 20_000;
/**
 * Target size per chunk once splitting kicks in.
 *
 * Sized against REQUEST_TIMEOUT_MS, not against the token ceiling. At 10k a
 * single ZH->JA chunk blew the 180s deadline in the 2026-08-27 end-to-end run:
 * ~27k characters of output through a model with one provider endpoint takes
 * longer than the budget allows, and one timed-out chunk fails the whole
 * document by design. Smaller chunks cost more requests and one more seam
 * each, which is the cheaper side of that trade.
 */
export const CHUNK_BUDGET_CHARS = 6_000;
/** How much of the previous chunk is shown to the next one as an anchor. */
const CHUNK_CONTEXT_CHARS = 500;

/** Spans that a split must never land inside, as [start, end) offsets. */
function unsplittableSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  // Fenced code blocks. The unterminated case matters: an author who opened a
  // fence and never closed it would otherwise let every later boundary check
  // believe it is outside code.
  const fence = /```/g;
  let open: number | null = null;
  for (const m of text.matchAll(fence)) {
    if (open === null) open = m.index;
    else {
      spans.push([open, m.index + 3]);
      open = null;
    }
  }
  if (open !== null) spans.push([open, text.length]);
  // Markdown links and images: splitting between the label and the URL breaks
  // both halves, and the URL half is what the prompt promises to preserve.
  for (const m of text.matchAll(/!?\[[^\]]*\]\([^)]*\)/g)) {
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

const spanContaining = (pos: number, spans: Array<[number, number]>): [number, number] | undefined =>
  spans.find(([s, e]) => pos > s && pos < e);

/**
 * Split a source document into independently translatable pieces.
 *
 * Boundaries are chosen by preference — blank line, then any line break, then a
 * forced cut — because a chunk that ends mid-sentence gives the model half a
 * thought to translate and reads like it on the seam. A forced cut still refuses
 * to land inside a code fence or a markdown link, sliding forward past the whole
 * span instead; an oversized chunk is a cost problem, a corrupted URL is a
 * broken post.
 *
 * Returns `[content]` unchanged when it fits, which is the path essentially all
 * production content takes.
 */
export function splitForTranslation(content: string, budget = CHUNK_BUDGET_CHARS): string[] {
  if (content.length <= budget) return [content];

  const spans = unsplittableSpans(content);
  // Refuse to emit slivers: without a floor, a document whose only boundaries
  // sit near the start of each window degrades into many tiny requests, and
  // every extra seam is somewhere terminology can drift.
  const minChunk = Math.max(1, Math.floor(budget / 4));
  const chunks: string[] = [];

  let start = 0;
  while (start < content.length) {
    if (content.length - start <= budget) {
      chunks.push(content.slice(start));
      break;
    }

    const limit = start + budget;
    let end = -1;
    for (const sep of ["\n\n", "\n"]) {
      // lastIndexOf so the chunk stays as full as the budget allows.
      let candidate = content.lastIndexOf(sep, limit);
      while (candidate > start + minChunk) {
        if (!spanContaining(candidate, spans)) {
          end = candidate + sep.length;
          break;
        }
        candidate = content.lastIndexOf(sep, candidate - 1);
      }
      if (end !== -1) break;
    }

    if (end === -1) {
      // No usable line break in range — a wall of prose, or CJK with no
      // newlines at all. Cut at the budget, then slide past any span the cut
      // would have landed inside.
      end = limit;
      const blocking = spanContaining(end, spans);
      if (blocking) end = blocking[1];
    }

    // Guarantee forward progress no matter what the boundary search decided.
    if (end <= start) end = Math.min(content.length, start + budget);
    chunks.push(content.slice(start, end));
    start = end;
  }

  return chunks.filter((c) => c.length > 0);
}

/**
 * How a document will actually be requested: one piece, or several.
 *
 * The threshold and the budget are different numbers doing different jobs — the
 * threshold decides *whether* to split, the budget decides *where* — so the
 * decision lives here rather than at the call site, where reading one as the
 * other is easy and silent.
 */
export function chunksForTranslation(content: string): string[] {
  return content.length > CHUNK_THRESHOLD_CHARS ? splitForTranslation(content) : [content];
}

/**
 * The request body for chunk N of a split document.
 *
 * The previous chunk's source tail and its translation are shown together, and
 * labelled as reference rather than input. Seeing the pair is what pins
 * terminology: the model is not being asked to remember how it rendered a
 * character's name, it is being shown. Without this, a 100k-character roleplay
 * log comes back with the same speaker named three different ways depending on
 * which chunk they appeared in.
 */
export function buildChunkUserMessage(
  chunk: string,
  previous?: { source: string; translated: string },
): string {
  if (!previous) return chunk;
  const tail = (s: string) => s.slice(-CHUNK_CONTEXT_CHARS);
  return (
    `[CONTEXT — the immediately preceding part of this document. Do NOT translate or repeat it. ` +
    `Match its terminology, names, and register exactly.]\n` +
    `Source:\n${tail(previous.source)}\n\n` +
    `Your translation of it:\n${tail(previous.translated)}\n\n` +
    `[TRANSLATE ONLY WHAT FOLLOWS]\n${chunk}`
  );
}

/**
 * Sharpened instructions for the one retry we allow after the model returned
 * the source verbatim. Separate from the base prompt so the bakeoff can score a
 * candidate's echo rate before AND after the retry — a model that only needs
 * the nudge occasionally is fine; one that needs it constantly is not.
 */
export function buildEchoRetrySystemPrompt(base: string, targetLang: SupportedLang): string {
  return (
    base +
    `\n\nThe text you must translate is currently in a DIFFERENT language than ${LANG_NAMES[targetLang]}. ` +
    `Even if the source contains emoji, names, code, or unusual punctuation, translate the prose. ` +
    `Do NOT copy the source text into the output.`
  );
}

function cleanJsonTranslation(raw: string): string {
  return raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();
}

export function looksLikeRefusal(translated: string): boolean {
  // Qwen and other instruct models occasionally refuse to translate content
  // that reads like a jailbreak prompt (e.g. meta-discussions about
  // bypassing safety filters). Don't cache the refusal — that would show
  // up as the user-visible "translation" of a community post.
  //
  // A refusal is about the REQUEST, so the match has to name the request.
  // This used to fire on bare openers ("i can't", "sorry, i", "i'm sorry"),
  // which are also how a translated complaint begins: 我也都找不到 → "I can't
  // find them either", 抱歉我已經兌換完了 → "Sorry, I already redeemed it". All
  // three `refused` pairs in the prod ledger on 2026-09-06 were that, each one
  // re-sent through the fallback model five times and never cached, so those
  // posts had no English translation at all.
  const head = translated.trim().slice(0, 200);
  const lower = head.toLowerCase();
  return (
    // "can't help" alone is an idiom ("can't help but laugh"); require the
    // object a model would name.
    /\b(?:can(?:no|')t|cannot|unable to|won't|will not|not able to)\s+(?:help (?:you )?with|assist|translate|fulfil|fulfill|comply|provide a translation)\b/.test(lower) ||
    /\b(?:this|that|your) request\b/.test(lower) && /\b(?:can(?:no|')t|cannot|unable|decline)\b/.test(lower) ||
    lower.startsWith("as an ai") ||
    /\bas an? (?:ai|language model)\b/.test(lower) ||
    // The same refusal, when the model answers in the target language.
    /(?:无法|不能)(?:翻译|协助|提供翻译)|翻訳(?:することは|することが|は)?できません|no puedo (?:traducir|ayudar con)/.test(head)
  );
}

/**
 * Did the answer come back in the language we asked for?
 *
 * Echo-detection compares bytes, so it is blind to an answer that is the
 * source re-spelled: every Traditional Chinese post on the forum that the
 * model bailed on has a "Japanese" or "Spanish" translation that is the same
 * sentence in Simplified characters (0758d56c, b8f5a2a1, 60888e04, dd3a5a80
 * in prod), and the one 106k-character thread came back as 45k characters of
 * "Spanish" that is 41% Chinese because half its chunks echoed. None of that
 * is the source verbatim, all of it is untranslated.
 *
 * Script is the honest signal. Nothing is Japanese without kana; nothing is
 * English or Spanish while a fifth of it is han; and a Chinese answer to a
 * Latin-script source has to contain more han than the source did. That last
 * clause is source-relative on purpose — a mixed post like "Deepseek V3.2
 * 已恢复" is 20% han and legitimately stays that way when translated INTO
 * Chinese from English, but is an echo when it was Chinese to begin with.
 *
 * Judged only when there is enough prose to judge: a source with fewer than
 * ten letters (an invite code, "gg", a model name) has no script to speak of.
 */
export function looksLikeUntranslated(translated: string, source: string, targetLang: SupportedLang): boolean {
  const strip = (s: string) =>
    s
      .replace(/!?\[[^\]]*]\([^)]+\)/g, "")
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`[^`]+`/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/\s/g, "");
  const src = strip(source);
  if ((src.match(/\p{L}/gu)?.length ?? 0) < 10) return false;
  const out = strip(translated);
  if (out.length === 0) return false;

  const ratio = (s: string, re: RegExp) => (s.match(re)?.length ?? 0) / s.length;
  const HAN = /[一-鿿㐀-䶿]/g;
  const KANA = /[぀-ゟ゠-ヿ]/g;
  const hanOut = ratio(out, HAN);
  const kanaOut = ratio(out, KANA);
  const hanSrc = ratio(src, HAN);
  const kanaSrc = ratio(src, KANA);

  switch (targetLang) {
    case "ja":
      return kanaOut < 0.02;
    case "zh":
      if (hanOut < 0.1) return true;
      if (kanaOut >= 0.02) return true;
      // Latin-script source: the answer must have gained han, not kept the
      // few it had. A Chinese source misfiled as English comes back unchanged
      // and fails here; a real translation of English gains plenty.
      return hanSrc < 0.3 && kanaSrc < 0.02 && hanOut <= hanSrc + 0.05;
    case "en":
    case "es":
      // 0.2, not the 0.3 detectLang uses for "is Chinese": a translation INTO
      // Latin script expands ~2x, so one echoed chunk in two dilutes to about
      // a quarter han. Real English quoting a card title sits under a tenth.
      return hanOut >= 0.2 || kanaOut >= 0.02;
  }
}

/**
 * Did the model hand back the answer skeleton instead of an answer?
 *
 * Every other guard here compares the output against the source. This one has
 * to exist because the failure it catches resembles neither the source nor a
 * refusal: on 2026-09-06 thread 7a7a08c8 was cached with `translated_title`
 * `<title in Chinese>` and `translated_content` `<content in Chinese>` — the
 * literal template out of the prompt, 18 completion tokens, valid JSON, past
 * every check, straight onto the page every Chinese reader saw.
 *
 * The prompt no longer offers a skeleton to copy, so this is the second lock
 * rather than the first. Match on shape, not on wording: a field that is one
 * bracketed span and nothing else is never a translation, whatever it says
 * inside. The `or null` tail covers the optional field in the event prompt.
 *
 * Real prose containing angle brackets (`<b>bold</b>`, `i <3 this card`) is
 * unaffected — it is only a placeholder when the bracket is the whole field.
 */
export function looksLikePlaceholder(translated: string): boolean {
  return /^<[^<>]{0,80}>(\s+or\s+null)?$/i.test(translated.trim());
}

export function looksLikeEcho(translated: string, source: string): boolean {
  // Flash-Lite occasionally returns the source verbatim when content has
  // heavy emoji / unusual punctuation / mixed scripts. Compare prose only —
  // strip markdown image/link URLs, code fences, and HTML before comparing,
  // since the prompt instructs the model to preserve those verbatim. Without
  // this, posts whose body is dominated by markdown image links got flagged
  // as echo even though the prose around the URLs was actually translated.
  const stripVerbatim = (s: string) =>
    s
      .replace(/!?\[[^\]]*]\([^)]+\)/g, "")
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`[^`]+`/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/https?:\/\/\S+/g, "")
      .trim();

  const a = stripVerbatim(translated);
  const b = stripVerbatim(source);
  if (a === b) return true;
  if (a.length === 0 || b.length === 0) return false;
  // Length similarity: a real translation between EN ↔ ZH ↔ ES typically
  // differs by 25%+. If lengths are within 3%, very likely an echo.
  const ratio = Math.abs(a.length - b.length) / Math.max(a.length, b.length);
  if (ratio < 0.03 && a.length > 40) {
    // Spot-check: count how many of the first 20 non-space chars match.
    const stripWs = (s: string) => s.replace(/\s/g, "");
    const sa = stripWs(a).slice(0, 40);
    const sb = stripWs(b).slice(0, 40);
    let same = 0;
    for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
      if (sa[i] === sb[i]) same++;
    }
    if (same / Math.min(sa.length, sb.length) > 0.8) return true;
  }
  return false;
}

export async function translateOne(
  sourceId: string,
  sourceType: TranslationSourceType,
  targetLang: SupportedLang,
  content: string,
  triggeredByUserId: string,
  title?: string,
): Promise<void> {
  const requestHash = sourceTextHash(content, title);

  // One attempt, one ledger increment. Several of the bail-outs below sit
  // downstream of each other (a JSON parse failure also makes the caller see
  // a null result), and double-counting would exhaust the retry budget at
  // twice the intended rate.
  let skipRecorded = false;
  const noteSkip = async (reason: TranslationSkipReason, attemptsOverride?: number) => {
    if (skipRecorded) return;
    skipRecorded = true;
    await recordSkip(sourceId, sourceType, targetLang, requestHash, reason, attemptsOverride);
  };

  const [existing] = await db
    .select({ id: contentTranslations.id, sourceHash: contentTranslations.sourceHash })
    .from(contentTranslations)
    .where(
      and(
        eq(contentTranslations.sourceId, sourceId),
        eq(contentTranslations.sourceType, sourceType),
        eq(contentTranslations.targetLang, targetLang),
      ),
    )
    .limit(1);

  // Only a translation of *this* revision counts as a cache hit. A row with a
  // different hash describes a pre-edit revision; NULL means it predates
  // hashing. Both need regenerating — and both stay readable until the
  // replacement lands, so a failed regeneration degrades to a stale
  // translation instead of no translation at all.
  if (existing && isCacheFresh(existing.sourceHash, requestHash)) {
    await clearSkip(sourceId, sourceType, targetLang);
    return;
  }

  // Everything below costs an API call, so consult the outcome ledger first.
  // Without this the sweeper would re-litigate the same hopeless pair on
  // every pass, and an edit that restores previously-failing text would
  // retry it immediately instead of on the backoff schedule.
  const ledger = await readAttemptLedger(sourceId, sourceType, targetLang);
  if (!shouldRetryAttempt(ledger, requestHash, new Date())) return;

  // A bare invite code, URL, "+1" or a row of emoji has nothing to translate.
  // Deciding that here (rather than paying for two API calls and letting
  // echo-detection reach the same answer) keeps them out of the retry queue
  // and names them honestly in the health report.
  if (!hasTranslatableProse(content, title)) {
    // A row that survived the freshness check above describes text that is
    // gone, and what replaced it has nothing to translate — so the row is
    // wrong by construction, not merely stale. Left in place it is what
    // readers see: prod post 83cc7bc6 showed Spanish readers invite code
    // "SG32JUE" for a post whose only content is "SG32THUR".
    if (existing) {
      await db.delete(contentTranslations).where(eq(contentTranslations.id, existing.id));
    }
    await noteSkip("no_prose", MAX_ATTEMPTS_TERMINAL);
    return;
  }

  const chunks = chunksForTranslation(content);
  const isChunked = chunks.length > 1;
  // JSON mode carries the title and body in one response, which only works
  // when the body is one response. A chunked run translates the title on its
  // own and takes each body chunk back as plain prose.
  const isJson = Boolean(title) && !isChunked;

  const systemMessage = buildTranslationSystemPrompt(targetLang, isJson);
  const userMessage = buildTranslationUserMessage(content, title);

  /** One request for the whole document — the path all but one source takes. */
  const attemptWhole = async (sysMsg: string, model: string): Promise<{ title: string | null; content: string } | null> => {
    const raw = await requestTranslationRaw(sysMsg, userMessage, triggeredByUserId, isJson, model);
    if (!raw) return null;
    if (!isJson) return { title: null, content: raw };
    try {
      const parsed = JSON.parse(cleanJsonTranslation(raw));
      if (typeof parsed.content !== "string") return null;
      return { title: parsed.title ?? null, content: parsed.content };
    } catch {
      // Parse failure — don't cache markdown-wrapped raw text. The skip is
      // recorded so the sweeper (lib/translation-sweeper.ts) comes back for
      // it; any existing translation stays in place until a good one lands.
      console.warn(`[translate] JSON parse failed for ${sourceType}/${sourceId} → ${targetLang}; skipping cache`);
      await noteSkip("parse_error");
      return null;
    }
  };

  /**
   * Sequential chunk-by-chunk translation for a document no single response can
   * hold. Sequential rather than parallel on purpose: each chunk is shown the
   * previous one's translation, which is the whole mechanism keeping names and
   * register consistent across the seams.
   */
  const attemptChunked = async (sysMsg: string, model: string): Promise<{ title: string | null; content: string } | null> => {
    console.log(
      `[translate] ${sourceType}/${sourceId} → ${targetLang}: ${content.length} chars over ${chunks.length} chunks on ${model}`,
    );
    const parts: string[] = [];
    let previous: { source: string; translated: string } | undefined;

    for (const chunk of chunks) {
      const raw = await requestTranslationRaw(
        sysMsg,
        buildChunkUserMessage(chunk, previous),
        triggeredByUserId,
        false,
        model,
      );
      // One dead chunk fails the whole translation. Caching the parts that did
      // come back would publish a post that is half translated and half not,
      // with nothing to mark where the boundary is.
      if (!raw) return null;
      // Surface a mid-document refusal to the caller's refusal path by handing
      // it back as the result: the retry then re-runs the whole document on the
      // permissive fallback, rather than stitching two models' voices together.
      if (looksLikeRefusal(raw)) return { title: null, content: raw };
      // An echoed chunk must fail here, per chunk. Judged only on the stitched
      // whole, one untranslated chunk among twenty passes every ratio and
      // ships: the 106k-character prod thread's "Spanish" translation is 41%
      // han for exactly that reason. The ledger gets the specific reason so
      // the sweeper's next pass re-runs the document; the caller's own
      // `api_error` note below is then a no-op.
      if (looksLikeEcho(raw, chunk) || looksLikeUntranslated(raw, chunk, targetLang)) {
        console.warn(
          `[translate] chunk ${parts.length + 1}/${chunks.length} of ${sourceType}/${sourceId} → ${targetLang} came back untranslated; failing the document`,
        );
        await noteSkip(looksLikeEcho(raw, chunk) ? "echo" : "wrong_language");
        return null;
      }

      // The model drops the chunk's trailing newlines, so re-apply the source's
      // own separator. Joining on a fixed "\n\n" would invent paragraph breaks
      // at any boundary that had to be a hard cut mid-paragraph.
      parts.push(raw.trimEnd() + (chunk.match(/\s*$/)?.[0] ?? ""));
      previous = { source: chunk, translated: raw };
    }

    let translatedTitle: string | null = null;
    if (title) {
      const rawTitle = await requestTranslationRaw(
        buildTranslationSystemPrompt(targetLang, false),
        title,
        triggeredByUserId,
        false,
        model,
      );
      if (!rawTitle) return null;
      translatedTitle = rawTitle;
    }

    return { title: translatedTitle, content: parts.join("") };
  };

  const attempt = isChunked ? attemptChunked : attemptWhole;

  const resultIsRefusal = (r: { title: string | null; content: string }): boolean =>
    looksLikeRefusal(r.content) || (r.title != null && looksLikeRefusal(r.title));

  let result = await attempt(systemMessage, TRANSLATION_PRIMARY_MODEL);
  if (!result) {
    // requestTranslationRaw already logged the specific cause; the ledger
    // only needs to know this pair is outstanding and retryable.
    await noteSkip("api_error");
    return;
  }

  // Refusal-fallback: Qwen3 has a stricter safety filter than Gemini and
  // refuses ~1% of community posts (mostly meta-discussions that themselves
  // quote jailbreak prompts). For NSFW-tolerant community content, retry
  // refusals with Gemini Flash-Lite, which historically handled this fine.
  // If both refuse, skip cache.
  if (resultIsRefusal(result)) {
    console.warn(
      `[translate] primary refused ${sourceType}/${sourceId} → ${targetLang}; trying fallback`,
    );
    const fallback = await attempt(systemMessage, TRANSLATION_FALLBACK_MODEL);
    if (!fallback) {
      await noteSkip("api_error");
      return;
    }
    if (resultIsRefusal(fallback)) {
      console.warn(
        `[translate] fallback also refused ${sourceType}/${sourceId} → ${targetLang}; skipping cache`,
      );
      await noteSkip("refused");
      return;
    }
    result = fallback;
  }

  // Echo-detection: if the model returned the source verbatim (a known
  // Flash-Lite failure mode on emoji-heavy or unusual content), retry with
  // a sharper directive. If the retry still echoes, give up — don't cache
  // garbage. Any translation already cached is deliberately left intact, and
  // the ledger caps this pair at MAX_ATTEMPTS_TERMINAL tries: a second echo
  // usually means the source is language-neutral, not that we got unlucky.
  //
  // For title-bearing translations, only treat as echo when BOTH title and
  // content echo. An image-heavy thread has a real Chinese title (which gets
  // translated) plus a body that's pure markdown URLs (correctly preserved
  // verbatim by the model). Demanding non-echo on both halves would discard
  // the translated title.
  const computeIsEcho = (r: { title: string | null; content: string }): boolean => {
    const contentEcho = looksLikeEcho(r.content, content);
    if (title == null) return contentEcho;
    const titleEcho = r.title != null && looksLikeEcho(r.title, title);
    return contentEcho && titleEcho;
  };
  // Same retry, wider net: an answer in the wrong script is an echo the byte
  // comparison cannot see (see looksLikeUntranslated). The body is judged
  // when it has prose; a title-only source is judged on its title.
  const computeIsUntranslated = (r: { title: string | null; content: string }): boolean =>
    looksLikeUntranslated(r.content, content, targetLang) ||
    (title != null && r.title != null && looksLikeUntranslated(r.title, title, targetLang));

  // The echo retry tells the model not to copy the source. For a source with
  // real prose that is the right push; for one the prose filter let through on
  // a technicality — a vowel-less invite code, "\ o /" — it is an instruction
  // to make something up, and on 2026-09-06 the model obliged with
  // 哈哈哈哈哈哈哈哈 for MXPCXDDH. Same ten-letter bar looksLikeUntranslated
  // uses: below it an echo is taken at face value and closed out like
  // no_prose, because that is what the model just told us it is.
  const sourceLetters = `${title ?? ""} ${content}`
    .replace(/!?\[[^\]]*]\([^)]+\)/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .match(/\p{L}/gu)?.length ?? 0;
  if (sourceLetters < 10 && computeIsEcho(result)) {
    if (existing) {
      await db.delete(contentTranslations).where(eq(contentTranslations.id, existing.id));
    }
    await noteSkip("no_prose", MAX_ATTEMPTS_TERMINAL);
    return;
  }

  if (computeIsEcho(result) || computeIsUntranslated(result)) {
    const retry = await attempt(buildEchoRetrySystemPrompt(systemMessage, targetLang), TRANSLATION_PRIMARY_MODEL);
    if (!retry) {
      await noteSkip("api_error");
      return;
    }
    if (computeIsEcho(retry)) {
      console.warn(
        `[translate] echo on retry for ${sourceType}/${sourceId} → ${targetLang}; skipping cache`,
      );
      await noteSkip("echo");
      return;
    }
    if (computeIsUntranslated(retry)) {
      console.warn(
        `[translate] wrong-language answer on retry for ${sourceType}/${sourceId} → ${targetLang}; skipping cache`,
      );
      await noteSkip("wrong_language");
      return;
    }
    result = retry;
  }

  // Placeholder-detection, last gate before the write so it covers whichever
  // of the three model calls above produced the result we are about to cache.
  // The echo-retry is where it actually happened (see looksLikePlaceholder),
  // and that path already reaches here having passed refusal and echo. No
  // in-run retry: a fourth call would re-ask the model that just failed, and
  // `placeholder` is transient, so the sweeper comes back on the backoff
  // schedule — by then, against a prompt with no skeleton in it.
  if (looksLikePlaceholder(result.content) || (result.title != null && looksLikePlaceholder(result.title))) {
    console.warn(
      `[translate] placeholder answer for ${sourceType}/${sourceId} → ${targetLang}; skipping cache`,
    );
    await noteSkip("placeholder");
    return;
  }

  let discarded: TranslationSkipReason | null = null;
  await db.transaction(async (tx) => {
    // Lock the source through the cache write. Two things are being checked at
    // once, both under that lock:
    //
    //  - The source still exists. A concurrent content/account delete waits
    //    here, removes the source, and its post-delete orphan sweep removes
    //    this translation. If deletion already won, skip the write.
    //  - The source still holds the text we actually translated. We were in
    //    the model for several seconds; if the author edited during that
    //    window, this result describes a revision that no longer exists.
    //    Writing it would pin a stale translation to a fresh post — the exact
    //    failure users hit when they edited a post right after posting.
    const liveHash = await currentSourceHash(tx as unknown as typeof db, sourceId, sourceType, title != null);
    if (shouldDiscardStaleResult(liveHash, requestHash, sourceType)) {
      if (liveHash !== null) {
        console.warn(
          `[translate] source ${sourceType}/${sourceId} changed while translating → ${targetLang}; discarding stale result`,
        );
      }
      discarded = liveHash === null ? "source_deleted" : "source_changed";
      return;
    }

    // Overwrite rather than skip-on-conflict: the row may hold a pre-edit
    // translation that this result supersedes. The hash guard above is what
    // makes last-write-wins safe — a losing in-flight request has already
    // returned by now.
    await tx
      .insert(contentTranslations)
      .values({
        sourceId,
        sourceType,
        targetLang,
        translatedTitle: result.title,
        translatedContent: result.content,
        sourceHash: requestHash,
      })
      .onConflictDoUpdate({
        target: [
          contentTranslations.sourceId,
          contentTranslations.sourceType,
          contentTranslations.targetLang,
        ],
        set: {
          translatedTitle: result.title,
          translatedContent: result.content,
          sourceHash: requestHash,
        },
      });
  });

  // Settle the ledger. A source that changed under us still owes a translation,
  // so it stays on the books against the revision we translated — the live
  // revision hashes differently, which resets the counter and gets a fresh try.
  // A source that was deleted owes nothing, same as a successful write.
  if (discarded !== null && discarded !== "source_deleted") {
    await noteSkip(discarded);
  } else {
    await clearSkip(sourceId, sourceType, targetLang);
  }
}

/**
 * Translate content into every supported language other than the source.
 * Fire-and-forget: caller should invoke with `.catch(() => {})`.
 *
 * `triggeredByUserId` is the user whose action caused this translation
 * (poster, replier, admin who created the announcement, etc.). It is required
 * so usage_logs has proper attribution. Translation runs on the company's
 * OpenRouter key (apiKeyTier "internal") so it does not deduct from wallets.
 */
export async function translateContent(
  sourceId: string,
  sourceType: TranslationSourceType,
  sourceLang: SupportedLang,
  content: string,
  triggeredByUserId: string,
  title?: string,
): Promise<void> {
  const targets = SUPPORTED_LANGS.filter((l) => l !== sourceLang);
  await Promise.all(
    targets.map((target) =>
      translateOne(sourceId, sourceType, target, content, triggeredByUserId, title).catch((err) => {
        console.error(`[translate] ${sourceType}/${sourceId} → ${target} failed:`, err);
      }),
    ),
  );
}

async function translateEventOne(
  sourceId: string,
  targetLang: SupportedLang,
  input: {
    title: string;
    introduction: string;
    rewardDescription?: string | null;
    triggeredByUserId: string;
  },
  overwrite: boolean,
): Promise<void> {
  const [existing] = await db
    .select({ id: contentTranslations.id })
    .from(contentTranslations)
    .where(
      and(
        eq(contentTranslations.sourceId, sourceId),
        eq(contentTranslations.sourceType, "event"),
        eq(contentTranslations.targetLang, targetLang),
      ),
    )
    .limit(1);

  if (existing && !overwrite) return;

  const targetLangName = LANG_NAMES[targetLang];
  const systemMessage =
    `You are a professional translator. Translate the user's event into ${targetLangName}.\n` +
    `CRITICAL: Never return the source text unchanged. Output must be written in ${targetLangName}.\n` +
    `Preserve markdown, emoji, and line breaks within each field.\n` +
    `Match the original tone and register. Do not polish or formalize the writing style.\n` +
    `Never use em dashes (—).\n` +
    // Keys named, no fillable slots. Same reason as buildTranslationSystemPrompt:
    // a skeleton in the prompt is something the model can answer with.
    `Respond with JSON only, no preamble: a JSON object with exactly the keys "title", "introduction" and "rewardDescription". ` +
    `"title" and "introduction" must be the ${targetLangName} translation of the corresponding source field, written out in full; ` +
    `"rewardDescription" must be the ${targetLangName} translation of the rewards, or null when the source has none. ` +
    `Never answer with a description of the text, a field name, or bracketed placeholder text such as <...>.`;
  const userMessage =
    `Title:\n${input.title}\n\n` +
    `Introduction:\n${input.introduction}\n\n` +
    `Rewards:\n${input.rewardDescription?.trim() || "null"}`;

  const attempt = async (sysMsg: string) => {
    const raw = await requestTranslationRaw(sysMsg, userMessage, input.triggeredByUserId, true, TRANSLATION_PRIMARY_MODEL);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(cleanJsonTranslation(raw));
      const intro =
        typeof parsed.introduction === "string"
          ? parsed.introduction
          : typeof parsed.content === "string"
            ? parsed.content
            : null;
      if (!intro) return null;
      return {
        title: typeof parsed.title === "string" ? parsed.title : null,
        introduction: intro,
        rewardDescription:
          typeof parsed.rewardDescription === "string" ? parsed.rewardDescription : null,
      };
    } catch {
      console.warn(`[translate] JSON parse failed for event/${sourceId} → ${targetLang}; skipping cache`);
      return null;
    }
  };

  let result = await attempt(systemMessage);
  if (!result) return;

  const isEcho =
    (result.title != null && looksLikeEcho(result.title, input.title)) ||
    looksLikeEcho(result.introduction, input.introduction);
  if (isEcho) {
    const retrySys =
      systemMessage +
      `\n\nThe source is in a DIFFERENT language than ${targetLangName}. ` +
      `Even with emojis or unusual punctuation, do not echo the source verbatim — translate the prose.`;
    const retry = await attempt(retrySys);
    if (!retry) return;
    if (
      (retry.title != null && looksLikeEcho(retry.title, input.title)) ||
      looksLikeEcho(retry.introduction, input.introduction)
    ) {
      console.warn(`[translate] echo on retry for event/${sourceId} → ${targetLang}; skipping cache`);
      return;
    }
    result = retry;
  }

  // Same last gate as translateOne. Events have no retry ledger, so the two
  // required fields fail the whole translation (an admin re-run is the retry)
  // while the optional one degrades to null rather than taking the event down
  // with it.
  if (looksLikePlaceholder(result.introduction) || (result.title != null && looksLikePlaceholder(result.title))) {
    console.warn(`[translate] placeholder answer for event/${sourceId} → ${targetLang}; skipping cache`);
    return;
  }

  const translatedTitle = result.title;
  const translatedIntroduction = result.introduction;
  const translatedRewardDescription =
    result.rewardDescription != null && looksLikePlaceholder(result.rewardDescription)
      ? null
      : result.rewardDescription;

  const translatedContent = JSON.stringify({
    introduction: translatedIntroduction,
    rewardDescription: translatedRewardDescription,
  });

  if (existing) {
    await db
      .update(contentTranslations)
      .set({
        translatedTitle,
        translatedContent,
      })
      .where(eq(contentTranslations.id, existing.id));
    return;
  }

  await db
    .insert(contentTranslations)
    .values({
      sourceId,
      sourceType: "event",
      targetLang,
      translatedTitle,
      translatedContent,
    })
    .onConflictDoNothing();
}

export async function translateEventContent(
  sourceId: string,
  sourceLang: SupportedLang,
  input: {
    title: string;
    introduction: string;
    rewardDescription?: string | null;
    triggeredByUserId: string;
  },
  options?: { overwrite?: boolean },
): Promise<void> {
  const targets = SUPPORTED_LANGS.filter((l) => l !== sourceLang);
  await Promise.all(
    targets.map((target) =>
      translateEventOne(sourceId, target, input, options?.overwrite ?? false).catch((err) => {
        console.error(`[translate] event/${sourceId} → ${target} failed:`, err);
      }),
    ),
  );
}
