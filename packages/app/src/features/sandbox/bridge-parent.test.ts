import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { SandboxBridge, type ApiHandler, type StreamHandler } from "./bridge-parent";
import { buildAPI, resolveApiCall } from "../../../sandbox/sandbox-context";
import { installCompatShims, resolveShimCall } from "../../../sandbox/compat-shims";
import {
  unwrapMessage,
  wrapMessage,
  type ApiResponseMessage,
  type ParentMessage,
  type SandboxMessage,
} from "../../../sandbox/protocol";

function harness(t: TestContext, onApiCall: ApiHandler, onStreamCall?: StreamHandler, ready = true) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const host = new EventTarget();
  const responses: ParentMessage[] = [];
  const child = {
    postMessage(data: unknown) {
      const message = unwrapMessage<ParentMessage>(data)!;
      responses.push(message);
      if (message.type === "api-response") {
        // The component host routes these two response families to their SDKs.
        const receive = message.callId.startsWith("shim-") ? resolveShimCall : resolveApiCall;
        receive(message.callId, message.result, message.error);
      }
    },
  };
  function emit(message: SandboxMessage, source: unknown = child, origin = "null") {
    const event = new Event("message");
    Object.defineProperties(event, {
      source: { value: source },
      origin: { value: origin },
      data: { value: wrapMessage(message) },
    });
    host.dispatchEvent(event);
  }
  const fakeWindow = Object.assign(host, {
    location: { origin: "https://yumina.test", search: "" },
    parent: { postMessage: (data: unknown) => emit(unwrapMessage<SandboxMessage>(data)!) },
    fetch: async () => new Response("{}"),
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  const bridge = new SandboxBridge({ onApiCall, onStreamCall, onResize() {}, onError() {} });
  bridge.attach({ contentWindow: child } as unknown as HTMLIFrameElement);
  if (ready) emit({ type: "ready", protocolVersion: 2 });
  t.after(() => {
    bridge.destroy();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  });
  const api = buildAPI({
    variables: {}, globalVariables: {}, worldName: "RPC test", worldId: "w1",
    sessionId: "s1", messages: [], mode: "session",
  } as unknown as Parameters<typeof buildAPI>[0]);
  const request = (callId: string, method = "test") => emit({ type: "api-call", callId, method, args: [] });
  return { api, responses, request, emit, fakeWindow, bridge };
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test("fetchAsset accepts a 12-second bridge response with the original binary payload", async (t) => {
  const bytes = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0, 255]).buffer;
  const calls: { method: string; args: unknown[] }[] = [];
  const h = harness(t, (method, args) => {
    calls.push({ method, args });
    return new Promise(resolve => setTimeout(() => resolve({ ok: true, bytes, contentType: "model/gltf-binary" }), 12_000));
  });
  const ref = "@asset:11111111-1111-4111-8111-111111111111";
  const pending = h.api.fetchAsset(ref);
  t.mock.timers.tick(12_000);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.bytes, bytes);
  assert.deepEqual(new Uint8Array(result.bytes!), new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0, 255]));
  assert.equal(result.contentType, "model/gltf-binary");
  assert.deepEqual(calls, [{ method: "fetchAsset", args: [ref] }]);
});

test("fetchAsset waits 30 seconds before returning an error and ignores a late bridge reply", async (t) => {
  let complete!: (value: unknown) => void;
  const h = harness(t, () => new Promise(resolve => { complete = resolve; }));
  const pending = h.api.fetchAsset("11111111-1111-4111-8111-111111111111");
  let settled = false;
  void pending.then(() => { settled = true; });
  t.mock.timers.tick(29_999);
  await flush();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  const failed = await pending;
  assert.deepEqual(failed, { ok: false, error: "API call 'fetchAsset' timed out" });
  const late = { ok: true, bytes: new Uint8Array([1, 2, 3]).buffer, contentType: "application/octet-stream" };
  complete(late);
  await flush();
  assert.equal((h.responses.at(-1) as ApiResponseMessage).result, late, "the late response reaches resolveApiCall");
  assert.equal(await pending, failed, "late bytes cannot replace the timeout result");
});

test("ordinary SDK methods retain their 10-second timeout", async (t) => {
  const h = harness(t, () => new Promise(() => {}));
  let settled = false;
  const pending = h.api.storage.remove("campaign").then(
    () => { settled = true; return "unexpected success"; },
    (error: Error) => { settled = true; return error.message; },
  );
  t.mock.timers.tick(9999);
  await flush();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  assert.equal(await pending, "API call 'storage.remove' timed out");
});

test("fetchAsset preserves immediate success and parent errors without waiting for its deadline", async (t) => {
  const success = { ok: true, bytes: new Uint8Array([4, 5, 6]).buffer, contentType: "model/gltf-binary" };
  const rejected = { ok: false, error: "too-large" };
  let response: unknown = success;
  const h = harness(t, () => response);
  assert.equal(await h.api.fetchAsset("asset"), success);
  response = rejected;
  assert.equal(await h.api.fetchAsset("asset"), rejected);
  response = Promise.reject(new Error("Network unavailable"));
  assert.deepEqual(await h.api.fetchAsset("asset"), { ok: false, error: "Network unavailable" });
  t.mock.timers.tick(30_000);
  assert.equal(h.responses.length, 3);
});

test('keyed voice output frames reach an additive SDK subscription without changing legacy playback', (t) => {
  const h = harness(t, () => {});
  const listen = (h.api.tts as typeof h.api.tts & { onPlaybackFrame?: (cb: (frame: unknown) => void) => () => void }).onPlaybackFrame;
  assert.equal(typeof listen, 'function');
  const frames: unknown[] = [];
  const off = listen!(frame => frames.push(frame));
  const frame = { key: 'hat-turn-3', generation: 7, audible: true, audioLevel: .3, currentTime: .5, duration: 2 };
  const event = new Event('yumina:voice-playback-frame');
  Object.defineProperty(event, 'detail', { value: frame });
  h.fakeWindow.dispatchEvent(event);
  assert.deepEqual(frames, [frame]);
  off();
  h.fakeWindow.dispatchEvent(event);
  assert.equal(frames.length, 1);
  assert.equal(h.api.ttsState.playback, null);
});

test('the parent bridge sends compact voice frames as their own message', (t) => {
  const h = harness(t, () => {});
  const send = (h.bridge as typeof h.bridge & { sendVoicePlaybackFrame?: (frame: unknown) => void }).sendVoicePlaybackFrame;
  assert.equal(typeof send, 'function');
  const frame = { key: 'hat-turn-3', generation: 7, audible: false, audioLevel: 0, currentTime: .5 };
  send!.call(h.bridge, frame);
  assert.deepEqual(h.responses.at(-1), { type: 'voice-playback-frame', frame });
});

test('voice samples are not queued for obsolete replay during iframe boot', (t) => {
  const h = harness(t, () => {}, undefined, false);
  const send = (h.bridge as typeof h.bridge & { sendVoicePlaybackFrame?: (frame: unknown) => void }).sendVoicePlaybackFrame;
  assert.equal(typeof send, 'function');
  const frame = { key: 'hat-turn-3', generation: 7, audible: true, audioLevel: .3, currentTime: .5 };
  send!.call(h.bridge, frame);
  h.emit({ type: 'ready', protocolVersion: 2 });
  assert.equal(h.responses.filter(message => (message as {type:string}).type === 'voice-playback-frame').length, 0);
  send!.call(h.bridge, { ...frame, audible: false, audioLevel: 0 });
  assert.equal(h.responses.filter(message => (message as {type:string}).type === 'voice-playback-frame').length, 1);
});

test("SDK storage writes with synchronous void handlers resolve instead of timing out", async (t) => {
  const stored = new Map<string, unknown>();
  const h = harness(t, (method, args) => {
    if (method === "storage.set") stored.set(String(args[0]), args[1]);
    if (method === "storage.remove") stored.delete(String(args[0]));
    // Same successful return as WorldRenderer's localStorage handlers.
  });
  const saved = h.api.storage.set("campaign", "snapshot").then(() => "saved", (e: Error) => e.message);
  await flush();
  t.mock.timers.tick(10_001);
  assert.equal(await saved, "saved");
  assert.equal(stored.get("campaign"), "snapshot");
  const removed = h.api.storage.remove("campaign").then(() => "removed", (e: Error) => e.message);
  await flush();
  t.mock.timers.tick(10_001);
  assert.equal(await removed, "removed");
  assert.equal(stored.has("campaign"), false);
  assert.equal(h.responses.length, 2);
});

test("sessionStorage forwards JSON and explicit versions, and propagates conflicts without retry", async (t) => {
  const calls: { method: string; args: unknown[] }[] = [];
  const h = harness(t, (method, args) => {
    calls.push({ method, args });
    if (method === "sessionStorage.get") return { value: { coverEntryId: "one" }, version: 3, exists: true };
    if (method === "sessionStorage.set") {
      if ((args[2] as { expectedVersion: number }).expectedVersion !== 3) throw new Error("SESSION_STORAGE_CONFLICT");
      return { value: args[1], version: 4, exists: true };
    }
    return { value: null, version: 5, exists: false };
  });
  const current = await h.api.sessionStorage.get<{ coverEntryId: string }>("gallery");
  assert.equal(current.value?.coverEntryId, "one");
  const saved = await h.api.sessionStorage.set("gallery", { coverEntryId: "two" }, { expectedVersion: current.version });
  assert.equal(saved.version, 4);
  await assert.rejects(h.api.sessionStorage.set("gallery", { coverEntryId: "stale" }, { expectedVersion: 2 }), /SESSION_STORAGE_CONFLICT/);
  assert.deepEqual(await h.api.sessionStorage.remove("gallery", { expectedVersion: 4 }), { value: null, version: 5, exists: false });
  assert.deepEqual(calls, [
    { method: "sessionStorage.get", args: ["gallery"] },
    { method: "sessionStorage.set", args: ["gallery", { coverEntryId: "two" }, { expectedVersion: 3 }] },
    { method: "sessionStorage.set", args: ["gallery", { coverEntryId: "stale" }, { expectedVersion: 2 }] },
    { method: "sessionStorage.remove", args: ["gallery", { expectedVersion: 4 }] },
  ]);
});

test("request IDs govern replies; void, null, false and domain errors retain their values", async (t) => {
  const values = [undefined, Promise.resolve(undefined), null, false, { error: "quota_exceeded" }];
  const h = harness(t, () => values.shift());
  for (const id of ["async-1", "shim-1", "callback-1", "callback-fire-result", "async-5"]) h.request(id);
  await flush();
  assert.deepEqual(h.responses.map((message) => (message as ApiResponseMessage).result), [
    undefined, undefined, null, false, { error: "quota_exceeded" },
  ]);
});

test("synchronous throws and rejected handlers reject the SDK promise immediately", async (t) => {
  const h = harness(t, (method) => {
    if (method === "storage.set") throw new Error("Storage unavailable");
    return Promise.reject(new Error("Read unavailable"));
  });
  await assert.rejects(h.api.storage.set("campaign", "snapshot"), /Storage unavailable/);
  await assert.rejects(h.api.storage.get("campaign"), /Read unavailable/);
  assert.deepEqual(h.responses.map((message) => (message as ApiResponseMessage).error), [
    "Storage unavailable", "Read unavailable",
  ]);
});

test("legacy fetch shims receive successful responses and transport rejections", async (t) => {
  let failed = false;
  harness(t, () => failed ? Promise.reject(new Error("Network unavailable")) : { status: 200, body: { ok: true } });
  installCompatShims();
  const response = await window.fetch("/api/sessions/s1");
  assert.deepEqual(await response.json(), { ok: true });
  failed = true;
  await assert.rejects(window.fetch("/api/sessions/s1"), /Network unavailable/);
});

test("notification and streaming calls retain their separate response behavior", async (t) => {
  let notifications = 0;
  const h = harness(t, () => { notifications++; return "ignored"; }, (_method, _args, stream) => {
    stream.onDelta("hello");
    stream.onDone("hello world");
  });
  h.request("fire-1");
  h.request("shim-fire-2");
  h.request("");
  h.request("stream-3");
  await flush();
  assert.equal(notifications, 3);
  assert.deepEqual(h.responses, [
    { type: "api-stream", callId: "stream-3", delta: "hello", done: false },
    { type: "api-stream", callId: "stream-3", delta: "", done: true, result: "hello world" },
  ]);
});

test("RPC requests from a foreign window or origin cannot execute or obtain a reply", async (t) => {
  let calls = 0;
  const h = harness(t, () => { calls++; });
  const request = { type: "api-call", callId: "async-1", method: "storage.set", args: [] } as const;
  h.emit({ ...request, args: [] }, {}, "null");
  h.emit({ ...request, args: [] }, undefined, "https://foreign.test");
  await flush();
  assert.equal(calls, 0);
  assert.deepEqual(h.responses, []);
});
