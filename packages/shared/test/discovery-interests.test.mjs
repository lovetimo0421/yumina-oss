import assert from 'node:assert/strict';
import test from 'node:test';
import * as shared from '../dist/index.js';

test('starter choices distinguish topics and experiences without becoming filter tags', () => {
  assert.equal(typeof shared.discoveryInterestsForTags, 'function');
  for (const id of ['games', 'fantasy', 'rpg', 'visual_novel', 'anime', 'books', 'history']) {
    assert.ok(shared.DISCOVERY_INTEREST_IDS.includes(id), id);
  }
  const grouped = shared.DISCOVERY_INTEREST_GROUPS.flatMap(group => group.interests);
  assert.deepEqual([...grouped].sort(), [...shared.DISCOVERY_INTEREST_IDS].sort());
  assert.equal(new Set(grouped).size, grouped.length);
});

test('interest mapping honors multilingual exact tag aliases and does not guess from substring', () => {
  assert.equal(typeof shared.discoveryInterestsForTags, 'function');
  assert.ok(shared.discoveryInterestsForTags(['歷史']).includes('history'));
  assert.ok(shared.discoveryInterestsForTags(['Historia']).includes('history'));
  assert.ok(shared.discoveryInterestsForTags(['RPG']).includes('rpg'));
  assert.ok(shared.discoveryInterestsForTags(['Visual Novel']).includes('visual_novel'));
  assert.deepEqual(shared.discoveryInterestsForTags(['not fantasy', 'game-breaking', 'unknown']), []);
  assert.deepEqual(shared.discoveryInterestsForTags(['RPG', 'rpg', 'RPG']), shared.discoveryInterestsForTags(['RPG']));
});

test('starter hints fade with time and independent strong evidence without inventing a preference', () => {
  assert.equal(typeof shared.discoveryStarterStrength, 'function');
  const now = new Date('2026-09-21T00:00:00Z');
  assert.equal(shared.discoveryStarterStrength(now.toISOString(), now, 0), 1);
  assert.equal(shared.discoveryStarterStrength('2026-08-22T00:00:00Z', now, 0), 0.5);
  assert.equal(shared.discoveryStarterStrength(now.toISOString(), now, 4), 0.5);
  assert.equal(shared.discoveryStarterStrength(now.toISOString(), now, 8), 0);
  assert.equal(shared.discoveryStarterStrength(undefined, now, 0), 0);
  assert.equal(shared.discoveryStarterStrength('bad', now, 0), 0);
  assert.equal(shared.discoveryStarterStrength('2026-10-21T00:00:00Z', now, 0), 0);
  assert.equal(shared.discoveryStarterStrength(now.toISOString(), now, NaN), 0);
});
