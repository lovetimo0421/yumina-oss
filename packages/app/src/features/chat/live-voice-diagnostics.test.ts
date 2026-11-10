import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveVoiceSession } from './live-voice-session';
import { hydrateVoiceSceneNotice } from './voice-scene-notice';

for (const change of ['sight', 'public-state']) test(`unplayed reply identifies ${change} rejection without exporting context`, () => {
  let current: Record<string, unknown> = {
    'unperson-state': { phase: 'find' }, 'unperson-private-life': { entries: ['PRIVATE_PAGE'] },
    'unperson-room': { version: 1, attempt: 'a', clock: 2, events: [
      { id: 'question', attempt: 'a', at: 0, kind: 'speech', actor: 'resident', visibility: 'public', data: { role: 'user', text: 'MY_WORDS', source: 'typed', delivery: 'received' } },
      { id: 'answer', attempt: 'a', at: 1, kind: 'speech', actor: 'screen', visibility: 'public', data: { role: 'assistant', text: 'APPROVED_WORDS', source: 'generated', delivery: 'generated' } },
    ] },
  };
  const events: any[] = [], failures: string[] = [];
  const session = new LiveVoiceSession({ send: e => {
    if (e.type === 'session.input_audio.mute') session.receive({ type: 'session.input_audio.muted', client_event_id: e.event_id });
    if (/^session\.(instructions|thinking|commentary)\.append$/.test(String(e.type))) session.receive({ type: e.type + 'ed', client_event_id: e.event_id });
  }, emit: e => events.push(e), input() {}, interruptAudio() {}, fail: message => failures.push(message) }, 'Official', { state: { sight: 'Visible' }, events: [] }, 'manual', undefined, true, 'silent');
  try {
    session.receive({ type: 'session.started' }); session.start();
    session.scene(hydrateVoiceSceneNotice({ id: 'answer', kind: 'reply' }, current, [], '78.0.0', () => current)!);
    if (change === 'sight') session.updateContext({ state: { sight: 'Behind partition' }, events: [] });
    else current = { ...current, 'unperson-state': { phase: 'inspection' } };
    assert.equal(session.beforePlayback(), false);
    assert.equal(failures.length, 1); assert.match(failures[0], /Reconnect/);
    assert.deepEqual(events.filter(e => e.type === 'diagnostic'), [{ type: 'diagnostic', code: `reply-${change}-changed` }]);
    assert.doesNotMatch(JSON.stringify(events.filter(e => e.type === 'diagnostic')), /PRIVATE_PAGE|MY_WORDS|APPROVED_WORDS|partition/);
  } finally { session.close(); }
});

test('capture diagnostics identify evidence without including provider words or waveform', async () => {
  const events: any[] = [];
  const session = new LiveVoiceSession({ send() {}, emit: e => events.push(e), input() {}, inputEvidence: async () => 'silent', interruptAudio() {}, fail: assert.fail }, 'Official', '', 'manual', undefined, true);
  try {
    session.receive({ type: 'session.started' }); session.start();
    session.receive({ type: 'session.input_transcript.delta', delta: 'PHANTOM_WORDS' });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.deepEqual(events.filter(e => e.type === 'diagnostic'), [{ type: 'diagnostic', code: 'input-evidence', evidence: 'silent' }]);
    assert.equal(events.some(e => e.type === 'transcript'), false);
  } finally { session.close(); }
});
