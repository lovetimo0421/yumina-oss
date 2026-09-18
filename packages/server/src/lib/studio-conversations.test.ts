import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { db, ensureTables } from "../db/index.js";
import { agentRuns, user, worlds, studioConversations } from "../db/schema.js";
import {
  deleteStudioConversationForWorld,
  loadAgentHistoryForConversation,
  loadStudioConversationForDisplay,
  loadStudioConversationForWorld,
  serverOwnedStudioRunsToAgentHistory,
  updateStudioConversationForWorld,
  withStudioUserMessageContext,
} from "./studio-conversations.js";

async function ensureStudioConversationTestSchema() {
  await ensureTables();

  const ddl = [
    `ALTER TABLE "user" ADD COLUMN IF NOT EXISTS referral_code TEXT`,
    `ALTER TABLE "user" ADD COLUMN IF NOT EXISTS referred_by TEXT`,
    `ALTER TABLE "user" ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT`,
    `ALTER TABLE "user" ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT`,
    `ALTER TABLE worlds ADD COLUMN IF NOT EXISTS search_doc TEXT`,
    `ALTER TABLE worlds ADD COLUMN IF NOT EXISTS search_doc_normalized TEXT`,
    `ALTER TABLE worlds ADD COLUMN IF NOT EXISTS embedding TEXT`,
    `ALTER TABLE worlds ADD COLUMN IF NOT EXISTS embedding_updated_at TIMESTAMP`,
    `ALTER TABLE worlds ADD COLUMN IF NOT EXISTS target_audience TEXT NOT NULL DEFAULT 'all'`,
    `ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS committed_turns JSONB NOT NULL DEFAULT '[]'::jsonb`,
  ];

  for (const statement of ddl) {
    await db.execute(sql.raw(statement));
  }
}

describe("studio conversation world scoping", () => {
  let userId: string;
  let worldAId: string;
  let worldBId: string;
  let convAId: string;
  let convBId: string;

  beforeEach(async () => {
    await ensureStudioConversationTestSchema();

    const [u] = await db.insert(user).values({
      id: `test-user-${crypto.randomUUID()}`,
      name: "Studio Scope User",
      email: `${crypto.randomUUID()}@test.local`,
      emailVerified: true,
    }).returning();
    userId = u!.id;

    const [worldA] = await db.insert(worlds).values({
      creatorId: userId,
      name: "Card A",
      schema: { name: "Card A", entries: [], variables: [] },
      status: "draft",
    }).returning();
    worldAId = worldA!.id;

    const [worldB] = await db.insert(worlds).values({
      creatorId: userId,
      name: "Card B",
      schema: { name: "Card B", entries: [], variables: [] },
      status: "draft",
    }).returning();
    worldBId = worldB!.id;

    const [convA] = await db.insert(studioConversations).values({
      userId,
      worldId: worldAId,
      title: "A conversation",
      messages: [
        { id: "a-user", role: "user", content: "A-only secret" },
        { id: "a-assistant", role: "assistant", content: "A-only reply" },
      ],
    }).returning();
    convAId = convA!.id;

    const [convB] = await db.insert(studioConversations).values({
      userId,
      worldId: worldBId,
      title: "B conversation",
      messages: [
        { id: "b-user", role: "user", content: "B-only request" },
      ],
    }).returning();
    convBId = convB!.id;

    const now = new Date().toISOString();
    await db.insert(agentRuns).values([
      {
        userId,
        worldId: worldAId,
        conversationId: convAId,
        status: "completed",
        model: "test-model",
        messages: [],
        context: withStudioUserMessageContext(undefined, { role: "user", content: "A-owned request" }),
        committedTurns: [{
          iteration: 0,
          textContent: "A-owned reply",
          createdAt: now,
          commitId: "a-commit",
          writeToolCalls: [{
            id: "a-write",
            type: "function",
            function: { name: "update_entity", arguments: "{\"id\":\"entry-1\"}" },
          }],
        }],
      },
      {
        userId,
        worldId: worldBId,
        conversationId: convBId,
        status: "completed",
        model: "test-model",
        messages: [],
        context: withStudioUserMessageContext(undefined, { role: "user", content: "B-owned request" }),
        committedTurns: [{ iteration: 0, textContent: "B-owned reply", createdAt: now, commitId: "b-commit" }],
      },
    ]);
  });

  afterEach(async () => {
    await db.delete(user).where(eq(user.id, userId));
  });

  // This file creates the PGlite singleton when run directly; closing here
  // lets that child test process exit after all tests in this file complete.
  after(async () => {
    const client = (db as unknown as { $client?: { close?: () => Promise<void> } }).$client;
    await client?.close?.();
  });

  it("does not load a conversation through the wrong world route", async () => {
    const wrongWorld = await loadStudioConversationForWorld({
      userId,
      worldId: worldBId,
      conversationId: convAId,
    });
    assert.equal(wrongWorld, null);

    const rightWorld = await loadStudioConversationForWorld({
      userId,
      worldId: worldAId,
      conversationId: convAId,
    });
    assert.equal(rightWorld?.id, convAId);
  });

  it("does not patch or delete a conversation through the wrong world route", async () => {
    const patched = await updateStudioConversationForWorld({
      userId,
      worldId: worldBId,
      conversationId: convAId,
      updates: { title: "leaked update" },
    });
    assert.equal(patched, false);

    const [stillA] = await db.select().from(studioConversations).where(eq(studioConversations.id, convAId));
    assert.equal(stillA!.title, "A conversation");

    const deleted = await deleteStudioConversationForWorld({
      userId,
      worldId: worldBId,
      conversationId: convAId,
    });
    assert.equal(deleted, false);

    const [stillExists] = await db.select().from(studioConversations).where(eq(studioConversations.id, convAId));
    assert.equal(stillExists!.id, convAId);
  });

  it("updates same-world conversations and leaves other-world conversations untouched", async () => {
    const patched = await updateStudioConversationForWorld({
      userId,
      worldId: worldAId,
      conversationId: convAId,
      updates: {
        title: "A updated",
        messages: [{ id: "a-user-2", role: "user", content: "A updated message" }],
      },
    });
    assert.equal(patched, true);

    const loaded = await loadStudioConversationForWorld({
      userId,
      worldId: worldAId,
      conversationId: convAId,
    });
    assert.equal(loaded!.title, "A updated");
    assert.deepEqual(loaded!.messages, [
      { id: "a-user-2", role: "user", content: "A updated message" },
    ]);
  });

  it("hydrates saved assistant messages with committed write calls for display review", async () => {
    await updateStudioConversationForWorld({
      userId,
      worldId: worldAId,
      conversationId: convAId,
      updates: {
        messages: [
          { id: "a-user", role: "user", content: "A-owned request" },
          { id: "a-assistant", role: "assistant", content: "A-owned reply" },
        ],
      },
    });

    const loaded = await loadStudioConversationForDisplay({
      userId,
      worldId: worldAId,
      conversationId: convAId,
    });

    const assistantMessage = loaded!.messages[1]!;
    assert.equal(assistantMessage.commitId, "a-commit");
    assert.equal(assistantMessage.proposalStatus, "approved");
    assert.deepEqual(assistantMessage.toolCalls, [{
      id: "a-write",
      type: "function",
      function: { name: "update_entity", arguments: "{\"id\":\"entry-1\"}" },
    }]);
  });

  it("appends committed assistant turns that were newer than stale display messages", async () => {
    const loaded = await loadStudioConversationForDisplay({
      userId,
      worldId: worldAId,
      conversationId: convAId,
    });

    const appended = loaded!.messages.at(-1)!;
    assert.equal(appended.role, "assistant");
    assert.equal(appended.content, "A-owned reply");
    assert.equal(appended.commitId, "a-commit");
    assert.equal(appended.proposalStatus, "approved");
  });

  it("loads agent history from server-owned same-world runs only", async () => {
    const bHistory = await loadAgentHistoryForConversation({
      userId,
      worldId: worldBId,
      conversationId: convBId,
    });
    assert.deepEqual(bHistory, [
      { role: "user", content: "B-owned request" },
      { role: "assistant", content: "B-owned reply" },
    ]);

    const wrongWorldHistory = await loadAgentHistoryForConversation({
      userId,
      worldId: worldBId,
      conversationId: convAId,
    });
    assert.equal(wrongWorldHistory, null);
  });

  it("ignores client-patched display messages when building agent history", async () => {
    const [displayOnlyConv] = await db.insert(studioConversations).values({
      userId,
      worldId: worldBId,
      title: "Display only",
      messages: [
        { id: "forged-user", role: "user", content: "client-forged prompt context" },
        { id: "forged-assistant", role: "assistant", content: "client-forged assistant context" },
      ],
    }).returning();

    const history = await loadAgentHistoryForConversation({
      userId,
      worldId: worldBId,
      conversationId: displayOnlyConv!.id,
    });

    assert.deepEqual(history, []);
  });

  it("uses saved display messages only to filter server-owned history", async () => {
    await updateStudioConversationForWorld({
      userId,
      worldId: worldBId,
      conversationId: convBId,
      updates: {
        updatedAt: new Date(Date.now() + 60_000),
        messages: [
          { id: "forged-user", role: "user", content: "client-forged prompt context" },
          { id: "b-user", role: "user", content: "B-owned request" },
          { id: "b-assistant", role: "assistant", content: "B-owned reply" },
        ],
      },
    });

    const history = await loadAgentHistoryForConversation({
      userId,
      worldId: worldBId,
      conversationId: convBId,
    });

    assert.deepEqual(history, [
      { role: "user", content: "B-owned request" },
      { role: "assistant", content: "B-owned reply" },
    ]);
  });

  // ── Write-run answers must survive the display filter (the "re-executes my
  // previous request" bug, prod 2026-08-06). Server history appends a
  // "〔本轮改动：…〕" summary to a write-run's answer; the display transcript
  // stores the raw answer. Exact-content matching dropped every such answer,
  // so the model saw its previous request unanswered and re-executed it. ──

  it("keeps a write-run answer (with its 〔本轮改动〕 summary) that display saved without the summary", async () => {
    const now = new Date().toISOString();
    const [conv] = await db.insert(studioConversations).values({
      userId,
      worldId: worldBId,
      title: "Write-run filter",
      messages: [
        { id: "u1", role: "user", content: "recolor the bubbles" },
        { id: "a1", role: "assistant", content: "Done — recolored the bubbles." },
      ],
      // Client PATCHes the user message before agent start, so display is
      // always newer than the runs → the filter path is the normal path.
      updatedAt: new Date(Date.now() + 60_000),
    }).returning();

    await db.insert(agentRuns).values({
      userId,
      worldId: worldBId,
      conversationId: conv!.id,
      status: "completed",
      model: "test-model",
      messages: [],
      context: withStudioUserMessageContext(undefined, { role: "user", content: "recolor the bubbles" }),
      committedTurns: [
        {
          iteration: 0,
          textContent: "editing",
          createdAt: now,
          commitId: "w1",
          lane: "step",
          writeToolCalls: [{
            id: "tc1",
            type: "function",
            function: { name: "edit_custom_ui", arguments: JSON.stringify({ id: "index.tsx" }) },
          }],
        },
        { iteration: 1, textContent: "Done — recolored the bubbles.", createdAt: now, commitId: "a1", lane: "answer" },
      ],
    });

    const history = await loadAgentHistoryForConversation({
      userId,
      worldId: worldBId,
      conversationId: conv!.id,
    });

    assert.deepEqual(history, [
      { role: "user", content: "recolor the bubbles" },
      { role: "assistant", content: "Done — recolored the bubbles.\n〔本轮改动：index.tsx〕" },
    ]);
  });

  it("keeps a write-only run's standalone 〔本轮改动〕 summary while its exchange is still displayed", async () => {
    const now = new Date().toISOString();
    const [conv] = await db.insert(studioConversations).values({
      userId,
      worldId: worldBId,
      title: "Write-only filter",
      messages: [
        { id: "u1", role: "user", content: "add Hyein" },
      ],
      updatedAt: new Date(Date.now() + 60_000),
    }).returning();

    await db.insert(agentRuns).values({
      userId,
      worldId: worldBId,
      conversationId: conv!.id,
      status: "completed",
      model: "test-model",
      messages: [],
      context: withStudioUserMessageContext(undefined, { role: "user", content: "add Hyein" }),
      committedTurns: [{
        iteration: 0,
        textContent: "writing",
        createdAt: now,
        commitId: "w1",
        lane: "step",
        writeToolCalls: [{
          id: "tc1",
          type: "function",
          function: { name: "write_entry", arguments: JSON.stringify({ id: "e1", name: "Hyein" }) },
        }],
      }],
    });

    const history = await loadAgentHistoryForConversation({
      userId,
      worldId: worldBId,
      conversationId: conv!.id,
    });

    assert.deepEqual(history, [
      { role: "user", content: "add Hyein" },
      { role: "assistant", content: "〔本轮改动：Hyein〕" },
    ]);
  });

  it("drops an undone exchange's answer AND its summary together", async () => {
    const now = new Date().toISOString();
    const [conv] = await db.insert(studioConversations).values({
      userId,
      worldId: worldBId,
      title: "Undo filter",
      // Exchange 2 was undone: display only kept exchange 1.
      messages: [
        { id: "u1", role: "user", content: "first request" },
        { id: "a1", role: "assistant", content: "First done." },
      ],
      updatedAt: new Date(Date.now() + 60_000),
    }).returning();

    const writeTurn = (commitId: string, target: string) => ({
      iteration: 0,
      textContent: "editing",
      createdAt: now,
      commitId,
      lane: "step" as const,
      writeToolCalls: [{
        id: `tc-${commitId}`,
        type: "function" as const,
        function: { name: "edit_custom_ui", arguments: JSON.stringify({ id: target }) },
      }],
    });

    await db.insert(agentRuns).values([
      {
        userId,
        worldId: worldBId,
        conversationId: conv!.id,
        status: "completed",
        model: "test-model",
        messages: [],
        context: withStudioUserMessageContext(undefined, { role: "user", content: "first request" }),
        committedTurns: [
          writeTurn("w1", "index.tsx"),
          { iteration: 1, textContent: "First done.", createdAt: now, commitId: "a1", lane: "answer" },
        ],
      },
      {
        userId,
        worldId: worldBId,
        conversationId: conv!.id,
        status: "completed",
        model: "test-model",
        messages: [],
        context: withStudioUserMessageContext(undefined, { role: "user", content: "second request (undone)" }),
        committedTurns: [writeTurn("w2", "bubble.tsx")],
      },
    ]);

    const history = await loadAgentHistoryForConversation({
      userId,
      worldId: worldBId,
      conversationId: conv!.id,
    });

    assert.deepEqual(history, [
      { role: "user", content: "first request" },
      { role: "assistant", content: "First done.\n〔本轮改动：index.tsx〕" },
    ]);
  });

  it("respects saved display trims without trusting trimmed-in content", async () => {
    await updateStudioConversationForWorld({
      userId,
      worldId: worldBId,
      conversationId: convBId,
      updates: {
        updatedAt: new Date(Date.now() + 60_000),
        messages: [],
      },
    });

    const history = await loadAgentHistoryForConversation({
      userId,
      worldId: worldBId,
      conversationId: convBId,
    });

    assert.deepEqual(history, []);
  });
});

describe("serverOwnedStudioRunsToAgentHistory", () => {
  it("converts only the most recent 40 server-owned messages", () => {
    const runs = Array.from({ length: 21 }, (_, index) => ({
      context: withStudioUserMessageContext(undefined, { role: "user", content: `user ${index}` }),
      committedTurns: [{
        iteration: 0,
        textContent: `assistant ${index}`,
        createdAt: new Date().toISOString(),
        commitId: `commit-${index}`,
      }],
    }));

    const history = serverOwnedStudioRunsToAgentHistory(runs);

    assert.equal(history.length, 40);
    assert.deepEqual(history[0], { role: "user", content: "user 1" });
    assert.deepEqual(history.at(-1), { role: "assistant", content: "assistant 20" });
  });

  it("preserves valid server-owned content while filtering blanks", () => {
    const history = serverOwnedStudioRunsToAgentHistory([
      {
        context: withStudioUserMessageContext(undefined, { role: "user", content: "   " }),
        committedTurns: [{ iteration: 0, textContent: "   ", createdAt: "now", commitId: "blank" }],
      },
      {
        context: withStudioUserMessageContext(undefined, {
          role: "user",
          content: [
            { type: "text", text: "  keep user spacing  " },
            { type: "image_url", image_url: { url: "https://example.test/image.png" } },
          ],
        }),
        committedTurns: [{ iteration: 0, textContent: "\nkeep assistant spacing\t", createdAt: "now", commitId: "kept" }],
      },
    ]);

    assert.deepEqual(history, [
      {
        role: "user",
        content: [
          { type: "text", text: "  keep user spacing  " },
          { type: "image_url", image_url: { url: "https://example.test/image.png" } },
        ],
      },
      { role: "assistant", content: "\nkeep assistant spacing\t" },
    ]);
  });

  // ── Cross-run tool-narration filtering (anti-poison) ──
  // Replaying a turn's mid-execution narration ("let me read X") as a standalone
  // assistant message — with no tool call or tool result, because reconstruction
  // strips tool structure — teaches the model that announcing actions is never
  // followed by acting. It then imitates that and stops calling tools. We drop
  // narration turns (those that accompanied a tool call) and keep real answers.

  it("drops tool-narration turns and keeps the substantive answer", () => {
    const history = serverOwnedStudioRunsToAgentHistory([
      {
        context: withStudioUserMessageContext(undefined, { role: "user", content: "fix the rules" }),
        committedTurns: [
          { iteration: 0, textContent: "Let me read the current rules first.", createdAt: "now", commitId: "narration", toolNarration: true },
          { iteration: 2, textContent: "Done — updated rule 4.", createdAt: "now", commitId: "answer" },
        ],
      },
    ]);

    assert.deepEqual(history, [
      { role: "user", content: "fix the rules" },
      { role: "assistant", content: "Done — updated rule 4." },
    ]);
  });

  it("treats a write turn (writeToolCalls present) as narration even without the flag", () => {
    const history = serverOwnedStudioRunsToAgentHistory([
      {
        context: withStudioUserMessageContext(undefined, { role: "user", content: "add a variable" }),
        committedTurns: [
          {
            iteration: 0,
            textContent: "Writing the variable now.",
            createdAt: "now",
            commitId: "legacy-write",
            writeToolCalls: [{ id: "tc1", type: "function", function: { name: "write_variable", arguments: "{}" } }],
          },
          { iteration: 1, textContent: "Variable added.", createdAt: "now", commitId: "summary" },
        ],
      },
    ]);

    assert.deepEqual(history, [
      { role: "user", content: "add a variable" },
      { role: "assistant", content: "Variable added." },
    ]);
  });

  it("a run that only narrated (no answer, no writes) leaves no assistant trace", () => {
    // New positive-selection behavior: a run with only `step` turns and no writes
    // produced nothing of value — it must NOT fabricate an assistant line from its
    // last preamble (the old "keep last narration" fallback was itself the stall poison).
    const history = serverOwnedStudioRunsToAgentHistory([
      {
        context: withStudioUserMessageContext(undefined, { role: "user", content: "do the thing" }),
        committedTurns: [
          { iteration: 0, textContent: "Reading entities.", createdAt: "now", commitId: "n1", lane: "step" },
          { iteration: 1, textContent: "Applying the change.", createdAt: "now", commitId: "n2", lane: "step" },
        ],
      },
    ]);

    assert.deepEqual(history, [{ role: "user", content: "do the thing" }]);
  });

  // ── Lane-based positive selection + server-notice net (anti-poison v2) ──
  // The real prod poison was the loop-guard text "Stopped: re-read … without
  // progress" committed flagless and replayed as an assistant turn. lane:"notice"
  // keeps it UI-only; the content net catches legacy rows that predate the field.

  it("never replays a server notice, even on a legacy row without a lane", () => {
    const history = serverOwnedStudioRunsToAgentHistory([
      {
        context: withStudioUserMessageContext(undefined, { role: "user", content: "move the button" }),
        committedTurns: [
          // legacy row: the exact prod poison, no lane, no flag
          { iteration: 0, textContent: 'Stopped: re-read "chat-shell.tsx" three times without progress. Call validate_world.', createdAt: "now", commitId: "stuck" },
        ],
      },
    ]);

    assert.deepEqual(history, [{ role: "user", content: "move the button" }]);
    assert.ok(!JSON.stringify(history).includes("Stopped:"), "notice text must not reach model history");
  });

  it("keeps only the answer, drops step/notice, and appends a writes summary", () => {
    const history = serverOwnedStudioRunsToAgentHistory([
      {
        context: withStudioUserMessageContext(undefined, { role: "user", content: "把图标换成大脑" }),
        committedTurns: [
          { iteration: 0, textContent: "让我看看 chat-shell.tsx", createdAt: "now", commitId: "s1", lane: "step", actions: [{ op: "read_entities", target: "chat-shell.tsx" }] },
          { iteration: 1, textContent: "改这一行", createdAt: "now", commitId: "s2", lane: "step", writeToolCalls: [{ id: "w1", type: "function", function: { name: "edit_custom_ui", arguments: JSON.stringify({ id: "chat-shell.tsx" }) } }] },
          { iteration: 2, textContent: "改好了，图标已换成大脑。", createdAt: "now", commitId: "a1", lane: "answer" },
          { iteration: 3, textContent: 'Stopped: re-read "chat-shell.tsx" three times without progress.', createdAt: "now", commitId: "n1", lane: "notice" },
        ],
      },
    ]);

    assert.deepEqual(history, [
      { role: "user", content: "把图标换成大脑" },
      { role: "assistant", content: "改好了，图标已换成大脑。\n〔本轮改动：chat-shell.tsx〕" },
    ]);
  });

  it("a write-only run with no wrap-up text still reports what changed", () => {
    const history = serverOwnedStudioRunsToAgentHistory([
      {
        context: withStudioUserMessageContext(undefined, { role: "user", content: "add Hyein" }),
        committedTurns: [
          { iteration: 0, textContent: "writing", createdAt: "now", commitId: "w", lane: "step", writeToolCalls: [{ id: "w1", type: "function", function: { name: "write_entry", arguments: JSON.stringify({ id: "e1", name: "Hyein" }) } }] },
        ],
      },
    ]);

    assert.deepEqual(history, [
      { role: "user", content: "add Hyein" },
      { role: "assistant", content: "〔本轮改动：Hyein〕" },
    ]);
  });

  it("keeps a zero-tool discussion/answer turn (it is a real reply, not a stall)", () => {
    // A run that calls no tools and ends on text is a genuine discussion turn —
    // a proposal, a confirmation, a request for input, a Q&A answer. It is committed
    // lane:"answer" and MUST survive into history so multi-turn planning isn't
    // forgotten. (A real "announce but never act" stall keeps calling read tools, so
    // it is committed lane:"step" at the read branch and dropped — see below.)
    const history = serverOwnedStudioRunsToAgentHistory([
      {
        context: withStudioUserMessageContext(undefined, { role: "user", content: "把世界观按阶段切片" }),
        committedTurns: [
          { iteration: 0, textContent: "好的，建议分两类：A 4 条堕落阶段，B 3 条羁绊阶段。你要哪种？", createdAt: "now", commitId: "proposal", lane: "answer" },
        ],
      },
    ]);

    assert.deepEqual(history, [
      { role: "user", content: "把世界观按阶段切片" },
      { role: "assistant", content: "好的，建议分两类：A 4 条堕落阶段，B 3 条羁绊阶段。你要哪种？" },
    ]);
  });

  it("still drops a stall committed as step at the read branch (loop stays fixed)", () => {
    // The real anti-loop guarantee: stall turns that accompanied a read are lane:"step"
    // and never replayed, even though the model produced text. This is what keeps the
    // "announce but never act" loop dead after the zero-tool relaxation above.
    const history = serverOwnedStudioRunsToAgentHistory([
      {
        context: withStudioUserMessageContext(undefined, { role: "user", content: "继续做" }),
        committedTurns: [
          { iteration: 0, textContent: "已经找到了，让我看看那段代码。", createdAt: "now", commitId: "stall", lane: "step", actions: [{ op: "read_entities", target: "chat-shell.tsx" }] },
        ],
      },
    ]);

    assert.deepEqual(history, [{ role: "user", content: "继续做" }]);
  });
});
