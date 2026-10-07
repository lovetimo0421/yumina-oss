import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { RoomEvent, type RemoteTrack, type Room } from "livekit-client";
import { createAvatarVoiceAudio, type AvatarAudioRuntime, type AvatarConnection } from "./avatar-voice-audio";

const connection: AvatarConnection = { sessionId: "avatar-session", livekitUrl: "wss://media.invalid", livekitClientToken: "token", wsUrl: "wss://control.invalid", maxDurationSeconds: 300 };
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  const abort = new AbortController(), events: string[] = [], errors: string[] = [], muted: boolean[] = [];
  const outputStreams: MediaStream[] = [], frames: { id: number; frame: ImageBitmap }[] = [];
  const nodes: { outputs: unknown[]; disconnected: boolean }[] = [];
  const node = () => { const n = { outputs: [] as unknown[], disconnected: false, connect(to: unknown) { n.outputs.push(to); }, disconnect() { n.disconnected = true; } }; nodes.push(n); return n; };
  const context = { state: "running", sampleRate: 24000, destination: {},
    resume: async () => { events.push("capture-resume"); }, close: async () => { events.push("capture-close"); },
    createMediaStreamSource: () => node(), createGain: () => ({ ...node(), gain: { value: 1 } }),
  } as unknown as AudioContext;
  const capture = { ...node(), port: { onmessage: null, postMessage() {}, close() { events.push("port-close"); } }, onprocessorerror: null } as unknown as AudioWorkletNode;
  class FakeRoom extends EventEmitter {
    remoteParticipants = new Map();
    async connect() { events.push("room-connect"); }
    async disconnect() { events.push("room-close"); }
  }
  const room = new FakeRoom();
  const socket = {
    readyState: 1, bufferedAmount: 0, onmessage: null as ((event: { data: string }) => void) | null,
    onopen: null, onclose: null as (() => void) | null, onerror: null as (() => void) | null,
    sent: [] as Record<string, unknown>[], send(text: string) { this.sent.push(JSON.parse(text)); },
    close() { events.push("socket-close"); this.readyState = 3; },
  };
  const clock = { muted: false, srcObject: null, setAttribute() {}, play: async () => { events.push("clock-play"); }, pause() { events.push("clock-pause"); } } as unknown as HTMLAudioElement;
  const video = Object.assign(new EventTarget(), { muted: false, autoplay: false, playsInline: false, srcObject: null,
    readyState: 2, videoWidth: 1920, videoHeight: 1080, currentTime: 1,
    setAttribute() {}, play: async () => { events.push("video-play"); }, pause() { events.push("video-pause"); },
  }) as unknown as HTMLVideoElement;
  let pump: FrameRequestCallback | undefined, frameTime = 0;
  const runtime: AvatarAudioRuntime = {
    createOutput: () => { events.push("output-create"); return {
      ready: async () => {}, attach: stream => { outputStreams.push(stream); }, attachInput() {}, setSpatial() {},
      setMuted: value => muted.push(value), close: () => events.push("output-close"),
    }; },
    createCaptureContext: () => { events.push("capture-create"); return context; },
    createClockElement: () => clock, createVideoElement: () => video,
    createWorklet: async () => capture, createSocket: () => socket as unknown as WebSocket,
    createRoom: () => room as unknown as Room,
    createStream: track => ({ getTracks: () => [track], getAudioTracks: () => track.kind === "audio" ? [track] : [] }) as unknown as MediaStream,
    createFrame: async (_video, width, height) => ({ width, height, close() { events.push("frame-close"); } }) as unknown as ImageBitmap,
    scheduleFrame: callback => { pump = callback; return 1; }, cancelFrame: () => { pump = undefined; },
    connectTimeoutMs: 200,
  };
  const start = (onVideoFrame = (frame: typeof frames[number]) => { events.push("frame"); frames.push(frame); }) => createAvatarVoiceAudio(() => {}, () => {}, {
    signal: abort.signal, onError: error => errors.push(error), onPlayback: event => events.push(event),
    onSourceActivity: active => events.push(`source:${active}`), onQueue: count => events.push(`queue:${count}`),
    onVideoStatus: status => events.push(status), onVideoFrame,
  }, runtime);
  const track = (kind: "audio" | "video") => ({ kind, mediaStreamTrack: { kind, stop() { events.push(`${kind}-stop`); } }, detach() {} }) as unknown as RemoteTrack;
  const tracks = [track("audio"), track("video")];
  const mediaReady = async () => {
    await settle(); socket.onmessage?.({ data: JSON.stringify({ type: "session.state_updated", state: "connected" }) });
    for (const track of tracks) room.emit(RoomEvent.TrackSubscribed, track);
    await settle();
  };
  const nextFrame = async () => { pump?.(frameTime += 60); await settle(); };
  const ready = async () => { await mediaReady(); await nextFrame(); };
  return { runtime, start, ready, mediaReady, abort, room, socket, context, capture, nodes, outputStreams, frames, events, errors, muted, clock, video, tracks,
    pump: nextFrame };
}

test('media track replacement during full reconnect preserves the owned call', async t => {
  const h = harness(), audio = h.start(); t.after(() => audio.close());
  const pending = audio.connectAvatar(connection); await h.ready(); await pending;
  audio.ackVideoFrame(h.frames[0].id);
  // LiveKit unwinds subscriptions BEFORE emitting Reconnecting.
  h.room.emit(RoomEvent.TrackUnsubscribed, h.tracks[0]);
  h.room.emit(RoomEvent.TrackUnsubscribed, h.tracks[1]);
  h.room.emit(RoomEvent.Reconnecting);
  assert.deepEqual(h.errors, [], 'temporary track loss must allow the SDK to recover');
  assert.ok(!h.events.includes('output-close'));
  h.room.emit(RoomEvent.Reconnected);
  const replacements = h.tracks.map(track => ({ ...track, mediaStreamTrack: { ...track.mediaStreamTrack } }));
  for (const track of replacements) h.room.emit(RoomEvent.TrackSubscribed, track);
  await settle(); h.video.currentTime = 0; await h.pump();
  assert.equal(h.outputStreams.length, 2);
  assert.equal(h.frames.length, 2);
  assert.equal(h.events.filter(event => event === 'live').length, 2);
  assert.equal(h.events.filter(event => event === 'room-connect').length, 1);
  assert.deepEqual(h.errors, []);
});

test('media recovery stays bounded even when the SDK reconnects without both tracks', async t => {
  const h = harness(); h.runtime.reconnectTimeoutMs = 25;
  const audio = h.start(); t.after(() => audio.close());
  const pending = audio.connectAvatar(connection); await h.ready(); await pending;
  h.room.emit(RoomEvent.TrackUnsubscribed, h.tracks[0]);
  h.room.emit(RoomEvent.Reconnecting); h.room.emit(RoomEvent.Reconnected);
  assert.deepEqual(h.errors, []);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(h.errors, ['Avatar media could not reconnect. Start voice again.']);
  assert.equal(h.events.filter(event => event === 'room-close').length, 1);
});

test('a surviving old video frame cannot satisfy a later replacement during recovery', async t => {
  const h = harness(), audio = h.start(); t.after(() => audio.close());
  const pending = audio.connectAvatar(connection); await h.ready(); await pending;
  audio.ackVideoFrame(h.frames[0].id);
  h.room.emit(RoomEvent.TrackUnsubscribed, h.tracks[0]);
  h.video.currentTime = 2; await h.pump(); audio.ackVideoFrame(h.frames[1].id);
  h.room.emit(RoomEvent.TrackUnsubscribed, h.tracks[1]);
  h.room.emit(RoomEvent.Reconnecting); h.room.emit(RoomEvent.Reconnected);
  for (const track of h.tracks) h.room.emit(RoomEvent.TrackSubscribed, { ...track });
  await settle();
  assert.equal(h.events.filter(event => event === 'live').length, 1, 'replacement needs its own frame');
  h.video.currentTime = 0; await h.pump();
  assert.equal(h.events.filter(event => event === 'live').length, 2);
  assert.deepEqual(h.errors, []);
});

test('a pending pre-reconnect bitmap cannot establish recovered video', async t => {
  const h = harness(), audio = h.start(); t.after(() => audio.close());
  const pending = audio.connectAvatar(connection); await h.ready(); await pending;
  audio.ackVideoFrame(h.frames[0].id);
  const bitmap = deferred<ImageBitmap>(), createFrame = h.runtime.createFrame;
  h.runtime.createFrame = () => bitmap.promise;
  h.video.currentTime = 2; await h.pump();
  h.room.emit(RoomEvent.Reconnecting); h.room.emit(RoomEvent.Reconnected);
  let disposed = false;
  bitmap.resolve({ close() { disposed = true; } } as ImageBitmap); await settle();
  assert.equal(disposed, true); assert.equal(h.frames.length, 1);
  assert.equal(h.events.filter(event => event === 'live').length, 1);
  h.runtime.createFrame = createFrame; h.video.currentTime = 3; await h.pump();
  assert.equal(h.events.filter(event => event === 'live').length, 2);
});

test('a surviving frozen video stays connecting until its clock advances', async t => {
  const h = harness(), audio = h.start(); t.after(() => audio.close());
  const pending = audio.connectAvatar(connection); await h.ready(); await pending;
  audio.ackVideoFrame(h.frames[0].id);
  h.room.emit(RoomEvent.Reconnecting); h.room.emit(RoomEvent.Reconnected);
  await h.pump();
  assert.equal(h.frames.length, 1, 'the old frozen frame is not recovery');
  assert.equal(h.events.filter(event => event === 'live').length, 1);
  h.video.currentTime = 2; await h.pump();
  assert.equal(h.frames.length, 2);
  assert.equal(h.events.filter(event => event === 'live').length, 2);
  assert.deepEqual(h.errors, []);
});

test('ending voice during media recovery cancels the timer and ignores late tracks', async t => {
  const h = harness(); h.runtime.reconnectTimeoutMs = 25;
  const audio = h.start(); t.after(() => audio.close());
  const pending = audio.connectAvatar(connection); await h.ready(); await pending;
  h.room.emit(RoomEvent.TrackUnsubscribed, h.tracks[1]);
  h.abort.abort(); h.room.emit(RoomEvent.Reconnected);
  for (const track of h.tracks) h.room.emit(RoomEvent.TrackSubscribed, track);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(h.errors, []);
  assert.equal(h.events.filter(event => event === 'room-close').length, 1);
  assert.equal(h.events.filter(event => event === 'live').length, 1);
});

test('a late bitmap from a removed track cannot mark the replacement live', async t => {
  const h = harness(), audio = h.start(); t.after(() => audio.close());
  const pending = audio.connectAvatar(connection); await h.ready(); await pending;
  audio.ackVideoFrame(h.frames[0].id);
  const bitmap = deferred<ImageBitmap>(); h.runtime.createFrame = () => bitmap.promise;
  h.video.currentTime = 2; await h.pump();
  h.room.emit(RoomEvent.TrackUnsubscribed, h.tracks[1]);
  let disposed = false;
  bitmap.resolve({ close() { disposed = true; } } as ImageBitmap); await settle();
  assert.equal(disposed, true); assert.equal(h.frames.length, 1);
  assert.equal(h.events.filter(event => event === 'live').length, 1);
  assert.deepEqual(h.errors, []);
});

test('a terminal media disconnect still ends the call promptly', async t => {
  const h = harness(), audio = h.start(); t.after(() => audio.close());
  const pending = audio.connectAvatar(connection); await h.ready(); await pending;
  h.room.emit(RoomEvent.Disconnected);
  assert.deepEqual(h.errors, ['Avatar media disconnected. Start voice again.']);
  assert.ok(h.events.includes('output-close'));
});

test("continuous Live PCM reaches the avatar from the first sample and seals after the silent tail", async t => {
  const h = harness(), audio = h.start(); t.after(() => audio.close());
  const connected = audio.connectAvatar(connection); await h.ready(); await connected;
  audio.handleClientEvent({ type: "live.enable" });
  const packet = (value: number) => {
    const pcm = new ArrayBuffer(9600), view = new DataView(pcm);
    for (let i = 0; i < pcm.byteLength; i += 2) view.setInt16(i, value, true);
    h.capture.port.onmessage!({ data: { type: "live-pcm", pcm } } as MessageEvent);
  };
  packet(0); assert.equal(h.socket.sent.length, 0);
  packet(8192);
  const chunks = h.socket.sent.filter(e => e.type === "agent.speak");
  assert.equal(chunks.length, 2, "silent preroll and complete first speech packet survive");
  assert.equal(Buffer.from(String(chunks[1].audio), "base64").readInt16LE(0), 8192);
  packet(0); packet(0); packet(8192);
  assert.equal(h.socket.sent.some(e => e.type === "agent.speak_end"), false, "a brief pause is not a new turn");
  for (let i = 0; i < 6; i++) packet(0);
  assert.equal(h.socket.sent.filter(e => e.type === "agent.speak_end").length, 1);
  assert.deepEqual(h.events.filter(e => e.startsWith("source:")), ["source:true", "source:false"]);
  assert.ok(h.events.includes("queue:1"), "the avatar still owes playback after source silence");
  assert.deepEqual(h.errors, []);
});

test('a held Live reply preserves the first packet until the microphone has the floor', async t => {
  const h = harness(), audio = h.start(); t.after(()=>audio.close());
  const connected = audio.connectAvatar(connection); await h.ready(); await connected;
  audio.handleClientEvent({type:'live.enable'});audio.handleClientEvent({type:'live.hold',held:true});
  const pcm=new ArrayBuffer(9600);new Int16Array(pcm).fill(8192);
  h.capture.port.onmessage!({data:{type:'live-pcm',pcm}} as MessageEvent);
  assert.equal(h.socket.sent.length,0,'no avatar audio can leak back into the unfinished microphone utterance');
  audio.handleClientEvent({type:'live.hold',held:false});
  assert.equal(h.socket.sent[0].type,'agent.speak');
  assert.equal(Buffer.from(String(h.socket.sent[0].audio),'base64').readInt16LE(0),8192);
});

test('held Live audio drains in order through an already busy socket without overflow', async t => {
  const h = harness(), audio = h.start(); t.after(() => audio.close());
  const connected = audio.connectAvatar(connection); await h.ready(); await connected;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  h.socket.send = function(text) { this.sent.push(JSON.parse(text)); this.bufferedAmount += text.length; };
  audio.handleClientEvent({ type: 'live.enable' });
  audio.handleClientEvent({ type: 'live.hold', held: true });
  const packet = (value: number) => {
    const pcm = new ArrayBuffer(9600); new Int16Array(pcm).fill(value);
    h.capture.port.onmessage!({ data: { type: 'live-pcm', pcm } } as MessageEvent);
  };
  for (let i = 0; i < 50; i++) packet(8192 + i);
  assert.equal(h.socket.sent.length, 0);
  h.socket.bufferedAmount = 300 * 1024;
  audio.handleClientEvent({ type: 'live.hold', held: false });
  packet(9000); // New live packets must queue behind the earlier held phrase.
  assert.deepEqual(h.errors, [], 'a temporarily busy socket must not kill the call');
  assert.equal(h.socket.sent.length, 0);
  for (let i = 0; i < 8; i++) { h.socket.bufferedAmount = 0; t.mock.timers.tick(25); }
  assert.deepEqual(h.socket.sent.filter(e => e.type === 'agent.speak').map(e => Buffer.from(String(e.audio), 'base64').readInt16LE(0)), [...Array.from({ length: 50 }, (_, i) => 8192 + i), 9000]);
  assert.deepEqual(h.errors, []);
  h.socket.bufferedAmount = 300 * 1024;
  for (let i = 0; i < 45; i++) { packet(10000 + i); t.mock.timers.tick(50); }
  assert.deepEqual(h.errors, [], 'ordinary PCM must also defer after the held queue has drained');
  for (let i = 0; i < 8; i++) { h.socket.bufferedAmount = 0; t.mock.timers.tick(25); }
  assert.deepEqual(h.socket.sent.filter(e => e.type === 'agent.speak').slice(-45).map(e => Buffer.from(String(e.audio), 'base64').readInt16LE(0)), Array.from({ length: 45 }, (_, i) => 10000 + i));
  h.socket.bufferedAmount = 300 * 1024; packet(9100);
  audio.handleClientEvent({ type: 'live.interrupt' });
  h.socket.bufferedAmount = 0; t.mock.timers.tick(25);
  assert.equal(h.socket.sent.some(e => e.audio && Buffer.from(String(e.audio), 'base64').readInt16LE(0) === 9100), false, 'interruption discards unsent audio from both queues');
  const count = h.socket.sent.length; audio.close(); t.mock.timers.tick(10000);
  assert.equal(h.socket.sent.length, count);
});

test('socket loss retires uncertain playback even if speak_ended was lost', async t => {
  const h=harness(),audio=h.start();t.after(()=>audio.close());
  const connected=audio.connectAvatar(connection);await h.ready();await connected;
  audio.handleClientEvent({type:'live.enable'});
  const pcm=new ArrayBuffer(9600);new Int16Array(pcm).fill(8192);
  h.capture.port.onmessage!({data:{type:'live-pcm',pcm}} as MessageEvent);
  const id=h.socket.sent[0].event_id;
  h.socket.onmessage!({data:JSON.stringify({type:'agent.speak_started',source_event_id:id})});
  h.socket.onclose!();
  assert.equal(h.events.filter(v=>v.startsWith('queue:')).at(-1),'queue:0');
  assert.equal(h.events.filter(v=>v.startsWith('source:')).at(-1),'source:false');
  assert.equal(h.muted.at(-1),true,'uncertain remote playback cannot reach speakers');
  assert.deepEqual(h.errors,[],'bounded recovery, not a fatal popup');
});

test("connection stays pending until the first bitmap is handed off, then resolves once without an acknowledgement", async t => {
  const h = harness(), first = deferred<ImageBitmap>(), createFrame = h.runtime.createFrame;
  h.runtime.createFrame = () => first.promise;
  const audio = h.start(); t.after(() => audio.close());
  let resolutions = 0;
  const pending = audio.connectAvatar(connection);
  void pending.then(() => { resolutions++; h.events.push("resolved"); }, () => {});
  await h.mediaReady(); await h.pump();
  assert.equal(resolutions, 0, "Playable tracks cannot connect while the first bitmap is unavailable.");
  const noFrames: typeof h.frames = [];
  assert.deepEqual(h.frames, noFrames); assert.ok(!h.events.includes("live"));
  first.resolve(await createFrame(h.video, 768, 432)); await pending; await settle();
  assert.equal(resolutions, 1); assert.equal(h.frames.length, 1);
  assert.deepEqual(h.events.filter(event => ["frame", "live", "resolved"].includes(event)), ["frame", "live", "resolved"]);
  h.video.currentTime = 2; await h.pump();
  assert.equal(h.frames.length, 1, "Readiness must preserve the outstanding frame's backpressure.");
  audio.ackVideoFrame(h.frames[0].id); h.runtime.createFrame = createFrame; await h.pump();
  assert.equal(h.frames.length, 2); assert.equal(resolutions, 1);
  assert.equal(h.events.filter(event => event === "live").length, 1);
});

for (const missing of ["socket", "room", "speaker"] as const) {
  test(`a first bitmap cannot connect before ${missing} readiness`, async t => {
    const h = harness(), otherReady = deferred<void>();
    if (missing === "room") h.room.connect = () => otherReady.promise;
    if (missing === "speaker") {
      const createOutput = h.runtime.createOutput;
      h.runtime.createOutput = (...args) => {
        const output = createOutput(...args);
        return { ...output, attach: stream => { output.attach(stream); return otherReady.promise; } };
      };
    }
    const audio = h.start(); t.after(() => audio.close());
    let resolved = false;
    const pending = audio.connectAvatar(connection);
    void pending.then(() => { resolved = true; }, () => {});
    await settle();
    for (const track of h.tracks) h.room.emit(RoomEvent.TrackSubscribed, track);
    if (missing !== "socket") h.socket.onmessage?.({ data: JSON.stringify({ type: "session.state_updated", state: "connected" }) });
    await settle(); await h.pump();
    assert.equal(h.frames.length, 1); assert.equal(resolved, false);
    if (missing === "socket") h.socket.onmessage?.({ data: JSON.stringify({ type: "session.state_updated", state: "connected" }) });
    else otherReady.resolve();
    await pending; assert.equal(resolved, true);
  });
}

test("video play must finish before a first bitmap can make the connection ready", async t => {
  const h = harness(), playing = deferred<void>(); h.video.play = () => playing.promise;
  const audio = h.start(); t.after(() => audio.close());
  let resolved = false;
  const pending = audio.connectAvatar(connection);
  void pending.then(() => { resolved = true; }, () => {});
  await h.mediaReady(); await h.pump();
  assert.equal(resolved, false); assert.deepEqual(h.frames, []);
  playing.resolve(); await settle();
  assert.equal(resolved, false, "Finishing play still needs an available bitmap.");
  await h.pump(); await pending; assert.equal(h.frames.length, 1);
});

test("a rejected first bitmap leaves startup pending until the next frame recovers", async t => {
  const h = harness(), first = deferred<ImageBitmap>(), createFrame = h.runtime.createFrame;
  h.runtime.createFrame = () => first.promise;
  const audio = h.start(); t.after(() => audio.close());
  let resolved = false;
  const pending = audio.connectAvatar(connection);
  void pending.then(() => { resolved = true; }, () => {});
  await h.mediaReady(); await h.pump();
  first.reject(new DOMException("No current frame", "InvalidStateError")); await settle();
  assert.equal(resolved, false); assert.deepEqual(h.frames, []); assert.deepEqual(h.errors, []);
  assert.ok(!h.events.includes("live")); assert.ok(!h.events.includes("output-close"));
  h.runtime.createFrame = createFrame; h.video.currentTime = 2; await h.pump(); await pending;
  assert.equal(h.frames.length, 1); assert.equal(resolved, true);
});

for (const teardown of ["close", "abort", "failure"] as const) {
  test(`${teardown} with a pending first bitmap rejects and closes the late owned bitmap`, async t => {
    const h = harness(), first = deferred<ImageBitmap>();
    h.runtime.createFrame = () => first.promise;
    const audio = h.start(); t.after(() => audio.close());
    const pending = audio.connectAvatar(connection); void pending.catch(() => {});
    await h.mediaReady(); await h.pump();
    if (teardown === "abort") h.abort.abort();
    else if (teardown === "failure") h.socket.onerror?.();
    else audio.close();
    await assert.rejects(pending, teardown === "failure" ? /Avatar connection failed/ : /closed/);
    let closed = 0;
    first.resolve({ close() { closed++; } } as ImageBitmap); await settle();
    assert.equal(closed, 1); assert.deepEqual(h.frames, []); assert.ok(!h.events.includes("live"));
    assert.deepEqual(h.errors, teardown === "failure" ? ["Avatar connection failed. Start voice again."] : []);
  });

  test(`${teardown} inside the first handoff prevents connection resolution and late live status`, async t => {
    const h = harness();
    const audio = h.start(event => {
      h.frames.push(event); event.frame.close(); audio.ackVideoFrame(event.id);
      if (teardown === "abort") h.abort.abort();
      else if (teardown === "failure") h.socket.onerror?.();
      else audio.close();
    });
    t.after(() => audio.close());
    const pending = audio.connectAvatar(connection); void pending.catch(() => {});
    await h.mediaReady(); await h.pump();
    await assert.rejects(pending, teardown === "failure" ? /Avatar connection failed/ : /closed/);
    assert.equal(h.frames.length, 1); assert.equal(h.events.filter(event => event === "frame-close").length, 1);
    assert.ok(!h.events.includes("live")); assert.equal(h.events.at(-1), "stopped");
    assert.deepEqual(h.errors, teardown === "failure" ? ["Avatar connection failed. Start voice again."] : []);
  });
}

test("a throwing first handoff fails startup and releases the owned bitmap", async t => {
  const h = harness(), audio = h.start(() => { throw new Error("private receiver failure"); });
  t.after(() => audio.close());
  const pending = audio.connectAvatar(connection); void pending.catch(() => {});
  await h.mediaReady(); await h.pump();
  await assert.rejects(pending, /Avatar video could not be displayed/);
  assert.deepEqual(h.errors, ["Avatar video could not be displayed. Start voice again."]);
  assert.equal(h.events.filter(event => event === "frame-close").length, 1);
  assert.ok(!h.events.includes("live"));
});

test("startup with no available bitmap fails at the existing connection deadline", async t => {
  const h = harness(), first = deferred<ImageBitmap>(); h.runtime.connectTimeoutMs = 30;
  h.runtime.createFrame = () => first.promise;
  const audio = h.start(); t.after(() => audio.close());
  const pending = audio.connectAvatar(connection); void pending.catch(() => {});
  await h.mediaReady(); await h.pump();
  await assert.rejects(pending, /Avatar connection timed out/);
  assert.deepEqual(h.errors, ["Avatar connection timed out. Start voice again."]);
  assert.ok(h.events.includes("output-close")); assert.ok(!h.events.includes("live"));
  let closed = 0; first.resolve({ close() { closed++; } } as ImageBitmap); await settle();
  assert.equal(closed, 1); assert.deepEqual(h.frames, []);
});

test("persistent first-copy failure rejects startup within the existing recovery interval", async t => {
  let now = 1000; t.mock.method(Date, "now", () => now);
  const h = harness(); h.runtime.createFrame = async () => { throw new Error("Frame unavailable"); };
  const audio = h.start(); t.after(() => audio.close());
  let resolved = false;
  const pending = audio.connectAvatar(connection);
  void pending.then(() => { resolved = true; }, () => {});
  await h.mediaReady(); await h.pump();
  assert.equal(resolved, false); assert.deepEqual(h.errors, []);
  now += 2100; h.video.currentTime = 2; await h.pump();
  await assert.rejects(pending, /Avatar video could not be decoded/);
  assert.equal(resolved, false); assert.deepEqual(h.frames, []); assert.ok(!h.events.includes("live"));
  assert.deepEqual(h.errors, ["Avatar video could not be decoded. Start voice again."]);
});

test("both contexts unlock synchronously and OpenAI attaches only to the silent capture graph", async () => {
  const h = harness(), audio = h.start();
  assert.deepEqual(h.events.slice(0, 3), ["output-create", "capture-create", "capture-resume"]);
  await audio.ready!();
  const source = { getTracks: () => [] } as unknown as MediaStream;
  await audio.attach(source);
  assert.equal(h.clock.srcObject, source); assert.equal(h.clock.muted, true);
  assert.equal(h.outputStreams.length, 0);
  const connecting = audio.connectAvatar(connection); await h.ready(); await connecting;
  assert.equal(h.outputStreams.length, 1);
  assert.equal(h.outputStreams[0].getAudioTracks()[0], h.tracks[0].mediaStreamTrack);
  audio.close(); audio.close();
  assert.equal(h.events.filter(e => e === "capture-close").length, 1);
  assert.equal(h.events.filter(e => e === "output-close").length, 1);
  assert.ok(h.events.includes("audio-stop")); assert.ok(h.events.includes("video-stop"));
  assert.equal(h.clock.srcObject, null);
});

test("connection waits for socket protocol readiness and both playable media tracks", async () => {
  const h = harness(), audio = h.start();
  let connected = false;
  const pending = audio.connectAvatar(connection).then(() => { connected = true; });
  await settle();
  h.room.emit(RoomEvent.TrackSubscribed, h.tracks[0]); await settle();
  assert.equal(connected, false);
  h.socket.onmessage?.({ data: JSON.stringify({ type: "session.state_updated", state: "connected" }) });
  await settle(); assert.equal(connected, false);
  h.room.emit(RoomEvent.TrackSubscribed, h.tracks[1]); await settle();
  assert.equal(connected, false); await h.pump(); await pending;
  assert.equal(connected, true); audio.close();
});

test("video frames are bounded, require exact acknowledgement, and are unique across connections", async () => {
  const first = harness(), a = first.start(); const pending = a.connectAvatar(connection);
  await first.ready(); await pending; await first.pump();
  assert.equal(first.frames.length, 1); assert.equal(first.frames[0].frame.width, 768);
  assert.equal(first.frames[0].frame.height, 432); assert.ok(first.events.includes("live"));
  first.video.currentTime = 2;
  await first.pump(); a.ackVideoFrame(first.frames[0].id + 100); await first.pump();
  assert.equal(first.frames.length, 1);
  a.ackVideoFrame(first.frames[0].id); await first.pump(); assert.equal(first.frames.length, 2);
  a.close();
  const second = harness(), b = second.start(); const next = b.connectAvatar(connection);
  await second.ready(); await next; await second.pump();
  assert.ok(second.frames[0].id > first.frames[1].id); b.close();
});

test("late bitmap creation is closed after teardown and never transferred", async () => {
  const h = harness(); let release!: (frame: ImageBitmap) => void;
  const a = h.start(), pending = a.connectAvatar(connection); await h.ready(); await pending;
  h.runtime.createFrame = () => new Promise(resolve => { release = resolve; });
  a.ackVideoFrame(h.frames[0].id); h.video.currentTime = 2; await h.pump();
  a.close(); let closed = false;
  release({ close() { closed = true; } } as ImageBitmap); await settle();
  assert.equal(closed, true); assert.equal(h.frames.length, 1);
});

test("one unavailable video frame does not tear down speech and the next frame recovers", async () => {
  const h = harness(), createFrame = h.runtime.createFrame;
  let missed = false;
  const audio = h.start();
  try {
    const pending = audio.connectAvatar(connection); await h.ready(); await pending;
    h.runtime.createFrame = async (...args) => {
      if (!missed) { missed = true; throw new DOMException("No current frame", "InvalidStateError"); }
      return createFrame(...args);
    };
    audio.ackVideoFrame(h.frames[0].id); h.video.currentTime = 2; await h.pump();
    assert.deepEqual(h.errors, []);
    assert.ok(!h.events.includes("output-close"), "A missed video copy must leave the live audio graph intact.");
    h.video.currentTime = 3; await h.pump();
    assert.equal(h.frames.length, 2, "The rejected frame releases backpressure for the next real frame.");
    assert.ok(h.events.includes("live"));
  } finally { audio.close(); }
});

test("persistent frame-copy failure ends the call after a bounded recovery interval", async t => {
  let now = 1000; t.mock.method(Date, "now", () => now);
  const h = harness();
  const audio = h.start();
  try {
    const pending = audio.connectAvatar(connection); await h.ready(); await pending;
    h.runtime.createFrame = async () => { throw new Error("Frame unavailable"); };
    audio.ackVideoFrame(h.frames[0].id); h.video.currentTime = 2;
    await h.pump(); assert.deepEqual(h.errors, []);
    now += 2100; h.video.currentTime = 3; await h.pump();
    assert.deepEqual(h.errors, ["Avatar video could not be decoded. Start voice again."]);
    assert.ok(h.events.includes("output-close")); assert.ok(h.events.includes("room-close"));
  } finally { audio.close(); }
});

test("connection failure closes resources and reports a sanitized error without fallback", async () => {
  const h = harness(), a = h.start();
  const pending = a.connectAvatar(connection); await settle();
  h.socket.onerror?.();
  await assert.rejects(pending, /avatar/i);
  assert.equal(h.errors.length, 1); assert.ok(h.events.includes("output-close"));
  assert.ok(h.events.includes("capture-close")); assert.ok(h.events.includes("room-close"));
  assert.deepEqual(h.outputStreams, []); a.close();
});

test("abort while connecting rejects promptly and closes room/socket without an error notification", async () => {
  const h = harness(), a = h.start(); const pending = a.connectAvatar(connection); await settle();
  h.abort.abort(); await assert.rejects(pending);
  assert.ok(h.events.includes("room-close")); assert.ok(h.events.includes("socket-close"));
  assert.deepEqual(h.errors, []); a.close();
});

test("a rejected media join fails promptly without an unhandled rejection", async () => {
  const h = harness(); h.room.connect = async () => { throw new Error("private provider diagnostic"); };
  const a = h.start();
  await assert.rejects(a.connectAvatar(connection), /Avatar media could not connect/);
  assert.deepEqual(h.errors, ["Avatar media could not connect. Start voice again."]);
  assert.ok(h.events.includes("capture-close")); a.close();
});

test("aborting a pending lazy SDK load rejects immediately and disconnects the late room", async () => {
  const h = harness(); let resolve!: (room: Room) => void;
  h.runtime.createRoom = () => new Promise(r => { resolve = r; });
  const a = h.start(), pending = a.connectAvatar(connection); await settle();
  h.abort.abort(); await assert.rejects(pending, /closed/);
  resolve(h.room as unknown as Room); await settle();
  assert.ok(h.events.includes("room-close")); assert.ok(!h.events.includes("room-connect"));
});
