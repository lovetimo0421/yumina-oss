/**
 * Asks the vision models for the card AI review (卡片 AI 初审). The prompt and
 * the decision live in world-ai-review-core.ts.
 */
import { env, PUBLIC_ORIGIN } from "./env.js";
import { createProvider } from "./llm/provider-factory.js";
import { getObjectBuffer } from "./s3.js";
import { isPublicCdnKey } from "./cdn-key-policy.js";
import { recordUsageLog } from "./usage-log.js";
import { coverToReviewJpeg } from "./world-ai-review-image.js";
import {
  authorSettings, decideWorldReview, parseWorldAnswer, modeTieBreakAllowed, reviewPromptText, reviewSystemPrompt, tieBreakAllowed,
  type ReviewPrecedent, type WorldAiReview, type WorldReviewInput,
} from "./world-ai-review-core.js";

export * from "./world-ai-review-core.js";

/** Two independent vision models; both must agree before a card clears.
 *  grok-4.3 reads explicit anime without refusing (10/24 tagging bench); a
 *  Gemini content block counts as "send to a person". */
export const WORLD_REVIEW_MODELS = ["x-ai/grok-4.3", "google/gemini-3-flash-preview"];
/** Stands in when a model fails twice or refuses (a content filter). Reads explicit art without refusing. */
export const WORLD_REVIEW_FALLBACK_MODEL = "x-ai/grok-4.7";
const REVIEW_TIMEOUT_MS = 60_000;

/** A cover key or URL as a small JPEG for the models. */
export async function loadCoverJpeg(key: string): Promise<Buffer> {
  let buffer: Buffer;
  if (/^https?:\/\//i.test(key)) {
    // Only our own public CDN. An author-supplied address is never fetched by
    // the server (it could point inside our network); such a cover goes to a person.
    const host = new URL(key).hostname;
    if (!new Set(["yumina.io", "www.yumina.io", new URL(PUBLIC_ORIGIN).hostname]).has(host)) {
      throw new Error(`external cover (${host})`);
    }
    const res = await fetch(key, { signal: AbortSignal.timeout(20_000), redirect: "error" });
    if (!res.ok) throw new Error(`cover ${res.status}`);
    buffer = Buffer.from(await res.arrayBuffer());
  } else {
    // Same rule as the public CDN: never another account's private file.
    if (key.includes("..") || !isPublicCdnKey(key)) throw new Error("cover is not a public file");
    buffer = (await getObjectBuffer(key, { maxBytes: 30 * 1024 * 1024 })).buffer;
  }
  return coverToReviewJpeg(buffer);
}

/**
 * Some endpoints refuse to switch thinking off (x-ai/grok-4.7, the stand-in and
 * third vote: 400 "Reasoning is mandatory for this endpoint and cannot be
 * disabled", 11/08). Those get the same question once more, thinking low, with
 * room for the thinking on top of the answer.
 */
async function askModel(model: string, input: WorldReviewInput, userId: string): Promise<Record<string, unknown>> {
  try {
    return await askModelOnce(model, input, userId, false);
  } catch (error) {
    if (!/reasoning is mandatory/i.test(error instanceof Error ? error.message : String(error))) throw error;
    return askModelOnce(model, input, userId, true);
  }
}

async function askModelOnce(model: string, input: WorldReviewInput, userId: string, thinking: boolean): Promise<Record<string, unknown>> {
  const provider = createProvider("openrouter", env.YUMINA_OPENROUTER_KEY);
  const started = Date.now();
  const inner = input.innerImages ?? [];
  const text = reviewPromptText(input);
  const images = [...(input.cover ? [input.cover] : []), ...inner]
    .map((buf) => ({ type: "image_url" as const, image_url: { url: `data:image/jpeg;base64,${buf.toString("base64")}` } }));
  let out = "";
  let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
  for await (const chunk of provider.generateStream({
    model,
    messages: [
      { role: "system", content: reviewSystemPrompt(input) },
      { role: "user", content: images.length ? [{ type: "text", text }, ...images] : text },
    ],
    maxTokens: thinking ? 4000 : 500,
    temperature: 0,
    responseFormat: { type: "json_object" },
    reasoningEffort: thinking ? "low" : "none",
    disableReasoning: !thinking,
    singleAttempt: true,
    signal: AbortSignal.timeout(REVIEW_TIMEOUT_MS),
  })) {
    if (chunk.type === "text") out += chunk.content;
    if (chunk.type === "done" && chunk.usage) usage = chunk.usage;
    if (chunk.type === "error") throw new Error(chunk.content || "review call failed");
  }
  if (usage) {
    void recordUsageLog({
      userId, model, endpoint: "world-ai-review",
      promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens,
      apiKeyTier: "internal", generationTimeMs: Date.now() - started,
    }).catch(() => { /* logged inside */ });
  }
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`${model} returned no JSON`);
  return JSON.parse(out.slice(start, end + 1)) as Record<string, unknown>;
}

/** Both models look at the card; decideWorldReview turns that into a verdict. */
export async function reviewWorld(
  input: WorldReviewInput,
  userId: string,
  opts: { editions?: number; models?: string[]; ask?: typeof askModel; retryDelayMs?: number; precedent?: ReviewPrecedent } = {},
): Promise<WorldAiReview> {
  const started = Date.now();
  const ask = opts.ask ?? askModel;
  // A busy provider (502/429) gets one more try; a content-filter refusal goes to
  // the fallback model instead (Gemini blocks explicit Limitless cards). 11/08:
  // three of the first day's cards went to a person only because a model failed.
  const once = async (model: string) => parseWorldAnswer(await ask(model, input, userId));
  const author = authorSettings(input);
  const REFUSAL = /blocked|safety|PROHIBITED|content filter|refus/i;
  const models = await Promise.all((opts.models ?? WORLD_REVIEW_MODELS).map(async (model) => {
    let lastError = "";
    for (const [i, attempt] of [model, model, WORLD_REVIEW_FALLBACK_MODEL].entries()) {
      if (i === 2 && attempt === model) break;
      if (i >= 1 && REFUSAL.test(lastError)) {
        // A content filter firing on a card filed as Limited is itself a sign it
        // isn't Limited: a person decides, no stand-in. On Limitless, filters
        // refusing explicit art is expected, so the fallback answers instead.
        if (author.contentMode === "limited") break;
        if (i === 1) continue; // the fallback's answer is recorded under its own name
      }
      if (i === 1) await new Promise((resolve) => setTimeout(resolve, opts.retryDelayMs ?? 4_000));
      try {
        return { model: attempt, answer: await once(attempt) };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    return { model, error: lastError.slice(0, 200) };
  })) as WorldAiReview["models"];
  // A third model breaks a tie (decideWorldReview counts the votes) when the
  // two split on minors on a card none of them reads as sexual, or split on
  // Limited vs Limitless from the text alone (no sexual pictures, explicit
  // cover or minors). A refusal or failure here leaves the split, and the card
  // goes to a person.
  const answered = models.flatMap((m) => (m.answer ? [m.answer] : []));
  const split = (yes: number) => yes > 0 && yes < answered.length;
  const minorSplit = split(answered.filter((a) => a.minorSexual).length) && tieBreakAllowed(author, answered);
  const modeSplit = split(answered.filter((a) => a.contentMode === "limitless").length) && modeTieBreakAllowed(author, answered);
  if (answered.length === models.length && (minorSplit || modeSplit)
    && !models.some((m) => m.model === WORLD_REVIEW_FALLBACK_MODEL)) { // never a second vote for the same model
    const tiebreaker = WORLD_REVIEW_FALLBACK_MODEL;
    try {
      models.push({ model: tiebreaker, answer: await once(tiebreaker), tiebreak: true });
    } catch (error) {
      models.push({ model: tiebreaker, error: (error instanceof Error ? error.message : String(error)).slice(0, 200), tiebreak: true });
    }
  }
  return {
    ...decideWorldReview(author, models, {
      hasCover: !!input.cover, coverError: input.coverError, editions: opts.editions,
      unseenImages: input.unseenImages, explicitWord: input.explicitWord, minorWord: input.minorWord,
      precedent: opts.precedent, ...(input.update ? { scope: "changes" as const } : {}),
    }),
    ...(input.update ? { scope: "changes" as const } : {}),
    author,
    models,
    at: new Date().toISOString(),
    ms: Date.now() - started,
  };
}
