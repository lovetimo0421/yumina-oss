import test from "node:test";
import assert from "node:assert/strict";
import { LiveVoiceSession } from "./live-voice-session";
import { composeVoiceInstructions, voiceStartContextError } from "../../../sandbox/voice-types";

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
