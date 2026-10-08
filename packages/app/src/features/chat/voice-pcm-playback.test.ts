import test from 'node:test';
import assert from 'node:assert/strict';
const path = './voice-pcm-playback';
export function audioFixture() {
  const sources: any[] = [];
  const context = { currentTime: 0, state: 'running', createBuffer: (_c: number, n: number) => ({ copyToChannel() {}, length: n }),
    createBufferSource: () => { const s = { buffer: null, connect() {}, disconnect() {}, start(at: number) { s.at = at; }, stop() { s.stops++; }, at: 0, stops: 0, onended: null as any }; sources.push(s); return s; } };
  return { context, sources };
}
async function implementation() { const m = await import(path).catch(() => ({})); assert.equal(typeof m.PCMPlayback, 'function', 'PCM playback is implemented'); return m as typeof import('./voice-pcm-playback'); }
test('actual scheduled sample progress bounds the entire output queue and exact interrupt offset', async () => {
  const { PCMPlayback } = await implementation(), f = audioFixture();
  const audio = new PCMPlayback(f.context as unknown as AudioContext, {} as AudioNode);
  audio.enqueue(new Uint8Array(4800), 1); audio.enqueue(new Uint8Array(4800), 1);
  assert.equal(audio.playedSamples, 0); f.context.currentTime = .055;
  assert.equal(audio.playedSamples, 1320); assert.equal(audio.pendingSamples, 3480);
  assert.equal(audio.flush(), 1320); assert.ok(f.sources.every(v => v.stops === 1)); assert.equal(audio.pendingSamples, 0);
  assert.throws(() => audio.enqueue(new Uint8Array(96002), 2), /queue|PCM/);
});
for (const seconds of [10, 25]) test(`healthy ${seconds}s generation burst plays with <=2s client queue`, async () => {
  const { PCMPlayback } = await implementation(), f = audioFixture(), audio = new PCMPlayback(f.context as unknown as AudioContext, {} as AudioNode);
  let sent = 0;
  for (let ticks = 0; ticks < seconds * 100 + 250; ticks++) {
    while (sent < seconds * 24000 && audio.pendingSamples <= 45600) { audio.enqueue(new Uint8Array(4800), 1); sent += 2400; }
    assert.ok(audio.pendingSamples <= 48000); f.context.currentTime += .01;
  }
  assert.equal(sent, seconds * 24000); assert.equal(audio.playedSamples, sent); assert.equal(audio.pendingSamples, 0);
});
test('native audio revokes an owned loading worklet URL immediately on cancellation and cannot attach late', async t => {
  t.mock.timers.enable({apis:['setInterval']});
  const {createBalanceAudio}=await implementation();
  let loaded!:()=>void, created=0, closed=0, revoked=0;
  const param=()=>({setValueAtTime(){}}), node=()=>({connect(){},disconnect(){}});
  const originalContext=Object.getOwnPropertyDescriptor(globalThis,'AudioContext'), originalWorklet=Object.getOwnPropertyDescriptor(globalThis,'AudioWorkletNode'), originalCreate=URL.createObjectURL, originalRevoke=URL.revokeObjectURL;
  class Context {
    state='running'; currentTime=0; destination=node(); listener={positionX:param(),positionY:param(),positionZ:param(),forwardX:param(),forwardY:param(),forwardZ:param(),upX:param(),upY:param(),upZ:param()};
    audioWorklet={addModule:()=>new Promise<void>(resolve=>{loaded=resolve;})};
    resume=async()=>{}; close=async()=>{closed++;};
    createPanner=()=>({...node(),positionX:param(),positionY:param(),positionZ:param()}); createGain=()=>({...node(),gain:param()}); createAnalyser=()=>({...node(),fftSize:512,getFloatTimeDomainData(){}});
    createMediaStreamSource=()=>{created++;return node();};
  }
  Object.defineProperty(globalThis,'AudioContext',{configurable:true,value:Context}); Object.defineProperty(globalThis,'AudioWorkletNode',{configurable:true,value:class {constructor(){created++;}}});
  URL.createObjectURL=()=> 'blob:owned-worklet'; URL.revokeObjectURL=()=>{revoked++;};
  try {
    const audio=createBalanceAudio(()=>{},()=>{}); await audio.ready();
    const loading=audio.capture({} as MediaStream,1,()=>{},()=>{}); audio.close();
    assert.equal(revoked,1,'cancel revokes before addModule settles'); assert.equal(closed,1); loaded(); await loading; assert.equal(created,0);
  } finally {
    if(originalContext) Object.defineProperty(globalThis,'AudioContext',originalContext); else Reflect.deleteProperty(globalThis,'AudioContext');
    if(originalWorklet) Object.defineProperty(globalThis,'AudioWorkletNode',originalWorklet); else Reflect.deleteProperty(globalThis,'AudioWorkletNode');
    URL.createObjectURL=originalCreate; URL.revokeObjectURL=originalRevoke;
  }
});
