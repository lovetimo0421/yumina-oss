import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { parseSafeAuthReturnTo } from "./auth-return.js";
import { createSessionCheck, loginRedirectFor, type SessionAnswer } from "./session-check.js";

const signedIn = { data: { user: { id: "u1" } }, error: null };
const signedOut = { data: null, error: null };
const failure = (status: number) => ({ data: null, error: { status, statusText: "x" } });
type Reply = SessionAnswer | Error;

function server(...replies: Reply[]) {
  let calls = 0;
  const check = createSessionCheck(async () => {
    const reply = replies[Math.min(calls++, replies.length - 1)]!;
    if (reply instanceof Error) throw reply;
    return reply;
  }, { retryMs: 1 });
  return { check, calls: () => calls };
}

/** What a protected page does for this answer (mirrors require-session.ts). */
async function guard(check: ReturnType<typeof server>["check"], href = "/app/chat/s-1") {
  const answer = await check.get();
  return loginRedirectFor(answer, check.isUnverified(answer), parseSafeAuthReturnTo(href)) ?? "allowed";
}

test("a signed-in player passes and the answer is cached", async () => {
  const { check, calls } = server(signedIn);
  assert.equal(await guard(check), "allowed");
  assert.equal(await guard(check), "allowed");
  assert.equal(calls(), 1);
});

test("signed out (200 null or 401) goes to /login and comes back to the chat", async () => {
  for (const reply of [signedOut, failure(401)]) {
    const { check } = server(reply);
    assert.deepEqual(await guard(check), { to: "/login", search: { returnTo: "/app/chat/s-1" } });
  }
});

test("pages outside the return allowlist still go to /login without a return target", async () => {
  const { check } = server(signedOut);
  assert.deepEqual(await guard(check, "/app/settings"), { to: "/login", search: {} });
});

for (const [label, blip] of [
  ["a network failure (iOS 'Load failed')", new TypeError("Load failed")],
  ["a 502 from the edge", failure(502)],
  ["a 429", failure(429)],
] as const) {
  test(`${label} with nothing known lets the page load and is not cached as signed out`, async () => {
    const { check, calls } = server(blip, blip, signedIn);
    assert.equal(await guard(check), "allowed");
    assert.equal(calls(), 2, "one retry, then give up for this navigation");
    assert.deepEqual((await check.get()).data, signedIn.data, "the next check asks again");
    assert.equal(calls(), 3);
  });

  test(`${label} after a known sign-in keeps the player signed in, even past the cache window`, async (t: TestContext) => {
    const { check } = server(signedIn, blip);
    assert.equal(await guard(check), "allowed");
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 60_000 });
    assert.equal(await guard(check), "allowed");
    assert.deepEqual((await check.get()).data, signedIn.data);
  });
}

test("a blip followed by a definitive retry uses the retry", async () => {
  const { check } = server(new TypeError("Load failed"), signedOut);
  assert.deepEqual(await guard(check), { to: "/login", search: { returnTo: "/app/chat/s-1" } });
});

test("concurrent checks (hover preload + click) share one request", async () => {
  const { check, calls } = server(signedIn);
  await Promise.all([guard(check), guard(check), check.get()]);
  assert.equal(calls(), 1);
});

test("a check that started before sign-out cannot restore the old session", async () => {
  let release!: () => void;
  let first = true;
  const check = createSessionCheck(async () => {
    if (!first) return signedOut;
    first = false;
    await new Promise<void>((resolve) => { release = resolve; });
    return signedIn;
  }, { retryMs: 1 });
  const pending = check.get();
  check.clear();
  release();
  await pending;
  assert.equal((await check.get()).data, null);
});
