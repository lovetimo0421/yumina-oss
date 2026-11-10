import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { VOICE_INPUT_WORKLET } from './voice-input-monitor';

function harness() {
  const messages: any[] = [];
  let Processor: any;
  const scope = { currentFrame: 0, AudioWorkletProcessor: class {
    port = { onmessage: null, postMessage: (data: any) => messages.push(data) };
  }, registerProcessor: (_: string, value: any) => { Processor = value; } };
  vm.runInNewContext(VOICE_INPUT_WORKLET, scope);
  const processor = new Processor();
  const process = (channels = [new Float32Array(128)], gap = 0) => {
    scope.currentFrame += gap;
    const output = new Float32Array(128).fill(1);
    processor.process([channels], [[output]]);
    assert.ok(output.every(sample => sample === 0), 'monitor must never play the microphone');
    scope.currentFrame += 128;
  };
  const send = (data: any) => processor.port.onmessage({ data });
  const probe = () => { send({ type: 'probe', id: messages.length + 1 }); process(); return messages.at(-1).evidence; };
  return { messages, process, send, probe };
}

test('silence requires continuous samples and a fresh audio-thread barrier', () => {
  const h = harness(); h.process();
  h.send({ type: 'probe', id: 1 });
  assert.equal(h.messages.length, 0, 'no stale response from the message handler');
  h.process(); assert.equal(h.messages[0].evidence, 'silent');
  for (let i = 0; i < 100; i++) h.process();
  assert.equal(h.probe(), 'silent');
});

test('a single arbitrarily quiet sample survives forever, including between old meter polls', () => {
  const h = harness(); h.process();
  const quiet = new Float32Array(128); quiet[63] = 1e-10;
  h.process([new Float32Array(128), quiet]);
  for (let i = 0; i < 100; i++) h.process();
  assert.equal(h.probe(), 'signal');
});

test('missing frames, channels, invalid samples and suspension never prove silence', () => {
  for (const disrupt of [
    (h: ReturnType<typeof harness>) => h.process([], 0),
    (h: ReturnType<typeof harness>) => h.process(undefined, 128),
    (h: ReturnType<typeof harness>) => h.process([new Float32Array(128).fill(NaN)]),
    (h: ReturnType<typeof harness>) => h.send({ type: 'invalidate' }),
  ]) {
    const h = harness(); h.process(); disrupt(h);
    assert.equal(h.probe(), 'unknown'); assert.equal(h.probe(), 'unknown');
  }
});

test('a probe scans the next quantum before deciding, without exporting PCM', () => {
  const h = harness(); h.process(); h.send({ type: 'probe', id: 42 });
  h.process([new Float32Array(128).fill(.0001)]);
  assert.deepEqual(JSON.parse(JSON.stringify(h.messages)), [{ id: 42, evidence: 'signal' }]);
});
