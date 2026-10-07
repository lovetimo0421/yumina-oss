import test from "node:test";
import assert from "node:assert/strict";
import { LiveVoiceSegments } from "./live-voice-segments";

function pcm(value: number, milliseconds = 200) {
  const data = new Uint8Array(milliseconds * 48), view = new DataView(data.buffer);
  for (let offset = 0; offset < data.length; offset += 2) view.setInt16(offset, value, true);
  return data;
}
function fixture() {
  const sent: Uint8Array[] = [], events: string[] = [];
  const stream = new LiveVoiceSegments({ start: () => events.push("start"), pcm: data => sent.push(data), end: () => events.push("end") });
  return { stream, sent, events };
}
test("continuous avatar capture retains the first packet and does not split an ordinary short pause", () => {
  const f = fixture();
  f.stream.append(pcm(0)); const first = pcm(4000); f.stream.append(first);
  assert.deepEqual(f.events, ["start"]);
  assert.ok(f.sent.includes(first), "the onset must be delivered, not only future audio");
  for (let i = 0; i < 3; i++) f.stream.append(pcm(0));
  f.stream.append(pcm(3000));
  assert.deepEqual(f.events, ["start"]);
  for (let i = 0; i < 6; i++) f.stream.append(pcm(0));
  assert.deepEqual(f.events, ["start", "end"]);
  f.stream.append(pcm(4000)); assert.deepEqual(f.events, ["start", "end", "start"]);
});
test("deliberate interrupt discards the old continuous tail until actual quiet", () => {
  const f = fixture(); f.stream.append(pcm(4000)); f.stream.interrupt();
  const before = f.sent.length;
  for (let i = 0; i < 5; i++) f.stream.append(pcm(4000));
  assert.equal(f.sent.length, before);
  for (let i = 0; i < 6; i++) f.stream.append(pcm(0));
  f.stream.append(pcm(4000));
  assert.equal(f.events.filter(e => e === "start").length, 2);
});
test("continuous silence does not manufacture paid avatar utterances", () => {
  const f = fixture(); for (let i = 0; i < 100; i++) f.stream.append(pcm(0));
  assert.deepEqual(f.events, []); assert.equal(f.sent.length, 0);
  f.stream.close(); f.stream.append(pcm(4000)); assert.deepEqual(f.events, []);
});
