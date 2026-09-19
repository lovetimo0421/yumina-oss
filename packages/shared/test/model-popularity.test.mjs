import assert from 'node:assert/strict';
import test from 'node:test';
import { blendModelPopularity } from '../dist/index.js';

test('each source contributes half regardless of platform size and unlisted models', () => {
  const scores = blendModelPopularity(['a','b','c'], {a:9_000_000,b:1_000_000,other:1e12}, {a:1,b:9});
  assert.equal(scores.a, 0.5);
  assert.equal(scores.b, 0.5);
  assert.equal(scores.c, 0);
  assert.equal(Object.values(scores).reduce((a,b)=>a+b,0),1);
});

test('missing or invalid measurements never invent a single-source ranking', () => {
  for (const bad of [{}, {a:0}, {a:-1}, {a:NaN}, {a:Infinity}]) {
    assert.throws(()=>blendModelPopularity(['a'], bad, {a:1}));
    assert.throws(()=>blendModelPopularity(['a'], {a:1}, bad));
  }
  assert.throws(()=>blendModelPopularity(['a','a'], {a:1}, {a:1}));
  assert.throws(()=>blendModelPopularity(['a','b'], {a:Number.MAX_VALUE,b:Number.MAX_VALUE}, {a:1}));
});
