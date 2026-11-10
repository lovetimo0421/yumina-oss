import assert from "node:assert/strict";
import test from "node:test";
import {
  __resetSessionStateQueue,
  queueSessionStatePatch,
  queueSessionStateOperation,
  whenSessionStateSettled,
  type SessionStatePatch,
} from "./session-state-queue.js";

function recorder(delayResolvers?: Array<() => void>) {
  const sent: SessionStatePatch[] = [];
  const send = (patch: SessionStatePatch) => {
    sent.push({ sessionId: patch.sessionId, state: patch.state });
    if (!delayResolvers) return Promise.resolve();
    return new Promise<void>((resolve) => delayResolvers.push(resolve));
  };
  return { sent, send };
}

// 问道 2026-09-01: the creation screen wrote ~60 variables in one tick. One
// PATCH per write raced — out-of-order arrival decided the stored state and the
// message POST read a half-written session.
test("a burst of writes collapses into one request carrying the final values", async () => {
  __resetSessionStateQueue();
  const { sent, send } = recorder();
  let counter = 0;
  for (let i = 0; i < 60; i++) {
    counter = i + 1;
    queueSessionStatePatch(() => ({ sessionId: "s1", state: { writes: counter } }), send);
  }
  await whenSessionStateSettled();

  assert.equal(sent.length, 1, "60 writes must not become 60 requests");
  assert.deepEqual(sent[0]?.state, { writes: 60 }, "the flush must carry the latest values");
});

test("an operation ends PATCH coalescing without freezing reads behind a prior operation", async () => {
  __resetSessionStateQueue();
  const order: string[] = [];
  const sent: SessionStatePatch[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let variables = { earlier: 0, objective: "initial" };
  const prior = queueSessionStateOperation(async () => { await gate; variables = { ...variables, earlier: 7 }; order.push("prior"); });
  const patch = () => queueSessionStatePatch(() => ({ sessionId: "s1", state: { ...variables } }), async value => {
    sent.push(value); order.push("patch");
    // The old batch flushing must not clear the newer batch's coalescing
    // marker and create an unnecessary third PATCH for this later write.
    if (sent.length === 1) patch();
  });
  patch();
  const action = queueSessionStateOperation(async () => { order.push("action"); variables = { ...variables, objective: "from-action" }; });
  variables = { ...variables, objective: "later-write" }; patch(); patch();
  release(); await prior; await action; await whenSessionStateSettled();
  assert.deepEqual(order, ["prior", "patch", "action", "patch"]);
  assert.equal((sent[0]!.state as typeof variables).earlier, 7);
  assert.equal((sent[1]!.state as typeof variables).objective, "from-action");
});

test("a write issued while a request is in flight gets its own follow-up flush", async () => {
  __resetSessionStateQueue();
  const resolvers: Array<() => void> = [];
  const { sent, send } = recorder(resolvers);

  queueSessionStatePatch(() => ({ sessionId: "s1", state: { n: 1 } }), send);
  const settled = whenSessionStateSettled();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sent.length, 1);

  // Second write lands mid-request — it must not be swallowed.
  queueSessionStatePatch(() => ({ sessionId: "s1", state: { n: 2 } }), send);
  resolvers.shift()?.();
  await new Promise((r) => setTimeout(r, 0));
  resolvers.shift()?.();
  await settled;

  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1]?.state, { n: 2 });
});

test("only one request is ever in flight", async () => {
  __resetSessionStateQueue();
  const resolvers: Array<() => void> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const send = () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise<void>((resolve) =>
      resolvers.push(() => {
        inFlight--;
        resolve();
      }),
    );
  };

  for (let i = 0; i < 5; i++) {
    queueSessionStatePatch(() => ({ sessionId: "s1", state: { n: i } }), send);
    await new Promise((r) => setTimeout(r, 0));
    while (resolvers.length) resolvers.shift()?.();
    await new Promise((r) => setTimeout(r, 0));
  }
  await whenSessionStateSettled();

  assert.equal(maxInFlight, 1);
});

test("a failed request never poisons the chain (a send must not hang)", async () => {
  __resetSessionStateQueue();
  queueSessionStatePatch(
    () => ({ sessionId: "s1", state: {} }),
    () => Promise.reject(new Error("offline")),
  );
  await whenSessionStateSettled();

  const { sent, send } = recorder();
  queueSessionStatePatch(() => ({ sessionId: "s1", state: { after: true } }), send);
  await whenSessionStateSettled();
  assert.deepEqual(sent[0]?.state, { after: true });
});

test("a throwing patch reader is skipped, not fatal", async () => {
  __resetSessionStateQueue();
  const { sent, send } = recorder();
  queueSessionStatePatch(() => {
    throw new Error("no session");
  }, send);
  await whenSessionStateSettled();
  assert.equal(sent.length, 0);
});

test("settling with nothing queued resolves immediately", async () => {
  __resetSessionStateQueue();
  await whenSessionStateSettled();
});

// A dead radio can leave a PATCH hanging with no fetch timeout. The player's
// next message must still go out.
test("a request that never settles does not block the send forever", async () => {
  __resetSessionStateQueue();
  queueSessionStatePatch(
    () => ({ sessionId: "s1", state: {} }),
    () => new Promise<void>(() => {}),
  );
  const started = Date.now();
  await whenSessionStateSettled(50);
  assert.ok(Date.now() - started < 2000, "must give up on a hung request");
});
