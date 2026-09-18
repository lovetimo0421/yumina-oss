import { describe, expect, it } from 'vitest';
import { applySocialAction, claimSocialJob, finishSocialJob, initialSocialState, renewSocialEpoch, socialConfigSchema, socialJobContext, socialReplyBatch, type SocialConfig, type SocialState } from '../social/simulator.js';

const now = '2026-09-07T00:00:00Z';
const makeConfig = (size: number, count: number | 'all'): SocialConfig => ({
  profiles: Array.from({ length: size }, (_, i) => ({ id: `member-${i}`, name: `Member ${i}`, handle: `${i}`, avatar: '', loreEntryId: `${i}` })),
  replyCounts: { publicPost: count, privateMessage: count, channel: count, timeline: count },
});
const response = (members: string[], text?: string) => ({ messages: [...members].reverse().map(authorId => ({ authorId, text: text ?? `Reply from ${authorId}` })) });
const start = (config = makeConfig(13, 10), kind: 'post' | 'message' | 'refresh' = 'post') => {
  let state = initialSocialState(config, 'saved-epoch');
  if (kind === 'message') {
    state = applySocialAction(state, { type: 'conversation', id: 'group', name: 'Group', members: config.profiles.map(p => p.id), channel: true }, config, now);
  }
  return applySocialAction(state, kind === 'message'
    ? { type: kind, id: 'job', conversationId: 'group', text: 'ORIGINAL_TRIGGER' }
    : kind === 'post' ? { type: kind, id: 'job', text: 'ORIGINAL_TRIGGER' } : { type: kind, id: 'job' }, config, now);
};
const completeBatch = (state: SocialState, attempt = 'one', text?: string) => {
  const claim = claimSocialJob(state, { jobId: 'job', attempt }, 1000);
  expect(claim.claimed).toBe(true);
  const job = claim.state.jobs[0]!;
  return finishSocialJob(claim.state, 'job', attempt, response(socialReplyBatch(job).members, text), now, job.completedCount ?? 0);
};

describe('configurable reply batches', () => {
  it('accepts safe positive integers and all for every reply kind, without a six-person configuration ceiling', () => {
    for (const count of [1, 7, 10, 50, Number.MAX_SAFE_INTEGER, 'all'] as const) {
      const config = makeConfig(13, count);
      expect(socialConfigSchema.parse(config)).toEqual(config);
    }
    for (const count of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '10', 'ALL', null]) {
      for (const key of ['publicPost', 'privateMessage', 'channel', 'timeline']) {
        expect(socialConfigSchema.safeParse({ ...makeConfig(13, 10), replyCounts: { [key]: count } }).success).toBe(false);
      }
    }
  });

  it.each(['post', 'message', 'refresh'] as const)('persists a ten-person %s in batches of six and four, in assigned order with stable global IDs', kind => {
    const original = start(makeConfig(13, 10), kind);
    const assigned = original.jobs[0]!.members;
    expect(assigned).toHaveLength(10);
    expect(socialReplyBatch(original.jobs[0]!).members).toEqual(assigned.slice(0, 6));
    let state = completeBatch(original);
    expect(state.jobs[0]).toMatchObject({ status: 'queued', completedCount: 6, members: assigned, attempt: 'one' });
    const partial = structuredClone(state);
    expect(original.jobs[0]!.completedCount).toBeUndefined();
    state = completeBatch(JSON.parse(JSON.stringify(state)));
    expect(state.jobs[0]).toMatchObject({ status: 'done', completedCount: 10, members: assigned });
    const items = kind === 'message' ? state.conversations[0]!.messages.slice(1) : state.posts.filter(p => p.authorId !== 'you');
    expect(items.map(p => p.authorId)).toEqual(assigned);
    expect(items.map(p => p.id)).toEqual(assigned.map((_, i) => `job:ai:${i}`));
    const partialItems = kind === 'message' ? partial.conversations[0]!.messages.slice(1) : partial.posts.filter(p => p.authorId !== 'you');
    expect(items.slice(0, 6)).toEqual(partialItems);
    if (kind !== 'refresh') expect(state.notifications.map(n => n.id)).toEqual(items.map(p => p.id));
    expect(claimSocialJob(state, { jobId: 'job', attempt: 'one' }, 10000).claimed).toBe(false);
  });

  it.each([{ size: 13, count: 'all' as const, batches: [6, 6, 1] }, { size: 50, count: 'all' as const, batches: [6, 6, 6, 6, 6, 6, 6, 6, 2] }, { size: 13, count: Number.MAX_SAFE_INTEGER, batches: [6, 6, 1] }])('finishes a $size-person roster with request $count without omissions or duplicates', ({ size, count, batches }) => {
    let state = start(makeConfig(size, count));
    const assigned = [...state.jobs[0]!.members];
    expect(assigned).toHaveLength(size);
    const actual: number[] = [];
    while (state.jobs[0]!.status !== 'done') {
      actual.push(socialReplyBatch(state.jobs[0]!).members.length);
      state = completeBatch(state);
    }
    expect(actual).toEqual(batches);
    expect(state.posts.slice(1).map(p => p.authorId)).toEqual(assigned);
    expect(new Set(state.posts.map(p => p.id)).size).toBe(size + 1);
    expect(state.notifications).toHaveLength(size);
  });

  it('caps all at the saved selected cast and freezes that assignment across future setup/config changes', () => {
    const config = makeConfig(13, 'all');
    let state = applySocialAction(initialSocialState(config), { type: 'setup', id: 'setup', members: config.profiles.slice(0, 8).map(p => p.id) }, config, now);
    state = applySocialAction(state, { type: 'post', id: 'job', text: 'First' }, config, now);
    const assigned = [...state.jobs[0]!.members];
    state = completeBatch(state);
    state = applySocialAction(state, { type: 'setup', id: 'new-setup', members: ['member-12'] }, config, now);
    state = completeBatch(state);
    expect(state.jobs[0]!.members).toEqual(assigned);
    expect(state.posts.slice(1).map(p => p.authorId)).toEqual(assigned);
    state = applySocialAction(state, { type: 'post', id: 'next', text: 'Second' }, makeConfig(13, 50), now);
    expect(state.jobs[1]!.members).toEqual(['member-12']);
  });

  it('rejects duplicate, previous-batch, and future-batch speakers without losing completed replies', () => {
    const state = completeBatch(start());
    const running = claimSocialJob(state, { jobId: 'job', attempt: 'one' }, 2000).state;
    const members = socialReplyBatch(running.jobs[0]!).members;
    const before = structuredClone(running);
    for (const ids of [[members[0]!, members[0]!, ...members.slice(2)], ['member-0', ...members.slice(1)], ['member-12', ...members.slice(1)]]) {
      expect(() => finishSocialJob(running, 'job', 'one', response(ids), now, 6)).toThrow();
      expect(running).toEqual(before);
    }
  });

  it('a partially silent batch still consumes its speakers and the next batch starts where it should', () => {
    const state = completeBatch(start(makeConfig(13, 'all')));
    const running = claimSocialJob(state, { jobId: 'job', attempt: 'one' }, 2000).state;
    const members = socialReplyBatch(running.jobs[0]!).members;
    const next = finishSocialJob(running, 'job', 'one', response(members.slice(1)), now, 6);
    expect(next.jobs[0]!.completedCount).toBe(12);
    expect(next.jobs[0]!.persistedCount).toBe(11);
    expect(next.jobs[0]!.status).toBe('queued');
    expect(next.posts.filter(p => p.parentId === 'job')).toHaveLength(11);
    expect(socialReplyBatch(next.jobs[0]!).members).toEqual(['member-12']);
    const last = claimSocialJob(next, { jobId: 'job', attempt: 'two' }, 3000).state;
    const done = finishSocialJob(last, 'job', 'two', response(['member-12']), now, 12);
    expect(done.jobs[0]!.status).toBe('done');
    expect(done.posts.filter(p => p.parentId === 'job')).toHaveLength(12);
  });

  it('fences a duplicate earlier-batch result even when the next batch uses the same attempt', () => {
    const original = start();
    const firstResponse = response(socialReplyBatch(original.jobs[0]!).members);
    const partial = completeBatch(original);
    const claim = claimSocialJob(partial, { jobId: 'job', attempt: 'one' }, 2000);
    expect(claim.claimed).toBe(true);
    expect(claimSocialJob(claim.state, { jobId: 'job', attempt: 'one' }, 3000).claimed).toBe(false);
    expect(claimSocialJob(claim.state, { jobId: 'job', attempt: 'other' }, 3000).claimed).toBe(false);
    expect(finishSocialJob(claim.state, 'job', 'one', firstResponse, now, 0)).toBe(claim.state);
    expect(finishSocialJob(claim.state, 'job', 'one', response(socialReplyBatch(claim.state.jobs[0]!).members), now, 6).jobs[0]!.status).toBe('done');
  });

  it('requires a new attempt after a partial error, preserves progress, and rejects late results from the failed attempt', () => {
    let state = completeBatch(start());
    state.jobs[0]!.status = 'error';
    state.jobs[0]!.error = 'Provider timed out';
    state = JSON.parse(JSON.stringify(state));
    const history = structuredClone(state.posts);
    expect(claimSocialJob(state, { jobId: 'job', attempt: 'one' }, 300000).claimed).toBe(false);
    const retry = claimSocialJob(state, { jobId: 'job', attempt: 'retry' }, 300000);
    expect(retry.claimed).toBe(true);
    expect(retry.state.jobs[0]).toMatchObject({ completedCount: 6, attempt: 'retry', status: 'running' });
    expect(retry.state.jobs[0]!.error).toBeUndefined();
    const result = response(socialReplyBatch(retry.state.jobs[0]!).members);
    expect(finishSocialJob(retry.state, 'job', 'one', result, now, 6)).toBe(retry.state);
    const finished = finishSocialJob(retry.state, 'job', 'retry', result, now, 6);
    expect(finished.posts.slice(0, history.length)).toEqual(history);
    expect(finished.posts).toHaveLength(11);
  });

  it('recovers a stale later batch with a new attempt without replaying its first six replies', () => {
    const partial = completeBatch(start());
    const stalled = claimSocialJob(partial, { jobId: 'job', attempt: 'one' }, 1000).state;
    expect(claimSocialJob(stalled, { jobId: 'job', attempt: 'one' }, 300000).claimed).toBe(false);
    const retry = claimSocialJob(stalled, { jobId: 'job', attempt: 'retry' }, 241001);
    expect(retry.claimed).toBe(true);
    expect(socialReplyBatch(retry.state.jobs[0]!).members).toEqual(partial.jobs[0]!.members.slice(6));
    const result = response(socialReplyBatch(retry.state.jobs[0]!).members);
    expect(finishSocialJob(retry.state, 'job', 'one', result, now, 6)).toBe(retry.state);
    expect(finishSocialJob(retry.state, 'job', 'retry', result, now, 6).posts).toHaveLength(11);
  });

  it.each(['cancel', 'restore'] as const)('keeps partial history and rejects late results after %s', mode => {
    const partial = completeBatch(start());
    const running = claimSocialJob(partial, { jobId: 'job', attempt: 'one' }, 2000).state;
    const cancelled = mode === 'cancel' ? claimSocialJob(running, { jobId: 'job', attempt: 'one', cancel: true }, 3000).state
      : renewSocialEpoch({ metadata: { social: running } }, 'restored').metadata.social;
    expect(cancelled.jobs[0]).toMatchObject({ status: 'cancelled', completedCount: 6 });
    expect(cancelled.posts).toEqual(partial.posts);
    expect(cancelled.notifications).toEqual(partial.notifications);
    expect(finishSocialJob(cancelled, 'job', 'one', response(socialReplyBatch(running.jobs[0]!).members), now, 6)).toBe(cancelled);
    expect(claimSocialJob(cancelled, { jobId: 'job', attempt: 'retry' }, 300000).claimed).toBe(false);
  });

  it.each(['retry', 'cancel'] as const)('blocks send-ahead DM work after a partial error until %s and keeps replies in order', recovery => {
    const config = makeConfig(13, 10);
    let state = start(config, 'message');
    state = applySocialAction(state, { type: 'message', id: 'later', conversationId: 'group', text: 'LATER_USER_ACTION' }, config, now);
    state = completeBatch(state);
    const context = JSON.stringify(socialJobContext(state, state.jobs[0]!));
    expect(context).toContain('ORIGINAL_TRIGGER');
    expect(context).toContain('Reply from member-5');
    expect(context).not.toContain('LATER_USER_ACTION');
    state.jobs[0]!.status = 'error';
    expect(claimSocialJob(state, { jobId: 'later', attempt: 'later-attempt' }, 3000).claimed).toBe(false);
    state = recovery === 'retry' ? completeBatch(state, 'retry') : claimSocialJob(state, { jobId: 'job', attempt: 'one', cancel: true }, 3000).state;
    expect(claimSocialJob(state, { jobId: 'later', attempt: 'later-attempt' }, 4000).claimed).toBe(true);
    expect(state.conversations[0]!.messages.at(-1)!.text).toBe('LATER_USER_ACTION');
    expect(state.conversations[0]!.messages.slice(1, -1).map(m => m.authorId)).toEqual(state.jobs[0]!.members.slice(0, recovery === 'retry' ? 10 : 6));
  });

  it('completes old three-member queued jobs with no progress field after new configuration is loaded', () => {
    const oldConfig = makeConfig(13, 3);
    let state = start(oldConfig);
    expect(state.jobs[0]!.completedCount).toBeUndefined();
    state = applySocialAction(JSON.parse(JSON.stringify(state)), { type: 'post', id: 'new', text: 'New action' }, makeConfig(13, 'all'), now);
    expect(state.jobs[0]!.members).toHaveLength(3);
    expect(state.jobs[1]!.members).toHaveLength(13);
    state = completeBatch(state);
    expect(state.jobs[0]).toMatchObject({ status: 'done', completedCount: 3 });
    expect(state.posts.filter(p => p.parentId === 'job')).toHaveLength(3);
    expect(state.jobs[1]!.status).toBe('queued');
  });

  it('retains the original DM trigger within budget after many heavily escaped reply batches', () => {
    let state = start(makeConfig(50, 'all'), 'message');
    for (let i = 0; i < 8; i++) state = completeBatch(state, 'one', '\u0001'.repeat(280));
    const context = JSON.stringify(socialJobContext(state, state.jobs[0]!));
    expect(context.length).toBeLessThanOrEqual(25000);
    expect(context).toContain('ORIGINAL_TRIGGER');
    expect(context).toContain('member-47');
  });

  it('cancels a partial-error channel job when membership changes so later messages are not permanently blocked', () => {
    const config = makeConfig(13, 10);
    let state = completeBatch(start(config, 'message'));
    state.jobs[0]!.status = 'error';
    const history = structuredClone(state.conversations[0]!.messages);
    state = applySocialAction(state, { type: 'members', id: 'members-edit', conversationId: 'group', members: ['member-12'] }, config, now);
    expect(state.jobs[0]).toMatchObject({ status: 'cancelled', completedCount: 6 });
    expect(state.conversations[0]!.messages).toEqual(history);
    state = applySocialAction(state, { type: 'message', id: 'later', conversationId: 'group', text: 'Now with the new members' }, config, now);
    expect(claimSocialJob(state, { jobId: 'later', attempt: 'next' }, 3000).claimed).toBe(true);
  });
});
