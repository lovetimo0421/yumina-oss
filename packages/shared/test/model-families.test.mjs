import assert from 'node:assert/strict';
import test from 'node:test';
import { PICKER_MODEL_FAMILIES, PLAY_MODELS, groupPlayModels, activeVariant } from '../dist/index.js';

test('every family member is a Play model offered at its family lead price, tier and plan', () => {
  const byId = new Map(PLAY_MODELS.map(m => [m.id, m]));
  const seen = new Set();
  for (const family of PICKER_MODEL_FAMILIES) {
    const [lead] = family.members.map(([id]) => byId.get(id));
    assert.ok(lead, `${family.name}: lead ${family.members[0][0]} is not a Play model`);
    for (const [id, label] of family.members) {
      const model = byId.get(id);
      assert.ok(model, `${family.name}: ${id} is not a Play model`);
      assert.ok(!seen.has(id), `${id} belongs to two families`);
      seen.add(id);
      assert.ok(label && model.name.includes(label), `${id}: label "${label}" should come from "${model.name}"`);
      for (const key of ['inputPrice', 'outputPrice', 'tier', 'minPlan']) assert.equal(model[key], lead[key], `${id} ${key} differs from ${family.name}`);
    }
  }
});

test('the live catalog shows one Claude Opus row with every version, newest first', () => {
  const opus = groupPlayModels(PLAY_MODELS).find(g => g.name === 'Claude Opus');
  assert.deepEqual(opus.variants.map(v => v.label), ['5', '4.8', '4.7', '4.6', '4.5']);
  const keys = groupPlayModels(PLAY_MODELS).map(g => g.key);
  assert.equal(new Set(keys).size, keys.length, 'one series at two prices still gets distinct row keys');
  const rows = groupPlayModels(PLAY_MODELS);
  assert.equal(rows.flatMap(g => g.variants).length, PLAY_MODELS.length, 'no model disappears from the picker');
});

test('a family sits where its first listed member was, and a version whose price drifted gets its own row', () => {
  const base = { scope: 'play', tier: 'ultra', minPlan: 'plus', avgCostMushies: 1, inputPrice: 5, outputPrice: 25 };
  const models = [
    { ...base, id: 'a/cheap', name: 'Cheap', tier: 'budget' },
    { ...base, id: 'anthropic/claude-opus-4.7', name: 'Claude Opus 4.7' },
    { ...base, id: 'b/other', name: 'Other' },
    { ...base, id: 'anthropic/claude-opus-5', name: 'Claude Opus 5' },
    { ...base, id: 'anthropic/claude-opus-4.5', name: 'Claude Opus 4.5', inputPrice: 6 },
  ];
  const groups = groupPlayModels(models);
  assert.deepEqual(groups.map(g => g.key), ['a/cheap', 'family:anthropic/claude-opus-5', 'b/other', 'anthropic/claude-opus-4.5']);
  assert.deepEqual(groups[1].variants.map(v => v.model.id), ['anthropic/claude-opus-5', 'anthropic/claude-opus-4.7']);
  assert.equal(activeVariant(groups[1], 'anthropic/claude-opus-4.7').label, '4.7');
  assert.equal(activeVariant(groups[1], 'not/in-family').label, '5');
});

test('a family with one version left after filtering is an ordinary row under its own name', () => {
  const base = { scope: 'play', tier: 'ultra', minPlan: 'plus', avgCostMushies: 1, inputPrice: 5, outputPrice: 25 };
  const groups = groupPlayModels([{ ...base, id: 'anthropic/claude-opus-4.7', name: 'Claude Opus 4.7' }]);
  assert.deepEqual(groups.map(g => [g.key, g.name, g.variants.length]), [['anthropic/claude-opus-4.7', 'Claude Opus 4.7', 1]]);
});
