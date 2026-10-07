import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { agentRuns, studioConversations, user, worlds } from "../db/schema.js";
import { agentErrorCode, agentRoutes, streamAgentLoop, type AgentLoopParams } from "./agent.js";
import type { GenerateParams, LLMProvider, StreamChunk, ToolCall, ToolDefinition } from "../lib/llm/types.js";
import { isHarnessTurn } from "../lib/studio-tools/harness-notes.js";

before(async () => { await import(new URL("../../scripts/test-local-schema.mjs", import.meta.url).href); });

// Run only through scripts/test-local.mjs (isolated in-memory database).
// BYOK runs take the non-recovery path: nothing journals the world revision,
// so the write itself must not clobber an editor save made mid-run.
const TOOLS: ToolDefinition[] = [{ type: "function", function: {
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
function writeVariable(id: string): ToolCall {
  return { id: `call-${id}`, type: "function", function: { name: "write_variable",
    arguments: JSON.stringify({ id, name: id, type: "number", defaultValue: 1 }) } };
}
function text(content: string): Script {
  return async function* () {
    yield { type: "text", content };
    yield { type: "done", content: "", usage, stopReason: "end_turn" };
  };
}

async function fixture() {
  const userId = crypto.randomUUID();
  const worldId = crypto.randomUUID();
  const world = migrateWorldDefinition({ id: worldId, version: "19.0.0", name: "Before", description: "", author: "t",
    entries: [], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [],
    settings: { maxTokens: 4000, temperature: 1, playerName: "User" },
  } as unknown as WorldDefinition);
  await db.insert(user).values({ id: userId, name: "Concurrent save", email: `${userId}@test.local` });
  await db.insert(worlds).values({ id: worldId, creatorId: userId, name: world.name, status: "draft",
    schema: world as unknown as Record<string, unknown> });
  const [conversation] = await db.insert(studioConversations).values({ worldId, userId }).returning();
  const [run] = await db.insert(agentRuns).values({ worldId, userId, conversationId: conversation!.id,
    model: "test/byok", status: "running", messages: [{ role: "user", content: "Add a variable." }] }).returning();
  return { userId, worldId, runId: run!.id, conversationId: conversation!.id, world };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function runLoop(f: Fixture, provider: LLMProvider, maxIterations = 4) {
  const params: AgentLoopParams = {
    runId: f.runId, conversationId: f.conversationId, worldId: f.worldId, userId: f.userId,
    world: f.world, messages: [{ role: "user", content: "Add a variable." }], model: "test/byok",
    provider, isByok: true, apiKeyTier: "regular", iteration: 0, maxIterations, tools: TOOLS,
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
async function stored(f: Fixture) {
  const [row] = await db.select().from(worlds).where(eq(worlds.id, f.worldId));
  return row!.schema as unknown as WorldDefinition;
}
async function readRun(f: Fixture) {
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, f.runId));
  return run!;
}

describe("Studio agent outside credit recovery", { concurrency: false }, () => {
  it("keeps an editor save made mid-run when the agent writes afterwards", async () => {
    const f = await fixture();
    const provider = new ScriptedProvider([
      async function* () {
        yield { type: "text", content: "Adding the variable." };
        // The creator saves in the editor while the model is still generating.
        const current = await stored(f);
        await db.update(worlds).set({
          schema: { ...current, name: "Renamed by the creator",
            entries: [{ id: "creator-entry", name: "Creator lore", content: "Typed by hand", role: "lore",
              section: "chat-history", position: 0, keywords: [], conditions: [], conditionLogic: "all",
              enabled: true, alwaysSend: false }] } as unknown as Record<string, unknown>,
          updatedAt: new Date(Date.now() + 1000),
        }).where(eq(worlds.id, f.worldId));
        yield { type: "tool_call_end", content: "", toolCall: writeVariable("agent-var") };
        yield { type: "done", content: "", usage, stopReason: "tool_use" };
      },
      text("Done."),
    ]);
    await runLoop(f, provider);
    const world = await stored(f);
    assert.equal(world.name, "Renamed by the creator", "The creator's save survives the agent's write");
    assert.deepEqual(world.entries.map(e => e.id), ["creator-entry"]);
    assert.deepEqual(world.variables.map(v => v.id), ["agent-var"], "The agent's change still lands");
    assert.equal((await readRun(f)).status, "completed");
  });

  it("continues the next step from the merged world", async () => {
    const f = await fixture();
    const provider = new ScriptedProvider([
      async function* () {
        const current = await stored(f);
        await db.update(worlds).set({ schema: { ...current, name: "Saved mid-step" } as unknown as Record<string, unknown>,
          updatedAt: new Date(Date.now() + 2000) }).where(eq(worlds.id, f.worldId));
        yield { type: "tool_call_end", content: "", toolCall: writeVariable("first") };
        yield { type: "done", content: "", usage, stopReason: "tool_use" };
      },
      async function* (params) {
        // The model's next view of the card includes the creator's save.
        assert.match(JSON.stringify(params.messages[0]), /Saved mid-step/);
        yield { type: "tool_call_end", content: "", toolCall: writeVariable("second") };
        yield { type: "done", content: "", usage, stopReason: "tool_use" };
      },
      text("Done."),
    ]);
    await runLoop(f, provider);
    const world = await stored(f);
    assert.equal(world.name, "Saved mid-step");
    assert.deepEqual(world.variables.map(v => v.id).sort(), ["first", "second"]);
  });

  // The system prompt sits ahead of the conversation in the prompt cache: if
  // the request's own writes changed it, every later step wrote the whole
  // history into the cache again at the write price.
  it("keeps the system prompt byte-identical across the request's own writes", async () => {
    process.env.STUDIO_STABLE_PROMPT = "on";
    after(() => { delete process.env.STUDIO_STABLE_PROMPT; });
    const f = await fixture();
    let first = "";
    const provider = new ScriptedProvider([
      async function* (params) {
        first = JSON.stringify(params.messages[0]);
        yield { type: "tool_call_end", content: "", toolCall: writeVariable("first") };
        yield { type: "done", content: "", usage, stopReason: "tool_use" };
      },
      async function* (params) {
        assert.equal(JSON.stringify(params.messages[0]), first);
        yield { type: "tool_call_end", content: "", toolCall: writeVariable("second") };
        yield { type: "done", content: "", usage, stopReason: "tool_use" };
      },
      async function* (params) {
        assert.equal(JSON.stringify(params.messages[0]), first);
        yield { type: "text", content: "Done." };
        yield { type: "done", content: "", usage, stopReason: "end_turn" };
      },
    ]);
    await runLoop(f, provider);
    const world = await stored(f);
    assert.deepEqual(world.variables.map(v => v.id).sort(), ["first", "second"]);
  });

  it("tells the model its context copy is stale after it updates something", async () => {
    process.env.STUDIO_STABLE_PROMPT = "on";
    after(() => { delete process.env.STUDIO_STABLE_PROMPT; });
    const f = await fixture();
    let secondResults = "";
    const provider = new ScriptedProvider([
      async function* () {
        yield { type: "tool_call_end", content: "", toolCall: writeVariable("v1") };
        yield { type: "done", content: "", usage, stopReason: "tool_use" };
      },
      async function* () {
        yield { type: "tool_call_end", content: "", toolCall: { id: "call-v1-again", type: "function", function: { name: "write_variable",
          arguments: JSON.stringify({ id: "v1", name: "v1", type: "number", defaultValue: 2 }) } } };
        yield { type: "done", content: "", usage, stopReason: "tool_use" };
      },
      async function* (params) {
        secondResults = JSON.stringify(params.messages.slice(-1));
        yield { type: "text", content: "Done." };
        yield { type: "done", content: "", usage, stopReason: "end_turn" };
      },
    ]);
    await runLoop(f, provider);
    assert.match(secondResults, /read_entities it/);
  });

  it("does not nudge a finished answer, and nudges an announced action at most once", async () => {
    const answer = await fixture();
    const answered = new ScriptedProvider([text("好感度变量的范围是 0 到 100。")]);
    await runLoop(answer, answered);
    assert.equal(answered.calls.length, 1, "A plain answer ends the run");
    assert.equal((await readRun(answer)).status, "completed");

    const stall = await fixture();
    const stalled = new ScriptedProvider([text("I'll add the variable now."), text("Let me add it next.")]);
    await runLoop(stall, stalled);
    assert.equal(stalled.calls.length, 2, "One nudge, then the run completes");
    assert.equal(stalled.calls[1]!.messages.filter(m => isHarnessTurn(m)).length, 1);
  });

  it("lists only the writes that landed under the step's bubble", async () => {
    const f = await fixture();
    const broken: ToolCall = { id: "call-broken", type: "function", function: { name: "write_variable", arguments: "{not json" } };
    const events = await runLoop(f, new ScriptedProvider([
      async function* () {
        yield { type: "tool_call_end", content: "", toolCall: writeVariable("kept") };
        yield { type: "tool_call_end", content: "", toolCall: broken };
        yield { type: "done", content: "", usage, stopReason: "tool_use" };
      },
      text("Done."),
    ]));
    // A rejected edit showed under 「已应用」 as if it had changed the card.
    const step = events.find(e => e.event === "assistant_turn_commit" && Array.isArray(e.data.writeToolCalls));
    assert.deepEqual((step?.data.writeToolCalls as ToolCall[]).map(tc => tc.id), ["call-kept"]);
    assert.deepEqual((await stored(f)).variables.map(v => v.id), ["kept"]);
  });

  it("explains a stop caused by an identical repeated write", async () => {
    const f = await fixture();
    const same: Script = async function* () {
      yield { type: "tool_call_end", content: "", toolCall: writeVariable("dup") };
      yield { type: "done", content: "", usage, stopReason: "tool_use" };
    };
    const events = await runLoop(f, new ScriptedProvider([same, same]));
    const commits = events.filter(e => e.event === "assistant_turn_commit").map(e => String(e.data.textContent));
    assert.ok(commits.some(t => /repeated exactly the same edit/.test(t)), "The user is told why the run ended");
    const run = await readRun(f);
    assert.ok(run.committedTurns?.some(t => t.lane === "notice"));
  });
});

describe("agent run control", { concurrency: false }, () => {
  async function stop(f: Fixture, asUser: string, extra: Record<string, unknown> = {}) {
    const path = "/:worldId/agent/stop";
    const handler = agentRoutes.routes.find(route => route.method === "POST" && route.path === path)?.handler;
    assert.ok(handler);
    const app = new Hono<{ Variables: { user: { id: string } } }>();
    app.use("*", async (c, next) => { c.set("user", { id: asUser }); await next(); });
    app.post(path, handler);
    return app.request(`/${f.worldId}/agent/stop`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: f.runId, ...extra }) });
  }

  it("refuses to stop another user's run", async () => {
    const f = await fixture();
    const result = await stop(f, crypto.randomUUID());
    assert.equal(result.status, 404);
    assert.equal((await readRun(f)).status, "running");
  });

  it("keeps a paused run's checkpoint", async () => {
    const f = await fixture();
    const checkpoint = { version: 1, phase: "preflight", messages: [], iteration: 0, worldRevision: "r", requiredCredits: 5 };
    await db.update(agentRuns).set({ status: "awaiting_credits", creditCheckpoint: checkpoint }).where(eq(agentRuns.id, f.runId));
    assert.equal((await stop(f, f.userId)).status, 200);
    const run = await readRun(f);
    assert.equal(run.status, "awaiting_credits");
    assert.deepEqual(run.creditCheckpoint, checkpoint);
  });

  it("discards a paused run when the creator starts over", async () => {
    const f = await fixture();
    const checkpoint = { version: 1, phase: "preflight", messages: [], iteration: 0, worldRevision: "r", requiredCredits: 5 };
    await db.update(agentRuns).set({ status: "awaiting_credits", creditCheckpoint: checkpoint }).where(eq(agentRuns.id, f.runId));
    assert.equal((await stop(f, f.userId, { discardPause: true })).status, 200);
    const run = await readRun(f);
    assert.equal(run.status, "completed");
    assert.equal(run.creditCheckpoint, null);
  });

  it("stops a running run", async () => {
    const f = await fixture();
    assert.equal((await stop(f, f.userId)).status, 200);
    const run = await readRun(f);
    assert.equal(run.status, "completed");
    assert.equal(run.error, "Stopped by user.");
  });

  it("maps stored errors to stable codes", () => {
    assert.equal(agentErrorCode("Agent stalled — no model output for 3 minutes."), "AGENT_STALLED");
    assert.equal(agentErrorCode("Server restarted. Please retry."), "SERVER_RESTART");
    assert.equal(agentErrorCode("Superseded by new agent run."), "SUPERSEDED");
    assert.equal(agentErrorCode("CLAIM_LOST"), "CLAIM_LOST");
    assert.equal(agentErrorCode('duplicate key value violates unique constraint "x"'), "AGENT_ERROR");
  });
});
