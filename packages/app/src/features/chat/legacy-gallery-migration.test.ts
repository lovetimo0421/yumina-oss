import test from 'node:test';
import assert from 'node:assert/strict';
import { readLegacyGallery } from './legacy-gallery-migration';

const url = 'data:image/png;base64,YWJj';
const item = { id: 'one', url };
test('variable data is authoritative including empty galleries', () => {
  const get = (key: string) => key.endsWith(':pending-cloud') ? null : JSON.stringify({ items: [item] });
  assert.deepEqual(JSON.parse(readLegacyGallery(get, 's', {data: {items: []}})!), {items: []});
});
test('v3 reads only active manifest assets and preserves originals', () => {
  const records = new Map([
    ['oncin:gallery:v3:s', JSON.stringify({version: 3, items: [{id: 'one', assetId: 'a:b', assetChars: url.length}], collections: []})],
    ['oncin:gallery:v3:asset:s:a%3Ab', url],
    ['oncin:gallery:v3:backup:s', JSON.stringify({items: [{id: 'deleted', url}]})],
  ]);
  const before = [...records];
  const data = JSON.parse(readLegacyGallery(key => records.get(key) ?? null, 's')!);
  assert.deepEqual(data.items.map((x: typeof item) => x.id), ['one']);
  assert.equal(data.items[0].url, url);
  assert.deepEqual([...records], before);
  records.set('oncin:gallery:v3:asset:s:a%3Ab', url + 'AA');
  assert.throws(() => readLegacyGallery(key => records.get(key) ?? null, 's'), /integrity/);
});
test('v4 loads mixed v2/v3/v4 assets with exact identities', () => {
  const records = new Map([
    ['oncin:gallery:v4:s', JSON.stringify({version: 4, items: [
      {id: 'one', assetSource: 'v2'}, {id: 'two', assetSource: 'v3', assetId: 'two'}, {id: 'three', assetSource: 'v4', assetId: 'three'},
    ]})],
    ['oncin:gallery:v2:s', JSON.stringify({items: [item]})],
    ['oncin:gallery:v3:asset:s:two', url],
    ['oncin:gallery:v4:asset:s:three', JSON.stringify({items: [{id: 'three', url}]})],
  ]);
  assert.equal(JSON.parse(readLegacyGallery(key => records.get(key) ?? null, 's')!).items.length, 3);
  records.delete('oncin:gallery:v4:asset:s:three');
  assert.throws(() => readLegacyGallery(key => records.get(key) ?? null, 's'));
});
test('ambiguous recovery and malformed canonical records never fall back to obsolete data', () => {
  assert.throws(() => readLegacyGallery(key => key.includes('journal') ? '{}' : null, 's'), /recovery/);
  assert.throws(() => readLegacyGallery(() => '{broken', 's'));
  assert.equal(readLegacyGallery(() => null, 's'), null);
});

test('a staged cloud draft recovers newer images before old variable and split-store copies', () => {
  const get = (key: string) => key.endsWith(':pending-cloud') ? JSON.stringify({items: [item]}) : null;
  assert.deepEqual(JSON.parse(readLegacyGallery(get, 's', {items: []})!).items, [item]);
});
