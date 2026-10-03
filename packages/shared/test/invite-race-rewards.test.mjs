import assert from 'node:assert/strict';
import test from 'node:test';
import * as race from '../dist/index.js';

test('every positive ticket has a claim, including a share below one cent', () => {
  assert.equal(typeof race.settleInviteRaceRewards, 'function');
  const result = race.settleInviteRaceRewards([
    { userId: 'large', tickets: 1_000_000, reachedAt: null },
    { userId: 'small', tickets: 1, reachedAt: null },
    { userId: 'zero', tickets: 0, reachedAt: null },
  ], { ...race.DEFAULT_INVITE_RACE_RULES, rankPrizesUsd: [] });
  assert.equal(result.payouts.length, 2);
  assert.equal(result.payouts.find(p => p.userId === 'small').totalUsd, 0.01);
  assert.ok(result.payouts.every(p => p.method === 'choice_pending'));
});

test('participation rewards do not reduce existing cash allocations', () => {
  assert.equal(typeof race.settleInviteRaceRewards, 'function');
  const standings = Array.from({length: 200}, (_, i) => ({userId: String(i), tickets: i < 5 ? 1000 : 1, reachedAt: null}));
  const old = race.settleInviteRaceRound(standings);
  const next = race.settleInviteRaceRewards(standings);
  for (const payout of old.payouts) assert.equal(next.payouts.find(p => p.userId === payout.userId).totalUsd, payout.totalUsd);
  assert.equal(next.payouts.length, 200);
  assert.equal(next.payouts.find(p => p.userId === '199').giftCardUsd, null);
});
