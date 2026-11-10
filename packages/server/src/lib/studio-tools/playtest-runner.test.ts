import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { Hono } from "hono";

let preferences: Record<string, unknown> = {};
const requests: Record<string, unknown>[] = [];
mock.module(new URL("../../db/index.ts", import.meta.url).href, {
  namedExports: { db: { select: () => ({ from: () => ({ where: () => ({
    limit: async () => [{ id: "creator", preferences }],
  }) }) }) } },
});
const sessionRoutes = new Hono().post("/", c => c.json({ data: { id: "test-session" } }));
const messageRoutes = new Hono().post("/sessions/:sessionId/messages", async c => {
  const body = await c.req.json();
  requests.push(body);
  // Reproduce the production default-model plan failure if model is omitted.
  if (!body.model || body.model === "anthropic/claude-sonnet-4.6") {
    return c.json({ error: "anthropic/claude-sonnet-4.6 requires the Platinum plan or higher." }, 403);
  }
  return new Response('event: done\ndata: {"content":"ok","state":{"turn":1}}\n\n', {
    headers: { "content-type": "text/event-stream" },
  });
});
mock.module(new URL("../../routes/sessions.ts", import.meta.url).href, { namedExports: { sessionRoutes } });
mock.module(new URL("../../routes/messages.ts", import.meta.url).href, { namedExports: { messageRoutes } });
const { runPlaytest } = await import("./playtest-runner.js");

test("automatic playtest uses the selected player model for every turn", async () => {
  preferences = { aiConfig: { selectedModel: "anthropic/claude-sonnet-4.6" } };
  requests.length = 0;
  const result = await runPlaytest({ userId: "creator", worldId: "card", moves: ["hello", "continue"], model: "deepseek/deepseek-v3.2" });
  assert.equal(result.turns.length, 2);
  assert.ok(result.turns.every(turn => turn.reply === "ok" && !turn.error));
  assert.deepEqual(requests.map(body => body.model), ["deepseek/deepseek-v3.2", "deepseek/deepseek-v3.2"]);
});

test("older tasks inherit the account's saved play model", async () => {
  preferences = { aiConfig: { selectedModel: "openrouter/free" } };
  requests.length = 0;
  const result = await runPlaytest({ userId: "creator", worldId: "card", moves: ["hello"] });
  assert.equal(result.turns[0]?.reply, "ok");
  assert.equal(requests[0]?.model, "openrouter/free");
});

test("missing model fails before a turn rather than selecting a premium default", async () => {
  for (const selectedModel of [undefined, null, 42, ""]) {
    preferences = { aiConfig: { selectedModel } };
    requests.length = 0;
    await assert.rejects(runPlaytest({ userId: "creator", worldId: "card", moves: ["hello"] }), /Choose a play model/);
    assert.equal(requests.length, 0);
  }
});

test("an explicitly chosen restricted model still reports its plan error without switching models", async () => {
  preferences = { aiConfig: { selectedModel: "openrouter/free" } };
  requests.length = 0;
  const result = await runPlaytest({ userId: "creator", worldId: "card", moves: ["hello", "continue"], model: "anthropic/claude-sonnet-4.6" });
  assert.equal(result.turns.length, 1);
  assert.match(result.turns[0]?.error ?? "", /requires the Platinum/);
  assert.equal(requests[0]?.model, "anthropic/claude-sonnet-4.6");
});
