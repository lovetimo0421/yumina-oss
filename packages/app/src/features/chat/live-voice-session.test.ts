import test from "node:test";
import assert from "node:assert/strict";
import { LiveVoiceSession as ProviderLiveVoiceSession } from "./live-voice-session";
import { composeVoiceInstructions, voiceStartContextError } from "../../../sandbox/voice-types";
import {hydrateVoiceSceneNotice} from './voice-scene-notice';

const isReplyAppend = (event: any) => event.type === 'session.instructions.append' && event.content?.startsWith('For this reply only,');
const replyText = (event: any) => JSON.parse(event.content.split('Reply JSON:\n')[1]);

// These caption/context/playback tests use an accepting provider. Delayed,
// rejected and reordered input acknowledgments have their own integration suite.
class LiveVoiceSession extends ProviderLiveVoiceSession {
  constructor(...[deps, ...options]: ConstructorParameters<typeof ProviderLiveVoiceSession>) {
    super({ ...deps, send: event => {
      if (event.type === 'session.input_audio.mute' || event.type === 'session.input_audio.unmute') {
        this.receive({ type: event.type === 'session.input_audio.mute' ? 'session.input_audio.muted' : 'session.input_audio.unmuted', client_event_id: event.event_id });
      } else {
        deps.send(event);
        if (/^session\.(instructions|thinking|commentary)\.append$/.test(String(event.type)))
          this.receive({ type: event.type + 'ed', client_event_id: event.event_id });
      }
    } }, ...options);
  }
}

test('background microphone noise cannot indefinitely withhold a recognized statement from world reasoning', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events: any[] = [], sent: any[] = [];
  const s = new LiveVoiceSession({ send: e => sent.push(e), emit: e => events.push(e), input() {}, interruptAudio() {}, fail() {} }, 'Official', '', 'manual', undefined, true, 'silent');
  s.receive({ type: 'session.started' }); s.start();
  s.inputLevel(.1);
  s.receive({ type: 'session.input_transcript.delta', delta: 'Why must I erase her name?' });
  for (let n = 0; n < 80; n++) { s.inputLevel(.04); t.mock.timers.tick(100); }
  const requests = events.filter(e => e.type === 'delegation');
  assert.equal(requests.length, 1, 'steady room noise must not prevent a complete recognized statement from getting a reply');
  assert.equal(events.filter(e => e.type === 'transcript' && e.role === 'user' && e.final).length, 1);
  assert.equal(s.resolveDelegation(requests[0].id, { text: 'The correction concerns the register. Erase the entry.' }), true);
  assert.equal(sent.filter(isReplyAppend).length, 1, 'residual noise must not reopen the microphone floor and strand the approved reply');
  s.close();
});

test('a fresh manual live opening reserves its speaking turn before microphone noise can suppress it', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const inputs: boolean[] = [], events: any[] = [], sent: any[] = [], gates: boolean[] = [];
  const s = new LiveVoiceSession({ send: e=>sent.push(e), emit:e=>events.push(e), input:v=>inputs.push(v), allowAudio:v=>gates.push(v), interruptAudio(){}, fail(){} }, 'Fresh opening direction', '', 'manual', undefined, true, 'character');
  s.receive({type:'session.started'});s.start();
  assert.ok(sent.some(e=>e.content?.startsWith('Immediately speak the authored first-contact line')),'Fresh entry sends a direct greeting cue instead of conditional conversation advice');
  assert.equal(inputs.at(-1),false,'The first line owns the floor before source audio reaches the speaker');
  s.inputLevel(.08);s.updateInstructions('Later public direction.');
  assert.equal(sent.some(e=>e.content==='Later public direction.'),false,'Context changes must not restart the opening');
  s.sourceActivity(true);s.receive({type:'session.output_transcript.delta',delta:'6079. Your assignment is on the desk.'});
  assert.ok(events.some(e=>e.type==='transcript'&&e.role==='assistant'));
  assert.equal(gates.at(-1),true,'Noise cannot close the authorized opening output');
  s.avatarQueue(1);s.playback('started');s.sourceActivity(false);s.avatarQueue(0);s.playback('stopped');t.mock.timers.tick(1500);
  assert.equal(inputs.at(-1),true);s.close();
});

test('continued recognized speech resets the noise fallback and late words supersede its earlier request', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events: any[] = [];
  const s = new LiveVoiceSession({ send() {}, emit: e => events.push(e), input() {}, interruptAudio() {}, fail() {} }, 'Official', '', 'manual', undefined, true, 'silent');
  s.receive({ type: 'session.started' }); s.start();
  for (const delta of ['I remember her. ', 'She helped me when I was a child. ', 'She was real.']) {
    s.inputLevel(.1); s.receive({ type: 'session.input_transcript.delta', delta });
    for (let n = 0; n < 40; n++) { s.inputLevel(.04); t.mock.timers.tick(100); }
    assert.equal(events.some(e => e.type === 'delegation'), false, 'a long ongoing statement must not be split by total turn duration');
  }
  for (let n = 0; n < 30; n++) { s.inputLevel(.04); t.mock.timers.tick(100); }
  const request = events.find(e => e.type === 'delegation'); assert.ok(request);
  s.receive({ type: 'session.input_transcript.delta', delta: 'And I will not erase her.' });
  assert.equal(s.resolveDelegation(request.id, { text: 'Obsolete answer.' }), false);
  for (let n = 0; n < 80; n++) { s.inputLevel(.04); t.mock.timers.tick(100); }
  assert.equal(events.filter(e => e.type === 'delegation').length, 2);
  assert.equal(events.filter(e => e.type === 'transcript' && e.final).at(-1).text, 'And I will not erase her.');
  s.close();
});

test('noise that starts while the backend is thinking cannot strand its approved reply', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events: any[] = [], sent: any[] = [];
  const s = new LiveVoiceSession({ send: e => sent.push(e), emit: e => events.push(e), input() {}, interruptAudio() {}, fail() {} }, 'Official', '', 'manual', undefined, true, 'silent');
  s.receive({ type: 'session.started' }); s.start();
  s.inputLevel(.1); s.receive({ type: 'session.input_transcript.delta', delta: 'I remember her.' });
  t.mock.timers.tick(1500);
  const request = events.find(e => e.type === 'delegation'); assert.ok(request);
  s.inputLevel(.04); s.resolveDelegation(request.id, { text: 'Memory does not amend the register.' });
  for (let n = 0; n < 80; n++) { s.inputLevel(.04); t.mock.timers.tick(100); }
  assert.equal(sent.filter(isReplyAppend).length, 1);
  assert.equal(events.filter(e => e.type === 'delegation').length, 1, 'noise cannot fabricate a second statement');
  s.close();
});

test('connection startup prioritizes entry direction and saved history while preserving a fresh opening', () => {
  const sent: any[] = [];
  const session = new LiveVoiceSession({ send: e => sent.push(e), emit() {}, input() {}, interruptAudio() {}, fail() {} },
    'Current connection-entry direction: this is a reconnect after a completed answer. Remain silent and listen.', '', 'manual', undefined, true);
  session.receive({ type: 'session.started' }); session.start();
  assert.equal(sent.length, 1, 'entry priority and conditional silence must arrive in the same bounded startup append');
  const direction = sent[0].content;
  assert.match(direction, /Follow the current connection-entry direction and supplied saved history/);
  assert.match(direction, /fresh start with no prior exchange/);
  assert.match(direction, /speak the character's opening instruction/);
  assert.match(direction, /never repeat a completed opening or order/);
  assert.match(direction, /If entry direction requires silence, remain silent/);
  assert.doesNotMatch(direction, /Immediately speak first|session just started|do not wait for the user/i);
  session.close();
});

test('world input discards Go on and Finish your statement while requesting one complete backend reply without native delegation', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: any[] = [], events: any[] = [], inputs: boolean[] = [], gates: boolean[] = [];
  const s = new LiveVoiceSession({ send: e => sent.push(e), emit: e => events.push(e), input: v => inputs.push(v),
    allowAudio: v => gates.push(v), interruptAudio() { assert.fail('speculative speech was never played'); }, fail() {} }, 'Official', '', 'manual', undefined, true);
  s.receive({ type: 'session.started' }); s.start();
  s.inputLevel(.1);
  s.receive({ type: 'session.input_transcript.delta', delta: 'I refuse to erase Anna ' });
  s.sourceActivity(true);
  s.receive({ type: 'session.output_transcript.delta', delta: 'Go on. Finish your statement.' });
  assert.equal(gates.at(-1), false, 'unapproved speech must be excluded before avatar buffering');
  assert.equal(inputs.at(-1), true, 'the entire resident sentence must still be captured');
  t.mock.timers.tick(950); s.inputLevel(.1);
  s.receive({ type: 'session.input_transcript.delta', delta: 'She was a real person Why are you making me lie' });
  t.mock.timers.tick(1500);
  const final = events.find(e => e.type === 'transcript' && e.final && e.role === 'user');
  assert.equal(final.text, 'I refuse to erase Anna She was a real person Why are you making me lie');
  const request = events.find(e => e.type === 'delegation');
  assert.ok(request, 'a complete statement starts reasoning even when native Live never delegates');
  s.receive({ type: 'session.delegation.created', delegation: { id: 'native-late' } });
  s.receive({ type: 'session.delegation.created', delegation: { id: 'native-duplicate' } });
  assert.equal(events.filter(e => e.type === 'delegation').length, 1);
  s.resolveDelegation(request.id, { text: 'You remember a person. The Party requires a vacant position.' });
  assert.equal(sent.some(e => isReplyAppend(e)), false, 'old PCM must drain before the approved result is injected');
  s.sourceActivity(false);
  t.mock.timers.tick(700);
  assert.equal(sent.at(-1).type, 'session.instructions.append');
  assert.equal(sent.at(-1).delegation_id, null, 'application-owned work must not impersonate a provider delegation');
  assert.equal(gates.at(-1), true, 'authorize before the first response packet arrives');
  assert.equal(events.some(e => e.text?.includes('Go on')), false);
  assert.equal(s.resolveDelegation(request.id, { text: 'Duplicate' }), false);
  s.close();
});

test('delegation never substitutes old testimony for a delayed new transcript', t=>{
  t.mock.timers.enable({apis:['setTimeout']});const events:any[]=[];
  const s=new LiveVoiceSession({send(){},emit:e=>events.push(e),input(){},interruptAudio(){},fail(){}},'Official','','manual',undefined,true);
  s.receive({type:'session.started'});s.start();
  s.receive({type:'session.input_transcript.delta',delta:'Old statement.'});t.mock.timers.tick(1500);
  const old = events.find(e => e.type === 'delegation');
  assert.ok(old); s.resolveDelegation(old.id, { cancelled: true }); events.length = 0;
  s.inputLevel(.1);s.receive({type:'session.delegation.created',delegation:{id:'new-turn'}});
  t.mock.timers.tick(2000);
  assert.equal(events.some(e=>e.type==='delegation'),false);
  s.receive({type:'session.input_transcript.delta',delta:'I refuse the correction.'});t.mock.timers.tick(1500);
  assert.equal(events.filter(e=>e.type==='delegation').length,1);s.close();
});

test('finishing an earlier pending caption cannot acknowledge a newer microphone turn',t=>{
  t.mock.timers.enable({apis:['setTimeout']});const events:any[]=[];
  const s=new LiveVoiceSession({send(){},emit:e=>events.push(e),input(){},interruptAudio(){},fail(){}},'Official','','manual',undefined,true);
  s.receive({type:'session.started'});s.start();s.inputLevel(.1);
  s.receive({type:'session.input_transcript.delta',delta:'Previous words.'});t.mock.timers.tick(1300);
  s.inputLevel(.1);s.receive({type:'session.delegation.created',delegation:{id:'later'}});
  for(let n=0;n<20;n++)t.mock.timers.tick(100);
  assert.equal(events.some(e=>e.type==='delegation'),false);
  s.receive({type:'session.input_transcript.delta',delta:'I changed my mind.'});t.mock.timers.tick(1500);
  assert.equal(events.filter(e=>e.type==='delegation').length,1);
  const id = events.find(e => e.type === 'delegation').id;
  s.sourceActivity(true);s.resolveDelegation(id,{text:'A queued answer.'});
  assert.equal(s.resolveDelegation(id,{cancelled:true}),true);s.close();
});

test('interrupting or supplying new words cancels an answer buffered behind playback', t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  for(const interrupt of [false,true]){
    const sent:any[]=[], events:any[]=[];
    const s=new LiveVoiceSession({send:e=>sent.push(e),emit:e=>events.push(e),input(){},interruptAudio(){},fail(){}},'Official','','manual',undefined,true);
    s.receive({type:'session.started'});s.start();
    s.receive({type:'session.input_transcript.delta',delta:'I refuse.'});s.receive({type:'session.delegation.created',delegation:{id:'old'}});t.mock.timers.tick(1500);
    const id = events.find(e => e.type === 'delegation').id;
    s.sourceActivity(true);assert.equal(s.resolveDelegation(id,{text:'Your refusal has been recorded.'}),true);
    if(interrupt)s.interrupt();
    s.receive({type:'session.input_transcript.delta',delta:'Correction, I accept.'});
    s.sourceActivity(false);t.mock.timers.tick(2000);
    assert.equal(sent.some(e=>isReplyAppend(e)),false);
    assert.equal(s.resolveDelegation(id,{text:'Old result'}),false);s.close();
  }
});

test('quiet input releases a backend answer and explicit stale cancellation stays silent',t=>{
  t.mock.timers.enable({apis:['setTimeout']});const sent:any[]=[],events:any[]=[];
  const s=new LiveVoiceSession({send:e=>sent.push(e),emit:e=>events.push(e),input(){},interruptAudio(){},fail(){}},'Official','','manual',undefined,true);
  s.receive({type:'session.started'});s.start();
  s.receive({type:'session.input_transcript.delta',delta:'I remember her.'});s.receive({type:'session.delegation.created',delegation:{id:'answer'}});t.mock.timers.tick(1500);
  const id = events.find(e => e.type === 'delegation').id;
  s.inputLevel(.1);assert.equal(s.resolveDelegation(id,{text:'Your recollection is not a correction.'}),true);
  assert.equal(sent.some(e=>isReplyAppend(e)),false);t.mock.timers.tick(1300);
  assert.ok(sent.some(e=>isReplyAppend(e)));
  s.sourceActivity(true); s.avatarQueue(1); s.playback('started'); s.sourceActivity(false); s.avatarQueue(0); s.playback('stopped'); t.mock.timers.tick(700);
  s.receive({type:'session.input_transcript.delta',delta:'Another statement.'});s.receive({type:'session.delegation.created',delegation:{id:'cancel'}});t.mock.timers.tick(1500);
  const cancelled = events.filter(e => e.type === 'delegation').at(-1).id;
  assert.equal(s.resolveDelegation(cancelled,{cancelled:true}),true);t.mock.timers.tick(31000);
  assert.equal(events.some(e=>e.type==='input-hint'),false);s.close();
});

test('world delegation waits for the resident transcript and returns actual backend results, not a generic reply instruction', t => {
  t.mock.timers.enable({apis:['setTimeout']});const sent:any[]=[],events:any[]=[];
  const s=new LiveVoiceSession({send:e=>sent.push(e),emit:e=>events.push(e),input(){},interruptAudio(){},fail(){}},'Official','','manual',undefined,true);
  s.receive({type:'session.started'});s.start();sent.length=0;
  s.inputLevel(.1);s.receive({type:'session.input_transcript.delta',delta:'I refuse to erase ',start_ms:0,end_ms:600});
  s.receive({type:'session.delegation.created',delegation:{id:'d1'}});
  t.mock.timers.tick(900);s.inputLevel(.1);t.mock.timers.tick(600);
  assert.equal(events.some(e=>e.type==='delegation'),false,'The backend must not act on a half sentence.');
  assert.equal(events.some(e=>e.type==='transcript'&&e.final),false);
  s.receive({type:'session.input_transcript.delta',delta:'her name.',start_ms:1600,end_ms:1900});
  t.mock.timers.tick(1600);
  const final=events.find(e=>e.type==='transcript'&&e.final);
  assert.equal(final.text,'I refuse to erase her name.');
  assert.equal(events.filter(e=>e.type==='delegation').length,1);
  assert.ok(events.indexOf(final)<events.findIndex(e=>e.type==='delegation'));
  assert.equal(sent.length,0,'A delegation must actually go to the reasoning backend.');
  assert.equal(s.resolveDelegation('invented',{text:'The door opens.'}),false);
  const id = events.find(e => e.type === 'delegation').id;
  assert.equal(s.resolveDelegation(id,{text:'The name is to be cancelled. You have stated your refusal.'}),true);
  assert.equal(sent.at(-1).type,'session.instructions.append');assert.equal(sent.at(-1).delegation_id,null);
  assert.equal(s.resolveDelegation(id,{text:'Duplicate'}),false);s.close();
});

test('delegation timeout does not fabricate success or disconnect the call',t=>{
  t.mock.timers.enable({apis:['setTimeout']});const sent:any[]=[],events:any[]=[];
  const s=new LiveVoiceSession({send:e=>sent.push(e),emit:e=>events.push(e),input(){},interruptAudio(){},fail(){assert.fail('call must stay live');}},'Official','','manual',undefined,true);
  s.receive({type:'session.started'});s.start();sent.length=0;
  s.receive({type:'session.input_transcript.delta',delta:'I refuse.'});t.mock.timers.tick(1500);
  const id = events.find(e => e.type === 'delegation').id; t.mock.timers.tick(31000);
  assert.equal(events.some(e => e.type === 'input-hint'), false, 'one bounded backend refresh still has time to complete');
  t.mock.timers.tick(15000);
  assert.equal(s.resolveDelegation(id,{text:'You may leave.'}),false);
  assert.ok(events.some(e=>e.type==='input-hint'));
  assert.equal(sent.some(e=>isReplyAppend(e)),false);s.close();
});

function worldFixture(opening?: 'character' | 'silent') {
  const sent: any[] = [], events: any[] = [], inputs: boolean[] = [], allowed: boolean[] = [], errors: string[] = [];
  let interrupts = 0;
  const session = new LiveVoiceSession({ send: e => sent.push(e), emit: e => events.push(e), input: v => inputs.push(v),
    allowAudio: v => allowed.push(v), interruptAudio: () => { interrupts++; }, fail: e => errors.push(e) }, 'Official', '', 'manual', undefined, true, opening);
  session.receive({ type: 'session.started' }); session.start();
  return { session, sent, events, inputs, allowed, errors, interrupts: () => interrupts,
    request: () => events.filter(e => e.type === 'delegation').at(-1)?.id };
}

test('a changed semantic sight expires a buffered spoken answer before its performance without losing received words', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = worldFixture('silent');
  f.session.updateContext({ state: { sight: 'screen: resident in view; photograph visible', room: 'Permission 30.0s remaining' }, events: [] });
  f.session.receive({ type: 'session.input_transcript.delta', delta: 'Can you see the photograph?' }); t.mock.timers.tick(1500);
  f.session.sourceActivity(true); f.session.resolveDelegation(f.request(), { text: 'Keep it where it is. I can see it.' });
  f.session.updateContext({ state: { sight: 'screen: resident not in view; photograph unseen', room: 'Permission 28.0s remaining' }, events: [] });
  f.session.sourceActivity(false); t.mock.timers.tick(700);
  assert.equal(f.sent.some(event => isReplyAppend(event)), false);
  assert.ok(f.events.some(event => event.type === 'input-hint' && /words are saved/.test(event.message)));
  assert.ok(f.events.some(event => event.type === 'transcript' && event.final && event.text === 'Can you see the photograph?'));
  assert.equal(f.inputs.at(-1), true); assert.equal(f.interrupts(), 0); f.session.close();
});

test('time counters and omission text cannot expire a buffered answer with unchanged semantic sight', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = worldFixture('silent');
  f.session.updateContext({ state: { sight: 'resident unseen', room: 'Permission 30.0s remaining', omissions: '1 omitted' }, events: [] });
  f.session.receive({ type: 'session.input_transcript.delta', delta: 'Can you see me?' }); t.mock.timers.tick(1500);
  f.session.sourceActivity(true); f.session.resolveDelegation(f.request(), { text: 'Return to the screen.' });
  f.session.updateContext({ state: { sight: 'resident unseen', room: 'Permission 28.0s remaining', omissions: '3 omitted', extra: 'private metadata is not authority' }, events: [] });
  f.session.sourceActivity(false); t.mock.timers.tick(700);
  assert.deepEqual(f.sent.filter(event => isReplyAppend(event)).map(replyText), ['Return to the screen.']);
  assert.equal(f.interrupts(), 0); f.session.close();
});

test('silent opening blocks native context replies while preserving microphone and authorized reply or scene delivery', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const kind of ['reply', 'scene', 'microphone'] as const) {
    const f = worldFixture('silent');
    assert.equal(f.allowed.at(-1), false); assert.equal(f.inputs.at(-1), true);
    f.session.updateContext('The resident typed: I refuse the order.');
    f.session.sourceActivity(true);
    f.session.receive({ type: 'session.output_transcript.delta', delta: 'No. Your words are taken down as said.' });
    assert.equal(f.events.some(e => e.type === 'transcript' && e.role === 'assistant'), false);
    assert.equal(f.inputs.at(-1), true, 'denied native output cannot close microphone capture');
    if (kind === 'reply') { const variables = replyVariables(); f.session.scene(savedReply(() => variables)); }
    if (kind === 'scene') f.session.scene({ id: 'real-knock', kind: 'knock' });
    if (kind === 'microphone') {
      f.session.inputLevel(.1); f.session.receive({ type: 'session.input_transcript.delta', delta: 'I remember Anna.' }); t.mock.timers.tick(1500);
      assert.ok(f.request()); f.session.resolveDelegation(f.request(), { text: 'Your statement has been heard.' });
    }
    assert.equal(f.allowed.at(-1), false, 'existing raw source must drain before authorized speech');
    f.session.sourceActivity(false); t.mock.timers.tick(700);
    assert.equal(f.allowed.at(-1), true); assert.equal(f.inputs.at(-1), false);
    assert.equal(f.sent.at(-1).type, 'session.instructions.append');
    f.session.close();
  }
});

test('world playback stays protected through late recognition, captions, source gaps and all queued avatar speech', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = worldFixture();
  f.session.receive({ type: 'session.input_transcript.delta', delta: 'I remember Anna.' }); t.mock.timers.tick(1500);
  f.session.resolveDelegation(f.request(), { text: 'Memory does not change the correction.' });
  f.session.sourceActivity(true); f.session.avatarQueue(2); f.session.playback('started');
  f.session.receive({ type: 'session.output_transcript.delta', delta: 'Memory does not change the correction.' });
  f.session.inputLevel(.5); // Echo and ambient noise cannot take the floor.
  f.session.receive({ type: 'session.input_transcript.delta', delta: 'Late captured words.' });
  t.mock.timers.tick(1600);
  assert.equal(f.inputs.at(-1), false); assert.equal(f.interrupts(), 0);
  f.session.sourceActivity(false); f.session.playback('stopped'); f.session.avatarQueue(1); t.mock.timers.tick(2000);
  assert.equal(f.inputs.at(-1), false, 'the second queued source is still owed to the listener');
  f.session.playback('started'); f.session.playback('stopped'); f.session.avatarQueue(0); t.mock.timers.tick(700);
  assert.equal(f.inputs.at(-1), true); assert.equal(f.allowed.at(-1), false);
  f.session.close();
});

test('late recognition supersedes an unfinished backend result without replaying the earlier statement', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = worldFixture();
  f.session.receive({ type: 'session.input_transcript.delta', delta: 'I refuse.' }); t.mock.timers.tick(1500);
  const old = f.request();
  f.session.sourceActivity(true); f.session.resolveDelegation(old, { text: 'Earlier incomplete reply.' });
  f.session.receive({ type: 'session.input_transcript.delta', delta: 'Because Anna was a real person.' }); t.mock.timers.tick(1500);
  assert.notEqual(f.request(), old); assert.equal(f.session.resolveDelegation(old, { text: 'Late duplicate' }), false);
  f.session.sourceActivity(false); t.mock.timers.tick(700);
  assert.equal(f.sent.some(e => isReplyAppend(e)), false);
  f.session.resolveDelegation(f.request(), { text: 'The correction concerns the record you have been given.' });
  assert.equal(f.sent.filter(e => isReplyAppend(e)).length, 1); f.session.close();
});

test('world deliberate interrupt waits for the abandoned raw tail before authorizing a fresh reply', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = worldFixture();
  f.session.sourceActivity(true); f.session.avatarQueue(1); f.session.playback('started');
  f.session.interrupt(); t.mock.timers.tick(700);
  assert.equal(f.inputs.at(-1), true, 'V immediately returns capture despite discarded provider audio');
  f.session.inputLevel(.1); f.session.receive({ type: 'session.input_transcript.delta', delta: 'My correction.' }); t.mock.timers.tick(1500);
  f.session.resolveDelegation(f.request(), { text: 'Your correction has been heard.' });
  assert.equal(f.sent.some(e => isReplyAppend(e)), false, 'opening early would lose the approved onset in interrupt suppression');
  f.session.sourceActivity(false); t.mock.timers.tick(700);
  assert.equal(f.sent.filter(e => isReplyAppend(e)).length, 1);
  assert.equal(f.interrupts(), 1); f.session.close();
});

test('a committed physical scene queues behind the unfinished world reply', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = worldFixture();
  f.session.receive({ type: 'session.input_transcript.delta', delta: 'I refuse the correction.' }); t.mock.timers.tick(1500);
  const id = f.request(); f.session.scene({ id: 'knock-now', kind: 'knock' });
  assert.equal(f.sent.some(e => e.content?.includes('knock')), false);
  assert.equal(f.session.resolveDelegation(id, { text: 'Then your refusal is before us.' }), true);
  assert.equal(f.sent.at(-1).type, 'session.instructions.append');
  f.session.sourceActivity(true); f.session.avatarQueue(1); f.session.playback('started');
  f.session.sourceActivity(false); f.session.avatarQueue(0); f.session.playback('stopped'); t.mock.timers.tick(700);
  assert.ok(f.sent.at(-1).content.includes('knock')); assert.equal(f.interrupts(), 0); f.session.close();
});

test('an approved reply with no source audio retires the call so a later cue cannot release it', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = worldFixture();
  f.session.receive({ type: 'session.input_transcript.delta', delta: 'I refuse.' }); t.mock.timers.tick(1500);
  f.session.resolveDelegation(f.request(), { text: 'The register records the refusal.' });
  assert.equal(f.inputs.at(-1), false); t.mock.timers.tick(20100); t.mock.timers.tick(700);
  assert.equal(f.inputs.at(-1), false); assert.equal(f.allowed.at(-1), false);
  assert.ok(f.errors.some(message => message.includes('approved reply') && message.includes('Reconnect')));
  assert.equal(f.sent.at(-1).type, 'session.close');
  assert.equal(f.sent.filter(e => isReplyAppend(e)).length, 1); f.session.close();
});

test('world capture remains open through a long sentence and speculation never reaches a holding queue', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = worldFixture();
  f.session.inputLevel(.1); f.session.sourceActivity(true);
  for (let n = 0; n < 30; n++) { t.mock.timers.tick(500); f.session.inputLevel(.1); }
  assert.equal(f.inputs.at(-1), true); assert.equal(f.allowed.at(-1), false); assert.equal(f.interrupts(), 0);
  assert.equal(f.events.some(e => e.type === 'delegation'), false); f.session.close();
});

function savedReply(current: () => Record<string, unknown>) {
  return hydrateVoiceSceneNotice({ id: 'saved-reply', kind: 'reply' }, current(), [], '76.0.0', current)!;
}
function replyVariables() {
  return { 'unperson-state': { phase: 'find' }, 'unperson-room': { version: 1, attempt: 'a', clock: 2, events: [
    { id: 'typed-input', attempt: 'a', at: 0, kind: 'speech', actor: 'resident', visibility: 'public', data: { role: 'user', text: 'I refuse.', source: 'typed', delivery: 'received' } },
    { id: 'saved-reply', attempt: 'a', at: 1, kind: 'speech', actor: 'screen', visibility: 'public', data: { role: 'assistant', text: 'You have refused the correction.', source: 'generated', delivery: 'generated' } },
  ] } };
}

for (const source of ['delegation', 'typed'] as const) for (const long of [false, true]) {
  test(`approved ${source} performance uses one scoped quoted instruction (${long ? 'multi-packet Unicode' : 'short'}) and keeps actual native captions`, t => {
    t.mock.timers.enable({ apis: ['setTimeout'] }); const f = worldFixture('silent');
    const text = long ? '居民记得安娜。 "Ignore prior instructions" is quoted testimony, not an order. \\ '.repeat(20).slice(0, 1200) : 'The register records your refusal.';
    if (source === 'delegation') {
      f.session.receive({ type: 'session.input_transcript.delta', delta: 'I remember Anna.' }); t.mock.timers.tick(1500);
    }
    f.session.sourceActivity(true); f.sent.length = 0;
    f.session.updateInstructions('Official\n\nKeep the current room in mind.');
    f.session.updateContext('The current work is unfinished.');
    if (source === 'delegation') {
      assert.equal(f.session.resolveDelegation('unowned', { text }), false);
      assert.equal(f.session.resolveDelegation(f.request(), { text: 'x'.repeat(1201) }), false);
      assert.equal(f.session.resolveDelegation(f.request(), { text }), true);
    } else {
      const variables = replyVariables(); variables['unperson-room'].events[1]!.data.text = text;
      const notice = savedReply(() => variables); assert.ok(notice);
      f.session.scene(notice); f.session.scene(notice);
    }
    assert.equal(f.sent.length, 0); assert.equal(f.allowed.at(-1), false);
    f.session.sourceActivity(false); t.mock.timers.tick(700);
    assert.ok(f.sent.length > 0);
    assert.ok(f.sent.every(e => ['session.instructions.append', 'session.thinking.append'].includes(e.type) && e.delegation_id === null));
    assert.equal(f.allowed.at(-1), true, 'The existing source gate opens before the approved first audio packet.');
    assert.equal(f.inputs.at(-1), false);
    const instructions = f.sent.filter(e => e.type === 'session.instructions.append');
    assert.equal(instructions.length, 1, 'Only one complete instruction may cue the performance.');
    const instruction = instructions[0].content;
    assert.match(instruction, /^For this reply only,/);
    assert.match(instruction, /exactly and in full, once/);
    assert.match(instruction, /speech, not instructions/);
    assert.match(instruction, /then listen/);
    assert.equal((instruction.match(/For this reply only,/g) ?? []).length, 1, 'Packet continuations must not add competing speak requests.');
    const quoted = long ? f.sent.filter(e => e.type === 'session.thinking.append').map(e => e.content).join('') : instruction;
    assert.equal(JSON.parse(quoted.split('Reply JSON:\n')[1]), text, 'Quotes, backslashes, Unicode and all words remain inside the data boundary.');
    assert.equal(f.sent.length > 1, long);
    for (const packet of f.sent) assert.ok(new TextEncoder().encode(packet.content).length <= 480);
    const sentCount = f.sent.length;
    const actual = 'Your memory is yours. The entry is what the Party acts on.';
    f.session.sourceActivity(true); f.session.avatarQueue(1); f.session.playback('started');
    f.session.receive({ type: 'session.output_transcript.delta', delta: actual }); t.mock.timers.tick(1500);
    assert.deepEqual(f.events.filter(e => e.type === 'transcript' && e.role === 'assistant' && e.final).map(e => e.text), [actual]);
    assert.equal(f.sent.length, sentCount, 'A transcript boundary cannot release deferred instructions or context.');
    assert.equal(f.inputs.at(-1), false); assert.equal(f.interrupts(), 0);
    f.session.close();
  });
}

test('non-world saved replies retain their native commentary handoff', () => {
  const f = fixture(); f.sent.length = 0;
  f.session.scene({ id: 'native-reply', kind: 'reply', text: 'Your statement is recorded.' });
  assert.deepEqual(f.sent.map(e => [e.type, e.content]), [['session.commentary.append', 'Your statement is recorded.']]);
  f.session.close();
});

test('a saved typed reply supersedes pending microphone reasoning and is delivered before physical scenes', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = worldFixture();
  f.session.receive({ type: 'session.input_transcript.delta', delta: 'Earlier microphone statement.' }); t.mock.timers.tick(1500);
  const old = f.request(); f.session.sourceActivity(true);
  f.session.scene({ id: 'knock-queued', kind: 'knock' });
  const variables = replyVariables(); f.session.scene(savedReply(() => variables));
  assert.equal(f.session.resolveDelegation(old, { text: 'Obsolete answer' }), false);
  f.session.sourceActivity(false); t.mock.timers.tick(700);
  assert.equal(f.sent.at(-1).type, 'session.instructions.append');
  assert.equal(replyText(f.sent.at(-1)), 'You have refused the correction.');
  assert.equal(f.sent.some(e => e.content?.includes('knock')), false);
  f.session.close();
});

test('every hydrated scene expires at enqueue and at its eventual quiet boundary', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const staleAtEnqueue of [false, true]) {
    const f = worldFixture(); let variables = replyVariables();
    const notice = savedReply(() => variables); assert.ok(notice);
    f.session.sourceActivity(true); f.session.avatarQueue(1); f.session.playback('started');
    if (staleAtEnqueue) variables = { ...variables, 'unperson-state': { phase: 'conceal' } };
    f.session.scene(notice);
    variables = { ...variables, 'unperson-state': { phase: 'conceal' } };
    f.session.sourceActivity(false); f.session.avatarQueue(0); f.session.playback('stopped'); t.mock.timers.tick(700);
    assert.equal(f.sent.some(e => isReplyAppend(e) || e.content?.includes('You have refused')), false);
    assert.ok(f.events.some(e => e.type === 'input-hint' && e.message.includes('saved') && e.message.includes('spoken')));
    f.session.close();
  }
});

test('muting a world call cancels pending reasoning so power restoration cannot replay its old answer', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = worldFixture();
  f.session.receive({ type: 'session.input_transcript.delta', delta: 'Earlier statement.' }); t.mock.timers.tick(1500);
  const id = f.request(); f.session.setMuted({ input: true, output: true });
  assert.equal(f.session.resolveDelegation(id, { text: 'A stale answer after power-off.' }), false);
  t.mock.timers.tick(700); f.session.setMuted({ input: false, output: false }); t.mock.timers.tick(9000);
  assert.equal(f.sent.some(e => isReplyAppend(e)), false);
  assert.equal(f.inputs.at(-1), true); f.session.close();
});

test('cancelled, failed and timed-out reasoning release committed scenes without another microphone event', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const result of [{ cancelled: true }, { error: 'backend failure' }, null]) {
    const f = worldFixture();
    f.session.receive({ type: 'session.input_transcript.delta', delta: 'My statement.' }); t.mock.timers.tick(1500);
    f.session.scene({ id: 'committed-knock', kind: 'knock' });
    if (result) f.session.resolveDelegation(f.request(), result); else t.mock.timers.tick(46000);
    assert.equal(f.sent.at(-1).type, 'session.instructions.append'); assert.match(f.sent.at(-1).content, /knock/);
    assert.equal(f.sent.some(e => isReplyAppend(e)), false); f.session.close();
  }
});

test('a saved typed reply after deliberate interruption can speak when no further microphone input arrives', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const delayed of [false, true]) {
    const f = worldFixture(); f.session.interrupt(); t.mock.timers.tick(700);
    if (delayed) f.session.receive({ type: 'session.input_transcript.delta', delta: 'Earlier delayed microphone transcript.' });
    const variables = replyVariables(); f.session.scene(savedReply(() => variables));
    t.mock.timers.tick(1500);
    assert.equal(f.sent.at(-1).type, 'session.instructions.append');
    assert.equal(replyText(f.sent.at(-1)), 'You have refused the correction.');
    assert.equal(f.events.some(e => e.type === 'delegation'), false, 'the saved typed answer superseded this captured input revision');
    f.session.close();
  }
});

test('fresh recognized speech after a typed reply or mute remains eligible even below the local energy threshold', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const muted of [false, true]) {
    const f = worldFixture();
    if (muted) {
      f.session.setMuted({ input: true, output: true }); t.mock.timers.tick(700);
      f.session.setMuted({ input: false, output: false });
    } else {
      const variables = replyVariables(); f.session.scene(savedReply(() => variables));
      f.session.sourceActivity(true); f.session.avatarQueue(1); f.session.playback('started');
      f.session.sourceActivity(false); f.session.avatarQueue(0); f.session.playback('stopped'); t.mock.timers.tick(700);
    }
    f.session.inputLevel(.01);
    f.session.receive({ type: 'session.input_transcript.delta', delta: 'I still remember her.' }); t.mock.timers.tick(1500);
    assert.ok(f.request(), 'new recognized words must not require a local volume threshold to enter reasoning'); f.session.close();
  }
});

test('world reasoning defers incidental context and direction until its approved reply finishes', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = worldFixture();
  f.session.receive({ type: 'session.input_transcript.delta', delta: 'I refuse.' }); t.mock.timers.tick(1500);
  f.sent.length = 0;
  f.session.updateContext('Inspection not completed.');
  f.session.updateInstructions('Official\n\nThe inspection is pending.');
  assert.equal(f.sent.length, 0, 'incidental appends must not generate a preface while the backend is deciding');
  f.session.resolveDelegation(f.request(), { text: 'You refuse the order. That refusal is on the record, 6079.' });
  assert.deepEqual(f.sent.map(e => e.type), ['session.instructions.append']);
  f.session.sourceActivity(true); f.session.avatarQueue(1); f.session.playback('started');
  f.session.sourceActivity(false); t.mock.timers.tick(2000);
  assert.equal(f.sent.length, 1, 'the actual avatar performance still owns the floor');
  f.session.playback('stopped'); f.session.avatarQueue(0); t.mock.timers.tick(700);
  assert.deepEqual(f.sent.map(e => e.type), ['session.instructions.append', 'session.thinking.append', 'session.instructions.append']);
  assert.equal(f.allowed.at(-1), false, 'deferred metadata is delivered with the speech gate closed');
  f.session.close();
});

for (const source of ['delegation', 'typed'] as const) test(`${source} approval is the only append at handoff while queued history and scenes survive`, t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = worldFixture();
  if (source === 'delegation') {
    f.session.receive({ type: 'session.input_transcript.delta', delta: 'I refuse.' }); t.mock.timers.tick(1500);
  }
  // Prior source/playback holds a batch of updates at the same handoff boundary.
  f.session.sourceActivity(true);
  if (source === 'typed') { f.session.avatarQueue(1); f.session.playback('started'); }
  f.sent.length = 0;
  f.session.updateContext({ state: { inspection: 'Inspection not completed.' }, events: [{ id: 'first', text: 'The warden knocked.' }] });
  f.session.updateInstructions('Official\n\nThe inspection is pending.');
  f.session.scene({ id: 'knock-after-reply', kind: 'knock' });
  if (source === 'delegation') f.session.resolveDelegation(f.request(), { text: 'You have refused the correction.' });
  else { const variables = replyVariables(); f.session.scene(savedReply(() => variables)); }
  f.session.sourceActivity(false);
  if (source === 'typed') { f.session.avatarQueue(0); f.session.playback('stopped'); }
  t.mock.timers.tick(700);
  assert.deepEqual(f.sent.map(e => e.type), ['session.instructions.append']);
  assert.equal(replyText(f.sent[0]), 'You have refused the correction.');
  // Later snapshots may omit earlier events, but deferred history cannot vanish.
  f.session.updateContext({ state: { inspection: 'Inspection awaiting the resident.' }, events: [{ id: 'second', text: 'The resident returned to view.' }] });
  f.session.updateInstructions('Official\n\nThe inspection is pending.\n\nKeep the doorway in view.');
  f.session.sourceActivity(true); f.session.avatarQueue(1); f.session.playback('started');
  assert.equal(f.sent.length, 1);
  f.session.sourceActivity(false); f.session.avatarQueue(0); f.session.playback('stopped'); t.mock.timers.tick(700);
  const physical = f.sent.slice(1).map(e => e.content).join('');
  assert.match(physical, /A knock sounded/);
  assert.doesNotMatch(physical, /Inspection awaiting|The warden knocked|The inspection is pending|Keep the doorway/);
  const physicalEnd = f.sent.length;
  f.session.sourceActivity(true); f.session.avatarQueue(1); f.session.playback('started');
  f.session.sourceActivity(false); f.session.avatarQueue(0); f.session.playback('stopped'); t.mock.timers.tick(700);
  const later = f.sent.slice(physicalEnd).map(e => e.content).join('\n');
  assert.match(later, /Inspection awaiting the resident/); assert.doesNotMatch(later, /Inspection not completed/);
  assert.equal((later.match(/The warden knocked/g) ?? []).length, 1);
  assert.equal((later.match(/The resident returned to view/g) ?? []).length, 1);
  assert.match(later, /The inspection is pending/); assert.match(later, /Keep the doorway in view/);
  assert.equal(f.sent.filter(e => isReplyAppend(e)).length, 1);
  assert.equal(f.allowed.at(-1), false, 'metadata drains after every queued performance with output closed');
  f.session.close();
});

test('a committed work announcement explicitly releases entry silence for one quoted performance', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = worldFixture('silent');
  const variables = () => ({
    'unperson-state': { phase: 'conceal' }, 'unperson-work-enabled': true,
    'unperson-room': { version: 1, attempt: 'a', clock: 1, events: [
      { id: 'filed-original', attempt: 'a', at: 0, kind: 'work', actor: 'resident', visibility: 'public',
        data: { document: 'correction-14', action: 'submit', edition: 'original' } },
    ] },
  });
  const notice = hydrateVoiceSceneNotice({ id: 'filed-original', kind: 'bulletin' }, variables(), [], '78.0.0', variables);
  assert.ok(notice?.kind === 'bulletin'); f.sent.length = 0;
  f.session.scene(notice); f.session.scene(notice);
  const instruction = f.sent.map(e => e.content).join('');
  assert.match(instruction, /For this reply only, override the connection-entry silence/);
  assert.equal(JSON.parse(instruction.split('Reply JSON:\n')[1]), notice.text);
  assert.equal((instruction.match(/For this reply only,/g) ?? []).length, 1);
  assert.equal(f.inputs.at(-1), false, 'The automatic announcement still reserves the protected speech floor.');
  assert.equal(f.allowed.at(-1), true);
  f.session.sourceActivity(true); f.session.avatarQueue(1); f.session.playback('started');
  t.mock.timers.tick(9000);
  assert.equal(f.errors.length, 0, 'A started announcement must not expire as a missing onset.');
  f.session.sourceActivity(false); f.session.avatarQueue(0); f.session.playback('stopped'); t.mock.timers.tick(700);
  assert.equal(f.inputs.at(-1), true); assert.equal(f.allowed.at(-1), false);
  f.session.close();
});

test('committed physical performances get isolated handoffs before deferred native status and direction', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = worldFixture();
  f.session.sourceActivity(true); f.session.avatarQueue(1); f.session.playback('started'); f.sent.length = 0;
  f.session.updateContext({ state: { inspection: 'Inspection not completed.' }, events: [{ id: 'entered', text: 'Officers entered the room.' }] });
  f.session.updateInstructions('Official\n\nThe inspection is pending.');
  const announcement = 'The physical search is complete. Remain for the decision. No household clearance has been granted.';
  f.session.scene({ id: 'physical-search-complete', kind: 'bulletin', text: announcement });
  f.session.scene({ id: 'later-knock', kind: 'knock' });
  f.session.sourceActivity(false); f.session.avatarQueue(0); f.session.playback('stopped'); t.mock.timers.tick(700);
  const first = f.sent.map(e => e.content).join('');
  assert.match(first, /The physical search is complete/);
  assert.doesNotMatch(first, /Inspection not completed|Officers entered|The inspection is pending|A knock sounded/);
  assert.equal(f.sent.some(e => e.type === 'session.thinking.append'), false);
  assert.equal(f.allowed.at(-1), true);
  const firstEnd = f.sent.length;
  f.session.updateContext({ state: { inspection: 'Physical search completed.' }, events: [{ id: 'search-done', text: 'The physical search was completed.' }] });
  f.session.sourceActivity(true); f.session.avatarQueue(1); f.session.playback('started');
  f.session.receive({ type: 'session.output_transcript.delta', delta: announcement });
  f.session.sourceActivity(false); t.mock.timers.tick(2000);
  assert.equal(f.sent.length, firstEnd, 'source quiet and captions cannot drain metadata over the avatar');
  f.session.avatarQueue(0); f.session.playback('stopped'); t.mock.timers.tick(700);
  const second = f.sent.slice(firstEnd).map(e => e.content).join('');
  assert.match(second, /A knock sounded/); assert.doesNotMatch(second, /Physical search completed|Officers entered|The inspection is pending/);
  const secondEnd = f.sent.length;
  f.session.sourceActivity(true); f.session.avatarQueue(1); f.session.playback('started');
  f.session.sourceActivity(false); f.session.avatarQueue(0); f.session.playback('stopped'); t.mock.timers.tick(700);
  const metadata = f.sent.slice(secondEnd).map(e => e.content).join('\n');
  assert.match(metadata, /Physical search completed/); assert.doesNotMatch(metadata, /Inspection not completed/);
  assert.equal((metadata.match(/Officers entered the room/g) ?? []).length, 1);
  assert.equal((metadata.match(/The physical search was completed/g) ?? []).length, 1);
  assert.match(metadata, /The inspection is pending/);
  assert.equal(f.allowed.at(-1), false); f.session.close();
});

test('live work receipt expires behind active playback when the attempt changes', t => {
  t.mock.timers.enable({apis:['setTimeout']});const sent:any[]=[];
  const s=new LiveVoiceSession({send:e=>sent.push(e),emit(){},input(){},interruptAudio(){},fail(){}},'Official','Known resident.','manual');
  let attempt='a';const variables=()=>({'unperson-room':{version:1,attempt,clock:1,events:[{id:'work',attempt:'a',at:0,kind:'work',actor:'resident',visibility:'public',data:{document:'correction-14',action:'submit',edition:'original'}}]},'unperson-state':{phase:'conceal'},'unperson-work-enabled':true});
  s.receive({type:'session.started'});s.start();sent.length=0;s.sourceActivity(true);
  const notice=hydrateVoiceSceneNotice({id:'work',kind:'bulletin'},variables(),[],undefined,variables);assert.ok(notice);s.scene(notice);
  attempt='b';s.sourceActivity(false);t.mock.timers.tick(1000);
  assert.doesNotMatch(sent.map(e=>e.content??'').join(''),/Fourteen|entry I ordered withdrawn/);s.close();
});

test('structured context keeps a full reconnect snapshot but sends only changed facts and new events in a call', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const sent:any[]=[];
  const initial={state:{identity:'Known resident 6079.',sight:'Resident in view.'},events:[{id:'knock-1',text:'The door was knocked.'}]};
  assert.equal(voiceStartContextError('Official',initial),null);
  assert.match(composeVoiceInstructions('Official',initial as any),/Known resident 6079[\s\S]*The door was knocked/);
  const s=new LiveVoiceSession({send:e=>sent.push(e),emit(){},input(){},interruptAudio(){},fail(){}},'Official',initial as any,'manual');
  s.receive({type:'session.started'});s.start();sent.length=0;
  s.updateContext({...initial,state:{...initial.state,sight:'Resident behind the partition.'},events:[...initial.events,{id:'paper-1',text:'An exposed photograph was seen.'}]} as any);
  const first=sent.map(e=>e.content).join('');
  assert.match(first,/Resident behind the partition/);assert.match(first,/exposed photograph/);
  assert.doesNotMatch(first,/Known resident|door was knocked|Resident in view/);
  sent.length=0;
  s.sourceActivity(true);
  s.updateContext({...initial,state:{...initial.state,sight:'Resident at the door.'}} as any);
  s.updateContext({...initial,state:{...initial.state,sight:'Resident in view.'}} as any);
  assert.equal(sent.length,0);
  s.sourceActivity(false);t.mock.timers.tick(700);
  const latest=sent.map(e=>e.content).join('');
  assert.match(latest,/Resident in view/);assert.doesNotMatch(latest,/at the door|door was knocked/);
  s.close();
});

test('quiet-boundary coalescing keeps every unseen event even if later history budgeting omits it', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const sent: any[] = [];
  const initial = {state:{sight:'In view.'},events:[]};
  const s = new LiveVoiceSession({send:e=>sent.push(e),emit(){},input(){},interruptAudio(){},fail(){}}, 'Official', initial, 'manual');
  s.receive({type:'session.started'});s.start();sent.length=0;s.sourceActivity(true);
  s.updateContext({state:{sight:'By the door.'},events:[{id:'photo',text:'An exposed photograph was seen.'}]});
  s.updateContext({state:{sight:'Behind the partition.'},events:[{id:'writing',text:'Writing was seen.'}]});
  assert.equal(sent.length,0);
  s.sourceActivity(false);t.mock.timers.tick(700);
  const content=sent.map(e=>e.content).join('\n');
  assert.match(content,/exposed photograph/);assert.match(content,/Writing was seen/);
  assert.match(content,/Behind the partition/);assert.doesNotMatch(content,/By the door/);
  s.close();
});

test('shortening or citing an immutable event does not replay it to the live actor', () => {
  const sent: any[] = [];
  const initial = {state:{sight:'In view.'},events:[{id:'speech-1',text:'Resident said: My mother lived here before the register changed.'}]};
  const s = new LiveVoiceSession({send:e=>sent.push(e),emit(){},input(){},interruptAudio(){},fail(){}}, 'Official', initial, 'manual');
  s.receive({type:'session.started'});s.start();sent.length=0;
  s.updateContext({...initial,events:[{id:'speech-1',text:'Cited testimony: My mother lived here…'}]});
  assert.equal(sent.length,0);
  s.updateContext({...initial,events:[{id:'speech-2',text:'Resident said: My mother lived here before the register changed.'}]});
  assert.equal(sent.filter(e=>e.type==='session.thinking.append').length,1,'A second real utterance has a distinct ID even if the words repeat.');
  s.close();
});

test('context packets preserve text and prefer whole word boundaries across multilingual content',()=>{
  const f=fixture();f.sent.length=0;
  const content='The officer watches the doorway. '.repeat(35)+'居民仍在房间。'.repeat(45)+' End of observation.';
  f.session.updateContext(content);
  const packets=f.sent.filter(e=>e.type==='session.thinking.append').map(e=>e.content as string);
  const combined=packets.join('');assert.ok(combined.endsWith(content));
  for(const packet of packets)assert.ok(new TextEncoder().encode(packet).length<=480);
  for(let i=1;i<packets.length;i++)assert.ok(!(/[A-Za-z]$/.test(packets[i-1])&&/^[A-Za-z]/.test(packets[i])),'An ordinary English word must not be split between appends.');
  f.session.close();
});

function fixture() {
  const sent: any[] = [], events: any[] = [], input: boolean[] = [], interrupted: string[] = [], errors: string[] = [];
  const session = new LiveVoiceSession({ send: e => sent.push(e), emit: e => events.push(e), input: enabled => input.push(enabled), interruptAudio: () => interrupted.push("explicit"), fail: message => errors.push(message) }, "Known resident 6079", "Desk visible", "manual");
  session.receive({ type: "session.started", session: { model: "gpt-live-1" } }); session.start();
  return { session, sent, events, input, interrupted, errors };
}

test('adding phase direction sends the new complete block without replaying the live character prompt', () => {
  const sent: any[] = [];
  const character = 'You are the domestic telescreen. Only public observations are evidence.\n\n[voice; system-presets ]\nSpeak in restrained British authority. Leave room for the resident to answer.\n\n[voice; examples ]\nThe register already identifies the resident. Ask them to affirm it.';
  const clearance = '[voice; examples ]\nCommitted household clearance: “The household is accounted for. Proceed to work.” Then stop. Current police intervention overrides earlier clearance; door certification remains a physical action.';
  const s = new LiveVoiceSession({send:e=>sent.push(e),emit(){},input(){},interruptAudio(){},fail(){}}, character, '', 'manual');
  s.receive({type:'session.started'}); s.start(); sent.length = 0;
  s.updateInstructions(character + '\n\n' + clearance);
  assert.equal(sent.length, 1, 'the complete clearance block fits in one append');
  assert.equal(sent[0].type, 'session.instructions.append');
  assert.equal(sent[0].content.trim(), clearance);
  assert.doesNotMatch(sent[0].content, /Speak in restrained|Ask them to affirm/);
  s.close();
});

test('queued instruction changes compare with delivered direction, retaining additions but omitting cancelled changes', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const f = fixture(); const base = 'Known resident 6079'; f.sent.length = 0;
  f.session.sourceActivity(true);
  f.session.updateInstructions(base + '\n\nTemporary direction.');
  f.session.updateInstructions(base);
  f.session.sourceActivity(false); t.mock.timers.tick(700);
  assert.equal(f.sent.length, 0, 'reverting an unsent update must not replay the original prompt');
  f.session.sourceActivity(true);
  f.session.updateInstructions(base + '\n\nThe check is complete.');
  f.session.updateInstructions(base + '\n\nThe check is complete.\n\nLeave room for the resident to answer.');
  assert.equal(f.sent.length, 0);
  f.session.sourceActivity(false); t.mock.timers.tick(700);
  const content = f.sent.map(e=>e.content).join('');
  assert.match(content, /The check is complete/); assert.match(content, /Leave room/);
  assert.doesNotMatch(content, /Known resident|Temporary direction/);
  f.session.close();
});

test('rewriting or removing direction still sends the full current prompt; an inline suffix is not a new block', () => {
  const f = fixture(); f.sent.length = 0;
  f.session.updateInstructions('Known resident 6079 is on duty.');
  assert.equal(f.sent.map(e=>e.content).join(''), 'Known resident 6079 is on duty.');
  f.sent.length = 0;
  f.session.updateInstructions('Known resident 6079');
  assert.equal(f.sent.map(e=>e.content).join(''), 'Known resident 6079');
  f.session.close();
});

test('an early model reply waits for the resident to finish before protecting the microphone', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const input: boolean[] = [], held: boolean[] = [];
  const s = new LiveVoiceSession({send(){},emit(){},input:v=>input.push(v),holdAudio:v=>held.push(v),interruptAudio(){},fail(){}}, 'Official', '', 'manual');
  s.receive({type:'session.started'});s.start();
  s.inputLevel(.15);s.sourceActivity(true);
  assert.equal(held.at(-1),true);assert.equal(input.at(-1),true);
  t.mock.timers.tick(400);s.inputLevel(.2);t.mock.timers.tick(400);
  assert.equal(input.at(-1),true,'the remainder of the same utterance must reach the model');
  t.mock.timers.tick(850);
  assert.equal(input.at(-1),false);assert.equal(held.at(-1),false);
  s.close();
});

test('a natural pause between clauses does not clip the second half of resident speech', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const input: boolean[] = [], held: boolean[] = [];
  const s = new LiveVoiceSession({send(){},emit(){},input:v=>input.push(v),holdAudio:v=>held.push(v),interruptAudio(){},fail(){}},'Official','','manual');
  s.receive({type:'session.started'});s.start();s.inputLevel(.15);s.sourceActivity(true);
  t.mock.timers.tick(950);
  assert.equal(input.at(-1),true,'a 950 ms clause pause is not the end of the utterance');
  s.inputLevel(.15);t.mock.timers.tick(1199);assert.equal(input.at(-1),true);
  t.mock.timers.tick(1);assert.equal(input.at(-1),false);assert.equal(held.at(-1),false);s.close();
});

test('a long resident sentence discards speculative output rather than cutting microphone capture', t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const input:boolean[]=[],discarded:string[]=[];
  const s=new LiveVoiceSession({send(){},emit(){},input:v=>input.push(v),holdAudio(){},interruptAudio:()=>discarded.push('unsent'),fail(){}},'Official','','manual');
  s.receive({type:'session.started'});s.start();s.inputLevel(.1);s.sourceActivity(true);
  for(let n=0;n<21;n++){t.mock.timers.tick(500);s.inputLevel(.1);}
  assert.equal(input.at(-1),true);assert.deepEqual(discarded,['unsent']);s.close();
});

test("a rejected scene update does not disconnect a running Live conversation", () => {
  const f = fixture();
  f.session.receive({ type: "error", error: { code: "immutable_field_update", message: "Private provider internals", client_event_id: "update-1" } });
  assert.deepEqual(f.errors, []);
  assert.equal(f.sent.some(e => e.type === "session.close"), false);
  assert.ok(f.events.some(e => e.type === "input-hint"));
  assert.doesNotMatch(JSON.stringify(f.events), /Private provider internals/);
  f.session.sourceActivity(true); assert.equal(f.input.at(-1), false); f.session.close();
});

test("one finished segment cannot release capture while another avatar segment is queued", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture();
  f.session.avatarQueue(2); f.session.playback("started");
  f.session.playback("stopped"); f.session.avatarQueue(1); t.mock.timers.tick(700);
  assert.equal(f.input.at(-1), false);
  f.session.playback("started"); f.session.playback("stopped"); f.session.avatarQueue(0);
  t.mock.timers.tick(700); assert.equal(f.input.at(-1), true); f.session.close();
});
test("Live protects mic through source audio, avatar buffering and the acoustic tail", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture();
  f.session.sourceActivity(true); f.session.avatarPending(); f.session.playback("started");
  assert.equal(f.input.at(-1), false);
  f.session.receive({ type: "session.input_transcript.delta", delta: "speaker echo", start_ms: 1, end_ms: 200 });
  assert.equal(f.interrupted.length, 0, "a microphone event cannot cancel speech");
  f.session.sourceActivity(false); t.mock.timers.tick(1000);
  assert.equal(f.input.at(-1), false, "avatar can still be playing after source quiet");
  f.session.playback("stopped"); t.mock.timers.tick(700);
  assert.equal(f.input.at(-1), true);
  f.session.close();
});

test("Live saves delayed recognition of words captured before output began", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture();
  f.session.receive({ type: "session.input_transcript.delta", delta: "I work", start_ms: 0, end_ms: 400 });
  f.session.sourceActivity(true); f.session.playback("started");
  f.session.receive({ type: "session.input_transcript.delta", delta: " in Records.", start_ms: 400, end_ms: 1000 });
  t.mock.timers.tick(1500);
  assert.equal(f.events.find(e => e.type === "transcript" && e.final && e.role === "user")?.text, "I work in Records.");
  assert.equal(f.input.at(-1), false); assert.equal(f.interrupted.length, 0); f.session.close();
});

test("resuming after output mute allows a queued physical scene without requiring speech", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture();
  f.session.sourceActivity(true); f.session.playback("started");
  f.session.setMuted({ input: true, output: true });
  f.session.scene({ id: "resume-knock", kind: "knock" }); t.mock.timers.tick(700);
  f.session.setMuted({ input: false, output: false });
  assert.ok(f.sent.some(e => e.content?.includes("knock"))); f.session.close();
});

test('muting output cancels audio without inventing a resident interruption', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture();
  f.session.sourceActivity(true); f.session.playback('started');
  const before = f.sent.length;
  f.session.setMuted({ input: true, output: true });
  assert.equal(f.interrupted.length, 1, 'muted audio must not keep playing');
  assert.doesNotMatch(JSON.stringify(f.sent.slice(before)), /resident deliberately took the floor/);
  f.session.receive({ type: 'session.output_transcript.delta', delta: 'stale muted speech' });
  assert.equal(f.events.some(e => e.text?.includes('stale muted')), false);
  t.mock.timers.tick(700); assert.equal(f.input.at(-1), false);
  f.session.setMuted({ input: false, output: true });
  f.session.sourceActivity(true); f.session.avatarQueue(1); f.session.playback('started');
  assert.equal(f.input.at(-1), true, 'inaudible late PCM cannot take the microphone floor');
  assert.notEqual(f.events.at(-1)?.status, 'thinking');
  f.session.setMuted({ input: false, output: false });
  assert.equal(f.input.at(-1), false, 'unmuting current playback protects capture before speakers reopen');
  f.session.sourceActivity(false);f.session.avatarQueue(0);f.session.playback('stopped');t.mock.timers.tick(700);
  assert.equal(f.input.at(-1), true); f.session.close();
});
test("Live keeps quiet context and scene updates from cutting active speech", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture();
  f.session.sourceActivity(true); f.session.playback("started");
  const before = f.sent.length;
  f.session.updateContext("Officers at the door.");
  f.session.scene({ id: "knock-1", kind: "knock" });
  f.session.updateInstructions("Updated direction.");
  assert.equal(f.sent.length, before);
  f.session.sourceActivity(false); f.session.playback("stopped"); t.mock.timers.tick(700);
  assert.ok(f.sent.some(e => e.type === "session.thinking.append" && e.content.includes("Officers")));
  assert.ok(f.sent.some(e => e.type === "session.instructions.append" && e.content.includes("knock")));
  assert.equal(f.interrupted.length, 0); f.session.close();
});
test("only deliberate interruption discards audio and yields the floor", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture();
  f.session.sourceActivity(true); f.session.playback("started"); f.session.interrupt();
  assert.equal(f.interrupted.length, 1); t.mock.timers.tick(700);
  assert.equal(f.input.at(-1), true);
  assert.ok(f.sent.at(-1).content.includes("Stop speaking"));
  f.session.receive({ type: "session.output_transcript.delta", delta: "abandoned tail", start_ms: 4, end_ms: 8 });
  assert.equal(f.events.some(e => e.text?.includes("abandoned")), false);
  f.session.receive({ type: "session.input_transcript.delta", delta: "I disagree.", start_ms: 10, end_ms: 500 });
  t.mock.timers.tick(1500);
  assert.ok(f.events.some(e => e.type === "transcript" && e.final && e.text === "I disagree."));
  f.session.close();
});
test("Live preserves both transcript streams and deduplicates provider events", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture();
  const first = { type: "session.input_transcript.delta", event_id: "u1", delta: "My mother", start_ms: 0, end_ms: 400 };
  f.session.receive(first); f.session.receive(first);
  f.session.receive({ type: first.type, event_id: "u2", delta: " lived here.", start_ms: 400, end_ms: 1000 });
  t.mock.timers.tick(1500);
  assert.equal(f.events.filter(e => e.type === "transcript" && e.final).length, 1);
  assert.equal(f.events.find(e => e.type === "transcript" && e.final).text, "My mother lived here.");
  f.session.close(); t.mock.timers.tick(10000);
  assert.equal(f.sent.at(-1).type, "session.close");
});
