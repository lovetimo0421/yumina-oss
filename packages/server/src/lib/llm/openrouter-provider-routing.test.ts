import assert from "node:assert/strict";
import test from "node:test";
import {
  providerRoutingFor,
  normalizeProviderSlug,
  extractFailedProviderSlug,
  kimiRepetitionSamplingParam,
} from "./openrouter.js";

// ── providerRoutingFor ──

test("gemini: prefers AI Studio with fallbacks allowed", () => {
  const routing = providerRoutingFor("google/gemini-3.5-flash", false);
  assert.deepEqual(routing, { order: ["google-ai-studio"], allow_fallbacks: true });
});

test("gemini + cache breakpoints: AI Studio order merges with Bedrock ignore", () => {
  const routing = providerRoutingFor("google/gemini-3.5-flash", true);
  assert.deepEqual(routing, {
    order: ["google-ai-studio"],
    allow_fallbacks: true,
    ignore: ["amazon-bedrock"],
  });
});

test("GA Gemini Flash Lite uses normal Gemini routing", () => {
  const routing = providerRoutingFor("google/gemini-3.1-flash-lite", true);
  assert.deepEqual(routing, {
    order: ["google-ai-studio"],
    allow_fallbacks: true,
    ignore: ["amazon-bedrock"],
  });
});

test("modern claude: keeps the first-party anthropic pin, no bedrock ignore", () => {
  const routing = providerRoutingFor("anthropic/claude-opus-4.7", true);
  assert.deepEqual(routing, { order: ["anthropic"], allow_fallbacks: true });
});

test("legacy claude 3: no pin and no bedrock ignore (cache_control is never sent to these SKUs)", () => {
  // shouldIgnoreBedrockForCaching is only true for non-Claude models;
  // applyCacheBreakpoints also skips legacy Claude 3 entirely. Matches the
  // pre-refactor behavior: no provider preferences at all.
  assert.equal(providerRoutingFor("anthropic/claude-3-haiku", true), undefined);
});

test("non-gemini non-claude without cache breakpoints: no routing sent", () => {
  assert.equal(providerRoutingFor("deepseek/deepseek-v3.2", false), undefined);
});

test("dynamic exclusions from the retry loop merge into ignore without duplicates", () => {
  const routing = providerRoutingFor("google/gemini-3.1-flash-lite", true, [
    "google-vertex",
    "some-reseller",
  ]);
  assert.deepEqual(routing, {
    order: ["google-ai-studio"],
    allow_fallbacks: true,
    ignore: ["google-vertex", "some-reseller", "amazon-bedrock"],
  });
});

test("dynamic exclusions apply to models with otherwise no routing", () => {
  const routing = providerRoutingFor("deepseek/deepseek-v3.2", false, ["novita"]);
  assert.deepEqual(routing, { ignore: ["novita"] });
});

test("OpenRouter BYOK preserves account routing for Gemini", () => {
  assert.equal(
    providerRoutingFor("google/gemini-3.1-pro-preview", true, undefined, true),
    undefined,
  );
});

test("OpenRouter BYOK never adds request-level retry exclusions", () => {
  assert.equal(
    providerRoutingFor("google/gemini-3.1-pro-preview", true, ["google-vertex"], true),
    undefined,
  );
});

// ── normalizeProviderSlug ──

test("endpoint tags reduce to their provider slug", () => {
  assert.equal(normalizeProviderSlug("google-vertex/global"), "google-vertex");
  assert.equal(normalizeProviderSlug("google-ai-studio/flex"), "google-ai-studio");
});

test("display names map to routing slugs", () => {
  // "Google" is the display name of the Vertex storefront.
  assert.equal(normalizeProviderSlug("Google"), "google-vertex");
  assert.equal(normalizeProviderSlug("Google AI Studio"), "google-ai-studio");
  assert.equal(normalizeProviderSlug("Amazon Bedrock"), "amazon-bedrock");
  assert.equal(normalizeProviderSlug("Anthropic"), "anthropic");
});

test("garbage never becomes a routing preference", () => {
  assert.equal(normalizeProviderSlug(""), undefined);
  assert.equal(normalizeProviderSlug(null), undefined);
  assert.equal(normalizeProviderSlug(42), undefined);
  assert.equal(normalizeProviderSlug("we{ird!"), undefined);
});

// ── extractFailedProviderSlug ──

test("pulls the last attempted provider from openrouter_metadata.attempts", () => {
  const payload = {
    error: { code: 404, message: "Publisher model not found" },
    openrouter_metadata: {
      attempts: [
        { provider: "google-ai-studio", status: 429 },
        { provider: "google-vertex/global", status: 404 },
      ],
    },
  };
  assert.equal(extractFailedProviderSlug(payload), "google-vertex");
});

test("falls back to the selected endpoint when attempts is absent", () => {
  const payload = {
    openrouter_metadata: {
      endpoints: {
        available: [
          { provider_name: "Google AI Studio", selected: false },
          { provider_name: "Google", selected: true },
        ],
      },
    },
  };
  assert.equal(extractFailedProviderSlug(payload), "google-vertex");
});

test("returns undefined for payloads without usable metadata (plain retry)", () => {
  assert.equal(extractFailedProviderSlug(undefined), undefined);
  assert.equal(extractFailedProviderSlug({ error: { code: 500 } }), undefined);
  assert.equal(extractFailedProviderSlug({ openrouter_metadata: {} }), undefined);
  assert.equal(
    extractFailedProviderSlug({ openrouter_metadata: { attempts: [{ status: 404 }] } }),
    undefined,
  );
});

test("Kimi sampling params reach OpenRouter as repetition_penalty", () => {
  const params = kimiRepetitionSamplingParam({
    model: "moonshotai/kimi-k2-0905",
    messages: [],
    temperature: 0.8,
  });
  assert.deepEqual(params, { repetition_penalty: 1.08 });
});

test("unsupported models never receive Kimi's repetition_penalty", () => {
  const params = kimiRepetitionSamplingParam({
    model: "google/gemini-3.5-flash",
    messages: [],
    repetitionPenalty: 1.2,
    topP: 0.9,
  });
  assert.deepEqual(params, {});
});
