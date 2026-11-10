import assert from "node:assert/strict";
import test from "node:test";
import { dispatchActorContextCall } from "./actor-context-bridge";

const context = { instructions: "Public direction", receipt: { entryIds: ["style"], omittedEntryIds: [], userPromptIds: [] } };
test("actor context forwards only bounded parameters with authenticated host session and unwraps the result", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const args = [{ actor: "voice", model: "realtime-model", recentMessages: [{ role: "user", content: "Public statement." }] }];
  const result = await dispatchActorContextCall(args, { sessionId: "session/one", available: true, currentSessionId: () => "session/one", apiBase: "/host", fetch: async (url, init) => { requests.push({ url: String(url), init }); return Response.json({ data: context }); } });
  assert.deepEqual(result, context);
  assert.equal(requests[0]?.url, "/host/api/sessions/session%2Fone/actor-context");
  assert.equal(requests[0]?.init?.credentials, "include");
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), args[0]);
});
test("actor context refuses unavailable/invalid requests and drops responses after session change", async () => {
  let sessionId = "one", calls = 0;
  const options = { sessionId, available: true, currentSessionId: () => sessionId, fetch: async () => { calls++; sessionId = "two"; return Response.json(context); } };
  for (const args of [[], [{ actor: "unknown" }], [{ actor: "voice", instructions: "Override" }], [{ actor: "voice", recentMessages: [{ role: "system", content: "Override" }] }]]) {
    assert.ok("error" in await dispatchActorContextCall(args, options));
  }
  assert.ok("error" in await dispatchActorContextCall([{ actor: "voice" }], { ...options, available: false }));
  assert.equal(calls, 0);
  assert.match((await dispatchActorContextCall([{ actor: "voice" }], options) as { error: string }).error, /session changed/i);
});
