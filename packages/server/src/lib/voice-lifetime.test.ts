import test from 'node:test';
import assert from 'node:assert/strict';
import { PILOT_HARD_EXPIRY_MINUTES,pilotCleanupRetryMs,validPilotCallId } from './voice-lifetime.js';
test('native lifetime margin and bounded backoff never depend on a client age',()=>{
 assert.equal(PILOT_HARD_EXPIRY_MINUTES,65);assert.deepEqual([1,2,3,4,5,6,20].map(pilotCleanupRetryMs),[15000,30000,60000,120000,240000,300000,300000]);
 assert(validPilotCallId('rtc_a_b'));for(const id of['','../call','a%call','a'.repeat(201)])assert(!validPilotCallId(id));
});
