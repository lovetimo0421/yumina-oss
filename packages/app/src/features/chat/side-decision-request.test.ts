import assert from "node:assert/strict";
import test from "node:test";
import { buildAPI, resolveApiCall } from "../../../sandbox/sandbox-context";
import { unwrapMessage, type SandboxMessage } from "../../../sandbox/protocol";
import { requestSideDecision } from "./side-decision-request";

const params = { state: { scene: "observe" }, questions: { action: { type: "choice" as const, instructions: "Choose", criteria: { wait: "Wait" } } } };
const result = { answers: { action: { type: "choice", choice: "wait", probabilities: { wait: 1 }, confidence: 1 } } };

test("the decision SDK forwards only state/questions and settles a typed response", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  let sent: SandboxMessage | undefined;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { parent: { postMessage(data: unknown) { sent = unwrapMessage<SandboxMessage>(data)!; } } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window"); });
  const api = buildAPI({ variables: {}, globalVariables: {}, worldName: "Test", worldId: "w", sessionId: "s", messages: [], mode: "session", selectedModel: "selected/model" } as unknown as Parameters<typeof buildAPI>[0]);
  const promise = api.ai.decide({ ...params, model: "forged/model", apiKey: "forged-key", narrativeModel: "forged/model" } as Parameters<typeof api.ai.decide>[0]);
  assert.ok(sent && sent.type === "api-call");
  resolveApiCall(sent.callId, result);
  assert.deepEqual(await promise, result);
  assert.equal(sent.method, "ai.decide"); assert.deepEqual(sent.args, [params]);
});

test("the host injects its fresh model, ignores forged credentials/model fields and forwards cancellation", async t => {
  const controller = new AbortController();
  const calls: { url: unknown; init?: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    calls.push({ url, init }); return new Response(JSON.stringify(result));
  });
  assert.deepEqual(await requestSideDecision("current-session", { ...params, model: "forged", narrativeModel: "forged", apiKey: "forged" }, "fresh-model", controller.signal), result);
  assert.equal(calls[0]!.url, "/api/sessions/current-session/decisions");
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { ...params, narrativeModel: "fresh-model" });
  assert.equal(calls[0]!.init?.signal, controller.signal);
  assert.equal(calls[0]!.init?.credentials, "include");
});

test("decision errors reject without a retry or fabricated metadata", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(JSON.stringify({ error: "Decision timed out" }), { status: 504 }); });
  await assert.rejects(requestSideDecision("s", params, "model", new AbortController().signal), /Decision timed out/);
  assert.equal(calls, 1);
});
