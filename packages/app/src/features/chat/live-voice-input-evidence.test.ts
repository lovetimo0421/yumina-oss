import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveVoiceSession } from './live-voice-session';
import { hydrateVoiceSceneNotice } from './voice-scene-notice';

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function harness(inputEvidence: () => Promise<'silent' | 'signal' | 'unknown'>, onEvent: (e: any) => void = () => {}) {
  const events: any[] = [], sent: any[] = [];
  const s = new LiveVoiceSession({ inputEvidence, send(e) {
    sent.push(e);
    if (/^session\.(instructions|thinking|commentary)\.append$/.test(String(e.type))) s.receive({ type: e.type + 'ed', client_event_id: e.event_id });
    if (e.type === 'session.input_audio.mute' || e.type === 'session.input_audio.unmute') {
      s.receive({ type: e.type === 'session.input_audio.mute' ? 'session.input_audio.muted' : 'session.input_audio.unmuted', client_event_id: e.event_id });
    }
  }, emit: e => { events.push(e); onEvent(e); }, input() {}, interruptAudio() {}, fail: assert.fail }, 'Official', '', 'manual', undefined, true);
  s.receive({ type: 'session.started' }); s.start();
  const words = (delta: string, event_id?: string) => s.receive({ type: 'session.input_transcript.delta', delta, event_id });
  return { s, events, sent, words };
}

test('provider words during confirmed digital silence cannot become testimony or stop output', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(async () => 'silent');
  h.s.sourceActivity(true); h.s.playback('started');
  h.words('a man with', 'phantom'); await settle();
  t.mock.timers.tick(1600);
  assert.equal(h.events.some(e => e.type === 'transcript' || e.type === 'delegation'), false);
  assert.equal(h.sent.some(e => e.type === 'session.input_audio.unmute'), false, 'output stays protected');
  h.s.close();
});

test('signal and uncertain capture preserve quiet words and late recognition while muted', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const evidence of ['signal', 'unknown'] as const) {
    const h = harness(async () => evidence);
    h.s.setMuted({ input: true, output: false }); h.words('I remember Anna.'); await settle();
    t.mock.timers.tick(1600);
    assert.equal(h.events.find(e => e.type === 'transcript' && e.final)?.text, 'I remember Anna.');
    assert.equal(h.events.filter(e => e.type === 'delegation').length, 1);
    h.s.close();
  }
});

test('a silent hallucination cannot invalidate a queued authored answer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(async () => 'silent');
  h.s.sourceActivity(true);
  h.s.scene({ id: 'typed-answer', kind: 'reply', text: 'You remember a person. The register records a vacancy.' });
  h.words('a man with'); await settle(); t.mock.timers.tick(1600);
  h.s.sourceActivity(false); t.mock.timers.tick(700);
  const instruction = h.sent.filter(e => e.type === 'session.instructions.append').map(e => e.content).join('');
  assert.match(instruction, /Reply JSON:\n"You remember a person/);
  assert.equal(h.events.some(e => e.type === 'transcript' && e.role === 'user'), false);
  h.s.close();
});

test('queued words get a fresh probe and are admitted in provider order without duplicate IDs', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending: ((v: 'silent' | 'signal' | 'unknown') => void)[] = [];
  const h = harness(() => new Promise(resolve => pending.push(resolve)));
  h.words('phantom', '1'); await settle();
  h.words('I remember ', '2'); h.words('Anna.', '3'); h.words('Anna.', '3');
  pending.shift()!('silent'); await settle();
  assert.equal(h.events.filter(e => e.type !== 'diagnostic').length, 0);
  assert.equal(pending.length, 1, 'later arrival needs a new barrier');
  pending.shift()!('signal'); await settle(); t.mock.timers.tick(1600);
  assert.equal(h.events.find(e => e.type === 'transcript' && e.final)?.text, 'I remember Anna.');
  h.s.close();
});

test('failed or stalled evidence preserves speech; a closed session drops pending work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const proof of [async () => { throw Error('unavailable'); }, () => new Promise<'unknown'>(() => {})]) {
    const h = harness(proof); h.words('Quiet speech.'); await settle();
    t.mock.timers.tick(300); await settle(); t.mock.timers.tick(1600);
    assert.equal(h.events.find(e => e.type === 'transcript' && e.final)?.text, 'Quiet speech.'); h.s.close();
  }
  let resolve!: (v: 'signal') => void;
  const h = harness(() => new Promise(r => { resolve = r; })); h.words('Too late.'); await settle();
  h.s.close(); resolve('signal'); await settle(); t.mock.timers.tick(2000);
  assert.equal(h.events.some(e => e.type === 'transcript'), false);
});

test('a newer typed reply retains priority over earlier words awaiting capture proof', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolve!: (v: 'signal') => void;
  const sent: any[] = [], events: any[] = [];
  const s = new LiveVoiceSession({ send: e => {
    sent.push(e);
    if (/^session\.(instructions|thinking|commentary)\.append$/.test(String(e.type))) s.receive({ type: e.type + 'ed', client_event_id: e.event_id });
  }, emit: e => events.push(e), input() {}, interruptAudio() {}, fail: assert.fail,
    inputEvidence: () => new Promise(r => { resolve = r; }),
  }, 'Official', '', 'manual', undefined, true);
  s.receive({ type: 'session.started' }); s.start();
  s.receive({ type: 'session.input_transcript.delta', delta: 'Earlier words.' }); await settle();
  s.scene({ id: 'new-typed', kind: 'reply', text: 'The answer to your newer typed question.' });
  resolve('signal'); await settle();
  t.mock.timers.tick(1600);
  const mute = sent.find(e => e.type === 'session.input_audio.mute');
  s.receive({ type: 'session.input_audio.muted', client_event_id: mute.event_id });
  assert.ok(sent.some(e => e.content?.includes('Reply JSON:\n"The answer to your newer typed question.')));
  assert.equal(events.filter(e => e.type === 'transcript' && !e.final).length, 1); s.close();
});

test('a typed reply waits for pending capture proof instead of promoting digital silence to testimony', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolve!: (v: 'silent') => void;
  const h = harness(() => new Promise(r => { resolve = r; }));
  h.words('a woman stands'); await settle();
  h.s.scene({ id: 'typed-answer', kind: 'reply', text: 'The register is the account on which we act.' });
  assert.equal(h.events.some(e => e.type === 'transcript'), false, 'A scene handoff is not evidence of microphone signal.');
  assert.equal(h.sent.some(e => e.content?.includes('Reply JSON:')), false, 'Resolve the earlier capture event before performing the later answer.');
  resolve('silent'); await settle(); t.mock.timers.tick(1600);
  assert.equal(h.events.some(e => e.type === 'transcript' || e.type === 'delegation'), false);
  assert.ok(h.sent.some(e => e.content?.includes('Reply JSON:\n"The register is the account on which we act."')));
  h.s.close();
});

for (const cancel of ['scene', 'interrupt', 'mute', 'close']) test(`capture-delayed reply cannot revive after ${cancel}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolve!: (v: 'silent') => void;
  const h = harness(() => new Promise(r => { resolve = r; }));
  h.words('phantom'); await settle();
  h.s.scene({ id: 'delayed', kind: 'reply', text: 'An abandoned answer.' });
  if (cancel === 'scene') h.s.cancelScene('delayed');
  if (cancel === 'interrupt') h.s.interrupt();
  if (cancel === 'mute') { h.s.setMuted({ input: false, output: true }); h.s.setMuted({ input: false, output: false }); }
  if (cancel === 'close') h.s.close();
  resolve('silent'); await settle(); t.mock.timers.tick(1600);
  assert.equal(h.sent.some(e => e.content?.includes('Reply JSON:')), false);
  assert.equal(h.events.some(e => e.type === 'transcript' && e.role === 'user'), false);
  h.s.close();
});

test('a capture-delayed answer retains the sight authority it had on arrival', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolve!: (v: 'silent') => void;
  const h = harness(() => new Promise(r => { resolve = r; }));
  h.s.updateContext({ state: { sight: 'Resident in view' }, events: [] });
  h.words('phantom'); await settle();
  h.s.scene({ id: 'observed-answer', kind: 'reply', text: 'Remain where you are. I can see you.' });
  h.s.updateContext({ state: { sight: 'Resident behind partition' }, events: [] });
  resolve('silent'); await settle(); t.mock.timers.tick(1600);
  assert.equal(h.sent.some(e => e.content?.includes('Reply JSON:')), false, 'Waiting for capture cannot refresh an old answer into a new sightline.');
  assert.ok(h.events.some(e => e.type === 'input-hint'));
  h.s.close();
});

test('a stalled proof cannot grow the queue with a burst of provider packets', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(() => new Promise(() => {}));
  for (let i = 0; i < 1000; i++) h.words('x');
  assert.equal(h.events.filter(e => e.type === 'transcript' && !e.final).length, 1000, 'bounded fallback drains immediately in order');
  t.mock.timers.tick(300); await settle(); t.mock.timers.tick(1600);
  assert.equal(h.events.find(e => e.type === 'transcript' && e.final)?.text.length, 1000);
  h.s.close();
});

test('silence cannot alter saved reply authority; uncertain real speech still invalidates stale history', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const evidence of ['silent', 'unknown'] as const) {
    const variables = { 'unperson-state': { phase: 'find' }, 'unperson-room': { version: 1, attempt: 'a', clock: 3, events: [
      { id: 'typed', attempt: 'a', at: 0, kind: 'speech', actor: 'resident', visibility: 'public', data: { role: 'user', text: 'I refuse.', source: 'typed', delivery: 'received' } },
      { id: 'answer', attempt: 'a', at: 1, kind: 'speech', actor: 'screen', visibility: 'public', data: { role: 'assistant', text: 'You have refused the correction.', source: 'generated', delivery: 'generated' } },
    ] } };
    const h = harness(async () => evidence, event => {
      if (event.type === 'transcript' && event.role === 'user' && event.final) variables['unperson-room'].events.push({
        id: event.id, attempt: 'a', at: 2, kind: 'speech', actor: 'resident', visibility: 'public',
        data: { role: 'user', text: event.text, source: 'voice', delivery: 'received' },
      });
    });
    h.s.sourceActivity(true);
    const notice = hydrateVoiceSceneNotice({ id: 'answer', kind: 'reply' }, variables, [], '78.0.0', () => variables);
    assert.ok(notice); h.s.scene(notice);
    h.words(evidence === 'silent' ? 'a man with' : 'I changed my mind.'); await settle();
    t.mock.timers.tick(1600); h.s.sourceActivity(false); t.mock.timers.tick(700);
    assert.equal(variables['unperson-room'].events.length, evidence === 'silent' ? 2 : 3);
    assert.equal(h.sent.some(e => e.content?.includes('Reply JSON:')), evidence === 'silent');
    h.s.close();
  }
});
