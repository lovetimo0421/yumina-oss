import assert from "node:assert/strict";
import test from "node:test";
import { AvatarUtterances, AvatarFrameGate } from "./avatar-voice-audio-state";

function harness() {
  let next = 0;
  const commands: Record<string, unknown>[] = [], capture: Record<string, unknown>[] = [];
  const playback: string[] = [], muted: boolean[] = [];
  const state = new AvatarUtterances({
    uuid: () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`,
    send: event => commands.push(event), capture: event => capture.push(event),
    playback: event => playback.push(event), mute: value => muted.push(value),
  });
  return { state, commands, capture, playback, muted };
}

test("source chunks cannot speak before connected, or without an active output utterance", () => {
  const h = harness();
  h.state.pcm(0, new Uint8Array([1, 2]));
  h.state.provider({ type: "output_audio_buffer.started", response_id: "r1" });
  h.state.pcm(1, new Uint8Array([1, 2]));
  assert.equal(h.commands.length, 0);
  h.state.connected();
  h.state.provider({ type: "output_audio_buffer.started", response_id: "r1" });
  h.state.pcm(1, new Uint8Array([1, 2]));
  assert.equal(h.commands[0].type, "agent.speak");
  assert.equal(h.commands[0].audio, "AQI=");
  assert.match(String(h.commands[0].event_id), /^[\da-f-]{36}$/);
});

test("source stop drains tail before one speak_end and consumes OpenAI playback only", () => {
  const h = harness(); h.state.connected();
  assert.equal(h.state.provider({ type: "response.created", response: { id: "r1" } }), false);
  assert.equal(h.state.provider({ type: "output_audio_buffer.started", response_id: "r1" }), true);
  h.state.pcm(1, new Uint8Array([1, 2]));
  assert.equal(h.state.provider({ type: "output_audio_buffer.stopped", response_id: "r1" }), true);
  assert.equal(h.capture.at(-1)?.type, "drain");
  assert.equal(h.commands.length, 1);
  h.state.pcm(1, new Uint8Array([3, 4])); h.state.drained(1); h.state.drained(1);
  assert.deepEqual(h.commands.map(e => e.type), ["agent.speak", "agent.speak", "agent.speak_end"]);
  assert.equal(new Set(h.commands.map(e => e.event_id)).size, 1);
  assert.deepEqual(h.playback, [], "source playback never reports avatar speech");
});

test("an early avatar end retains later source PCM and never completes the turn at a chunk gap", () => {
  const h = harness(); h.state.connected();
  h.state.provider({ type: "output_audio_buffer.started", response_id: "r1" });
  h.state.pcm(1, new Uint8Array([1, 2])); const id = h.commands[0].event_id;
  h.state.avatar({ type: "agent.speak_started", source_event_id: id });
  h.state.avatar({ type: "agent.speak_ended", source_event_id: id });
  assert.equal(h.muted.at(-1), true); assert.deepEqual(h.playback, ["started"], "A chunk gap must not clear pending avatar speech or flush queued scenes.");
  h.state.pcm(1, new Uint8Array([3, 4]));
  assert.equal(h.commands.length, 2, "Later source PCM must reach the same pending utterance."); assert.equal(h.commands[1].event_id, id);
  h.state.avatar({ type: "agent.speak_started", source_event_id: id }); assert.equal(h.muted.at(-1), false);
  h.state.provider({ type: "output_audio_buffer.stopped", response_id: "r1" });h.state.drained(1);
  assert.equal(h.commands.at(-1)?.type, "agent.speak_end"); assert.equal(h.commands.at(-1)?.event_id, id);
  h.state.avatar({ type: "agent.speak_ended", source_event_id: id });
  assert.equal(h.playback.at(-1), "stopped"); assert.equal(h.muted.at(-1), true);
});

test("barge-in after an unsealed avatar end interrupts the server and the next correlated response becomes audible", () => {
  const h = harness(); h.state.connected();
  h.state.provider({ type: "output_audio_buffer.started", response_id: "old" });h.state.pcm(1, new Uint8Array([1, 2]));const oldId=h.commands[0].event_id;
  h.state.avatar({ type: "agent.speak_started", source_event_id: oldId });h.state.avatar({ type: "agent.speak_ended", source_event_id: oldId });
  h.state.provider({ type: "input_audio_buffer.speech_started" });assert.notEqual(h.commands.at(-1)?.type,"agent.interrupt");
  h.state.client({ type: "response.cancel", response_id: "old" });assert.equal(h.commands.at(-1)?.type,"agent.interrupt");
  const interrupted=h.commands.length;h.state.pcm(1,new Uint8Array([3,4]));h.state.drained(1);assert.equal(h.commands.length,interrupted);
  h.state.provider({ type:"output_audio_buffer.started",response_id:"new" });h.state.pcm(Number(h.capture.at(-1)?.epoch),new Uint8Array([5,6]));const newId=h.commands.at(-1)?.event_id;
  h.state.avatar({ type:"agent.speak_started",source_event_id:oldId });assert.equal(h.muted.at(-1),true,"Old server identities cannot open the gate.");
  h.state.avatar({ type:"agent.speak_started",source_event_id:newId });assert.equal(h.muted.at(-1),false);
});

test("a final chunk end closes only after source drain, including an ended draining tail", () => {
  const h=harness();h.state.connected();h.state.provider({type:"output_audio_buffer.started",response_id:"r1"});h.state.pcm(1,new Uint8Array([1,2]));const id=h.commands[0].event_id;
  h.state.avatar({type:"agent.speak_started",source_event_id:id});h.state.provider({type:"output_audio_buffer.stopped",response_id:"r1"});h.state.avatar({type:"agent.speak_ended",source_event_id:id});
  assert.deepEqual(h.playback,["started"]);h.state.drained(1);assert.equal(h.commands.at(-1)?.type,"agent.speak_end");assert.deepEqual(h.playback,["started","stopped"]);
  const completed=h.commands.length;h.state.provider({type:"input_audio_buffer.speech_started"});assert.equal(h.commands.length,completed,"A fully closed turn needs no interrupt.");
});

test("a sealed correlated final end completes a retained gap even without a repeated start", () => {
  const h=harness();h.state.connected();h.state.provider({type:"output_audio_buffer.started",response_id:"r1"});h.state.pcm(1,new Uint8Array([1,2]));const id=h.commands[0].event_id;
  h.state.avatar({type:"agent.speak_started",source_event_id:id});h.state.avatar({type:"agent.speak_ended",source_event_id:id});h.state.pcm(1,new Uint8Array([3,4]));h.state.drained(1);
  assert.deepEqual(h.playback,["started"]);h.state.avatar({type:"agent.speak_ended",source_event_id:id});assert.deepEqual(h.playback,["started","stopped"]);
});

test("interrupt immediately silences, discards late PCM and old provider lifecycle", () => {
  const h = harness(); h.state.connected();
  h.state.provider({ type: "output_audio_buffer.started", response_id: "old" });
  h.state.pcm(1, new Uint8Array([1, 2])); const oldId = h.commands[0].event_id;
  h.state.avatar({ type: "agent.speak_started", source_event_id: oldId });
  assert.equal(h.state.provider({ type: "input_audio_buffer.speech_started" }), false);
  assert.equal(h.muted.at(-1), false, "Raw onset preserves output");
  h.state.client({ type: "response.cancel", response_id: "old" });
  assert.equal(h.muted.at(-1), true); assert.equal(h.playback.at(-1), "cleared");
  const interruptedAt = h.commands.length;
  h.state.pcm(1, new Uint8Array([3, 4])); h.state.drained(1);
  h.state.provider({ type: "output_audio_buffer.started", response_id: "old" });
  h.state.provider({ type: "output_audio_buffer.stopped", response_id: "old" });
  assert.equal(h.commands.length, interruptedAt);
  h.state.provider({ type: "output_audio_buffer.started", response_id: "new" });
  h.state.pcm(Number(h.capture.at(-1)?.epoch), new Uint8Array([5, 6]));
  const newId = h.commands.at(-1)?.event_id;
  h.state.avatar({ type: "agent.speak_started", source_event_id: newId });
  assert.equal(h.muted.at(-1), false);
  const playbackCount = h.playback.length;
  h.state.avatar({ type: "agent.speak_ended", source_event_id: oldId });
  h.state.avatar({ type: "agent.audio_buffer_cleared", source_event_id: h.commands[1].event_id });
  h.state.provider({ type: "output_audio_buffer.cleared", response_id: "old" });
  assert.equal(h.muted.at(-1), false); assert.equal(h.playback.length, playbackCount);
});

test("mute is preserved across new playback and unknown playback identities never unmute", () => {
  const h = harness(); h.state.connected(); h.state.setMuted(true);
  h.state.provider({ type: "output_audio_buffer.started", response_id: "r1" });
  h.state.pcm(1, new Uint8Array([1, 2]));
  const id = h.commands[0].event_id;
  h.state.avatar({ type: "agent.speak_started", source_event_id: "unknown" });
  assert.deepEqual(h.playback, []);
  h.state.avatar({ type: "agent.speak_started", source_event_id: id });
  assert.equal(h.muted.at(-1), true);
  h.state.setMuted(false); assert.equal(h.muted.at(-1), false);
  h.state.drained(1);
  h.state.avatar({ type: "agent.speak_ended", source_event_id: id });
  assert.deepEqual(h.playback, ["started", "stopped"]); assert.equal(h.muted.at(-1), true);
});

test("late end of a previous valid utterance does not stop the next playback", () => {
  const h = harness(); h.state.connected();
  for (const response_id of ["one", "two"]) {
    h.state.provider({ type: "output_audio_buffer.started", response_id });
    const epoch = Number(h.capture.at(-1)?.epoch);
    h.state.pcm(epoch, new Uint8Array([1, 2]));
    h.state.avatar({ type: "agent.speak_started", source_event_id: h.commands.at(-1)?.event_id });
    h.state.drained(epoch);
  }
  const count = h.playback.length;
  h.state.avatar({ type: "agent.speak_ended", source_event_id: h.commands[0].event_id });
  assert.equal(h.playback.length, count); assert.equal(h.muted.at(-1), false);
});

test("explicit client clear/cancel interrupts; close blocks every late callback", () => {
  const h = harness(); h.state.connected();
  h.state.provider({ type: "output_audio_buffer.started", response_id: "r1" });
  h.state.pcm(1, new Uint8Array([1, 2]));
  h.state.client({ type: "response.cancel" });
  assert.equal(h.commands.at(-1)?.type, "agent.interrupt");
  h.state.client({ type: "output_audio_buffer.clear" });
  assert.equal(h.commands.filter(e => e.type === "agent.interrupt").length, 1);
  h.state.close(); const count = h.commands.length;
  h.state.connected(); h.state.provider({ type: "output_audio_buffer.started", response_id: "r2" });
  h.state.pcm(3, new Uint8Array([1, 2]));
  assert.equal(h.commands.length, count);
});

test("video allows one outstanding frame, stale acks cannot release it and close releases owned frames", () => {
  const gate = new AvatarFrameGate();
  const first = gate.begin(); assert.equal(first, 1); assert.equal(gate.begin(), null);
  gate.ack(200); assert.equal(gate.begin(), null);
  gate.ack(first!); assert.equal(gate.begin(), 2);
  gate.close(); assert.equal(gate.begin(), null);
  assert.deepEqual(AvatarFrameGate.size(1920, 1080), { width: 768, height: 432 });
  assert.deepEqual(AvatarFrameGate.size(320, 240), { width: 320, height: 240 });
});

test("accepted output starts report pending once; old and duplicate starts never reopen capture", () => {
  let pending = 0;
  const state = new AvatarUtterances({ uuid: () => "id", send() {}, capture() {}, playback() {}, mute() {}, pending: () => { pending++; } });
  state.connected();
  state.provider({ type: "output_audio_buffer.started", response_id: "r1" }); state.pcm(1, new Uint8Array([1, 2]));
  state.drained(1);
  state.provider({ type: "output_audio_buffer.started", response_id: "r1" });
  assert.equal(pending, 1);
  state.client({ type: "output_audio_buffer.clear" });
  state.provider({ type: "output_audio_buffer.started", response_id: "r1" });
  assert.equal(pending, 1);
});

test("missing actual avatar playback fails within a bounded deadline", () => {
  let now = 0; const errors: string[] = [];
  const state = new AvatarUtterances({ uuid: () => "id", send() {}, capture() {}, playback() {}, mute() {}, now: () => now, error: e => errors.push(e) });
  state.connected(); state.provider({ type: "output_audio_buffer.started", response_id: "r1" });
  state.pcm(1, new Uint8Array([1, 2])); state.drained(1);
  now = 29_000; state.checkTimeout(); assert.deepEqual(errors, []);
  now = 30_001; state.checkTimeout(); assert.match(errors[0], /playback timed out/i);
});

test("LITE keep-alive is sent only while its protocol connection is ready", () => {
  const h = harness(); h.state.keepAlive(); assert.equal(h.commands.length, 0);
  h.state.connected(); h.state.keepAlive(); assert.equal(h.commands[0].type, "session.keep_alive");
  h.state.close(); h.state.keepAlive(); assert.equal(h.commands.length, 1);
});

test("late provider clear for an earlier retained utterance never clears newer speech", () => {
  const h = harness(); h.state.connected();
  h.state.provider({ type: "output_audio_buffer.started", response_id: "old" });
  h.state.pcm(1, new Uint8Array([1, 2])); h.state.drained(1);
  h.state.provider({ type: "output_audio_buffer.started", response_id: "new" });
  h.state.pcm(2, new Uint8Array([3, 4]));
  h.state.avatar({ type: "agent.speak_started", source_event_id: h.commands.at(-1)?.event_id });
  const count = h.commands.length;
  h.state.provider({ type: "output_audio_buffer.cleared", response_id: "old" });
  assert.equal(h.muted.at(-1), false); assert.equal(h.playback.at(-1), "started");
  assert.equal(h.commands.length, count);
});


test("targeted old cancellation cannot tombstone a newer accepted response before its RTP starts", () => {
  const h = harness(); h.state.connected();
  h.state.provider({ type: "response.created", response: { id: "old" } });
  h.state.provider({ type: "output_audio_buffer.started", response_id: "old" });
  h.state.pcm(1, new Uint8Array([1, 2]));
  h.state.provider({ type: "response.created", response: { id: "new" } });
  h.state.client({ type: "response.cancel", response_id: "old" });
  h.state.provider({ type: "output_audio_buffer.started", response_id: "new" });
  h.state.pcm(Number(h.capture.at(-1)?.epoch), new Uint8Array([3, 4]));
  assert.equal(h.commands.at(-1)?.type, "agent.speak");
  h.state.avatar({ type: "agent.speak_started", source_event_id: h.commands.at(-1)?.event_id });
  assert.equal(h.muted.at(-1), false);
});
