import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { collectExtensionInvalidation, type InvalidateContext } from "../../lib/extension-hooks.js";
import { registerSessionMemoryExtension } from "./hooks.js";

// invalidateForRevert decides, per memory tier, whether the reverted timeline
// can KEEP the stored output or must reset it. We register the real extension
// and inspect the sessionFields it returns for reason "session-revert": a
// tier's reset constants appear only when that tier is DROPPED, so an
// empty/partial sessionFields proves the keep.
//
// One rule for all three tiers — "keep when the stored output covers no
// deleted message":
// - Story summary: kept unless a removed message was compacted into it (or
//   its covers-until pointer was removed). A mid-flight compaction is aborted
//   (status/hash reset) but the stored TEXT stays. Before this rule every
//   revert dropped the summary and re-summarized the whole transcript — a
//   1,800-message session burned its daily compaction budget in 15 minutes
//   and showed a blank "failed" summary for the rest of the day (hhltwz
//   report, 2026-09-04).
// - Layered summary: keep-when-valid on its own compaction flag.
// - Session memory: kept whenever its processed pointer SURVIVES the revert,
//   even mid-flight: the in-flight job set the pointer to the turn it is
//   folding, so a surviving pointer proves the stored (older) memory holds no
//   deleted-turn facts. Only a deleted or null pointer forces the wipe +
//   eager rebuild.
//
// This is the decision half; the DB-touching runAfter (unmark flags / clear
// snippets / eager rebuild) is exercised end-to-end by the revert integration path.

describe("session-memory invalidate: coverage-aware revert", () => {
  before(() => {
    // Each test file runs in its own process (node --test isolation), so this
    // registers the one real extension this suite inspects.
    registerSessionMemoryExtension();
  });

  const baseSession = {
    summary: "running summary",
    summaryStatus: "idle",
    summaryCoversUntilMessageId: "m-compacted",
    summaryceptionStatus: "idle",
    sessionMemory: { text: "- the hero met the stranger" },
    sessionMemoryStatus: "idle",
    sessionMemoryProcessedMessageId: "m-proc",
  };

  function revert(
    removedMessages: InvalidateContext["removedMessages"],
    opts: {
      session?: Record<string, unknown>;
    } = {},
  ) {
    return collectExtensionInvalidation({
      reason: "session-revert",
      sessionId: "s1",
      session: opts.session ?? baseSession,
      removedMessages,
    });
  }

  it("keeps every tier when the deleted tail is uncovered", () => {
    const { sessionFields } = revert([{ id: "m-after", compacted: false, summaryceptionCompacted: false }]);
    assert.ok(!("summary" in sessionFields), "story summary kept");
    assert.ok(!("summaryCoversUntilMessageId" in sessionFields));
    assert.ok(!("sessionMemory" in sessionFields), "session memory kept");
    assert.ok(!("summaryceptionSourceHash" in sessionFields), "layered summary kept");
  });

  it("drops the story summary when a removed message was compacted into it", () => {
    const { sessionFields } = revert([{ id: "m-after", compacted: true, summaryceptionCompacted: false }]);
    assert.equal(sessionFields.summary, null);
    assert.equal(sessionFields.summaryCoversUntilMessageId, null);
    assert.ok(!("sessionMemory" in sessionFields), "session memory kept");
  });

  it("drops the story summary when its covers-until pointer is in the deleted tail", () => {
    // Belt and braces: a removed message that lost its compacted flag but is
    // still the summary's recorded end must not keep a summary describing it.
    const { sessionFields } = revert([{ id: "m-compacted", compacted: false, summaryceptionCompacted: false }]);
    assert.equal(sessionFields.summary, null);
  });

  it("keeps the story summary text but aborts a mid-flight compaction", () => {
    const session = { ...baseSession, summaryStatus: "updating" };
    const { sessionFields } = revert([{ id: "m-after", compacted: false, summaryceptionCompacted: false }], { session });
    assert.ok(!("summary" in sessionFields), "stored summary text kept");
    assert.equal(sessionFields.summaryStatus, "idle", "in-flight job aborted");
    assert.equal(sessionFields.summarySourceHash, null, "in-flight job's persist guard invalidated");
  });

  it("resets the compaction job bookkeeping on every keep, even when the row read as idle", () => {
    // The revert route reads the session row BEFORE it deletes the tail. A
    // compaction can claim the row in that window; its persist guard checks
    // status + source hash, so the keep path must always clear both — the
    // old unconditional drop did this for free. Cost: one lost dedupe hash.
    const { sessionFields } = revert([{ id: "m-after", compacted: false, summaryceptionCompacted: false }]);
    assert.ok(!("summary" in sessionFields), "stored summary text kept");
    assert.equal(sessionFields.summaryStatus, "idle");
    assert.equal(sessionFields.summarySourceHash, null);
    assert.equal(sessionFields.summaryClaimedAt, null);
  });

  it("drops a story summary that has no covers-until pointer (coverage cannot be verified)", () => {
    // Legacy rows and the old regenerate-small path left the pointer null;
    // without it nothing proves the summary stops before the deleted tail.
    const session = { ...baseSession, summaryCoversUntilMessageId: null };
    const { sessionFields } = revert([{ id: "m-after", compacted: false, summaryceptionCompacted: false }], { session });
    assert.equal(sessionFields.summary, null);
  });

  it("drops the layered summary when a removed message was layer-compacted", () => {
    const { sessionFields } = revert([{ id: "m-after", compacted: false, summaryceptionCompacted: true }]);
    assert.equal(sessionFields.summaryceptionStatus, "idle");
    assert.ok("summaryceptionSourceHash" in sessionFields);
    assert.ok(!("sessionMemory" in sessionFields), "session memory kept");
    assert.ok(!("summary" in sessionFields), "story summary kept");
  });

  it("drops session memory when its processed turn is in the deleted tail", () => {
    const { sessionFields } = revert([{ id: "m-proc", compacted: false, summaryceptionCompacted: false }]);
    assert.equal(sessionFields.sessionMemory, null);
    assert.equal(sessionFields.sessionMemoryProcessedMessageId, null);
  });

  it("keeps session memory when its processed turn survives as the new tip (one-exchange rewind)", () => {
    const { sessionFields } = revert([{ id: "m-after", compacted: false, summaryceptionCompacted: false }]);
    assert.ok(!("sessionMemory" in sessionFields), "session memory kept");
    assert.ok(!("sessionMemoryProcessedMessageId" in sessionFields));
  });

  it("keeps session memory when an update is mid-flight but its pointer survives", () => {
    // The in-flight job already moved the pointer to the turn it is folding;
    // that turn surviving means the stored memory only describes older turns.
    const session = { ...baseSession, sessionMemoryStatus: "updating" };
    const { sessionFields } = revert([{ id: "m-after", compacted: false, summaryceptionCompacted: false }], { session });
    assert.ok(!("sessionMemory" in sessionFields), "session memory kept");
  });

  it("drops session memory when a mid-flight update's pointer is in the deleted tail", () => {
    const session = { ...baseSession, sessionMemoryStatus: "updating" };
    const { sessionFields } = revert([{ id: "m-proc", compacted: false, summaryceptionCompacted: false }], { session });
    assert.equal(sessionFields.sessionMemory, null);
  });

  it("drops session memory when the processed pointer is null (cannot be verified)", () => {
    const session = { ...baseSession, sessionMemoryProcessedMessageId: null };
    const { sessionFields } = revert([{ id: "m-after", compacted: false, summaryceptionCompacted: false }], { session });
    assert.equal(sessionFields.sessionMemory, null, "null pointer can't be verified → wipe");
  });

  it("falls back to a full wipe when the deleted tail is not supplied", () => {
    const { sessionFields } = collectExtensionInvalidation({ reason: "session-revert", sessionId: "s1" });
    assert.equal(sessionFields.summary, null);
    assert.equal(sessionFields.sessionMemory, null);
    assert.ok("summaryceptionSourceHash" in sessionFields, "layered summary reset too");
  });
});
