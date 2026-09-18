import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ─── Story-compaction triggering pins (2026-06-11) ──────────────────────────
// Source pins (same style as session-memory-retry.test.ts) for the triggering
// fixes: background failure cap, persist guards freed from the per-turn
// updatedAt race, summaryception not bumping the session row, and scoped
// edit/delete/swipe invalidation. Each pin keeps one leg of the fix from
// being refactored away independently.

const here = dirname(fileURLToPath(import.meta.url));
// Normalize line endings so the "\n}\n" block-extraction pins also hold on
// CRLF checkouts (Windows autocrlf).
const readSrc = (rel: string) => readFileSync(join(here, rel), "utf8").replace(/\r\n/g, "\n");
const compactionSrc = readSrc("session-compaction.ts");
const memorySrc = readSrc("session-memory.ts");
const summaryceptionSrc = readSrc("summaryception.ts");
const messagesSrc = readSrc("../routes/messages.ts");

test("background story compaction stops auto-retrying after the cap", () => {
  assert.match(compactionSrc, /STORY_COMPACTION_MAX_CONSECUTIVE_FAILURES = 3/, "cap constant missing or changed silently");
  const scheduleBlock = compactionSrc.slice(compactionSrc.indexOf("export function scheduleStoryCompaction"));
  assert.match(
    scheduleBlock.slice(0, 1200),
    /storyCompactionFailureCounts\.get\(args\.sessionId\)[\s\S]{0,80}STORY_COMPACTION_MAX_CONSECUTIVE_FAILURES/,
    "scheduleStoryCompaction must gate on the failure cap before enqueueing",
  );
  assert.match(
    scheduleBlock,
    /\.catch\(\(err\) => \{\s*storyCompactionFailureCounts\.set\(/,
    "the drain .catch must increment the failure count",
  );
});

test("failure count resets on successful persist and on manual paths", () => {
  const persistStart = compactionSrc.indexOf("async function persistStorySummaryResult");
  const persistEnd = compactionSrc.indexOf("async function loadSessionForSummary", persistStart);
  assert.ok(persistStart >= 0 && persistEnd > persistStart, "persist function boundaries must exist");
  const persistBlock = compactionSrc.slice(persistStart, persistEnd);
  assert.match(persistBlock, /storyCompactionFailureCounts\.delete\(args\.sessionId\)/, "successful persist must reset the failure count");
  const manualBlock = compactionSrc.slice(compactionSrc.indexOf("export function compactStorySummaryForSessionManually"));
  assert.match(manualBlock.slice(0, 800), /storyCompactionFailureCounts\.delete\(args\.sessionId\)/, "manual compaction must reset the failure count");
  const regenBlock = compactionSrc.slice(compactionSrc.indexOf("export function regenerateStorySummaryForSession"));
  assert.match(regenBlock.slice(0, 800), /storyCompactionFailureCounts\.delete\(args\.sessionId\)/, "manual regenerate must reset the failure count");
});

test("summary persists guard on status+hash, never on the per-turn updatedAt", () => {
  assert.ok(!compactionSrc.includes("expectedSessionUpdatedAt"), "story persist must not race play_sessions.updatedAt (every turn bumps it)");
  assert.ok(!memorySrc.includes("expectedSessionUpdatedAt"), "memory persist must not race play_sessions.updatedAt (a dropped turn is never re-learned)");
  const storyPersist = compactionSrc.slice(compactionSrc.indexOf("async function persistStorySummaryResult"));
  assert.match(storyPersist.slice(0, 1600), /summaryStatus, "updating"/);
  assert.match(storyPersist.slice(0, 1600), /summarySourceHash, args\.job\.sourceHash/);
  const memoryPersist = memorySrc.slice(memorySrc.indexOf("async function persistSessionMemoryResult"));
  assert.match(memoryPersist.slice(0, 1600), /sessionMemoryStatus, "updating"/);
  assert.match(memoryPersist.slice(0, 1600), /sessionMemorySourceHash, args\.job\.sourceHash/);
});

test("summaryception job bookkeeping does not bump the session-row updatedAt", () => {
  const updatingBlock = summaryceptionSrc.slice(summaryceptionSrc.indexOf("async function markUpdating"));
  assert.ok(!updatingBlock.slice(0, 600).includes("updatedAt: new Date()"), "markUpdating must not bump play_sessions.updatedAt");
  const failedBlock = summaryceptionSrc.slice(summaryceptionSrc.indexOf("async function markFailed"));
  assert.ok(!failedBlock.slice(0, 600).includes("updatedAt: new Date()"), "markFailed must not bump play_sessions.updatedAt");
});

test("persisted summary model ids go through applyModelRedirect on background paths", () => {
  for (const [name, src] of [["session-compaction.ts", compactionSrc], ["session-memory.ts", memorySrc], ["summaryception.ts", summaryceptionSrc]] as const) {
    assert.match(src, /applyModelRedirect\(/, `${name} must redirect deprecated persisted model ids`);
  }
});

test("history rewrites clear summaryception and abort in-flight jobs", () => {
  const sessionsSrc = readSrc("../routes/sessions.ts");
  // The dispatch call sites wrap across lines, so match on the reason strings.
  const dispatches = sessionsSrc.match(/reason: "(session-revert|session-restart|checkpoint-restore)"/g) ?? [];
  assert.ok(dispatches.length >= 3, `revert+restart+checkpoint-restore must dispatch extension invalidation, found ${dispatches.length}`);
  // 2026-09-01: the lag-one drop (`memProcId !== lastCopiedAssistantId`) was
  // deliberately REMOVED — wiping destroyed the whole accumulated memory
  // whenever the branch/revert point was the processed turn. The keep rule is
  // now "pointer maps into the copied messages"; a swipe of a covered tip
  // stamps the stale-confession instead (see hooks.ts).
  assert.match(
    sessionsSrc,
    /idMap\.has\(memProcId\)/,
    "branch must keep session memory only when its processed turn is among the copied messages",
  );
  assert.ok(
    !sessionsSrc.includes("memProcId !== lastCopiedAssistantId"),
    "the branch lag-one drop must not come back — it wiped accumulated memory on tip-branches",
  );
  const hooksSrc = readSrc("../extensions/session-memory/hooks.ts");
  assert.match(hooksSrc, /clearSummaryceptionData\(ctx\.sessionId\)/, "lifecycle invalidation must clear summaryception snippets");
  const helperIdx = hooksSrc.indexOf("function invalidateForChangedMessage");
  const helper = hooksSrc.slice(helperIdx, hooksSrc.indexOf("\n}\n", helperIdx) + 2);
  assert.match(helper, /summaryStatus, "updating"/, "scoped invalidation must abort an in-flight story job");
  assert.match(helper, /sessionMemoryStatus, "updating"/, "scoped invalidation must abort an in-flight memory job");
});

test("edit/delete/swipe invalidation is scoped and never wipes session memory", () => {
  const hooksSrc = readSrc("../extensions/session-memory/hooks.ts");
  const helperIdx = hooksSrc.indexOf("function invalidateForChangedMessage");
  assert.ok(helperIdx >= 0, "scoped invalidation helper missing from extensions/session-memory/hooks.ts");
  const helper = hooksSrc.slice(helperIdx, hooksSrc.indexOf("\n}\n", helperIdx) + 2);
  assert.match(helper, /compacted === true/, "story invalidation must be scoped to compacted messages");
  assert.match(helper, /summaryceptionCompacted === true/, "summaryception invalidation must be scoped to covered messages");
  assert.ok(!helper.includes("sessionMemory:"), "the scoped helper must never touch structured session memory");
  const edits = messagesSrc.match(/reason: "message-(edited|deleted|swiped)"/g) ?? [];
  assert.ok(edits.length >= 5, `expected the 5 edit/delete/swipe sites to dispatch invalidation, found ${edits.length}`);
});

test("message edits and deletes invalidate with post-write compacted flags", () => {
  const editStart = messagesSrc.indexOf('messageRoutes.patch("/messages/:id"');
  const deleteStart = messagesSrc.indexOf('messageRoutes.delete("/messages/:id"');
  const regenerateStart = messagesSrc.indexOf('messageRoutes.post("/messages/:id/regenerate"');
  const editBlock = messagesSrc.slice(editStart, deleteStart);
  const deleteBlock = messagesSrc.slice(deleteStart, regenerateStart);

  assert.match(editBlock, /messageFlags: result\[0\] \?\? msg/);
  assert.match(deleteBlock, /db\.delete\(messages\)[\s\S]*\.returning\(\)/);
  assert.match(deleteBlock, /messageFlags: deleted\[0\] \?\? msg/);
  const postWriteSwipeFlags = messagesSrc.match(/messageFlags: updatedMessage \?\? msg/g) ?? [];
  assert.equal(postWriteSwipeFlags.length, 3);
});

test("raw rows included by small manual regeneration still invalidate the summary", () => {
  const hooksSrc = readSrc("../extensions/session-memory/hooks.ts");
  assert.match(hooksSrc, /getChangedMessageStoryCoverage/);
  assert.match(hooksSrc, /summaryCoversUntilMessageId/);
  assert.match(hooksSrc, /rawCoverageReset/);
  assert.match(hooksSrc, /eq\(playSessions\.summarySourceHash, rawCoverage\.sourceHash\)/);
});

test("story summaries disable reasoning, probe custom endpoints, and never bill empty output", () => {
  const generateBlock = compactionSrc.slice(
    compactionSrc.indexOf("async function generateStorySummaryTextOnce"),
    compactionSrc.indexOf("function buildMergeSummaryPrompt"),
  );
  assert.match(generateBlock, /disableReasoning: true/, "summary calls must disable hidden reasoning");
  assert.match(
    generateBlock,
    /finalizeStorySummaryOutput\([\s\S]*recordUsage:[\s\S]*billUsage:/,
    "summary generation must delegate usage and billing order to the tested finalizer",
  );

  const summarizeBlock = compactionSrc.slice(
    compactionSrc.indexOf("async function summarizeRowsWithMetadata"),
    compactionSrc.indexOf("async function summarizeRows("),
  );
  assert.match(
    summarizeBlock,
    /summarizeStoryEpisodeTranscripts\([\s\S]*probeFirst: args\.model\.startsWith\("custom\/"\)/,
    "custom endpoints must succeed on one probe before concurrent fan-out",
  );
});
