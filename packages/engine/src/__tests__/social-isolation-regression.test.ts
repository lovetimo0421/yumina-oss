import { describe, expect, it } from 'vitest';
import { applySocialAction, claimSocialJob, finishSocialJob, initialSocialState, socialJobContext, socialReplyBatch } from '../social/simulator.js';

const now = '2026-09-15T00:00:00Z';
const profiles = Array.from({ length: 13 }, (_, i) => ({ id: `member-${i}`, name: `Member ${i}`, handle: `${i}`, avatar: '', loreEntryId: `${i}` }));
const config = { profiles, replyCounts: { privateMessage: 'all' as const } };
function start() {
  let s = applySocialAction(initialSocialState(config), { type: 'conversation', id: 'g', name: 'Group', members: profiles.map(p => p.id), channel: false }, config, now);
  s = applySocialAction(s, { type: 'message', id: 'trigger', conversationId: 'g', text: 'Current question' }, config, now);
  s = applySocialAction(s, { type: 'message', id: 'later', conversationId: 'g', text: 'FUTURE_SECRET' }, config, now);
  return claimSocialJob(s, { jobId: 'trigger', attempt: 'one' }, 1000).state;
}

describe('chat fragments and partial-batch history', () => {
  it('accepts consecutive short messages from one group member without losing other replies', () => {
    const s = start();
    const next = finishSocialJob(s, 'trigger', 'one', { messages: [
      { authorId: 'member-0', text: 'Hey.' }, { authorId: 'member-0', text: 'How was it?' },
      { authorId: 'member-1', text: 'Tell us.' },
    ] }, now, 0);
    expect(next.conversations[0]!.messages.map(m => m.text)).toEqual(['Current question', 'Hey.', 'How was it?', 'Tell us.', 'FUTURE_SECRET']);
    expect(next.jobs[0]).toMatchObject({ completedCount: 6, persistedCount: 3, status: 'queued' });
    expect(s.conversations[0]!.messages).toHaveLength(2);
  });

  it('does not read send-ahead messages after silent members consumed a batch', () => {
    const next = finishSocialJob(start(), 'trigger', 'one', { messages: [{ authorId: 'member-0', text: 'Only I replied.' }] }, now, 0);
    const context = JSON.stringify(socialJobContext(next, { ...socialReplyBatch(next.jobs[0]!), members: ['member-6'] }));
    expect(context).toContain('Only I replied.');
    expect(context).not.toContain('FUTURE_SECRET');
  });

  it('keeps every fragment visible and IDs unique across reload, silence, and three batches', () => {
    let s = start();
    for (let batch = 0; batch < 3; batch++) {
      s = claimSocialJob(JSON.parse(JSON.stringify(s)), { jobId: 'trigger', attempt: 'one' }, 2000).state;
      const job = socialReplyBatch(s.jobs[0]!);
      const messages = (batch === 0 ? job.members.slice(0, 1) : job.members).flatMap(authorId => Array.from({ length: 3 }, (_, i) => ({ authorId, text: `${authorId} fragment ${i}` })));
      s = finishSocialJob(s, 'trigger', 'one', { messages }, now, job.completedCount ?? 0);
      const context = JSON.stringify(socialJobContext(s, { ...s.jobs[0]!, members: ['member-12'] }));
      expect(context).toContain(messages.at(-1)!.text);
      expect(context).not.toContain('FUTURE_SECRET');
    }
    expect(s.jobs[0]).toMatchObject({ completedCount: 13, persistedCount: 24, status: 'done' });
    const messages = s.conversations[0]!.messages;
    expect(new Set(messages.map(m => m.id)).size).toBe(messages.length);
    expect(s.notifications).toHaveLength(24);
    expect(messages.at(-1)!.text).toBe('FUTURE_SECRET');
  });

  it('still rejects unauthorized authors, excessive fragments, and oversized text atomically', () => {
    const s = start();
    for (const messages of [
      [{ authorId: 'member-12', text: 'Not this batch' }],
      Array.from({ length: 4 }, () => ({ authorId: 'member-0', text: 'Too many' })),
      [{ authorId: 'member-0', text: 'x'.repeat(281) }],
    ]) expect(() => finishSocialJob(s, 'trigger', 'one', { messages }, now, 0)).toThrow();
    expect(s.conversations[0]!.messages).toHaveLength(2);
  });

  it('does not reuse legacy sparse reply IDs after a saved partial batch', () => {
    let s = start();
    // Two old batches had silent members. Their IDs used consumed-speaker
    // offsets (0 and 6), not the number of messages actually persisted (2).
    s.jobs[0]!.completedCount = 12;
    s.jobs[0]!.persistedCount = 2;
    s.conversations[0]!.messages.splice(1, 0,
      { id: 'trigger:ai:0', authorId: 'member-0', text: 'First batch', createdAt: now },
      { id: 'trigger:ai:6', authorId: 'member-6', text: 'Second batch', createdAt: now });
    s = JSON.parse(JSON.stringify(s));
    const next = finishSocialJob(s, 'trigger', 'one', { messages: [
      { authorId: 'member-12', text: 'One' }, { authorId: 'member-12', text: 'Two' },
    ] }, now, 12);
    expect(next.jobs[0]).toMatchObject({ completedCount: 13, persistedCount: 4, status: 'done' });
    expect(next.conversations[0]!.messages.map(m => m.id)).toEqual(['trigger', 'trigger:ai:0', 'trigger:ai:6', 'trigger:ai:12', 'trigger:ai:13', 'later']);
  });
});
