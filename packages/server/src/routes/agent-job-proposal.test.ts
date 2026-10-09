import assert from "node:assert/strict";
import test, { before } from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { agentRuns, creditWallets, studioConversations, user, worlds } from "../db/schema.js";
import type { GenerateParams, LLMProvider } from "../lib/llm/types.js";
import { STUDIO_TOOLS } from "../lib/studio-tools/tools.js";
import { agentRoutes, streamAgentLoop } from "./agent.js";
import { loadStudioConversationForDisplay } from "../lib/studio-conversations.js";
import { S3Client } from "@aws-sdk/client-s3";
import { LocalDiskStorage } from "../lib/storage/local-disk.js";

// A big job: the assistant states its plan, the platform adds time and cost,
// and the run waits for the creator to press Start — surviving a reload.

before(() => {
  assert.equal(process.env.YUMINA_LOCAL_TEST, "1");
  process.env.STUDIO_CREDIT_RECOVERY_ENABLED = "false";
});

async function fixture() {
  const userId = crypto.randomUUID();
  const worldId = crypto.randomUUID();
  const world = migrateWorldDefinition({ id: worldId, version: "19.0.0", name: "Job request",
    entries: [], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: {},
  } as unknown as WorldDefinition);
  await db.insert(user).values({ id: userId, name: "Job owner", email: `${userId}@test.local` });
  await db.insert(worlds).values({ id: worldId, creatorId: userId, name: world.name, schema: world as unknown as Record<string, unknown> });
  await db.insert(creditWallets).values({ userId, balance: 1000, addonBalance: 1000,
    periodStart: new Date(), periodEnd: new Date(Date.now() + 86400000) });
  const [conversation] = await db.insert(studioConversations).values({ userId, worldId }).returning();
  const [run] = await db.insert(agentRuns).values({ userId, worldId, conversationId: conversation!.id,
    model: "test/job", status: "running", messages: [{ role: "user", content: "给这张卡加一个选角色的开局" }] }).returning();
  return { userId, worldId, world, runId: run!.id, conversationId: conversation!.id };
}

test("Advise rejects an invented write tool even when the caller supplies Build tools", async () => {
  const f = await fixture();
  let calls = 0;
  const provider: LLMProvider = {
    async *generateStream(params) {
      assert.ok(!params.tools?.some(t => t.function.name === "update_settings"));
      if (++calls === 1) yield { type: "tool_call_end", content: "", toolCall: { id: "forbidden", type: "function", function: { name: "update_settings", arguments: '{"name":"Changed without approval"}' } } };
      else yield { type: "text", content: "We can discuss this first." };
      yield { type: "done", content: "", stopReason: calls === 1 ? "tool_use" : "stop" };
    }, async listModels() { return []; },
  };
  const app = new Hono();
  app.post("/loop", c => streamAgentLoop(c, { ...f, model: "test/plan", provider, isByok: true,
    context: { mode: "advise" }, apiKeyTier: "regular", iteration: 0, maxIterations: 3,
    tools: STUDIO_TOOLS, messages: [{ role: "user", content: "Think this through" }] }));
  const text = await (await app.request("/loop", { method: "POST" })).text();
  assert.equal(calls, 2);
  assert.ok(!text.includes("event: applied"));
  const [row] = await db.select().from(worlds).where(eq(worlds.id, f.worldId));
  assert.equal((row!.schema as { name: string }).name, f.world.name);
});

test("saving a brief commits a recoverable build offer without writing the card", async t => {
  const f = await fixture();
  // Synthetic storage only, irrespective of the edition's backend choice.
  t.mock.method(S3Client.prototype, "send", async () => ({}));
  t.mock.method(LocalDiskStorage.prototype, "putObject", async () => {});
  t.mock.method(LocalDiskStorage.prototype, "getObjectBuffer", async () => { throw new Error("No stored source"); });
  let calls = 0;
  const provider: LLMProvider = {
    async *generateStream() {
      if (++calls === 1) yield { type: "tool_call_end", content: "", toolCall: { id: "brief", type: "function", function: { name: "save_brief", arguments: JSON.stringify({ brief: "Port story", summary: "Build a port opening", steps: ["Opening", "Trust"] }) } } };
      else yield { type: "text", content: "The plan is ready for your confirmation." };
      yield { type: "done", content: "", stopReason: calls === 1 ? "tool_use" : "stop" };
    }, async listModels() { return []; },
  };
  const app = new Hono();
  app.post("/loop", c => streamAgentLoop(c, { ...f, model: "test/plan", provider, isByok: true,
    context: { mode: "advise" }, apiKeyTier: "regular", iteration: 0, maxIterations: 3,
    tools: STUDIO_TOOLS, messages: [{ role: "user", content: "The scope is ready" }] }));
  const text = await (await app.request("/loop", { method: "POST" })).text();
  assert.ok(text.includes('"buildProposal"'), text);
  assert.ok(!text.includes("event: applied"));
  const display = await loadStudioConversationForDisplay({ userId: f.userId, worldId: f.worldId, conversationId: f.conversationId });
  const proposal = display!.messages.find(m => m.buildProposal)?.buildProposal as { brief: string; summary: string; steps: string[] };
  assert.equal(proposal.brief, "Port story");
  assert.deepEqual(proposal.steps, ["Opening", "Trust"]);
  const [row] = await db.select().from(worlds).where(eq(worlds.id, f.worldId));
  assert.equal((row!.schema as { name: string }).name, f.world.name);
});

test("propose_job streams the plan with an estimate and waits for Start, across a reload", async () => {
  const f = await fixture();
  const calls: GenerateParams[] = [];
  const provider: LLMProvider = {
    async *generateStream(params) {
      calls.push(params);
      yield { type: "text", content: "好。" };
      yield { type: "tool_call_end", content: "", toolCall: { id: "job-call", type: "function",
        function: { name: "propose_job", arguments: JSON.stringify({
          plan: ["在开场前加一页选角色", "三个主角各写一段开场白", "加一个变量记住选了谁"], steps: 6,
        }) } } };
      yield { type: "done", content: "", stopReason: "tool_use" };
    },
    async listModels() { return []; },
  };
  const app = new Hono();
  app.post("/loop", c => streamAgentLoop(c, { ...f, model: "test/job", provider, isByok: true,
    apiKeyTier: "regular", iteration: 0, maxIterations: 4, tools: STUDIO_TOOLS,
    messages: [{ role: "user", content: "给这张卡加一个选角色的开局" }] }));
  const response = await app.request("/loop", { method: "POST" });
  assert.equal(response.status, 200);
  const frames = (await response.text()).split(/\r?\n\r?\n/).flatMap(frame => {
    const event = /^event: ?(.+)$/m.exec(frame)?.[1]?.trim();
    const data = /^data: ?(.+)$/m.exec(frame)?.[1];
    return event && data ? [{ event, data: JSON.parse(data) }] : [];
  });

  assert.equal(calls.length, 1, "the run stops after proposing; nothing is built before Start");
  const proposal = frames.find(frame => frame.event === "job_proposal")?.data;
  assert.ok(proposal, "the proposal reaches the panel");
  assert.deepEqual(proposal.plan, ["在开场前加一页选角色", "三个主角各写一段开场白", "加一个变量记住选了谁"]);
  assert.ok(proposal.minutes >= 2);
  assert.equal(proposal.mushies, null, "the creator's own key pays, so no mushroom cost is quoted");
  assert.equal(proposal.byKey, true);
  assert.equal(frames.at(-1)?.event, "done");
  assert.equal(frames.at(-1)?.data.status, "awaiting_user");

  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, f.runId));
  assert.equal(run!.status, "awaiting_user");

  // A reload asks the status endpoint; the proposal comes back with it.
  const handler = agentRoutes.routes.find(item => item.method === "GET" && item.path === "/:worldId/agent/status")?.handler;
  assert.ok(handler);
  const statusApp = new Hono<{ Variables: { user: { id: string } } }>();
  statusApp.use("*", async (c, next) => { c.set("user", { id: f.userId }); await next(); });
  statusApp.get("/:worldId/agent/status", handler);
  const status = await (await statusApp.request(`/${f.worldId}/agent/status?runId=${f.runId}`)).json() as { data: { status: string; jobProposal?: { plan: string[] } } };
  assert.equal(status.data.status, "awaiting_user");
  assert.equal(status.data.jobProposal?.plan.length, 3);
});
