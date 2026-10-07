import assert from "node:assert/strict";
import test, { before } from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { agentRuns, creditWallets, playSessions, studioConversations, user, worlds } from "../db/schema.js";
import type { ChatMessage, GenerateParams, LLMProvider } from "../lib/llm/types.js";
import { STUDIO_TOOLS } from "../lib/studio-tools/tools.js";
import { streamAgentLoop } from "./agent.js";

// The assistant plays the card through the real game routes. In isolated
// tests the card's model cannot be reached, so the turn fails — and that
// failure has to come back to the assistant as something it can read, with
// the creator's panel told where the session is.

before(() => {
  assert.equal(process.env.YUMINA_LOCAL_TEST, "1");
  process.env.STUDIO_CREDIT_RECOVERY_ENABLED = "false";
});

test("playtest makes a throwaway session, reports progress, and hands the turns back", async () => {
  const userId = crypto.randomUUID();
  const worldId = crypto.randomUUID();
  const world = migrateWorldDefinition({ id: worldId, version: "19.0.0", name: "雾港钟表铺",
    entries: [{ id: "open", name: "开场白", content: "雾很浓。", role: "greeting", enabled: true, alwaysSend: false, keywords: [], conditions: [] }],
    variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: {},
  } as unknown as WorldDefinition);
  await db.insert(user).values({ id: userId, name: "Owner", email: `${userId}@test.local` });
  await db.insert(worlds).values({ id: worldId, creatorId: userId, name: world.name, schema: world as unknown as Record<string, unknown> });
  await db.insert(creditWallets).values({ userId, balance: 1000, addonBalance: 1000,
    periodStart: new Date(), periodEnd: new Date(Date.now() + 86400000) });
  const [conversation] = await db.insert(studioConversations).values({ userId, worldId }).returning();
  const [run] = await db.insert(agentRuns).values({ userId, worldId, conversationId: conversation!.id,
    model: "test/play", status: "running", messages: [{ role: "user", content: "试玩一下" }] }).returning();

  const calls: GenerateParams[] = [];
  const provider: LLMProvider = {
    async *generateStream(params) {
      calls.push(params);
      if (calls.length === 1) {
        yield { type: "text", content: "我来试玩一下。" };
        yield { type: "tool_call_end", content: "", toolCall: { id: "play-call", type: "function",
          function: { name: "playtest", arguments: JSON.stringify({ moves: ["我推开门。", "我问店主在修什么。"], purpose: "检查开场" }) } } };
        yield { type: "done", content: "", stopReason: "tool_use" };
        return;
      }
      yield { type: "text", content: "试玩没跑起来，我看了原因。" };
      yield { type: "done", content: "", stopReason: "end_turn" };
    },
    async listModels() { return []; },
  };
  const app = new Hono();
  app.post("/loop", c => streamAgentLoop(c, { userId, worldId, world, runId: run!.id, conversationId: conversation!.id,
    model: "test/play", provider, isByok: true, apiKeyTier: "regular", iteration: 0, maxIterations: 4, tools: STUDIO_TOOLS,
    messages: [{ role: "user", content: "试玩一下" }] }));
  const response = await app.request("/loop", { method: "POST" });
  assert.equal(response.status, 200);
  const frames = (await response.text()).split(/\r?\n\r?\n/).flatMap(frame => {
    const event = /^event: ?(.+)$/m.exec(frame)?.[1]?.trim();
    const data = /^data: ?(.+)$/m.exec(frame)?.[1];
    return event && data ? [{ event, data: JSON.parse(data) }] : [];
  });

  const progress = frames.filter(frame => frame.event === "playtest_progress").map(frame => frame.data);
  assert.ok(progress.length >= 2, "the panel is told about the session and each turn");
  const sessionId = progress[0]!.sessionId as string;
  assert.equal(progress[0]!.turn, 0);
  assert.equal(progress[0]!.purpose, "检查开场");
  const [session] = await db.select().from(playSessions).where(eq(playSessions.id, sessionId));
  assert.ok(session, "a real session was made");
  assert.equal(session!.ephemeral, true, "and it is a throwaway one, hidden from the library");

  assert.equal(calls.length, 2, "the assistant carries on after reading the playtest");
  const toolResult = (calls[1]!.messages as ChatMessage[]).find(m => m.role === "tool");
  assert.ok(toolResult, "the playtest result is handed back as the tool's result");
  assert.match(String(toolResult!.content), /ERROR|could not run/, "a failed turn reads as a failure, not as an empty reply");
});
