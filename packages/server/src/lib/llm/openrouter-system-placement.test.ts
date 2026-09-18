import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSystemPlacement } from "./openrouter.js";

const C5 = "anthropic/claude-sonnet-5";
const C47 = "anthropic/claude-opus-4.7";

const parse = (shape: string) =>
  shape.split(",").map((r, i) => ({ role: { s: "system", u: "user", a: "assistant" }[r]!, content: `m${i}` }));
const shapeOf = (msgs: Record<string, unknown>[]) =>
  msgs.map((m) => ({ system: "s", user: "u", assistant: "a" }[m.role as string])).join(",");

// Measured against Opus 4.7 / Opus 5 / Sonnet 5 on 2026-07-30. Claude 5 rejects
// an inline system run unless it directly follows a user turn AND either ends
// the array or is followed by an assistant turn.
const ACCEPTED_BY_CLAUDE_5 = ["s,u", "s,u,s", "s,u,s,s", "s,u,a,u", "s,u,a,u,s", "s,u,a,u,s,s", "s,s,u", "s,u,u"];
const REJECTED_BY_CLAUDE_5 = ["s,u,s,u", "s,u,s,u,s", "s,u,a,u,s,u,s", "s,u,a,s,u"];

test("normalizeSystemPlacement: shapes Claude 5 already accepts are left untouched", () => {
  for (const shape of ACCEPTED_BY_CLAUDE_5) {
    const msgs = parse(shape);
    assert.equal(normalizeSystemPlacement(msgs, C5), msgs, `${shape} should be returned as-is`);
  }
});

// THE REGRESSION (@kljws, 2026-07-30): the send path emits
// …user → system(format block) → user(post-history entry) → system(post-history
// entry). That middle system has a user after it, so Claude 5 hard-400s while
// Opus 4.7 answers normally on the very same card.
test("normalizeSystemPlacement: the kljws shape becomes legal, message count intact", () => {
  const out = normalizeSystemPlacement(parse("s,u,s,u,s"), C5);
  assert.equal(shapeOf(out), "s,u,u,u,s");
  assert.equal(out.length, 5, "count must not change — cache-breakpoint indices depend on it");
  // Only the illegal system was touched; the legal trailing one keeps its role.
  assert.equal(out[4]!.role, "system");
  assert.equal(out[2]!.content, "m2", "content is preserved, only the role changes");
});

test("normalizeSystemPlacement: every rejected shape is rewritten into a legal one", () => {
  const expected: Record<string, string> = {
    "s,u,s,u": "s,u,u,u",
    "s,u,s,u,s": "s,u,u,u,s",
    "s,u,a,u,s,u,s": "s,u,a,u,u,u,s",
    "s,u,a,s,u": "s,u,a,u,u", // system after an assistant is illegal too
  };
  for (const shape of REJECTED_BY_CLAUDE_5) {
    const out = shapeOf(normalizeSystemPlacement(parse(shape), C5));
    assert.equal(out, expected[shape], `${shape} → ${out}`);
    // And the result must itself satisfy the rule — no illegal run survives.
    assert.equal(shapeOf(normalizeSystemPlacement(parse(out), C5)), out, `${out} must be a fixed point`);
  }
});

// Claude 4.x accepts every shape. Rewriting there would silently change the
// prompt for the models that work today.
test("normalizeSystemPlacement: Claude 4.x and non-Claude models are never rewritten", () => {
  for (const shape of REJECTED_BY_CLAUDE_5) {
    const msgs = parse(shape);
    assert.equal(normalizeSystemPlacement(msgs, C47), msgs);
    assert.equal(normalizeSystemPlacement(msgs, "anthropic/claude-sonnet-4.6"), msgs);
    assert.equal(normalizeSystemPlacement(msgs, "google/gemini-3-flash-preview"), msgs);
    assert.equal(normalizeSystemPlacement(msgs, "deepseek/deepseek-v3.2"), msgs);
  }
});

test("normalizeSystemPlacement: leading system run is exempt (OpenRouter hoists it)", () => {
  // Even a long leading run followed by a user is fine — those never become
  // inline messages on the Anthropic side.
  const msgs = parse("s,s,s,s,u");
  assert.equal(normalizeSystemPlacement(msgs, C5), msgs);
  // An all-system array has nothing inline to fix.
  const allSystem = parse("s,s");
  assert.equal(normalizeSystemPlacement(allSystem, C5), allSystem);
  assert.deepEqual(normalizeSystemPlacement([], C5), []);
});

// Sonnet 5 is STUDIO_RECOMMENDED_MODEL and the agent loop works today — this
// normalization must be a provable no-op there. The agent's only system message
// is `llmMessages[0]` (agent.ts), followed by user/assistant/tool turns.
test("normalizeSystemPlacement: the Studio agent's tool loop is untouched", () => {
  const agentLoop = [
    { role: "system", content: "studio prompt" },
    { role: "user", content: "add an entry" },
    { role: "assistant", content: "", tool_calls: [{ id: "t1" }] },
    { role: "tool", tool_call_id: "t1", content: "{\"ok\":true}" },
    { role: "assistant", content: "done" },
    { role: "user", content: "now translate it" },
  ];
  assert.equal(normalizeSystemPlacement(agentLoop, C5), agentLoop);
});

// Order matters: the prefill fix must run BEFORE placement normalization.
// Running it after would turn a legal `…system, assistant` tail into an illegal
// `…system, user` one and re-introduce the 400.
test("normalizeSystemPlacement: composes with the prefill fix in the shipped order", () => {
  // avoidClaudePrefill has already rewritten a trailing assistant to user here.
  const afterPrefillFix = parse("s,u,s,u");
  assert.equal(shapeOf(normalizeSystemPlacement(afterPrefillFix, C5)), "s,u,u,u");
  // The pre-prefill-fix shape is legal on its own, which is exactly why the
  // placement pass has to come second.
  const beforePrefillFix = parse("s,u,s,a");
  assert.equal(normalizeSystemPlacement(beforePrefillFix, C5), beforePrefillFix);
});

test("normalizeSystemPlacement: applies to the whole 5.x line and beyond", () => {
  for (const model of ["anthropic/claude-opus-5", "anthropic/claude-opus-5-fast", "anthropic/claude-fable-5"]) {
    assert.equal(shapeOf(normalizeSystemPlacement(parse("s,u,s,u"), model)), "s,u,u,u", model);
  }
});
