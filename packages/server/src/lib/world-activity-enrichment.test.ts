import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createWorldActivityEnricher} from './world-activity-enrichment.js';

test('enrichment preserves chat counters, replaces native counters, batches and caches reads',async()=>{
 const calls:string[][]=[];
 const enrich=createWorldActivityEnricher(async(ids,kind)=>{
  calls.push([...ids]);
  return ids.flatMap(id=>id==='unknown'?[]:[{id,seconds:kind==='native'?3600:180, ...(kind==='native'?{interactions:12}:{})}]);
 });
 const rows=[{id:'chat',messageCount:99},{id:'pvz',gamePath:'/pvz/',messageCount:0},{id:'unknown',gamePath:'/other',messageCount:0}];
 const expected=[{...rows[0],totalPlaytimeSeconds:180},{...rows[1],messageCount:12,totalPlaytimeSeconds:3600},{...rows[2],totalPlaytimeSeconds:null}];
 const [a,b]=await Promise.all([enrich(rows),enrich(rows)]);
 assert.deepEqual(a,expected);assert.deepEqual(b,expected);assert.equal(calls.length,2);
 assert.deepEqual(await enrich(rows),expected);assert.equal(calls.length,2);
});

test('native read failures remain unavailable without breaking chat totals',async()=>{
 const enrich=createWorldActivityEnricher(async(ids,kind)=>{
  if(kind==='native')throw new Error('database unavailable');
  return ids.map(id=>({id,seconds:100}));
 },()=>{});
 assert.deepEqual(await enrich([{id:'chat'},{id:'pvz',gamePath:'/pvz',messageCount:0}]),[
  {id:'chat',totalPlaytimeSeconds:100},{id:'pvz',gamePath:'/pvz',messageCount:0,totalPlaytimeSeconds:null},
 ]);
});

test('changing a world game path cannot reuse another source cached totals',async()=>{
 let supported=true;
 const enrich=createWorldActivityEnricher(async(ids,kind)=>supported?ids.map(id=>({id,seconds:kind==='native'?90:20,interactions:kind==='native'?4:undefined})):[]);
 assert.equal((await enrich([{id:'world',gamePath:'/pvz'}]))[0]!.messageCount,4);
 supported=false;
 assert.deepEqual(await enrich([{id:'world',gamePath:'/unsupported',messageCount:0}]),[{id:'world',gamePath:'/unsupported',messageCount:0,totalPlaytimeSeconds:null}]);
 supported=true;
 assert.equal((await enrich([{id:'world'}]))[0]!.totalPlaytimeSeconds,20);
});
