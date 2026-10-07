import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseVariableValue } from './variable-value';

test('invalid numeric drafts never become zero or Infinity', () => {
 for(const raw of ['', ' ', 'oops', 'Infinity', '1e999']) assert.equal(parseVariableValue('number',raw).ok,false);
 assert.deepEqual(parseVariableValue('number','-12.5'),{ok:true,value:-12.5});
 assert.deepEqual(parseVariableValue('number','0'),{ok:true,value:0});
});
test('JSON variables retain nested data and reject malformed or scalar drafts', () => {
 assert.deepEqual(parseVariableValue('json','{"bag":[{"count":2}]}'),{ok:true,value:{bag:[{count:2}]}});
 for(const raw of ['{', 'null', 'true', '4', '"text"']) assert.equal(parseVariableValue('json',raw).ok,false);
 assert.deepEqual(parseVariableValue('json','[]'),{ok:true,value:[]});
});
test('text remains literal and boolean parsing does not silently coerce typos', () => {
 assert.deepEqual(parseVariableValue('string','  12  '),{ok:true,value:'  12  '});
 assert.equal(parseVariableValue('boolean','tru').ok,false);
 assert.deepEqual(parseVariableValue('boolean','false'),{ok:true,value:false});
});
