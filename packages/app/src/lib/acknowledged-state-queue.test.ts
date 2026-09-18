import test from "node:test";
import assert from "node:assert/strict";
import { __resetSessionStateQueue, queueSessionStateOperation, queueSessionStatePatch, whenSessionStateSettled } from "./session-state-queue";

test("acknowledged initialization completes before a subsequent partial patch", async () => {
  __resetSessionStateQueue();
  const order:string[]=[];
  let finish!:()=>void;
  const ack=queueSessionStateOperation(async()=>{order.push("setup-start");await new Promise<void>(resolve=>{finish=resolve;});order.push("setup-saved");});
  queueSessionStatePatch(()=>({sessionId:"s",state:{variables:{notes:"note"}}}),async()=>{order.push("notes-saved");});
  await Promise.resolve();assert.deepEqual(order,["setup-start"]);
  finish();await ack;await whenSessionStateSettled();
  assert.deepEqual(order,["setup-start","setup-saved","notes-saved"]);
});

test("an expired queued initialization cannot run after a slow earlier save", async()=>{
  __resetSessionStateQueue();let release!:()=>void;let initialized=false;
  const prior=queueSessionStateOperation(()=>new Promise<void>(resolve=>{release=resolve;}));
  const expired=queueSessionStateOperation(async()=>{initialized=true;},10);
  await assert.rejects(expired,{name:"TimeoutError"});
  release();await prior;await whenSessionStateSettled();assert.equal(initialized,false);
});
