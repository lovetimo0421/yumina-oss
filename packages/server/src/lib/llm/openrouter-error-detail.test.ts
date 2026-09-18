import assert from "node:assert/strict";
import test from "node:test";
import { upstreamErrorDetail, composeOpenRouterError } from "./openrouter.js";

// Payloads below are verbatim from OpenRouter prod responses captured on
// 2026-07-30 while investigating the Claude 5 400s (@kljws).

test("upstreamErrorDetail: unwraps Anthropic's nested error envelope", () => {
  const payload = {
    error: {
      message: "Provider returned error",
      code: 400,
      metadata: {
        provider_name: "Anthropic",
        raw: '{"type":"error","error":{"type":"invalid_request_error","message":"This model does not support assistant message prefill. The conversation must end with a user message."},"request_id":"req_011CdXyP"}',
      },
    },
  };
  assert.equal(
    upstreamErrorDetail(payload),
    "Anthropic: This model does not support assistant message prefill. The conversation must end with a user message.",
  );
});

test("upstreamErrorDetail: unwraps Bedrock's flat envelope", () => {
  const payload = {
    error: {
      message: "Provider returned error",
      code: 400,
      metadata: {
        provider_name: "Amazon Bedrock",
        raw: '{"message":"This model does not support assistant message prefill."}',
      },
    },
  };
  assert.equal(
    upstreamErrorDetail(payload),
    "Amazon Bedrock: This model does not support assistant message prefill.",
  );
});

test("upstreamErrorDetail: falls back to plain-text raw and to provider-only", () => {
  assert.equal(
    upstreamErrorDetail({ error: { metadata: { provider_name: "Azure", raw: "upstream exploded" } } }),
    "Azure: upstream exploded",
  );
  // No raw at all — still name the provider, which is more than we had before.
  assert.equal(
    upstreamErrorDetail({ error: { metadata: { provider_name: "Google" } } }),
    "upstream provider Google",
  );
});

test("upstreamErrorDetail: returns undefined when there is nothing to unwrap", () => {
  assert.equal(upstreamErrorDetail(undefined), undefined);
  assert.equal(upstreamErrorDetail("not an object"), undefined);
  assert.equal(upstreamErrorDetail({ error: { message: "Rate limited" } }), undefined);
  assert.equal(upstreamErrorDetail({ error: { metadata: {} } }), undefined);
});

// THE REGRESSION: users and PostHog saw only "Provider returned error", which
// names neither the provider nor the cause.
test("composeOpenRouterError: the generic wrapper is replaced by the real cause", () => {
  assert.equal(
    composeOpenRouterError(400, "Provider returned error", "Anthropic: max_tokens too large"),
    "OpenRouter error (400): Anthropic: max_tokens too large",
  );
});

test("composeOpenRouterError: an informative message keeps both halves", () => {
  assert.equal(
    composeOpenRouterError(429, "Rate limit exceeded", "Anthropic: overloaded"),
    "OpenRouter error (429): Rate limit exceeded — Anthropic: overloaded",
  );
});

test("composeOpenRouterError: degrades cleanly with no detail or no message", () => {
  assert.equal(composeOpenRouterError(402, "Insufficient credits", undefined), "OpenRouter error (402): Insufficient credits");
  assert.equal(composeOpenRouterError("stream", undefined, undefined), "OpenRouter error (stream): unknown upstream error");
  // Never print the same sentence twice.
  assert.equal(composeOpenRouterError(400, "Anthropic: boom", "Anthropic: boom"), "OpenRouter error (400): Anthropic: boom");
});

// The retry loop classifies non-retryable failures with /\((401|402|429)\)/ —
// the composed prefix must keep that shape intact.
test("composeOpenRouterError: keeps the (code) prefix the retry classifier matches", () => {
  for (const code of [401, 402, 429]) {
    assert.match(composeOpenRouterError(code, "Provider returned error", "Anthropic: nope"), /\((401|402|429)\)/);
  }
});
