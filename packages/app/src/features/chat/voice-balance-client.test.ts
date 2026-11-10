import test from 'node:test';
import assert from 'node:assert/strict';
import { attempt, identity, fixture, connect, output } from './voice-balance-test-support';
test('input admission pause stops capture without losing the call and resume asks the player to repeat', async () => {
  const f = await fixture(); await connect(f);
  f.socket.event({ type: 'input-status', epoch: 1, revision: 1, status: 'paused' });
  assert.equal(f.audio.paused, true); assert.equal(f.track.stops, 0);
  f.advance(200); f.poll();
  assert.equal(f.events.filter(e => e.type === 'activity').at(-1)?.status, 'thinking');
  assert.ok(f.events.some(e => e.type === 'status' && e.code === 'VOICE_INPUT_PAUSED' && /not accepted/i.test(e.message ?? '')));
  f.audio.frames({ epoch: 1, sequence: 0, pcm: new ArrayBuffer(960) });
  assert.equal(f.socket.sent.filter(v => v instanceof ArrayBuffer).length, 0);
  f.socket.event({ type: 'input-status', epoch: 1, revision: 2, status: 'listening' });
  assert.equal(f.audio.paused, false);
  f.audio.frames({ epoch: 1, sequence: 1, pcm: new ArrayBuffer(960) });
  assert.equal(f.socket.sent.filter(v => v instanceof ArrayBuffer).length, 1);
  assert.ok(f.events.some(e => e.type === 'status' && e.code === 'VOICE_INPUT_RESUMED' && /repeat/i.test(e.message ?? '')));
  f.client.stop();
});
test('bounded server error code survives generic recovery without carrying provider bodies', async () => {
  const f = await fixture(); await connect(f);
  f.socket.event({ type: 'error', epoch: 1, code: 'VOICE_INPUT_OVERFLOW' });
  assert.equal(f.track.stops, 1);
  assert.ok(f.events.some(e => e.type === 'status' && e.code === 'VOICE_INPUT_OVERFLOW'));
});
test('fixed deadline reason survives SDK recovery and unknown diagnostic payloads are rejected', async () => {
  const f = await fixture(); await connect(f);
  f.socket.event({ type: 'error', epoch: 1, code: 'VOICE_DEADLINE', reason: 'input-age' });
  assert.ok(f.events.some(e => e.type === 'status' && e.code === 'VOICE_DEADLINE' && e.reason === 'input-age'));
  const invalid = await fixture(); await connect(invalid);
  invalid.socket.event({ type: 'error', epoch: 1, code: 'VOICE_DEADLINE', reason: 'arbitrary provider body' });
  assert.equal(invalid.events.some(e => e.type === 'status' && e.code === 'VOICE_DEADLINE'), false);
});
test('bind resubmits the exact recipe and full duplex input keeps flowing during scheduled output', async () => {
  const f = await fixture(); await connect(f);
  assert.deepEqual(f.socket.sent[0], { type: 'bind', callId: 'call', connectionId: 'connection', epoch: 1, recipe: { instructions: 'Hat direction', context: '', voice: 'marin' } });
  f.audio.pendingSamples = 24000;
  f.audio.frames({ epoch: 1, sequence: 0, pcm: new ArrayBuffer(960) });
  const binary = f.socket.sent.find(v => v instanceof ArrayBuffer); assert.ok(binary); assert.equal(binary.byteLength, 972); assert.equal(new DataView(binary).getUint32(4), 1);
  f.client.stop(); assert.equal(f.track.stops, 1); assert.equal(f.audio.closed, 1); assert.equal(f.socket.readyState, 3);
});
test('final groups drain atomically before finished and replay preserves stable part identities', async () => {
  let finished = false;
  const f = await fixture(() => ({ ...identity, status: finished ? 'finished' : 'pending', providerState: finished ? 'close-confirmed' : 'open', accountingState: finished ? 'complete' : 'pending', finalSeq: 1, finals: [{ finalSeq: 1, kind: 'response', finals: [{ itemId: 'item', contentIndex: 0, role: 'assistant', text: 'First' }, { itemId: 'item', contentIndex: 1, role: 'assistant', text: 'Second' }] }] }));
  await connect(f); f.client.stop(); finished = true;
  const result = await f.client.finish(); assert.equal(result.status, 'finished');
  assert.equal(f.events.filter(v => v.type === 'transcript' && v.final).length, 4, 'explicit finish repeats the two accepted records for its current subscriber');
  if (result.status === 'finished') assert.equal(result.lastFinalSeq, 1);
  await f.client.finish(); assert.equal(f.events.filter(v => v.type === 'transcript').length, 6);
});
test('pending cursor remains internal, missing page recovery uses atomic recover finish and rejects replacement attempt', async () => {
  const f = await fixture(); const result = await f.client.finish(); assert.equal(result.status, 'pending'); assert.equal('lastFinalSeq' in result, false);
  assert.ok(f.urls.some(v => v.endsWith('/recover/finish'))); assert.equal(f.socket.sent.length, 0);
  f.replace(); await assert.rejects(f.client.finish(), /scope|unavailable/i);
});
test('backpressure, malformed/faster-than-real-time/stale capture all silence the microphone', async () => {
  for (const mode of ['backpressure', 'malformed', 'fast', 'stale']) {
    const f = await fixture(); await connect(f);
    if (mode === 'backpressure') f.socket.bufferedAmount = 10000;
    if (mode === 'fast') for (let i = 0; i < 11; i++) f.audio.frames({ epoch: 1, sequence: i, pcm: new ArrayBuffer(960) });
    else f.audio.frames({ epoch: mode === 'stale' ? 0 : 1, sequence: 0, pcm: new ArrayBuffer(mode === 'malformed' ? 958 : 960) });
    assert.equal(f.track.stops, 1, mode); assert.equal(f.audio.closed, 1, mode);
  }
});
test('interrupt reports clamped actually rendered samples before cancelling done-before-drain output', async () => {
  const f = await fixture(); await connect(f); output(f); f.audio.playedSamples = 1320;
  f.client.interrupt();
  assert.deepEqual(f.socket.sent.slice(-2).map(v => v.type), ['playback', 'interrupt']); assert.equal(f.socket.sent.at(-2).playedSamples, 1320); assert.equal(f.audio.pendingSamples, 0);
  f.client.stop();
});
test('interrupt keeps its last rendered counter through ticks and fences late old PCM', async () => {
  const f = await fixture(); await connect(f); output(f); f.audio.playedSamples = 1200;
  f.client.interrupt(); f.advance(200); f.poll();
  assert.equal(f.track.stops, 0); output(f, 2400, 1, 2400); assert.equal(f.audio.pendingSamples, 0);
  f.socket.event({ type: 'flush', epoch: 1, playbackEpoch: 2, delivery: 'interrupted' });
  f.advance(200); f.poll(); assert.equal(f.track.stops, 0); f.client.stop();
});
test('context waits for correlated server pending/configuring/applied and keeps input full duplex while pending', async () => {
  const f = await fixture(); await connect(f); output(f);
  f.client.updateContext('older'); f.client.updateContext('latest'); f.advance(200); f.poll();
  const context = f.socket.sent.find(v => v.type === 'context'); assert.ok(context); assert.equal(context.context, 'latest');
  f.socket.event({ type: 'context-status', epoch: 1, revision: context.seq, status: 'pending' }); assert.equal(f.audio.paused, false);
  f.socket.event({ type: 'context-status', epoch: 1, revision: context.seq, status: 'configuring' }); assert.equal(f.audio.paused, true);
  f.socket.event({ type: 'configuring', epoch: 1 });
  f.socket.event({ type: 'ready', epoch: 1, playbackEpoch: 1 }); assert.equal(f.audio.paused, true, 'ready alone cannot acknowledge this context revision');
  f.socket.event({ type: 'context-status', epoch: 1, revision: context.seq, status: 'applied' }); assert.equal(f.audio.paused, false);
  f.client.stop();
});
test('stalled actual output clock cancels capture instead of accumulating a hidden billable stream', async () => {
  const f = await fixture(); await connect(f); output(f); f.advance(3001); f.poll(); assert.equal(f.track.stops, 1); assert.equal(f.audio.closed, 1);
});
test('fresh page recovery retains exact identity and waits for explicit finish to deliver accepted groups', async () => {
  const f = await fixture(() => ({...identity,status:'finished',providerState:'close-confirmed',accountingState:'complete',finalSeq:1,finals:[{finalSeq:1,kind:'transcription',finals:[{itemId:'user-1',contentIndex:0,role:'user',text:'My answer'}]}]}));
  await f.client.recover(); assert.equal(f.events.filter(v => v.type === 'transcript').length,0,'automatic init cannot drain before a sandbox consumer is ready');
  const result = await f.client.finish(); assert.equal(result.status,'finished');
  const finals = f.events.filter(v => v.type === 'transcript');
  assert.equal(new Set(finals.map(v => v.id)).size,1,'background cleanup and explicit replay preserve one stable accepted identity');
  assert.ok(finals.every(v => v.text === 'My answer'));
  assert.equal(f.socket.sent.length,0); assert.equal(f.audio.frames,null); assert.equal(f.urls.some(v => v.endsWith('/start')),false);
});
test('redaction and atomic never-started results preserve cleanup state without manufacturing a journal cursor', async () => {
  for (const status of ['unavailable','not-started'] as const) {
    const f = await fixture(() => ({...identity,status,providerState:status === 'not-started' ? 'not-created' : 'unconfirmed',accountingState:status === 'not-started' ? 'complete' : 'incomplete',receiptAvailability:status === 'unavailable' ? 'redacted' : 'live'}));
    const result = await f.client.finish(); assert.equal(result.status,status); assert.equal('lastFinalSeq' in result,false); assert.equal(f.events.some(v => v.type === 'transcript'),false);
  }
});
test('gapped or changed-attempt final groups can never resolve a finished interview', async () => {
  for (const mode of ['gap','foreign']) {
    const f = await fixture(() => ({...identity,attempt:mode === 'foreign' ? {...attempt,cardAttemptId:'other'} : attempt,status:'finished',providerState:'close-confirmed',accountingState:'complete',finalSeq:2,finals:[{finalSeq:2,kind:'response',finals:[{itemId:'i',contentIndex:0,role:'assistant',text:'Late'}]}]}));
    await assert.rejects(f.client.finish(),/gap|scope/i); assert.equal(f.events.some(v => v.type === 'transcript'),false);
  }
});
test('partial provider text cannot become a durable final; malformed output counters stop every resource', async () => {
  for (const event of [{type:'response.output_audio_transcript.delta',epoch:1,delta:'Partial'}, {type:'audio',epoch:1,playbackEpoch:1,sequence:99,responseId:'r',part:0,offset:0,samples:2400}]) {
    const f = await fixture(); await connect(f); f.socket.event(event); assert.equal(f.track.stops,1); assert.equal(f.audio.closed,1); assert.equal(f.events.some(v => v.type === 'transcript'),false);
  }
});
test('scope replacement cancels live capture on its next frame and rejects exact old receipt delivery', async () => {
  const f = await fixture(); await connect(f); f.replace(); f.audio.frames({epoch:1,sequence:0,pcm:new ArrayBuffer(960)});
  assert.equal(f.track.stops,1); assert.equal(f.audio.closed,1); assert.equal(f.events.some(v => v.type === 'transcript'),false);
});
test('canceling a reservation with a lost start response invokes atomic current-attempt cancellation', async () => {
  const {BalanceVoiceClient}=await import('./voice-balance-client');
  let release!:(v:Response)=>void; const paths:string[]=[];
  const audio=audioFixtureForCancel(), track={enabled:true,stops:0,onended:null,stop(){this.stops++;}};
  const client=new BalanceVoiceClient({sessionId:'session',connectionId:'connection',current:()=>true,currentAttempt:()=>attempt,createSocket(){assert.fail('canceled call has no socket');},emit(){},fetch:async(url)=>{
    paths.push(String(url)); if(String(url).endsWith('/start')) return new Promise<Response>(resolve=>{release=resolve;});
    return Response.json({...identity,status:'not-started',providerState:'not-created',accountingState:'complete'});
  }});
  const start=client.start({instructions:'Hat',context:'',voice:'marin'},{getTracks:()=>[track],getAudioTracks:()=>[track]} as unknown as MediaStream,audio); const rejection=assert.rejects(start);
  client.stop(); for(let i=0;i<8;i++) await Promise.resolve();
  assert.ok(paths.some(v=>v.endsWith('/recover/finish'))); assert.equal(track.stops,1); assert.equal(audio.closed,1);
  release(Response.json({...identity,status:'not-started',providerState:'not-created',accountingState:'complete'})); await rejection;
});
function audioFixtureForCancel() {return {ready:async()=>{},capture:async()=>{},pauseInput(){},enqueue(){},playedSamples:0,pendingSamples:0,flush:()=>0,setMuted(){},setSpatial(){},closed:0,close(){this.closed++;}};}
