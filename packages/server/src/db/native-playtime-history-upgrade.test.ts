import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';

test('existing embedded databases install the native history tables and snapshot after derived game paths exist',async()=>{
  const source=await readFile(new URL('./index.ts',import.meta.url),'utf8');
  assert.match(source,/\.\.\.NATIVE_PLAYTIME_HISTORY_DDLS/);
  const upgrade=source.slice(source.indexOf('export async function ensureTables()'),source.indexOf('export async function ensureCreativeUploadSchema()'));
  assert.match(upgrade,/if \(!IS_PGLITE\) return/);
  assert.ok(upgrade.indexOf('NATIVE_PLAYTIME_HISTORY_SNAPSHOT')>upgrade.indexOf('await ensureWorldsSchemaDerived()'));
});
