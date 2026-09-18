import test from "node:test";
import assert from "node:assert/strict";
import { withStreamDeadline } from "./stream-deadline";
test('stalled read rejects on deadline and cancels the underlying request', async () => {
  const controller=new AbortController(); let cancelled=false;
  await assert.rejects(withStreamDeadline(new Promise(()=>{}),controller.signal,()=>{cancelled=true;controller.abort();},10),/stopped responding/);
  assert.equal(cancelled,true);
});
test('user cancellation immediately releases a stalled read without a timeout error', async () => {
  const controller=new AbortController();let timedOut=false;
  const result=withStreamDeadline(new Promise(()=>{}),controller.signal,()=>{timedOut=true;},1000);
  controller.abort();await assert.rejects(result,{name:'AbortError'});assert.equal(timedOut,false);
});
test('completed reads clear the deadline', async () => {
  const controller=new AbortController();let timedOut=false;
  assert.equal(await withStreamDeadline(Promise.resolve('done'),controller.signal,()=>{timedOut=true;},10),'done');
  await new Promise(r=>setTimeout(r,20));assert.equal(timedOut,false);
});
