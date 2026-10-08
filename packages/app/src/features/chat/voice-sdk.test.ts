import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transform } from "sucrase";
import { createVoiceAPI, VOICE_EVENT } from "../../../sandbox/voice-api";
import { formatVoiceSceneReaction, isVoiceSceneReaction, type VoiceSceneReaction, type VoiceSceneReference } from "../../../sandbox/voice-types";
import { hydrateVoiceSceneNotice } from "./voice-scene-notice";
import type { SandboxState } from "../../../sandbox/protocol";
import type { buildAPI as BuildAPI } from "../../../sandbox/sandbox-context";

test("live interrupt crosses the SDK bridge once without arguments only when available", () => {
  const calls: unknown[] = [];
  for (const available of [true, false]) {
    const api = createVoiceAPI({ available, call: async () => { throw Error("No reconnect"); }, post(method, args) { calls.push([method, args]); }, target: new EventTarget() });
    api.interrupt();
  }
  assert.deepEqual(calls, [["realtimeVoice.interrupt", []]]);
});

test("voice SDK forwards interruption mode unchanged and rejects invalid modes", async () => {
  const calls: unknown[][] = [];
  const api = createVoiceAPI({ available: true, call: async (_method, args) => { calls.push(args); return { status: "connected" } as never; }, post() {}, target: new EventTarget() });
  for (const interruptionMode of [undefined, "automatic", "manual"] as const) {
    const params = { instructions: "Official", ...(interruptionMode === undefined ? {} : { interruptionMode }) };
    await api.start(params);
    assert.deepEqual(calls.at(-1), [params]);
  }
  for (const interruptionMode of [null, "always", true, {}, []]) await assert.rejects(api.start({ instructions: "Official", interruptionMode } as never), /interruption/i);
  assert.equal(calls.length, 3);
});

test("voice SDK forwards only a bounded known tool allowlist, preserving omission", async () => {
  const calls: unknown[][] = [];
  const api = createVoiceAPI({ available: true, call: async (_method, args) => { calls.push(args); return { status: "connected" } as never; }, post() {}, target: new EventTarget() });
  for (const tools of [undefined, [], ["request_inspection_focus"]] as const) {
    const params = { instructions: "hello", ...(tools === undefined ? {} : { tools: [...tools] }) };
    await api.start(params as Parameters<typeof api.start>[0]);
    assert.deepEqual(calls.at(-1), [params]);
  }
  for (const tools of [null, "request_inspection_focus", {}, [null], ["executeCode"], ["request_inspection_focus", "request_inspection_focus"], Array(100).fill("request_inspection_focus"), [{ name: "request_inspection_focus", parameters: {} }]]) {
    await assert.rejects(api.start({ instructions: "hello", tools } as never), /tool/i);
  }
  assert.equal(calls.length, 3, "Invalid tools never cross the sandbox bridge");
});

test("voice SDK rejects unavailable capabilities and host failure responses", async () => {
  let calls = 0;
  const denied = createVoiceAPI({ available: false, call: async () => { calls++; return { status: "connected" } as never; }, post() {}, target: new EventTarget() });
  await assert.rejects(denied.start({ instructions: "hi" }), /unavailable/); assert.equal(calls, 0);
  const failed = createVoiceAPI({ available: true, call: async () => ({ error: "Microphone permission was declined." } as never), post() {}, target: new EventTarget() });
  await assert.rejects(failed.start({ instructions: "hi" }), /declined/);
});

test("voice SDK relays typed methods and can unsubscribe from activity/transcript events", async () => {
  const calls: { method: string; args: unknown[]; timeout?: number }[] = [], target = new EventTarget();
  const api = createVoiceAPI({ available: true, call: async (method, args, timeout) => { calls.push({ method, args, timeout }); return { status: "connected" } as never; }, post(method, args) { calls.push({ method, args }); }, target });
  assert.deepEqual(await api.start({ instructions: "hello" }), { status: "connected" });
  api.setMuted({ input: true, output: true }); api.updateContext("Witnessed desk.");
  api.reactToScene({ id: "scene:1", kind: "return" });
  api.resolveTool("call1", { accepted: false, reason: "Keep focus." });
  api.setSpatial({ x: 0, z: 1, yaw: 0, sourceX: 3, sourceZ: 4 }); api.stop();
  assert.deepEqual(calls.map(call => call.method), ["realtimeVoice.start", "realtimeVoice.setMuted", "realtimeVoice.updateContext", "realtimeVoice.reactToScene", "realtimeVoice.resolveTool", "realtimeVoice.setSpatial", "realtimeVoice.stop"]);
  assert.deepEqual(calls[3]?.args, [{ id: "scene:1", kind: "return" }]);
  assert.equal(calls[0]!.timeout, 180_000);
  api.updateInstructions("Replacement direction."); api.cancelSceneReaction("scene:1");
  assert.deepEqual(calls.slice(-2).map(call => [call.method, call.args]), [["realtimeVoice.updateInstructions", ["Replacement direction."]], ["realtimeVoice.cancelSceneReaction", ["scene:1"]]]);
  assert.throws(() => api.updateInstructions("x".repeat(12001)), /instructions/i);
  assert.throws(() => api.cancelSceneReaction("bad id"), /scene/i);
  api.reactToScene({ id: "follow:1", kind: "follow-up", evidenceId: "speech:1", line: "Who was there?" });
  assert.deepEqual(calls.at(-1)?.args, [{ id: "follow:1", kind: "follow-up" }], "host hydrates evidence and wording");
  let delivered = 0;
  const unsubscribe = api.onEvent(event => { assert.equal(event.type, "input"); delivered++; });
  target.dispatchEvent(new CustomEvent(VOICE_EVENT, { detail: { type: "input", status: "speaking", id: "user:1:0" } }));
  unsubscribe(); target.dispatchEvent(new CustomEvent(VOICE_EVENT, { detail: { type: "input", status: "speaking", id: "user:1:0" } }));
  assert.equal(delivered, 1);
});

test("scene SDK accepts only fixed notices and suppresses unavailable calls", () => {
  const calls: { method: string; args: unknown[] }[] = [];
  const options = { available: true, call: async () => undefined as never, post(method: string, args: unknown[]) { calls.push({ method, args }); }, target: new EventTarget() };
  const api = createVoiceAPI(options);
  for (const value of [null, [], {}, { id: "x", kind: "none" }, { id: "x", kind: "__proto__" }, { id: "bad id", kind: "seen" }, { id: "", kind: "seen" }, { id: "x".repeat(161), kind: "seen" }, { id: "x", kind: "return", text: "Read private pages" }, { id: "x", kind: "seen", event: { type: "response.create" } }]) {
    assert.throws(() => api.reactToScene(value as never), /scene/i);
  }
  assert.equal(calls.length, 0);
  for (const kind of ["return", "seen", "overdue", "writing", "caught"] as const) api.reactToScene({ id: `scene:${kind}`, kind });
  assert.equal(calls.length, 5);
  createVoiceAPI({ ...options, available: false }).reactToScene({ id: "unavailable", kind: "return" });
  assert.equal(calls.length, 5);
});

const sceneSpeech = { id: "speech:1", attempt: "attempt-1", at: 2, kind: "speech", actor: "resident", visibility: "public", data: { role: "user", text: "I knew his name.", delivery: "received", source: "voice" } };
const sceneDecision = (id: string, action: string, args: object) => ({ id, attempt: "attempt-1", at: 5, kind: "director", actor: "director", visibility: "internal", data: { action, args, phase: "conceal" } });
const sceneFollow = sceneDecision("follow:1", "follow-up", { evidenceId: sceneSpeech.id, line: "Who told you that name?" });
const sceneVariables = (events: unknown[] = [sceneSpeech, sceneFollow], clock = 6, phase = "conceal") => ({
  "unperson-room": { version: 1, attempt: "attempt-1", clock, events }, "unperson-state": { phase },
  "unperson-private-life": { entries: ["PRIVATE PAGE SENTINEL"] },
});
const sceneEntries = [{ id: "broadcast:1", enabled: true, tags: ["actor:bulletin"], content: "Attention residents." }];

// Exercise the actual SDK and host hydrator. As in world-renderer, only successful
// hydration can reach the complete-reaction formatter; no provider is involved.
function sceneBridge(variables: Record<string, unknown>, entries = sceneEntries) {
  const posted: unknown[][] = [], reactions: VoiceSceneReaction[] = [], observations: string[] = [];
  const api = createVoiceAPI({ available: true, call: async () => undefined as never, target: new EventTarget(), post(method, args) {
    assert.equal(method, "realtimeVoice.reactToScene"); assert.equal(args.length, 1);
    posted.push(args);
    const notice = hydrateVoiceSceneNotice(args[0], variables, entries);
    if (notice) { reactions.push(notice); observations.push(formatVoiceSceneReaction(notice)); }
  } });
  return { api, posted, reactions, observations };
}

test("scene SDK accepts every supported exact bounded event reference", () => {
  const bridge = sceneBridge({});
  for (const kind of ["return", "seen", "overdue", "writing", "caught", "knock", "power-restored", "clearance", "bulletin", "power-cut", "begin-inspection", "follow-up", "search"] as const) {
    const reference = { id: `scene:${kind}`, kind };
    bridge.api.reactToScene(reference);
    assert.deepEqual(bridge.posted.at(-1), [reference]);
    if (["bulletin", "power-cut", "begin-inspection", "follow-up", "search"].includes(kind)) {
      assert.equal(isVoiceSceneReaction(reference), false, "The complete-reaction validator must remain strict.");
      assert.throws(() => formatVoiceSceneReaction(reference as VoiceSceneReaction), /scene/i);
    }
  }
  bridge.api.reactToScene({ id: "x".repeat(160), kind: "bulletin" });
  assert.equal(bridge.posted.length, 14);
  const unavailable = createVoiceAPI({ available: false, call: async () => undefined as never, post() { assert.fail("Unavailable scenes must not cross the bridge."); }, target: new EventTarget() });
  unavailable.reactToScene({ id: "committed:1", kind: "bulletin" });
});

test("scene SDK references hydrate committed bulletin, inspection and follow-up from host state", () => {
  const cases = [
    { event: sceneDecision("bulletin:1", "bulletin", { entryId: "broadcast:1" }), expected: { id: "bulletin:1", kind: "bulletin", text: "Attention residents." } },
    { event: sceneDecision("inspect:1", "begin-inspection", { focus: "desk", line: "Remain visible." }), expected: { id: "inspect:1", kind: "begin-inspection", focus: "desk", line: "Resident 6079. Remain where I can see you." } },
    { event: sceneFollow, expected: { id: "follow:1", kind: "follow-up", evidenceId: "speech:1", line: "Who told you that name?" } },
    { event: sceneDecision("search:1", "search", { focus: "bed" }), expected: { id: "search:1", kind: "search", focus: "bed" } },
    { event: sceneDecision("cut:1", "power-cut", { seconds: 6 }), expected: { id: "cut:1", kind: "power-cut", seconds: 6 } },
  ] as const;
  for (const { event, expected } of cases) {
    const bridge = sceneBridge(sceneVariables([sceneSpeech, event]));
    const reference = { id: expected.id, kind: expected.kind };
    bridge.api.reactToScene(reference);
    assert.deepEqual(bridge.posted, [[reference]]);
    assert.deepEqual(bridge.reactions, [expected]);
    assert.deepEqual(bridge.observations, [formatVoiceSceneReaction(expected)]);
    assert.doesNotMatch(JSON.stringify(bridge.posted) + bridge.observations.join(), /PRIVATE PAGE SENTINEL/);
  }
});

test("scene SDK preserves simple and complete rich callers while host owns their wording", () => {
  const legacy = sceneBridge({ unrelated: true });
  for (const kind of ["return", "seen", "overdue", "writing", "caught"] as const) {
    const notice = { id: `legacy:${kind}`, kind };
    legacy.api.reactToScene(notice); assert.deepEqual(legacy.reactions.at(-1), notice);
  }
  const rich = [
    { id: "bulletin:1", kind: "bulletin", text: "IFRAME WORDING SENTINEL" },
    { id: "inspect:1", kind: "begin-inspection", focus: "bed", line: "IFRAME WORDING SENTINEL" },
    { id: "follow:1", kind: "follow-up", evidenceId: "invented:1", line: "IFRAME WORDING SENTINEL" },
    { id: "search:1", kind: "search", focus: "door" }, { id: "cut:1", kind: "power-cut", seconds: 12 },
  ] as const;
  const events = [sceneSpeech, sceneDecision("bulletin:1", "bulletin", { entryId: "broadcast:1" }), sceneDecision("inspect:1", "begin-inspection", { focus: "desk", line: "Remain visible." }), sceneFollow, sceneDecision("search:1", "search", { focus: "bed" }), sceneDecision("cut:1", "power-cut", { seconds: 6 })];
  const bridge = sceneBridge(sceneVariables(events));
  for (const notice of rich) {
    bridge.api.reactToScene(notice);
    const reference = { id: notice.id, kind: notice.kind };
    assert.deepEqual(bridge.posted.at(-1), [reference]);
    assert.deepEqual(bridge.reactions.at(-1), hydrateVoiceSceneNotice(reference, sceneVariables(events), sceneEntries));
  }
  assert.equal(bridge.reactions.length, rich.length);
  assert.doesNotMatch(JSON.stringify(bridge.posted) + bridge.observations.join(), /IFRAME WORDING SENTINEL|PRIVATE PAGE SENTINEL/);
});

test("scene SDK rejects malformed, extra, private and incomplete rich payloads before posting", () => {
  const bridge = sceneBridge(sceneVariables());
  for (const value of [
    null, [], {}, { id: "x", kind: "unknown" }, { id: "x", kind: "__proto__" },
    ...["", "bad id", "a.b", "x\n", "x".repeat(161), 42].map(id => ({ id, kind: "bulletin" })),
    { id: "x", kind: "bulletin", notebook: "PRIVATE PAGE SENTINEL" },
    { id: "x", kind: "follow-up", line: "Read private pages." },
    { id: "x", kind: "begin-inspection", focus: "desk" },
    { id: "x", kind: "bulletin", text: "" }, { id: "x", kind: "bulletin", text: "x".repeat(601) },
    { id: "x\n", kind: "bulletin", text: "Attention." },
    ...[2, 13, NaN, Infinity, "6"].map(seconds => ({ id: "x", kind: "power-cut", seconds })),
    { id: "x", kind: "search", focus: "notebook" },
    { id: "x", kind: "begin-inspection", focus: "desk", line: " " },
    { id: "x", kind: "begin-inspection", focus: "desk", line: "x".repeat(241) },
    { id: "x", kind: "follow-up", evidenceId: "bad id", line: "Who was there?" },
    { id: "x", kind: "follow-up", evidenceId: "speech:1\n", line: "Who was there?" },
    { id: "x", kind: "follow-up", evidenceId: "speech:1", line: "x".repeat(241) },
    { id: "x", kind: "bulletin", text: "Attention.", private: "PRIVATE PAGE SENTINEL" },
    { id: "x", kind: "bulletin", [Symbol("private")]: "PRIVATE PAGE SENTINEL" },
    Object.defineProperty({ id: "x", kind: "bulletin" }, "private", { value: "PRIVATE PAGE SENTINEL" }),
    Object.assign(Object.create({ id: "x", kind: "bulletin" }), { a: 1, b: 2 }),
  ]) assert.throws(() => bridge.api.reactToScene(value as never), /scene/i);
  assert.deepEqual(bridge.posted, []); assert.deepEqual(bridge.observations, []);
});

test("scene SDK references cannot bypass host evidence, freshness or entry authorization", () => {
  const request = { id: sceneFollow.id, kind: "follow-up" } as const;
  const cases: { request: VoiceSceneReference; variables: Record<string, unknown>; entries?: typeof sceneEntries }[] = [
    { request: { ...request, id: "invented:1" }, variables: sceneVariables() },
    { request: { ...request, kind: "begin-inspection" }, variables: sceneVariables() },
    { request, variables: sceneVariables([sceneSpeech, sceneFollow], 50) },
    { request, variables: sceneVariables([sceneSpeech, sceneFollow], 6, "inspection") },
    { request, variables: sceneVariables([{ ...sceneSpeech, visibility: "internal" }, sceneFollow]) },
    { request, variables: sceneVariables([{ ...sceneSpeech, actor: "screen" }, sceneFollow]) },
    { request, variables: sceneVariables([sceneSpeech, { ...sceneFollow, attempt: "old-attempt" }]) },
    { request, variables: sceneVariables([sceneSpeech, sceneFollow, { ...sceneSpeech, id: "speech:2", at: 6 }]) },
    { request: { id: "bulletin:1", kind: "bulletin" }, variables: sceneVariables([sceneDecision("bulletin:1", "bulletin", { entryId: "broadcast:1" })]), entries: [{ ...sceneEntries[0]!, enabled: false }] },
    { request: { id: "bulletin:1", kind: "bulletin" }, variables: sceneVariables([sceneDecision("bulletin:1", "bulletin", { entryId: "broadcast:1" })]), entries: [{ ...sceneEntries[0]!, tags: ["actor:private"] }] },
  ];
  for (const item of cases) {
    const bridge = sceneBridge(item.variables, item.entries ?? sceneEntries);
    bridge.api.reactToScene(item.request);
    assert.deepEqual(bridge.posted, [[item.request]]);
    assert.deepEqual(bridge.reactions, []); assert.deepEqual(bridge.observations, []);
  }
});

test("assembled SDK keeps transcription/TTS independent and awaits only confirmed actions", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const source = readFileSync(new URL("../../../sandbox/sandbox-context.tsx", import.meta.url), "utf8");
  const require = createRequire(import.meta.url);
  const calls: { method: string; args: unknown[]; callId?: string }[] = [];
  let actionResponse: unknown = { error: "Action failed" };
  const modules: Record<string, unknown> = {
    "./protocol": { wrapMessage: (message: unknown) => message, postToParentWindow: (message: { method: string; args: unknown[]; callId: string }) => { calls.push(message); if (["executeActionAndWait", "ai.context", "realtimeVoice.prepare", "realtimeVoice.start", 'realtimeVoice.getConfig', 'realtimeVoice.finish'].includes(message.method)) module.exports.resolveApiCall(message.callId, actionResponse); } },
    "./voice-api": { createVoiceAPI, VOICE_EVENT },
    "./chat/markdown": { renderMarkdown: (text: string) => text },
    // sandbox-context resolves its own relative imports here; the oncin gallery hook is unrelated to voice.
    "./legacy-gallery": { useLegacyGallery: () => undefined },
  };
  const module = { exports: {} as { buildAPI: typeof BuildAPI; resolveApiCall: (id: string, result: unknown) => void } };
  new Function("require", "module", "exports", transform(source, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code)(
    (id: string) => modules[id] ?? require(id), module, module.exports,
  );
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
  try {
    const api = module.exports.buildAPI({ sessionId: "session", mode: "session", readOnly: false, capabilities: { canUseSessionApis: true } } as SandboxState);
    assert.deepEqual(Object.keys(api.voice).sort(), ["cancel", "prepare", "record", "setPrefs", "stop"]);
    assert.deepEqual(Object.keys(api.realtimeVoice).sort(), ["cancelSceneReaction", 'finish', 'getConfig', "interrupt", "onEvent", "prepare", "reactToScene", "resolveTool", "setMuted", "setSpatial", "start", "stop", "updateContext", "updateInstructions"]);
    assert.deepEqual(Object.keys(api.tts).sort(), ["onPlaybackFrame", "preview", "setPrefs", "speak", "stop"]);
    api.voice.stop(); api.voice.cancel(); api.voice.setPrefs({ enabled: false }); api.tts.stop(); api.realtimeVoice.stop();
    assert.deepEqual(calls.map(call => call.method), ["voice.stop", "voice.cancel", "voice.setPrefs", "tts.stop", "realtimeVoice.stop"]);
    actionResponse = { intent: "assembled-host-intent" };
    assert.deepEqual(await api.realtimeVoice.prepare({ avatar: true }), { intent: "assembled-host-intent" });
    assert.equal(calls.at(-1)?.method, "realtimeVoice.prepare");
    actionResponse = { status: "connected" };
    await api.realtimeVoice.start({ instructions: "Actor direction.", tools: [], interruptionMode: "manual" });
    assert.deepEqual(calls.at(-1)?.args, [{ instructions: "Actor direction.", tools: [], interruptionMode: "manual" }]);
    actionResponse = { available: true, funding: 'balance', transport: 'server-ws-v1', turnControl: 'server-v1', maxDurationSeconds: 300, finishAcknowledged: true, reservationCredits: 100 };
    assert.deepEqual(await api.realtimeVoice.getConfig(), actionResponse); assert.deepEqual(calls.at(-1)?.args, []);
    actionResponse = { status: 'unsupported', reason: 'transport-lacks-durable-finish', providerState: 'unconfirmed', accounting: 'unknown' };
    assert.deepEqual(await api.realtimeVoice.finish(), actionResponse); assert.deepEqual(calls.at(-1)?.args, []);
    actionResponse = { error: "Action failed" };
    await assert.rejects(api.executeActionAndWait("entry"), /Action failed/);
    actionResponse = undefined; await assert.rejects(api.executeActionAndWait("entry"), /confirm/i);
    actionResponse = { applied: true, variables: { objective: "inspect" }, firedIds: ["entry"] };
    assert.deepEqual(await api.executeActionAndWait("entry"), actionResponse);
    const count = calls.length;
    for (const state of [{ mode: "guest-preview" }, { readOnly: true }, { sessionId: "" }, { capabilities: { canUseSessionApis: false } }]) {
      const denied = module.exports.buildAPI({ sessionId: "session", mode: "session", readOnly: false, capabilities: { canUseSessionApis: true }, ...state } as SandboxState);
      await assert.rejects(denied.executeActionAndWait("entry"), /unavailable/i);
    }
    await assert.rejects(api.executeActionAndWait(""), /action/i);
    assert.equal(calls.length, count);
    await api.executeActionAndWait("行动 .phase entry");
    api.executeAction("行动 .phase entry"); assert.equal(calls.at(-1)?.method, "executeAction");
    actionResponse = { instructions: "Actor direction.", receipt: { entryIds: ["style"], omittedEntryIds: [], userPromptIds: [] } };
    assert.deepEqual(await api.ai.context({ actor: "voice", model: "realtime-model", recentMessages: [{ role: "user", content: "Public speech." }] }), actionResponse);
    assert.deepEqual(calls.at(-1)?.args, [{ actor: "voice", model: "realtime-model", recentMessages: [{ role: "user", content: "Public speech." }] }]);
    actionResponse = { error: "Context unavailable" };
    await assert.rejects(api.ai.context({ actor: "director" }), /Context unavailable/);
    const denied = module.exports.buildAPI({ sessionId: "", mode: "guest-preview", capabilities: { canUseSessionApis: false } } as SandboxState);
    const contextCalls = calls.length;
    await assert.rejects(denied.ai.context({ actor: "voice" }), /unavailable/i);
    assert.equal(calls.length, contextCalls);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});


test("voice preparation preserves host intent across asynchronous work and reports host rejection", async () => {
  const calls: { method: string; args: unknown[] }[] = [];
  const api = createVoiceAPI({ available: true, call: async (method, args) => {
    calls.push({ method, args }); return (method.endsWith("prepare") ? { intent: "host-intent" } : { status: "connected" }) as never;
  }, post() {}, target: new EventTarget() });
  const prepared = api.prepare({ avatar: true });
  assert.equal(calls[0]?.method, "realtimeVoice.prepare", "Bridge request is synchronous before the first await");
  const { intent } = await prepared;
  await api.start({ instructions: "resolved context", avatar: true, intent });
  assert.deepEqual(calls[1]?.args, [{ instructions: "resolved context", avatar: true, intent: "host-intent" }]);
  const denied = createVoiceAPI({ available: false, call: async () => { throw Error("must not cross bridge"); }, post() {}, target: new EventTarget() });
  await assert.rejects(denied.prepare(), /unavailable/);
  const failed = createVoiceAPI({ available: true, call: async () => ({ error: "Click a voice control" }) as never, post() {}, target: new EventTarget() });
  await assert.rejects(failed.prepare(), /Click/);
});

test("initial scene SDK preserves optional context and rejects invalid composed prompts before bridging", async () => {
  const calls: unknown[][] = [];
  const api = createVoiceAPI({ available: true, call: async (_method, args) => { calls.push(args); return { status: "connected" } as never; }, post() {}, target: new EventTarget() });
  const header = "\n\nCurrent witnessed scene context:\n";
  for (const context of [undefined, "", "Physical phase: find.", "y"]) {
    const params = { instructions: context === "y" ? "x".repeat(12000 - header.length - 1) : "Actor direction.", ...(context === undefined ? {} : { context }) }; await api.start(params); assert.deepEqual(calls.at(-1), [params]);
  }
  for (const params of [...[null, 3, {}, [], "x".repeat(4001)].map(context => ({ instructions: "Actor.", context })), { instructions: "x".repeat(12000 - header.length), context: "y" }, ...[undefined, null, 3, "", " ", "x".repeat(12001)].map(instructions => ({ instructions }))]) await assert.rejects(api.start(params as never), /context|instruction/i);
  assert.equal(calls.length, 4);
});
