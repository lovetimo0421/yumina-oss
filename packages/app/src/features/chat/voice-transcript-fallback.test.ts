import test from "node:test";
import assert from "node:assert/strict";
import { TranscriptFallback, encodeWav, INPUT_TAIL_WORKLET } from "./voice-transcript-fallback";

function rig() {
  let now = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const emitted: string[] = [], clips: Blob[] = [];
  const fallback = new TranscriptFallback({
    now: () => now,
    schedule: (fn, ms) => timers.push({ at: now + ms, fn }),
    tail: async seconds => ({ samples: new Float32Array(Math.round(seconds * 48000)).fill(.2), sampleRate: 48000 }),
    transcribe: async clip => { clips.push(clip); return "Fuck Big Brother."; },
    emit: text => emitted.push(text),
  });
  const speak = (ms: number) => { for (let t = 0; t < ms; t += 50) { fallback.level(.3); now += 50; } };
  const quiet = (ms: number) => { for (let t = 0; t < ms; t += 50) { fallback.level(0); now += 50; } };
  const run = async (ms: number) => { now += ms; for (const timer of timers.splice(0).filter(t => t.at <= now)) timer.fn(); await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0)); };
  return { fallback, speak, quiet, run, emitted, clips };
}

test("speech the live model never transcribed is transcribed and given to the world", async () => {
  const r = rig();
  r.speak(2400); r.quiet(1300);
  await r.run(7000);
  assert.deepEqual(r.emitted, ["Fuck Big Brother."]);
  assert.equal(r.clips.length, 1);
  assert.equal(r.clips[0]!.type, "audio/wav");
});

test("nothing is uploaded when the live model heard the speech", async () => {
  const r = rig();
  r.speak(2400); r.quiet(1300);
  r.fallback.heard();
  await r.run(7000);
  assert.equal(r.clips.length, 0);
  assert.deepEqual(r.emitted, []);
});

test("a cough is not speech", async () => {
  const r = rig();
  r.speak(300); r.quiet(1300);
  await r.run(7000);
  assert.equal(r.clips.length, 0);
});

test("the WAV is 16 kHz mono with a valid header", async () => {
  const wav = encodeWav(new Float32Array(48000).fill(.5), 48000);
  const view = new DataView(await wav.arrayBuffer());
  assert.equal(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)), "RIFF");
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(40, true), 16000 * 2);
});

test("the ring worklet returns the newest samples in order", () => {
  let Ctor: any; const port: any = { onmessage: null, postMessage(m: any) { port.last = m; } };
  new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", INPUT_TAIL_WORKLET)(class { port = port; }, (_: string, c: unknown) => { Ctor = c; }, 1000);
  const p = new Ctor();
  for (let i = 0; i < 3; i++) p.process([[new Float32Array(128).fill(i + 1)]], [[new Float32Array(128)]]);
  port.onmessage({ data: { type: "tail", id: 1, seconds: .2 } });
  const s: Float32Array = port.last.samples;
  assert.equal(s.length, 200);
  assert.equal(s[0], 2); assert.equal(s[199], 3);
});
