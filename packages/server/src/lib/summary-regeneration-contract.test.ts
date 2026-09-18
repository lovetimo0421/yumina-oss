import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { SUMMARY_CLAIM_TTL_MS } from "./summary-job-core.js";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const compaction = read("./session-compaction.ts");

test("summary safety caps leave room to complete output above soft writing targets", () => {
  const episodePrompt = read("./story-summary-prompts.ts");
  assert.match(episodePrompt, /writing targets, not strict quotas/);
  assert.match(compaction, /const MAX_EPISODE_SUMMARY_TOKENS = 2_048;/);
  assert.match(compaction, /const MAX_MERGE_SUMMARY_TOKENS = 4_096;/);
  assert.match(compaction, /prompt: withStoryMergeBudget\(mergePrompt, recovery\),\s*endpoint: "story-compaction",\s*maxTokens: MAX_MERGE_SUMMARY_TOKENS/);
  const episodeCall = compaction.slice(compaction.indexOf("const summarizeEpisode ="), compaction.indexOf("const EPISODE_CONCURRENCY"));
  assert.match(episodeCall, /prompt: promptFor\(text, recovery\)[\s\S]*maxTokens: MAX_EPISODE_SUMMARY_TOKENS/);
  assert.match(compaction, /prompt: promptFor\(transcript, recovery\), maxTokens: MAX_EPISODE_SUMMARY_TOKENS/);
  assert.match(episodeCall, /load: \(text, recovery\) => loadEpisodeCheckpoint\(keyFor\(text, recovery\)\)/);
  assert.match(compaction, /signal: args.signal/);
});

test("regenerate authenticates ownership before queueing and returns a tracked receipt", () => {
  const routes = read("../routes/session-memory.ts");
  const start = routes.indexOf('sessionMemoryRoutes.post("/:sessionId/summary/regenerate"');
  const route = routes.slice(start, routes.indexOf('sessionMemoryRoutes.post("/:sessionId/summary/compact"', start));
  assert.match(route, /rateLimitMiddleware\("ai-generation"\)/);
  assert.ok(route.indexOf("if (!row)") < route.indexOf("discardQueuedStoryCompactions"));
  assert.ok(route.indexOf("if (!row)") < route.indexOf("summaryJobs.start"));
  assert.match(route, /summaryJobs.start\(summaryJobKey\(currentUser.id, sessionId\), async \(run\)/);
  assert.match(route, /regenerateStorySummaryForSession\(\{ sessionId, userId: currentUser.id, model, run \}\)/);
  assert.match(route, /return c.json\([\s\S]*job,[\s\S]*202\)/);
  assert.match(routes, /summaryJobs.read\(summaryJobKey\(row.userId, row.id\)\).catch\(\(\) => null\)/);
});

test("summary UI polls active jobs, reconciles lost receipts, and disables repeat clicks", () => {
  const ui = read("../../../app/sandbox/extensions/session-memory/session-memory-modal.tsx");
  assert.match(ui, /setInterval\(poll, anyUpdating \? 1500 : 4000\)/);
  assert.match(ui, /const current = await api.getSessionSummary\(\);[\s\S]*current.job\?\.status === "queued"/);
  assert.match(ui, /onClick=\{handleRegenerateSummary\}\s*disabled=\{[^}]*summaryJobActive/);
  assert.match(ui, /summaryJobActive && \([\s\S]*role="status"/);
});

test("expired database claims allow replacement and reject an old worker's persist", async () => {
  // Exercise PostgreSQL's conditional-update behavior in isolated PGlite,
  // and pin the production predicates/lease to the same contract below.
  const client = new PGlite();
  try {
    await client.exec("CREATE TABLE play_sessions (id TEXT PRIMARY KEY, summary_status TEXT, summary_claimed_at TIMESTAMPTZ, summary_source_hash TEXT, summary TEXT)");
    const started = new Date("2026-09-08T00:00:00Z");
    await client.query("INSERT INTO play_sessions VALUES ('s', 'updating', $1, 'first-run-hash', NULL)", [started]);
    const claim = (now: Date) => client.query(`UPDATE play_sessions
      SET summary_claimed_at = $1, summary_source_hash = 'replacement-run-hash'
      WHERE id = 's' AND (summary_status <> 'updating' OR summary_claimed_at IS NULL OR summary_claimed_at < $2)
      RETURNING id`, [now, new Date(now.getTime() - SUMMARY_CLAIM_TTL_MS)]);
    assert.equal((await claim(new Date(started.getTime() + 60_000))).rows.length, 0);
    assert.equal((await claim(new Date(started.getTime() + SUMMARY_CLAIM_TTL_MS + 31_000))).rows.length, 1);
    const persist = (hash: string) => client.query("UPDATE play_sessions SET summary = 'complete', summary_status = 'idle' WHERE id = 's' AND summary_status = 'updating' AND summary_source_hash = $1 RETURNING id", [hash]);
    assert.equal((await persist("first-run-hash")).rows.length, 0);
    assert.equal((await persist("replacement-run-hash")).rows.length, 1);
    assert.match(compaction, /STORY_COMPACTION_CLAIM_TTL_MS = SUMMARY_CLAIM_TTL_MS/);
    assert.equal((compaction.match(/runId: args.run\?\.id/g) ?? []).length, 2);
    assert.match(compaction, /lt\(playSessions.summaryClaimedAt, new Date\(now.getTime\(\) - STORY_COMPACTION_CLAIM_TTL_MS\)\)/);
    const persistCode = compaction.slice(compaction.indexOf("async function persistStorySummaryResult"));
    assert.match(persistCode, /eq\(playSessions.summarySourceHash, args.job.sourceHash\)/);
  } finally { await client.close(); }
});
