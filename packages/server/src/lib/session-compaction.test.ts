import test from "node:test";
import assert from "node:assert/strict";

async function loadModule() {
  return import("./session-compaction-core.js");
}

function makeMessage(index: number, words = 400) {
  return {
    id: `m${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: Array.from({ length: words }, (_, i) => `word${index}_${i}`).join(" "),
    createdAt: new Date(index * 1000),
  };
}

test("selectCompactionWindow keeps a recent tail and compacts older turns", async () => {
  const { selectCompactionWindow } = await loadModule();
  const rows = Array.from({ length: 18 }, (_, index) => makeMessage(index));

  const window = selectCompactionWindow(rows, {
    triggerTokens: 4_000,
    recentTailTokens: 1_500,
    minCompactableTokens: 500,
  });

  assert.ok(window);
  assert.ok(window.compactable.length > 0);
  assert.ok(window.retained.length >= 2);
  assert.equal(window.compactable.at(-1)!.id, rows[rows.length - window.retained.length - 1]!.id);
  assert.equal(window.retained.at(-1)!.id, rows.at(-1)!.id);
});

test("selectCompactionWindow returns null below threshold", async () => {
  const { selectCompactionWindow } = await loadModule();
  const rows = Array.from({ length: 4 }, (_, index) => makeMessage(index, 20));
  assert.equal(selectCompactionWindow(rows, { triggerTokens: 50_000 }), null);
});

test("selectForcedManualCompactionWindow keeps a tiny live tail for testing", async () => {
  const { selectForcedManualCompactionWindow } = await loadModule();
  const rows = Array.from({ length: 4 }, (_, index) => makeMessage(index, 20));

  const window = selectForcedManualCompactionWindow(rows);

  assert.ok(window);
  assert.deepEqual(window.compactable.map((row) => row.id), ["m0", "m1"]);
  assert.deepEqual(window.retained.map((row) => row.id), ["m2", "m3"]);
});

test("normalizeSessionSummaryTriggerTokens clamps custom thresholds", async () => {
  const { normalizeSessionSummaryRecentTailTokens, normalizeSessionSummaryTriggerTokens } = await loadModule();
  // Values BELOW the default but above the floor must stick — when the floor
  // equalled the default, the panel's Apply looked like a reset-to-default.
  assert.equal(normalizeSessionSummaryTriggerTokens("20000"), 20_000);
  assert.equal(normalizeSessionSummaryTriggerTokens(100), 8_000);
  assert.equal(normalizeSessionSummaryTriggerTokens(3_000_000), 2_000_000);
  assert.equal(normalizeSessionSummaryRecentTailTokens("12000"), 12_000);
  assert.equal(normalizeSessionSummaryRecentTailTokens(100), 4_000);
  assert.equal(normalizeSessionSummaryRecentTailTokens(3_000_000), 2_000_000);
  // Unset (null DB column / 0) means the DEFAULT, never the minimum —
  // Number(null) is 0, which used to fall through to the min clamp and was
  // only invisible while min === default.
  assert.equal(normalizeSessionSummaryTriggerTokens(null), 32_000);
  assert.equal(normalizeSessionSummaryTriggerTokens(0), 32_000);
  assert.equal(normalizeSessionSummaryTriggerTokens(undefined), 32_000);
  assert.equal(normalizeSessionSummaryRecentTailTokens(null), 12_000);
  assert.equal(normalizeSessionSummaryRecentTailTokens(0), 12_000);
  assert.equal(normalizeSessionSummaryRecentTailTokens(undefined), 12_000);
});

test("threshold trigger is raised to the workable floor (tail + min chunk)", async () => {
  const { getStoryCompactionTargets } = await loadModule();
  // trigger 8k with a 20k kept tail can never produce a window before ~24k —
  // the progress bar used to hit 100% at 8k while nothing was compactable.
  const raised = getStoryCompactionTargets({ triggerTokens: 8_000, recentTailTokens: 20_000 });
  assert.equal(raised.triggerTokens, 24_000);
  // A trigger already above the floor is untouched.
  const kept = getStoryCompactionTargets({ triggerTokens: 50_000, recentTailTokens: 20_000 });
  assert.equal(kept.triggerTokens, 50_000);
  // Small tail keeps small triggers reachable (8k trigger, 4k tail → 8k).
  const small = getStoryCompactionTargets({ triggerTokens: 8_000, recentTailTokens: 4_000 });
  assert.equal(small.triggerTokens, 8_000);
});

test("resolveThresholdTriggerTokens keeps background compaction below the overflow point", async () => {
  const { resolveThresholdTriggerTokens } = await loadModule();
  // Large-context users keep the default trigger untouched.
  assert.equal(resolveThresholdTriggerTokens(50_000, 200_000), 50_000);
  // Small budgets cap the trigger at half the context so the background path
  // fires before the awaited send-path overflow compaction ever has to.
  assert.equal(resolveThresholdTriggerTokens(50_000, 64_000), 32_000);
  // Never below a workable window (default recent tail + one minimum chunk).
  assert.equal(resolveThresholdTriggerTokens(50_000, 16_000), 16_000);
  // Unknown budget → unchanged.
  assert.equal(resolveThresholdTriggerTokens(50_000, null), 50_000);
  assert.equal(resolveThresholdTriggerTokens(50_000, undefined), 50_000);
});

test("overflow summary mode compacts only the oldest context overflow", async () => {
  const { estimateMessagesTokens, selectCompactionWindow } = await loadModule();
  const rows = Array.from({ length: 12 }, (_, index) => makeMessage(index, 160));
  const total = estimateMessagesTokens(rows);
  const target = Math.floor(total * 0.65);

  const window = selectCompactionWindow(rows, {
    mode: "overflow",
    contextTokenLimit: target,
  });

  assert.ok(window);
  assert.ok(window.compactable.length > 0);
  assert.equal(window.compactable[0]!.id, rows[0]!.id);
  assert.equal(window.retained.at(-1)!.id, rows.at(-1)!.id);
  assert.ok(estimateMessagesTokens(window.retained) >= target);
});

test("story summary prompt formatting strips code fences", async () => {
  const { formatStorySummaryForPrompt, normalizeStorySummaryText } = await loadModule();
  const summary = normalizeStorySummaryText("```md\n## Story So Far\nThe seal was found.\n```");
  assert.equal(summary, "## Story So Far\nThe seal was found.");
  assert.equal(
    formatStorySummaryForPrompt(summary),
    "[Summary of earlier events]\n## Story So Far\nThe seal was found.",
  );
});

test("story summary finalization records usage but never bills empty output", async () => {
  const { finalizeStorySummaryOutput } = await loadModule();
  const successfulEvents: string[] = [];
  const summary = await finalizeStorySummaryOutput({
    text: "  ## Story So Far\nThe seal was found.  ",
    recordUsage: async () => { successfulEvents.push("usage"); },
    billUsage: async () => { successfulEvents.push("billing"); },
  });
  assert.equal(summary, "## Story So Far\nThe seal was found.");
  assert.deepEqual(successfulEvents, ["usage", "billing"]);

  const emptyEvents: string[] = [];
  await assert.rejects(
    finalizeStorySummaryOutput({
      text: "   ",
      stopReason: "max_tokens",
      sawReasoning: true,
      reasoningTokens: 1_200,
      recordUsage: async () => { emptyEvents.push("usage"); },
      billUsage: async () => { emptyEvents.push("billing"); },
    }),
    /spent its entire output limit on reasoning/,
  );
  assert.deepEqual(emptyEvents, ["usage"], "empty output stays observable without charging the player");

  const truncatedEvents: string[] = [];
  await assert.rejects(
    finalizeStorySummaryOutput({
      text: "## Story So Far\nA partial sentence",
      stopReason: "max_tokens",
      recordUsage: async () => { truncatedEvents.push("usage"); },
      billUsage: async () => { truncatedEvents.push("billing"); },
    }),
    /before completing the story summary/,
  );
  assert.deepEqual(truncatedEvents, ["usage"], "truncated output must not be billed or persisted");
});

test("empty story summary diagnostics distinguish reasoning, truncation, and generic emptiness", async () => {
  const { storySummaryEmptyOutputMessage } = await loadModule();
  assert.match(
    storySummaryEmptyOutputMessage({ sawReasoning: true }),
    /returned reasoning but no story summary/,
  );
  assert.equal(
    storySummaryEmptyOutputMessage({ stopReason: "max_tokens" }),
    "Summary model reached its output limit without returning a story summary",
  );
  assert.equal(
    storySummaryEmptyOutputMessage({}),
    "Summary model returned an empty story summary",
  );
});

test("custom story summarization fails its health probe before concurrent fan-out", async () => {
  const { summarizeStoryEpisodeTranscripts } = await loadModule();
  const calls: string[] = [];
  await assert.rejects(
    summarizeStoryEpisodeTranscripts({
      transcripts: ["one", "two", "three", "four"],
      probeFirst: true,
      concurrency: 4,
      summarize: async (transcript: string) => {
        calls.push(transcript);
        throw new Error("empty output");
      },
    }),
    /empty output/,
  );
  assert.deepEqual(calls, ["one"]);
});

test("a successful custom probe resumes bounded episode work in chronological order", async () => {
  const { summarizeStoryEpisodeTranscripts } = await loadModule();
  let active = 0;
  let maxActive = 0;
  const results = await summarizeStoryEpisodeTranscripts({
    transcripts: ["one", "two", "three", "four", "five"],
    probeFirst: true,
    concurrency: 2,
    summarize: async (transcript: string) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
      return transcript.toUpperCase();
    },
  });
  assert.deepEqual(results, ["ONE", "TWO", "THREE", "FOUR", "FIVE"]);
  assert.equal(maxActive, 2);
});

test("non-custom story summarization starts with normal bounded concurrency", async () => {
  const { summarizeStoryEpisodeTranscripts } = await loadModule();
  let active = 0;
  let maxActive = 0;
  await summarizeStoryEpisodeTranscripts({
    transcripts: ["one", "two", "three", "four", "five"],
    probeFirst: false,
    concurrency: 4,
    summarize: async (transcript: string) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
      return transcript;
    },
  });
  assert.equal(maxActive, 4);
});

test("splitMessagesIntoCompactionChunks respects target token budget", async () => {
  const { splitMessagesIntoCompactionChunks } = await loadModule();
  const rows = Array.from({ length: 8 }, (_, index) => makeMessage(index, 250));
  const chunks = splitMessagesIntoCompactionChunks(rows, 1_000);
  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.flat().map((row) => row.id), rows.map((row) => row.id));
});

test("story compaction budget always allows a user-authorized recovery probe", async () => {
  const {
    isStoryCompactionSoftBudgetError,
    LEGACY_STORY_COMPACTION_BUDGET_ERROR,
    resolveStoryCompactionBudgetDecision,
    STORY_COMPACTION_BUDGET_ERROR,
    STORY_COMPACTION_HARD_BUDGET_ERROR,
  } = await loadModule();
  const decide = (windowCalls: number, resumePending = false) =>
    resolveStoryCompactionBudgetDecision({ windowCalls, resumePending, softLimit: 150 });

  assert.equal(decide(149), "available");
  assert.equal(decide(150), "soft-capped");
  assert.equal(decide(150, true), "recovery-probe");
  assert.equal(decide(300, true), "recovery-probe");
  assert.equal(isStoryCompactionSoftBudgetError(STORY_COMPACTION_BUDGET_ERROR), true);
  assert.equal(isStoryCompactionSoftBudgetError(LEGACY_STORY_COMPACTION_BUDGET_ERROR), true);
  assert.equal(isStoryCompactionSoftBudgetError(STORY_COMPACTION_HARD_BUDGET_ERROR), true);
});

test("story compaction bounds each job while preserving an oldest-first remainder", async () => {
  const {
    createStoryCompactionAttemptBudget,
    selectStoryCompactionRunSlice,
    splitMessagesIntoCompactionChunks,
    STORY_COMPACTION_MAX_EPISODE_CHUNKS_PER_RUN,
    STORY_COMPACTION_MAX_PROVIDER_ATTEMPTS_PER_RUN,
  } = await loadModule();
  const rows = Array.from({ length: 80 }, (_, index) => makeMessage(index, 250));
  const { slice, remainder } = selectStoryCompactionRunSlice(rows);
  const chunks = splitMessagesIntoCompactionChunks(slice);

  assert.equal(chunks.length, STORY_COMPACTION_MAX_EPISODE_CHUNKS_PER_RUN);
  assert.equal(
    STORY_COMPACTION_MAX_PROVIDER_ATTEMPTS_PER_RUN,
    (STORY_COMPACTION_MAX_EPISODE_CHUNKS_PER_RUN + 1) * 2,
  );
  assert.deepEqual([...slice, ...remainder].map((row) => row.id), rows.map((row) => row.id));
  assert.equal(slice[0]!.id, rows[0]!.id);
  assert.equal(remainder[0]!.id, rows[slice.length]!.id);

  const budget = createStoryCompactionAttemptBudget(STORY_COMPACTION_MAX_PROVIDER_ATTEMPTS_PER_RUN);
  const consumed = await Promise.all(
    Array.from({ length: STORY_COMPACTION_MAX_PROVIDER_ATTEMPTS_PER_RUN + 8 }, async () => budget.tryConsume()),
  );
  assert.equal(
    consumed.filter(Boolean).length,
    STORY_COMPACTION_MAX_PROVIDER_ATTEMPTS_PER_RUN,
    "parallel episode promises share one synchronous per-run allowance",
  );
  assert.equal(budget.remaining(), 0);
  assert.equal(budget.tryConsume(), false, "a refusal fallback cannot exceed the allowance");
});

test("story compaction recovery starts a fresh soft window within the UTC day", async () => {
  const { resolveStoryCompactionBudgetWindowStart } = await loadModule();
  const dayStart = new Date("2026-09-04T00:00:00.000Z");
  const recoveredAt = new Date("2026-09-04T12:00:00.000Z");

  assert.equal(resolveStoryCompactionBudgetWindowStart(dayStart, recoveredAt), recoveredAt);
  assert.equal(
    resolveStoryCompactionBudgetWindowStart(dayStart, new Date("2026-09-03T23:59:59.000Z")),
    dayStart,
  );
});
