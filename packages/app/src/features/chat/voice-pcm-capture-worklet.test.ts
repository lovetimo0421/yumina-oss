import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformWithEsbuild} from 'vite';

const modulePath = './voice-pcm-capture-worklet';
async function implementation() {
  const value = await import(modulePath).catch(() => ({}));
  assert.equal(typeof value.PCMResampler, 'function', 'continuous PCM resampler is implemented');
  return value as typeof import('./voice-pcm-capture-worklet');
}
for (const rate of [44100, 48000]) test(`${rate} capture preserves spectrum, length and fractional phase across 128 sample quanta`, async () => {
  const { PCMResampler } = await implementation();
  const signal = Float32Array.from({ length: rate }, (_, i) => .5 * Math.sin(2 * Math.PI * 1000 * i / rate));
  const whole = new PCMResampler(rate).process(signal);
  const resampler = new PCMResampler(rate), chunks: number[] = [];
  for (let i = 0; i < signal.length; i += 128) chunks.push(...resampler.process(signal.subarray(i, i + 128)));
  assert.equal(chunks.length, 24000); assert.deepEqual(chunks, Array.from(whole));
  let energy = 0, sine = 0, cosine = 0;
  for (let i = 100; i < chunks.length; i++) {
    energy += chunks[i]! ** 2;
    sine += chunks[i]! * Math.sin(2 * Math.PI * 1000 * i / 24000);
    cosine += chunks[i]! * Math.cos(2 * Math.PI * 1000 * i / 24000);
  }
  const amplitude = 2 * Math.hypot(sine, cosine) / (chunks.length - 100);
  assert.ok(Math.abs(amplitude - .5) < .01); assert.ok(Math.abs(energy / (chunks.length - 100) - .125) < .01);
  const high = new PCMResampler(rate).process(Float32Array.from({ length: rate }, (_, i) => Math.sin(2 * Math.PI * 18000 * i / rate)));
  assert.ok(Math.sqrt(high.subarray(100).reduce((n, v) => n + v * v, 0) / (high.length - 100)) < .02, 'reject above-Nyquist alias');
});
test('worklet emits PCM16LE 20ms frames with bounded acknowledged ownership and zero speaker path', async () => {
  const { captureWorkletSource } = await implementation();
  const frames: any[] = []; let Processor: any;
  class Base { port = { postMessage: (v: any) => frames.push(v), onmessage: null as any }; }
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', captureWorkletSource)(Base, (_name: string, value: any) => { Processor = value; }, 48000);
  const processor = new Processor({ processorOptions: { epoch: 7 } });
  const output = new Float32Array(128).fill(1);
  for (let i = 0; i < 75; i++) processor.process([[new Float32Array(128).fill(.25)]], [[output]]);
  const pcm = frames.filter(v => v.type === 'pcm');
  assert.equal(pcm.length, 10); assert.deepEqual(pcm.map(v => v.sequence), Array.from({ length: 10 }, (_, i) => i));
  assert.ok(pcm.every(v => v.epoch === 7 && v.pcm.byteLength === 960)); assert.ok(output.every(v => v === 0));
  assert.equal(new DataView(pcm[1].pcm).getInt16(0, true), 8192);
  for (let i = 0; i < 8; i++) processor.process([[new Float32Array(128)]], [[output]]);
  assert.ok(frames.some(v => v.type === 'failure'), 'over 200ms unacknowledged capture fails');
});
test('minified ES2020 host build produces a self-contained Blob worklet with no outer helper dependency', async () => {
  const source=readFileSync(new URL('./voice-pcm-capture-worklet.ts',import.meta.url),'utf8');
  const built=await transformWithEsbuild(source,'voice-pcm-capture-worklet.ts',{loader:'ts',format:'cjs',minify:true,target:'es2020',
    tsconfigRaw:{compilerOptions:{useDefineForClassFields:true}}});
  const module={exports:{} as {captureWorkletSource:string}};
  new Function('module','exports',built.code)(module,module.exports);
  const frames:any[]=[];
  let Processor:any; class Base {port={postMessage(value:any){frames.push(value);},onmessage:null};}
  new Function('AudioWorkletProcessor','registerProcessor','sampleRate',module.exports.captureWorkletSource)(Base,(_name:string,p:any)=>{Processor=p;},48000);
  const processor=new Processor({processorOptions:{epoch:1}}),output=new Float32Array(128).fill(1);
  for(let i=0;i<8;i++)assert.equal(processor.process([[new Float32Array(128).fill(.25)]],[[output]]),true);
  assert.equal(frames.length,1);assert.equal(frames[0].type,'pcm');assert.equal(frames[0].epoch,1);
  assert.equal(frames[0].sequence,0);assert.equal(frames[0].pcm.byteLength,960);
  assert.equal(new DataView(frames[0].pcm).getInt16(200,true),8192);assert.ok(output.every(value=>value===0));
});
