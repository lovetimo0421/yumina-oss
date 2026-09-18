/**
 * Which model a turn retries on when the upstream refusal is deterministic —
 * i.e. re-sending the same model is guaranteed to fail again. The provider
 * decides *when* to fall back (see shouldFallbackToAnotherModel in
 * openrouter.ts); this module decides *what to*.
 *
 * Deliberately free of any DB / env import so it stays a pure, testable unit.
 */

/** OpenRouter's Free Models Router — the model id behind "Yumina Free". */
export const FREE_ROUTER_MODEL = "openrouter/free";

/**
 * Where a Yumina Free TEXT turn goes when the free pool is exhausted.
 *
 * The free pool's daily cap is per-ACCOUNT, not per-user: once it trips, every
 * free player on the platform is locked out until the UTC day rolls over.
 * Before this fallback existed the turn just died with FREE_POOL_EXHAUSTED and
 * the player was told to go pick another model. Yumina eats the cost of the
 * replacement: the turn stays billed at Free's zero rate.
 *
 * $0.048/M in, $0.193/M out, 262k context, text->text, five providers
 * (StreamLake / SiliconFlow / CoreWeave / Nebius / Alibaba).
 *
 * Sticker price understates how cheap this is. The tier skews zh, and Qwen's
 * tokenizer bills 1.39 chars/token on Chinese against Mistral's 1.05 — 32%
 * fewer tokens for identical text. On Yumina's input-heavy turn shape (~21k in
 * / 0.7k out) that lands it at HALF the per-turn cost of the
 * mistral-small-3.2-24b-instruct it replaced, not the 0.67x the price list
 * implies. Always compare candidates on measured tokens, never on $/M alone.
 *
 * Smoke-tested 2026-08-25 against Yumina's real turn shape (card system prompt +
 * the engine's own <directive-format> and <game-state>, adult ZH roleplay):
 *   - 0 refusals in 24 runs across explicit / coercion / 痴女 / graphic violence
 *   - 100% emitted directives; 88% moved all three variables the card demanded
 *   - no reasoning tokens, no Japanese leakage, no English words mid-sentence
 * It beat the incumbent on every one of those: mistral-small-3.2 emitted
 * directives 88% of the time, moved all three variables only 50% of the time,
 * leaked English mid-Chinese ("等待着他的 Ultimately 死亡"), and quietly went
 * short on 痴女 content (94 chars against this model's 217).
 *
 * The rung it inherits was inclusionai/ling-2.6-flash until 2026-08-25, when
 * OpenRouter retired that id without notice — see isModelUnavailableError.
 */
export const FREE_ROUTER_FALLBACK_MODEL = "qwen/qwen3-30b-a3b-instruct-2507";

/**
 * Last rung of the free TEXT chain — reached only when the primary is throttled
 * or down.
 *
 * $0.09/M in, $0.55/M out, 262k context, text->text, and ELEVEN providers
 * (GMICloud / DeepInfra / Novita / Parasail / Alibaba / Venice / Nebius /
 * AtlasCloud / StreamLake / Google ×2) — by far the widest spread of anything
 * tested, which is exactly what a rung that exists for capacity needs. The
 * single-provider trap is what killed ling; nothing sits down here that only
 * one storefront serves.
 *
 * Tokenizer-adjusted, a 235B flagship costs the SAME per turn as the 24B model
 * it replaces. Scored 100% directive compliance AND 100% three-variable
 * coverage over 8 runs, 0 refusals in 24 — the only candidate that swept both.
 * It sits below the primary purely on price, not on quality.
 */
export const FREE_ROUTER_LAST_RESORT_MODEL = "qwen/qwen3-235b-a22b-2507";

/**
 * First rung for a Free turn carrying an image.
 *
 * openrouter/free routes to vision-capable models and attachments aren't
 * plan-gated, so free players do send images — but both text rungs are
 * text->text and 400 the moment an image_url part arrives. Vision turns get
 * their own chain rather than being wedged into the text one.
 *
 * $0.13/M in, $0.52/M out, 262k context, text+image->text, four providers
 * (Alibaba / DeepInfra / Novita / SiliconFlow). Same Qwen tokenizer advantage,
 * and it matched the 235B on the hard numbers: 100% directives, 100%
 * three-variable coverage, 0 refusals in 24.
 */
export const FREE_ROUTER_VISION_MODEL = "qwen/qwen3-vl-30b-a3b-instruct";

/**
 * Last rung of the free VISION chain.
 *
 * The previous primary, kept on precisely because it is known-good rather than
 * new: smoke-tested 2026-08-20 and again 2026-08-25 (0 refusals in 24), and it
 * has served real free traffic. Its directive compliance is the weakest of the
 * four (88% / 50%) and its Chinese is visibly worse, which is why it sits at
 * the bottom of the minority path instead of the top of the main one. Three
 * providers, $0.075/$0.200, 131k context, vision.
 */
export const FREE_ROUTER_VISION_LAST_RESORT_MODEL = "mistralai/mistral-small-3.2-24b-instruct";

/**
 * Generation-grade, CJK-aware, broadly available fallback when an official-key
 * user's chosen model is blocked for TOS reasons. (Was x-ai/grok-4.1-fast, now
 * deprecated → redirected to the ~20x-pricier x-ai/grok-4.20.)
 */
export const OFFICIAL_PROVIDER_TOS_FALLBACK_MODEL = "google/gemini-2.5-flash";

/**
 * BYOK keys never get a fallback: the retry would spend the user's own money on
 * a model they didn't choose. Official-key turns do, because we're the ones
 * holding the bag either way.
 */
export function getOfficialProviderFallbackModels(
  model: string,
  isByok: boolean,
  needsVision = false,
): string[] | undefined {
  if (isByok) return undefined;
  // Free turns fall back to the near-free model, not the ToS one — the ToS
  // fallback is a paid model we'd be donating at ~10x the cost, on a tier
  // whose entire promise is that the player is never charged.
  if (model === FREE_ROUTER_MODEL) {
    // Two separate two-rung chains rather than one shared list: both text rungs
    // are text->text and 400 on an image_url part, so a vision turn can't just
    // start lower down the same ladder. Each chain keeps a second rung so a
    // throttled first rung degrades instead of failing.
    return needsVision
      ? [FREE_ROUTER_VISION_MODEL, FREE_ROUTER_VISION_LAST_RESORT_MODEL]
      : [FREE_ROUTER_FALLBACK_MODEL, FREE_ROUTER_LAST_RESORT_MODEL];
  }
  // Paid cross-model retries must return to the client for consent (or its
  // explicitly saved automatic policy). The chosen replacement makes a fresh
  // request through the normal access, provider and credit guards.
  return undefined;
}

/**
 * True when the turn carries an image part, so the fallback has to be
 * vision-capable. Shape matches what we send upstream: OpenAI-style content
 * arrays with `{ type: "image_url" }` parts (see the attachment injection in
 * routes/messages.ts).
 */
export function turnNeedsVision<T extends { content: unknown }>(
  messages: ReadonlyArray<T>,
): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((part) => (part as { type?: unknown } | null)?.type === "image_url"),
  );
}

/**
 * True when this turn was asked for as Yumina Free but served by one of OUR
 * paid fallbacks. Callers use it to keep the turn labelled and billed as Free,
 * so the player never sees the downgrade and never pays for it.
 *
 * Matches the fallback ids exactly rather than "served !== requested". A healthy
 * openrouter/free call already comes back naming the pool member it routed to
 * (e.g. "poolside/laguna-xs-2.1:free"), so the looser check would flag every
 * ordinary free turn as a downgrade.
 *
 * Derived from one set rather than an || chain: a rung missing from here is not
 * a cosmetic slip, it bills the player real money for a downgrade they never
 * chose. Adding a rung above adds it here automatically.
 */
const FREE_ROUTER_FALLBACK_IDS: ReadonlySet<string> = new Set([
  FREE_ROUTER_FALLBACK_MODEL,
  FREE_ROUTER_LAST_RESORT_MODEL,
  FREE_ROUTER_VISION_MODEL,
  FREE_ROUTER_VISION_LAST_RESORT_MODEL,
]);

export function isFreeRouterFallback(requestedModel: string, servedModel: string): boolean {
  if (requestedModel !== FREE_ROUTER_MODEL) return false;
  return FREE_ROUTER_FALLBACK_IDS.has(servedModel);
}

/** Whether this turn's chain may also descend on transient upstream failures.
 *  See GenerateParams.fallbackOnTransientErrors for why only Free gets it. */
export function allowsTransientFallback(model: string, isByok: boolean): boolean {
  return !isByok && model === FREE_ROUTER_MODEL;
}
