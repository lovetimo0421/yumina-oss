import assert from 'node:assert/strict';
import test from 'node:test';
import * as shared from '../dist/index.js';

const format = () => ({ type: 'json_schema', json_schema: { name: 'decision_v1', strict: true, schema: {
  type: 'object', properties: { action: { type: 'string', enum: ['wait'] } }, required: ['action'], additionalProperties: false,
} } });
const parse = raw => {
  assert.equal(typeof shared.parseCompletionResponseFormat, 'function', 'shared parser is exported');
  return shared.parseCompletionResponseFormat(raw);
};

test('omitted and legacy JSON formats remain compatible; nested schema is preserved', () => {
  assert.equal(parse(undefined), undefined);
  assert.deepEqual(parse({ type: 'json_object' }), { type: 'json_object' });
  const raw = format();
  assert.deepEqual(parse(raw), raw);
  const sharedNode = { type: 'string' };
  raw.json_schema.schema.properties = { left: sharedNode, right: sharedNode };
  assert.deepEqual(parse(raw), raw, 'shared references serialize normally and are not cycles');
});

test('reject malformed wrappers and values without accepting a weaker format', () => {
  for (const raw of [null, [], {}, { type: 'text' }, { type: 'json_object', extra: true },
    { ...format(), extra: true }, { type: 'json_schema', json_schema: { ...format().json_schema, extra: true } },
    ...['', 'bad name', 'x'.repeat(65)].map(name => ({ type: 'json_schema', json_schema: { ...format().json_schema, name } })),
    ...[false, undefined, 'true'].map(strict => ({ type: 'json_schema', json_schema: { ...format().json_schema, strict } })),
    ...[null, [], true, { type: 'array' }, { type: 'object', x: undefined }, { type: 'object', x: NaN },
      { type: 'object', x: Infinity }, { type: 'object', x: 1n }, { type: 'object', x: () => {} },
      { type: 'object', x: Symbol('x') }, { type: 'object', x: new Date() }].map(schema => ({ type: 'json_schema', json_schema: { ...format().json_schema, schema } })),
  ]) assert.throws(() => parse(raw), /responseFormat/);
  const accessor = format();
  Object.defineProperty(accessor.json_schema.schema, 'x', { enumerable: true, get() { assert.fail('getter must not execute'); } });
  assert.throws(() => parse(accessor), /accessors/);
  const sparse = format(); sparse.json_schema.schema.enum = Array(1);
  assert.throws(() => parse(sparse), /dense/);
});

test('bound UTF-8 serialization at exactly 16384 bytes', () => {
  const raw = format(); raw.json_schema.schema.description = '';
  const base = Buffer.byteLength(JSON.stringify(raw));
  raw.json_schema.schema.description = 'é'.repeat(Math.floor((16384 - base) / 2)) + 'x'.repeat((16384 - base) % 2);
  assert.equal(Buffer.byteLength(JSON.stringify(raw)), 16384);
  assert.deepEqual(parse(raw), raw);
  raw.json_schema.schema.description += 'x';
  assert.throws(() => parse(raw), /16384/);
});

test('bound full-format traversal depth and visited values, and reject cycles before stringify', () => {
  const raw = format(); let nested = raw.json_schema.schema;
  // Format root is depth zero; schema is depth two.
  for (let i = 0; i < 14; i++) nested = nested.x = {};
  assert.deepEqual(parse(raw), raw);
  nested.x = {};
  assert.throws(() => parse(raw), /depth/);
  const cyclic = format(); cyclic.json_schema.schema.self = cyclic;
  assert.throws(() => parse(cyclic), /cycl/);
  const values = { type: 'json_schema', json_schema: { name: 'n', strict: true, schema: { type: 'object', enum: [] } } };
  // root, type, json_schema, name, strict, schema, type, enum = eight values.
  values.json_schema.schema.enum = Array(2040).fill(null);
  assert.deepEqual(parse(values), values);
  values.json_schema.schema.enum.push(null);
  assert.throws(() => parse(values), /2048/);
});

test('reject hidden serialization hooks before they can bypass JSON traversal', () => {
  const raw = format(); let called = false;
  Object.defineProperty(raw.json_schema.schema, 'toJSON', { value() { called = true; return {}; } });
  assert.throws(() => parse(raw), /non-enumerable/);
  assert.equal(called, false);
});

test('reject inherited array serialization hooks before they can substitute schema data', () => {
  const raw = format(); let calls = 0;
  const values = ['wait'];
  Object.setPrototypeOf(values, Object.assign(Object.create(Array.prototype), {
    toJSON() { calls++; return ['substituted']; },
  }));
  raw.json_schema.schema.properties.action.enum = values;
  assert.throws(() => parse(raw), /plain JSON arrays/);
  assert.equal(calls, 0, 'inherited serialization hook must never execute');
  const normal = format();
  assert.deepEqual(parse(normal), normal, 'ordinary dense arrays remain valid');
});
