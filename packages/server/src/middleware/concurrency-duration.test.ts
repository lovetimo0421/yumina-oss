import test from 'node:test';
import assert from 'node:assert/strict';
process.env.BETTER_AUTH_SECRET='concurrency-duration-test';
process.env.DATABASE_URL='postgresql://test:test@127.0.0.1:1/test';
delete process.env.REDIS_URL;
const {acquireConcurrency,releaseConcurrency}=await import('./rate-limit.js');

test('long reasoning holds its concurrency slot beyond the default TTL',async t=>{
 let now=1_000_000;t.mock.method(Date,'now',()=>now);
 assert.equal(await acquireConcurrency('long-dave',1,630),true);
 assert.equal(await acquireConcurrency('ordinary',1),true);
 now+=100_000;
 assert.equal(await acquireConcurrency('long-dave',1,630),false);
 assert.equal(await acquireConcurrency('ordinary',1),true);
 await releaseConcurrency('long-dave');assert.equal(await acquireConcurrency('long-dave',1,630),true);
 now+=631_000;assert.equal(await acquireConcurrency('long-dave',1,630),true);
 await releaseConcurrency('long-dave');await releaseConcurrency('ordinary');
});
