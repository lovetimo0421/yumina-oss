import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceController, dispatchVoiceCall, type VoiceDependencies } from './voice-controller';
import { createVoiceAPI } from '../../../sandbox/voice-api';
import { attempt, capability, identity, FakeSocket, audioFixture } from './voice-balance-test-support';
import type { VoiceEvent } from '../../../sandbox/voice-types';
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; }
function fixture(initialAttempt: typeof attempt | null = attempt) {
  const events: VoiceEvent[] = [], urls: string[] = [], socket = new FakeSocket(), audio = audioFixture();
  const consent = deferred<boolean>(), permission = deferred<MediaStream>();
  let current = true, media = 0, consentCalls = 0, balanceAudio = 0, scope: typeof attempt | null = initialAttempt;
  let preparationAttempt = initialAttempt;
  const track = { stops: 0, enabled: true, readyState: 'live', onended: null as any, stop() { this.stops++; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const deps: VoiceDependencies = { sessionId: 'session', canUse: () => current, canRecover: () => current, currentAttempt: () => scope,
    currentPreparationScope: () => ({sessionId:attempt.sessionId,worldId:attempt.worldId,journeyId:attempt.journeyId,journeyEpoch:attempt.journeyEpoch}),
    currentPreparationAttempt: () => preparationAttempt,
    hasUserActivation: () => true, getUserMedia: () => { media++; return permission.promise; }, createPeer() { throw Error('balance must not create WebRTC'); },
    createAudio: () => ({ attach() {}, attachInput() {}, setMuted() {}, setSpatial() {}, close() {} }),
    createBalanceAudio: () => { balanceAudio++; return audio; }, createSocket: () => socket as unknown as WebSocket,
    requestConsent: async (_signal, unlock, config) => { assert.equal(config.funding, 'balance'); consentCalls++; const accepted = await consent.promise; if (accepted) unlock(); return accepted; },
    fetch: async (url) => { urls.push(String(url)); return Response.json(String(url).endsWith('/config') ? capability : String(url).includes('/recover?') ? {status:'not-found'} : String(url).endsWith('/start') ? { ...identity, connectionId: (deps as VoiceDependencies & {lastConnection?:string}).lastConnection ?? 'connection', status: 'pending', finalSeq:0, finals:[], socketPath:'/api/voice/session/balance/socket' } : {...identity,status:'pending',finalSeq:0,finals:[]}); }
  } as VoiceDependencies & {lastConnection?:string};
  const original = deps.fetch;
  deps.fetch = (url, opts) => { if (String(url).endsWith('/start')) (deps as any).lastConnection = (opts?.headers as Record<string,string>)['X-Voice-Connection-Id']; return original(url, opts); };
  const controller = new VoiceController(e => events.push(e), deps);
  return { controller, deps, events, urls, consent, permission, stream, track, socket, audio, counters: () => ({media,consentCalls,balanceAudio}), acknowledge: (next: typeof attempt | null) => {scope=next;preparationAttempt=next;}, inactive:()=>{preparationAttempt=null;}, replace: () => { current = false; scope = null; } };
}

test('fresh Hat prepare survives its acknowledged first attempt and still waits for balance consent', async () => {
  const f=fixture(null), prepared=await f.controller.prepare({avatar:false});
  f.acknowledge(attempt); f.controller.resetAttempt();
  const outcome=f.controller.start({intent:prepared.intent,instructions:'Hat',avatar:false,tools:[]}).catch(error=>error);
  try {
    await tick();
    assert.equal(f.counters().consentCalls,1,'the acknowledged first attempt must retain the original prepared intent');
    assert.equal(f.counters().media,0);
    assert.equal(f.urls.some(url=>url.endsWith('/start')),false,'capability and preparation cannot reserve a paid call');
    f.consent.resolve(false); assert.match(String(await outcome),/declined/);
  } finally { f.controller.dispose(); await outcome; }
});

test('a retained canceled Hat attempt does not invalidate preparation for its next acknowledged attempt', async () => {
  const f=fixture();f.inactive();
  const prepared=await f.controller.prepare({}),next={...attempt,cardAttemptId:'next-deliberate-attempt'};
  f.acknowledge(next);f.controller.resetAttempt();
  const outcome=f.controller.start({intent:prepared.intent,instructions:'Hat',tools:[]}).catch(error=>error);
  try{
    await tick();assert.equal(f.counters().consentCalls,1,'inactive receipt identity must not bind the next preparation');
    assert.equal(f.counters().media,0);assert.equal(f.urls.some(url=>url.endsWith('/start')),false);
    f.consent.resolve(false);assert.match(String(await outcome),/declined/);
  }finally{f.controller.dispose();await outcome;}
});

test('inactive preparation leaves the retained attempt available to native cleanup', async () => {
  const f=fixture();f.inactive();
  f.deps.fetch=async(url)=>{f.urls.push(String(url));return Response.json(String(url).endsWith('/config')?capability:
    {...identity,status:'not-started',providerState:'not-created',accountingState:'complete'});};
  try{
    const result=await f.controller.finish();assert.equal(result.status,'not-started');
    if(result.status==='not-started')assert.deepEqual(result.attempt,attempt);
    assert.equal(f.counters().media,0);assert.equal(f.urls.some(url=>url.endsWith('/start')),false);
  }finally{f.controller.dispose();}
});

test('prepared fresh Hat cannot move to another session, world, journey or epoch', async () => {
  for(const change of [{sessionId:'other-session'},{worldId:'other-world'},{journeyId:'other-journey'},{journeyEpoch:2}]) {
    const f=fixture(null), prepared=await f.controller.prepare({});
    try {
      f.acknowledge({...attempt,...change}); f.controller.resetAttempt();
      await assert.rejects(f.controller.start({intent:prepared.intent,instructions:'Hat',tools:[]}),/expired/);
      assert.equal(f.counters().consentCalls,0); assert.equal(f.counters().media,0); assert.equal(f.urls.length,0);
    } finally {f.controller.dispose();}
  }
});

test('fresh preparation binds once and cannot follow a replacement or removed attempt', async () => {
  for(const fresh of [true,false]) for(const next of [null,{...attempt,cardAttemptId:'replacement'}]) {
    const f=fixture(fresh?null:attempt), prepared=await f.controller.prepare({});
    try {
      if(fresh){f.acknowledge(attempt);f.controller.resetAttempt();}
      f.acknowledge(next); f.controller.resetAttempt();
      await assert.rejects(f.controller.start({intent:prepared.intent,instructions:'Hat',tools:[]}),/expired/);
      assert.equal(f.counters().consentCalls,0); assert.equal(f.urls.length,0);
    } finally {f.controller.dispose();}
  }
});

test('start fences changed acknowledged namespace even before the host passive reset runs', async () => {
  const f=fixture(null),prepared=await f.controller.prepare({});
  f.acknowledge({...attempt,journeyEpoch:2});
  try{
    await assert.rejects(f.controller.start({intent:prepared.intent,instructions:'Hat',tools:[]}),/expired/);
    assert.equal(f.counters().consentCalls,0);assert.equal(f.urls.length,0);
  }finally{f.controller.dispose();}
});

test('first-attempt adoption without a captured host namespace fails closed', async () => {
  const f=fixture(null);delete f.deps.currentPreparationScope;
  const prepared=await f.controller.prepare({});
  f.acknowledge(attempt);f.controller.resetAttempt();
  try{
    await assert.rejects(f.controller.start({intent:prepared.intent,instructions:'Hat',tools:[]}),/expired/);
    assert.equal(f.counters().consentCalls,0);assert.equal(f.urls.length,0);
  }finally{f.controller.dispose();}
});
test('prepared balance intent still requires truthful funding consent; delayed OS permission gets its own human window', async t => {
  t.mock.timers.enable({apis:['setTimeout','setInterval']});
  const f = fixture(), prepared = await f.controller.prepare({});
  let now=0; f.deps.now=()=>now;
  const start = f.controller.start({intent:prepared.intent,instructions:'Hat',tools:[]}); await tick();
  assert.equal(f.counters().consentCalls,1); assert.equal(f.counters().media,0);
  f.controller.updateInstructions('Replacement must not silently apply');
  assert.ok(f.events.some(v=>v.type==='input-hint' && /stay fixed/.test(v.message)),'balance instructions are explicitly unsupported even during human consent');
  f.controller.updateContext('latest witnessed context while awaiting permission');
  t.mock.timers.tick(40000); f.consent.resolve(true); await tick();
  assert.equal(f.counters().media,1); t.mock.timers.tick(40000); await tick();
  assert.equal(f.urls.some(v => v.endsWith('/start')),false,'no reservation until OS permission');
  f.permission.resolve(f.stream); await tick(); f.socket.open(); f.socket.event({type:'bound',epoch:1}); f.socket.event({type:'ready',epoch:1,playbackEpoch:0}); await start;
  now=200; t.mock.timers.tick(200);
  assert.equal(f.socket.sent.find(v=>v.type==='context')?.context,'latest witnessed context while awaiting permission','human-phase updates coalesce into a deferred update after the exact initial bind');
  f.controller.stop(); assert.equal(f.track.stops,1);
});
test('decline and stop-before-late-grant never reserve a provider or leave tracks', async () => {
  for (const mode of ['decline','late-grant']) {
    const f = fixture(); const start = f.controller.start({instructions:'Hat',tools:[]}); const rejected = assert.rejects(start); await tick();
    f.consent.resolve(mode !== 'decline'); await tick(); f.controller.stop(); f.permission.resolve(f.stream); await rejected; await tick();
    assert.equal(f.urls.some(v => v.endsWith('/start')),false); assert.equal(f.track.stops,mode === 'late-grant' ? 1 : 0);
  }
});
test('finish cancels native consent and permission immediately but waits for atomic server proof', async t => {
  for (const phase of ['consent', 'permission'] as const) await t.test(phase, async () => {
    const f = fixture(), receipt = deferred<Response>();
    const atomic = { ...identity, callId: 'server-consumed-attempt', connectionId: null, epoch: 0, status: 'not-started', providerState: 'not-created', accountingState: 'not-applicable' };
    f.deps.requestConsent = async (_signal, unlock) => { unlock(); return f.consent.promise; };
    f.deps.fetch = async (url, options) => {
      const path = String(url); f.urls.push(path);
      if (path.endsWith('/config')) return Response.json(capability);
      assert.equal(path, '/api/voice/session/balance/recover/finish');
      assert.equal(options?.method, 'POST'); assert.equal(options?.credentials, 'include');
      return receipt.promise;
    };
    const starting = f.controller.start({ instructions: 'Hat', tools: [] });
    const rejected = assert.rejects(starting, /stopped/i);
    await tick(); if (phase === 'permission') { f.consent.resolve(true); await tick(); }
    let returned = false;
    const finishing = f.controller.finish().then(result => { returned = true; return result; });
    try {
      assert.equal(f.audio.closed, 1, 'finish synchronously closes the unlocked native audio owner');
      await rejected; await tick();
      assert.ok(f.urls.some(path => path.endsWith('/recover/finish')), 'atomic exact-attempt cancellation is requested');
      assert.equal(returned, false, 'local absence is not a no-call receipt');
      if (phase === 'consent') f.consent.resolve(true);
      f.permission.resolve(f.stream); await tick();
      assert.equal(f.counters().media, phase === 'permission' ? 1 : 0);
      assert.equal(f.track.stops, phase === 'permission' ? 1 : 0, 'a late OS grant is released');
      f.socket.open(); f.socket.event({ type: 'ready', epoch: 1, playbackEpoch: 0 });
      assert.equal(f.urls.some(path => path.endsWith('/start')), false);
      assert.equal(f.events.some(event => event.type === 'status' && event.status === 'connected'), false);
      receipt.resolve(Response.json(atomic));
      assert.deepEqual(await finishing, { status: 'not-started', callId: atomic.callId, connectionId: null, epoch: 0, attempt, providerState: 'not-created', accounting: 'not-applicable' });
    } finally {
      f.controller.stop(); f.consent.resolve(false); f.permission.resolve(f.stream); receipt.resolve(Response.json(atomic));
      await rejected; await finishing; f.controller.dispose();
    }
  });
});
test('finish during native permission rejects missing atomic proof while still canceling local start', async () => {
  const f = fixture();
  f.deps.fetch = async url => { const path = String(url); f.urls.push(path); return Response.json(path.endsWith('/config') ? capability : { status: 'not-found' }); };
  const starting = f.controller.start({ instructions: 'Hat', tools: [] }), rejected = assert.rejects(starting, /stopped/i);
  await tick(); f.consent.resolve(true); await tick();
  try {
    await assert.rejects(f.controller.finish(), /cleanup.*unavailable/i);
    await rejected; f.permission.resolve(f.stream); await tick();
    assert.equal(f.audio.closed, 1); assert.equal(f.track.stops, 1);
    assert.equal(f.urls.some(path => path.endsWith('/start')), false);
    assert.ok(f.events.some(event => event.type === 'status' && event.code === 'VOICE_BALANCE_RECOVERY'));
  } finally { f.controller.stop(); f.permission.resolve(f.stream); await rejected; f.controller.dispose(); }
});
test('actual SDK and zero-argument dispatch expose no-spend balance config and strict finish validation', async () => {
  const f = fixture(); const api = createVoiceAPI({available:true,call:async (method,args) => await dispatchVoiceCall(f.controller,method,args) as never,post() {},target:new EventTarget()});
  assert.deepEqual(await api.getConfig(),capability);
  assert.equal(f.counters().media,0); assert.throws(() => dispatchVoiceCall(f.controller,'realtimeVoice.getConfig',['foreign']),/argument/i); assert.throws(() => dispatchVoiceCall(f.controller,'realtimeVoice.finish',['foreign']),/argument/i);
  const malformed = createVoiceAPI({available:true,call:async()=>({status:'finished',lastFinalSeq:0}) as never,post(){},target:new EventTarget()}); await assert.rejects(malformed.finish(),/invalid|confirm/i);
  f.replace(); assert.equal((await f.controller.getConfig()).available,false);
});
test('permission denial and revocation close audio without a balance start', async () => {
  const f = fixture(); f.deps.getUserMedia = async () => {throw Object.assign(Error('denied'),{name:'NotAllowedError'});};
  const starting=f.controller.start({instructions:'Hat',tools:[]}); const rejected=assert.rejects(starting,/microphone|blocked/i); await tick(); f.consent.resolve(true); await rejected;
  assert.equal(f.urls.some(v=>v.endsWith('/start')),false); assert.equal(f.audio.closed,1);
  const revoked=fixture(); const start=revoked.controller.start({instructions:'Hat',tools:[]}); const rejection=assert.rejects(start,/disconnected|stopped/i); await tick(); revoked.consent.resolve(true); await tick(); revoked.track.readyState='ended'; revoked.permission.resolve(revoked.stream); await rejection;
  assert.equal(revoked.urls.some(v=>v.endsWith('/start')),false); assert.equal(revoked.track.stops,1);
});
test('late capability responses are fenced after account/session replacement and disabled SDK has no bridge traffic', async () => {
  const f=fixture(), response=deferred<Response>(); f.deps.fetch=()=>response.promise;
  const query=f.controller.getConfig(); f.replace(); response.resolve(Response.json(capability)); assert.equal((await query).available,false);
  const disabled=createVoiceAPI({available:false,call:async()=>{assert.fail('disabled bridge');},post(){},target:new EventTarget()}); assert.equal((await disabled.getConfig()).available,false); assert.equal((await disabled.finish()).status,'unsupported');
});
test('legacy finish is explicitly unsupported and never changes its emergency stop behavior', async () => {
  const f=fixture(); f.deps.fetch=async()=>Response.json({available:true,funding:'byok',turnControl:'client-v1',maxDurationSeconds:300});
  assert.equal((await f.controller.finish()).status,'unsupported'); assert.equal(f.counters().media,0); assert.equal(f.urls.some(v=>v.includes('/balance/')),false);
});
test('strict SDK finish accepts actual states and rejects forged completion, cursors and scope', async () => {
  const base={callId:'call',connectionId:'connection',epoch:1,attempt,providerState:'close-confirmed',accounting:'complete'};
  const valid=[{...base,status:'finished',lastFinalSeq:0},{...base,status:'pending',providerState:'open',accounting:'pending'},{...base,status:'incomplete',providerState:'hard-expired',accounting:'incomplete',lastFinalSeq:1},{...base,status:'unavailable',accounting:'incomplete'},{...base,status:'not-started',providerState:'not-created'}];
  const invalid=[{...base,status:'finished',lastFinalSeq:0,providerState:'unconfirmed'},{...base,status:'finished',lastFinalSeq:0,accounting:'pending'},{...base,status:'pending',lastFinalSeq:0},{...base,status:'unavailable',lastFinalSeq:0},{...base,status:'finished',lastFinalSeq:-1},{...base,status:'finished',lastFinalSeq:0,attempt:{...attempt,journeyEpoch:-1}},{...base,status:'finished',lastFinalSeq:0,providerKey:'forbidden'}];
  for(const value of valid){const api=createVoiceAPI({available:true,call:async()=>value as never,post(){},target:new EventTarget()}); assert.deepEqual(await api.finish(),value);}
  for(const value of invalid){const api=createVoiceAPI({available:true,call:async()=>value as never,post(){},target:new EventTarget()}); await assert.rejects(api.finish(),/invalid/i);}
});
test('replacing the saved attempt discards retained replay authority and finishes the new exact attempt only', async () => {
  const f=fixture(); let current=attempt;
  f.deps.currentAttempt=()=>current;
  f.deps.fetch=async(url)=>Response.json(String(url).endsWith('/config') ? capability : String(url).endsWith('/recover/finish') ? {...identity,callId:'next-call',attempt:current,status:'not-started',providerState:'not-created',accountingState:'complete'} : {...identity,status:'finished',providerState:'close-confirmed',accountingState:'complete',finalSeq:0,finals:[]});
  await f.controller.recover(); current={...attempt,cardAttemptId:'next-attempt'}; f.controller.resetAttempt();
  const result=await f.controller.finish(); assert.equal(result.status,'not-started'); if(result.status==='not-started') assert.equal(result.attempt.cardAttemptId,'next-attempt');
  assert.equal(f.events.some(v=>v.type==='transcript'),false); assert.equal(f.counters().media,0);
});
