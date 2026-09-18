import assert from "node:assert/strict";
import test from "node:test";
import {
  FREE_ROUTER_MODEL,
  FREE_ROUTER_FALLBACK_MODEL,
  FREE_ROUTER_LAST_RESORT_MODEL,
  FREE_ROUTER_VISION_MODEL,
  FREE_ROUTER_VISION_LAST_RESORT_MODEL,
  OFFICIAL_PROVIDER_TOS_FALLBACK_MODEL,
  allowsTransientFallback,
  getOfficialProviderFallbackModels,
  isFreeRouterFallback,
  turnNeedsVision,
} from "./fallback-models.js";
import { isFreePoolExhaustedError, shouldFallbackToAnotherModel } from "./openrouter.js";

// ── isFreePoolExhaustedError ──

test("429 naming the free-models-per-day cap is a free-pool exhaustion", () => {
  // Shape observed in prod logs.
  const body = JSON.stringify({
    error: { message: "Rate limit exceeded: free-models-per-day-high-balance.", code: 429 },
  });
  assert.equal(isFreePoolExhaustedError(429, body), true);
});

test("a plain 429 is NOT a free-pool exhaustion", () => {
  // Ordinary throttling: the same model succeeds on retry, so falling back to a
  // paid model would spend money to solve a problem that fixes itself.
  const body = JSON.stringify({ error: { message: "Rate limit exceeded", code: 429 } });
  assert.equal(isFreePoolExhaustedError(429, body), false);
});

test("free-models-per-day text on a non-429 status does not count", () => {
  assert.equal(isFreePoolExhaustedError(403, "free-models-per-day"), false);
  assert.equal(isFreePoolExhaustedError(500, "free-models-per-day"), false);
});

// ── shouldFallbackToAnotherModel ──

const THROTTLED = "qwen/qwen3-30b-a3b-instruct-2507 is temporarily rate-limited upstream.";

test("a throttled fallback model keeps descending when the chain allows it", () => {
  // The whole point of the second rung: the primary is single-provider and gets
  // throttled once the free tier piles onto it.
  assert.equal(shouldFallbackToAnotherModel(429, THROTTLED, true), true);
  assert.equal(shouldFallbackToAnotherModel(503, "upstream unavailable", true), true);
});

test("the same throttle on a paid model does NOT swap models", () => {
  assert.equal(shouldFallbackToAnotherModel(429, THROTTLED, false), false);
  assert.equal(shouldFallbackToAnotherModel(503, "upstream unavailable", undefined), false);
});

test("deterministic refusals fall back regardless of the transient opt-in", () => {
  assert.equal(shouldFallbackToAnotherModel(403, "provider terms of service", false), true);
  assert.equal(
    shouldFallbackToAnotherModel(429, "Rate limit exceeded: free-models-per-day.", false),
    true,
  );
});

test("a 400 never triggers a fallback — the request itself is wrong", () => {
  assert.equal(shouldFallbackToAnotherModel(400, "invalid request", true), false);
});

test("a retired model id (404) falls back even without the transient opt-in", () => {
  // The 2026-08-25 regression: OpenRouter pulled every provider endpoint from
  // inclusionai/ling-2.6-flash, then the free chain's first rung. Without this
  // the turn died on the retired id and never reached the healthy rung below.
  const body = JSON.stringify({
    error: {
      message:
        "Ling-2.6-flash is no longer available as a free model. It has transitioned to a paid model. Continue using it here: https://openrouter.ai/inclusionai/ling-2.6-flash",
      code: 404,
    },
  });
  assert.equal(shouldFallbackToAnotherModel(404, body, false), true);
  assert.equal(shouldFallbackToAnotherModel(404, "No endpoints found for some/model.", undefined), true);
});

// ── getOfficialProviderFallbackModels ──

test("Yumina Free falls back to the near-free chain, not the ToS model", () => {
  // Two rungs: when the whole free tier lands on the primary at once it can be
  // throttled, so there has to be somewhere further down to go.
  assert.deepEqual(getOfficialProviderFallbackModels(FREE_ROUTER_MODEL, false), [
    FREE_ROUTER_FALLBACK_MODEL,
    FREE_ROUTER_LAST_RESORT_MODEL,
  ]);
});

test("a Free turn carrying an image gets its own vision-only chain", () => {
  // Both text rungs are text->text and 400 on an image_url part, so a turn with
  // an attachment must not touch that ladder at all — it gets a parallel one.
  assert.deepEqual(getOfficialProviderFallbackModels(FREE_ROUTER_MODEL, false, true), [
    FREE_ROUTER_VISION_MODEL,
    FREE_ROUTER_VISION_LAST_RESORT_MODEL,
  ]);
});

test("the text and vision chains never share a rung", () => {
  // A text-only id leaking into the vision chain is silent until a free player
  // sends a picture, at which point every rung 400s.
  const text = getOfficialProviderFallbackModels(FREE_ROUTER_MODEL, false)!;
  const vision = getOfficialProviderFallbackModels(FREE_ROUTER_MODEL, false, true)!;
  assert.equal(text.some((m) => vision.includes(m)), false);
  assert.equal(text.length, 2, "a throttled first rung must have somewhere to go");
  assert.equal(vision.length, 2, "same for vision");
});

test("every rung of both chains bills back to Free", () => {
  // Miss one here and the player is charged real money for a downgrade they
  // never chose, on the one tier whose promise is that they never pay.
  const all = [
    ...getOfficialProviderFallbackModels(FREE_ROUTER_MODEL, false)!,
    ...getOfficialProviderFallbackModels(FREE_ROUTER_MODEL, false, true)!,
  ];
  for (const served of all) {
    assert.equal(isFreeRouterFallback(FREE_ROUTER_MODEL, served), true, served);
  }
});

test("a paid official-key model requires consent before a different model is called", () => {
  assert.equal(getOfficialProviderFallbackModels("deepseek/deepseek-v3.2", false), undefined);
});

test("the ToS fallback model does not fall back to itself", () => {
  assert.equal(
    getOfficialProviderFallbackModels(OFFICIAL_PROVIDER_TOS_FALLBACK_MODEL, false),
    undefined,
  );
});

test("BYOK gets no fallback — including on Free, whose retry would spend their money", () => {
  assert.equal(getOfficialProviderFallbackModels(FREE_ROUTER_MODEL, true), undefined);
  assert.equal(getOfficialProviderFallbackModels("deepseek/deepseek-v3.2", true), undefined);
});

// ── allowsTransientFallback ──

test("only Yumina Free may descend on transient upstream failures", () => {
  assert.equal(allowsTransientFallback(FREE_ROUTER_MODEL, false), true);
});

test("a paid model does not silently swap models on a blip", () => {
  // The player picked and pays for a specific model — serving another one on a
  // 429 is not ours to do.
  assert.equal(allowsTransientFallback("deepseek/deepseek-v3.2", false), false);
});

test("BYOK on Free does not descend either — it would spend their money", () => {
  assert.equal(allowsTransientFallback(FREE_ROUTER_MODEL, true), false);
});

// ── turnNeedsVision ──

test("a turn with an image_url part needs vision", () => {
  // Shape produced by the attachment injection in routes/messages.ts.
  const messages = [
    { role: "system", content: "You are a narrator." },
    {
      role: "user",
      content: [
        { type: "text", text: "who is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
      ],
    },
  ];
  assert.equal(turnNeedsVision(messages), true);
});

test("a plain text turn does not need vision", () => {
  assert.equal(
    turnNeedsVision([
      { role: "system", content: "You are a narrator." },
      { role: "user", content: "hi" },
    ]),
    false,
  );
});

test("a content array without image parts does not need vision", () => {
  assert.equal(turnNeedsVision([{ role: "user", content: [{ type: "text", text: "hi" }] }]), false);
});

// ── isFreeRouterFallback ──

test("Free served by one of our paid fallbacks is a free-router fallback", () => {
  assert.equal(isFreeRouterFallback(FREE_ROUTER_MODEL, FREE_ROUTER_FALLBACK_MODEL), true);
  assert.equal(isFreeRouterFallback(FREE_ROUTER_MODEL, FREE_ROUTER_LAST_RESORT_MODEL), true);
  assert.equal(isFreeRouterFallback(FREE_ROUTER_MODEL, FREE_ROUTER_VISION_MODEL), true);
  assert.equal(
    isFreeRouterFallback(FREE_ROUTER_MODEL, FREE_ROUTER_VISION_LAST_RESORT_MODEL),
    true,
  );
});

test("a HEALTHY free turn naming its pool member is NOT a fallback", () => {
  // openrouter/free reports the pool member it routed to, so this is what an
  // ordinary, still-free turn looks like. Flagging it would fire a bogus
  // downgrade event on every free turn on the platform.
  assert.equal(isFreeRouterFallback(FREE_ROUTER_MODEL, "poolside/laguna-xs-2.1:free"), false);
  assert.equal(isFreeRouterFallback(FREE_ROUTER_MODEL, "deepseek/deepseek-chat:free"), false);
});

test("Free served by Free is not a fallback", () => {
  assert.equal(isFreeRouterFallback(FREE_ROUTER_MODEL, FREE_ROUTER_MODEL), false);
});

test("a paid model swapped by the ToS fallback is not a free-router fallback", () => {
  // This one must stay billable — the player picked (and pays for) a paid model.
  assert.equal(
    isFreeRouterFallback("deepseek/deepseek-v3.2", OFFICIAL_PROVIDER_TOS_FALLBACK_MODEL),
    false,
  );
});
