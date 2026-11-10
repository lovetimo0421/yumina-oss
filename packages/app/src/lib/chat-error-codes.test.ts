import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { classifyChatError, errorDetail } from "../../sandbox/chat/error-codes";
import { makeChatT } from "../../sandbox/chat/i18n";

// Launch QA: Chinese players saw "No API key configured for this provider. Add
// one in Settings. Dismiss". Every raw server/provider line must map to a
// category the UI has copy for, a server code winning over the text.
test("server codes win over the text", () => {
  assert.equal(classifyChatError("anything", "NO_API_KEY"), "NO_API_KEY");
  assert.equal(classifyChatError("x", "UPSTREAM_UNAVAILABLE"), "UPSTREAM_BUSY");
  assert.equal(classifyChatError("x", "INTERRUPTED"), "CONNECTION_LOST");
  assert.equal(classifyChatError("x", "OFFLINE"), "OFFLINE");
  assert.equal(classifyChatError("x", "CONTENT_FILTER"), "CONTENT_BLOCKED");
});

test("raw texts the server and providers actually send are recognized", () => {
  const cases: Array<[string, string]> = [
    ["No API key configured for this provider. Add one in Settings.", "NO_API_KEY"],
    ["No API key configured for this provider", "NO_API_KEY"],
    ["This model is unavailable. Please select another model.", "MODEL_UNAVAILABLE"],
    ["OpenRouter error (404): No endpoints found for foo/bar.", "MODEL_UNAVAILABLE"],
    ["OpenRouter error (400): This endpoint's maximum context length is 131072 tokens.", "CONTEXT_TOO_LONG"],
    ["Not enough mushies for this message — the conversation is too long for your remaining balance.", "NO_CREDITS"],
    ["OpenRouter error (429): Rate limit exceeded: free-models-per-day-high-balance.", "FREE_POOL_EXHAUSTED"],
    ["OpenRouter error (429): google/gemma is temporarily rate-limited upstream.", "UPSTREAM_BUSY"],
    ["HTTP 502: Bad gateway", "UPSTREAM_BUSY"],
    ["yumina.io | 524: A timeout occurred", "UPSTREAM_TIMEOUT"],
    ["The connection stopped responding. Recovering the reply; you can stop waiting and try again.", "UPSTREAM_TIMEOUT"],
    ["Connection lost — the model may have timed out. Try regenerating, or switch to a faster model.", "CONNECTION_LOST"],
    ["Connection closed unexpectedly. Try regenerating.", "CONNECTION_LOST"],
    ["You're offline — the message was not sent.", "OFFLINE"],
    ["Server is restarting — your reply was interrupted. Please resend.", "SERVER_RESTART"],
    ["The model returned an empty reply. Please tap regenerate or send again.", "EMPTY_REPLY"],
    ["OpenRouter error (400): Gemini blocked the request: PROHIBITED_CONTENT", "CONTENT_BLOCKED"],
  ];
  for (const [raw, code] of cases) assert.equal(classifyChatError(raw), code, raw);
});

test("unknown errors stay unknown instead of getting a confident wrong label", () => {
  assert.equal(classifyChatError("TypeError: Cannot read properties of undefined (reading 'foo')"), null);
  assert.equal(classifyChatError(""), null);
  assert.equal(errorDetail("a\n  b"), "a b");
  assert.equal(errorDetail("x".repeat(300)).length, 140);
});

test("upstream balance wording never becomes a Mushies recharge instruction", () => {
  for (const raw of [
    'Custom endpoint error (402): {"error":"Insufficient Balance"}',
    "OpenRouter error (402): Insufficient credits",
    'OpenAI error (429): {"code":"insufficient_quota"}',
    "Insufficient balance",
    "Insufficient credits",
    "Upstream error: You have used all your credits",
  ]) {
    assert.equal(classifyChatError(raw), "UPSTREAM_BALANCE", raw);
    assert.equal(classifyChatError(raw, "PRIVATE_API_BALANCE"), "PRIVATE_API_BALANCE", raw);
  }
});

test("explicit platform and provider balance codes remain distinct", () => {
  assert.equal(classifyChatError("Insufficient credits", "NO_CREDITS"), "NO_CREDITS");
  assert.equal(classifyChatError("Insufficient credits", "INSUFFICIENT_CREDITS"), "NO_CREDITS");
  assert.equal(classifyChatError("Not enough mushies", "UPSTREAM_BALANCE"), "UPSTREAM_BALANCE");
  assert.equal(classifyChatError("Not enough mushies", "PRIVATE_API_BALANCE"), "PRIVATE_API_BALANCE");
  assert.equal(classifyChatError("You've used all your credits for this period. Purchase additional credits or upgrade your plan."), "NO_CREDITS");
});

test("live banners and saved failed turns give the same balance advice in every language", () => {
  for (const language of ["en", "zh", "zh-Hant", "ja", "es"]) {
    const errors = JSON.parse(readFileSync(new URL(`../locales/${language}/chat.json`, import.meta.url), "utf8")).errors;
    const t = makeChatT(language);
    for (const [code, key] of [
      ["PRIVATE_API_BALANCE", "errPrivateApiBalance"],
      ["UPSTREAM_BALANCE", "errUpstreamBalance"],
    ] as const) {
      assert.equal(classifyChatError("Insufficient balance", code), code);
      assert.ok(errors[code]?.length > 0, `${language}: missing ${code}`);
      assert.equal(t(key), errors[code], `${language}: failed turn and banner disagree`);
      assert.doesNotMatch(t(key), /mushies|蘑菇/i, `${language}: upstream failure must not send players to recharge Mushies`);
    }
  }
});
