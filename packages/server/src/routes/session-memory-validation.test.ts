import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  MODEL_ID_PATTERN,
  applyModelRedirect,
} from "../lib/llm/model-redirects.js";

// ─── Session-memory endpoint hardening (Q1, 2026-06-10) ─────────────────────
// The 9 memory/summary endpoints previously parsed bodies with bare
// c.req.json<T>() (no runtime validation), accepted arbitrary model strings
// (length-sliced only), and had no rate limits on the 3 endpoints that fire
// paid LLM calls. These tests pin the validation layer and the wiring.

test("MODEL_ID_PATTERN accepts real provider slugs and rejects junk", () => {
  const valid = [
    "google/gemini-2.5-flash-lite",
    "x-ai/grok-4.20",
    "deepseek/deepseek-chat:free",
    "anthropic/claude-sonnet-4.6",
    "moonshotai/kimi-k2.6",
  ];
  for (const m of valid) assert.ok(MODEL_ID_PATTERN.test(m), `should accept ${m}`);

  const invalid = [
    "", // empty
    "a".repeat(200), // over length
    "model with spaces",
    "'; DROP TABLE play_sessions; --",
    "model\nnewline",
    "<script>alert(1)</script>",
    "-leading-dash",
  ];
  for (const m of invalid) assert.ok(!MODEL_ID_PATTERN.test(m), `should reject ${JSON.stringify(m.slice(0, 40))}`);
});

test("deprecated model ids redirect; current ids pass through", () => {
  assert.equal(applyModelRedirect("x-ai/grok-4.1-fast"), "x-ai/grok-4.20");
  assert.equal(applyModelRedirect("x-ai/grok-4.1"), "x-ai/grok-4.20");
  assert.equal(
    applyModelRedirect("google/gemini-3.1-flash-lite-preview"),
    "google/gemini-3.1-flash-lite",
  );
  assert.equal(applyModelRedirect("google/gemini-2.5-flash-lite"), "google/gemini-2.5-flash-lite");
});

const here = dirname(fileURLToPath(import.meta.url));

test("session-memory routes: every body parse goes through zod parseBody, LLM endpoints are rate limited", () => {
  const src = readFileSync(join(here, "session-memory.ts"), "utf8");

  // No bare typed json parses may remain — parseBody is the only entry.
  assert.ok(!/c\.req\.json</.test(src), "found a bare c.req.json<T>() — use parseBody(schema)");

  // The three paid-LLM endpoints carry the ai-generation rate bucket.
  for (const route of ["/summary/regenerate", "/summary/compact", "/memory/regenerate"]) {
    const line = src.split("\n").find((l) => l.includes(`"${`/:sessionId${route}`}"`));
    assert.ok(line, `route ${route} not found`);
    assert.match(line!, /rateLimitMiddleware\("ai-generation"\)/, `${route} must be rate limited`);
  }

  // Model fields validate through the shared schema (charset + redirect).
  assert.match(src, /modelSchema/, "modelSchema missing");
  assert.match(src, /applyModelRedirect/, "deprecated-model redirect not applied");
});
