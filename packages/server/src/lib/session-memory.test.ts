import assert from "node:assert/strict";
import { test } from "node:test";

async function loadModule() {
  return import("./session-memory-core.js");
}

test("normalizeSessionMemory accepts { text }, bare strings, and { memory } wrappers", async () => {
  const { normalizeSessionMemory } = await loadModule();
  assert.deepEqual(normalizeSessionMemory({ text: "  Mira trusts the player  " }), {
    text: "Mira trusts the player",
  });
  assert.deepEqual(normalizeSessionMemory("plain string memory"), {
    text: "plain string memory",
  });
  assert.deepEqual(normalizeSessionMemory({ memory: { text: "wrapped" } }), {
    text: "wrapped",
  });
  assert.deepEqual(normalizeSessionMemory(null), { text: "" });
  assert.deepEqual(normalizeSessionMemory(42), { text: "" });
});

test("normalizeSessionMemory converts legacy structured memory to labeled text", async () => {
  const { normalizeSessionMemory } = await loadModule();
  const normalized = normalizeSessionMemory({
    coreFacts: ["  Mira trusts   the player  ", "", null],
    activeGoalsAndOpenThreads: ["Return before sunrise."],
    relationshipChanges: "not an array",
  });

  assert.ok(normalized.text.includes("Core facts:"));
  assert.ok(normalized.text.includes("- Mira trusts the player"));
  assert.ok(normalized.text.includes("Active goals and open threads:"));
  assert.ok(normalized.text.includes("- Return before sunrise."));
  assert.ok(!normalized.text.includes("Relationship changes:"));
});

test("normalizeSessionMemory caps oversized memory text", async () => {
  const { normalizeSessionMemory, MAX_MEMORY_CHARS } = await loadModule();
  const normalized = normalizeSessionMemory({ text: "x".repeat(MAX_MEMORY_CHARS * 2) });
  assert.ok(normalized.text.length <= MAX_MEMORY_CHARS + 20);
  assert.ok(normalized.text.endsWith("[truncated]"));
});

test("formatSessionMemoryForPrompt omits empty memory", async () => {
  const { formatSessionMemoryForPrompt } = await loadModule();
  assert.equal(formatSessionMemoryForPrompt(null), null);
  assert.equal(formatSessionMemoryForPrompt({ text: "   " }), null);
  assert.equal(formatSessionMemoryForPrompt({ coreFacts: [] }), null);
});

test("formatSessionMemoryForPrompt injects the memory text verbatim", async () => {
  const { formatSessionMemoryForPrompt } = await loadModule();
  const prompt = formatSessionMemoryForPrompt({
    text: "Core facts:\n- The player carries the archive seal.",
  });

  assert.ok(prompt?.includes("[Session Memory]"));
  assert.ok(prompt?.includes("Core facts:"));
  assert.ok(prompt?.includes("- The player carries the archive seal."));
});

test("a stale-since-edit memory carries the obsolete-content warning; a fresh one does not", async () => {
  const { formatSessionMemoryForPrompt } = await loadModule();
  const memory = { text: "Core facts:\n- The scene takes place at the beach." };

  const fresh = formatSessionMemoryForPrompt(memory);
  assert.ok(fresh && !fresh.includes("EDITED or REMOVED"));

  const stale = formatSessionMemoryForPrompt(memory, { staleSinceEdit: true });
  assert.ok(stale?.includes("EDITED or REMOVED earlier messages"));
  // The warning must sit BEFORE the memory text, where instruction-following
  // models weight it against the facts that follow.
  assert.ok(stale!.indexOf("EDITED or REMOVED") < stale!.indexOf("Core facts:"));
  // Explicitly false stays clean — only a real stamp triggers the warning.
  const explicitFresh = formatSessionMemoryForPrompt(memory, { staleSinceEdit: false });
  assert.ok(explicitFresh && !explicitFresh.includes("EDITED or REMOVED"));
});

test("detects a Chinese sentence repeated across the generated memory", async () => {
  const { isDegenerateSessionMemoryText } = await loadModule();
  const repeated = "她站在练习室门口，反复确认今晚的约定。".repeat(8);

  assert.equal(isDegenerateSessionMemoryText(repeated), true);
});

test("detects a repeated clause even when the model only uses commas", async () => {
  const { isDegenerateSessionMemoryText } = await loadModule();
  const repeated = Array.from(
    { length: 8 },
    () => "她仍然站在练习室门口等待",
  ).join("，");

  assert.equal(isDegenerateSessionMemoryText(repeated), true);
});

test("detects an unpunctuated repeated phrase", async () => {
  const { isDegenerateSessionMemoryText } = await loadModule();
  const repeated = "她仍然站在练习室门口等待今晚的约定".repeat(8);

  assert.equal(isDegenerateSessionMemoryText(repeated), true);
});

test("detects repeated bullets in one paragraph but accepts normal memory", async () => {
  const { isDegenerateSessionMemoryText } = await loadModule();
  const repeated = Array.from(
    { length: 6 },
    () => "- Ningning promised to meet the player after rehearsal.",
  ).join(" ");
  const normal = [
    "Core facts:",
    "- The player carries the archive seal.",
    "- Winter knows the east gate is watched.",
    "Relationship changes:",
    "- Karina now trusts the player with the map.",
    "Active goals and open threads:",
    "- Meet Ningning after rehearsal.",
  ].join("\n");

  assert.equal(isDegenerateSessionMemoryText(repeated), true);
  assert.equal(isDegenerateSessionMemoryText(normal), false);
});

test("does not flag a repeated short name or ordinary terse bullets", async () => {
  const { isDegenerateSessionMemoryText } = await loadModule();
  const normal = [
    "Core facts:",
    "- aespa arrives first.",
    "- aespa keeps the key.",
    "- aespa trusts the player.",
    "- aespa waits backstage.",
  ].join("\n");

  assert.equal(isDegenerateSessionMemoryText(normal), false);
});

test("incremental generation drops an already-corrupted memory seed", async () => {
  const { sanitizeSessionMemoryForGeneration } = await loadModule();
  const repeated = "她站在练习室门口，反复确认今晚的约定。".repeat(8);

  assert.deepEqual(sanitizeSessionMemoryForGeneration({ text: repeated }), { text: "" });
});

test("formatSessionMemoryForPrompt suppresses previously persisted degenerate memory", async () => {
  const { formatSessionMemoryForPrompt } = await loadModule();
  const repeated = "她站在练习室门口，反复确认今晚的约定。".repeat(8);

  assert.equal(formatSessionMemoryForPrompt({ text: repeated }), null);
});

test("degenerate generation retries once with the fallback model", async () => {
  const { generateHealthySessionMemory } = await loadModule();
  const calls: string[] = [];
  const retries: string[] = [];
  const memory = await generateHealthySessionMemory({
    primaryModel: "google/gemini-3.1-flash-lite",
    fallbackModel: "deepseek/deepseek-v4-flash",
    generate: async (model: string) => {
      calls.push(model);
      return model.startsWith("google/")
        ? { text: "她站在练习室门口，反复确认今晚的约定。".repeat(8) }
        : { text: "Core facts:\n- The rehearsal ends at midnight." };
    },
    onRetry: (model: string) => {
      retries.push(model);
    },
  });

  assert.deepEqual(calls, [
    "google/gemini-3.1-flash-lite",
    "deepseek/deepseek-v4-flash",
  ]);
  assert.deepEqual(retries, ["deepseek/deepseek-v4-flash"]);
  assert.equal(memory.text, "Core facts:\n- The rehearsal ends at midnight.");
});

test("degenerate generation fails after one fallback attempt", async () => {
  const { DegenerateSessionMemoryError, generateHealthySessionMemory } = await loadModule();
  const calls: string[] = [];
  let failed = false;

  await assert.rejects(
    generateHealthySessionMemory({
      primaryModel: "google/gemini-3.1-flash-lite",
      fallbackModel: "deepseek/deepseek-v4-flash",
      generate: async (model: string) => {
        calls.push(model);
        return { text: "她站在练习室门口，反复确认今晚的约定。".repeat(8) };
      },
      onFailure: () => {
        failed = true;
      },
    }),
    DegenerateSessionMemoryError,
  );
  assert.equal(calls.length, 2);
  assert.equal(failed, true);
});

test("degenerate generation does not retry across an unsafe provider boundary", async () => {
  const { DegenerateSessionMemoryError, generateHealthySessionMemory } = await loadModule();
  const calls: string[] = [];
  const retries: string[] = [];
  let failed = false;

  await assert.rejects(
    generateHealthySessionMemory({
      primaryModel: "google/gemini-3.1-flash-lite",
      fallbackModel: "deepseek/deepseek-v4-flash",
      generate: async (model: string) => {
        calls.push(model);
        return { text: "The rehearsal promise remains unchanged for tonight. ".repeat(8) };
      },
      canRetry: () => false,
      onRetry: (model: string) => {
        retries.push(model);
      },
      onFailure: () => {
        failed = true;
      },
    }),
    DegenerateSessionMemoryError,
  );

  assert.deepEqual(calls, ["google/gemini-3.1-flash-lite"]);
  assert.deepEqual(retries, []);
  assert.equal(failed, true);
});

test("empty generation follows the same one-retry health guard", async () => {
  const { generateHealthySessionMemory } = await loadModule();
  const calls: string[] = [];

  const memory = await generateHealthySessionMemory({
    primaryModel: "google/gemini-3.1-flash-lite",
    fallbackModel: "deepseek/deepseek-v4-flash",
    generate: async (model: string) => {
      calls.push(model);
      return model.startsWith("google/")
        ? { text: "   " }
        : { text: "Core facts:\n- The rehearsal ends at midnight." };
    },
  });

  assert.deepEqual(calls, [
    "google/gemini-3.1-flash-lite",
    "deepseek/deepseek-v4-flash",
  ]);
  assert.equal(memory.text, "Core facts:\n- The rehearsal ends at midnight.");
});

test("provider errors do not trigger the semantic-degeneration fallback", async () => {
  const { generateHealthySessionMemory } = await loadModule();
  const calls: string[] = [];

  await assert.rejects(
    generateHealthySessionMemory({
      primaryModel: "google/gemini-3.1-flash-lite",
      fallbackModel: "deepseek/deepseek-v4-flash",
      generate: async (model: string) => {
        calls.push(model);
        throw new Error("provider unavailable");
      },
    }),
    /provider unavailable/,
  );
  assert.deepEqual(calls, ["google/gemini-3.1-flash-lite"]);
});

test("hasSessionMemory reflects text presence for old and new shapes", async () => {
  const { hasSessionMemory } = await loadModule();
  assert.equal(hasSessionMemory({ text: "something" }), true);
  assert.equal(hasSessionMemory({ text: "" }), false);
  assert.equal(hasSessionMemory({ coreFacts: ["legacy fact"] }), true);
  assert.equal(hasSessionMemory(null), false);
});

// ── Output cap / truncation guard ────────────────────────────────────
// The old prompt asked for a 12,000-character memory but the LLM call capped
// output at 4,000 tokens — a CJK memory was cut mid-write on ~20% of updates
// platform-wide (hhltwz report, 2026-09-04). The cap must be able to hold a
// max-length memory, and an output that still hits it must be treated as
// truncated (kept out of the row) instead of persisted as half a memory.

test("the memory output cap fits a target-length CJK memory", async () => {
  const { MEMORY_TARGET_CHARS, MAX_MEMORY_OUTPUT_TOKENS } = await loadModule();
  const { estimateTokens } = await import("@yumina/engine");
  const cjk = "记".repeat(MEMORY_TARGET_CHARS);
  assert.ok(estimateTokens(cjk, "google/gemini-2.5-flash-lite") <= MAX_MEMORY_OUTPUT_TOKENS);
  assert.ok(estimateTokens(cjk, "deepseek/deepseek-v3.2") <= MAX_MEMORY_OUTPUT_TOKENS);
});

test("isTruncatedMemoryOutput trusts the provider's stop reason first, then usage, then the text's size", async () => {
  const { isTruncatedMemoryOutput, MAX_MEMORY_OUTPUT_TOKENS } = await loadModule();
  const model = "google/gemini-2.5-flash-lite";
  // Provider said it stopped at the length limit — truncated regardless of counts.
  assert.equal(isTruncatedMemoryOutput({ stopReason: "max_tokens", completionTokens: 300, text: "x", model }), true);
  // Provider said it finished — not truncated even when reasoning tokens
  // pushed the completion count to the cap (reasoning models share the budget).
  assert.equal(isTruncatedMemoryOutput({ stopReason: "stop", completionTokens: MAX_MEMORY_OUTPUT_TOKENS, text: "x", model }), false);
  // No stop reason: fall back to reported usage.
  assert.equal(isTruncatedMemoryOutput({ completionTokens: MAX_MEMORY_OUTPUT_TOKENS, text: "x", model }), true);
  assert.equal(isTruncatedMemoryOutput({ completionTokens: MAX_MEMORY_OUTPUT_TOKENS + 5, text: "x", model }), true);
  assert.equal(isTruncatedMemoryOutput({ completionTokens: 120, text: "记".repeat(MAX_MEMORY_OUTPUT_TOKENS), model }), false);
  // No usage either: the text's own size.
  assert.equal(isTruncatedMemoryOutput({ completionTokens: 0, text: "记".repeat(MAX_MEMORY_OUTPUT_TOKENS), model }), true);
  assert.equal(isTruncatedMemoryOutput({ completionTokens: 0, text: "short memory", model }), false);
});

test("classifyMemoryOutput lets a repetitive output that hit the cap reach the degenerate retry, not the truncation error", async () => {
  const { classifyMemoryOutput, MAX_MEMORY_OUTPUT_TOKENS } = await loadModule();
  const model = "google/gemini-2.5-flash-lite";
  const looping = "她站在练习室门口，反复确认今晚的约定。".repeat(8);
  // The classic failure isDegenerateSessionMemoryText exists for: one bullet
  // looping until the output cap. That must stay a "degenerate" verdict (so
  // the health guard retries with the fallback model), not "truncated".
  assert.equal(classifyMemoryOutput({ stopReason: "max_tokens", completionTokens: MAX_MEMORY_OUTPUT_TOKENS, text: looping, model }), "degenerate");
  assert.equal(classifyMemoryOutput({ stopReason: "max_tokens", completionTokens: MAX_MEMORY_OUTPUT_TOKENS, text: "Core facts:\n- the hero met the stranger", model }), "truncated");
  assert.equal(classifyMemoryOutput({ stopReason: "stop", completionTokens: 400, text: "Core facts:\n- the hero met the stranger", model }), "ok");
});

test("memoryBudgetInstruction tells the model to compress only when the existing memory is over budget", async () => {
  const { memoryBudgetInstruction, MEMORY_TARGET_CHARS } = await loadModule();
  assert.equal(memoryBudgetInstruction("- short".length), "");
  const over = memoryBudgetInstruction(MEMORY_TARGET_CHARS + 2_000);
  assert.ok(over.includes(String(MEMORY_TARGET_CHARS)));
  assert.ok(/compress|shorter|over/i.test(over));
});

// ── Player-pinned notes ──────────────────────────────────────────────
// A block the player writes and the updater never rewrites. Injected with the
// memory even when the auto memory is empty, and listed FIRST so it wins over
// auto-written facts it contradicts.

test("normalizePinnedMemory trims, nulls blanks, and clamps to the pinned cap", async () => {
  const { normalizePinnedMemory, MAX_PINNED_MEMORY_CHARS } = await loadModule();
  assert.equal(normalizePinnedMemory("  莉娜已经死了  "), "莉娜已经死了");
  assert.equal(normalizePinnedMemory("   "), null);
  assert.equal(normalizePinnedMemory(null), null);
  assert.equal(normalizePinnedMemory(undefined), null);
  assert.equal(normalizePinnedMemory("x".repeat(MAX_PINNED_MEMORY_CHARS + 50))!.length, MAX_PINNED_MEMORY_CHARS);
});

test("formatSessionMemoryForPrompt injects pinned notes even when the auto memory is empty", async () => {
  const { formatSessionMemoryForPrompt } = await loadModule();
  const block = formatSessionMemoryForPrompt(null, { pinned: "莉娜已经死了，不要再让她出场" });
  assert.ok(block, "pinned notes alone still produce a block");
  assert.ok(block!.includes("[Session Memory]"));
  assert.ok(block!.includes("莉娜已经死了，不要再让她出场"));
  assert.equal(formatSessionMemoryForPrompt(null, { pinned: "   " }), null, "blank pinned + empty memory = nothing");
  assert.equal(formatSessionMemoryForPrompt(null, {}), null);
});

test("formatSessionMemoryForPrompt lists pinned notes before the auto memory", async () => {
  const { formatSessionMemoryForPrompt } = await loadModule();
  const block = formatSessionMemoryForPrompt({ text: "- the hero met the stranger" }, { pinned: "the stranger is the hero's father" });
  assert.ok(block);
  assert.ok(block!.indexOf("the stranger is the hero's father") < block!.indexOf("- the hero met the stranger"));
});
