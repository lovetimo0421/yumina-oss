import assert from "node:assert/strict";
import test from "node:test";
import { createCoverUploadJobs } from "./cover-upload-jobs.js";
const result = { key: "cover.motion.anim.image", contentType: "image/webp", animated: true, sizeBytes: 123 };
const plenty = () => 4 * 1024 ** 3;
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test("polling returns promptly, shares the active job and recovers after completion or failure", async () => {
  let calls = 0;
  let finish!: (value: typeof result) => void;
  let fail!: (error: Error) => void;
  const jobs = createCoverUploadJobs(() => { calls++; return new Promise((resolve, reject) => { finish = resolve; fail = reject; }); }, Date.now, plenty);
  assert.equal(jobs.poll("source", "world"), null);
  assert.equal(jobs.poll("source", "world"), null);
  assert.throws(() => jobs.poll("other", "world"), /busy/);
  await settle(); assert.equal(calls, 1);
  finish(result); await settle();
  assert.deepEqual(jobs.poll("source", "world"), result);
  assert.equal(jobs.poll("other", "world"), null); await settle();
  fail(new Error("decode failed")); await settle();
  assert.throws(() => jobs.poll("other", "world"), /decode failed/);
  assert.equal(jobs.poll("other", "world"), null); await settle();
  finish(result); await settle();
  assert.equal(calls, 3);
});

test("low container headroom refuses before a source is read; expired jobs can recover from storage", async () => {
  let clock = 0, memory = 64 * 1024 ** 2, calls = 0;
  const jobs = createCoverUploadJobs(async () => { calls++; return result; }, () => clock, () => memory);
  assert.throws(() => jobs.poll("source", "world"), /busy/);
  assert.equal(calls, 0);
  memory = plenty(); jobs.poll("source", "world"); await settle();
  clock = 600_001;
  assert.equal(jobs.poll("source", "world"), null); await settle();
  assert.equal(calls, 2);
});

test("legacy completion joins an asynchronous job and concurrent callers share its result", async () => {
  let calls = 0;
  let finish!: (value: typeof result) => void;
  const jobs = createCoverUploadJobs(() => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  }, Date.now, plenty);
  assert.equal(jobs.poll("source", "world"), null);
  let completed = false;
  const first = jobs.complete("source", "world").then(value => { completed = true; return value; });
  const second = jobs.complete("source", "world");
  await settle();
  assert.equal(calls, 1);
  assert.equal(completed, false, "legacy responses wait for publication");
  finish(result);
  assert.deepEqual(await Promise.all([first, second]), [result, result]);
  assert.deepEqual(await jobs.complete("source", "world"), result);
  assert.equal(calls, 1, "completed retries do not restart processing");
});

test("concurrent legacy callers receive the same processing failure and a later request can retry", async () => {
  let calls = 0;
  let fail!: (error: Error) => void;
  const failure = new Error("decode failed");
  const jobs = createCoverUploadJobs(() => {
    calls++;
    return calls === 1 ? new Promise((_resolve, reject) => { fail = reject; }) : Promise.resolve(result);
  }, Date.now, plenty);
  const first = jobs.complete("source", "world");
  const second = jobs.complete("source", "world");
  const outcomes = Promise.allSettled([first, second]);
  await settle();
  fail(failure);
  for (const outcome of await outcomes) {
    assert.equal(outcome.status, "rejected");
    if (outcome.status === "rejected") assert.equal(outcome.reason, failure);
  }
  assert.equal(calls, 1, "a waiting caller must not silently restart a failed job");
  assert.deepEqual(await jobs.complete("source", "world"), result);
  assert.equal(calls, 2);
});
