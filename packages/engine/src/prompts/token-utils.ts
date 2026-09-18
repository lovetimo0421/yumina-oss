import { Tiktoken } from "js-tiktoken/lite";

// Lazy-init encoder — cl100k_base is the closest match for GPT-family models.
//
// The rank data is loaded via dynamic import() of "js-tiktoken/ranks/cl100k_base"
// instead of the "js-tiktoken" root entry: the root entry statically embeds ALL
// encodings (~5.5 MB minified), and because the editor imports the engine's
// prompt-builder for token counts, that payload landed in the editor's blocking
// chunk graph — on slow connections the editor spinner never resolved
// (2026-07-13 community report). The dynamic import keeps the ranks in their own
// async chunk that loads in the background; until it arrives (or if it fails),
// estimateTokens falls back to the character heuristic below.
let encoder: Tiktoken | null = null;
let preTokenPattern: string | null = null;
const utf8 = new TextEncoder();
const MAX_BPE_PIECE_BYTES = 256;
// Repeated prompt/overflow passes see the same immutable strings. Bound both
// retained text (about 4 MB of UTF-16) and entry overhead, including in browsers.
const tokenCache = new Map<string, number>();
let cachedChars = 0;
const MAX_CACHED_CHARS = 2_000_000;
const MAX_CACHE_ENTRIES = 1024;
let initFailed = false;
let loadPromise: Promise<void> | null = null;

/** Kick off (or join) the background load of the cl100k_base ranks.
 *  Servers should call this once at boot so counts are exact from the start;
 *  browsers just let the first estimateTokens call trigger it. */
export function preloadTokenizer(): Promise<void> {
  if (!loadPromise) {
    loadPromise = import("js-tiktoken/ranks/cl100k_base")
      .then((m) => {
        encoder = new Tiktoken(m.default);
        preTokenPattern = m.default.pat_str;
      })
      .catch(() => {
        // Rank data failed to load (offline, blocked CDN, missing files) —
        // permanent fallback to the heuristic.
        initFailed = true;
      });
  }
  return loadPromise;
}

function tryGetEncoder(): Tiktoken | null {
  if (encoder) return encoder;
  if (!initFailed) void preloadTokenizer();
  return null;
}

/** js-tiktoken repeatedly scans every adjacent byte pair when merging one
 * regex piece. A 20 KB repeated-letter run takes seconds on the HTTP thread.
 * Keep normal pieces exact, but count oversized pieces by their UTF-8 byte
 * upper bound. BPE cannot produce more tokens than input bytes. These are
 * tokenizer boundaries, so no merge crosses from a counted run into a suffix.
 * This affects budget estimates only; it never modifies the prompt text. */
function boundedTokenCount(text: string, enc: Tiktoken): number {
  if (!preTokenPattern || text.length <= MAX_BPE_PIECE_BYTES / 4) {
    return enc.encode(text).length;
  }
  let cursor = 0, tokens = 0;
  for (const match of text.matchAll(new RegExp(preTokenPattern, "ug"))) {
    const piece = match[0];
    // A Unicode scalar occupies at most four UTF-8 bytes.
    if (piece.length <= MAX_BPE_PIECE_BYTES / 4) continue;
    const bytes = utf8.encode(piece).length;
    if (bytes <= MAX_BPE_PIECE_BYTES) continue;
    if (match.index > cursor) tokens += enc.encode(text.slice(cursor, match.index)).length;
    tokens += bytes;
    cursor = match.index + piece.length;
  }
  return tokens + enc.encode(text.slice(cursor)).length;
}

/**
 * Models whose tokenizers count CJK characters roughly 1:1 (vs cl100k_base
 * which fragments each Chinese/Japanese/Korean character into ~2 BPE tokens).
 *
 * Using cl100k_base for these models causes our budget logic to ~2x overestimate
 * Chinese-heavy prompts and underutilize the user's context budget — e.g. a
 * 42k cap fills only ~22k of the model's actual tokenizer capacity. The
 * CJK-aware heuristic mirrors what these tokenizers do well enough for budgeting.
 *
 * Includes:
 * - Gemini — sentencepiece tokenizer with broad CJK coverage
 * - Claude — Anthropic's tokenizer is similarly CJK-efficient
 * - DeepSeek — V3/V4 tokenizer was trained with heavy Chinese corpora and
 *   merges most Chinese chars into single tokens (often denser than 1:1, but
 *   the heuristic is conservative). Confirmed against user reports of "set
 *   42k, only ~20k fills" with the cl100k_base path.
 *
 * Mirrors the strategy already used by `agent.ts:estimateTextTokens` in the
 * Studio AI chat path.
 */
function isCjkAwareModel(modelId?: string): boolean {
  if (!modelId) return false;
  const id = modelId.toLowerCase();
  return id.includes("gemini") || id.includes("claude") || id.includes("deepseek");
}

/**
 * Estimate tokens from precomputed character metrics instead of the string.
 *
 * Callers that only need token TOTALS (the memory panel's progress numbers)
 * can read `messages.content_len` / `content_cjk_len` and skip fetching the
 * bodies entirely — a 7k-message session went from ~52 MB of content off disk
 * plus multiple string-scanning passes on the single Node main thread (20-46 s
 * of event-loop block, the 2026-08-15 502 incident) to a few hundred KB of
 * integers.
 *
 * For CJK-aware models this reproduces estimateCjkAware() exactly. For the
 * others it returns the same character heuristic estimateTokens() falls back to
 * when the cl100k ranks are unavailable — a few percent off real BPE, which is
 * fine for a progress bar but NOT for building a prompt (that path still runs
 * the real tokenizer over real text).
 */
export function estimateTokensFromMetrics(
  totalChars: number,
  cjkChars: number,
  modelId?: string
): number {
  if (totalChars <= 0) return 0;
  const cjk = Math.min(Math.max(cjkChars, 0), totalChars);
  if (isCjkAwareModel(modelId)) {
    return Math.ceil(cjk + (totalChars - cjk) / 4);
  }
  return Math.ceil(totalChars / 3);
}

/**
 * CJK-aware character-count estimator: 1 token per CJK char, ~4 ASCII chars per
 * token. Approximates Gemini and Claude tokenizers reasonably well for both
 * Chinese-heavy and English-heavy text.
 */
function estimateCjkAware(text: string): number {
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // CJK Unified Ideographs, Hiragana/Katakana, Hangul, CJK punctuation
    if (
      (c >= 0x3000 && c <= 0x9fff) ||
      (c >= 0xac00 && c <= 0xd7af) ||
      (c >= 0xf900 && c <= 0xfaff)
    ) {
      cjk++;
    }
  }
  const ascii = text.length - cjk;
  return Math.ceil(cjk + ascii / 4);
}

/**
 * Estimate token count for budgeting decisions (lorebook trimming, history
 * windowing, etc.).
 *
 * - For Gemini, Claude, and DeepSeek models, uses a CJK-aware character
 *   heuristic that matches their tokenizers' efficient handling of CJK chars.
 * - For everything else (GPT family, Llama, Mistral, Grok, …) uses
 *   cl100k_base, with conservative UTF-8 byte counts for oversized BPE pieces
 *   that would otherwise cause quadratic CPU work.
 * - When `modelId` is omitted, defaults to cl100k_base. This is the safe choice
 *   for callers that don't have model context (e.g. world-level total token
 *   counts shown in browse/discovery), since cl100k tends to over-count rather
 *   than under-count, avoiding accidental context-window overflows.
 */
export function estimateTokens(text: string, modelId?: string): number {
  if (!text) return 0;
  if (isCjkAwareModel(modelId)) {
    return estimateCjkAware(text);
  }
  const enc = tryGetEncoder();
  if (enc) {
    try {
      const cached = tokenCache.get(text);
      if (cached !== undefined) {
        tokenCache.delete(text);
        tokenCache.set(text, cached);
        return cached;
      }
      const tokens = boundedTokenCount(text, enc);
      if (text.length <= 131_072) {
        tokenCache.set(text, tokens);
        cachedChars += text.length;
        while (cachedChars > MAX_CACHED_CHARS || tokenCache.size > MAX_CACHE_ENTRIES) {
          const oldest = tokenCache.keys().next().value;
          if (oldest === undefined) break;
          cachedChars -= oldest.length;
          tokenCache.delete(oldest);
        }
      }
      return tokens;
    } catch {
      // Encoding failed for this specific text — use heuristic
    }
  }
  // Heuristic: ~1 token per 3 chars (conservative, slightly overestimates for CJK safety)
  return Math.ceil(text.length / 3);
}
