import assert from "node:assert/strict";
import test from "node:test";
import { buildAPI, receiveStreamChunk } from "../../../sandbox/sandbox-context";
import { unwrapMessage, type SandboxMessage } from "../../../sandbox/protocol";
import { buildSideCompletionRequest } from "./side-completion-request";

test("the SDK forwards session context and explicit limits without card-supplied preferences", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  let sent: SandboxMessage | undefined;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { parent: { postMessage(data: unknown) { sent = unwrapMessage<SandboxMessage>(data)!; } } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window"); });
  const api = buildAPI({ variables: {}, globalVariables: {}, worldName: "Test", worldId: "w", sessionId: "s", messages: [], mode: "session", selectedModel: "selected/model" } as unknown as Parameters<typeof buildAPI>[0]);
  const promise = api.ai.complete({ messages: [{ role: "user", content: "scene" }], context: "session", maxTokens: 900, temperature: 0.3, overrides: { temperature: 99 } } as Parameters<typeof api.ai.complete>[0]);
  assert.ok(sent && sent.type === "api-call");
  const params = sent.args[0] as Record<string, unknown>;
  // Settle the SDK request before assertions so a failing test leaves no timer.
  receiveStreamChunk(sent.callId, "", true, "{}");
  assert.equal(await promise, "{}");
  assert.equal(params.context, "session");
  assert.equal(params.model, "selected/model");
  assert.equal(params.maxTokens, 900); assert.equal(params.temperature, 0.3);
  assert.equal(params.overrides, undefined);
});

test("the host uses fresh player preferences, ignores forged card overrides, and leaves raw calls alone", () => {
  const params = { messages: [{ role: "user" as const, content: "scene" }], context: "session" as const, maxTokens: 700, temperature: 0.2, overrides: { maxTokens: 999999, temperature: 99 } };
  const preferences = { maxTokens: 5000, temperature: 0.8, topP: 0.7, reasoningEffort: "low", repetitionPenalty: 1.08 };
  const first = buildSideCompletionRequest(params, preferences);
  assert.equal(first.maxTokens, 700); assert.equal(first.temperature, 0.2);
  assert.equal(first.overrides?.maxTokens, 5000); assert.equal(first.overrides?.temperature, 0.8);
  assert.equal(first.overrides?.repetitionPenalty, undefined);
  assert.equal(first.overrides?.reasoningEffort, "low");
  preferences.temperature = 0.5;
  assert.equal(buildSideCompletionRequest(params, preferences).overrides?.temperature, 0.5);
  assert.equal(buildSideCompletionRequest({ ...params, context: undefined }, preferences).overrides, undefined);
  assert.equal(buildSideCompletionRequest({ ...params, model: "moonshotai/kimi-k2-0905" }, preferences).overrides?.repetitionPenalty, 1.08);
});
