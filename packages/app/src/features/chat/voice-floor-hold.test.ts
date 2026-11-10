import test from "node:test";
import assert from "node:assert/strict";
import { FLOOR_HOLD_WORKLET } from "./voice-floor-hold";

function processor() {
  let Ctor: any;
  const port: any = { onmessage: null };
  new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", FLOOR_HOLD_WORKLET)(
    class { port = port; }, (_: string, c: unknown) => { Ctor = c; }, 48000);
  const p = new Ctor();
  const run = (value: number) => { const out = new Float32Array(128); p.process([[new Float32Array(128).fill(value)]], [[out]]); return out[0]; };
  return { run, hold: (held: boolean) => port.onmessage({ data: { type: "held", held } }) };
}

test("passes the microphone straight through when not held", () => {
  const f = processor();
  assert.equal(f.run(.5), .5);
});

test("held speech is queued, not lost, and plays after release", () => {
  const f = processor();
  f.hold(true);
  assert.equal(f.run(.25), 0, "the model hears silence while he speaks");
  assert.equal(f.run(.375), 0);
  f.hold(false);
  assert.equal(f.run(0), .25, "the first held word comes out first");
  assert.equal(f.run(0), .375);
  f.run(0);
  assert.equal(f.run(.75), .75, "with no speech left queued, quiet is dropped and it is live again");
});

test("a short gap inside a held phrase survives the catch-up", () => {
  const f = processor();
  f.hold(true);
  f.run(.5); for (let i = 0; i < 20; i++) f.run(0); f.run(.25);
  f.hold(false);
  const heard = [f.run(0)];
  for (let i = 0; i < 21; i++) heard.push(f.run(0));
  assert.equal(heard[0], .5);
  assert.equal(heard.filter(v => v === 0).length, 20, "the 53 ms consonant gap is kept");
  assert.equal(heard[21], .25);
});

test("a long held pause is skipped", () => {
  const f = processor();
  f.hold(true);
  f.run(.5); for (let i = 0; i < 400; i++) f.run(0); f.run(.25);
  f.hold(false);
  const heard = []; for (let i = 0; i < 200; i++) heard.push(f.run(0));
  assert.ok(heard.indexOf(.25) > 0 && heard.indexOf(.25) < 150, "the second word arrives within the pause allowance");
});
