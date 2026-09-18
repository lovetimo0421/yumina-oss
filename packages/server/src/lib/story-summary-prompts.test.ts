import assert from "node:assert/strict";
import test from "node:test";
import { buildEpisodeSummaryPrompt, recoverStoryMerge, withStoryMergeBudget } from "./story-summary-prompts.js";
import { memoryPromptWithBudget } from "./session-memory-prompts.js";
import { StorySummaryTruncatedError } from "./summary-episode-recovery.js";
import { createStoryCompactionAttemptBudget, finalizeStorySummaryOutput, STORY_SUMMARY_MAX_CHARS } from "./session-compaction-core.js";
import type { ChatMessage } from "./llm/types.js";

const input = { worldName: "灰岸", transcript: "林澄保管青铜钥匙，第三次潮汐后归还。", language: "zh-Hans" as const };
const text = (recovery = false) => buildEpisodeSummaryPrompt({ ...input, recovery }).map(message => String(message.content)).join("\n");

test("episode prompt uses soft targets while retaining names, language, and ending", () => {
  const prompt = text();
  assert.match(prompt, /writing targets, not strict quotas/);
  assert.match(prompt, /2-3 concise sentences/);
  assert.match(prompt, /prefer around 8 concise items TOTAL/);
  assert.match(prompt, /Preserve essential facts even if this needs extra items/);
  assert.doesNotMatch(prompt, /must stay within|at most \d+ (tokens|items)/);
  assert.match(prompt, /Use \[\] for a list with no essential new fact/);
  assert.match(prompt, /Never repeat a fact/);
  assert.match(prompt, /endingOneLine/);
  assert.match(prompt, /Never translate, transliterate, or re-romanize a name/);
  assert.match(prompt, /Simplified Chinese/);
  assert.ok(prompt.includes(input.transcript));
  assert.doesNotMatch(prompt, /5-10 sentence/);
});

test("recovery reduces requested output rather than repeating the full episode requirements", () => {
  const normal = text();
  const compact = text(true);
  assert.match(compact, /writing targets, not strict quotas/);
  assert.match(compact, /Aim for about 600 tokens/);
  assert.match(compact, /one concise sentence/);
  assert.match(compact, /prefer around 4 concise items TOTAL/);
  assert.doesNotMatch(compact, /2-3 concise sentences|8 concise items TOTAL/);
  assert.notEqual(compact, normal, "identical transcript inputs must produce different full/recovery cache inputs");
  assert.ok(compact.includes(input.transcript));
});

test("both prompts retain the episode fields the merge and player notification consume", () => {
  for (const recovery of [false, true]) {
    const user = String(buildEpisodeSummaryPrompt({ ...input, recovery })[1]!.content);
    const shape = JSON.parse(user.slice(user.indexOf('{'), user.lastIndexOf('}') + 1));
    assert.deepEqual(Object.keys(shape), ["title", "summary", "endingOneLine", "majorEvents", "relationshipChanges", "decisionsAndPromises", "goalsAndOpenThreads", "worldStateAndInventory", "risksAndConstraints", "keywords"]);
    for (const value of Object.values(shape).slice(3)) assert.deepEqual(value, []);
    assert.match(user, /never omit closing JSON syntax/);
  }
});

const memoryEvidence: ChatMessage[] = [
  { role: "system", content: "Write facts in Traditional Chinese. Keep headings in English." },
  { role: "user", content: "Existing memory: OLD EVENT LOG. New exchange: the compass must be returned tomorrow." },
];
// Distinct facts reproduce the oversized complete-draft case, not repetition.
const completeDraft = Array.from({ length: 250 }, (_, i) => `- Person ${i} holds item ${i}; return it at checkpoint ${i}.`).join("\n");

test("oversized complete memory is compacted directly instead of replaying the old event log", () => {
  const original = structuredClone(memoryEvidence);
  const prompt = memoryPromptWithBudget(memoryEvidence, 1500, true, { text: completeDraft, stopReason: "stop", completionTokens: 4500 });
  const system = String(prompt[0]!.content);
  const evidence = String(prompt[1]!.content);
  assert.ok(evidence.includes(completeDraft), "the complete candidate carries old facts and newly extracted changes");
  assert.doesNotMatch(evidence, /OLD EVENT LOG/);
  assert.match(system, /Traditional Chinese/);
  assert.match(system, /1500 characters TOTAL.*1500 output tokens/);
  assert.match(system, /supersedes ALL earlier length guidance/);
  assert.doesNotMatch(system, /7000/, "do not give the model a second, larger target");
  assert.deepEqual(memoryEvidence, original);
});

test("truncated or repetitive memory drafts never replace the original evidence", () => {
  for (const candidate of [
    { text: completeDraft, stopReason: "max_tokens", completionTokens: 8192 },
    { text: "The same repeated fact loops without adding anything new. ".repeat(180), stopReason: "stop", completionTokens: 4000 },
  ]) {
    const prompt = memoryPromptWithBudget(memoryEvidence, 3500, true, candidate);
    assert.deepEqual(prompt.slice(1), memoryEvidence.slice(1));
  }
});

test("merge targets permit essential detail beyond the target and preserve original evidence", () => {
  const prompt: ChatMessage[] = [
    { role: "system", content: "Write facts in Simplified Chinese." },
    { role: "user", content: "Previous story: Lin owes Mei a map. Completed episodes: Lin found it. Current state: the bridge is closed." },
  ];
  for (const recovery of [false, true]) {
    const bounded = withStoryMergeBudget(prompt, recovery);
    assert.deepEqual(bounded.slice(1), prompt.slice(1));
    assert.match(String(bounded[0]!.content), /Simplified Chinese/);
    assert.match(String(bounded[0]!.content), /Rewrite the whole summary/);
    assert.match(String(bounded[0]!.content), /## Story So Far/);
    assert.match(String(bounded[0]!.content), /## Major Open Threads/);
    assert.match(String(bounded[0]!.content), /## Important Past Events/);
    assert.match(String(bounded[0]!.content), /soft writing target, not a strict limit/);
    assert.doesNotMatch(String(bounded[0]!.content), /at most \d+ (bullets|sentences|tokens)/);
  }
  assert.match(String(withStoryMergeBudget(prompt, true)[0]!.content), /1200 tokens/);
  assert.notDeepEqual(withStoryMergeBudget(prompt, false), withStoryMergeBudget(prompt, true));
});

test("truncated merge retries once, bills only complete text, and uses the shared attempt budget", async () => {
  const recoveries: boolean[] = [];
  const budget = createStoryCompactionAttemptBudget(2);
  let recorded = 0, billed = 0;
  const result = await recoverStoryMerge({ generate: async (recovery) => {
    recoveries.push(recovery);
    assert.ok(budget.tryConsume());
    return finalizeStorySummaryOutput({
      text: recovery ? "## Story So Far\nLin recovered the map.\n## Major Open Threads\n- Return it to Mei.\n## Important Past Events\n- The bridge closed." : "## Story So Far\nUnfinished",
      stopReason: recovery ? "stop" : "max_tokens",
      recordUsage: async () => { recorded++; }, billUsage: async () => { billed++; },
    });
  } });
  assert.deepEqual(recoveries, [false, true]);
  assert.equal(recorded, 2); assert.equal(billed, 1); assert.equal(budget.remaining(), 0);
  assert.match(result, /Return it to Mei/);
});

test("merge recovery cannot loop or retry provider errors or cancellation", async () => {
  let attempts = 0;
  await assert.rejects(recoverStoryMerge({ generate: async () => { attempts++; throw new StorySummaryTruncatedError(); } }), StorySummaryTruncatedError);
  assert.equal(attempts, 2);
  for (const error of [new Error("Provider unavailable"), new DOMException("Cancelled", "AbortError")]) {
    attempts = 0;
    await assert.rejects(recoverStoryMerge({ generate: async () => { attempts++; throw error; } }), error);
    assert.equal(attempts, 1);
  }
  const controller = new AbortController();
  attempts = 0;
  await assert.rejects(recoverStoryMerge({ signal: controller.signal, generate: async () => {
    attempts++; controller.abort(); throw new StorySummaryTruncatedError();
  } }), { name: "AbortError" });
  assert.equal(attempts, 1);
});

test("complete summaries keep their final facts up to the storage ceiling and never bill a sliced result", async () => {
  const ending = "\n## Important Past Events\nThe bridge closed.";
  const complete = "S".repeat(STORY_SUMMARY_MAX_CHARS - ending.length) + ending;
  let billed = 0, recorded = 0;
  const finalize = (text: string) => finalizeStorySummaryOutput({
    text, stopReason: "stop",
    recordUsage: async () => { recorded++; }, billUsage: async () => { billed++; },
  });
  assert.equal(await finalize("```md\n" + complete + "\n```"), complete);
  await assert.rejects(finalize("S" + complete), /exceeded the safe storage size/);
  assert.equal(recorded, 2);
  assert.equal(billed, 1);
});

test("a complete summary above the safety ceiling gets one recovery instead of a silent slice", async () => {
  let calls = 0, billed = 0;
  const run = (alwaysTooLong = false) => recoverStoryMerge({ generate: async recovery => {
    calls++;
    return finalizeStorySummaryOutput({
      text: !recovery || alwaysTooLong ? "S".repeat(STORY_SUMMARY_MAX_CHARS + 1) : "## Story So Far\nComplete current situation.",
      stopReason: "stop", billUsage: async () => { billed++; },
    });
  } });
  assert.equal(await run(), "## Story So Far\nComplete current situation.");
  assert.equal(calls, 2);
  assert.equal(billed, 1);
  calls = 0; billed = 0;
  await assert.rejects(run(true), /exceeded the safe storage size/);
  assert.equal(calls, 2);
  assert.equal(billed, 0);
});
