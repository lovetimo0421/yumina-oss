import test from "node:test";
import assert from "node:assert/strict";
import { afterSessionHistory, whenSessionHistorySettled, withSessionHistoryMutation } from "./session-history-operations";

test("generation waits for an accepted history write but other sessions stay independent", async () => {
  let release!: () => void;
  const events: string[] = [];
  const mutation = withSessionHistoryMutation("s1", () => new Promise<void>(resolve => { release = resolve; events.push("delete"); }));
  const running = new AbortController();
  const waiting = afterSessionHistory("s1", () => { events.push("generate"); return running; });
  afterSessionHistory("other", () => { events.push("other"); return new AbortController(); });
  await Promise.resolve();
  assert.deepEqual(events, ["other", "delete"]);
  release();
  await mutation; await whenSessionHistorySettled("s1"); await Promise.resolve();
  assert.deepEqual(events, ["other", "delete", "generate"]);
  waiting.abort();
  assert.equal(running.signal.aborted, true);
});

test("Stop during history preflight cannot start generation after the write completes", async () => {
  let release!: () => void, started = false;
  const mutation = withSessionHistoryMutation("stopped", () => new Promise<void>(resolve => { release = resolve; }));
  const waiting = afterSessionHistory("stopped", () => { started = true; return new AbortController(); });
  waiting.abort(); await Promise.resolve(); release();
  await mutation; await whenSessionHistorySettled("stopped"); await Promise.resolve();
  assert.equal(started, false);
});

test("failed writes release the barrier, and a new write added while draining is also awaited", async () => {
  const failure = withSessionHistoryMutation("failed", async () => { throw new Error("offline"); });
  await assert.rejects(failure, /offline/);
  await whenSessionHistorySettled("failed");
  let release!: () => void;
  let settled = false;
  const first = withSessionHistoryMutation("growing", async () => {
    void withSessionHistoryMutation("growing", () => new Promise<void>(resolve => { release = resolve; }));
  });
  const barrier = whenSessionHistorySettled("growing").then(() => { settled = true; });
  await first; await Promise.resolve();
  assert.equal(settled, false); release(); await barrier;
  assert.equal(settled, true);
});
