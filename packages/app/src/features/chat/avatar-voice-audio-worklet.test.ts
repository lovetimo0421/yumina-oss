import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { AVATAR_PCM_WORKLET } from "./avatar-voice-audio-worklet";

function worklet() {
  const messages: { type: string; epoch: number; pcm?: ArrayBuffer }[] = [];
  let Processor: any;
  vm.runInNewContext(AVATAR_PCM_WORKLET, {
    sampleRate: 24_000,
    AudioWorkletProcessor: class { port = { onmessage: null, postMessage: (data: any) => messages.push(data) }; },
    registerProcessor: (_name: string, constructor: any) => { Processor = constructor; },
  });
  const processor = new Processor();
  const send = (data: Record<string, unknown>) => processor.port.onmessage({ data });
  const process = (channels: Float32Array[], length = channels[0]?.length ?? 128) => {
    const output = new Float32Array(length).fill(1);
    processor.process([channels], [[output]]);
    assert.ok(output.every((value: number) => value === 0), "OpenAI output must always stay silent");
  };
  return { messages, send, process };
}

test("continuous capture emits complete onset and silence packets without provider turn events", () => {
  const h = worklet(); h.send({ type: "continuous" });
  h.process([new Float32Array(4800).fill(.25)]); h.process([new Float32Array(4800)]);
  assert.deepEqual(h.messages.map(m => m.type), ["live-pcm", "live-pcm"]);
  assert.equal(new DataView(h.messages[0].pcm!).getInt16(0, true), 8192);
  assert.equal(new DataView(h.messages[1].pcm!).getInt16(0, true), 0);
});

test("worklet produces 24k mono signed little endian PCM without routing original audio to speakers", () => {
  const h = worklet(); h.process([new Float32Array(4800).fill(0.5)]);
  assert.equal(h.messages.length, 0);
  h.send({ type: "begin", epoch: 1 });
  h.process([new Float32Array(4800).fill(1), new Float32Array(4800).fill(0)]);
  const chunk = h.messages.find(m => m.type === "pcm")!;
  assert.equal(chunk.epoch, 1); assert.equal(chunk.pcm!.byteLength, 9600);
  assert.equal(new DataView(chunk.pcm!).getInt16(0, true), 16384);
});

test("bounded drain includes final partial chunk, then closes capture exactly once", () => {
  const h = worklet(); h.send({ type: "begin", epoch: 1 });
  h.process([new Float32Array(128).fill(-1)]);
  h.send({ type: "drain", epoch: 1, frames: 128 });
  h.process([new Float32Array(128).fill(0.5)]);
  assert.deepEqual(h.messages.map(m => m.type), ["pcm", "drained"]);
  const pcm = new DataView(h.messages[0].pcm!);
  assert.equal(pcm.byteLength, 512); assert.equal(pcm.getInt16(0, true), -32768);
  assert.equal(pcm.getInt16(256, true), 16384);
  h.process([new Float32Array(4800).fill(1)]);
  assert.equal(h.messages.length, 2);
});

test("clear discards partial old PCM and a new epoch cannot emit it", () => {
  const h = worklet(); h.send({ type: "begin", epoch: 1 });
  h.process([new Float32Array(128).fill(1)]);
  h.send({ type: "clear", epoch: 2 }); h.process([new Float32Array(128).fill(1)]);
  h.send({ type: "begin", epoch: 3 });
  h.process([new Float32Array(4800).fill(-1)]);
  assert.equal(h.messages.length, 1); assert.equal(h.messages[0].epoch, 3);
  assert.equal(new DataView(h.messages[0].pcm!).getInt16(0, true), -32768);
});

test("a new capture flushes and seals an earlier drain before its first chunk", () => {
  const h = worklet(); h.send({ type: "begin", epoch: 1 });
  h.process([new Float32Array(128).fill(0.5)]);
  h.send({ type: "drain", epoch: 1, frames: 12000 });
  h.send({ type: "begin", epoch: 2 });
  h.process([new Float32Array(4800).fill(-1)]);
  assert.deepEqual(h.messages.map(m => [m.type, m.epoch]), [["pcm", 1], ["drained", 1], ["pcm", 2]]);
});

test("a small pre-roll preserves audio arriving before the initial output-start event", () => {
  const h = worklet(); h.process([new Float32Array(128).fill(0.5)]);
  h.send({ type: "begin", epoch: 1 }); h.send({ type: "drain", epoch: 1, frames: 0 });
  assert.equal(h.messages[0].type, "pcm");
  assert.equal(new DataView(h.messages[0].pcm!).getInt16(0, true), 16384);
});

test("pre-roll stays disabled across interruption so the old RTP tail cannot leak into a new turn", () => {
  const h = worklet(); h.send({ type: "begin", epoch: 1 });
  h.process([new Float32Array(128).fill(1)]); h.send({ type: "clear", epoch: 2 });
  h.process([new Float32Array(2400).fill(1)]);
  h.send({ type: "begin", epoch: 3 }); h.process([new Float32Array(128).fill(-1)]);
  h.send({ type: "drain", epoch: 3, frames: 0 });
  assert.equal(h.messages[0].pcm!.byteLength, 256);
  assert.equal(new DataView(h.messages[0].pcm!).getInt16(0, true), -32768);
});
