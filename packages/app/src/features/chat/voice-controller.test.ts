import test from "node:test";
import assert from "node:assert/strict";
import { AvatarUtterances } from "./avatar-voice-audio-state";
import { VoiceController, dispatchVoiceCall, type VoiceDependencies } from "./voice-controller";
import type { VoiceEvent } from "../../../sandbox/voice-types";
import { isVoiceSceneReaction, formatVoiceSceneReaction } from "../../../sandbox/voice-types";
import { hydrateVoiceSceneNotice } from "./voice-scene-notice";

test("private pilot funding uses native capture and owned stop just like sponsored testing", async () => {
  const f = fixture(), fetch = f.deps.fetch; let stops = 0;
  f.deps.fetch = async (url, options) => {
    if (String(url).endsWith("/config")) return new Response(JSON.stringify({ available: true, funding: "private-pilot", maxDurationSeconds: 300, turnControl: "client-v1" }));
    if (String(url).endsWith("/stop")) stops++;
    return fetch(url, options);
  };
  await f.connect();
  assert.equal(f.calls.media, 1);
  f.controller.stop(); await tick(); assert.equal(stops, 1);
});
test("private-pilot provider failures and budget exhaustion never ask the user for a personal key", async () => {
  for (const code of ["VOICE_DAILY_LIMIT", "OPENAI_KEY_REJECTED", "VOICE_UNAVAILABLE", "VOICE_CONNECTION_PENDING"]) {
    const f = fixture(), fetch = f.deps.fetch;
    f.deps.fetch = async (url, options) => {
      if (String(url).endsWith("/config")) return new Response(JSON.stringify({ available: true, funding: "private-pilot", maxDurationSeconds: 300, turnControl: "client-v1" }));
      if (String(url).endsWith("/connect")) return new Response(JSON.stringify({ code }), { status: 503 });
      return fetch(url, options);
    };
    await assert.rejects(f.controller.start({ instructions: "hello", avatar: false, tools: [] }), error => {
      assert.doesNotMatch(String(error), /your.*key|add.*key/i); assert.match(String(error), /text/i);
      if (code === "VOICE_CONNECTION_PENDING") { assert.match(String(error), /still closing/i); assert.doesNotMatch(String(error), /stop it/i); }
      return true;
    });
    f.controller.stop();
  }
});

function pilotFixture(stop: () => Promise<Response>) {
  const f = fixture(), fetch = f.deps.fetch;
  f.deps.fetch = (url, options) => {
    if (String(url).endsWith("/config")) return Promise.resolve(Response.json({ available: true, funding: "private-pilot", maxDurationSeconds: 300, turnControl: "client-v1" }));
    if (String(url).endsWith("/stop")) return stop();
    return fetch(url, options);
  };
  return f;
}

test("private pilot stops capture/playback and fences events before stop POST, retaining its inert transport until settlement", async () => {
  const stopped = deferred<Response>(); let requests = 0;
  const f = pilotFixture(() => {
    requests++; assert.equal(f.track.enabled, false); assert.equal(f.track.stops, 1); assert.equal(f.audio.closed, 1);
    assert.equal(f.channel.readyState, "open"); assert.equal(f.peer.closed, 0);
    assert.equal(f.channel.onmessage, null); assert.equal(f.peer.ontrack, null);
    return stopped.promise;
  });
  await f.connect();
  const receive = f.channel.onmessage!, track = f.peer.ontrack!;
  f.controller.stop();
  assert.equal(requests, 1); assert.equal(f.peer.closed, 0); assert.equal(f.channel.readyState, "open");
  assert.ok(f.events.some(e => e.type === "status" && e.status === "stopped"));
  const eventCount = f.events.length, sends = f.channel.sent.length, attachments = f.audio.attached;
  receive({ data: JSON.stringify({ type: "response.output_audio_transcript.done", item_id: "late", transcript: "Late words" }) });
  track({ streams: [f.stream] }); f.level(1); f.controller.updateContext("Late context");
  assert.equal(f.events.length, eventCount); assert.equal(f.channel.sent.length, sends); assert.equal(f.audio.attached, attachments);
  f.controller.stop(); assert.equal(requests, 1);
  stopped.resolve(new Response(null, { status: 503 })); await tick();
  assert.equal(f.peer.closed, 1); assert.equal(f.channel.readyState, "closed");
  assert.equal(f.track.stops, 1); assert.equal(f.audio.closed, 1);
});

test("private pilot closes an unsettled stop at its bounded deadline and ignores late settlement", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stopped = deferred<Response>(), f = pilotFixture(() => stopped.promise);
  await f.connect(); f.controller.stop();
  t.mock.timers.tick(13_999); assert.equal(f.peer.closed, 0); assert.equal(f.track.stops, 1); assert.equal(f.audio.closed, 1);
  t.mock.timers.tick(1); assert.equal(f.peer.closed, 1); assert.equal(f.channel.readyState, "closed");
  stopped.resolve(new Response(null, { status: 200 })); await tick(); assert.equal(f.peer.closed, 1);
});

test("private pilot old settlement and deadline cannot affect a replacement call", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const first of ["settlement", "deadline"]) {
    const stopped = deferred<Response>(), f = pilotFixture(() => stopped.promise), replacement = fixture();
    await f.connect(); f.controller.stop(); assert.equal(f.peer.closed, 0);
    f.deps.createPeer = () => replacement.peer as unknown as RTCPeerConnection;
    f.deps.getUserMedia = async () => replacement.stream;
    f.deps.createAudio = () => replacement.audio;
    const starting = f.controller.start({ instructions: "Replacement" }); await tick(); replacement.channel.open(); await starting;
    const events = f.events.length;
    if (first === "settlement") { stopped.resolve(new Response(null, { status: 200 })); await tick(); }
    t.mock.timers.tick(14_000);
    if (first === "deadline") { stopped.resolve(new Response(null, { status: 200 })); await tick(); }
    assert.equal(f.peer.closed, 1); assert.equal(replacement.peer.closed, 0); assert.equal(replacement.channel.readyState, "open");
    assert.equal(replacement.track.stops, 0); assert.equal(replacement.audio.closed, 0); assert.equal(f.events.length, events);
    f.controller.stop(); await tick(); assert.equal(replacement.peer.closed, 1);
  }
});

test("private pilot rejected and synchronously failed stop requests still close local resources", async () => {
  for (const stop of [() => Promise.reject(Error("network")), () => { throw Error("fetch failed"); }]) {
    const f = pilotFixture(stop); await f.connect();
    assert.doesNotThrow(() => f.controller.stop()); await tick();
    assert.equal(f.peer.closed, 1); assert.equal(f.channel.readyState, "closed");
    assert.equal(f.track.stops, 1); assert.equal(f.audio.closed, 1);
  }
});

test("BYOK and testing still close transport immediately regardless of a pending stop request", async () => {
  for (const funding of ["byok", "testing"]) {
    const f = fixture(), fetch = f.deps.fetch;
    f.deps.fetch = (url, options) => String(url).endsWith("/config")
      ? Promise.resolve(Response.json({ available: true, funding, maxDurationSeconds: 300, turnControl: "client-v1" }))
      : String(url).endsWith("/stop") ? new Promise(() => {}) : fetch(url, options);
    await f.connect(); f.controller.stop(); assert.equal(f.peer.closed, 1); assert.equal(f.channel.readyState, "closed");
  }
});

test("an obsolete police-only queue retires quietly when the existing reply ends", async () => {
  const f = fixture(); await f.connect();
  const event = (id: string, at: number, kind: string, actor: string, data: object) => ({ id, attempt: "a", at, kind, actor, visibility: kind === "director" ? "internal" : "public", data });
  const order = (action: string, at: number) => event(action, at, "director", "director", { action, args: action === "release-resident" ? {} : { evidenceId: "e" }, phase: "inspection", edition: "ai", nextDelay: 8, reason: "Public record." });
  let events = [event("e", 0, "observation", "screen", { code: "writing" }), order("dispatch-police", 0), event("entry", 8, "police", "police", { code: "entering" }), event("search", 11, "police", "police", { code: "searching" })];
  const variables = () => ({ "unperson-room": { version: 1, attempt: "a", clock: 15, events }, "unperson-state": { phase: "inspection", calm: false } });
  try {
    f.controller.reactToScene(hydrateVoiceSceneNotice({ id: "search", kind: "bulletin" }, variables(), [], "48.0.0", variables));
    events = [...events, order("release-resident", 15)];
    f.channel.event({ type: "response.done" });
    assert.equal(f.channel.sent.filter(e => e.type === "response.create").length, 1, "A stale police notice cannot launch a new turn.");
    assert.equal(f.channel.sent.some(e => e.type === "response.cancel" || e.type === "output_audio_buffer.clear"), false);
  } finally { f.controller.stop(); }
});

test("trusted police notices coalesce behind active speech and expire on muted release without cancelling that reply", async () => {
  const f = fixture(); await f.connect();
  const evidence = { id: "physical", attempt: "a", at: 0, kind: "observation", actor: "screen", visibility: "public", data: { code: "writing" } };
  const order = (action: string, at: number) => ({ id: action, attempt: "a", at, kind: "director", actor: "director", visibility: "internal", data: { action, args: action === "release-resident" ? {} : { evidenceId: "physical" }, phase: "inspection", edition: "ai", nextDelay: 8, reason: "Public record." } });
  const stage = (code: string, at: number) => ({ id: code, attempt: "a", at, kind: "police", actor: "police", visibility: "public", data: { code } });
  let events: unknown[] = [evidence, order("dispatch-police", 0), stage("entering", 8), stage("searching", 11)];
  let clock = 11;
  const variables = () => ({ "unperson-room": { version: 1, attempt: "a", clock, events }, "unperson-state": { phase: "inspection", calm: false } });
  const notice = (id: string) => { const value = hydrateVoiceSceneNotice({ id, kind: "bulletin" }, variables(), [], "48.0.0", variables); assert.ok(value); return value; };
  try {
    f.controller.reactToScene(notice("searching"));
    const oldItem = f.channel.sent.find(e => e.type === "conversation.item.create")!.item.id;
    f.controller.reactToScene({ id: "ordinary", kind: "bulletin", text: "An unrelated public bulletin." });
    const ordinaryItem = f.channel.sent.filter(e => e.type === "conversation.item.create").at(-1)!.item.id;
    events = [...events, stage("desk-checked", 21)]; clock = 21;
    f.controller.updateContext("Current physical progress: desk-checked.");
    f.controller.reactToScene(notice("desk-checked"));
    assert.ok(f.channel.sent.some(e => e.type === "conversation.item.delete" && e.item_id === oldItem));
    assert.equal(f.channel.sent.some(e => e.type === "conversation.item.delete" && e.item_id === ordinaryItem), false);
    assert.equal(f.channel.sent.some(e => e.type === "response.cancel" || e.type === "output_audio_buffer.clear"), false);
    assert.equal(f.channel.sent.filter(e => e.type === "response.create").length, 1, "Milestones wait behind the ongoing ordinary reply.");
    f.channel.event({ type: "response.done" });
    assert.equal(f.channel.sent.filter(e => e.type === "response.create").length, 2, "The current milestone gets one turn after existing speech retires.");
    events = [...events, stage("bed-checked", 31)]; clock = 31;
    f.controller.updateContext("Current physical progress: bed-checked.");
    f.controller.reactToScene(notice("bed-checked"));
    assert.equal(f.channel.sent.some(e => e.type === "response.cancel" || e.type === "output_audio_buffer.clear"), false, "Advancing during an active police reply also preserves its audio.");
    const bedItem = f.channel.sent.filter(e => e.type === "conversation.item.create").at(-1)!.item.id;
    f.controller.setMuted({ input: false, output: true });
    const cancelledByMute = f.channel.sent.filter(e => e.type === "response.cancel").length;
    events = [...events, order("release-resident", 32)]; clock = 32;
    f.controller.setMuted({ input: false, output: false });
    assert.ok(f.channel.sent.some(e => e.type === "conversation.item.delete" && e.item_id === bedItem));
    assert.equal(f.channel.sent.filter(e => e.type === "response.cancel").length, cancelledByMute);
    assert.equal(hydrateVoiceSceneNotice({ id: "searching", kind: "bulletin" }, variables()), null);
  } finally { f.controller.stop(); }
});

const publicNotices = [
  { id: "knock", kind: "knock" }, { id: "bulletin", kind: "bulletin", text: "Attention residents." },
  { id: "cut", kind: "power-cut", seconds: 8 }, { id: "restored", kind: "power-restored" },
  { id: "inspect", kind: "begin-inspection", focus: "desk", line: "Remain visible." },
  { id: "search", kind: "search", focus: "bed" }, { id: "clear", kind: "clearance" },
] as const;

test("public scene notices validate strict bounded payloads and share scene observation text", async () => {
  const f = fixture(); await f.connect(); f.channel.event({ type: "response.done" });
  try {
    for (const notice of publicNotices) {
      assert.equal(isVoiceSceneReaction(notice), true);
      f.controller.reactToScene(notice);
      const text = f.channel.sent.at(-2)?.item.content[0].text;
      assert.equal(text, formatVoiceSceneReaction(notice));
      assert.match(text, /already committed|already happened/i);
      assert.match(text, /scene observation/i);
      assert.match(text, /not player speech/i);
      f.channel.event({ type: "response.done" });
    }
    for (const value of [
      ...publicNotices.map(n => ({ ...n, notebook: "private" })),
      { id: "x", kind: "bulletin", text: "" }, { id: "x", kind: "bulletin", text: "x".repeat(601) },
      { id: "x", kind: "power-cut", seconds: 2 }, { id: "x", kind: "power-cut", seconds: 13 },
      { id: "x", kind: "power-cut", seconds: NaN }, { id: "x", kind: "search", focus: "notebook" },
      { id: "x", kind: "begin-inspection", focus: "desk", line: " " },
      { id: "x", kind: "begin-inspection", focus: "desk", line: "x".repeat(241) },
    ]) assert.equal(isVoiceSceneReaction(value), false);
    assert.match(formatVoiceSceneReaction(publicNotices[1]), /Attention residents/);
    assert.match(formatVoiceSceneReaction(publicNotices[2]), /cannot see.*8|8.*cannot see/i);
  } finally { f.controller.stop(); }
});

test("audio unlock is awaited before capture and failure reaches error with cleanup", async () => {
  let ready!: () => void;
  const unlocked = new Promise<void>(resolve => { ready = resolve; });
  const f = fixture(); f.deps.createAudio = () => ({ ...f.audio, ready: () => unlocked });
  const pending = f.controller.start({ instructions: "hello" }); await tick();
  assert.equal(f.calls.media, 0); assert.equal(f.calls.peer, 0);
  ready(); await tick(); f.channel.open(); await pending; f.controller.stop();
  const g = fixture(); g.deps.createAudio = () => ({ ...g.audio, close: () => { g.audio.closed++; }, ready: async () => { throw Error("blocked"); } });
  await assert.rejects(g.controller.start({ instructions: "hello" }), /audio|speaker/i);
  assert.equal(g.calls.media, 0); assert.equal(g.audio.closed, 1);
  assert.ok(g.events.some(e => e.type === "status" && e.status === "error" && /again/i.test(e.message ?? "")));
});

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("voice controller forwards its initial tool allowlist before any generation", async () => {
  for (const tools of [undefined, [], ["request_inspection_focus"]]) {
    const f = fixture(); const fetch = f.deps.fetch; let request: Record<string, unknown> | undefined;
    f.deps.fetch = async (url, init) => {
      if (String(url).endsWith("/connect")) {
        assert.equal(f.channel.sent.some(event => event.type === "response.create"), false);
        request = JSON.parse(String(init?.body));
      }
      return fetch(url, init);
    };
    try {
      const pending = f.controller.start({ instructions: "hello", ...(tools === undefined ? {} : { tools }) });
      await tick(); f.channel.open(); await pending;
      assert.ok(request); assert.equal(request.turnControl, "client-v1"); assert.deepEqual(request.tools, tools);
      assert.equal(Object.hasOwn(request, "tools"), tools !== undefined);
      f.channel.event({ type: "response.function_call_arguments.done", call_id: "legacy", name: "request_inspection_focus", arguments: '{"focus":"desk","reason":"Look"}' });
      assert.equal(f.events.some(event => event.type === "tool"), tools?.length !== 0, "Default and explicit legacy tool handling remain available");
    } finally { f.controller.stop(); }
  }
});

test("voice controller rejects malformed tool allowlists before consent or network", async () => {
  for (const tools of [null, "request_inspection_focus", {}, [null], ["executeCode"], ["request_inspection_focus", "request_inspection_focus"], Array(100).fill("request_inspection_focus"), [{ name: "request_inspection_focus" }]]) {
    const f = fixture();
    try {
      // Opening the fixture channel lets the pre-fix implementation settle without a timeout.
      const started = f.controller.start({ instructions: "hello", tools });
      const rejected = assert.rejects(started, /tool/i);
      await tick(); f.channel.open(); await rejected;
      assert.equal(f.calls.fetch, 0); assert.equal(f.calls.consent, 0); assert.equal(f.calls.media, 0);
    } finally { f.controller.stop(); }
  }
});

test("disabled tools cannot dispatch forged or late provider calls to the room", async () => {
  const f = fixture();
  const call = { type: "response.function_call_arguments.done", call_id: "forged", name: "request_inspection_focus", arguments: '{"focus":"desk","reason":"Look"}' };
  try {
    const pending = f.controller.start({ instructions: "hello", tools: [] });
    await tick(); f.channel.open(); await pending;
    f.channel.event(call);
    assert.equal(f.events.some(event => event.type === "tool"), false);
    f.controller.stop(); f.channel.event({ ...call, call_id: "late" });
    assert.equal(f.events.some(event => event.type === "tool"), false);
  } finally { f.controller.stop(); }
});
test("a delayed bulletin retires its scene command only after response and playback finish", async () => {
  const f = fixture(); await f.connect();
  try {
    f.channel.event({ type: "output_audio_buffer.started" });
    f.controller.reactToScene({ id: "permission:1", kind: "bulletin", text: "Permission granted. Put the room in order, then return to your place." });
    const command = f.channel.sent.find(event => event.type === "conversation.item.create")!.item;
    f.controller.cancelSceneReaction();
    assert.equal(f.channel.sent.some(event => event.type === "conversation.item.delete"), false, "No-id cancellation retains a queued bulletin.");
    assert.equal(f.channel.sent.filter(event => event.type === "response.create").length, 1, "Wait for the earlier response before requesting the bulletin.");
    f.channel.event({ type: "response.done" });
    f.channel.event({ type: "output_audio_buffer.stopped" });
    assert.equal(f.channel.sent.filter(event => event.type === "response.create").length, 2);
    f.channel.event({ type: "output_audio_buffer.started" });
    f.channel.event({ type: "response.output_audio_transcript.done", item_id: "spoken:permission", content_index: 0, transcript: "Permission granted. Return to your place when ready." });
    f.channel.event({ type: "response.done" });
    assert.equal(f.channel.sent.some(event => event.type === "conversation.item.delete"), false, "Generation completion does not end playback.");
    f.channel.event({ type: "output_audio_buffer.stopped" });
    assert.ok(f.channel.sent.some(event => event.type === "conversation.item.delete" && event.item_id === command.id), "Completed broadcast instructions cannot stay as standing commands.");
    assert.ok(!f.channel.sent.some(event => event.type === "conversation.item.delete" && event.item_id === "spoken:permission"));
    assert.ok(f.events.some(event => event.type === "transcript" && event.role === "assistant" && event.text.includes("Permission granted")), "Generated dialogue stays available for durable recording.");
    const count=f.channel.sent.filter(event => event.type === "conversation.item.create").length;
    f.controller.reactToScene({ id: "permission:1", kind: "bulletin", text: "Permission granted." });
    assert.equal(f.channel.sent.filter(event => event.type === "conversation.item.create").length,count,"Retirement does not permit replay.");
  } finally { f.controller.stop(); }
});
test("live instructions replace initial direction at a quiet turn boundary", async () => {
  const f = fixture(); await f.connect();
  try {
    f.controller.updateContext("The desk is visible.");
    const before = f.channel.sent.length;
    dispatchVoiceCall(f.controller, "realtimeVoice.updateInstructions", ["New character direction."]);
    dispatchVoiceCall(f.controller, "realtimeVoice.updateInstructions", ["Latest character direction."]);
    assert.equal(f.channel.sent.length, before, "defer while the initial response is active");
    f.channel.event({ type: "output_audio_buffer.started" });
    f.channel.event({ type: "response.done" });
    assert.equal(f.channel.sent.length, before, "generation completion is not playback completion");
    f.channel.event({ type: "output_audio_buffer.stopped" });
    const instructions = f.channel.sent.at(-1)?.session.instructions;
    assert.match(instructions, /Latest character direction/);
    assert.match(instructions, /desk is visible/);
    assert.doesNotMatch(instructions, /Ask what I saw|New character direction/);
    assert.equal(f.track.stops, 0); assert.equal(f.audio.closed, 0);
    assert.throws(() => dispatchVoiceCall(f.controller, "realtimeVoice.updateInstructions", ["x".repeat(12001)]), /instructions/i);
    assert.throws(() => dispatchVoiceCall(f.controller, "realtimeVoice.updateInstructions", [" "]), /instructions/i);
  } finally { f.controller.stop(); }
});

test("cancelled queued scene prompts are removed and never drain after the current turn", async () => {
  const f = fixture(); await f.connect();
  try {
    f.controller.reactToScene({ id: "old-phase", kind: "return" });
    const item = f.channel.sent.find(event => event.type === "conversation.item.create")!.item;
    dispatchVoiceCall(f.controller, "realtimeVoice.cancelSceneReaction", ["old-phase"]);
    assert.ok(f.channel.sent.some(event => event.type === "conversation.item.delete" && event.item_id === item.id));
    assert.equal(f.channel.sent.some(event => event.type === "response.cancel"), false, "ordinary response is preserved");
    f.channel.event({ type: "response.done" });
    assert.equal(f.channel.sent.filter(event => event.type === "response.create").length, 1);
    f.controller.reactToScene({ id: "old-phase", kind: "return" });
    assert.equal(f.channel.sent.filter(event => event.type === "conversation.item.create").length, 1, "cancelled id cannot replay");
  } finally { f.controller.stop(); }
});

test("new speech invalidates a queued evidence follow-up without discarding the microphone", async () => {
  const f = fixture(); await f.connect();
  try {
    f.controller.reactToScene({ id: "follow:1", kind: "follow-up", evidenceId: "speech:1", line: "Who supplied that figure?" });
    f.channel.event({ type: "input_audio_buffer.speech_started", item_id: "new-answer" });
    assert.equal(f.channel.sent.some(event => event.type === "conversation.item.delete"), false);
    finalInput(f, "No", "new-answer");
    f.channel.event({ type: "response.done" });
    assert.ok(f.channel.sent.some(event => event.type === "conversation.item.delete"));
    f.channel.event({ type: "input_audio_buffer.speech_stopped", item_id: "new-answer" }); inputEvent(f, "committed", "new-answer");
    created(f); f.channel.event({ type: "response.done" });
    assert.equal(f.channel.sent.filter(event => event.type === "response.create").length, 2);
    assert.equal(f.channel.sent.some(event => event.type === "input_audio_buffer.clear"), false);
    assert.equal(f.track.enabled, true); assert.equal(f.audio.closed, 0);
  } finally { f.controller.stop(); }
});

test("explicit cancellation clears active scene audio but keeps the call alive", async () => {
  const f = fixture(); await f.connect();
  try {
    f.channel.event({ type: "response.done" });
    f.controller.reactToScene({ id: "scene-now", kind: "knock" });
    f.channel.event({ type: "output_audio_buffer.started" });
    dispatchVoiceCall(f.controller, "realtimeVoice.cancelSceneReaction", ["scene-now"]);
    assert.ok(f.channel.sent.some(event => event.type === "response.cancel"));
    assert.ok(f.channel.sent.some(event => event.type === "output_audio_buffer.clear"));
    assert.equal(f.track.stops, 0); assert.equal(f.audio.closed, 0);
  } finally { f.controller.stop(); }
});

test("phase cancellation removes only follow-ups while retaining the committed inspection announcement", async () => {
  const f = fixture(); await f.connect();
  try {
    f.controller.reactToScene({ id: "follow:1", kind: "follow-up", evidenceId: "speech:1", line: "Who was there?" });
    f.controller.reactToScene({ id: "inspection:1", kind: "begin-inspection", focus: "desk", line: "Remain visible." });
    dispatchVoiceCall(f.controller, "realtimeVoice.cancelSceneReaction", []);
    assert.equal(f.channel.sent.filter(event => event.type === "conversation.item.delete").length, 1);
    f.channel.event({ type: "response.done" });
    assert.equal(f.channel.sent.filter(event => event.type === "response.create").length, 2);
  } finally { f.controller.stop(); }
});

test("instruction changes during speech precede its explicit reply and retain only the newest direction", async () => {
  const f = fixture(); await f.connect();
  try {
    f.channel.event({ type: "response.done" });
    f.channel.event({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    f.controller.updateInstructions("First replacement.");
    f.controller.updateContext("Updated public scene.");
    assert.match(f.channel.sent.at(-1)?.session.instructions, /Ask what I saw/);
    assert.doesNotMatch(f.channel.sent.at(-1)?.session.instructions, /replacement/);
    f.controller.updateInstructions("Final replacement.");
    f.channel.event({ type: "input_audio_buffer.speech_stopped", item_id: "u1" }); inputEvent(f, "committed", "u1");
    finalInput(f, "No", "u1");
    assert.equal(f.channel.sent.at(-1)?.type, "response.create");
    created(f);
    f.channel.event({ type: "response.done" });
    assert.equal(f.channel.sent.filter(e => e.type === "session.update").at(-1)?.session.instructions, "Final replacement.\n\nCurrent witnessed scene context:\nUpdated public scene.");
    const count = f.channel.sent.length;
    f.controller.updateInstructions("Final replacement.");
    assert.equal(f.channel.sent.length, count, "unchanged direction sends no extra session update");
  } finally { f.controller.stop(); }
});

test("a queued scene waits for pending instruction replacement before starting the next response", async () => {
  const f = fixture(); await f.connect();
  try {
    f.channel.event({ type: "output_audio_buffer.started" });
    f.controller.updateInstructions("Use the newly edited direction.");
    f.controller.reactToScene({ id: "knock:1", kind: "knock" });
    f.channel.event({ type: "response.done" });
    assert.equal(f.channel.sent.filter(event => event.type === "response.create").length, 1);
    f.channel.event({ type: "output_audio_buffer.stopped" });
    const next = f.channel.sent.slice(-2);
    assert.equal(next[0]?.type, "session.update");
    assert.match(next[0]?.session.instructions, /newly edited/);
    assert.equal(next[1]?.type, "response.create");
  } finally { f.controller.stop(); }
});
test("remote speaker startup failure is visible and closes the call", async () => {
  const f = fixture();
  f.deps.createAudio = () => ({ ...f.audio, attach: async () => { throw Error("playback denied"); }, close: () => { f.audio.closed++; } });
  await f.connect();
  try {
    f.peer.ontrack?.({ streams: [f.stream] }); await tick();
    assert.ok(f.events.some(e => e.type === "status" && e.status === "error" && /speaker|audio/i.test(e.message ?? "")));
    assert.equal(f.audio.closed, 1); assert.equal(f.track.stops, 1);
  } finally { f.controller.stop(); }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
class Channel {
  readyState = "connecting";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: Record<string, any>[] = [];
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = "closed"; this.onclose?.(); }
  open() { this.readyState = "open"; this.onopen?.(); }
  event(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
function fixture(overrides: Partial<VoiceDependencies> = {}) {
  const events: VoiceEvent[] = [], channel = new Channel();
  const track = {
    enabled: true, readyState: "live", stops: 0, onended: null as (() => void) | null,
    stop() { this.stops++; },
    end() { this.readyState = "ended"; this.onended?.(); },
  };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const audio = { attachInput() {}, closed: 0, muted: false, attached: 0, attach() { this.attached++; }, setMuted(value: boolean) { this.muted = value; }, setSpatial() {}, close() { this.closed++; } };
  const peer = {
    connectionState: "new", closed: 0, remotes: 0,
    ontrack: null as ((event: { streams: MediaStream[] }) => void) | null,
    onconnectionstatechange: null as (() => void) | null,
    createDataChannel: () => channel,
    addTrack() {}, createOffer: async () => ({ type: "offer", sdp: "v=0\r\no=offer" }),
    setLocalDescription: async () => {}, setRemoteDescription: async () => { peer.remotes++; },
    close() { this.closed++; },
  };
  let inputLevel: (value: number) => void = () => {};
  const calls = { consent: 0, media: 0, peer: 0, audio: 0, fetch: 0 };
  const deps: VoiceDependencies = {
    canUse: () => true, sessionId: "session-one",
    requestConsent: async (_signal, prepareAudio) => { calls.consent++; prepareAudio(); return true; },
    getUserMedia: async () => { calls.media++; return stream; },
    createPeer: () => { calls.peer++; return peer as unknown as RTCPeerConnection; },
    createAudio: (_out, input) => { inputLevel = input; calls.audio++; return audio; },
    fetch: async url => { calls.fetch++; return String(url).endsWith("/config") ? Response.json({ turnControl: "client-v1", available: true, funding: "byok", maxDurationSeconds: 300 }) : Response.json({ turnControl: "client-v1", sdp: "v=0\r\no=answer" }); },
    connectTimeoutMs: 1000,
    ...overrides,
  };
  const controller = new VoiceController(e => events.push(e), deps);
  const connect = async () => { const pending = controller.start({ instructions: "Ask what I saw." }); await tick(); channel.open(); await pending; };
  return { controller, deps, channel, track, stream, peer, audio, calls, events, connect, level: (value: number) => inputLevel(value) };
}

function avatarFixture() {
  const f = fixture();
  let callbacks: any;
  let inputLevel: (value: number) => void = () => {};
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const providerEvents: string[] = [], clientEvents: string[] = [], acknowledgements: number[] = [];
  const avatar = { ...f.audio,
    close: () => { f.audio.closed++; },
    connectAvatar: async (_connection: unknown) => {},
    handleProviderEvent: (event: Record<string, unknown>) => {
      providerEvents.push(String(event.type));
      if (event.type === "output_audio_buffer.started") callbacks.onPending?.();
      return String(event.type).startsWith("output_audio_buffer.");
    },
    handleClientEvent: (event: Record<string, unknown>) => { clientEvents.push(String(event.type)); if (event.type === "output_audio_buffer.clear") callbacks.onPlayback("cleared"); },
    ackVideoFrame: (id: number) => { acknowledgements.push(id); },
  };
  f.deps.createAvatarAudio = (_output, input, options) => { inputLevel = input; callbacks = options; return avatar; };
  f.deps.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/config")) return Response.json({ turnControl: "client-v1", available: true, avatarAvailable: true, funding: "testing", maxDurationSeconds: 300 });
    if (String(url).endsWith("/avatar/start")) return Response.json({ sessionId: "avatar-session", livekitUrl: "wss://media.example.test", livekitClientToken: "ephemeral", wsUrl: "wss://avatar.example.test", maxDurationSeconds: 300 });
    return Response.json({ turnControl: "client-v1", sdp: "v=0\r\no=answer" });
  };
  const connect = async () => { const pending = f.controller.start({ instructions: "Ask what I saw.", avatar: true }); await tick(); f.channel.open(); await pending; };
  return { ...f, avatar, requests, providerEvents, clientEvents, acknowledgements, callbacks: () => callbacks, connect, level: (value: number) => inputLevel(value) };
}

test("avatar waits for media readiness before opening the AI and never constructs direct playback", async () => {
  const f = avatarFixture(), ready = deferred<void>();
  f.avatar.connectAvatar = () => ready.promise;
  const pending = f.controller.start({ instructions: "hello", avatar: true });
  try {
    await tick(); assert.equal(f.calls.media, 1); assert.equal(f.calls.peer, 0); assert.equal(f.calls.audio, 0);
    assert.equal(f.requests.filter(r => r.url.endsWith("/avatar/start")).length, 1);
    ready.resolve(); await tick(); f.channel.open(); await pending;
    assert.equal(f.calls.peer, 1);
    assert.equal(f.channel.sent.filter(e => e.type === "response.create").length, 1);
  } finally { f.controller.stop(); }
  assert.equal(f.requests.filter(r => r.url.endsWith("/avatar/stop")).length, 1);
  const start = f.requests.find(r => r.url.endsWith("/avatar/start"))!;
  const stop = f.requests.find(r => r.url.endsWith("/avatar/stop"))!;
  assert.equal(new Headers(start.init?.headers).get("X-Voice-Connection-Id"), new Headers(stop.init?.headers).get("X-Voice-Connection-Id"));
  assert.equal(f.audio.closed, 1); assert.equal(f.track.stops, 1);
});

test("avatar opt-in fails visibly when unavailable and does not silently run direct voice", async () => {
  const f = fixture();
  await assert.rejects(f.controller.start({ instructions: "hello", avatar: true }), /video|avatar/i);
  assert.equal(f.calls.consent, 0); assert.equal(f.calls.media, 0); assert.equal(f.calls.audio, 0);
  await assert.rejects(f.controller.start({ instructions: "hello", avatar: "true" }), /avatar|video/i);
});

test("actual avatar playback holds scene reactions and instructions beyond OpenAI generation", async () => {
  const f = avatarFixture(); await f.connect();
  try {
    const before = f.events.length;
    f.channel.event({ type: "output_audio_buffer.started" });
    assert.equal(f.events.slice(before).some(e => e.type === "activity" && e.status === "speaking"), false);
    f.controller.updateInstructions("New direction.");
    f.controller.reactToScene({ id: "door:1", kind: "knock" });
    f.channel.event({ type: "response.done" }); f.channel.event({ type: "output_audio_buffer.stopped" });
    assert.equal(f.channel.sent.filter(e => e.type === "response.create").length, 1);
    f.callbacks().onPlayback("started");
    assert.ok(f.events.some(e => e.type === "activity" && e.status === "speaking"));
    assert.equal(f.channel.sent.filter(e => e.type === "session.update").length, 0);
    f.callbacks().onPlayback("stopped");
    assert.equal(f.channel.sent.at(-2)?.session.instructions, "New direction.");
    assert.equal(f.channel.sent.at(-1)?.type, "response.create");
  } finally { f.controller.stop(); }
});

test("an unsealed avatar playback gap keeps queued scene reactions behind the actual source turn", async () => {
  const f=avatarFixture();await f.connect();let sequence=0;
  const commands:Record<string,unknown>[]=[];
  const state=new AvatarUtterances({uuid:()=>`utterance-${++sequence}`,send:event=>commands.push(event),capture(){},mute(){},pending:()=>f.callbacks().onPending(),playback:event=>f.callbacks().onPlayback(event)});
  state.connected();f.avatar.handleProviderEvent=event=>state.provider(event);f.avatar.handleClientEvent=event=>state.client(event);
  try{
    created(f, "r1");
    f.channel.event({type:"output_audio_buffer.started",response_id:"r1"});state.pcm(1,new Uint8Array([1,2]));const id=commands[0].event_id;
    state.avatar({type:"agent.speak_started",source_event_id:id});f.controller.reactToScene({id:"door:gap",kind:"knock"});
    f.channel.event({type:"response.done"});state.avatar({type:"agent.speak_ended",source_event_id:id});
    assert.equal(f.channel.sent.filter(e=>e.type==="response.create").length,1,"A transient avatar chunk gap must not release a queued scene response.");
    state.pcm(1,new Uint8Array([3,4]));state.avatar({type:"agent.speak_started",source_event_id:id});f.channel.event({type:"output_audio_buffer.stopped",response_id:"r1"});state.drained(1);state.avatar({type:"agent.speak_ended",source_event_id:id});
    assert.equal(f.channel.sent.filter(e=>e.type==="response.create").length,2,"The queued scene response resumes after actual turn completion.");
  }finally{state.close();f.controller.stop();}
});

test("avatar receives interruptions and valid frame acknowledgements while transcripts still persist", async () => {
  const f = avatarFixture(); await f.connect();
  try {
    f.channel.event({ type: "response.output_audio_transcript.done", item_id: "reference", content_index: 0, transcript: "Explain the page." });
    f.callbacks().onPlayback("started");
    f.channel.event({ type: "input_audio_buffer.speech_started", item_id: "utterance1" });
    f.channel.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "utterance1", content_index: 0, transcript: "I remember." });
    assert.ok(f.events.some(e => e.type === "transcript" && e.text === "I remember."));
    assert.ok(f.providerEvents.includes("input_audio_buffer.speech_started"));
    f.controller.setMuted({ input: false, output: true });
    assert.ok(f.clientEvents.includes("output_audio_buffer.clear"));
    dispatchVoiceCall(f.controller, "realtimeVoice.ackVideoFrame", [7]);
    assert.deepEqual(f.acknowledgements, [7]);
    for (const id of [NaN, -1, 1.1, "7", Infinity]) assert.throws(() => dispatchVoiceCall(f.controller, "realtimeVoice.ackVideoFrame", [id]), /frame/i);
  } finally { f.controller.stop(); }
});

test("stop during avatar negotiation releases the exact server session and ignores late frames", async () => {
  const f = avatarFixture(), ready = deferred<void>(); f.avatar.connectAvatar = () => ready.promise;
  const pending = f.controller.start({ instructions: "hello", avatar: true });
  const rejected = assert.rejects(pending, /stopped/i); await tick(); f.controller.stop(); await rejected;
  ready.resolve(); await tick();
  let closed = 0;
  f.callbacks().onVideoFrame({ id: 1, frame: { close: () => { closed++; } } });
  f.callbacks().onPlayback("started");
  assert.equal(closed, 1); assert.equal(f.calls.peer, 0);
  assert.equal(f.requests.filter(r => r.url.endsWith("/avatar/stop")).length, 1);
  assert.equal(f.events.at(-1)?.type, "status");
});

test("avatar transport failure stops both providers and surfaces a retryable error", async () => {
  const f = avatarFixture(); await f.connect();
  f.callbacks().onError("The telescreen video disconnected. Start voice again.");
  assert.equal(f.audio.closed, 1); assert.equal(f.track.stops, 1);
  assert.ok(f.requests.some(r => r.url.endsWith("/avatar/stop")));
  assert.ok(f.requests.some(r => r.url.endsWith("/stop") && !r.url.endsWith("/avatar/stop")));
  assert.ok(f.events.some(e => e.type === "status" && e.status === "error" && /video/i.test(e.message ?? "")));
});

test("expired avatar heartbeat ends the whole call without leaving audio-only playback", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = avatarFixture(); f.deps.avatarHeartbeatMs = 5;
  const fetch = f.deps.fetch;
  f.deps.fetch = async (url, options) => String(url).endsWith("/avatar/heartbeat") ? Response.json({ active: false }) : fetch(url, options);
  await f.connect();
  try {
    t.mock.timers.tick(5);
    await tick();
    assert.equal(f.audio.closed, 1); assert.equal(f.track.stops, 1);
    assert.ok(f.events.some(e => e.type === "status" && e.status === "error" && /connection ended/i.test(e.message ?? "")));
  } finally { f.controller.stop(); }
});

test("speech clearing delayed avatar playback cannot release a queued scene over the player", async () => {
  const f = avatarFixture(); await f.connect();
  try {
    f.channel.event({ type: "output_audio_buffer.started" });
    f.channel.event({ type: "response.done" });
    f.controller.reactToScene({ id: "waiting-knock", kind: "knock" });
    f.callbacks().onPlayback("started");
    f.channel.event({ type: "input_audio_buffer.speech_started", item_id: "interruption" });
    assert.equal(f.channel.sent.filter(e => e.type === "response.create").length, 1, "Synchronous playback-clear callback respects current player speech.");
  } finally { f.controller.stop(); }
});

test("clearing an active avatar scene reaches OpenAI before a queued reply can be released", async () => {
  const f = avatarFixture(); await f.connect();
  f.avatar.handleClientEvent = event => { if (event.type === "output_audio_buffer.clear") f.callbacks().onPlayback("cleared"); };
  try {
    f.channel.event({ type: "response.done" });
    f.controller.reactToScene({ id: "follow:active", kind: "follow-up", evidenceId: "speech:1", line: "Who was there?" });
    f.channel.event({ type: "output_audio_buffer.started" }); f.callbacks().onPlayback("started");
    f.channel.event({ type: "response.done" });
    f.controller.reactToScene({ id: "knock:queued", kind: "knock" });
    const before = f.channel.sent.length;
    f.controller.cancelSceneReaction("follow:active");
    const sent = f.channel.sent.slice(before).map(e => e.type);
    assert.ok(sent.indexOf("output_audio_buffer.clear") < sent.indexOf("response.create"), "Provider clear must not land after the next response request.");
  } finally { f.controller.stop(); }
});

test("capability and consent denial never acquire a microphone", async () => {
  const denied = fixture({ canUse: () => false });
  await assert.rejects(denied.controller.start({ instructions: "hello" }), /unavailable/i);
  assert.equal(denied.calls.consent, 0); assert.equal(denied.calls.media, 0);
  const refused = fixture({ requestConsent: async () => false });
  await assert.rejects(refused.controller.start({ instructions: "hello" }), /declined/i);
  assert.equal(refused.calls.media, 0); assert.equal(refused.calls.peer, 0);
  assert.ok(refused.events.some(e => e.type === "status" && e.status === "stopped"), "Declining is an intentional stop.");
  assert.equal(refused.events.some(e => e.type === "status" && e.status === "error"), false, "Not now is not a connection error.");
});

test("connection feedback distinguishes device permission from network setup", async () => {
  const media = deferred<MediaStream>();
  const f = fixture({ getUserMedia: () => media.promise });
  const pending = f.controller.start({ instructions: "hello" });
  try {
    await tick();
    assert.ok(f.events.some(e => e.type === "status" && e.status === "connecting" && e.message === "Confirm microphone"));
    assert.ok(f.events.some(e => e.type === "status" && e.status === "connecting" && e.message === "Allow microphone"));
    assert.equal(f.calls.peer, 0);
    media.resolve(f.stream); await tick(); f.channel.open(); await pending;
    assert.ok(f.events.some(e => e.type === "status" && e.status === "connecting" && e.message === "Connecting voice"));
  } finally { f.controller.stop(); await pending.catch(() => {}); }
});

test("duplicate starts share consent and transport; stop cancels pending consent", async () => {
  const consent = deferred<boolean>(); let signal!: AbortSignal;
  const f = fixture({ requestConsent: async s => { signal = s; f.calls.consent++; return consent.promise; } });
  const first = f.controller.start({ instructions: "hello" });
  const second = f.controller.start({ instructions: "again" });
  assert.equal(first, second); await tick(); assert.equal(f.calls.consent, 1);
  const rejection = assert.rejects(first, /stopped/i);
  f.controller.stop(); await rejection;
  consent.resolve(true); await tick();
  assert.equal(signal.aborted, true); assert.equal(f.calls.media, 0);
});

test("late microphone permission is immediately released after stop", async () => {
  const media = deferred<MediaStream>(); const f = fixture({ getUserMedia: () => media.promise });
  const pending = f.controller.start({ instructions: "hello" }); await tick();
  const rejection = assert.rejects(pending, /stopped/i); f.controller.stop(); await rejection;
  media.resolve(f.stream); await tick();
  assert.equal(f.track.stops, 1); assert.equal(f.calls.peer, 0); assert.equal(f.audio.closed, 1);
});

test("stopping negotiation aborts HTTP and prevents late answer revival", async () => {
  const response = deferred<Response>(); let signal: AbortSignal | null | undefined;
  const f = fixture({ fetch: async (_url, init) => { if (String(_url).endsWith("/config")) return Response.json({ turnControl: "client-v1", available: true, funding: "byok", maxDurationSeconds: 300 }); signal = init?.signal; return response.promise; } });
  const pending = f.controller.start({ instructions: "hello" }); await tick();
  const rejection = assert.rejects(pending, /stopped/i); f.controller.stop(); await rejection;
  response.resolve(Response.json({ turnControl: "client-v1", sdp: "late" })); await tick();
  assert.equal(signal?.aborted, true); assert.equal(f.peer.remotes, 0); assert.equal(f.track.stops, 1);
});

test("changed capability during consent cannot start capture", async () => {
  const consent = deferred<boolean>(); let allowed = true;
  const f = fixture({ canUse: () => allowed, requestConsent: () => consent.promise });
  const pending = f.controller.start({ instructions: "hello" }); allowed = false; consent.resolve(true);
  await assert.rejects(pending, /unavailable/i); assert.equal(f.calls.media, 0);
});

test("connection opens one first response and stop closes media, audio, peer and ignores old events", async () => {
  const f = fixture(); await f.connect();
  assert.deepEqual([...new Set(f.events.filter(e => e.type === "status").map(e => e.status))], ["connecting", "connected"]);
  assert.equal(f.channel.sent.filter(e => e.type === "response.create").length, 1);
  f.peer.ontrack?.({ streams: [f.stream] }); assert.equal(f.audio.attached, 1);
  const stale = f.channel.onmessage; f.controller.stop(); const eventCount = f.events.length;
  stale?.({ data: JSON.stringify({ type: "response.output_audio_transcript.done", item_id: "late", transcript: "late", content_index: 0 }) });
  assert.equal(f.events.length, eventCount); assert.equal(f.track.stops, 1); assert.equal(f.peer.closed, 1); assert.equal(f.audio.closed, 1);
});

test("provider data produces stable cumulative captions and forwards a valid tool only once", async () => {
  const f = fixture(); await f.connect();
  const event = (type: string, extra: object) => f.channel.event({ type, ...extra });
  event("response.done", {});
  event("conversation.item.input_audio_transcription.delta", { item_id: "u1", content_index: 0, delta: "I saw ", event_id: "e1" });
  event("conversation.item.input_audio_transcription.delta", { item_id: "u1", content_index: 0, delta: "I saw ", event_id: "e1" });
  event("conversation.item.input_audio_transcription.delta", { item_id: "u1", content_index: 0, delta: "nothing." });
  event("conversation.item.input_audio_transcription.completed", { item_id: "u1", content_index: 0, transcript: "I saw nothing." });
  event("conversation.item.input_audio_transcription.completed", { item_id: "u1", content_index: 0, transcript: "changed" });
  event("response.output_audio_transcript.done", { item_id: "a1", content_index: 0, transcript: "Understood." });
  const captions = f.events.filter(e => e.type === "transcript");
  assert.deepEqual(captions.map(e => [e.id, e.text, e.final]), [["user:u1:0", "I saw nothing.", true], ["assistant:a1:0", "Understood.", true]], "Resident deltas stay provisional until their final classification");
  const call = { call_id: "call1", name: "request_inspection_focus", arguments: JSON.stringify({ focus: "desk", reason: "Inspect the letter" }) };
  event("response.function_call_arguments.done", call); event("response.function_call_arguments.done", call);
  assert.equal(f.events.filter(e => e.type === "tool").length, 1);
  f.controller.resolveTool("call1", { accepted: false, reason: "Stay here." }); f.controller.resolveTool("call1", { accepted: true, focus: "door" });
  assert.equal(f.channel.sent.filter(e => e.type === "conversation.item.create").length, 1);
  f.controller.stop();
});

test("malformed or excessive provider events cannot become captions or gameplay tools", async () => {
  const f = fixture(); await f.connect();
  for (const value of [null, [], { type: "response.output_audio_transcript.done", item_id: {}, transcript: "fake" }, { type: "response.function_call_arguments.done", call_id: "bad1", name: "executeCode", arguments: "{}" }, { type: "response.function_call_arguments.done", call_id: "bad2", name: "request_inspection_focus", arguments: '{"focus":"hidden","reason":"x"}' }, { type: "response.function_call_arguments.done", call_id: "bad3", name: "request_inspection_focus", arguments: '{"focus":"desk","reason":"x","code":"eval"}' }]) f.channel.event(value);
  f.channel.onmessage?.({ data: "{" }); f.channel.onmessage?.({ data: "x".repeat(70000) });
  f.channel.event({ type: "conversation.item.added", item: {} });
  f.channel.event({ type: "conversation.item.created", item: null });
  assert.equal(f.events.some(e => e.type === "tool" || e.type === "transcript"), false);
  f.controller.stop();
});

test("outage cancellation fences a late unseen assistant item after restore without losing prior words", async () => {
  const f = fixture(); await f.connect();
  try {
    created(f, "before-cut");
    f.channel.event({ type: "response.output_audio_transcript.done", response_id: "before-cut", item_id: "committed", content_index: 0, transcript: "Already generated." });
    f.channel.event({ type: "input_audio_buffer.speech_started", item_id: "resident" });
    f.controller.setMuted({ input: true, output: true });
    f.controller.setMuted({ input: false, output: false });
    f.channel.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "resident", content_index: 0, transcript: "My earlier words." });
    f.channel.event({ type: "response.output_audio_transcript.done", response_id: "before-cut", item_id: "unseen-late", content_index: 0, transcript: "Obsolete reply." });
    assert.ok(f.events.some(e => e.type === "transcript" && e.text === "Already generated."));
    assert.ok(f.events.some(e => e.type === "transcript" && e.text === "My earlier words."));
    assert.equal(f.events.some(e => e.type === "transcript" && e.text === "Obsolete reply."), false);
  } finally { f.controller.stop(); }
});

test("outage cancellation fences an outstanding response.create and old completion playback and tools", async () => {
  for (const avatar of [false, true]) {
    const f = avatar ? avatarFixture() : fixture(); await f.connect();
    try {
      // The opening request is genuinely outstanding: no created receipt yet.
      assert.ok(f.channel.sent.some(e => e.type === "response.create"));
      f.controller.setMuted({ input: true, output: true });
      f.controller.setMuted({ input: false, output: false });
      f.channel.event({ type: "response.created", response: { id: "cancelled-opening", metadata: f.channel.sent.filter(e => e.type === "response.create").at(-1)!.response.metadata } });
      f.channel.event({ type: "response.output_audio_transcript.done", response_id: "cancelled-opening", item_id: "late", content_index: 0, transcript: "Never deliver." });
      assert.ok(!f.events.some(e => e.type === "transcript" && e.text === "Never deliver."));
      f.channel.event({ type: "response.done", response: { id: "cancelled-opening", status: "cancelled" } });
      f.controller.reactToScene({ id: "restoration", kind: "power-restored" });
      f.channel.event({ type: "response.created", response: { id: "current", metadata: f.channel.sent.filter(e => e.type === "response.create").at(-1)!.response.metadata } });
      const count = f.channel.sent.filter(e => e.type === "response.create").length;
      f.controller.reactToScene({ id: "queued-current", kind: "bulletin", text: "Current public observation." });
      const beforeEvents = f.events.length;
      for (const event of [
        { type: "output_audio_buffer.started", response_id: "cancelled-opening" },
        { type: "output_audio_buffer.stopped", response_id: "cancelled-opening" },
        { type: "response.function_call_arguments.done", response_id: "cancelled-opening", call_id: "old-tool", name: "request_inspection_focus", arguments: '{"focus":"desk","reason":"old"}' },
        { type: "response.done", response: { id: "cancelled-opening", status: "failed" } },
        { type: "response.created", response: { id: "cancelled-opening" } },
      ]) f.channel.event(event);
      assert.equal(f.events.length, beforeEvents, "Old generation cannot emit activity, tools or disconnect.");
      assert.equal(f.channel.sent.filter(e => e.type === "response.create").length, count, "Old done cannot release a newer response's queue.");
      f.channel.event({ type: "response.output_audio_transcript.done", response_id: "current", item_id: "new", content_index: 0, transcript: "Supply restored." });
      assert.ok(f.events.some(e => e.type === "transcript" && e.text === "Supply restored."));
    } finally { f.controller.stop(); }
  }
});

test("outage cancellation fences delayed automatic replies to pre-cut input after restoration", async () => {
  const f = fixture(); await f.connect();
  try {
    created(f, "opening");
    f.channel.event({ type: "response.done", response: { id: "opening", status: "completed" } });
    f.channel.event({ type: "input_audio_buffer.speech_started", item_id: "pre-cut-input" });
    f.controller.setMuted({ input: true, output: true });
    f.controller.setMuted({ input: false, output: false });
    f.channel.event({ type: "input_audio_buffer.speech_stopped", item_id: "pre-cut-input" }); inputEvent(f, "committed", "pre-cut-input");
    f.channel.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "pre-cut-input", content_index: 0, transcript: "Earlier words." });
    f.channel.event({ type: "response.created", response: { id: "late-automatic" } });
    f.channel.event({ type: "response.output_audio_transcript.done", response_id: "late-automatic", item_id: "late-auto-text", content_index: 0, transcript: "Obsolete automatic reply." });
    assert.ok(f.events.some(e => e.type === "transcript" && e.text === "Earlier words."));
    assert.ok(!f.events.some(e => e.type === "transcript" && e.text === "Obsolete automatic reply."));
    f.channel.event({ type: "response.done", response: { id: "late-automatic", status: "cancelled" } });
    f.controller.reactToScene({ id: "restored-after-input", kind: "power-restored" });
    f.channel.event({ type: "response.created", response: { id: "explicit-restored", metadata: f.channel.sent.filter(e => e.type === "response.create").at(-1)!.response.metadata } });
    f.channel.event({ type: "response.output_audio_transcript.done", response_id: "explicit-restored", item_id: "restored-text", content_index: 0, transcript: "Restored notice." });
    assert.ok(f.events.some(e => e.type === "transcript" && e.text === "Restored notice."));
    f.channel.event({ type: "response.done", response: { id: "explicit-restored", status: "completed" } });
    f.channel.event({ type: "input_audio_buffer.speech_started", item_id: "fresh-input" });
    f.channel.event({ type: "input_audio_buffer.speech_stopped", item_id: "fresh-input" }); inputEvent(f, "committed", "fresh-input");
    finalInput(f, "A fresh answer", "fresh-input");
    created(f, "fresh-automatic");
    f.channel.event({ type: "response.output_audio_transcript.done", response_id: "fresh-automatic", item_id: "fresh-text", content_index: 0, transcript: "Fresh answer." });
    assert.ok(f.events.some(e => e.type === "transcript" && e.text === "Fresh answer."));
  } finally { f.controller.stop(); }
});

for (const avatar of [false, true]) {
  test(`outage review: collision retry respects mute stop correlation and its one-attempt limit (${avatar ? "avatar" : "direct"})`, async () => {
    for (const boundary of ["mute", "stop", "unknown-code", "unrelated-id", "no-overlap", "second-rejection", "new-input"]) {
      const f = avatar ? avatarFixture() : fixture(); await f.connect();
      try {
        created(f, "opening");
        f.channel.event({ type: "response.done", response: { id: "opening", status: "completed" } });
        if (boundary !== "no-overlap") {
          f.channel.event({ type: "input_audio_buffer.speech_started", item_id: "pre-cut" });
          f.controller.setMuted({ input: true, output: true });f.controller.setMuted({ input: false, output: false });
        }
        f.controller.reactToScene({ id: "restore-boundary", kind: "power-restored" });
        if (boundary !== "no-overlap") {
          f.channel.event({ type: "input_audio_buffer.speech_stopped", item_id: "pre-cut" }); inputEvent(f, "committed", "pre-cut");
          f.channel.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "pre-cut", content_index: 0, transcript: "Earlier words." });
          f.channel.event({ type: "response.created", response: { id: "old-active" } });
        }
        const request = f.channel.sent.filter(e => e.type === "response.create").at(-1)!;
        f.channel.event({ type: "error", error: { code: boundary === "unknown-code" ? "unknown_provider_failure" : "conversation_already_has_active_response", event_id: boundary === "unrelated-id" ? "unrelated-request" : request.event_id } });
        if (["unknown-code", "unrelated-id", "no-overlap"].includes(boundary)) {
          assert.equal(f.track.stops, 1, boundary + " retains terminal provider-error handling.");
          assert.equal(f.channel.sent.filter(e => e.type === "response.create").length, 2);continue;
        }
        if (boundary === "mute") f.controller.setMuted({ input: true, output: true });
        if (boundary === "stop") f.controller.stop();
        if (boundary === "new-input") f.channel.event({ type: "input_audio_buffer.speech_started", item_id: "fresh" });
        f.channel.event({ type: "response.done", response: { id: "old-active", status: "cancelled" } });
        if (boundary !== "second-rejection") {
          assert.equal(f.channel.sent.filter(e => e.type === "response.create").length, 2, boundary + " cannot revive the rejected request.");
          if (boundary === "mute") {f.controller.setMuted({ input: false, output: false });assert.equal(f.channel.sent.filter(e => e.type === "response.create").length, 2);}
          continue;
        }
        const retry = f.channel.sent.filter(e => e.type === "response.create").at(-1)!;
        assert.equal(f.channel.sent.filter(e => e.type === "response.create").length, 3);
        f.channel.event({ type: "error", error: { code: "conversation_already_has_active_response", event_id: retry.event_id } });
        assert.equal(f.track.stops, 1,"Second rejection is terminal; no retry loop.");
        assert.equal(f.channel.sent.filter(e => e.type === "response.create").length, 3);
      } finally { f.controller.stop(); }
    }
  });

  test(`outage review: correlated single-active rejection retries once after old response retires (${avatar ? "avatar" : "direct"})`, async () => {
    for (const order of ["before-created", "before-done", "after-done"]) {
      const f = avatar ? avatarFixture() : fixture(); await f.connect();
      try {
        created(f, "opening");
        f.channel.event({ type: "response.done", response: { id: "opening", status: "completed" } });
        f.channel.event({ type: "input_audio_buffer.speech_started", item_id: "pre-cut" });
        f.controller.setMuted({ input: true, output: true });f.controller.setMuted({ input: false, output: false });
        f.controller.reactToScene({ id: "restore-conflict", kind: "power-restored" });
        f.channel.event({ type: "input_audio_buffer.speech_stopped", item_id: "pre-cut" }); inputEvent(f, "committed", "pre-cut");
        f.channel.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "pre-cut", content_index: 0, transcript: "Preserved words." });
        const request = f.channel.sent.filter(e => e.type === "response.create").at(-1)!;
        const reject = () => f.channel.event({ type: "error", error: { code: "conversation_already_has_active_response", event_id: request.event_id } });
        if (order === "before-created") reject();
        f.channel.event({ type: "response.created", response: { id: "old-active" } });
        if (order === "before-done") reject();
        assert.equal(f.track.stops, 0, "The correlated collision is not a terminal provider failure.");
        assert.equal(f.channel.sent.filter(e => e.type === "response.create").length, 2, "No retry before actual retirement.");
        assert.equal(activity(f), "thinking", "The correlated request remains pending through collision settlement");
        f.channel.event({ type: "response.done", response: { id: "old-active", status: "cancelled" } });
        if (order === "after-done") reject();
        const retried = f.channel.sent.filter(e => e.type === "response.create").at(-1)!;
        assert.equal(f.channel.sent.filter(e => e.type === "response.create").length, 3);
        assert.notEqual(retried.event_id, request.event_id);
        assert.equal(activity(f), "thinking", "Retry owns output before its new response receipt");
        f.channel.event({ type: "response.done", response: { id: "old-active", status: "cancelled" } });
        assert.equal(f.channel.sent.filter(e => e.type === "response.create").length, 3, "Duplicate old completion never retries again.");
        f.channel.event({ type: "response.created", response: { id: "restored-retry", metadata: retried.response.metadata } });
        f.channel.event({ type: "response.output_audio_transcript.done", response_id: "restored-retry", item_id: "restored-retry-text", content_index: 0, transcript: "Supply restored after cancellation." });
        assert.equal(f.events.filter(e => e.type === "transcript" && e.text === "Supply restored after cancellation.").length, 1);
        assert.equal(f.events.filter(e => e.type === "transcript" && e.text === "Preserved words.").length, 1);
        f.channel.event({ type: "response.done", response: { id: "restored-retry", status: "completed" } });
        assert.equal(activity(f), "listening", "Silent retry completion releases pending activity");
      } finally { f.controller.stop(); }
    }
  });

  test(`outage review: finalized pre-cut input still fences its delayed automatic reply (${avatar ? "avatar" : "direct"})`, async () => {
    const f = avatar ? avatarFixture() : fixture(); await f.connect();
    try {
      created(f, "opening");
      f.channel.event({ type: "response.done", response: { id: "opening", status: "completed" } });
      f.channel.event({ type: "input_audio_buffer.speech_started", item_id: "finished-before-cut" });
      f.channel.event({ type: "input_audio_buffer.speech_stopped", item_id: "finished-before-cut" }); inputEvent(f, "committed", "finished-before-cut");
      f.channel.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "finished-before-cut", content_index: 0, transcript: "Already received words." });
      f.controller.setMuted({ input: true, output: true });
      f.controller.setMuted({ input: false, output: false });
      f.channel.event({ type: "response.created", response: { id: "late-finished-auto" } });
      f.channel.event({ type: "response.output_audio_transcript.done", response_id: "late-finished-auto", item_id: "late-finished-text", content_index: 0, transcript: "Obsolete finalized-input answer." });
      assert.equal(f.events.filter(e => e.type === "transcript" && e.text === "Already received words.").length, 1);
      assert.ok(!f.events.some(e => e.type === "transcript" && e.text === "Obsolete finalized-input answer."));
    } finally { f.controller.stop(); }
  });

  test(`outage review: delayed automatic response cannot impersonate pending restoration (${avatar ? "avatar" : "direct"})`, async () => {
    const f = avatar ? avatarFixture() : fixture(); await f.connect();
    try {
      created(f, "opening");
      f.channel.event({ type: "response.done", response: { id: "opening", status: "completed" } });
      f.channel.event({ type: "input_audio_buffer.speech_started", item_id: "pre-cut" });
      f.controller.setMuted({ input: true, output: true });
      f.controller.setMuted({ input: false, output: false });
      f.controller.reactToScene({ id: "restore-overlap", kind: "power-restored" });
      f.channel.event({ type: "input_audio_buffer.speech_stopped", item_id: "pre-cut" }); inputEvent(f, "committed", "pre-cut");
      f.channel.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "pre-cut", content_index: 0, transcript: "Delayed earlier words." });
      const request = f.channel.sent.filter(e => e.type === "response.create").at(-1)!;
      assert.equal(f.channel.sent.filter(e => e.type === "response.create").length, 2, "Restoration request is actually outstanding.");
      f.channel.event({ type: "response.created", response: { id: "old-auto-overlap" } });
      f.channel.event({ type: "response.output_audio_transcript.done", response_id: "old-auto-overlap", item_id: "old-auto-overlap-text", content_index: 0, transcript: "Obsolete overlapping reply." });
      assert.ok(!f.events.some(e => e.type === "transcript" && e.text === "Obsolete overlapping reply."));
      f.channel.event({ type: "response.done", response: { id: "old-auto-overlap", status: "cancelled" } });
      f.channel.event({ type: "response.created", response: { id: "actual-restoration", metadata: request.response?.metadata } });
      f.channel.event({ type: "response.output_audio_transcript.done", response_id: "actual-restoration", item_id: "restoration-text", content_index: 0, transcript: "Supply restored normally." });
      assert.equal(f.events.filter(e => e.type === "transcript" && e.text === "Supply restored normally.").length, 1);
      assert.equal(f.events.filter(e => e.type === "transcript" && e.text === "Delayed earlier words.").length, 1);
      assert.equal(f.track.stops, 0);
    } finally { f.controller.stop(); }
  });
}

test("mute gates tracks and clears provider audio; context and tool outputs stay bounded", async () => {
  const f = fixture(); await f.connect();
  created(f, "r1");
  f.controller.setMuted({ input: true, output: true });
  assert.equal(f.track.enabled, false); assert.equal(f.audio.muted, true);
  assert.ok(f.channel.sent.some(e => e.type === "response.cancel"));
  assert.ok(f.channel.sent.some(e => e.type === "output_audio_buffer.clear"));
  f.controller.setMuted({ input: false, output: false }); assert.equal(f.track.enabled, true);
  f.controller.updateContext("Visible: desk");
  const context = f.channel.sent.at(-1)!; assert.equal(context.type, "session.update"); assert.match(context.session.instructions, /Visible: desk/);
  assert.throws(() => f.controller.updateContext("x".repeat(12001)), /context/i);
  assert.throws(() => f.controller.setSpatial({ x: NaN, z: 0, yaw: 0, sourceX: 1, sourceZ: 1 }), /spatial/i);
  f.controller.resolveTool("made-up-call", { accepted: true, focus: "desk" });
  assert.equal(f.channel.sent.some(e => e.type === "conversation.item.create"), false); f.controller.stop();
});

test("safe server error codes never echo raw failure text and timeout releases capture", async () => {
  const f = fixture({ fetch: async url => String(url).endsWith("/config") ? Response.json({ turnControl: "client-v1", available: true, funding: "byok", maxDurationSeconds: 300 }) : Response.json({ code: "OPENAI_KEY_REQUIRED", error: "secret provider diagnostic" }, { status: 412 }) });
  await assert.rejects(f.controller.start({ instructions: "hello" }), /OpenAI.*key/i);
  assert.equal(JSON.stringify(f.events).includes("secret"), false); assert.equal(f.track.stops, 1);
  const timeout = fixture({ connectTimeoutMs: 10, fetch: async url => String(url).endsWith("/config") ? Response.json({ turnControl: "client-v1", available: true, funding: "byok", maxDurationSeconds: 300 }) : new Promise(() => {}) });
  await assert.rejects(timeout.controller.start({ instructions: "hello" }), /timed out/i);
  assert.equal(timeout.track.stops, 1); assert.equal(timeout.peer.closed, 1);
});

test("active calls expire without auto-restarting billable capture", async () => {
  const f = fixture({ maxDurationMs: 10 }); await f.connect(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.track.stops, 1); assert.equal(f.peer.closed, 1); assert.equal(f.calls.media, 1);
  assert.ok(f.events.some(e => e.type === "status" && e.status === "stopped" && /limit/i.test(e.message ?? "")));
});

test("tool continuation waits for the preceding response to finish", async () => {
  const f = fixture(); await f.connect();
  created(f, "r1");
  f.channel.event({ type: "response.function_call_arguments.done", call_id: "call1", name: "request_inspection_focus", arguments: '{"focus":"desk","reason":"Look"}' });
  f.controller.resolveTool("call1", { accepted: true, focus: "desk" });
  assert.equal(f.channel.sent.filter(e => e.type === "response.create").length, 1);
  f.channel.event({ type: "response.done" });
  assert.equal(f.channel.sent.filter(e => e.type === "response.create").length, 2); f.controller.stop();
});

test("cards cannot send provider events or malformed argument envelopes", async () => {
  const f = fixture(); await f.connect();
  assert.throws(() => dispatchVoiceCall(f.controller, "realtimeVoice.send", [{ type: "session.update" }]), /unknown/i);
  assert.throws(() => dispatchVoiceCall(f.controller, "realtimeVoice.start", null as unknown as unknown[]), /arguments/i);
  f.controller.stop();
});

test("input activity uses transcript ids and muting preserves unfinished speech for transcription", async () => {
  const f = fixture(); await f.connect();
  f.channel.event({ type: "input_audio_buffer.speech_started", item_id: "u1", event_id: "e1" });
  f.controller.setMuted({ input: true, output: true });
  assert.equal(f.channel.sent.some(e => e.type === "input_audio_buffer.clear"), false);
  f.channel.event({ type: "input_audio_buffer.speech_stopped", item_id: "u1", event_id: "e2" }); inputEvent(f, "committed", "u1");
  f.channel.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", content_index: 0, transcript: "The final sentence." });
  assert.deepEqual(f.events.filter(e => e.type === "input" || e.type === "transcript").map(e => [e.type, e.id]), [["input", "user:u1:0"], ["input", "user:u1:0"], ["transcript", "user:u1:0"]]);
  f.controller.stop();
});

test("late cancellation errors do not disconnect before final user transcription", async () => {
  const f = fixture(); await f.connect();
  try {
    f.controller.setMuted({ input: true, output: true });
    const cancellation = f.channel.sent.find(event => event.type === "response.cancel")!;
    f.channel.event({ type: "error", error: { event_id: cancellation.event_id, code: "response_cancel_not_active", message: "Nothing remains to cancel." } });
    assert.equal(f.track.stops, 0, "a harmless cancel race must preserve capture and transcription transport");
    f.channel.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "last", content_index: 0, transcript: "My last words." });
    assert.ok(f.events.some(event => event.type === "transcript" && event.final && event.text === "My last words."));
    f.channel.event({ type: "error", error: { event_id: "unrelated", code: "server_error" } });
    assert.equal(f.track.stops, 1, "unrelated provider errors still clean up");
  } finally { f.controller.stop(); }
});

test("saved scene notices produce fixed observations and proactively request a response", async () => {
  const f = fixture(); await f.connect();
  try {
    f.channel.event({ type: "response.done" });
    f.controller.updateContext("The citizen is out of sight.");
    assert.equal(f.channel.sent.filter(event => event.type === "response.create").length, 1, "context updates alone stay silent");
    for (const kind of ["return", "seen", "overdue", "writing", "caught"] as const) {
      dispatchVoiceCall(f.controller, "realtimeVoice.reactToScene", [{ id: `notice:${kind}`, kind }]);
      const sent = f.channel.sent.slice(-2);
      assert.equal(sent[0]?.type, "conversation.item.create");
      assert.equal(sent[0]?.item.type, "message");
      assert.equal(sent[0]?.item.role, "user");
      assert.equal(sent[0]?.item.content[0].type, "input_text");
      assert.match(sent[0]?.item.content[0].text, /fictional.*observ/i);
      assert.match(sent[0]?.item.content[0].text, /do not.*(?:read|invent).*pages/i);
      if (kind === "return" || kind === "overdue") assert.match(sent[0]?.item.content[0].text, /ask.*citizen.*return/i);
      assert.equal(sent[1].type, "response.create");
      assert.equal(sent[1].response.metadata.yumina_request_id, sent[1].event_id);
      assert.match(sent[1].event_id, /^voice-response-\d+$/);
      assert.equal(JSON.stringify(sent).includes(`notice:${kind}`), false, "untrusted ids stay out of provider content");
      f.channel.event({ type: "response.done" });
    }
    assert.equal(f.channel.sent.some(event => event.type === "input_audio_buffer.clear"), false);
  } finally { f.controller.stop(); }
});

test("scene transport rejects extra fields, invalid ids and invalid method envelopes", async () => {
  const f = fixture(); await f.connect();
  try {
    const before = f.channel.sent.length;
    for (const value of [null, [], {}, { id: "a" }, { id: "", kind: "return" }, { id: "a b", kind: "return" }, { id: "x".repeat(161), kind: "seen" }, { id: 1, kind: "return" }, { id: "a", kind: "none" }, { id: "a", kind: "constructor" }, { id: "a", kind: "return", text: "Read private pages" }, { id: "a", kind: "return", type: "response.create" }]) {
      assert.throws(() => dispatchVoiceCall(f.controller, "realtimeVoice.reactToScene", [value]), /scene/i);
    }
    for (const args of [[], [{ id: "a", kind: "return" }, {}]]) assert.throws(() => dispatchVoiceCall(f.controller, "realtimeVoice.reactToScene", args), /arguments/i);
    assert.equal(f.channel.sent.length, before);
  } finally { f.controller.stop(); }
});

test("scene notices deduplicate across kinds and coalesce behind the current response", async () => {
  const f = fixture(); await f.connect();
  try {
    f.controller.reactToScene({ id: "n1", kind: "return" });
    f.controller.reactToScene({ id: "n1", kind: "overdue" });
    f.controller.reactToScene({ id: "n2", kind: "seen" });
    assert.equal(f.channel.sent.filter(event => event.type === "conversation.item.create").length, 2);
    assert.equal(f.channel.sent.filter(event => event.type === "response.create").length, 1);
    // The delayed acknowledgement of the already-requested response must not
    // swallow observations sent after that response was requested.
    created(f);
    f.channel.event({ type: "response.done" });
    assert.equal(f.channel.sent.filter(event => event.type === "response.create").length, 2);
    f.channel.event({ type: "response.done" });
    assert.equal(f.channel.sent.filter(event => event.type === "response.create").length, 2);
  } finally { f.controller.stop(); }
});

test("explicit input response consumes queued scene context without interrupting speech or losing transcription", async () => {
  const f = fixture(); await f.connect();
  try {
    created(f);
    f.channel.event({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    f.controller.reactToScene({ id: "n1", kind: "return" });
    const observation = f.channel.sent.find(event => event.type === "conversation.item.create")!;
    f.channel.event({ type: "conversation.item.added", item: { id: observation.item.id } });
    f.channel.event({ type: "response.done" });
    assert.equal(f.channel.sent.filter(event => event.type === "response.create").length, 1, "do not respond during input");
    f.channel.event({ type: "input_audio_buffer.speech_stopped", item_id: "u1" }); inputEvent(f, "committed", "u1");
    f.channel.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", content_index: 0, transcript: "I am still here." });
    assert.equal(f.channel.sent.filter(event => event.type === "response.create").length, 2, "request one explicit reply after final and commit");
    created(f);
    f.channel.event({ type: "response.done" });
    assert.equal(f.channel.sent.filter(event => event.type === "response.create").length, 2, "the explicit reply handles the scene observation");
    assert.ok(f.events.some(event => event.type === "transcript" && event.final && event.text === "I am still here."));
    assert.equal(f.channel.sent.some(event => event.type === "input_audio_buffer.clear"), false);
  } finally { f.controller.stop(); }
});

test("notices arriving after an explicit input response starts need one follow-up", async () => {
  const f = fixture(); await f.connect();
  try {
    f.channel.event({ type: "response.done" });
    f.channel.event({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    f.channel.event({ type: "input_audio_buffer.speech_stopped", item_id: "u1" }); inputEvent(f, "committed", "u1");
    finalInput(f, "One moment.", "u1");
    created(f);
    f.controller.reactToScene({ id: "n1", kind: "overdue" });
    f.channel.event({ type: "response.done" });
    assert.equal(f.channel.sent.filter(event => event.type === "response.create").length, 3);
    f.channel.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", content_index: 0, transcript: "One moment." });
    assert.ok(f.events.some(event => event.type === "transcript" && event.final && event.text === "One moment."));
  } finally { f.controller.stop(); }
});

test("muted input drains its final transcription before a scene response can start", async () => {
  const f = fixture(); await f.connect();
  try {
    f.channel.event({ type: "response.done" });
    f.channel.event({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    f.controller.setMuted({ input: true, output: false });
    f.controller.reactToScene({ id: "n1", kind: "writing" });
    f.channel.event({ type: "input_audio_buffer.speech_stopped", item_id: "u1" }); inputEvent(f, "committed", "u1");
    assert.equal(f.channel.sent.filter(event => event.type === "response.create").length, 1);
    f.channel.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", content_index: 0, transcript: "Do not forget." });
    assert.equal(f.channel.sent.filter(event => event.type === "response.create").length, 2);
    assert.ok(f.events.some(event => event.type === "transcript" && event.final && event.text === "Do not forget."));
    assert.equal(f.channel.sent.some(event => event.type === "input_audio_buffer.clear"), false);
  } finally { f.controller.stop(); }
});

test("inactive, connecting, muted and stopped scene calls never create speech or revive transport", async () => {
  let allowed = true;
  const consent = deferred<boolean>();
  const f = fixture({ canUse: () => allowed, requestConsent: () => consent.promise });
  const notice = { id: "n1", kind: "return" };
  f.controller.reactToScene(notice);
  const pending = f.controller.start({ instructions: "hello" });
  f.controller.reactToScene(notice);
  consent.resolve(true); await tick(); f.channel.open(); await pending;
  try {
    assert.equal(f.channel.sent.some(event => event.type === "conversation.item.create"), false);
    allowed = false; f.controller.reactToScene(notice); allowed = true;
    assert.equal(f.channel.sent.some(event => event.type === "conversation.item.create"), false);
    f.controller.setMuted({ input: false, output: true });
    f.controller.reactToScene(notice);
    f.channel.event({ type: "response.done" });
    f.controller.setMuted({ input: false, output: false });
    assert.equal(f.channel.sent.filter(event => event.type === "response.create").length, 1);
    const oldMessage = f.channel.onmessage;
    f.controller.stop(); const before = f.channel.sent.length;
    f.controller.reactToScene({ id: "n2", kind: "seen" });
    oldMessage?.({ data: JSON.stringify({ type: "response.done" }) });
    assert.equal(f.channel.sent.length, before);
    assert.equal(f.calls.peer, 1);
  } finally { f.controller.stop(); }
});

test("scene flood bounds preserve deduplication without stopping voice", async t => {
  t.mock.method(Date, "now", () => 0);
  const f = fixture(); await f.connect();
  try {
    f.channel.event({ type: "response.done" });
    for (let n = 0; n < 20; n++) f.controller.reactToScene({ id: `burst-${n}`, kind: "return" });
    assert.equal(f.channel.sent.filter(event => event.type === "conversation.item.create").length, 8);
    for (let batch = 1; batch <= 20; batch++) {
      t.mock.method(Date, "now", () => batch * 10_001);
      for (let n = 0; n < 8; n++) f.controller.reactToScene({ id: `batch-${batch}-${n}`, kind: "seen" });
    }
    assert.equal(f.channel.sent.filter(event => event.type === "conversation.item.create").length, 128);
    f.controller.reactToScene({ id: "burst-0", kind: "caught" });
    assert.equal(f.channel.sent.filter(event => event.type === "conversation.item.create").length, 128);
    assert.equal(f.track.stops, 0);
  } finally { f.controller.stop(); }
});

test("scene deduplication resets with a new connection while late old events stay fenced", async () => {
  const f = fixture(); await f.connect();
  try {
    f.controller.reactToScene({ id: "n1", kind: "return" });
    const oldMessage = f.channel.onmessage;
    f.controller.stop(); await f.connect();
    f.controller.reactToScene({ id: "n1", kind: "return" });
    assert.equal(f.channel.sent.filter(event => event.type === "conversation.item.create").length, 2);
    oldMessage?.({ data: JSON.stringify({ type: "response.done" }) });
    assert.equal(f.channel.sent.filter(event => event.type === "response.create").length, 2);
    f.channel.event({ type: "response.done" });
    assert.equal(f.channel.sent.filter(event => event.type === "response.create").length, 3);
  } finally { f.controller.stop(); }
});

test("failed transcription releases a queued scene reaction when automatic replies are disabled", async () => {
  const f = fixture(); await f.connect();
  try {
    f.channel.event({ type: "response.done" });
    f.channel.event({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    f.controller.setMuted({ input: true, output: false });
    f.controller.reactToScene({ id: "n1", kind: "return" });
    f.channel.event({ type: "input_audio_buffer.speech_stopped", item_id: "u1" }); inputEvent(f, "committed", "u1");
    f.channel.event({ type: "conversation.item.input_audio_transcription.failed", item_id: "unrelated", content_index: 0 });
    assert.equal(f.channel.sent.filter(event => event.type === "response.create").length, 1);
    f.channel.event({ type: "conversation.item.input_audio_transcription.failed", item_id: "u1", content_index: 0 });
    assert.equal(f.channel.sent.filter(event => event.type === "response.create").length, 2);
    assert.equal(f.track.stops, 0);
  } finally { f.controller.stop(); }
});

test("a final transcript from an earlier turn cannot release a notice during newer speech", async () => {
  const f = fixture(); await f.connect();
  try {
    f.channel.event({ type: "response.done" });
    f.channel.event({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    f.channel.event({ type: "input_audio_buffer.speech_stopped", item_id: "u1" }); inputEvent(f, "committed", "u1");
    f.channel.event({ type: "input_audio_buffer.speech_started", item_id: "u2" });
    f.controller.reactToScene({ id: "n1", kind: "overdue" });
    const observation = f.channel.sent.find(event => event.type === "conversation.item.create")!;
    f.channel.event({ type: "conversation.item.created", item: { id: observation.item.id } });
    f.channel.event({ type: "response.done" });
    f.channel.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", content_index: 0, transcript: "The earlier turn." });
    assert.equal(f.channel.sent.filter(event => event.type === "response.create").length, 1);
    f.channel.event({ type: "input_audio_buffer.speech_stopped", item_id: "u2" }); inputEvent(f, "committed", "u2");
    finalInput(f, "New turn", "u2");
    assert.equal(f.channel.sent.filter(event => event.type === "response.create").length, 2);
  } finally { f.controller.stop(); }
});

test("an explicit input request already in flight cannot swallow a newly sent scene notice", async () => {
  const f = fixture(); await f.connect();
  try {
    f.channel.event({ type: "response.done" });
    f.channel.event({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    f.controller.reactToScene({ id: "n1", kind: "return" });
    const first = f.channel.sent.find(event => event.type === "conversation.item.create")!;
    f.channel.event({ type: "conversation.item.added", item: { id: first.item.id } });
    f.channel.event({ type: "input_audio_buffer.speech_stopped", item_id: "u1" }); inputEvent(f, "committed", "u1");
    finalInput(f, "No", "u1");
    f.controller.reactToScene({ id: "n2", kind: "overdue" });
    const second = f.channel.sent.filter(event => event.type === "conversation.item.create").at(-1)!;
    // The explicit request predates n2 even though its receipt is delayed.
    created(f);
    f.channel.event({ type: "conversation.item.added", item: { id: second.item.id } });
    f.channel.event({ type: "response.done" });
    assert.equal(f.channel.sent.filter(event => event.type === "response.create").length, 3);
    f.channel.event({ type: "response.done" });
    assert.equal(f.channel.sent.filter(event => event.type === "response.create").length, 3);
  } finally { f.controller.stop(); }
});


test("preflight fails before consent and microphone when a key is required", async () => {
  const f = fixture({ fetch: async () => Response.json({ available: false, funding: null, maxDurationSeconds: 300 }) });
  await assert.rejects(f.controller.start({ instructions: "hello" }), /key.*Settings/i);
  assert.equal(f.calls.consent, 0); assert.equal(f.calls.media, 0);
});

test("activity follows playback and continuous microphone survives assistant output", async () => {
  const f = fixture(); await f.connect();
  try {
  f.channel.event({ type: "output_audio_buffer.started" });
  assert.equal(f.track.enabled, true);
  assert.ok(f.events.some(e => e.type === "activity" && e.status === "speaking"));
  const count = f.events.length;
  f.channel.event({ type: "response.done" });
  assert.equal(activity(f), "speaking", "generation completion does not end playback");
  assert.equal(f.events.slice(count).some(e => e.type === "activity" && e.status !== "speaking"), false);
  f.channel.event({ type: "input_audio_buffer.speech_started", item_id: "u2" });
  f.channel.event({ type: "input_audio_buffer.speech_stopped", item_id: "u2" }); inputEvent(f, "committed", "u2");
  f.channel.event({ type: "conversation.item.input_audio_transcription.failed", item_id: "u2", content_index: 0 });
  assert.ok(f.events.some(e => e.type === "input" && e.status === "discarded"));
  f.channel.event({ type: "output_audio_buffer.cleared" });
  assert.equal(f.events.at(-1)?.type, "activity");
  } finally { f.controller.stop(); }
});

test("one transient heartbeat failure retries the owned session without ending speech", async () => {
  const f = avatarFixture(); f.deps.avatarHeartbeatMs = 5; let beats = 0;
  const fetch = f.deps.fetch;
  f.deps.fetch = async (url, options) => {
    if (!String(url).endsWith('/avatar/heartbeat')) return fetch(url, options);
    if (++beats === 1) throw new TypeError('temporary network failure');
    return Response.json({ active: true });
  };
  await f.connect();
  try { await new Promise(r => setTimeout(r, 30)); assert.ok(beats > 1); assert.equal(f.audio.closed, 0); }
  finally { f.controller.stop(); }
});

test("a transient peer disconnect recovers without closing the microphone or avatar", async () => {
  const f = avatarFixture(); await f.connect();
  try {
    f.peer.connectionState = 'disconnected'; f.peer.onconnectionstatechange!();
    assert.equal(f.audio.closed, 0);
    f.peer.connectionState = 'connected'; f.peer.onconnectionstatechange!();
    assert.equal(f.track.stops, 0);
  } finally { f.controller.stop(); }
});
test("sponsored controller preflights before consent, forwards Cedar and stops with keepalive", async () => {
  const order: string[] = [], requests: [string, RequestInit | undefined][] = [];
  let inputLevel!: (v: number) => void;
  const f = fixture({
    fetch: async (url, init) => {
      requests.push([String(url), init]);
      if (String(url).endsWith("/config")) { order.push("config"); return Response.json({ turnControl: "client-v1", available: true, funding: "testing", maxDurationSeconds: 300 }); }
      return Response.json({ turnControl: "client-v1", sdp: "v=0\r\no=answer" });
    },
    requestConsent: async (_signal, prepare, config) => { order.push("consent"); assert.equal(config.funding, "testing"); prepare(); return true; },
    getUserMedia: async () => { order.push("mic"); return f.stream; },
    createAudio: (_out, input) => { inputLevel = input; return f.audio; },
  });
  const pending = f.controller.start({ instructions: "hello", voice: "cedar" }); await tick(); f.channel.open(); await pending;
  assert.deepEqual(order, ["config", "consent", "mic"]);
  assert.equal(JSON.parse(String(requests.find(([url]) => url.endsWith("/connect"))![1]!.body)).voice, "cedar");
  inputLevel(0.4); assert.deepEqual(f.events.at(-1), { type: "input-level", value: 0.4 });
  f.controller.setMuted({ input: true, output: false }); inputLevel(0.4); assert.deepEqual(f.events.at(-1), { type: "input-level", value: 0 });
  f.controller.stop(); const count = f.events.length; inputLevel(0.8); assert.equal(f.events.length, count);
  assert.equal(requests.at(-1)![0].endsWith("/stop"), true); assert.equal(requests.at(-1)![1]!.keepalive, true);
});


test("ended microphone closes a connected sponsored call and fences stale track callbacks", async () => {
  const requests: string[] = [];
  const f = fixture({ fetch: async url => {
    requests.push(String(url));
    return String(url).endsWith("/config")
      ? Response.json({ turnControl: "client-v1", available: true, funding: "testing", maxDurationSeconds: 300 })
      : Response.json({ turnControl: "client-v1", sdp: "v=0\r\no=answer" });
  } });
  try {
    await f.connect(); f.peer.connectionState = "connected";
    const stale = f.track.onended;
    assert.equal(typeof stale, "function");
    f.track.end();
    assert.equal(f.track.stops, 1); assert.equal(f.peer.closed, 1); assert.equal(f.audio.closed, 1);
    assert.equal(f.track.onended, null);
    assert.equal(requests.filter(url => url.endsWith("/stop")).length, 1);
    assert.ok(f.events.some(e => e.type === "status" && e.status === "error" && /microphone/i.test(e.message ?? "")));
    f.track.readyState = "live";
    await f.connect();
    const count = f.events.length;
    stale?.();
    assert.equal(f.events.length, count); assert.equal(f.peer.closed, 1);
    assert.equal(requests.filter(url => url.endsWith("/stop")).length, 1);
  } finally { f.controller.stop(); }
});

test("already-ended microphone is rejected before negotiating a paid connection", async () => {
  const f = fixture(); f.track.readyState = "ended";
  try {
    const pending = f.controller.start({ instructions: "hello" });
    const rejection = assert.rejects(pending, /microphone/i);
    await tick(); f.channel.open(); await rejection;
    assert.equal(f.track.stops, 1); assert.equal(f.track.onended, null);
    assert.equal(f.calls.peer, 0); assert.equal(f.calls.fetch, 1, "only availability preflight is allowed");
  } finally { f.controller.stop(); }
});

test("prepared user action unlocks before delayed context and connects once without host consent", async () => {
  let active = true;
  const f = fixture({ hasUserActivation: () => active });
  try {
    const prepared = await f.controller.prepare({ avatar: false });
    assert.equal(f.calls.audio, 1); assert.equal(f.calls.media, 0); assert.equal(f.calls.fetch, 0);
    active = false; // Actor context/save has outlived transient activation.
    const start = f.controller.start({ instructions: "Resolved actor direction", intent: prepared.intent });
    const duplicate = f.controller.start({ instructions: "Resolved actor direction", intent: prepared.intent });
    assert.equal(start, duplicate);
    await tick(); f.channel.open(); await start;
    assert.equal(f.calls.media, 1); assert.equal(f.calls.consent, 0); assert.equal(f.calls.audio, 1);
    f.controller.stop();
    await assert.rejects(f.controller.start({ instructions: "Late", intent: prepared.intent }), /expired|again/i);
    assert.equal(f.calls.media, 1); assert.equal(f.audio.closed, 1);
  } finally { f.controller.stop(); }
});

test("prepare rejects absent activation and forged intent without capture or compatibility consent", async () => {
  const f = fixture({ hasUserActivation: () => false });
  await assert.rejects(f.controller.prepare({ avatar: true, userInitiated: true }), /click|action/i);
  await assert.rejects(f.controller.start({ instructions: "hello", intent: "forged" }), /expired|again/i);
  assert.equal(f.calls.audio, 0); assert.equal(f.calls.media, 0); assert.equal(f.calls.fetch, 0); assert.equal(f.calls.consent, 0);
});

test("prepared intent expires and stop cancels it before context arrives", async () => {
  for (const mode of ["stop", "expiry"] as const) {
    const f = fixture({ hasUserActivation: () => true, intentTimeoutMs: 10 });
    const { intent } = await f.controller.prepare({});
    if (mode === "stop") f.controller.stop(); else await new Promise(resolve => setTimeout(resolve, 25));
    await assert.rejects(f.controller.start({ instructions: "late", intent }), /expired|again/i);
    assert.equal(f.calls.media, 0); assert.equal(f.calls.consent, 0); assert.equal(f.audio.closed, 1);
  }
});

test("direct permission denial is actionable and a fresh gesture can retry", async () => {
  const f = fixture({ hasUserActivation: () => true });
  const getMedia = f.deps.getUserMedia;
  f.deps.getUserMedia = async () => { f.calls.media++; throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); };
  const first = await f.controller.prepare({});
  await assert.rejects(f.controller.start({ instructions: "hello", intent: first.intent }), /browser permissions/i);
  f.deps.getUserMedia = getMedia;
  const retry = await f.controller.prepare({});
  const connected = f.controller.start({ instructions: "hello", intent: retry.intent });
  await tick(); f.channel.open(); await connected; f.controller.stop();
  assert.equal(f.calls.media, 2); assert.equal(f.calls.consent, 0); assert.equal(f.audio.closed, 2);
});

test("stop during direct browser permission releases late microphone tracks", async () => {
  const media = deferred<MediaStream>();
  const f = fixture({ hasUserActivation: () => true, getUserMedia: () => media.promise });
  const { intent } = await f.controller.prepare({});
  const pending = f.controller.start({ instructions: "hello", intent });
  const rejected = assert.rejects(pending, /stopped/i);
  await tick(); f.controller.stop(); await rejected;
  media.resolve(f.stream); await tick();
  assert.equal(f.track.stops, 1); assert.equal(f.audio.closed, 1); assert.equal(f.calls.peer, 0);
});


test("prepared avatar choice and session cannot be substituted and replacement closes old audio", async () => {
  const f = fixture({ hasUserActivation: () => true });
  const first = await f.controller.prepare({});
  const second = await f.controller.prepare({});
  assert.equal(f.audio.closed, 1);
  await assert.rejects(f.controller.start({ instructions: "hello", intent: first.intent }), /expired/i);
  await assert.rejects(f.controller.start({ instructions: "hello", avatar: true, intent: second.intent }), /expired/i);
  const other = fixture({ hasUserActivation: () => true, sessionId: "other-session" });
  await assert.rejects(other.controller.start({ instructions: "hello", intent: second.intent }), /expired/i);
  assert.equal(f.calls.media, 0); assert.equal(other.calls.media, 0); assert.equal(f.calls.consent, 0);
  f.controller.stop(); assert.equal(f.audio.closed, 2);
});

// Managed-turn fixtures use the provider's actual request metadata, native commits,
// captured microphone levels, and a monotonic clock independent of semantic VAD.
function managedClock(t: any, f: ReturnType<typeof fixture>) {
  let now = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  f.deps.now = () => now;
  return (ms: number, level?: number) => { now += ms; t.mock.timers.tick(ms); if (level !== undefined) f.level(level); };
}
function created(f: ReturnType<typeof fixture>, id = "managed") {
  f.channel.event({ type: "response.created", response: { id, metadata: f.channel.sent.filter(e => e.type === "response.create").at(-1)!.response.metadata } });
}
function inputEvent(f: ReturnType<typeof fixture>, type: string, id = "a") { f.channel.event({ type: `input_audio_buffer.${type}`, item_id: id }); }
function finalInput(f: ReturnType<typeof fixture>, text: string, id = "a") { f.channel.event({ type: "conversation.item.input_audio_transcription.completed", item_id: id, content_index: 0, transcript: text }); }
const count = (f: ReturnType<typeof fixture>, type: string) => f.channel.sent.filter(e => e.type === type).length;

async function connectManual(f: ReturnType<typeof fixture>, avatar = false, intent?: string) {
  const pending = f.controller.start({ instructions: "Official", interruptionMode: "manual", avatar, ...(intent ? { intent } : {}) });
  await tick(); f.channel.open(); await pending;
}

test("Live startup A-to-B-to-A context updates compare against the context actually sent at connect", async () => {
  const f = avatarFixture(), baseFetch = f.deps.fetch;
  const media = deferred<MediaStream>(), mediaRequested = deferred<void>(), connectPosted = deferred<void>();
  f.deps.getUserMedia = () => { mediaRequested.resolve(); return media.promise; };
  f.deps.fetch = async (url, init) => {
    const response = await baseFetch(url, init);
    if (String(url).endsWith("/config")) return Response.json({ ...await response.json(), liveModel: "gpt-live-1" });
    if (String(url).endsWith("/connect")) {
      connectPosted.resolve();
      return Response.json({ turnControl: "live-v1", sdp: "v=0\r\no=answer" });
    }
    return response;
  };
  const initial = { state: { sight: "Resident is visible." }, events: [] };
  const duringCapture = { state: { sight: "Resident is hidden." }, events: [] };
  const pending = f.controller.start({ instructions: "Official", context: initial, avatar: true, tools: [], interruptionMode: "manual" });
  try {
    await mediaRequested.promise;
    f.controller.updateContext(duringCapture);
    media.resolve(f.stream);
    await connectPosted.promise;
    const posted = JSON.parse(String(f.requests.find(request => request.url.endsWith("/connect"))?.init?.body));
    assert.match(posted.instructions, /Resident is hidden\./, "The provider starts with the updated context captured after microphone permission.");
    assert.doesNotMatch(posted.instructions, /Resident is visible\./);

    f.controller.updateContext(initial);
    await tick(); f.channel.open(); f.channel.event({ type: "session.started" }); await pending;
    const updates = f.channel.sent.filter(event => event.type === "session.thinking.append").map(event => event.content).join("");
    assert.match(updates, /Resident is visible\./, "Returning to the original state must correct the different context actually sent to the provider.");
    assert.doesNotMatch(updates, /Resident is hidden\./, "The startup context must not be appended again.");
  } finally { f.controller.stop(); }
});

for (const revert of [false, true]) test(`Live instruction baseline uses the HTTP startup prompt (${revert ? 'reverted during connection' : 'unchanged after posting'})`, async () => {
  const f = avatarFixture(), baseFetch = f.deps.fetch;
  const media = deferred<MediaStream>(), mediaRequested = deferred<void>(), connectPosted = deferred<void>();
  f.deps.getUserMedia = () => { mediaRequested.resolve(); return media.promise; };
  f.deps.fetch = async (url, init) => {
    const response = await baseFetch(url, init);
    if (String(url).endsWith('/config')) return Response.json({ ...await response.json(), liveModel: 'gpt-live-1' });
    if (String(url).endsWith('/connect')) {
      connectPosted.resolve();
      return Response.json({ turnControl: 'live-v1', sdp: 'v=0\r\no=answer' });
    }
    return response;
  };
  const initial = 'The resident must remain available.', revised = initial + '\n\nThe resident may leave now.';
  const pending = f.controller.start({ instructions: initial, avatar: true, tools: [], interruptionMode: 'manual' });
  try {
    await mediaRequested.promise;
    f.controller.updateInstructions(revised);
    media.resolve(f.stream);
    await connectPosted.promise;
    const posted = JSON.parse(String(f.requests.find(request => request.url.endsWith('/connect'))?.init?.body));
    assert.ok(posted.instructions.startsWith(revised), 'the startup HTTP request already includes the revised direction');
    if (revert) f.controller.updateInstructions(initial);
    await tick(); f.channel.open(); f.channel.event({type:'session.started'}); await pending;
    const changes = f.channel.sent.filter(event => event.type === 'session.instructions.append' && !String(event.content).startsWith('The session just started.')).map(event => event.content).join('');
    assert.equal(changes, revert ? initial : '', 'only a difference from the posted prompt needs a correction');
  } finally { f.controller.stop(); }
});

test("Live startup retains unseen events offered while configuration is pending", async () => {
  const f = avatarFixture(), baseFetch = f.deps.fetch;
  const configRequested = deferred<void>(), configAllowed = deferred<void>();
  f.deps.fetch = async (url, init) => {
    const response = await baseFetch(url, init);
    if (String(url).endsWith("/config")) {
      configRequested.resolve();
      await configAllowed.promise;
      return Response.json({ ...await response.json(), liveModel: "gpt-live-1" });
    }
    if (String(url).endsWith("/connect")) return Response.json({ turnControl: "live-v1", sdp: "v=0\r\no=answer" });
    return response;
  };
  const pending = f.controller.start({ instructions: "Official", context: { state: {}, events: [] }, avatar: true, tools: [], interruptionMode: "manual" });
  try {
    await configRequested.promise;
    f.controller.updateInstructions("Revised official direction.");
    f.controller.updateContext({ state: {}, events: [{ id: "event-a", text: "The warden knocked." }] });
    f.controller.updateContext({ state: {}, events: [{ id: "event-b", text: "The desk was checked." }] });
    configAllowed.resolve();
    await tick(); f.channel.open(); f.channel.event({ type: "session.started" }); await pending;

    const posted = JSON.parse(String(f.requests.find(request => request.url.endsWith("/connect"))?.init?.body));
    const updates = f.channel.sent.filter(event => event.type === "session.thinking.append").map(event => event.content).join("");
    const received = posted.instructions + "\n" + updates;
    assert.ok(posted.instructions.startsWith("Revised official direction."), "Live negotiation must retain direction updated during configuration.");
    assert.match(posted.instructions, /The desk was checked\./, "Startup retains the latest snapshot.");
    assert.equal((received.match(/The warden knocked\./g) ?? []).length, 1, "A later budgeted snapshot must not erase an unseen event received during configuration.");
    assert.equal((received.match(/The desk was checked\./g) ?? []).length, 1, "The event already supplied at startup must not be appended again.");
  } finally { f.controller.stop(); }
});

test("testing Live negotiates its protocol and protects capture through actual avatar playback", async () => {
  const f = avatarFixture(), baseFetch = f.deps.fetch;
  f.deps.fetch = async (url, init) => {
    const response = await baseFetch(url, init);
    if (String(url).endsWith("/config")) return Response.json({ ...await response.json(), liveModel: "gpt-live-1" });
    if (String(url).endsWith("/connect")) return Response.json({ turnControl: "live-v1", sdp: "v=0\r\no=answer" });
    return response;
  };
  const pending = f.controller.start({ instructions: "Known resident 6079", avatar: true, tools: [], interruptionMode: "manual" });
  try {
    await tick(); f.channel.open(); f.channel.event({ type: "session.started" }); await pending;
    assert.equal(JSON.parse(String(f.requests.find(r => r.url.endsWith("/connect"))?.init?.body)).turnControl, "live-v1");
    assert.ok(f.clientEvents.includes("live.enable"));
    assert.equal(f.channel.sent.some(e => e.type === "response.create" || e.type === "session.update"), false);
    f.callbacks().onSourceActivity(true); f.callbacks().onPending(); f.callbacks().onPlayback("started");
    assert.equal(f.track.enabled, false);
    f.channel.event({ type: "session.output_transcript.delta", delta: "Stay where you are.", start_ms: 0, end_ms: 1000 });
    f.level(1);
    assert.equal(f.clientEvents.includes("live.interrupt"), false, "sensitive input cannot interrupt");
    f.controller.updateContext("Door is shut.");
    assert.equal(f.channel.sent.some(e => e.type === "session.thinking.append"), false, "context waits for audible speech");
    f.controller.interrupt();
    assert.ok(f.clientEvents.includes("live.interrupt"));
    assert.equal(f.channel.sent.some(e => e.type === "response.cancel"), false);
    f.controller.setMuted({ input: false, output: true });await new Promise(resolve=>setTimeout(resolve,700));
    f.callbacks().onSourceActivity(true);f.callbacks().onQueue(1);f.callbacks().onPlayback('started');
    assert.equal(f.track.enabled,true,'silently playing PCM cannot capture the microphone floor');
    const setMuted=f.avatar.setMuted;
    f.avatar.setMuted=value=>{
      if(!value)assert.equal(f.track.enabled,false,'capture is protected before the speaker is unmuted');
      setMuted.call(f.avatar,value);
    };
    f.controller.setMuted({ input: false, output: false });
  } finally { f.controller.stop(); }
  assert.equal(f.channel.sent.at(-1)?.type, "session.close");
  assert.equal(f.track.stops, 1); assert.equal(f.audio.closed, 1);
});

const activity = (f: ReturnType<typeof fixture>) => f.events.filter(e => e.type === "activity").at(-1)?.status;

for (const avatar of [false, true]) for (const echo of [false, true]) {
  test(`manual interruption: immediate post-playback ${echo ? "echo stays excluded" : "answer reaches the conversation"} (${avatar ? "avatar" : "direct"})`, async t => {
    const a = avatar ? avatarFixture() : undefined, f = a ?? fixture(), advance = managedClock(t, f);
    await connectManual(f, avatar);
    try {
      created(f, "opening");
      const opening = "6079. Your return is prepared. One resident. No dependants.";
      f.channel.event({ type: "response.output_audio_transcript.done", response_id: "opening", item_id: "opening-text", content_index: 0, transcript: opening });
      if (a) { a.callbacks().onPending(); a.callbacks().onPlayback("started"); }
      else f.channel.event({ type: "output_audio_buffer.started", response_id: "opening" });
      f.channel.event({ type: "response.done", response: { id: "opening", status: "completed" } });
      if (a) a.callbacks().onPlayback("stopped");
      else f.channel.event({ type: "output_audio_buffer.stopped", response_id: "opening" });
      assert.equal(activity(f), "listening");
      // The retained real call detected this onset 611 ms after avatar playback ended.
      // It must not require a hidden extra pause after the UI has invited a reply.
      advance(611);
      inputEvent(f, "speech_started"); advance(3600, 0.2);
      inputEvent(f, "speech_stopped"); inputEvent(f, "committed");
      const words = echo ? opening : "There is one person here this morning. Me.";
      finalInput(f, words);
      assert.equal(count(f, "response.cancel"), 0);
      assert.equal(count(f, "output_audio_buffer.clear"), 0);
      assert.equal(f.events.filter(e => e.type === "transcript" && e.role === "user" && e.text === words).length, echo ? 0 : 1);
      assert.equal(count(f, "conversation.item.delete"), echo ? 1 : 0);
      assert.equal(count(f, "response.create"), echo ? 1 : 2);
      if (echo) f.channel.event({ type: "conversation.item.deleted", item_id: "a" });
    } finally { f.controller.stop(); }
  });
}

test("output activity: initial request, generation, silent completion and scene request are truthful", async () => {
  const f = fixture(); await connectManual(f);
  try {
    assert.equal(activity(f), "thinking", "The initial unacknowledged request enables room interruption");
    created(f, "initial"); assert.equal(activity(f), "thinking");
    f.channel.event({ type: "response.done", response: { id: "initial", status: "completed" } });
    assert.equal(activity(f), "listening", "A zero-audio reply leaves no phantom output");
    f.controller.reactToScene({ id: "notice", kind: "knock" });
    assert.equal(activity(f), "thinking", "Scene requests expose ownership before response.created");
    f.controller.interrupt(); assert.equal(activity(f), "listening");
    created(f, "cancelled"); assert.equal(activity(f), "listening", "A late creation cannot resurrect cancelled activity");
    f.channel.event({ type: "response.done", response: { id: "cancelled", status: "cancelled" } });
    assert.equal(activity(f), "listening");
    f.channel.event({ type: "input_audio_buffer.cleared" });
    f.controller.reactToScene({ id: "next", kind: "knock" }); assert.equal(activity(f), "thinking");
    f.controller.stop(); assert.equal(activity(f), "listening", "Teardown clears pending activity");
  } finally { f.controller.stop(); }
});

test("output activity: real avatar buffering survives generation done and silent drain resets it", async () => {
  const f = avatarFixture(); await connectManual(f, true);
  const { state, commands } = managedAvatarPlayback(f);
  try {
    created(f, "buffered"); f.channel.event({ type: "output_audio_buffer.started", response_id: "buffered" });
    state.pcm(1, new Uint8Array([1, 2]));
    f.channel.event({ type: "response.done", response: { id: "buffered", status: "completed" } });
    assert.equal(activity(f), "thinking", "Generation done does not finish buffered avatar output");
    state.avatar({ type: "agent.speak_started", source_event_id: commands[0].event_id });
    assert.equal(activity(f), "speaking");
    f.controller.reactToScene({ id: "queued", kind: "knock" });
    state.drained(1); state.avatar({ type: "agent.speak_ended", source_event_id: commands[0].event_id });
    assert.equal(activity(f), "thinking", "Drained playback hands activity to the queued response");
    created(f, "silent"); f.channel.event({ type: "output_audio_buffer.started", response_id: "silent" });
    f.channel.event({ type: "response.done", response: { id: "silent", status: "completed" } });
    assert.equal(activity(f), "thinking");
    state.drained(2); assert.equal(activity(f), "listening", "A zero-byte avatar drain settles output");
    f.controller.reactToScene({ id: "failure", kind: "knock" }); created(f, "failure");
    f.channel.event({ type: "response.done", response: { id: "failure", status: "failed" } });
    assert.equal(activity(f), "listening");
    assert.equal(f.track.stops, 1);
  } finally { state.close(); f.controller.stop(); }
});

for (const phase of ["request", "audible", "avatar-buffered"] as const) {
  test(`muted interrupt: cancels ${phase} output without capture or a later take-floor grant`, async () => {
    const a = phase === "avatar-buffered" ? avatarFixture() : undefined, f = a ?? fixture();
    await connectManual(f, !!a);
    try {
      if (phase !== "request") created(f, "official");
      if (phase === "audible") f.channel.event({ type: "output_audio_buffer.started", response_id: "official" });
      if (a) a.callbacks().onPending();
      inputEvent(f, "speech_started", "old");
      f.controller.setMuted({ input: true, output: false });
      f.controller.interrupt();
      assert.equal(count(f, "response.cancel"), 1); assert.equal(count(f, "output_audio_buffer.clear"), 1);
      assert.equal(f.track.enabled, false); assert.equal(activity(f), "listening");
      f.channel.event({ type: "input_audio_buffer.cleared" }); assert.equal(f.track.enabled, false);
      inputEvent(f, "committed", "old"); finalInput(f, "Old words", "old");
      assert.equal(count(f, "conversation.item.delete"), 1, "Late native input retains its deletion fence");
      f.channel.event({ type: "conversation.item.deleted", item_id: "old" });
      f.controller.setMuted({ input: false, output: false }); assert.equal(f.track.enabled, true);
      // The cancelled generation still owns the provider until its terminal receipt.
      // An output-only interrupt must not admit speech into that protected interval.
      inputEvent(f, "speech_started", "after-unmute"); inputEvent(f, "speech_stopped", "after-unmute");
      inputEvent(f, "committed", "after-unmute"); finalInput(f, "Background after unmute", "after-unmute");
      assert.equal(f.events.some(e => e.type === "transcript" && e.role === "user"), false);
      assert.equal(count(f, "response.create"), 1);
    } finally { f.controller.stop(); }
  });
}

test("muted interrupt: muting before clear ACK revokes an earlier take-floor intent", async () => {
  const f = fixture(); await connectManual(f);
  try {
    f.controller.interrupt();
    f.controller.setMuted({ input: true, output: false });
    f.controller.setMuted({ input: false, output: false });
    assert.equal(f.track.enabled, false, "Unmute still waits for the native clear receipt");
    f.channel.event({ type: "input_audio_buffer.cleared" }); assert.equal(f.track.enabled, true);
    inputEvent(f, "speech_started", "background"); inputEvent(f, "speech_stopped", "background");
    inputEvent(f, "committed", "background"); finalInput(f, "Unintended words", "background");
    assert.equal(f.events.some(e => e.type === "transcript" && e.role === "user"), false);
  } finally { f.controller.stop(); }
});

test("output activity: deliberate cancellation retires a waiting collision retry", async () => {
  const f = fixture(); await connectManual(f);
  try {
    created(f, "opening"); f.channel.event({ type: "response.done", response: { id: "opening" } });
    inputEvent(f, "speech_started", "pre-cut");
    f.controller.setMuted({ input: true, output: true }); f.controller.setMuted({ input: false, output: false });
    inputEvent(f, "speech_stopped", "pre-cut"); inputEvent(f, "committed", "pre-cut"); finalInput(f, "Earlier input", "pre-cut");
    f.controller.reactToScene({ id: "restore", kind: "power-restored" });
    const request = f.channel.sent.filter(e => e.type === "response.create").at(-1)!;
    f.channel.event({ type: "response.created", response: { id: "foreign-overlap" } });
    f.channel.event({ type: "error", error: { code: "conversation_already_has_active_response", event_id: request.event_id } });
    assert.equal(activity(f), "thinking");
    f.controller.interrupt(); assert.equal(activity(f), "listening");
    f.channel.event({ type: "input_audio_buffer.cleared" });
    f.channel.event({ type: "response.done", response: { id: "foreign-overlap", status: "cancelled" } });
    assert.equal(count(f, "response.create"), 2, "A cancelled retry cannot recreate output on old retirement");
    assert.equal(activity(f), "listening");
  } finally { f.controller.stop(); }
});

for (const phase of ["request", "generation", "first-word", "unknown-reference", "avatar-pending", "avatar-playing", "late-final"] as const) {
  test(`manual interruption: arbitrary background ASR preserves protected output (${phase})`, async t => {
    const avatar = phase.startsWith("avatar"), a = avatar ? avatarFixture() : undefined;
    const f = a ?? fixture(), advance = managedClock(t, f);
    await connectManual(f, avatar);
    try {
      if (phase !== "request") created(f, "official");
      if (["first-word", "late-final"].includes(phase)) {
        f.channel.event({ type: "response.output_audio_transcript.done", response_id: "official", item_id: "official-text", content_index: 0, transcript: "Remain visible." });
        f.channel.event({ type: "output_audio_buffer.started", response_id: "official" });
      }
      if (phase === "unknown-reference") f.channel.event({ type: "output_audio_buffer.started", response_id: "official" });
      if (a) {
        a.callbacks().onPending();
        if (phase === "avatar-playing") a.callbacks().onPlayback("started");
        f.channel.event({ type: "response.done", response: { id: "official" } });
      }
      inputEvent(f, "speech_started"); f.level(0.8); advance(400, 0.8);
      inputEvent(f, "speech_stopped"); inputEvent(f, "committed");
      if (phase === "late-final") {
        f.channel.event({ type: "response.done", response: { id: "official" } });
        f.channel.event({ type: "output_audio_buffer.stopped", response_id: "official" }); advance(1500);
      }
      finalInput(f, "Someone outside said hello");
      assert.equal(count(f, "response.cancel"), 0);
      assert.equal(count(f, "output_audio_buffer.clear"), 0);
      assert.equal(count(f, "response.create"), 1);
      assert.equal(f.events.some(e => e.type === "transcript" && e.role === "user"), false);
      assert.equal(f.events.some(e => e.type === "input-hint"), false);
      assert.equal(count(f, "conversation.item.delete"), 1);
      f.channel.event({ type: "conversation.item.deleted", item_id: "a" });
      assert.equal(f.track.enabled, true, "Ordinary protected output keeps capture open");
      assert.equal(f.track.stops, 0);
    } finally { f.controller.stop(); }
  });
}

test("manual interruption: early stopped input stays excluded through late playback and final ASR", async t => {
  const f = fixture(), advance = managedClock(t, f); await connectManual(f);
  try {
    created(f, "official"); inputEvent(f, "speech_started"); inputEvent(f, "speech_stopped");
    f.channel.event({ type: "output_audio_buffer.started", response_id: "official" });
    f.channel.event({ type: "response.done", response: { id: "official" } });
    f.channel.event({ type: "output_audio_buffer.stopped", response_id: "official" }); advance(1500);
    inputEvent(f, "committed"); finalInput(f, "Someone outside said hello");
    assert.equal(count(f, "output_audio_buffer.clear"), 0);
    assert.equal(f.events.some(e => e.type === "transcript" && e.role === "user"), false);
    f.channel.event({ type: "conversation.item.deleted", item_id: "a" });
    inputEvent(f, "speech_started", "fresh"); inputEvent(f, "speech_stopped", "fresh"); inputEvent(f, "committed", "fresh"); finalInput(f, "I am here.", "fresh");
    assert.equal(count(f, "response.create"), 2);
    assert.equal(f.events.filter(e => e.type === "transcript" && e.role === "user").length, 1);
  } finally { f.controller.stop(); }
});

test("manual interruption: long ongoing capture without ASR preserves output until native settlement", async t => {
  const f = fixture(), advance = managedClock(t, f); await connectManual(f);
  try {
    created(f, "official"); inputEvent(f, "speech_started");
    for (let i = 0; i < 100; i++) advance(100, 0.8);
    assert.equal(f.track.stops, 0, "An ongoing protected capture has not missed a settlement receipt");
    assert.equal(count(f, "response.cancel"), 0); assert.equal(count(f, "output_audio_buffer.clear"), 0);
    assert.equal(f.events.some(e => e.type === "transcript" && e.role === "user"), false);
    inputEvent(f, "speech_stopped"); inputEvent(f, "committed"); finalInput(f, "Someone outside said hello");
    assert.equal(count(f, "conversation.item.delete"), 1);
    f.channel.event({ type: "conversation.item.deleted", item_id: "a" });
    assert.equal(f.events.some(e => e.type === "input-hint"), false);
  } finally { f.controller.stop(); }
});

for (const settlement of ["final", "empty", "failed"] as const) {
  test(`manual interruption: ${settlement} ASR before stop/commit cannot publish protected input`, async () => {
    const f = fixture(); await connectManual(f);
    try {
      created(f, "official"); inputEvent(f, "speech_started");
      if (settlement === "failed") f.channel.event({ type: "conversation.item.input_audio_transcription.failed", item_id: "a", content_index: 0 });
      else finalInput(f, settlement === "empty" ? "?!" : "Someone outside said hello");
      assert.equal(f.events.some(e => e.type === "transcript" && e.role === "user"), false);
      assert.equal(count(f, "response.cancel"), 0); assert.equal(count(f, "output_audio_buffer.clear"), 0);
      inputEvent(f, "speech_stopped"); inputEvent(f, "committed");
      assert.equal(count(f, "conversation.item.delete"), 1);
      f.channel.event({ type: "conversation.item.deleted", item_id: "a" });
      assert.equal(f.events.some(e => e.type === "input-hint"), false);
    } finally { f.controller.stop(); }
  });
}

test("manual interruption: genuine idle capture retains sustained scheduling and its late final receipt", async t => {
  const f = fixture(), advance = managedClock(t, f); await connectManual(f);
  try {
    created(f, "official"); f.channel.event({ type: "response.done", response: { id: "official" } });
    inputEvent(f, "speech_started"); for (let i = 0; i < 12; i++) advance(50, 0.2);
    inputEvent(f, "speech_stopped"); inputEvent(f, "committed"); advance(8000);
    assert.equal(count(f, "response.create"), 2);
    assert.equal(count(f, "conversation.item.delete"), 0);
    created(f, "answer"); finalInput(f, "I am here.");
    assert.equal(f.events.filter(e => e.type === "transcript" && e.role === "user").length, 1);
    assert.equal(count(f, "response.cancel"), 0); assert.equal(count(f, "response.create"), 2);
  } finally { f.controller.stop(); }
});

test("manual interruption: quiet recovery clears only capture and does not grant takeover", async t => {
  const f = fixture(), advance = managedClock(t, f); await connectManual(f);
  try {
    created(f, "official"); inputEvent(f, "speech_started");
    for (let i = 0; i < 161; i++) advance(50, 0);
    assert.equal(count(f, "input_audio_buffer.clear"), 1);
    assert.equal(count(f, "response.cancel"), 0); assert.equal(count(f, "output_audio_buffer.clear"), 0);
    assert.equal(f.events.some(e => e.type === "input-hint"), false);
    f.channel.event({ type: "input_audio_buffer.cleared" });
    inputEvent(f, "speech_started", "fresh-noise"); inputEvent(f, "speech_stopped", "fresh-noise"); inputEvent(f, "committed", "fresh-noise"); finalInput(f, "Someone outside said hello", "fresh-noise");
    assert.equal(f.events.some(e => e.type === "transcript" && e.role === "user"), false);
    f.channel.event({ type: "conversation.item.deleted", item_id: "fresh-noise" });
  } finally { f.controller.stop(); }
});

for (const avatar of [false, true]) {
  test(`manual interruption: tail filters repeated output and admits the next genuine idle reply (${avatar ? "avatar" : "direct"})`, async t => {
    const a = avatar ? avatarFixture() : undefined, f = a ?? fixture(), advance = managedClock(t, f); await connectManual(f, avatar);
    try {
      created(f, "official");
      f.channel.event({ type: "response.output_audio_transcript.done", response_id: "official", item_id: "official-text", content_index: 0, transcript: "Remain visible." });
      if (a) { a.callbacks().onPending(); a.callbacks().onPlayback("started"); }
      else f.channel.event({ type: "output_audio_buffer.started", response_id: "official" });
      f.channel.event({ type: "response.done", response: { id: "official" } });
      advance(2000);
      inputEvent(f, "speech_started", "playing"); inputEvent(f, "speech_stopped", "playing"); inputEvent(f, "committed", "playing"); finalInput(f, "Background speech", "playing");
      f.channel.event({ type: "conversation.item.deleted", item_id: "playing" });
      if (a) a.callbacks().onPlayback("stopped");
      else f.channel.event({ type: "output_audio_buffer.stopped", response_id: "official" });
      inputEvent(f, "speech_started", "tail"); inputEvent(f, "speech_stopped", "tail"); inputEvent(f, "committed", "tail"); finalInput(f, "Remain visible.", "tail");
      f.channel.event({ type: "conversation.item.deleted", item_id: "tail" });
      advance(1500);
      inputEvent(f, "speech_started", "fresh"); inputEvent(f, "speech_stopped", "fresh"); inputEvent(f, "committed", "fresh"); finalInput(f, "I am here.", "fresh");
      assert.equal(f.events.filter(e => e.type === "transcript" && e.role === "user").length, 1);
      assert.equal(count(f, "response.create"), 2);
      assert.equal(count(f, "response.cancel"), 0); assert.equal(count(f, "output_audio_buffer.clear"), 0);
    } finally { f.controller.stop(); }
  });
}

for (const control of ["input-mute", "pause", "disconnect", "capability"] as const) {
  test(`manual interruption: physical ${control} still owns capture/output and invalidates protected words`, async t => {
    let allowed = true; const f = fixture({ canUse: () => allowed }), advance = managedClock(t, f); await connectManual(f);
    try {
      created(f, "official"); inputEvent(f, "speech_started");
      if (control === "disconnect") f.controller.stop();
      else if (control === "capability") { allowed = false; f.controller.interrupt(); }
      else f.controller.setMuted({ input: true, output: control === "pause" });
      if (control === "pause") { assert.equal(count(f, "response.cancel"), 1); assert.equal(count(f, "output_audio_buffer.clear"), 1); }
      else { assert.equal(count(f, "response.cancel"), 0); assert.equal(count(f, "output_audio_buffer.clear"), 0); }
      if (control === "disconnect") assert.equal(f.track.stops, 1);
      else if (control !== "capability") assert.equal(f.track.enabled, false);
      for (let i = 0; i < 180; i++) advance(50, 0);
      assert.equal(count(f, "input_audio_buffer.clear"), 0, "Physical suspension does not run quiet recovery on buffered input");
      inputEvent(f, "speech_stopped"); inputEvent(f, "committed"); finalInput(f, "Someone outside said hello");
      assert.equal(f.events.some(e => e.type === "transcript" && e.role === "user"), false);
      if (control !== "disconnect") f.channel.event({ type: "conversation.item.deleted", item_id: "a" });
    } finally { f.controller.stop(); }
  });
}

test("manual interruption: prepared start applies manual mode and reconnect defaults to automatic", async () => {
  const f = fixture({ hasUserActivation: () => true });
  try {
    const { intent } = await f.controller.prepare({}); await connectManual(f, false, intent);
    created(f, "official"); inputEvent(f, "speech_started"); inputEvent(f, "speech_stopped"); inputEvent(f, "committed"); finalInput(f, "Someone outside said hello");
    assert.equal(count(f, "response.cancel"), 0);
    f.controller.stop(); await f.connect(); created(f, "automatic");
    inputEvent(f, "speech_started", "fresh"); inputEvent(f, "speech_stopped", "fresh"); inputEvent(f, "committed", "fresh"); finalInput(f, "Someone outside said hello", "fresh");
    assert.equal(count(f, "response.cancel"), 1, "Manual policy is per-run and omission retains automatic interruption");
  } finally { f.controller.stop(); }
});

test("manual interruption: explicit automatic option retains final-ASR cut-in", async () => {
  const f = fixture();
  try {
    const pending = f.controller.start({ instructions: "Official", interruptionMode: "automatic" }); await tick(); f.channel.open(); await pending;
    created(f, "official"); inputEvent(f, "speech_started"); inputEvent(f, "speech_stopped"); inputEvent(f, "committed"); finalInput(f, "Someone outside said hello");
    assert.equal(count(f, "response.cancel"), 1); assert.equal(count(f, "output_audio_buffer.clear"), 1);
    assert.equal(f.events.filter(e => e.type === "transcript" && e.role === "user").length, 1);
  } finally { f.controller.stop(); }
});

for (const avatar of [false, true]) {
  test(`manual interruption: explicit takeover admits only fresh speech after clear ACK (${avatar ? "avatar" : "direct"})`, async t => {
    const a = avatar ? avatarFixture() : undefined, f = a ?? fixture(); managedClock(t, f); await connectManual(f, avatar);
    try {
      created(f, "official"); if (a) a.callbacks().onPending();
      inputEvent(f, "speech_started", "old");
      f.controller.interrupt();
      assert.equal(count(f, "response.cancel"), 1); assert.equal(count(f, "output_audio_buffer.clear"), 1);
      assert.equal(f.track.enabled, false);
      inputEvent(f, "speech_started", "pre-ack"); inputEvent(f, "committed", "pre-ack"); finalInput(f, "Too soon", "pre-ack");
      f.channel.event({ type: "input_audio_buffer.cleared" });
      assert.equal(f.track.enabled, true);
      inputEvent(f, "committed", "old"); finalInput(f, "Old background", "old");
      inputEvent(f, "speech_started", "fresh"); inputEvent(f, "speech_stopped", "fresh"); inputEvent(f, "committed", "fresh"); finalInput(f, "Stop. I need to answer.", "fresh");
      assert.equal(f.events.filter(e => e.type === "transcript" && e.role === "user").length, 1);
      assert.equal(count(f, "response.create"), 1, "Deletion receipts still fence the next reply");
      f.channel.event({ type: "response.done", response: { id: "official", status: "cancelled" } });
      f.channel.event({ type: "conversation.item.deleted", item_id: "pre-ack" });
      assert.equal(count(f, "response.create"), 1);
      f.channel.event({ type: "conversation.item.deleted", item_id: "old" });
      assert.equal(count(f, "response.create"), 2);
      assert.equal(count(f, "response.cancel"), 1);
    } finally { f.controller.stop(); }
  });
}

test("manual interruption: invalid mode rejects before consent, capture or transport", async () => {
  for (const interruptionMode of [null, "always", "Manual", true, {}, []]) {
    const f = fixture();
    try {
      const pending = f.controller.start({ instructions: "Official", interruptionMode });
      const rejected = assert.rejects(pending, /interruption/i);
      await tick(); f.channel.open(); await rejected;
      assert.equal(f.calls.consent, 0); assert.equal(f.calls.media, 0); assert.equal(f.calls.fetch, 0);
    } finally { f.controller.stop(); }
  }
});

function managedAvatarPlayback(f: ReturnType<typeof avatarFixture>) {
  let sequence = 0;
  const commands: Record<string, any>[] = [];
  const state = new AvatarUtterances({ uuid: () => `lexical-${++sequence}`, send: e => commands.push(e), capture() {}, mute() {}, pending: () => f.callbacks().onPending(), playback: e => f.callbacks().onPlayback(e) });
  state.connected(); f.avatar.handleProviderEvent = e => state.provider(e); f.avatar.handleClientEvent = e => state.client(e);
  return { state, commands };
}

test("manual interruption: actual avatar utterance retains pending and first-word audio after generation done", async t => {
  const f = avatarFixture(), advance = managedClock(t, f); await connectManual(f, true);
  const { state, commands } = managedAvatarPlayback(f);
  try {
    created(f, "official"); f.channel.event({ type: "output_audio_buffer.started", response_id: "official" });
    state.pcm(1, new Uint8Array([1, 2])); f.channel.event({ type: "response.done", response: { id: "official" } });
    inputEvent(f, "speech_started", "pending-noise"); finalInput(f, "Someone outside said hello", "pending-noise"); inputEvent(f, "committed", "pending-noise");
    f.channel.event({ type: "conversation.item.deleted", item_id: "pending-noise" });
    const source = commands[0].event_id;
    state.avatar({ type: "agent.speak_started", source_event_id: source });
    inputEvent(f, "speech_started", "first-word-noise"); inputEvent(f, "speech_stopped", "first-word-noise"); inputEvent(f, "committed", "first-word-noise"); finalInput(f, "Hello", "first-word-noise");
    assert.equal(commands.some(e => e.type === "agent.interrupt"), false);
    assert.equal(count(f, "response.cancel"), 0); assert.equal(count(f, "output_audio_buffer.clear"), 0);
    assert.equal(f.events.some(e => e.type === "transcript" && e.role === "user" || e.type === "input-hint"), false);
    f.channel.event({ type: "conversation.item.deleted", item_id: "first-word-noise" });
    state.drained(1); state.avatar({ type: "agent.speak_ended", source_event_id: source }); advance(1500);
    inputEvent(f, "speech_started", "genuine"); inputEvent(f, "speech_stopped", "genuine"); inputEvent(f, "committed", "genuine"); finalInput(f, "I am here.", "genuine");
    assert.equal(count(f, "response.create"), 2);
    assert.equal(f.events.filter(e => e.type === "transcript" && e.role === "user").length, 1);
  } finally { state.close(); f.controller.stop(); }
});

const sharedVocabularyReference = "You said your mother lived here and tapped twice. This return concerns today: one resident, no dependants. A knock was heard.";
for (const avatar of [false, true]) {
  for (const delayedReference of [false, true]) {
    for (const reply of [
      { name: "observed split correction", parts: ["I said she used to live here.", "I did not say she is here now."] },
      { name: "practical shared-word reply", parts: ["That knock is coming from upstairs."] },
      { name: "shared two-word reply", parts: ["My mother lived abroad before moving away."] },
    ]) test(`lexical retention: ${reply.name} in ${avatar ? "avatar" : "direct"} tail (${delayedReference ? "delayed" : "ready"} reference)`, async t => {
      const avatarCall = avatar ? avatarFixture() : undefined;
      const f = avatarCall ?? fixture(), advance = managedClock(t, f);
      await f.connect();
      const playback = avatarCall ? managedAvatarPlayback(avatarCall) : undefined;
      const reference = () => f.channel.event({ type: "response.output_audio_transcript.done", response_id: "official", item_id: "official-text", content_index: 0, transcript: sharedVocabularyReference });
      const receipts = () => f.events.filter((e): e is Extract<VoiceEvent, { type: "transcript" }> => e.type === "transcript" && e.role === "user" && e.final);
      try {
        created(f, "official");
        if (!delayedReference) reference();
        f.channel.event({ type: "output_audio_buffer.started", response_id: "official" });
        if (playback) {
          playback.state.pcm(1, new Uint8Array([1, 2]));
          playback.state.avatar({ type: "agent.speak_started", source_event_id: playback.commands[0].event_id });
        }
        f.channel.event({ type: "response.done", response: { id: "official", status: "completed" } });
        if (playback) {
          f.channel.event({ type: "output_audio_buffer.stopped", response_id: "official" });
          advance(1000);
          playback.state.drained(1);
          playback.state.avatar({ type: "agent.speak_ended", source_event_id: playback.commands[0].event_id });
        } else f.channel.event({ type: "output_audio_buffer.stopped", response_id: "official" });
        advance(614);
        inputEvent(f, "speech_started", "first");
        advance(1000, .2);
        inputEvent(f, "speech_stopped", "first");
        if (reply.parts.length > 1) {
          inputEvent(f, "committed", "first");
          // Provider starts the next item before returning the first item's final.
          inputEvent(f, "speech_started", "second");
        }
        finalInput(f, reply.parts[0], "first"); finalInput(f, reply.parts[0], "first");
        if (delayedReference) {
          advance(1499);
          assert.deepEqual(receipts(), [], "Partial or missing final reference cannot establish nonmatch");
          assert.equal(count(f, "response.create"), 1);
          assert.equal(count(f, "conversation.item.delete"), 0);
          reference();
        }
        assert.deepEqual(receipts().map(e => ({ id: e.id, text: e.text })), [{ id: "user:first:0", text: reply.parts[0] }]);
        assert.equal(count(f, "response.create"), 1, "Next onset or missing native commit holds the response");
        if (reply.parts.length > 1) {
          advance(50, .2);
          inputEvent(f, "speech_stopped", "second");
          finalInput(f, reply.parts[1], "second"); finalInput(f, reply.parts[1], "second");
          assert.equal(count(f, "response.create"), 1, "Final words alone cannot bypass native settlement");
          inputEvent(f, "committed", "second");
        } else inputEvent(f, "committed", "first");
        assert.deepEqual(receipts().map(e => e.text), reply.parts, "Recognized fragments persist verbatim exactly once");
        assert.equal(count(f, "response.create"), 2, "One settled reply creates one eligible response");
        assert.equal(count(f, "conversation.item.delete"), 0);
        assert.equal(count(f, "response.cancel"), 0);
        assert.equal(count(f, "output_audio_buffer.clear"), 0);
        assert.equal(count(f, "input_audio_buffer.clear"), 0);
        assert.equal(f.track.enabled, true); assert.equal(f.track.stops, 0);
        created(f, "answer");
        f.channel.event({ type: "response.done", response: { id: "answer" } });
        finalInput(f, reply.parts[0], "first");
        assert.deepEqual(receipts().map(e => e.text), reply.parts);
        assert.equal(count(f, "response.create"), 2, "Duplicate receipts do not create another turn");
      } finally { playback?.state.close(); f.controller.stop(); }
    });
  }
  for (const text of ["You", sharedVocabularyReference, "No, your mother lived abroad before moving away."]) {
    test(`lexical echo: ${avatar ? "avatar" : "direct"} preserves audible output and deletes native ${text === "You" ? "first word" : text === sharedVocabularyReference ? "full echo" : "mixed triple"}`, async t => {
      const avatarCall = avatar ? avatarFixture() : undefined;
      const f = avatarCall ?? fixture(); managedClock(t, f); await f.connect();
      const playback = avatarCall ? managedAvatarPlayback(avatarCall) : undefined;
      try {
        created(f, "official");
        f.channel.event({ type: "response.output_audio_transcript.done", response_id: "official", item_id: "official-text", content_index: 0, transcript: sharedVocabularyReference });
        f.channel.event({ type: "output_audio_buffer.started", response_id: "official" });
        if (playback) {
          playback.state.pcm(1, new Uint8Array([1, 2]));
          playback.state.avatar({ type: "agent.speak_started", source_event_id: playback.commands[0].event_id });
        }
        inputEvent(f, "speech_started", "echo"); inputEvent(f, "speech_stopped", "echo"); inputEvent(f, "committed", "echo");
        finalInput(f, text, "echo"); finalInput(f, text, "echo");
        assert.equal(f.events.some(e => e.type === "transcript" && e.role === "user"), false);
        assert.deepEqual(f.channel.sent.filter(e => e.type === "conversation.item.delete").map(e => e.item_id), ["echo"]);
        assert.equal(count(f, "response.cancel"), 0); assert.equal(count(f, "output_audio_buffer.clear"), 0);
        f.controller.reactToScene({ id: "after-echo", kind: "knock" });
        f.channel.event({ type: "response.done", response: { id: "official" } });
        assert.equal(count(f, "response.create"), 1, "Audible output still owns the floor");
        f.channel.event({ type: "output_audio_buffer.stopped", response_id: "official" });
        if (playback) {
          playback.state.drained(1);
          playback.state.avatar({ type: "agent.speak_ended", source_event_id: playback.commands[0].event_id });
        }
        assert.equal(count(f, "response.create"), 1, "Native deletion remains a barrier after playback");
        f.channel.event({ type: "conversation.item.deleted", item_id: "unrelated" });
        assert.equal(count(f, "response.create"), 1);
        f.channel.event({ type: "conversation.item.deleted", item_id: "echo" });
        f.channel.event({ type: "conversation.item.deleted", item_id: "echo" });
        assert.equal(count(f, "response.create"), 2);
        assert.equal(count(f, "response.cancel"), 0); assert.equal(count(f, "output_audio_buffer.clear"), 0);
      } finally { playback?.state.close(); f.controller.stop(); }
    });
  }
}

for (const done of [false, true]) test(`echo policy: first-word ASR preserves actual avatar and waits for deletion acknowledgement (done=${done})`, async t => {
  const f = avatarFixture(); managedClock(t, f); await f.connect();
  let sequence = 0;
  const commands: Record<string, any>[] = [], mute: boolean[] = [];
  const state = new AvatarUtterances({ uuid: () => `echo-${++sequence}`, send: e => commands.push(e), capture() {}, mute: v => mute.push(v), pending: () => f.callbacks().onPending(), playback: e => f.callbacks().onPlayback(e) });
  state.connected(); f.avatar.handleProviderEvent = e => state.provider(e); f.avatar.handleClientEvent = e => state.client(e);
  try {
    created(f, "official");
    f.channel.event({ type: "response.output_audio_transcript.done", response_id: "official", item_id: "official-text", content_index: 0, transcript: "Resident, explain the page." });
    f.channel.event({ type: "output_audio_buffer.started", response_id: "official" });
    state.pcm(1, new Uint8Array([1, 2])); state.avatar({ type: "agent.speak_started", source_event_id: commands[0].event_id });
    if (done) f.channel.event({ type: "response.done", response: { id: "official" } });
    inputEvent(f, "speech_started", "echo");
    f.channel.event({ type: "conversation.item.input_audio_transcription.delta", item_id: "echo", content_index: 0, delta: "Resident" });
    inputEvent(f, "speech_stopped", "echo"); inputEvent(f, "committed", "echo"); finalInput(f, "Resident", "echo");
    assert.equal(count(f, "response.cancel"), 0); assert.equal(count(f, "output_audio_buffer.clear"), 0);
    assert.equal(mute.at(-1), false);
    assert.equal(f.events.some(e => e.type === "transcript" && e.role === "user"), false);
    assert.ok(f.channel.sent.some(e => e.type === "conversation.item.delete" && e.item_id === "echo"));
    f.controller.reactToScene({ id: "echo-scene", kind: "knock" });
    f.channel.event({ type: "response.done", response: { id: "official" } });
    state.avatar({ type: "agent.speak_ended", source_event_id: commands[0].event_id });
    assert.equal(count(f, "response.create"), 1, "Unsealed chunk gap retains ownership");
    state.drained(1);
    assert.equal(count(f, "response.create"), 1, "Deletion must be acknowledged");
    f.channel.event({ type: "conversation.item.deleted", item_id: "echo" });
    assert.equal(count(f, "response.create"), 2);
    inputEvent(f, "speech_started", "echo"); finalInput(f, "Late words", "echo");
    assert.equal(f.events.some(e => e.type === "transcript" && e.role === "user"), false);
    assert.equal(count(f, "response.create"), 2);
  } finally { state.close(); f.controller.stop(); }
});

test("echo policy: energy alone preserves output; late reference can accept a clearly different final", async t => {
  const f = fixture(), advance = managedClock(t, f); await f.connect();
  try {
    created(f, "official"); inputEvent(f, "speech_started");
    f.channel.event({ type: "output_audio_buffer.started", response_id: "official" });
    for (let i = 0; i < 60; i++) advance(50, .2);
    assert.equal(count(f, "response.cancel"), 0);
    assert.equal(f.events.filter(e => e.type === "activity").at(-1)?.status, "speaking");
    inputEvent(f, "speech_stopped"); inputEvent(f, "committed"); finalInput(f, "不");
    advance(1499); assert.equal(count(f, "response.cancel"), 0);
    f.channel.event({ type: "response.output_audio_transcript.done", response_id: "official", item_id: "official-text", content_index: 0, transcript: "Resident, explain the page." });
    assert.equal(count(f, "response.cancel"), 1); assert.equal(count(f, "output_audio_buffer.clear"), 1);
    assert.equal(f.events.filter(e => e.type === "transcript" && e.role === "user" && e.final).length, 1);
  } finally { f.controller.stop(); }
});

for (const reply of [
  { name: "distinct reply", text: "Then let me get ready for work.", voicedSamples: 35, level: .2 },
  { name: "short weak reply", text: "Yes", voicedSamples: 2, level: .02 },
]) test(`echo policy: delayed semantic endpointing preserves a ${reply.name} begun in the output tail`, async t => {
  const f = fixture(), advance = managedClock(t, f);
  await f.connect();
  try {
    created(f, "official");
    f.channel.event({ type: "response.output_audio_transcript.done", response_id: "official", item_id: "official-text", content_index: 0, transcript: "That will do. The return is confirmed: one resident, no dependants. Remain where you can be seen." });
    f.channel.event({ type: "output_audio_buffer.started", response_id: "official" });
    f.channel.event({ type: "response.done", response: { id: "official", status: "completed" } });
    f.channel.event({ type: "output_audio_buffer.stopped", response_id: "official" });
    advance(614);
    inputEvent(f, "speech_started", "resident");
    for (let i = 0; i < 35; i++) advance(50, i < reply.voicedSamples ? reply.level : 0);
    for (let i = 0; i < 44; i++) advance(50, 0);
    assert.equal(count(f, "input_audio_buffer.clear"), 0, "Captured words survive while semantic VAD decides the utterance has ended");
    assert.equal(count(f, "response.create"), 1);
    assert.equal(f.events.some(e => e.type === "transcript" && e.role === "user"), false);

    advance(1900);
    inputEvent(f, "speech_stopped", "resident");
    inputEvent(f, "committed", "resident");
    finalInput(f, reply.text, "resident");
    finalInput(f, reply.text, "resident");
    assert.deepEqual(f.events.filter((e): e is Extract<VoiceEvent, { type: "transcript" }> => e.type === "transcript" && e.role === "user" && e.final).map(e => e.text), [reply.text]);
    assert.equal(count(f, "response.create"), 2);
    assert.equal(count(f, "response.cancel"), 0);
    assert.equal(count(f, "input_audio_buffer.clear"), 0);
  } finally { f.controller.stop(); }
});

test("echo policy: delayed semantic endpointing still discards output-tail echo until native deletion acknowledgement", async t => {
  const f = fixture(), advance = managedClock(t, f);
  const official = "That will do. The return is confirmed: one resident, no dependants. Remain where you can be seen.";
  await f.connect();
  try {
    created(f, "official");
    f.channel.event({ type: "response.output_audio_transcript.done", response_id: "official", item_id: "official-text", content_index: 0, transcript: official });
    f.channel.event({ type: "output_audio_buffer.started", response_id: "official" });
    f.channel.event({ type: "response.done", response: { id: "official", status: "completed" } });
    f.channel.event({ type: "output_audio_buffer.stopped", response_id: "official" });
    advance(614);
    inputEvent(f, "speech_started", "echo");
    for (let i = 0; i < 35; i++) advance(50, .2);
    for (let i = 0; i < 44; i++) advance(50, 0);
    assert.equal(count(f, "input_audio_buffer.clear"), 0);
    f.controller.reactToScene({ id: "echo-scene", kind: "knock" });
    assert.equal(count(f, "response.create"), 1);
    assert.equal(count(f, "conversation.item.delete"), 0, "Uncommitted native input cannot be deleted");

    advance(1900);
    inputEvent(f, "speech_stopped", "echo");
    inputEvent(f, "committed", "echo");
    finalInput(f, official, "echo");
    finalInput(f, official, "echo");
    assert.equal(count(f, "response.cancel"), 0);
    assert.equal(f.events.filter(e => e.type === "transcript" && e.role === "user" && e.final).length, 0);
    assert.equal(count(f, "conversation.item.delete"), 1);
    assert.ok(f.channel.sent.some(e => e.type === "conversation.item.delete" && e.item_id === "echo"));
    assert.equal(count(f, "response.create"), 1, "Queued scene waits for native item deletion");
    f.channel.event({ type: "conversation.item.deleted", item_id: "unrelated" });
    assert.equal(count(f, "response.create"), 1);
    f.channel.event({ type: "conversation.item.deleted", item_id: "echo" });
    assert.equal(count(f, "response.create"), 2);
    assert.equal(count(f, "response.cancel"), 0);
    assert.equal(count(f, "input_audio_buffer.clear"), 0);
  } finally { f.controller.stop(); }
});

test("echo policy: quiet raw onset retires after 8000ms of fresh samples and input clear acknowledgement", async t => {
  const f = fixture(), advance = managedClock(t, f); await f.connect();
  try {
    created(f); inputEvent(f, "speech_started", "quiet"); f.controller.reactToScene({ id: "quiet-scene", kind: "knock" });
    f.channel.event({ type: "response.done" });
    advance(20_000, 0); assert.equal(count(f, "input_audio_buffer.clear"), 0);
    for (let i = 0; i < 40; i++) advance(50, 0);
    assert.equal(count(f, "input_audio_buffer.clear"), 0, "Two seconds of quiet must not erase pending semantic input");
    for (let i = 0; i < 119; i++) advance(50, 0);
    advance(49, 0);
    assert.equal(count(f, "input_audio_buffer.clear"), 0, "Recovery needs the full 8000ms of fresh quiet");
    assert.equal(count(f, "response.create"), 1);
    advance(1, 0);
    assert.equal(count(f, "input_audio_buffer.clear"), 1); assert.equal(count(f, "response.create"), 1);
    advance(50, 0);
    assert.equal(count(f, "input_audio_buffer.clear"), 1);
    f.channel.event({ type: "input_audio_buffer.cleared" }); assert.equal(count(f, "response.create"), 2);
    finalInput(f, "Late words", "quiet"); assert.equal(f.events.some(e => e.type === "transcript" && e.role === "user"), false);
  } finally { f.controller.stop(); }
});

for (const retirement of ["ack", "timeout", "error"] as const) test(`echo policy: missing reference expires at 1500ms; deletion ${retirement}`, async t => {
  const f = fixture(), advance = managedClock(t, f); await f.connect();
  try {
    created(f, "official"); f.channel.event({ type: "output_audio_buffer.started", response_id: "official" });
    inputEvent(f, "speech_started"); inputEvent(f, "speech_stopped"); finalInput(f, "Resident");
    f.controller.reactToScene({ id: "waiting", kind: "knock" });
    advance(1499); assert.equal(count(f, "conversation.item.delete"), 0);
    advance(1); assert.ok(f.events.some(e => e.type === "input-hint"));
    assert.equal(count(f, "conversation.item.delete"), 0, "Cannot delete an uncommitted native item");
    inputEvent(f, "committed"); assert.equal(count(f, "conversation.item.delete"), 1);
    f.channel.event({ type: "response.output_audio_transcript.done", response_id: "official", item_id: "late-reference", content_index: 0, transcript: "Different reference" });
    assert.equal(f.events.some(e => e.type === "transcript" && e.role === "user"), false);
    assert.equal(count(f, "response.cancel"), 0);
    f.channel.event({ type: "response.done", response: { id: "official" } });
    f.channel.event({ type: "output_audio_buffer.stopped", response_id: "official" });
    f.channel.event({ type: "conversation.item.deleted", item_id: "unrelated" }); assert.equal(count(f, "response.create"), 1);
    if (retirement === "ack") {
      f.channel.event({ type: "conversation.item.deleted", item_id: "a" }); assert.equal(count(f, "response.create"), 2);
    } else {
      if (retirement === "timeout") { advance(7999); assert.equal(f.track.stops, 0); advance(1); }
      else f.channel.event({ type: "error", error: { code: "item_delete_failed" } });
      assert.equal(f.track.stops, 1); assert.equal(count(f, "response.create"), 1);
      assert.ok(f.events.some(e => e.type === "status" && e.status === "error"));
    }
  } finally { f.controller.stop(); }
});

test("echo policy: explicit interrupt excludes all pre-clear audio and admits one exact repeat after acknowledgement", async t => {
  const f = fixture(); managedClock(t, f); await f.connect();
  try {
    created(f, "official"); f.channel.event({ type: "response.output_audio_transcript.done", response_id: "official", item_id: "official-text", content_index: 0, transcript: "Resident, explain the page." });
    f.channel.event({ type: "output_audio_buffer.started", response_id: "official" });
    inputEvent(f, "speech_started", "before");
    dispatchVoiceCall(f.controller, "realtimeVoice.interrupt", []);
    assert.equal(count(f, "input_audio_buffer.clear"), 1); assert.equal(count(f, "response.cancel"), 1); assert.equal(f.track.enabled, false);
    inputEvent(f, "speech_started", "during"); inputEvent(f, "committed", "before"); finalInput(f, "Resident", "before");
    f.channel.event({ type: "response.done", response: { id: "official" } }); assert.equal(count(f, "response.create"), 1);
    f.channel.event({ type: "input_audio_buffer.cleared" }); assert.equal(f.track.enabled, true);
    inputEvent(f, "speech_started", "during"); finalInput(f, "Resident", "during");
    inputEvent(f, "speech_started", "after"); inputEvent(f, "speech_stopped", "after"); inputEvent(f, "committed", "after"); finalInput(f, "Resident", "after");
    assert.deepEqual(f.events.filter((e): e is Extract<VoiceEvent, { type: "transcript" }> => e.type === "transcript" && e.role === "user").map(e => e.id), ["user:after:0"]);
    assert.equal(count(f, "response.create"), 1, "The old committed item still needs deletion acknowledgement");
    f.channel.event({ type: "conversation.item.deleted", item_id: "before" }); assert.equal(count(f, "response.create"), 2);
    assert.equal(f.calls.media, 1); assert.equal(f.calls.peer, 1);
    assert.throws(() => dispatchVoiceCall(f.controller, "realtimeVoice.interrupt", [{}]), /arguments/);
  } finally { f.controller.stop(); }
});

test("echo policy: clear handles a native commit without onset, preserving an already accepted resident item", async t => {
  const f = fixture(); managedClock(t, f); await f.connect();
  try {
    created(f); inputEvent(f, "speech_started", "genuine"); inputEvent(f, "committed", "genuine"); finalInput(f, "نعم", "genuine");
    f.controller.interrupt();
    inputEvent(f, "committed", "buffered");
    assert.ok(f.channel.sent.some(e => e.type === "conversation.item.delete" && e.item_id === "buffered"));
    assert.equal(f.channel.sent.some(e => e.type === "conversation.item.delete" && e.item_id === "genuine"), false, "Already accepted words are not provisional evidence");
  } finally { f.controller.stop(); }
});

test("echo policy: a partial reference cannot accept a mixture and does not extend the final-ASR deadline", async t => {
  const f = fixture(), advance = managedClock(t, f); await f.connect();
  try {
    created(f); f.channel.event({ type: "output_audio_buffer.started" }); inputEvent(f, "speech_started");
    inputEvent(f, "speech_stopped"); inputEvent(f, "committed"); finalInput(f, "Explain the page, but I was asleep");
    f.channel.event({ type: "response.output_audio_transcript.delta", item_id: "ref", content_index: 0, delta: "Resident" });
    advance(1499); assert.equal(count(f, "response.cancel"), 0);
    f.channel.event({ type: "response.output_audio_transcript.delta", item_id: "ref", content_index: 0, delta: ", explain the page." });
    advance(1); assert.equal(count(f, "conversation.item.delete"), 1);
    f.channel.event({ type: "response.output_audio_transcript.done", item_id: "ref", content_index: 0, transcript: "Resident, explain the page." });
    assert.equal(f.events.some(e => e.type === "transcript" && e.role === "user"), false);
  } finally { f.controller.stop(); }
});

test("echo policy: overlapping missing ASR retires the native item rather than treating timeout as speech", async t => {
  const f = fixture(), advance = managedClock(t, f); await f.connect();
  try {
    created(f); f.channel.event({ type: "output_audio_buffer.started" }); inputEvent(f, "speech_started");
    for (let i = 0; i < 12; i++) advance(50, .2);
    inputEvent(f, "speech_stopped"); inputEvent(f, "committed"); advance(8000);
    assert.equal(count(f, "response.cancel"), 0); assert.equal(count(f, "conversation.item.delete"), 1);
    assert.equal(count(f, "response.create"), 1); assert.equal(f.events.some(e => e.type === "transcript" && e.role === "user"), false);
  } finally { f.controller.stop(); }
});

test("echo policy: resumed raw capture acquires the output reference before final words", async t => {
  const f = fixture(); managedClock(t, f); await f.connect();
  try {
    created(f); inputEvent(f, "speech_started"); inputEvent(f, "speech_stopped");
    f.channel.event({ type: "response.output_audio_transcript.done", item_id: "ref", content_index: 0, transcript: "Explain the page" });
    f.channel.event({ type: "output_audio_buffer.started" });
    inputEvent(f, "speech_started"); inputEvent(f, "speech_stopped"); inputEvent(f, "committed"); finalInput(f, "Explain the page but I was asleep");
    assert.equal(count(f, "response.cancel"), 0);
    assert.equal(f.events.some(e => e.type === "transcript" && e.role === "user"), false);
    assert.equal(count(f, "conversation.item.delete"), 1);
  } finally { f.controller.stop(); }
});

test("echo policy: deliberate floor action alone creates no response and clear timeout is recoverable", async t => {
  const f = fixture(), advance = managedClock(t, f); await f.connect();
  try {
    created(f); f.controller.interrupt(); f.controller.interrupt();
    assert.equal(count(f, "input_audio_buffer.clear"), 1); f.channel.event({ type: "response.done" });
    advance(7999); assert.equal(count(f, "response.create"), 1); assert.equal(f.track.stops, 0);
    advance(1); assert.equal(f.track.stops, 1); assert.ok(f.events.some(e => e.type === "status" && e.status === "error"));
  } finally { f.controller.stop(); }
});

for (const mode of ["long", "missing", "gaps"]) test(`echo policy: quiet recovery never promotes or ends ${mode} mic evidence`, async t => {
  const f = fixture(), advance = managedClock(t, f); await f.connect();
  try {
    created(f); f.channel.event({ type: "output_audio_buffer.started" }); inputEvent(f, "speech_started");
    for (let i = 0; i < 200; i++) advance(mode === "gaps" ? 200 : 50, mode === "missing" ? undefined : mode === "long" ? .2 : 0);
    assert.equal(count(f, "response.cancel"), 0); assert.equal(count(f, "input_audio_buffer.clear"), 0);
    assert.equal(f.events.some(e => e.type === "transcript" && e.role === "user"), false);
  } finally { f.controller.stop(); }
});

test("echo policy: tail is bounded and delayed ASR uses capture overlap, not arrival time", async t => {
  const f = fixture(), advance = managedClock(t, f); await f.connect();
  try {
    created(f); inputEvent(f, "speech_started", "earlier"); inputEvent(f, "speech_stopped", "earlier"); inputEvent(f, "committed", "earlier");
    f.channel.event({ type: "response.output_audio_transcript.done", item_id: "text", content_index: 0, transcript: "Resident" });
    f.channel.event({ type: "output_audio_buffer.started" }); finalInput(f, "نعم", "earlier");
    assert.ok(f.events.some(e => e.type === "transcript" && e.role === "user" && e.text === "نعم"));
    f.channel.event({ type: "response.done" });
    // Earlier accepted input interrupted output; its acoustic tail still applies.
    inputEvent(f, "speech_started", "tail"); inputEvent(f, "speech_stopped", "tail"); inputEvent(f, "committed", "tail"); finalInput(f, "Resident", "tail");
    assert.ok(f.channel.sent.some(e => e.type === "conversation.item.delete" && e.item_id === "tail"));
    f.channel.event({ type: "conversation.item.deleted", item_id: "tail" });
    advance(751); inputEvent(f, "speech_started", "outside"); inputEvent(f, "speech_stopped", "outside"); inputEvent(f, "committed", "outside"); finalInput(f, "Resident", "outside");
    assert.ok(f.events.some(e => e.type === "transcript" && e.role === "user" && e.id === "user:outside:0"));
  } finally { f.controller.stop(); }
});

for (const support of ["all", "boolean", "reject"] as const) test(`capture: probe existing track and report selected AEC (${support})`, async () => {
  const f = fixture(); const applied: unknown[] = [];
  Object.assign(f.track, {
    getCapabilities: () => ({ echoCancellation: support === "boolean" ? [true, false] : [true, "all"] }),
    applyConstraints: async (constraints: unknown) => { applied.push(constraints); if (support === "reject") throw new Error("overconstrained"); },
    getSettings: () => ({ echoCancellation: support === "all" ? "all" : true, deviceId: "DO NOT EMIT" }),
  });
  await f.connect();
  try {
    assert.deepEqual(applied, support === "boolean" ? [] : [{ echoCancellation: { exact: "all" } }]);
    assert.deepEqual(f.events.filter(e => e.type === "capture-settings"), [{ type: "capture-settings", echoCancellation: support === "all" ? "all" : true }]);
    assert.equal(f.calls.media, 1);
  } finally { f.controller.stop(); }
});

test("managed: raw 100ms noise preserves active follow-up across a delayed semantic stop", async t => {
  const f = fixture(); const advance = managedClock(t, f); await f.connect();
  try {
    f.channel.event({ type: "response.done" });
    f.controller.reactToScene({ id: "follow", kind: "follow-up", line: "Explain the page.", evidenceId: "page" });
    created(f, "follow"); f.channel.event({ type: "output_audio_buffer.started", response_id: "follow" });
    inputEvent(f, "speech_started");
    for (let i = 0; i < 40; i++) advance(50, i < 2 ? 0.2 : 0);
    assert.equal(count(f, "response.cancel"), 0); assert.equal(count(f, "output_audio_buffer.clear"), 0);
    assert.equal(count(f, "conversation.item.delete"), 0);
    assert.ok(f.events.some(e => e.type === "input" && e.status === "speaking"));
    inputEvent(f, "speech_stopped"); inputEvent(f, "committed"); finalInput(f, "...");
    assert.equal(count(f, "response.create"), 2);
  } finally { f.controller.stop(); }
});

test("managed: sustained activity waits for meaningful final words before cancelling, retirement and native commit", async t => {
  const f = fixture(); const advance = managedClock(t, f); await f.connect();
  try {
    created(f, "old"); inputEvent(f, "speech_started");
    for (let i = 0; i < 12; i++) advance(50, 0.06);
    assert.equal(count(f, "response.cancel"), 0); assert.equal(count(f, "output_audio_buffer.clear"), 0);
    finalInput(f, "不");
    assert.equal(count(f, "response.cancel"), 1); assert.equal(count(f, "output_audio_buffer.clear"), 1);
    const cancelled = f.channel.sent.findIndex(e => e.type === "response.cancel");
    assert.equal(f.channel.sent[cancelled].response_id, "old"); assert.equal(f.channel.sent[cancelled + 1].type, "output_audio_buffer.clear");
    finalInput(f, "不"); inputEvent(f, "speech_stopped");
    f.channel.event({ type: "response.done", response: { id: "old" } });
    assert.equal(count(f, "response.create"), 1, "No answer without commit");
    inputEvent(f, "committed"); assert.equal(count(f, "response.create"), 2);
    finalInput(f, "不"); assert.equal(count(f, "response.create"), 2);
  } finally { f.controller.stop(); }
});

for (const phase of ["request", "generation", "avatar-pending"] as const) {
  for (const settlement of ["empty", "failed", "missing"] as const) {
    test(`pending voice: ${phase} survives acoustic activity and ${settlement} ASR without a noise reply`, async t => {
      const f = phase === "avatar-pending" ? avatarFixture() : fixture(), advance = managedClock(t, f);
      await f.connect();
      let state: AvatarUtterances | undefined, sequence = 0;
      const commands: Record<string, any>[] = [], mute: boolean[] = [];
      if (phase === "avatar-pending") {
        const a = f as ReturnType<typeof avatarFixture>;
        state = new AvatarUtterances({ uuid: () => `pending-${++sequence}`, send: e => commands.push(e), capture() {}, mute: v => mute.push(v), pending: () => a.callbacks().onPending(), playback: e => a.callbacks().onPlayback(e) });
        state.connected(); a.avatar.handleProviderEvent = e => state!.provider(e); a.avatar.handleClientEvent = e => state!.client(e);
      }
      try {
        if (phase !== "request") created(f, "official");
        if (state) {
          f.channel.event({ type: "output_audio_buffer.started", response_id: "official" });
          state.pcm(1, new Uint8Array([1, 2]));
          f.channel.event({ type: "response.done", response: { id: "official" } });
        }
        inputEvent(f, "speech_started", "noise");
        if (settlement !== "missing") f.controller.reactToScene({ id: "pending-scene", kind: "knock" });
        for (let i = 0; i < 12; i++) advance(50, .2);
        assert.equal(count(f, "response.cancel"), 0, "Energy without words cannot cancel pending generation");
        assert.equal(count(f, "output_audio_buffer.clear"), 0, "Energy without words cannot clear pending audio");
        assert.equal(f.track.enabled, true, "Pending output keeps microphone capture enabled");
        assert.equal(count(f, "response.create"), 1, "Raw input and scenes cannot overlap pending output");
        if (phase === "request") created(f, "official");
        f.channel.event({ type: "response.output_audio_transcript.done", response_id: "official", item_id: "official-text", content_index: 0, transcript: "Remain where you can be seen." });
        assert.ok(f.events.some(e => e.type === "transcript" && e.role === "assistant" && e.final));
        inputEvent(f, "speech_stopped", "noise"); inputEvent(f, "committed", "noise");
        if (settlement === "empty") finalInput(f, "", "noise");
        if (settlement === "failed") f.channel.event({ type: "conversation.item.input_audio_transcription.failed", item_id: "noise", content_index: 0 });
        advance(8000);
        assert.equal(count(f, "response.create"), 1, "Scene still waits for output retirement after no-word input settles");
        if (state) {
          assert.equal(commands.filter(e => e.type === "agent.interrupt").length, 0);
          const source = commands[0].event_id;
          state.avatar({ type: "agent.speak_started", source_event_id: source });
          assert.equal(mute.at(-1), false, "Buffered official audio remains playable");
          state.drained(1); state.avatar({ type: "agent.speak_ended", source_event_id: source });
        } else f.channel.event({ type: "response.done", response: { id: "official" } });
        assert.equal(count(f, "response.create"), settlement === "missing" ? 1 : 2, "Only a queued scene can request output after no-word input settles");
        if (settlement === "missing") f.controller.reactToScene({ id: "quiet-scene", kind: "knock" });
        assert.equal(count(f, "response.create"), 2, "One scene drains after both input and output retire");
        created(f, "scene"); f.channel.event({ type: "response.done", response: { id: "scene" } });
        assert.equal(count(f, "response.create"), 2, "No-word input cannot request another native reply");
        assert.equal(f.events.some(e => e.type === "transcript" && e.role === "user" && e.text.trim().length > 0), false);
        assert.equal(count(f, "response.cancel"), 0); assert.equal(count(f, "output_audio_buffer.clear"), 0);
        assert.equal(count(f, "input_audio_buffer.clear"), 0);
      } finally { state?.close(); f.controller.stop(); }
    });
  }

  test(`pending voice: explicit take-floor immediately clears ${phase} and retains exact acknowledgement barriers`, async t => {
    const f = phase === "avatar-pending" ? avatarFixture() : fixture(), advance = managedClock(t, f);
    await f.connect();
    try {
      if (phase !== "request") created(f, "official");
      if (phase === "avatar-pending") {
        f.channel.event({ type: "output_audio_buffer.started", response_id: "official" });
        f.channel.event({ type: "response.done", response: { id: "official" } });
      }
      inputEvent(f, "speech_started", "noise");
      for (let i = 0; i < 12; i++) advance(50, .2);
      assert.equal(count(f, "output_audio_buffer.clear"), 0);
      f.controller.interrupt();
      assert.equal(count(f, "output_audio_buffer.clear"), 1);
      assert.equal(count(f, "response.cancel"), phase === "avatar-pending" ? 0 : 1);
      assert.equal(count(f, "input_audio_buffer.clear"), 1); assert.equal(f.track.enabled, false);
      inputEvent(f, "committed", "noise");
      assert.ok(f.channel.sent.some(e => e.type === "conversation.item.delete" && e.item_id === "noise"));
      f.channel.event({ type: "conversation.item.deleted", item_id: "wrong-item" });
      finalInput(f, "Unacknowledged", "noise");
      assert.equal(f.events.some(e => e.type === "transcript" && e.role === "user"), false);
      f.channel.event({ type: "input_audio_buffer.cleared" }); assert.equal(f.track.enabled, true);
      inputEvent(f, "speech_started", "fresh"); inputEvent(f, "speech_stopped", "fresh"); inputEvent(f, "committed", "fresh"); finalInput(f, "No", "fresh");
      assert.equal(count(f, "response.create"), 1, "The old native item deletion remains a barrier");
      if (phase === "request") created(f, "official");
      f.channel.event({ type: "response.done", response: { id: "official" } });
      assert.equal(count(f, "response.create"), 1);
      f.channel.event({ type: "conversation.item.deleted", item_id: "noise" });
      assert.equal(count(f, "response.create"), 2);
    } finally { f.controller.stop(); }
  });
}

test("pending voice: buffering input acquires the real avatar playback reference and discards echo behind deletion", async t => {
  const f = avatarFixture(), advance = managedClock(t, f); await f.connect();
  let sequence = 0;
  const commands: Record<string, any>[] = [], mute: boolean[] = [];
  const state = new AvatarUtterances({ uuid: () => `delayed-${++sequence}`, send: e => commands.push(e), capture() {}, mute: v => mute.push(v), pending: () => f.callbacks().onPending(), playback: e => f.callbacks().onPlayback(e) });
  state.connected(); f.avatar.handleProviderEvent = e => state.provider(e); f.avatar.handleClientEvent = e => state.client(e);
  try {
    created(f, "official");
    f.channel.event({ type: "response.output_audio_transcript.done", response_id: "official", item_id: "official-text", content_index: 0, transcript: "Resident, explain the page." });
    f.channel.event({ type: "output_audio_buffer.started", response_id: "official" });
    state.pcm(1, new Uint8Array([1, 2]));
    f.channel.event({ type: "response.done", response: { id: "official" } });
    inputEvent(f, "speech_started", "echo");
    for (let i = 0; i < 12; i++) advance(50, .2);
    assert.equal(count(f, "output_audio_buffer.clear"), 0);
    const source = commands[0].event_id;
    state.avatar({ type: "agent.speak_started", source_event_id: source });
    for (let i = 0; i < 12; i++) advance(50, .2);
    inputEvent(f, "speech_stopped", "echo"); inputEvent(f, "committed", "echo"); finalInput(f, "Resident", "echo");
    assert.equal(count(f, "response.cancel"), 0); assert.equal(count(f, "output_audio_buffer.clear"), 0);
    assert.equal(mute.at(-1), false); assert.equal(f.track.enabled, true);
    assert.equal(f.events.some(e => e.type === "transcript" && e.role === "user"), false);
    assert.ok(f.channel.sent.some(e => e.type === "conversation.item.delete" && e.item_id === "echo"));
    f.controller.reactToScene({ id: "delayed-scene", kind: "knock" });
    state.drained(1); state.avatar({ type: "agent.speak_ended", source_event_id: source });
    assert.equal(count(f, "response.create"), 1);
    f.channel.event({ type: "conversation.item.deleted", item_id: "other" }); assert.equal(count(f, "response.create"), 1);
    f.channel.event({ type: "conversation.item.deleted", item_id: "echo" }); assert.equal(count(f, "response.create"), 2);
  } finally { state.close(); f.controller.stop(); }
});

test("pending voice: meaningful short final clears buffered actual avatar after generation without acoustic cancellation", async t => {
  const f = avatarFixture(), advance = managedClock(t, f); await f.connect();
  let sequence = 0;
  const commands: Record<string, any>[] = [];
  const state = new AvatarUtterances({ uuid: () => `final-${++sequence}`, send: e => commands.push(e), capture() {}, mute() {}, pending: () => f.callbacks().onPending(), playback: e => f.callbacks().onPlayback(e) });
  state.connected(); f.avatar.handleProviderEvent = e => state.provider(e); f.avatar.handleClientEvent = e => state.client(e);
  try {
    created(f, "official"); f.channel.event({ type: "output_audio_buffer.started", response_id: "official" });
    state.pcm(1, new Uint8Array([1, 2])); f.channel.event({ type: "response.done", response: { id: "official" } });
    inputEvent(f, "speech_started"); for (let i = 0; i < 12; i++) advance(50, .2);
    assert.equal(count(f, "output_audio_buffer.clear"), 0);
    finalInput(f, "不");
    assert.equal(count(f, "output_audio_buffer.clear"), 1); assert.equal(count(f, "response.cancel"), 0);
    assert.equal(commands.filter(e => e.type === "agent.interrupt").length, 1);
    assert.equal(count(f, "response.create"), 1);
    inputEvent(f, "speech_stopped"); assert.equal(count(f, "response.create"), 1);
    inputEvent(f, "committed"); assert.equal(count(f, "response.create"), 2);
    assert.deepEqual(f.events.filter((e): e is Extract<VoiceEvent, { type: "transcript" }> => e.type === "transcript" && e.role === "user" && e.final).map(e => e.text), ["不"]);
  } finally { state.close(); f.controller.stop(); }
});

test("managed: stopped ASR timeout releases scenes but late real words persist without a duplicate answer", async t => {
  const f = fixture(); const advance = managedClock(t, f); await f.connect();
  try {
    f.channel.event({ type: "response.done" }); inputEvent(f, "speech_started"); inputEvent(f, "speech_stopped"); inputEvent(f, "committed");
    f.controller.reactToScene({ id: "notice", kind: "knock" });
    advance(7999); assert.equal(count(f, "response.create"), 1);
    advance(1); assert.equal(count(f, "response.create"), 2);
    assert.equal(f.events.some(e => e.type === "input" && e.status === "discarded"), false);
    created(f, "scene"); finalInput(f, "No"); finalInput(f, "No");
    assert.equal(count(f, "response.cancel"), 0);
    assert.equal(f.events.filter(e => e.type === "transcript" && e.final && e.role === "user").length, 1);
    f.channel.event({ type: "response.done", response: { id: "scene" } }); assert.equal(count(f, "response.create"), 2);
    assert.equal(count(f, "input_audio_buffer.clear"), 0);
  } finally { f.controller.stop(); }
});

test("managed: config advertisement and acknowledgement are mandatory without legacy retry", async () => {
  for (const mode of [undefined, "client-v2", null]) {
    const f = fixture(); f.deps.fetch = async () => Response.json({ available: true, funding: "byok", maxDurationSeconds: 300, turnControl: mode });
    await assert.rejects(f.controller.start({ instructions: "hello" }), /refresh|compatible/i);
    assert.equal(f.calls.media, 0); assert.equal(f.calls.consent, 0);
    const g = fixture(); const fetch = g.deps.fetch; let posts = 0;
    g.deps.fetch = async (url, init) => String(url).endsWith("/connect") ? (posts++, Response.json({ sdp: "v=0\r\no=answer", turnControl: mode })) : fetch(url, init);
    await assert.rejects(g.controller.start({ instructions: "hello" }), /refresh|compatible/i);
    assert.equal(g.peer.remotes, 0); assert.equal(posts, 1); assert.equal(g.track.stops, 1);
  }
});

for (const avatar of [false, true]) {
  test(`managed: real ${avatar ? "avatar" : "direct"} output survives noise, confirmation clears pending output before any reply`, async t => {
    const f = avatar ? avatarFixture() : fixture(), advance = managedClock(t, f);
    await f.connect(); let state: AvatarUtterances | undefined, sequence = 0;
    const commands: Record<string, any>[] = [], capture: Record<string, any>[] = [], mute: boolean[] = [];
    if (avatar) {
      const a = f as ReturnType<typeof avatarFixture>;
      state = new AvatarUtterances({ uuid: () => `u-${++sequence}`, send: event => commands.push(event), capture: event => capture.push(event), mute: value => mute.push(value), pending: () => a.callbacks().onPending(), playback: event => a.callbacks().onPlayback(event) });
      state.connected(); a.avatar.handleProviderEvent = event => state!.provider(event); a.avatar.handleClientEvent = event => state!.client(event);
    }
    try {
      created(f, "old");
      f.channel.event({ type: "response.output_audio_transcript.done", response_id: "old", item_id: "reference", content_index: 0, transcript: "Explain the page." });
      f.channel.event({ type: "output_audio_buffer.started", response_id: "old" });
      state?.pcm(1, new Uint8Array([1, 2]));
      const oldSource = commands[0]?.event_id;
      state?.avatar({ type: "agent.speak_started", source_event_id: oldSource });
      inputEvent(f, "speech_started");
      f.controller.reactToScene({ id: "physical", kind: "writing" });
      for (let i = 0; i < 40; i++) advance(50, i < 2 ? 0.2 : 0);
      assert.equal(count(f, "response.cancel"), 0); assert.equal(count(f, "output_audio_buffer.clear"), 0);
      if (state) assert.equal(mute.at(-1), false);
      // Generation finishes while RTP/avatar is still pending or in a chunk gap.
      f.channel.event({ type: "response.done", response: { id: "old" } });
      state?.avatar({ type: "agent.speak_ended", source_event_id: oldSource });
      inputEvent(f, "speech_stopped"); inputEvent(f, "committed"); finalInput(f, "No");
      assert.equal(count(f, "response.create"), 2); assert.equal(count(f, "output_audio_buffer.clear"), 1);
      const clearAt = f.channel.sent.findIndex(e => e.type === "output_audio_buffer.clear");
      assert.ok(clearAt < f.channel.sent.map(e => e.type).lastIndexOf("response.create"), "Clear precedes synchronous callback release");
      if (state) {
        assert.equal(commands.filter(e => e.type === "agent.interrupt").length, 1);
        const sent = commands.length; state.pcm(1, new Uint8Array([3, 4])); state.drained(1);
        state.avatar({ type: "agent.speak_started", source_event_id: oldSource });
        assert.equal(commands.length, sent); assert.equal(mute.at(-1), true);
      }
      created(f, "new"); f.channel.event({ type: "output_audio_buffer.started", response_id: "new" });
      if (state) { state.pcm(capture.at(-1)!.epoch, new Uint8Array([5, 6])); state.avatar({ type: "agent.speak_started", source_event_id: commands.at(-1)!.event_id }); }
      f.channel.event({ type: "response.created", response: { id: "foreign" } });
      assert.equal(count(f, "output_audio_buffer.clear"), 1, "Foreign cancellation cannot clear newer audio");
      if (state) assert.equal(mute.at(-1), false);
    } finally { state?.close(); f.controller.stop(); }
  });
}

for (const order of [["stop", "commit", "final"], ["final", "commit", "stop"], ["commit", "stop", "final"], ["stop", "final", "commit"], ["commit", "final", "stop"], ["final", "stop", "commit"]]) {
  test(`managed: short Unicode answer settles ${order.join("/")} exactly once`, async () => {
    const f = fixture(); await f.connect();
    try {
      created(f, "old"); inputEvent(f, "speech_started");
      f.channel.event({ type: "conversation.item.input_audio_transcription.delta", item_id: "a", content_index: 0, delta: "不" });
      assert.equal(count(f, "response.cancel"), 0, "Partial ASR never interrupts");
      for (const event of order) {
        if (event === "final") finalInput(f, "不"); else inputEvent(f, event === "stop" ? "speech_stopped" : "committed");
        assert.equal(count(f, "response.create"), 1, "Actual old generation still owns its slot");
      }
      assert.equal(count(f, "response.cancel"), 1);
      f.channel.event({ type: "response.done", response: { id: "old" } });
      assert.equal(count(f, "response.create"), 2);
      finalInput(f, "不"); f.channel.event({ type: "response.done", response: { id: "old" } });
      assert.equal(count(f, "response.create"), 2); assert.equal(f.events.filter(e => e.type === "transcript" && e.final && e.role === "user").length, 1);
    } finally { f.controller.stop(); }
  });
}

test("managed: independent A/B input records retain late A words and coalesce B without retroactive interruption", async t => {
  const f = fixture(), advance = managedClock(t, f); await f.connect();
  try {
    created(f, "old"); inputEvent(f, "speech_started", "a"); inputEvent(f, "speech_stopped", "a"); inputEvent(f, "committed", "a");
    advance(7999); inputEvent(f, "speech_started", "b"); f.controller.reactToScene({ id: "scene", kind: "knock" }); advance(1);
    finalInput(f, "A late word", "a");
    assert.equal(count(f, "response.cancel"), 0); assert.equal(count(f, "response.create"), 1);
    inputEvent(f, "committed", "b"); finalInput(f, "نعم", "b");
    assert.equal(count(f, "response.cancel"), 1);
    f.channel.event({ type: "response.done", response: { id: "old" } }); assert.equal(count(f, "response.create"), 1);
    inputEvent(f, "speech_stopped", "b"); assert.equal(count(f, "response.create"), 2);
    assert.equal(f.events.filter(e => e.type === "transcript" && e.final && e.role === "user").length, 2);
  } finally { f.controller.stop(); }
});

for (const mode of ["empty", "failure", "sustained-failure", "sustained-expiry", "missing-commit", "late-final", "late-final-before-commit"] as const) {
  test(`managed: settlement ${mode} neither invents words nor duplicates native replies`, async t => {
    const f = fixture(), advance = managedClock(t, f); await f.connect();
    try {
      f.channel.event({ type: "response.done" }); inputEvent(f, "speech_started");
      if (mode.startsWith("sustained")) for (let i = 0; i < 12; i++) advance(50, 0.2);
      inputEvent(f, "speech_stopped");
      if (mode !== "missing-commit" && mode !== "late-final-before-commit") inputEvent(f, "committed");
      if (mode === "empty") finalInput(f, "?!");
      if (mode.endsWith("failure")) f.channel.event({ type: "conversation.item.input_audio_transcription.failed", item_id: "a", content_index: 0 });
      advance(8000);
      assert.equal(count(f, "response.create"), mode.startsWith("sustained") ? 2 : 1);
      if (mode.startsWith("late-final")) {
        finalInput(f, "7");
        if (mode === "late-final-before-commit") { assert.equal(count(f, "response.create"), 1); inputEvent(f, "committed"); }
        assert.equal(count(f, "response.create"), 2); finalInput(f, "7");
      }
      assert.equal(count(f, "response.cancel"), 0); assert.equal(count(f, "input_audio_buffer.clear"), 0);
      if (mode === "sustained-expiry") assert.equal(f.events.some(e => e.type === "transcript" || e.type === "input" && e.status === "discarded"), false);
    } finally { f.controller.stop(); }
  });
}

test("managed: duplicate stop and ASR deltas cannot extend the first deadline, resumed speech still blocks", async t => {
  const f = fixture(), advance = managedClock(t, f); await f.connect();
  try {
    f.channel.event({ type: "response.done" }); inputEvent(f, "speech_started"); inputEvent(f, "committed");
    f.controller.reactToScene({ id: "waiting", kind: "knock" });
    advance(9000); assert.equal(count(f, "response.create"), 1, "No synthetic stop");
    inputEvent(f, "speech_stopped"); advance(7000); inputEvent(f, "speech_stopped");
    f.channel.event({ type: "conversation.item.input_audio_transcription.delta", item_id: "a", content_index: 0, delta: "Still" });
    advance(999); inputEvent(f, "speech_started"); advance(1); assert.equal(count(f, "response.create"), 1);
    inputEvent(f, "speech_stopped"); assert.equal(count(f, "response.create"), 2, "Original elapsed deadline applies on the real next stop");
    assert.equal(f.events.some(e => e.type === "input" && e.status === "discarded"), false);
  } finally { f.controller.stop(); }
});

for (const boundary of ["input", "output", "both", "capability", "stop"] as const) {
  test(`managed: ${boundary} at599ms invalidates samples and reply eligibility while preserving genuine words`, async t => {
    let allowed = true; const f = fixture({ canUse: () => allowed }), advance = managedClock(t, f); await f.connect();
    try {
      created(f, "old"); inputEvent(f, "speech_started");
      for (let i = 0; i < 11; i++) advance(50, 0.2); advance(49, 0.2);
      if (boundary === "stop") f.controller.stop();
      else if (boundary === "capability") allowed = false;
      else f.controller.setMuted({ input: boundary !== "output", output: boundary !== "input" });
      const cancels = count(f, "response.cancel"); advance(1, 0.2);
      assert.equal(count(f, "response.cancel"), cancels);
      allowed = true;
      if (boundary !== "stop") f.controller.setMuted({ input: false, output: false });
      inputEvent(f, "speech_stopped"); inputEvent(f, "committed"); finalInput(f, "Buffered actual words");
      f.channel.event({ type: "response.done", response: { id: "old" } }); advance(8000);
      assert.equal(count(f, "response.create"), 1);
      assert.equal(f.events.filter(e => e.type === "transcript" && e.final && e.role === "user").length, boundary === "stop" ? 0 : 1);
      for (const update of f.channel.sent.filter(e => e.type === "session.update" && e.session.audio)) assert.deepEqual(update.session.audio.input.turn_detection, { type: "semantic_vad", eagerness: "medium", create_response: false, interrupt_response: false });
    } finally { f.controller.stop(); }
  });
}

test("managed: expiry at7999ms cannot survive stop/restart, and stale level callbacks are inert", async t => {
  const f = fixture(), advance = managedClock(t, f); await f.connect();
  inputEvent(f, "speech_started"); inputEvent(f, "speech_stopped"); inputEvent(f, "committed");
  f.controller.reactToScene({ id: "old", kind: "knock" }); advance(7999);
  const receive = f.channel.onmessage; f.controller.stop(); await f.connect();
  try { advance(1); receive?.({ data: JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: "a", content_index: 0, transcript: "old" }) }); assert.equal(count(f, "response.create"), 2); assert.equal(f.events.some(e => e.type === "transcript" && e.text === "old"), false); }
  finally { f.controller.stop(); }
});


test("managed: retry keeps newer scene cutoff queued instead of consuming it", async () => {
  const f = fixture(); await f.connect();
  try {
    created(f, "opening"); f.channel.event({ type: "response.done", response: { id: "opening" } });
    inputEvent(f, "speech_started"); f.controller.setMuted({ input: true, output: true }); f.controller.setMuted({ input: false, output: false });
    f.controller.reactToScene({ id: "restore", kind: "power-restored" }); inputEvent(f, "speech_stopped"); inputEvent(f, "committed"); finalInput(f, "Earlier");
    const request = f.channel.sent.filter(e => e.type === "response.create").at(-1)!;
    f.channel.event({ type: "response.created", response: { id: "overlap" } });
    f.channel.event({ type: "error", error: { code: "conversation_already_has_active_response", event_id: request.event_id } });
    f.controller.reactToScene({ id: "after-cutoff", kind: "knock" });
    f.channel.event({ type: "response.done", response: { id: "overlap" } }); assert.equal(count(f, "response.create"), 3);
    created(f, "retry"); f.channel.event({ type: "response.done", response: { id: "retry" } });
    assert.equal(count(f, "response.create"), 4, "A notice after the original cutoff retains its one later turn");
  } finally { f.controller.stop(); }
});

test("managed: compatibility cleanup preserves gesture unlock but prevents avatar/provider work", async () => {
  for (const avatar of [false, true]) {
    const f = avatar ? avatarFixture() : fixture(); f.deps.hasUserActivation = () => true;
    const fetch = f.deps.fetch; let posts = 0;
    f.deps.fetch = async (url, init) => {
      if (String(url).endsWith("/config")) return Response.json({ available: true, avatarAvailable: true, funding: "testing", maxDurationSeconds: 300 });
      posts++; return fetch(url, init);
    };
    const prepared = await f.controller.prepare({ avatar });
    await assert.rejects(f.controller.start({ avatar, intent: prepared.intent, instructions: "hello" }), /incompatible/i);
    assert.equal(f.calls.media, 0); assert.equal(f.calls.consent, 0); assert.equal(posts, 0); assert.equal(f.audio.closed, 1);
  }
  const f = avatarFixture(), fetch = f.deps.fetch; let posts = 0;
  f.deps.fetch = async (url, init) => {
    if (String(url).endsWith("/connect")) { posts++; assert.equal(JSON.parse(String(init?.body)).turnControl, "client-v1"); return Response.json({ sdp: "v=0\r\no=answer" }); }
    return fetch(url, init);
  };
  await assert.rejects(f.controller.start({ avatar: true, instructions: "hello" }), /incompatible/i);
  assert.equal(posts, 1); assert.equal(f.peer.remotes, 0); assert.equal(f.audio.closed, 1); assert.equal(f.track.stops, 1);
  assert.equal(f.requests.filter(r => r.url.endsWith("/avatar/stop")).length, 1);
  assert.equal(f.requests.filter(r => r.url.endsWith("/stop") && !r.url.endsWith("/avatar/stop")).length, 1);
});

test("managed: request tombstone survives confirmation before created, without releasing its slot", async () => {
  const f = fixture(); await f.connect();
  try {
    inputEvent(f, "speech_started"); inputEvent(f, "speech_stopped"); inputEvent(f, "committed"); finalInput(f, "No");
    assert.equal(count(f, "response.create"), 1); assert.equal(count(f, "output_audio_buffer.clear"), 1);
    created(f, "late-created");
    f.channel.event({ type: "response.output_audio_transcript.done", response_id: "late-created", item_id: "late", content_index: 0, transcript: "Never deliver" });
    assert.equal(f.events.some(e => e.type === "transcript" && e.text === "Never deliver"), false);
    assert.equal(count(f, "response.create"), 1);
    f.channel.event({ type: "response.done", response: { id: "late-created" } }); assert.equal(count(f, "response.create"), 2);
  } finally { f.controller.stop(); }
});


test("managed: final before stop stays settled in public input receipts", async () => {
  const f = fixture(); await f.connect();
  try {
    inputEvent(f, "speech_started"); inputEvent(f, "committed"); finalInput(f, "No");
    const finalIndex = f.events.map(e => e.type === "transcript" && e.final).lastIndexOf(true);
    inputEvent(f, "speech_stopped"); inputEvent(f, "speech_stopped");
    assert.equal(f.events.slice(finalIndex + 1).some(e => e.type === "input" && e.status === "transcribing"), false, "A delayed/duplicate stop cannot recreate root voicePending after genuine final ASR");
  } finally { f.controller.stop(); }
});

test("managed: response input membership records commits with holes instead of a sequence watermark", async t => {
  const f = fixture(), advance = managedClock(t, f); await f.connect();
  try {
    f.channel.event({ type: "response.done" }); inputEvent(f, "speech_started"); inputEvent(f, "speech_stopped");
    f.controller.reactToScene({ id: "scene", kind: "knock" }); advance(8000); assert.equal(count(f, "response.create"), 2);
    created(f, "scene"); inputEvent(f, "committed"); finalInput(f, "No");
    assert.equal(count(f, "response.cancel"), 0); assert.equal(count(f, "response.create"), 2);
    f.channel.event({ type: "response.done", response: { id: "scene" } }); assert.equal(count(f, "response.create"), 3, "Input absent at scene request has not already been included");
  } finally { f.controller.stop(); }
});


for (const finalAt of [7999, 8000, 8001]) {
  test(`managed: real final at${finalAt}ms keeps one response and one genuine receipt`, async t => {
    const f = fixture(), advance = managedClock(t, f); await f.connect();
    try {
      f.channel.event({ type: "response.done" }); inputEvent(f, "speech_started"); inputEvent(f, "speech_stopped"); inputEvent(f, "committed");
      f.controller.reactToScene({ id: "queued", kind: "knock" }); advance(finalAt); finalInput(f, "No"); advance(1);
      assert.equal(count(f, "response.create"), 2); assert.equal(count(f, "response.cancel"), 0);
      assert.equal(f.events.filter(e => e.type === "transcript" && e.final && e.role === "user").length, 1);
      assert.equal(f.events.some(e => e.type === "input" && e.status === "discarded"), false);
    } finally { f.controller.stop(); }
  });
}

for (const output of [false, true]) {
  test(`managed: ${output ? "outage" : "input mute"} at7999ms lets restoration resume without reviving expired input`, async t => {
    const f = fixture(), advance = managedClock(t, f); await f.connect();
    try {
      f.channel.event({ type: "response.done" }); inputEvent(f, "speech_started");
      for (let i = 0; i < 12; i++) advance(50, 0.2);
      inputEvent(f, "speech_stopped"); inputEvent(f, "committed"); advance(7999);
      f.controller.setMuted({ input: true, output }); advance(1); assert.equal(count(f, "response.create"), 1);
      f.controller.setMuted({ input: false, output: false }); f.controller.reactToScene({ id: "restore", kind: "power-restored" });
      assert.equal(count(f, "response.create"), 2); created(f, "restored"); finalInput(f, "Before the cut");
      assert.equal(count(f, "response.cancel"), 0); f.channel.event({ type: "response.done", response: { id: "restored" } });
      assert.equal(count(f, "response.create"), 2); assert.equal(f.events.filter(e => e.type === "transcript" && e.final && e.role === "user").length, 1);
    } finally { f.controller.stop(); }
  });
}


test("managed: obsolete police-only work cannot become a generic reply while direct playback drains", async () => {
  const f = fixture(); await f.connect();
  const event = (id: string, at: number, kind: string, actor: string, data: object) => ({ id, attempt: "a", at, kind, actor, visibility: kind === "director" ? "internal" : "public", data });
  const order = (action: string, at: number) => event(action, at, "director", "director", { action, args: action === "release-resident" ? {} : { evidenceId: "e" }, phase: "inspection", edition: "ai", nextDelay: 8, reason: "Public record." });
  let events = [event("e", 0, "observation", "screen", { code: "writing" }), order("dispatch-police", 0), event("entry", 8, "police", "police", { code: "entering" }), event("search", 11, "police", "police", { code: "searching" })];
  const variables = () => ({ "unperson-room": { version: 1, attempt: "a", clock: 15, events }, "unperson-state": { phase: "inspection", calm: false } });
  try {
    created(f, "old"); f.channel.event({ type: "output_audio_buffer.started", response_id: "old" });
    f.controller.reactToScene(hydrateVoiceSceneNotice({ id: "search", kind: "bulletin" }, variables(), [], "48.0.0", variables));
    f.channel.event({ type: "response.done", response: { id: "old" } });
    events = [...events, order("release-resident", 15)];
    f.channel.event({ type: "output_audio_buffer.stopped", response_id: "old" });
    assert.equal(count(f, "response.create"), 1, "Only actual current host police work may launch speech");
    assert.equal(count(f, "response.cancel"), 0);
  } finally { f.controller.stop(); }
});


for (const avatar of [false, true]) {
  test(`outage review: settled fresh input waits for abandoned retry overlap retirement (${avatar ? "avatar" : "direct"})`, async () => {
    const f = avatar ? avatarFixture() : fixture(); await f.connect();
    try {
      created(f, "opening"); f.channel.event({ type: "response.done", response: { id: "opening" } });
      inputEvent(f, "speech_started", "pre-cut");
      f.controller.setMuted({ input: true, output: true }); f.controller.setMuted({ input: false, output: false });
      f.controller.reactToScene({ id: "restore-handoff", kind: "power-restored" });
      inputEvent(f, "speech_stopped", "pre-cut"); inputEvent(f, "committed", "pre-cut"); finalInput(f, "Before the cut.", "pre-cut");
      const rejected = f.channel.sent.filter(e => e.type === "response.create").at(-1)!;
      assert.equal(count(f, "response.create"), 2);
      f.channel.event({ type: "response.created", response: { id: "old-overlap" } });
      f.channel.event({ type: "error", error: { code: "conversation_already_has_active_response", event_id: rejected.event_id } });
      assert.equal(f.track.stops, 0);

      // Supersede the rejected request, then fully settle fresh input while the
      // identified old provider generation still owns the conversation slot.
      inputEvent(f, "speech_started", "fresh");
      inputEvent(f, "speech_stopped", "fresh"); inputEvent(f, "committed", "fresh"); finalInput(f, "No", "fresh");
      assert.equal(count(f, "response.create"), 2, "Settled input must not release the live overlap generation gate");
      f.controller.reactToScene({ id: "fresh-scene", kind: "writing" });
      assert.equal(count(f, "response.create"), 2, "Direct scene scheduling also respects known provider ownership");
      const beforeInstructions = count(f, "session.update");
      f.controller.updateInstructions("Current direction after the interrupted turn.");
      assert.equal(count(f, "session.update"), beforeInstructions, "Instructions also wait for the real quiet boundary");
      assert.equal(count(f, "conversation.item.delete"), 0, "Surviving scene context remains queued through handoff");

      f.channel.event({ type: "response.done", response: { id: "old-overlap", status: "cancelled" } });
      assert.equal(count(f, "response.create"), 3, "Retirement releases exactly one combined fresh-input/scene answer");
      assert.equal(f.channel.sent.at(-2)?.session.instructions, "Current direction after the interrupted turn.");
      const freshRequest = f.channel.sent.filter(e => e.type === "response.create").at(-1)!;
      assert.notEqual(freshRequest.event_id, rejected.event_id);
      created(f, "fresh-answer");
      f.channel.event({ type: "response.output_audio_transcript.done", response_id: "fresh-answer", item_id: "fresh-answer-text", content_index: 0, transcript: "Your answer is recorded." });
      f.channel.event({ type: "response.done", response: { id: "old-overlap", status: "cancelled" } });
      finalInput(f, "No", "fresh");
      f.channel.event({ type: "response.done", response: { id: "fresh-answer" } });
      assert.equal(count(f, "response.create"), 3, "Duplicate old retirement and ASR cannot create another answer");
      assert.equal(f.events.filter(e => e.type === "transcript" && e.role === "user" && e.final).length, 2);
      assert.equal(f.events.filter(e => e.type === "transcript" && e.text === "Your answer is recorded.").length, 1);
      assert.equal(f.events.some(e => e.type === "status" && e.status === "error"), false);
      assert.equal(f.track.stops, 0); assert.equal(f.audio.closed, 0);
    } finally { f.controller.stop(); }
  });
}

const sceneHeader = "\n\nCurrent witnessed scene context:\n";
test('structured context retains full replacement semantics on the Realtime fallback', async () => {
  const f=fixture(), fetch=f.deps.fetch;
  let posted: {instructions:string}|undefined;
  f.deps.fetch=async(url,init)=>{if(String(url).endsWith('/connect'))posted=JSON.parse(String(init?.body));return fetch(url,init);};
  const initial={state:{identity:'Resident 6079.',sight:'At the door.'},events:[{id:'speech:1',text:'I live alone.'}]};
  try {
    const pending=f.controller.start({instructions:'Official.',context:initial});await tick();f.channel.open();await pending;
    assert.equal(posted?.instructions,'Official.'+sceneHeader+'Resident 6079.\nAt the door.\nI live alone.');
    f.channel.event({type:'response.done'});
    f.controller.updateContext({...initial,state:{...initial.state,sight:'In view.'}});
    const update=f.channel.sent.filter(event=>event.type==='session.update'&&event.session.instructions).at(-1);
    assert.equal(update?.session.instructions,'Official.'+sceneHeader+'Resident 6079.\nIn view.\nI live alone.');
    assert.equal(f.channel.sent.some(event=>event.type==='session.thinking.append'),false);
  } finally { f.controller.stop(); }
});
for (const prepared of [false, true]) test(`initial scene: connect, replacement and reconnect (${prepared ? "prepared" : "fresh"})`, async () => {
  const f = fixture({ hasUserActivation: () => true }), requests: string[] = [], fetch = f.deps.fetch;
  f.deps.fetch = async (url, init) => { if (String(url).endsWith("/connect")) requests.push(JSON.parse(String(init?.body)).instructions); return fetch(url, init); };
  try {
    const intent = prepared ? (await f.controller.prepare({})).intent : undefined;
    const pending = f.controller.start({ instructions: "Actor direction.", context: "Physical phase: find.", ...(intent ? { intent } : {}) });
    await tick(); f.channel.open(); await pending;
    assert.equal(requests[0], "Actor direction." + sceneHeader + "Physical phase: find.");
    f.channel.event({ type: "response.done" }); f.controller.updateContext("Physical phase: conceal."); f.controller.updateInstructions("Replacement actor.");
    const latest = f.channel.sent.filter(e => e.type === "session.update" && e.session.instructions).at(-1)!.session.instructions;
    assert.equal(latest, "Replacement actor." + sceneHeader + "Physical phase: conceal."); assert.equal(latest.match(/Physical phase:/g)?.length, 1); assert.doesNotMatch(latest, /find/);
    f.controller.stop(); const reconnect = f.controller.start({ instructions: "Legacy actor." }); await tick(); f.channel.open(); await reconnect; assert.equal(requests.at(-1), "Legacy actor.");
  } finally { f.controller.stop(); }
});
test("initial scene: invalid context and combined 12001 reject before capture or network", async () => {
  for (const options of [...[null, 3, {}, [], "x".repeat(4001)].map(context => ({ instructions: "Actor.", context })), { instructions: "x".repeat(12000 - sceneHeader.length), context: "y" }]) {
    const f = fixture(); try {
      const pending = f.controller.start(options), rejected = assert.rejects(pending, /context|combined|instruction/i); await tick(); f.channel.open(); await rejected;
      assert.equal(f.calls.media, 0); assert.equal(f.calls.fetch, 0); assert.equal(f.calls.consent, 0);
    } finally { f.controller.stop(); }
  }
});
test("initial scene: exact 12000 includes separator and empty context preserves legacy instructions", async () => {
  for (const context of ["y", ""]) {
    const f = fixture(), instructions = "x".repeat(context ? 12000 - sceneHeader.length - 1 : 12000), fetch = f.deps.fetch; let actual = "";
    f.deps.fetch = async (url, init) => { if (String(url).endsWith("/connect")) actual = JSON.parse(String(init?.body)).instructions; return fetch(url, init); };
    try { const pending = f.controller.start({ instructions, context }); await tick(); f.channel.open(); await pending; assert.equal(actual, instructions + (context ? sceneHeader + context : "")); assert.equal(actual.length, 12000); } finally { f.controller.stop(); }
  }
});
