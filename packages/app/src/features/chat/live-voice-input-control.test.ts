import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveVoiceSession } from './live-voice-session';
import { hydrateVoiceSceneNotice, bindVoiceReplyAuthority } from './voice-scene-notice';

const isReplyAppend = (event: any) => event.type === 'session.instructions.append' && event.content?.startsWith('For this reply only,');
function fixture(mode: 'manual' | 'automatic' = 'manual', world = true) {
  const sent: any[] = [], input: boolean[] = [], held: boolean[] = [], allowed: boolean[] = [], events: any[] = [], errors: string[] = [];
  let interrupts = 0;
  const session = new LiveVoiceSession({ send: e => {
    sent.push(e);
    if (/^session\.(instructions|thinking|commentary)\.append$/.test(String(e.type))) session.receive({ type: e.type + 'ed', client_event_id: e.event_id });
  }, input: v => input.push(v), holdAudio: v => held.push(v),
    allowAudio: v => allowed.push(v), emit: e => events.push(e), interruptAudio: () => { interrupts++; }, fail: e => errors.push(e) },
  'Official', '', mode, undefined, world, 'silent');
  session.receive({ type: 'session.started' }); session.start();
  const commands = () => sent.filter(e => /^session\.input_audio\./.test(e.type));
  const ack = (command = commands().at(-1)) => session.receive({ type: command.type === 'session.input_audio.mute' ? 'session.input_audio.muted' : 'session.input_audio.unmuted', client_event_id: command.event_id });
  return { session, sent, input, held, allowed, events, errors, commands, ack, interrupts: () => interrupts };
}

test('manual approved scene waits for correlated provider mute; capture opens only after unmute acknowledgment', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(); t.after(() => f.session.close());
  f.session.scene({ id: 'knock', kind: 'knock' });
  assert.equal(f.input.at(-1), false);
  assert.equal(f.commands().at(-1)?.type, 'session.input_audio.mute');
  assert.equal(f.sent.some(e => e.content?.includes('knock')), false);
  assert.equal(f.allowed.at(-1), false, 'speculative PCM remains excluded while mute is pending');
  f.session.receive({ type: 'session.input_audio.muted', client_event_id: 'unrelated' });
  assert.equal(f.sent.some(e => e.content?.includes('knock')), false);
  f.ack(); assert.ok(f.sent.some(e => e.content?.includes('knock'))); assert.equal(f.allowed.at(-1), true);
  f.session.sourceActivity(true); f.session.avatarQueue(2); f.session.playback('started');
  f.session.sourceActivity(false); f.session.avatarQueue(1); f.session.playback('stopped'); t.mock.timers.tick(700);
  assert.equal(f.commands().length, 1, 'source quiet does not finish queued avatar speech');
  f.session.avatarQueue(0); t.mock.timers.tick(700);
  assert.equal(f.commands().at(-1)?.type, 'session.input_audio.unmute'); assert.equal(f.input.at(-1), false);
  f.session.receive({ type: 'session.input_audio.unmuted', client_event_id: f.commands()[0].event_id });
  assert.equal(f.input.at(-1), false);
  f.ack(); assert.equal(f.input.at(-1), true);
});

test('a saved answer cannot replace a committed bulletin awaiting provider mute acknowledgment', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(); t.after(() => f.session.close());
  const variables = () => ({ 'unperson-state': { phase: 'conceal' }, 'unperson-work-enabled': true,
    'unperson-room': { version: 1, attempt: 'a', clock: 3, events: [
      { id: 'work', attempt: 'a', at: 0, kind: 'work', actor: 'resident', visibility: 'public',
        data: { document: 'correction-14', action: 'submit', edition: 'original' } },
      { id: 'typed', attempt: 'a', at: 1, kind: 'speech', actor: 'resident', visibility: 'public',
        data: { role: 'user', text: 'I remember her.', source: 'typed', delivery: 'received' } },
      { id: 'saved', attempt: 'a', at: 2, kind: 'speech', actor: 'screen', visibility: 'public',
        data: { role: 'assistant', text: 'Your recollection is recorded.', source: 'generated', delivery: 'generated' } },
    ] } });
  const bulletin = hydrateVoiceSceneNotice({ id: 'work', kind: 'bulletin' }, variables(), [], '78.0.0', variables);
  const reply = hydrateVoiceSceneNotice({ id: 'saved', kind: 'reply' }, variables(), [], '78.0.0', variables);
  assert.ok(bulletin?.kind === 'bulletin'); assert.ok(reply?.kind === 'reply');
  f.session.scene(bulletin); f.session.scene(reply);
  assert.equal(f.sent.some(isReplyAppend), false);
  f.ack();
  const spoken = () => f.sent.filter(isReplyAppend).map(e => JSON.parse(e.content.split('Reply JSON:\n')[1]));
  assert.deepEqual(spoken(), [bulletin.text], 'The reserved public announcement must be delivered first.');
  f.session.sourceActivity(true); f.session.avatarQueue(1); f.session.playback('started');
  f.session.sourceActivity(false); f.session.avatarQueue(0); f.session.playback('stopped'); t.mock.timers.tick(700);
  f.ack(); f.ack();
  assert.deepEqual(spoken(), [bulletin.text, reply.text], 'The saved reply follows without losing or repeating either line.');
  assert.deepEqual(f.errors, []);
});

test('rapid mute reversals serialize commands and never reopen capture on stale acknowledgments', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(); t.after(() => f.session.close());
  f.session.setMuted({ input: true, output: false }); const mute = f.commands().at(-1);
  assert.ok(mute); f.session.setMuted({ input: false, output: false });
  assert.equal(f.commands().length, 1); assert.equal(f.input.at(-1), false);
  f.ack(mute); const unmute = f.commands().at(-1); assert.equal(unmute.type, 'session.input_audio.unmute');
  f.session.scene({ id: 'new-scene', kind: 'knock' });
  assert.equal(f.commands().length, 2); f.ack(mute); assert.equal(f.commands().length, 2);
  f.ack(unmute); assert.equal(f.commands().at(-1)?.type, 'session.input_audio.mute'); assert.equal(f.input.at(-1), false);
  assert.equal(f.sent.some(e => e.content?.includes('knock')), false); f.ack(); assert.ok(f.sent.some(e => e.content?.includes('knock')));
});

test('held native audio waits for the resident floor and provider acknowledgment before reaching the avatar', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture('manual', false); t.after(() => f.session.close());
  f.session.inputLevel(.2); f.session.sourceActivity(true);
  assert.equal(f.input.at(-1), true); assert.equal(f.held.at(-1), true); assert.equal(f.commands().length, 0);
  t.mock.timers.tick(1200);
  assert.equal(f.input.at(-1), false); assert.equal(f.held.at(-1), true);
  assert.equal(f.commands().at(-1)?.type, 'session.input_audio.mute'); f.ack(); assert.equal(f.held.at(-1), false);
});

for (const cancel of ['interrupt', 'output-mute', 'new-words', 'cancel-scene'] as const) test(`pending approved delivery is invalidated by ${cancel}`, t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(); t.after(() => f.session.close());
  f.session.scene({ id: 'knock', kind: 'knock' }); const mute = f.commands().at(-1); assert.ok(mute);
  if (cancel === 'interrupt') f.session.interrupt();
  if (cancel === 'output-mute') f.session.setMuted({ input: false, output: true });
  if (cancel === 'new-words') f.session.receive({ type: 'session.input_transcript.delta', delta: 'A new statement.' });
  if (cancel === 'cancel-scene') f.session.cancelScene('knock');
  f.ack(mute); t.mock.timers.tick(700);
  assert.equal(f.sent.some(e => e.content?.includes('knock')), false);
  assert.equal(f.input.at(-1), false); assert.equal(f.commands().at(-1)?.type, 'session.input_audio.unmute');
  f.ack(); assert.equal(f.input.at(-1), true);
  if (cancel === 'interrupt') {
    f.session.inputLevel(.1); f.session.receive({ type: 'session.input_transcript.delta', delta: 'My next words.' }); t.mock.timers.tick(1500);
    assert.ok(f.events.some(e => e.type === 'delegation'));
  }
});

for (const failure of ['timeout', 'rejected'] as const) test(`provider input ${failure} fails closed and cleanup rejects late acknowledgments`, t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(); t.after(() => f.session.close());
  f.session.scene({ id: 'knock', kind: 'knock' }); const mute = f.commands().at(-1); assert.ok(mute);
  if (failure === 'timeout') t.mock.timers.tick(8001);
  else f.session.receive({ type: 'error', error: { client_event_id: mute.event_id, message: 'Private provider detail' } });
  assert.equal(f.errors.length, 1); assert.match(f.errors[0], /microphone|input/i); assert.doesNotMatch(f.errors[0], /Private/);
  assert.equal(f.input.at(-1), false); assert.equal(f.sent.some(e => e.content?.includes('knock')), false);
  f.session.close(); const count = f.sent.length; f.ack(mute); t.mock.timers.tick(20000);
  assert.equal(f.sent.length, count); assert.equal(f.errors.length, 1); assert.equal(f.input.at(-1), false);
});

test('automatic mode retains continuous microphone capture without playback mute commands', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture('automatic'); t.after(() => f.session.close());
  f.session.scene({ id: 'knock', kind: 'knock' }); f.session.sourceActivity(true); f.session.playback('started');
  assert.equal(f.input.at(-1), true); assert.equal(f.commands().length, 0); assert.ok(f.sent.some(e => e.content?.includes('knock')));
});

test('room changes during provider acknowledgment expire an unsent saved reply', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(); t.after(() => f.session.close());
  let phase = 'find';
  const variables = () => ({ 'unperson-state': { phase }, 'unperson-room': { version: 1, attempt: 'a', clock: 2, events: [
    { id: 'typed', attempt: 'a', at: 0, kind: 'speech', actor: 'resident', visibility: 'public', data: { role: 'user', text: 'I refuse.', source: 'typed', delivery: 'received' } },
    { id: 'saved', attempt: 'a', at: 1, kind: 'speech', actor: 'screen', visibility: 'public', data: { role: 'assistant', text: 'Your refusal is recorded.', source: 'generated', delivery: 'generated' } },
  ] } });
  const notice = hydrateVoiceSceneNotice({ id: 'saved', kind: 'reply' }, variables(), [], '76.0.0', variables); assert.ok(notice);
  f.session.scene(notice); assert.equal(f.commands().at(-1)?.type, 'session.input_audio.mute');
  phase = 'conceal'; f.session.updateContext('The room phase changed.'); f.ack();
  assert.equal(f.sent.some(e => isReplyAppend(e)), false);
  assert.ok(f.events.some(e => e.type === 'input-hint' && e.message.includes('not spoken')));
  t.mock.timers.tick(700); f.ack(); assert.equal(f.input.at(-1), true);
});

for (const change of ['public', 'sight', 'private'] as const) test(`microphone result rechecks ${change} authority after delayed provider mute acknowledgment`, t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(); t.after(() => f.session.close());
  const current: Record<string, unknown> = { 'unperson-state': { phase: 'conceal' }, 'unperson-room': { attempt: 'a', clock: 2, events: [] } };
  f.session.updateContext({ state: { sight: 'screen: resident in view', room: 'Permission 30s' }, events: [] });
  f.session.receive({ type: 'session.input_transcript.delta', delta: 'Can I leave?' }); t.mock.timers.tick(1500);
  const request = f.events.find(e => e.type === 'delegation'); assert.ok(request);
  f.session.resolveDelegation(request.id, bindVoiceReplyAuthority({ text: 'You may leave.' }, current, () => current, '79.0.0'));
  const mute = f.commands().at(-1); assert.equal(mute.type, 'session.input_audio.mute');
  if (change === 'public') current['unperson-room'] = { attempt: 'a', clock: 3, events: [{ id: 'detention', attempt: 'a', kind: 'director', actor: 'director', visibility: 'internal', at: 3, data: { action: 'detain-resident' } }] };
  if (change === 'sight') f.session.updateContext({ state: { sight: 'screen: resident out of view', room: 'Permission 29s' }, events: [] });
  if (change === 'private') { current['unperson-private-life'] = { entries: ['PRIVATE_DIARY'] }; current['unperson-room'] = { attempt: 'a', clock: 3, events: [] }; }
  f.ack(mute);
  assert.equal(f.sent.some(e => isReplyAppend(e)), change === 'private');
  assert.equal(f.events.some(e => e.type === 'input-hint' && /words are saved/.test(e.message)), change !== 'private');
  assert.ok(f.events.some(e => e.type === 'transcript' && e.final && e.text === 'Can I leave?'));
  assert.equal(f.interrupts(), 0);
  if (change !== 'private') { t.mock.timers.tick(700); f.ack(); assert.equal(f.input.at(-1), true); }
});

test('unmute rejection cannot reopen capture or accept subsequent stale acknowledgments', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(); t.after(() => f.session.close());
  f.session.setMuted({ input: true, output: false }); f.ack();
  f.session.setMuted({ input: false, output: false }); const unmute = f.commands().at(-1);
  assert.equal(unmute.type, 'session.input_audio.unmute');
  f.session.receive({ type: 'error', error: { client_event_id: unmute.event_id } }); f.ack(unmute);
  assert.equal(f.input.at(-1), false); assert.equal(f.errors.length, 1);
});

test('new speculation during mute acknowledgment drains before the approved handoff', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(); t.after(() => f.session.close());
  f.session.scene({ id: 'knock', kind: 'knock' }); f.session.sourceActivity(true); f.ack();
  assert.equal(f.sent.some(e => e.content?.includes('knock')), false); assert.equal(f.allowed.at(-1), false);
  f.session.sourceActivity(false);
  assert.ok(f.sent.some(e => e.content?.includes('knock'))); assert.equal(f.allowed.at(-1), true);
});

test('non-world scene timeout leaves the native output path usable', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture('manual', false); t.after(() => f.session.close());
  f.session.scene({ id: 'knock', kind: 'knock' }); f.ack();
  t.mock.timers.tick(8100); t.mock.timers.tick(700); f.ack();
  assert.equal(f.input.at(-1), true); assert.equal(f.allowed.at(-1), true);
});

test('a speculative source that never drains after mute cannot leave an approved reply locked forever', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(); t.after(() => f.session.close());
  f.session.scene({ id: 'knock', kind: 'knock' }); f.session.sourceActivity(true); f.ack();
  t.mock.timers.tick(8100); t.mock.timers.tick(700);
  assert.ok(f.events.some(e => e.type === 'input-hint' && /reply/i.test(e.message)));
  assert.equal(f.commands().at(-1)?.type, 'session.input_audio.unmute'); f.ack();
  assert.equal(f.input.at(-1), true); assert.equal(f.allowed.at(-1), false);
  f.session.sourceActivity(false);
  assert.equal(f.sent.some(e => e.content?.includes('knock')), false);
});

for (const origin of ['microphone', 'typed'] as const) test(`a newer saved typed reply supersedes ${origin} commentary still awaiting the mute acknowledgment`, t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(); t.after(() => f.session.close());
  if (origin === 'microphone') {
    f.session.receive({ type: 'session.input_transcript.delta', delta: 'Earlier microphone statement.' }); t.mock.timers.tick(1500);
    const request = f.events.find(e => e.type === 'delegation'); assert.ok(request);
    assert.equal(f.session.resolveDelegation(request.id, { text: 'Obsolete microphone reply.' }), true);
  } else f.session.scene({ id: 'earlier-saved', kind: 'reply', text: 'Obsolete typed reply.' });
  const mute = f.commands().at(-1); assert.equal(mute?.type, 'session.input_audio.mute');
  assert.equal(f.sent.some(e => isReplyAppend(e)), false);
  f.session.scene({ id: 'knock-behind-reply', kind: 'knock' });
  const variables = () => ({ 'unperson-state': { phase: 'find' }, 'unperson-room': { version: 1, attempt: 'a', clock: 2, events: [
    { id: 'typed-new', attempt: 'a', at: 0, kind: 'speech', actor: 'resident', visibility: 'public', data: { role: 'user', text: 'I accept.', source: 'typed', delivery: 'received' } },
    { id: 'saved-new', attempt: 'a', at: 1, kind: 'speech', actor: 'screen', visibility: 'public', data: { role: 'assistant', text: 'New saved reply.', source: 'generated', delivery: 'generated' } },
  ] } });
  const reply = hydrateVoiceSceneNotice({ id: 'saved-new', kind: 'reply' }, variables(), [], '76.0.0', variables); assert.ok(reply);
  f.session.scene(reply);
  assert.equal(f.input.at(-1), false); assert.equal(f.commands().length, 1, 'supersession keeps the existing protected floor');
  f.ack(mute);
  assert.deepEqual(f.sent.filter(e => isReplyAppend(e)).map(e => JSON.parse(e.content.split('Reply JSON:\n')[1])), ['New saved reply.']);
  assert.equal(f.sent.some(e => e.content?.includes('knock')), false, 'committed physical cues still wait behind the answer');
  assert.equal(f.interrupts(), 0, 'the superseded reply had never reached playback');
});

test('manual source protection closes capture and holds avatar PCM before session readiness', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: any[] = [], input: boolean[] = [], held: boolean[] = [];
  const session = new LiveVoiceSession({ send: e => sent.push(e), input: v => input.push(v), holdAudio: v => held.push(v),
    emit() {}, interruptAudio() {}, fail: message => assert.fail(message) }, 'Official', '', 'manual', undefined, true);
  t.after(() => session.close());
  session.prepareOutput(); session.sourceActivity(true);
  assert.equal(input.at(-1), false, 'remote media can arrive while the microphone track is already active');
  assert.equal(held.at(-1), true, 'the first PCM packet cannot reach the avatar before protection is acknowledged');
  assert.equal(sent.length, 0, 'provider control is deferred until its session is ready');
  session.receive({ type: 'session.started' }); session.start();
  const mute = sent.find(e => e.type === 'session.input_audio.mute'); assert.ok(mute);
  assert.equal(input.at(-1), false); assert.equal(held.at(-1), true);
  session.receive({ type: 'session.input_audio.muted', client_event_id: mute.event_id });
  assert.equal(held.at(-1), false); assert.equal(input.at(-1), false);
});

test('a manual native scene waits for speech arriving during mute acknowledgment and its avatar queue', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture('manual', false); t.after(() => f.session.close());
  f.session.scene({ id: 'knock', kind: 'knock' });
  f.session.sourceActivity(true); f.session.avatarQueue(2); f.ack();
  assert.equal(f.held.at(-1), false, 'acknowledged input protection allows the native buffered speech');
  assert.equal(f.sent.some(e => e.content?.includes('knock')), false, 'instructions must not interrupt that native speech');
  f.session.playback('started'); f.session.sourceActivity(false);
  f.session.playback('stopped'); f.session.avatarQueue(1);
  assert.equal(f.sent.some(e => e.content?.includes('knock')), false);
  f.session.playback('started'); f.session.avatarQueue(0);
  assert.equal(f.sent.some(e => e.content?.includes('knock')), false);
  f.session.playback('stopped');
  assert.equal(f.sent.filter(e => e.content?.includes('knock')).length, 1);
  assert.equal(f.input.at(-1), false); assert.equal(f.interrupts(), 0);
});

test('a pending native scene expires without cutting long native speech or leaving capture locked afterward', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture('manual', false); t.after(() => f.session.close());
  f.session.scene({ id: 'knock', kind: 'knock' }); f.session.sourceActivity(true); f.session.avatarQueue(1); f.session.playback('started'); f.ack();
  t.mock.timers.tick(8100);
  assert.equal(f.sent.some(e => e.content?.includes('knock')), false); assert.equal(f.input.at(-1), false);
  assert.equal(f.interrupts(), 0); assert.ok(f.events.some(e => e.type === 'input-hint'));
  f.session.sourceActivity(false); f.session.avatarQueue(0); f.session.playback('stopped'); t.mock.timers.tick(700);
  assert.equal(f.commands().at(-1)?.type, 'session.input_audio.unmute'); f.ack();
  assert.equal(f.input.at(-1), true); assert.equal(f.allowed.at(-1), true);
});
