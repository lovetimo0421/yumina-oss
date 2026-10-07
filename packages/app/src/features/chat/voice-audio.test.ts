import assert from "node:assert/strict";
import test from "node:test";
import { createVoiceAudio } from "./voice-audio";

const createElement = () => ({ muted: false, srcObject: null, setAttribute() {}, play: async () => {}, pause() {} }) as unknown as HTMLAudioElement;

test("real audio readiness reports resume rejection, suspension and timeout", async () => {
  const node = () => ({ connect() {}, disconnect() {}, fftSize: 512 });
  const audio = (resume: () => Promise<void>, state: string) => createVoiceAudio(() => {}, {
    createElement,
    createContext: () => ({ state, resume, close: async () => {}, createPanner: node, createGain: node, createAnalyser: node } as unknown as AudioContext),
    schedule: () => 1, cancel() {},
  });
  for (const [resume, state] of [[async () => { throw Error("blocked"); }, "suspended"], [async () => {}, "suspended"], [() => new Promise<void>(() => {}), "suspended"]] as const) {
    const output = audio(resume, state);
    await assert.rejects(output.ready!(10), /audio|speaker/i); output.close();
  }
  const output = audio(async () => {}, "running"); await output.ready!(); output.close();
});

test("remote audio is spatial, measurable, muted and fully disconnected on close", async () => {
  const param = () => ({ value: 0, setValueAtTime(value: number) { this.value = value; } });
  const node = () => ({ disconnected: 0, outputs: [] as unknown[], connect(to: unknown) { this.outputs.push(to); }, disconnect() { this.disconnected++; } });
  const panner = { ...node(), positionX: param(), positionY: param(), positionZ: param() };
  const gain = { ...node(), gain: param() };
  const analyser = { ...node(), fftSize: 512, getFloatTimeDomainData(samples: Float32Array) { samples.fill(0.25); } };
  const source = node();
  const listener = { positionX: param(), positionY: param(), positionZ: param(), forwardX: param(), forwardY: param(), forwardZ: param(), upX: param(), upY: param(), upZ: param() };
  let resumed = 0, closed = 0, cancelCount = 0, sample!: () => void;
  const context = { currentTime: 0, state: "running", listener, destination: {}, createGain: () => gain, createPanner: () => panner, createAnalyser: () => analyser, createMediaStreamSource: () => source,
    resume: async () => { resumed++; }, close: async () => { closed++; } } as unknown as AudioContext;
  const levels: number[] = [];
  const element = createElement(); let plays = 0, pauses = 0;
  element.play = async () => { plays++; }; element.pause = () => { pauses++; };
  const audio = createVoiceAudio(level => levels.push(level), {
    createElement: () => element,
    createContext: () => context, schedule: callback => { sample = callback; return 1; }, cancel: () => { cancelCount++; },
  });
  assert.equal(resumed, 1);
  const stream = {} as MediaStream;
  await audio.attach(stream);
  assert.equal(plays, 1); assert.equal(element.srcObject, stream); assert.equal(element.muted, true);
  assert.deepEqual(source.outputs, [panner]); assert.deepEqual(panner.outputs, [gain]); assert.deepEqual(gain.outputs, [analyser]);
  audio.setSpatial({ x: 2, z: 3, yaw: Math.PI / 2, sourceX: 6, sourceZ: -4 });
  assert.equal(listener.positionX.value, 2); assert.equal(listener.positionZ.value, 3); assert.equal(listener.forwardX.value, -1); assert.equal(panner.positionX.value, 6);
  sample(); assert.ok(levels.at(-1)! > 0);
  audio.setMuted(true); sample(); assert.equal(gain.gain.value, 0); assert.equal(levels.at(-1), 0);
  audio.setMuted(false); assert.equal(element.muted, true, "playout clock must never become a second audible route");
  audio.close(); audio.close(); assert.equal(closed, 1); assert.equal(cancelCount, 1); assert.equal(source.disconnected, 1);
  assert.equal(pauses, 1); assert.equal(element.srcObject, null);
  const previous = levels.length; sample(); assert.equal(levels.length, previous);
});


test("microphone meter is isolated from output and disconnects on close", () => {
  const node = () => ({ outputs: [] as unknown[], disconnected: false, connect(to: unknown) { this.outputs.push(to); }, disconnect() { this.disconnected = true; } });
  const analysers: any[] = [], sources: any[] = [], destination = {};
  let sample!: () => void;
  const context = { state: "running", resume: async () => {}, close: async () => {}, destination,
    createPanner: node, createGain: node,
    createAnalyser: () => { const a = { ...node(), fftSize: 512, getFloatTimeDomainData(data: Float32Array) { data.fill(0.2); } }; analysers.push(a); return a; },
    createMediaStreamSource: () => { const source = node(); sources.push(source); return source; },
  } as unknown as AudioContext;
  const inputs: number[] = [];
  const audio = createVoiceAudio(() => {}, { createElement, createContext: () => context, schedule: callback => { sample = callback; return 1; }, cancel() {} }, v => inputs.push(v));
  const track = { enabled: true };
  audio.attachInput({ getAudioTracks: () => [track] } as unknown as MediaStream);
  sample(); assert.ok(inputs.at(-1)! > 0);
  assert.deepEqual(sources[0].outputs, [analysers[1]]);
  assert.deepEqual(analysers[1].outputs, [], "input must never feed speakers");
  track.enabled = false; sample(); assert.equal(inputs.at(-1), 0);
  audio.close(); assert.equal(sources[0].disconnected, true);
});
