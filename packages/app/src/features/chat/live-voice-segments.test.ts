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
test('live startup buffering sends a continuous lead without dropping or reordering onset PCM', () => {
  const sent: Uint8Array[] = [], events: string[] = [];
  const stream = new LiveVoiceSegments({start:()=>events.push('start'),pcm:data=>sent.push(data),end:()=>events.push('end')},1200);
  const packets=Array.from({length:6},(_,n)=>pcm(3000+n));
  for(const packet of packets.slice(0,5))stream.append(packet);
  assert.deepEqual(events,['start'],'Reserve the speaker immediately while collecting its audio lead');
  assert.equal(sent.length,0,'A few initial packets must not starve the avatar as soon as its mouth starts');
  stream.append(packets[5]);assert.deepEqual(sent,packets);
  const next=pcm(7000);stream.append(next);assert.equal(sent.at(-1),next);
  stream.close();
});

test('rejected buffered audio cannot escape when the next source is authorized', () => {
  const sent: Uint8Array[]=[];
  const stream=new LiveVoiceSegments({start(){},pcm:data=>sent.push(data),end(){}},1200);
  stream.append(pcm(3000));stream.allow(false);stream.allow(true);
  for(let n=0;n<6;n++)stream.append(pcm(0));
  const fresh=Array.from({length:6},()=>pcm(6000));for(const packet of fresh)stream.append(packet);
  assert.deepEqual(sent,fresh);stream.close();
});
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

test('source permission applies to whole sources and cannot admit an already rejected tail', () => {
  const sent: Uint8Array[] = [], activity: boolean[] = [], boundaries: string[] = [];
  const stream = new LiveVoiceSegments({ start: () => boundaries.push('start'), pcm: data => sent.push(data),
    end: () => boundaries.push('end'), activity: active => activity.push(active) });
  stream.allow(false); stream.append(pcm(3000));
  stream.allow(true); stream.append(pcm(4000));
  assert.equal(sent.length, 0); assert.deepEqual(activity, [true]);
  for (let n = 0; n < 6; n++) stream.append(pcm(0));
  assert.deepEqual(activity, [true, false]); assert.deepEqual(boundaries, []);
  const onset = pcm(5000); stream.append(onset);
  assert.equal(sent[0], onset); assert.deepEqual(boundaries, ['start']); stream.close();
});

test('source rejection on onset happens before the first packet and still reports actual quiet', () => {
  const sent: Uint8Array[] = [], activity: boolean[] = [];
  const stream = new LiveVoiceSegments({ start() { assert.fail('unapproved source'); }, pcm: data => sent.push(data), end() {},
    activity(active) { activity.push(active); if (active) stream.allow(false); } });
  stream.append(pcm(5000)); for (let n = 0; n < 6; n++) stream.append(pcm(0));
  assert.deepEqual(sent, []); assert.deepEqual(activity, [true, false]); stream.close();
});

test('explicit source authorization after an idle interrupt cannot drop the approved first packet', () => {
  const f = fixture(); f.stream.allow(false); f.stream.interrupt(); f.stream.allow(true);
  const onset = pcm(5000); f.stream.append(onset);
  assert.equal(f.sent[0], onset); f.stream.close();
});
