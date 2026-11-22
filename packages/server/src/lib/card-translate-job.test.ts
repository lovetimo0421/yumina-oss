import assert from "node:assert/strict";
import test from "node:test";
import { cachedChat } from "./card-translate-job.js";
import type { ChatFn } from "./card-translate.js";

test("a resumed run replays model calls the job already paid for", async () => {
  let calls = 0;
  const chat: ChatFn = async () => { calls++; return { text: "译文", costUsd: 0.01, model: "m" }; };
  const jobId = `test-${Date.now()}`;
  const first = cachedChat(jobId, chat, () => true);
  const again = cachedChat(jobId, chat, () => true);
  const msgs = [{ role: "user" as const, content: "Translate: hello" }];
  assert.equal((await first(msgs, { json: true })).text, "译文");
  assert.equal((await again(msgs, { json: true })).text, "译文");
  assert.equal(calls, 1);
  await again([{ role: "user" as const, content: "Translate: bye" }], { json: true });
  assert.equal(calls, 2);
});

test("a run that lost its lease stops before calling the model", async () => {
  let calls = 0;
  const chat: ChatFn = async () => { calls++; return { text: "x", costUsd: 0, model: "m" }; };
  await assert.rejects(cachedChat("lost", chat, () => false)([{ role: "user" as const, content: "a" }], {}));
  assert.equal(calls, 0);
});
