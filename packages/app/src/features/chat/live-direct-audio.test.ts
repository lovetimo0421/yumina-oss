import test from "node:test";
import assert from "node:assert/strict";
import { VoiceController, type VoiceDependencies } from "./voice-controller";
import { LiveVoiceSession } from "./live-voice-session";
import { createVoiceAudio } from "./voice-audio";
import type { VoiceEvent } from "../../../sandbox/voice-types";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
let heartbeatStatus = 200;

class Channel {
  readyState = "connecting";
  sent: any[] = [];
  onopen: (() => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  open() { this.readyState = "open"; this.onopen?.(); }
  event(event: object) { this.onmessage?.({ data: JSON.stringify(event) }); }
  close() { this.readyState = "closed"; }
}

/** A plain speaker adapter (no avatar) that supports the Live input clock. */
function directFixture(config: Record<string, unknown> = {}) {
  const events: VoiceEvent[] = [], channel = new Channel(), requests: string[] = [];
  const track = { enabled: true, readyState: "live", stops: 0, onended: null as (() => void) | null, stop() { this.stops++; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const liveTrack = { enabled: true, readyState: "live", stops: 0, stop() { this.stops++; } };
  const liveStream = { getTracks: () => [liveTrack], getAudioTracks: () => [liveTrack] } as unknown as MediaStream;
  const clientEvents: Record<string, unknown>[] = [];
  let outputLevel: (value: number) => void = () => {};
  const audio = {
    closed: 0, attached: 0, prepared: 0,
    attachInput() {}, attach() { this.attached++; }, setMuted() {}, setSpatial() {}, close() { this.closed++; },
    prepareLiveInput: async () => { audio.prepared++; return liveStream; },
    handleClientEvent: (event: Record<string, unknown>) => { clientEvents.push(event); },
  };
  const peer = {
    connectionState: "new", closed: 0, added: [] as unknown[], ontrack: null as unknown, onconnectionstatechange: null as unknown,
    createDataChannel: () => channel, addTrack(track: unknown, stream: unknown) { this.added.push({ track, stream }); },
    createOffer: async () => ({ type: "offer", sdp: "v=0\r\no=offer" }), setLocalDescription: async () => {}, setRemoteDescription: async () => {}, close() { this.closed++; },
  };
  let now = 0;
  const deps: VoiceDependencies = {
    now: () => now,
    canUse: () => true, sessionId: "session-direct",
    requestConsent: async (_signal, prepareAudio) => { prepareAudio(); return true; },
    getUserMedia: async () => stream,
    createPeer: () => peer as unknown as RTCPeerConnection,
    createAudio: (output) => { outputLevel = output; return audio; },
    // No avatar factory at all: the live transport must not need one.
    fetch: async (url, init) => {
      requests.push(String(url));
      if (String(url).endsWith("/config")) return Response.json({ turnControl: "client-v1", available: true, funding: "testing", maxDurationSeconds: 1800, liveModel: "gpt-live-1", ...config });
      if (String(url).endsWith("/connect")) {
        const body = JSON.parse(String(init?.body));
        return Response.json({ turnControl: body.turnControl, sdp: "v=0\r\no=answer" });
      }
      if (String(url).endsWith("/live/heartbeat")) return Response.json({}, { status: heartbeatStatus });
      return Response.json({ stopped: true });
    },
    connectTimeoutMs: 1000,
  };
  const controller = new VoiceController(e => events.push(e), deps);
  return { controller, channel, events, requests, audio, peer, liveTrack, track, clientEvents, level: (v: number) => outputLevel(v), advance: (ms: number) => { now += ms; } };
}

test("a card can use the live model without an avatar: direct speaker, live clock, no avatar request", async () => {
  const f = directFixture();
  const pending = f.controller.start({ instructions: "Official", avatar: false, tools: [], transport: "live", interruptionMode: "automatic", opening: "character" });
  try {
    await tick(); f.channel.open(); f.channel.event({ type: "session.started" }); await pending;
    assert.equal(f.requests.some(url => url.includes("/avatar/")), false, "no avatar session is opened");
    assert.equal(f.audio.prepared, 1, "the plain adapter supplied the live input clock");
    assert.equal((f.peer.added[0] as { track: unknown }).track, f.liveTrack, "the live clock track is what reaches the peer");
    assert.ok(f.clientEvents.some(e => e.type === "live.enable"), "the plain adapter receives the live enable event");
    assert.ok(f.channel.sent.some(e => e.type === "session.instructions.append" && String(e.content).includes("opening")), "the opening cue is sent to the live model");
    // Speaker level drives the official's speaking state without an avatar.
    f.level(0.2);
    assert.equal(f.events.filter(e => e.type === "activity").at(-1)?.status, "speaking");
    f.advance(400); f.level(0);
    assert.notEqual(f.events.filter(e => e.type === "activity").at(-1)?.status, "speaking");
  } finally { f.controller.stop(); }
  assert.equal(f.audio.closed, 1);
});

test("the server's maxDurationSeconds is honoured instead of a fixed five minutes", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = directFixture({ maxDurationSeconds: 900 });
  const pending = f.controller.start({ instructions: "Official", avatar: false, tools: [], transport: "live" });
  try {
    await tick(); f.channel.open(); f.channel.event({ type: "session.started" }); await pending;
    f.advance(300_000); t.mock.timers.tick(300_000); await tick();
    assert.equal(f.events.some(e => e.type === "status" && e.status === "stopped"), false, "the old five-minute limit no longer ends the call");
    f.advance(600_000); t.mock.timers.tick(600_000); await tick();
    assert.ok(f.events.some(e => e.type === "status" && e.status === "stopped" && /limit/i.test(String(e.message))), "the server limit ends the call");
  } finally { f.controller.stop(); }
});

test("an out-of-range or missing maxDurationSeconds is rejected", async () => {
  for (const value of [undefined, 10, 10_000, "300"]) {
    const f = directFixture({ maxDurationSeconds: value });
    const pending = f.controller.start({ instructions: "Official", avatar: false, tools: [], transport: "live" });
    await assert.rejects(pending, /configuration/i);
    f.controller.stop();
  }
});

test("turn latency is measured from the last energetic microphone sample to the first audible output", async () => {
  const events: VoiceEvent[] = [];
  const s = new LiveVoiceSession({ send() {}, emit: e => events.push(e), input() {}, interruptAudio() {}, fail() {} }, "Official", "", "automatic");
  s.receive({ type: "session.started" }); s.start();
  s.inputLevel(0.1);
  const before = Date.now();
  await new Promise(resolve => setTimeout(resolve, 30));
  s.inputLevel(0.1);
  await new Promise(resolve => setTimeout(resolve, 1300)); // quiet floor ends the turn
  s.sourceActivity(true); s.playback("started");
  const latency = events.filter(e => e.type === "diagnostic" && (e as any).code === "turn-latency");
  assert.equal(latency.length, 1, "exactly one measurement per exchange");
  const ms = (latency[0] as any).ms;
  assert.ok(ms >= 1200 && ms < 5000 && ms <= Date.now() - before, `measured ${ms}ms`);
  s.playback("stopped"); s.sourceActivity(false);
  s.sourceActivity(true);
  assert.equal(events.filter(e => e.type === "diagnostic" && (e as any).code === "turn-latency").length, 1, "output without a preceding player turn is not measured");
  s.close();
});

test("the plain speaker adapter gates live output, holds and interruptions", async () => {
  const gains: number[] = [];
  const node = () => ({ connect() {}, disconnect() {}, fftSize: 512, getFloatTimeDomainData() {} });
  const context = { state: "running", destination: {}, currentTime: 0, listener: {}, resume: async () => {}, close: async () => {},
    createPanner: node, createGain: () => ({ ...node(), gain: { setValueAtTime: (value: number) => { gains.push(value); } } }), createAnalyser: node,
    createMediaStreamSource: node, createMediaStreamDestination: node, createConstantSource: node,
  };
  const audio = createVoiceAudio(() => {}, { createElement: () => ({ muted: false, srcObject: null, setAttribute() {}, play: async () => {}, pause() {} }) as unknown as HTMLAudioElement, createContext: () => context as unknown as AudioContext, schedule: () => 1, cancel() {} });
  try {
    assert.equal(typeof audio.handleClientEvent, "function");
    audio.handleClientEvent!({ type: "live.output", allowed: false });
    assert.equal(gains.at(-1), 0);
    audio.handleClientEvent!({ type: "live.output", allowed: true });
    assert.equal(gains.at(-1), 1);
    audio.handleClientEvent!({ type: "live.hold", held: true });
    assert.equal(gains.at(-1), 0);
    audio.handleClientEvent!({ type: "live.hold", held: false });
    assert.equal(gains.at(-1), 1);
    audio.setMuted(true); audio.handleClientEvent!({ type: "live.output", allowed: true });
    assert.equal(gains.at(-1), 0, "mute wins over live permission");
    audio.setMuted(false);
    audio.handleClientEvent!({ type: "live.interrupt" });
    assert.equal(gains.at(-1), 0, "an interrupt dips the speaker");
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(gains.at(-1), 1, "the dip releases on its own");
  } finally { audio.close(); }
});

test("credits-live: GPT-Live paid from Mushies runs the live session for 15 minutes, beats, and stops billing on cleanup", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  heartbeatStatus = 200;
  const f = directFixture({ funding: "credits-live", maxDurationSeconds: 900, creditsPerMinute: 60 });
  const pending = f.controller.start({ instructions: "Official", avatar: false, tools: [], transport: "live", interruptionMode: "automatic", opening: "silent" });
  try {
    await tick(); f.channel.open(); f.channel.event({ type: "session.started" }); await pending;
    assert.ok(f.requests.some(url => url.endsWith("/connect")));
    assert.equal(f.requests.filter(url => url.endsWith("/live/heartbeat")).length, 0);
    t.mock.timers.tick(30_000); await tick();
    t.mock.timers.tick(30_000); await tick();
    assert.equal(f.requests.filter(url => url.endsWith("/live/heartbeat")).length, 2, "one beat every 30 s");
  } finally { f.controller.stop(); }
  await tick();
  assert.ok(f.requests.some(url => url.endsWith("/stop")), "cleanup tells the server, which ends billing");
  t.mock.timers.tick(60_000); await tick();
  assert.equal(f.requests.filter(url => url.endsWith("/live/heartbeat")).length, 2, "no beats after the call ends");
});

test("credits-live: a beat the server no longer knows ends the call with a plain reason", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  heartbeatStatus = 404;
  const f = directFixture({ funding: "credits-live", maxDurationSeconds: 900, creditsPerMinute: 60 });
  const pending = f.controller.start({ instructions: "Official", avatar: false, tools: [], transport: "live", interruptionMode: "automatic", opening: "silent" });
  try {
    await tick(); f.channel.open(); f.channel.event({ type: "session.started" }); await pending;
    t.mock.timers.tick(30_000); await tick(); await tick();
    const failed = f.events.find(e => e.type === "status" && (e as { status?: string }).status === "error") as { message?: string } | undefined;
    assert.match(String(failed?.message), /Mushies ran out|time limit/);
  } finally { f.controller.stop(); heartbeatStatus = 200; }
});

test("credits-live: too few Mushies is refused before the microphone opens", async () => {
  const f = directFixture({ funding: "credits-live", available: false, maxDurationSeconds: 900, code: "VOICE_CREDITS_REQUIRED" });
  await assert.rejects(f.controller.start({ instructions: "Official", avatar: false, tools: [], transport: "live", interruptionMode: "automatic", opening: "silent" }), /more Mushies/);
  assert.equal(f.requests.some(url => url.endsWith("/connect")), false);
});
