import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateMessageTokens,
  estimateMessagesTokens,
  getStoryCompactionProgress,
  selectCompactionWindow,
  type StoryMessageRow,
  type StoryMessageSizing,
} from "./session-compaction-core.js";

// ─── Body-free sizing (2026-08-15 502 incident) ─────────────────────────────
// routes/session-memory.ts used to load every uncompacted message BODY just to
// render the memory panel's counts — ~52 MB and 20-46 s of event-loop block on
// a 7k-message session, which 502'd the whole site. It now reads the
// precomputed messages.content_len / content_cjk_len integers instead.
//
// The contract that makes that safe: for the SAME messages, the metrics path
// must report the SAME numbers as the body path. If these drift, users see
// their memory usage jump for no reason. A LIMIT was rejected for exactly this
// reason (it changes the totals), so the equivalence has to be pinned by tests.

/** Mirror of estimateCjkAware's classification, used to build fixtures. */
function cjkCount(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff)) n++;
  }
  return n;
}

function withBody(
  id: string,
  role: "user" | "assistant" | "system",
  content: string,
  attachments: Array<unknown> | null = null,
): StoryMessageRow {
  return { id, role, content, attachments, createdAt: new Date("2026-01-01") };
}

/** What the DB query produces: same row, metrics instead of the body. */
function sizingOf(row: StoryMessageRow): StoryMessageSizing {
  return {
    id: row.id,
    role: row.role,
    attachments: row.attachments ?? null,
    createdAt: row.createdAt,
    contentLen: row.content.length,
    contentCjkLen: cjkCount(row.content),
  };
}

const CJK_MODEL = "google/gemini-3.1-flash-lite"; // takes the CJK-aware branch

const FIXTURES: StoryMessageRow[] = [
  withBody("m1", "user", "我们该往哪边走？"),
  withBody("m2", "assistant", "她转向窗户，午后的光落在她下颌的线条上。".repeat(12)),
  withBody("m3", "user", "plain ASCII only, no CJK at all"),
  withBody("m4", "assistant", "混合 text，测试。mixed content with 中文 and English".repeat(30)),
  withBody("m5", "user", ""),
  withBody("m6", "assistant", "안녕하세요, 반갑습니다".repeat(8)),
  withBody("m7", "user", "with an attachment", [{ type: "image" }, { type: "image" }]),
  withBody("m8", "system", "system rows are filtered out before counting"),
  withBody("m9", "assistant", "こんにちは、world".repeat(50)),
];

test("per-message estimate is identical from metrics and from the body", () => {
  for (const row of FIXTURES) {
    assert.equal(
      estimateMessageTokens(sizingOf(row), CJK_MODEL),
      estimateMessageTokens(row, CJK_MODEL),
      `token estimate drifted for ${row.id}`,
    );
  }
});

test("role label length is counted, not silently dropped", () => {
  // "user: " and "assistant: " differ by 5 ASCII chars; the estimator sees the
  // label, so a metrics row that ignored it would under-count long transcripts.
  const sameBody = "x".repeat(400);
  const asUser = withBody("u", "user", sameBody);
  const asAssistant = withBody("a", "assistant", sameBody);
  assert.notEqual(
    estimateMessageTokens(sizingOf(asUser), CJK_MODEL),
    estimateMessageTokens(sizingOf(asAssistant), CJK_MODEL),
  );
  assert.equal(estimateMessageTokens(sizingOf(asUser), CJK_MODEL), estimateMessageTokens(asUser, CJK_MODEL));
  assert.equal(
    estimateMessageTokens(sizingOf(asAssistant), CJK_MODEL),
    estimateMessageTokens(asAssistant, CJK_MODEL),
  );
});

test("attachment surcharge survives the body-free path", () => {
  const withFiles = FIXTURES.find((m) => m.id === "m7")!;
  const bare = withBody("m7b", "user", withFiles.content);
  assert.ok(
    estimateMessageTokens(sizingOf(withFiles), CJK_MODEL) > estimateMessageTokens(sizingOf(bare), CJK_MODEL),
    "attachments must still cost tokens when estimating without bodies",
  );
  assert.equal(estimateMessageTokens(sizingOf(withFiles), CJK_MODEL), estimateMessageTokens(withFiles, CJK_MODEL));
});

test("totals over the whole backlog match the body path", () => {
  assert.equal(
    estimateMessagesTokens(FIXTURES.map(sizingOf), CJK_MODEL),
    estimateMessagesTokens(FIXTURES, CJK_MODEL),
  );
});

test("panel progress is byte-for-byte identical from metrics rows", () => {
  const opts = { triggerTokens: 400, recentTailTokens: 150, minCompactableTokens: 40, modelId: CJK_MODEL };
  assert.deepEqual(
    getStoryCompactionProgress(FIXTURES.map(sizingOf), opts),
    getStoryCompactionProgress(FIXTURES, opts),
  );
});

test("compaction window splits at the same message from metrics rows", () => {
  const opts = { triggerTokens: 400, recentTailTokens: 150, minCompactableTokens: 40, modelId: CJK_MODEL };
  const fromBodies = selectCompactionWindow(FIXTURES, opts);
  const fromMetrics = selectCompactionWindow(FIXTURES.map(sizingOf), opts);
  assert.ok(fromBodies, "fixture should produce a window");
  assert.ok(fromMetrics, "metrics rows should produce the same window");
  assert.deepEqual(
    fromMetrics.compactable.map((m) => m.id),
    fromBodies.compactable.map((m) => m.id),
  );
  assert.deepEqual(
    fromMetrics.retained.map((m) => m.id),
    fromBodies.retained.map((m) => m.id),
  );
  assert.equal(fromMetrics.estimatedTotalTokens, fromBodies.estimatedTotalTokens);
  assert.equal(fromMetrics.estimatedCompactableTokens, fromBodies.estimatedCompactableTokens);
});

test("a row missing its metrics still estimates from the body it carries", () => {
  // The COALESCE in the query means this should not happen, but a partial row
  // must degrade to the old behaviour rather than silently counting as zero.
  const row = withBody("m1", "user", "我们该往哪边走？");
  const partial: StoryMessageSizing = { ...row, contentLen: null, contentCjkLen: null };
  assert.equal(estimateMessageTokens(partial, CJK_MODEL), estimateMessageTokens(row, CJK_MODEL));
  assert.ok(estimateMessageTokens(partial, CJK_MODEL) > 6);
});

test("non-CJK models estimate from metrics without touching the tokenizer", () => {
  // Option A: GPT/Grok/Qwen panels fall back to the character heuristic rather
  // than running cl100k over megabytes of text. Deliberately approximate — but
  // it must stay monotonic and non-zero, not collapse to a constant.
  const short = { id: "s", role: "user", contentLen: 100, contentCjkLen: 0 };
  const long = { id: "l", role: "user", contentLen: 10_000, contentCjkLen: 0 };
  const a = estimateMessageTokens(short, "openai/gpt-5");
  const b = estimateMessageTokens(long, "openai/gpt-5");
  assert.ok(a > 6, "short message should cost more than the per-message overhead");
  assert.ok(b > a * 10, "estimate must scale with length");
});
