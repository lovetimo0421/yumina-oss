import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveVoiceSession } from './live-voice-session';

const isAppend = (event: any) => /^session\.(instructions|thinking|commentary)\.append$/.test(event.type);
const isReply = (event: any) => event.content?.startsWith('For this reply only,');
function fixture(world = true, immediate = false) {
  const sent: any[] = [], events: any[] = [], errors: string[] = [], inputs: boolean[] = [], allowed: boolean[] = [];
  const session = new LiveVoiceSession({
    send(event) {
      sent.push(event);
      if (event.type === 'session.input_audio.mute' || event.type === 'session.input_audio.unmute')
        session.receive({ type: event.type + 'd', client_event_id: event.event_id });
      if (immediate && isAppend(event)) session.receive({ type: event.type + 'ed', client_event_id: event.event_id });
    },
    emit: event => events.push(event), input: value => inputs.push(value), allowAudio: value => allowed.push(value),
    interruptAudio() { session.avatarQueue(0); }, fail: message => errors.push(message),
  }, 'Listen silently on reconnect.', '', 'manual', undefined, world, 'silent');
  session.receive({ type: 'session.started' }); session.start();
  const ack = (event: any) => session.receive({ type: event.type + 'ed', client_event_id: event.event_id });
  const reply = (id = 'saved') => session.scene({ id, kind: 'reply', text: 'That is the record, 6079.' });
  return { session, sent, events, errors, inputs, allowed, ack, reply };
}

test('approved replay waits for every startup/context ACK and requests immediate scoped speech', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(); t.after(() => f.session.close());
  f.session.updateContext('Current public room state.');
  f.session.updateInstructions('Fresh actor directions. '.repeat(80));
  const startup = f.sent.filter(isAppend); assert.ok(startup.length > 4);
  f.reply(); assert.equal(f.sent.some(isReply), false);
  for (const event of startup.slice(1).reverse()) f.ack(event);
  f.session.receive({ type: 'session.thinking.appended', client_event_id: startup[0].event_id });
  f.ack(startup[1]); assert.equal(f.sent.some(isReply), false, 'wrong-kind/duplicate ACKs cannot release the barrier');
  t.mock.timers.tick(4400); f.ack(startup[0]);
  const reply = f.sent.filter(isReply); assert.equal(reply.length, 1);
  assert.match(reply[0].content, /immediately/i);
  assert.match(reply[0].content, /silence|silent/i);
  assert.match(reply[0].content, /once|one time/);
  assert.equal(f.inputs.at(-1), false);
});

test('a committed follow-up releases silence with one complete speech cue', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(true, true);
  t.after(() => f.session.close());
  const line = 'You call it a shopping list. Why did you conceal it?';
  f.session.scene({ id: 'follow:public', kind: 'follow-up', evidenceId: 'speech:resident', line });
  const cues = f.sent.filter(isReply);
  assert.equal(cues.length, 1, 'committed question needs an explicit performance, not a scene description');
  assert.equal(JSON.parse(cues[0].content.split('Reply JSON:\n')[1]), line);
  assert.doesNotMatch(cues[0].content, /speech:resident|Fictional scene observation/);
  assert.equal(f.inputs.at(-1), false);
  f.session.sourceActivity(true);
  assert.equal(f.session.beforePlayback(), true);
  f.session.playback('started');
  t.mock.timers.tick(9000);
  assert.deepEqual(f.errors, [], 'valid playback owns the complete floor');
});

test('onset deadline starts at matching final performance ACK; timeout retires latent speech', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(); t.after(() => f.session.close());
  f.ack(f.sent.find(isAppend)); f.reply(); const performance = f.sent.filter(isAppend).slice(1);
  t.mock.timers.tick(7500); assert.equal(f.errors.length, 0);
  for (const event of performance) f.ack(event);
  t.mock.timers.tick(19500); assert.equal(f.errors.length, 0, 'send time is not acceptance time');
  f.ack(performance[0]); // A duplicate must not extend the deadline.
  t.mock.timers.tick(501);
  assert.equal(f.errors.length, 1); assert.match(f.errors[0], /Reconnect/);
  assert.equal(f.sent.filter(e => e.type === 'session.close').length, 1);
  assert.equal(f.inputs.at(-1), false); assert.equal(f.allowed.at(-1), false);
  const count = f.sent.length;
  f.session.updateContext('Later room event.'); f.reply('later'); f.ack(performance[0]);
  f.session.sourceActivity(true); f.session.receive({ type: 'session.output_transcript.delta', delta: 'That is the record' });
  assert.equal(f.session.beforePlayback(), false); assert.equal(f.sent.length, count);
  assert.equal(f.events.some(e => e.role === 'assistant'), false);
  t.mock.timers.tick(30000); assert.equal(f.errors.length, 1);
});

test('a cold live response has time to reach the buffered avatar without cancelling its first word', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(true, true); t.after(() => f.session.close());
  f.reply();
  t.mock.timers.tick(8900);
  f.session.receive({ type: 'session.output_transcript.delta', delta: '6079.' });
  f.session.sourceActivity(true);
  f.session.avatarQueue(1);
  t.mock.timers.tick(3500);
  assert.deepEqual(f.errors, [], 'Observed cold response latency plus avatar buffering must not close the live call');
  assert.equal(f.inputs.at(-1), false, 'Capture stays protected through avatar buffering');
  assert.equal(f.session.beforePlayback(), true);
  f.session.playback('started');
  t.mock.timers.tick(21000);
  assert.deepEqual(f.errors, [], 'Playback cancels the bounded startup deadline');
});

for (const stage of ['startup', 'performance'] as const) test(`missing ${stage} ACK has a bounded wait and closes the call`, t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(); t.after(() => f.session.close());
  if (stage === 'performance') f.ack(f.sent.find(isAppend));
  f.reply(); t.mock.timers.tick(8001);
  assert.equal(f.errors.length, 1); assert.equal(f.sent.at(-1).type, 'session.close');
  assert.equal(f.inputs.at(-1), false); assert.equal(f.session.beforePlayback(), false);
});

for (const before of [true, false]) test(`rejected startup update ${before ? 'before' : 'during'} replay prevents performance`, t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(); t.after(() => f.session.close());
  const startup = f.sent.find(isAppend);
  if (!before) f.reply();
  f.session.receive({ type: 'error', error: { client_event_id: startup.event_id, message: 'Private provider detail' } });
  if (before) f.reply();
  assert.equal(f.sent.some(isReply), false); assert.equal(f.errors.length, 1);
  assert.doesNotMatch(f.errors[0], /Private/); assert.equal(f.sent.at(-1).type, 'session.close');
});

test('closing a pending connection cancels ACK waits and cannot affect its replacement', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const old = fixture(); old.reply(); old.session.close();
  const next = fixture(); t.after(() => next.session.close()); next.ack(next.sent.find(isAppend)); next.reply();
  for (const event of next.sent.filter(isAppend)) next.ack(event);
  next.session.sourceActivity(true); assert.equal(next.session.beforePlayback(), true); next.session.playback('started');
  old.ack(old.sent.find(isAppend)); t.mock.timers.tick(20000);
  assert.equal(old.sent.some(isReply), false); assert.equal(old.errors.length, 0); assert.equal(next.errors.length, 0);
});

test('authority is rechecked after the startup barrier, before sending saved words', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(); t.after(() => f.session.close());
  f.reply(); f.session.updateContext({ state: { sight: 'resident no longer visible' }, events: [] });
  f.ack(f.sent.find(isAppend)); t.mock.timers.tick(700);
  assert.equal(f.sent.some(isReply), false); assert.equal(f.errors.length, 0);
});

for (const accepted of [false, true]) for (const cancel of ['interrupt', 'output-mute', 'new-words', 'authority'] as const) test(`${accepted ? 'accepted' : 'unacknowledged'} unstarted reply cannot survive ${cancel}`, t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(true, accepted); t.after(() => f.session.close());
  if (!accepted) f.ack(f.sent.find(isAppend));
  f.reply(); assert.ok(f.sent.some(isReply));
  if (cancel === 'interrupt') f.session.interrupt();
  if (cancel === 'output-mute') f.session.setMuted({ input: false, output: true });
  if (cancel === 'new-words') f.session.receive({ type: 'session.input_transcript.delta', delta: 'Wait, I changed my mind.' });
  if (cancel === 'authority') { f.session.updateContext({ state: { sight: 'resident moved out of view' }, events: [] }); f.session.sourceActivity(true); }
  assert.equal(f.errors.length, 1); assert.equal(f.sent.at(-1).type, 'session.close');
  if (cancel === 'new-words') assert.ok(f.events.some(e => e.role === 'user' && e.final && e.text === 'Wait, I changed my mind.'));
  const count = f.sent.length; for (const event of f.sent.filter(isAppend)) f.ack(event);
  f.reply('next'); t.mock.timers.tick(20000);
  assert.equal(f.sent.length, count); assert.equal(f.session.beforePlayback(), false); assert.equal(f.errors.length, 1);
});

test('immediate multi-packet ACKs do not start an orphan timer after audio has begun', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(true, true); t.after(() => f.session.close());
  f.session.scene({ id: 'long', kind: 'reply', text: 'Approved words. '.repeat(70) });
  assert.ok(f.sent.filter(isAppend).length > 3);
  f.session.sourceActivity(true); assert.equal(f.session.beforePlayback(), true); f.session.playback('started');
  f.session.updateContext({ state: { sight: 'resident moved during audible words' }, events: [] });
  t.mock.timers.tick(20000); assert.equal(f.errors.length, 0);
});

test('the recorded three-sentence answer is one complete speech instruction', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(true, true); t.after(() => f.session.close());
  const text = 'A shopping list on the staff register, 6079? The entry you returned is the name I ordered withdrawn. Turn the photograph towards the screen.';
  const before = f.sent.length; f.session.scene({ id: 'shopping', kind: 'reply', text });
  const speech = f.sent.slice(before).filter(isAppend);
  assert.equal(speech.length, 1, 'A continuation instruction must not interrupt the first sentence.');
  assert.equal(JSON.parse(speech[0].content.split('Reply JSON:\n')[1]), text);
  assert.ok(new TextEncoder().encode(speech[0].content).length <= 480);
});

test('long dialogue is fully staged and acknowledged before a single speaking cue', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(); t.after(() => f.session.close());
  f.ack(f.sent.find(isAppend)); const before = f.sent.length;
  const text = 'The resident remembers the name. '.repeat(45) + '居民仍在房间。'.repeat(8);
  f.session.scene({ id: 'long', kind: 'reply', text });
  const staged = f.sent.slice(before).filter(isAppend);
  assert.ok(staged.length > 2);
  assert.ok(staged.every(e => e.type === 'session.thinking.append'));
  const data = staged.map(e => e.content).join('');
  assert.equal(JSON.parse(data.split('Reply JSON:\n')[1]), text);
  assert.equal(f.allowed.at(-1), false, 'Staging is never audible speech authorization.');
  for (const event of staged.slice(1).reverse()) f.ack(event);
  assert.equal(f.sent.some(isReply), false);
  f.ack(staged[0]); const cues = f.sent.filter(isReply);
  assert.equal(cues.length, 1); assert.match(cues[0].content, /approved-reply-\d+/);
  assert.equal(f.allowed.at(-1), true);
  for (const event of f.sent.filter(isAppend)) assert.ok(new TextEncoder().encode(event.content).length <= 480);
  f.ack(cues[0]); f.session.sourceActivity(true); assert.equal(f.session.beforePlayback(), true);
  f.session.playback('started'); t.mock.timers.tick(9000); assert.deepEqual(f.errors, []);
});

test('superseding a staged reply cannot release its old speaking cue after late acknowledgments', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(); t.after(() => f.session.close());
  f.ack(f.sent.find(isAppend)); const before = f.sent.length;
  f.session.scene({ id: 'old', kind: 'reply', text: 'An old answer. '.repeat(90) });
  const staged = f.sent.slice(before).filter(isAppend);
  f.session.scene({ id: 'new', kind: 'reply', text: 'The corrected answer.' });
  for (const event of staged) f.ack(event);
  const cues = f.sent.filter(isReply); assert.equal(cues.length, 1);
  assert.equal(JSON.parse(cues[0].content.split('Reply JSON:\n')[1]), 'The corrected answer.');
  assert.doesNotMatch(cues[0].content, /approved-reply-|old answer/);
});

test('native conversation does not wait for context ACKs to deliver its ordinary scene', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(false); t.after(() => f.session.close());
  f.session.scene({ id: 'knock', kind: 'knock' });
  assert.ok(f.sent.some(e => e.content?.includes('knock'))); t.mock.timers.tick(9000);
  assert.equal(f.errors.length, 0);
});

test('transient source audio across the final ACK cannot substitute for avatar onset', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(); t.after(() => f.session.close());
  f.ack(f.sent.find(isAppend)); f.reply();
  f.session.sourceActivity(true);
  for (const event of f.sent.filter(isAppend)) f.ack(event);
  f.session.sourceActivity(false); t.mock.timers.tick(700);
  assert.equal(f.inputs.at(-1), false, 'the handoff still owns capture until actual playback');
  t.mock.timers.tick(19301);
  assert.equal(f.errors.length, 1); assert.equal(f.session.beforePlayback(), false);
});
