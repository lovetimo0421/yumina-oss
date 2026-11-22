import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { agentRuns, studioConversations, user, worlds } from "../db/schema.js";
import { agentRoutes, streamAgentLoop, type AgentLoopParams } from "./agent.js";
import type { ChatMessage, GenerateParams, LLMProvider, StreamChunk, ToolCall, ToolDefinition } from "../lib/llm/types.js";
import { UPDATE_PLAN_TOOL } from "../lib/studio-tools/plan.js";
import { MAX_WAITING_STEERS, queueSteer, takeSteers } from "../lib/studio-steer.js";

before(async () => { await import(new URL("../../scripts/test-local-schema.mjs", import.meta.url).href); });

// Run only through scripts/test-local.mjs (isolated in-memory database, no Redis).
const TOOLS: ToolDefinition[] = [UPDATE_PLAN_TOOL, { type: "function", function: {
  name: "write_variable", description: "Create a test variable",
  parameters: { type: "object", properties: { id: { type: "string" } } },
} }];
type Script = (params: GenerateParams) => AsyncIterable<StreamChunk>;
class ScriptedProvider implements LLMProvider {
  calls: GenerateParams[] = [];
  constructor(private scripts: Script[]) {}
  async *generateStream(params: GenerateParams) {
    const script = this.scripts[this.calls.length];
    this.calls.push(params);
    assert.ok(script, "The loop must not issue an unplanned provider request");
    yield* script(params);
  }
  async listModels() { return []; }
}
const usage = { promptTokens: 10, completionTokens: 10, totalTokens: 20 };
const call = (name: string, args: unknown): ToolCall =>
  ({ id: `call-${crypto.randomUUID()}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
function tools(calls: ToolCall[], during?: () => Promise<unknown>): Script {
  return async function* () {
    await during?.();
    for (const [index, toolCall] of calls.entries()) yield { type: "tool_call_end", content: "", toolCallIndex: index, toolCall };
    yield { type: "done", content: "", usage, stopReason: "tool_use" };
  };
}
function text(content: string, during?: () => Promise<unknown>): Script {
  return async function* () {
    await during?.();
    yield { type: "text", content };
    yield { type: "done", content: "", usage, stopReason: "end_turn" };
  };
}

async function fixture() {
  const userId = crypto.randomUUID();
  const worldId = crypto.randomUUID();
  const world = migrateWorldDefinition({ id: worldId, version: "19.0.0", name: "Steer", description: "", author: "t",
    entries: [], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [],
    settings: { maxTokens: 4000, temperature: 1, playerName: "User" },
  } as unknown as WorldDefinition);
  await db.insert(user).values({ id: userId, name: "Steer", email: `${userId}@test.local` });
  await db.insert(worlds).values({ id: worldId, creatorId: userId, name: world.name, status: "draft",
    schema: world as unknown as Record<string, unknown> });
  const [conversation] = await db.insert(studioConversations).values({ worldId, userId }).returning();
  const [run] = await db.insert(agentRuns).values({ worldId, userId, conversationId: conversation!.id,
    model: "test/byok", status: "running", messages: [{ role: "user", content: "Build affection." }] }).returning();
  return { userId, worldId, runId: run!.id, conversationId: conversation!.id, world };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function runLoop(f: Fixture, provider: LLMProvider, extra: Partial<AgentLoopParams> = {}) {
  const params: AgentLoopParams = {
    runId: f.runId, conversationId: f.conversationId, worldId: f.worldId, userId: f.userId,
    world: f.world, messages: [{ role: "user", content: "Build affection." }], model: "test/byok",
    provider, isByok: true, apiKeyTier: "regular", iteration: 0, maxIterations: 6, tools: TOOLS, ...extra,
  };
  const app = new Hono();
  app.post("/loop", c => streamAgentLoop(c, params));
  const body = await (await app.request("/loop", { method: "POST" })).text();
  return body.split(/\r?\n\r?\n/).flatMap(frame => {
    const event = /^event: ?(.+)$/m.exec(frame)?.[1]?.trim();
    const data = /^data: ?(.+)$/m.exec(frame)?.[1];
    return event && data ? [{ event, data: JSON.parse(data) as Record<string, unknown> }] : [];
  });
}
const runContext = async (f: Fixture) =>
  (await db.select({ context: agentRuns.context }).from(agentRuns).where(eq(agentRuns.id, f.runId)))[0]!.context as Record<string, unknown>;
const userTexts = (messages: ChatMessage[]) => messages.filter((m) => m.role === "user").map((m) => m.content);

describe("agent checklist and mid-run messages", { concurrency: false }, () => {
  it("streams the checklist, keeps it on the run, and gives the next step what the creator added", async () => {
    const f = await fixture();
    const plan = [{ step: "好感变量", status: "in_progress" }, { step: "试玩", status: "pending" }];
    const provider = new ScriptedProvider([
      // The creator types while the first step is being generated.
      tools([call("update_plan", { plan }), call("write_variable", { id: "affection", name: "affection", type: "number", defaultValue: 0 })],
        () => queueSteer(f.runId, { id: "s1", text: "上限改成 100" })),
      text("Done: affection 0-100."),
    ]);
    const events = await runLoop(f, provider);

    assert.deepEqual(events.find((e) => e.event === "plan")?.data.plan, plan);
    assert.deepEqual(events.find((e) => e.event === "steer_applied")?.data.ids, ["s1"]);
    // The second model call sees the message, after the first step's tool results.
    const second = provider.calls[1]!.messages;
    const at = second.findIndex((m) => m.role === "user" && m.content === "上限改成 100");
    assert.ok(at > 0 && second[at - 1]!.role === "tool", "The added message follows the last tool result");
    const context = await runContext(f);
    assert.deepEqual(context.plan, plan);
    assert.deepEqual(context.steers, [{ id: "s1", text: "上限改成 100", iteration: 1 }]);
    assert.deepEqual(await takeSteers(f.runId), [], "Nothing is left in the queue");
  });

  it("answers a message that arrived while the final reply was generated, instead of ending", async () => {
    const f = await fixture();
    const provider = new ScriptedProvider([
      text("All set.", () => queueSteer(f.runId, { id: "s2", text: "再加一个嫉妒值" })),
      text("Added jealousy too."),
    ]);
    const events = await runLoop(f, provider);
    assert.equal(provider.calls.length, 2);
    assert.ok(userTexts(provider.calls[1]!.messages).includes("再加一个嫉妒值"));
    assert.equal(events.filter((e) => e.event === "done").length, 1);
  });

  it("keeps a started job working when the model proposes it again", async () => {
    const f = await fixture();
    const provider = new ScriptedProvider([
      tools([call("propose_job", { plan: ["好感变量", "试玩"], steps: 4 })]),
      text("Done."),
    ]);
    const events = await runLoop(f, provider, { context: { jobApproved: true, mode: "build" } });
    assert.equal(provider.calls.length, 2, "The run carried on instead of waiting for another Start");
    assert.ok(!events.some((e) => e.event === "job_proposal"));
    const result = provider.calls[1]!.messages.at(-1)!;
    assert.equal(result.role, "tool");
    assert.match(String(result.content), /already approved this work/);
    const [run] = await db.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, f.runId));
    assert.equal(run!.status, "completed");
  });

  it("keeps what the creator added before an approval when the run carries on", async () => {
    const f = await fixture();
    // Taken in the run's first stretch, before it parked for approval.
    await db.update(agentRuns).set({ context: { steers: [{ id: "s0", text: "用中文" }] } }).where(eq(agentRuns.id, f.runId));
    const provider = new ScriptedProvider([
      tools([call("write_variable", { id: "affection" })], () => queueSteer(f.runId, { id: "s4", text: "上限 100" })),
      text("Done."),
    ]);
    await runLoop(f, provider);
    assert.deepEqual((await runContext(f)).steers, [{ id: "s0", text: "用中文" }, { id: "s4", text: "上限 100", iteration: 1 }]);
  });

  it("shows a checklist sent alongside playtest instead of turning it away", async () => {
    const f = await fixture();
    const plan = [{ step: "试玩", status: "in_progress" }];
    const provider = new ScriptedProvider([
      // No moves: playtest answers without starting a game, the path is the same.
      tools([call("update_plan", { plan }), call("playtest", { moves: [] })]),
      text("Done."),
    ]);
    const events = await runLoop(f, provider);
    assert.deepEqual(events.find((e) => e.event === "plan")?.data.plan, plan);
    const results = provider.calls[1]!.messages.filter((m) => m.role === "tool");
    const planResult = results.find((m) => m.content.includes("shown"));
    assert.ok(planResult, "the checklist call is answered as shown");
    assert.ok(!results.some((m) => m.content.includes("Call playtest alone")), "only real companions are turned away");
    assert.deepEqual((await runContext(f)).plan, plan);
  });

  it("turns away messages past the waiting limit until the run reads them", async () => {
    const runId = crypto.randomUUID();
    for (let i = 0; i < MAX_WAITING_STEERS; i++) assert.equal(await queueSteer(runId, { id: `m${i}`, text: "x" }), true);
    assert.equal(await queueSteer(runId, { id: "over", text: "x" }), false);
    assert.equal((await takeSteers(runId)).length, MAX_WAITING_STEERS);
    assert.equal(await queueSteer(runId, { id: "after", text: "x" }), true, "reading the queue makes room again");
    await takeSteers(runId);
  });

  it("refuses a message for a run that is no longer working, or someone else's", async () => {
    const f = await fixture();
    const path = "/:worldId/agent/steer";
    const handler = agentRoutes.routes.find(route => route.method === "POST" && route.path === path)?.handler;
    assert.ok(handler);
    const send = (asUser: string) => {
      const app = new Hono<{ Variables: { user: { id: string } } }>();
      app.use("*", async (c, next) => { c.set("user", { id: asUser }); await next(); });
      app.post(path, handler);
      return app.request(`/${f.worldId}/agent/steer`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: f.runId, id: "s3", message: "hi" }) });
    };
    assert.equal((await send(crypto.randomUUID())).status, 404);
    await db.update(agentRuns).set({ status: "completed" }).where(eq(agentRuns.id, f.runId));
    assert.equal((await send(f.userId)).status, 409);
    assert.deepEqual(await takeSteers(f.runId), []);
  });
});
