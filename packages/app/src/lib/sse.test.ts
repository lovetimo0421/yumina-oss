import test, { mock } from "node:test";
import assert from "node:assert/strict";
import posthog from "posthog-js";
import { connectSSE } from "./sse";

// The retry boundary in connectSSE guards against a real past incident:
// the server persists the user message as soon as a POST arrives (no
// idempotency key), so a retry of a request that REACHED the origin
// duplicates user messages. Only Cloudflare pre-origin statuses may retry,
// exactly once. These tests pin fetch-call counts, not just messages.

const realFetch = globalThis.fetch;

/** Let queued microtasks + already-due callbacks run. */
async function settle() {
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
}

function mockFetchStatuses(statuses: number[]) {
  let calls = 0;
  globalThis.fetch = (async () => {
    const status = statuses[Math.min(calls, statuses.length - 1)]!;
    calls++;
    return new Response(`edge error ${status}`, { status });
  }) as typeof fetch;
  return () => calls;
}

function collect() {
  const errors: string[] = [];
  const dones: unknown[] = [];
  return {
    errors,
    dones,
    callbacks: {
      onText: () => {},
      onDone: (d: Record<string, unknown>) => dones.push(d),
      onError: (e: string) => errors.push(e),
    },
  };
}

test("pre-origin edge statuses retry exactly once; others never retry", async () => {
  const cases: Array<[number, number]> = [
    [521, 2], [522, 2], [523, 2], [525, 2], [526, 2],
    [520, 1], [524, 1], [500, 1], [502, 1], [402, 1],
  ];
  for (const [status, wantFetches] of cases) {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const getCalls = mockFetchStatuses([status]);
      const c = collect();
      connectSSE("http://test.local/api/x", { method: "POST", body: {}, callbacks: c.callbacks });
      await settle();
      mock.timers.tick(2000);
      await settle();
      // A hypothetical second retry would need another delay — prove none is pending.
      mock.timers.tick(2000);
      await settle();
      assert.equal(getCalls(), wantFetches, `status ${status}: fetch count`);
      assert.equal(c.errors.length, 1, `status ${status}: onError exactly once`);
      if (wantFetches === 2) {
        assert.match(c.errors[0]!, new RegExp(`Cloudflare ${status}`), `status ${status}: friendly copy`);
      } else {
        assert.match(c.errors[0]!, new RegExp(`^HTTP ${status}: `), `status ${status}: classic copy`);
      }
    } finally {
      mock.timers.reset();
    }
  }
});

test("abort during the retry delay cancels cleanly — no second POST, no onError", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const getCalls = mockFetchStatuses([525]);
    const c = collect();
    const controller = connectSSE("http://test.local/api/x", { method: "POST", body: {}, callbacks: c.callbacks });
    await settle();
    controller.abort();
    mock.timers.tick(2000);
    await settle();
    assert.equal(getCalls(), 1);
    assert.equal(c.errors.length, 0);
    assert.equal(c.dones.length, 0);
  } finally {
    mock.timers.reset();
  }
});

test("success on first attempt streams normally with no retry side effects", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response('event: done\ndata: {"ok":true}\n\n', { status: 200 });
  }) as typeof fetch;
  const c = collect();
  connectSSE("http://test.local/api/x", { method: "POST", body: {}, callbacks: c.callbacks });
  await settle();
  assert.equal(calls, 1);
  assert.equal(c.dones.length, 1);
  assert.deepEqual(c.dones[0], { ok: true });
  assert.equal(c.errors.length, 0);
});

test("edge failure then success: second attempt streams, onDone once, no third fetch", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1
        ? new Response("bad edge", { status: 525 })
        : new Response('event: done\ndata: {"ok":1}\n\n', { status: 200 });
    }) as typeof fetch;
    const c = collect();
    connectSSE("http://test.local/api/x", { method: "POST", body: {}, callbacks: c.callbacks });
    await settle();
    mock.timers.tick(2000);
    await settle();
    mock.timers.tick(2000);
    await settle();
    assert.equal(calls, 2);
    assert.equal(c.dones.length, 1);
    assert.equal(c.errors.length, 0);
  } finally {
    mock.timers.reset();
  }
});

test("telemetry keeps canonical names: retried edge failure suffixed, non-edge never renamed", async () => {
  // captureFailure only fires in a window context; posthog-js is SSR-safe to import.
  (globalThis as { window?: unknown }).window = globalThis;
  const captured: string[] = [];
  const realCapture = posthog.capture;
  posthog.capture = ((_event: string, props?: Record<string, unknown>) => {
    captured.push(String(props?.error_type));
    return undefined as never;
  }) as typeof posthog.capture;
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    // 525 then 525: attempt 0 canonical, retry suffixed
    mockFetchStatuses([525, 525]);
    const c1 = collect();
    connectSSE("http://test.local/api/x", { method: "POST", body: {}, callbacks: c1.callbacks });
    await settle();
    mock.timers.tick(2000);
    await settle();
    assert.deepEqual(captured, ["http_525", "http_525_retry_failed"]);

    // 525 then 402: the business error keeps its exact-match dashboard name
    captured.length = 0;
    mockFetchStatuses([525, 402]);
    const c2 = collect();
    connectSSE("http://test.local/api/x", { method: "POST", body: {}, callbacks: c2.callbacks });
    await settle();
    mock.timers.tick(2000);
    await settle();
    assert.deepEqual(captured, ["http_525", "http_402"]);
  } finally {
    mock.timers.reset();
    posthog.capture = realCapture;
    delete (globalThis as { window?: unknown }).window;
    globalThis.fetch = realFetch;
  }
});

// Error-origin metadata drives the retry policy upstream (chat store): only
// "server" origins may auto-retry; "connection" origins may have a zombie
// generation still running server-side and must never blind re-POST.
test("onError meta.origin classifies server / http / connection failures", async () => {
  function collectMeta() {
    const origins: Array<string | undefined> = [];
    return {
      origins,
      callbacks: {
        onText: () => {},
        onDone: () => {},
        onError: (_e: string, meta?: { origin: string }) => origins.push(meta?.origin),
      },
    };
  }

  try {
    // Server-sent event: error → "server"
    globalThis.fetch = (async () =>
      new Response('event: error\ndata: {"error":"llm broke"}\n\n', { status: 200 })) as typeof fetch;
    const srv = collectMeta();
    connectSSE("http://test.local/api/x", { method: "POST", body: {}, callbacks: srv.callbacks });
    await settle();
    assert.deepEqual(srv.origins, ["server"]);

    // Non-2xx response → "http"
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    const http = collectMeta();
    connectSSE("http://test.local/api/x", { method: "POST", body: {}, callbacks: http.callbacks });
    await settle();
    assert.deepEqual(http.origins, ["http"]);

    // fetch throws (Safari "Load failed") → "connection"
    globalThis.fetch = (async () => {
      throw new TypeError("Load failed");
    }) as typeof fetch;
    const net = collectMeta();
    connectSSE("http://test.local/api/x", { method: "POST", body: {}, callbacks: net.callbacks });
    await settle();
    assert.deepEqual(net.origins, ["connection"]);

    // Mid-stream read failure → "connection"
    globalThis.fetch = (async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: text\ndata: {"content":"hi"}\n\n'));
          controller.error(new Error("socket reset"));
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    const mid = collectMeta();
    connectSSE("http://test.local/api/x", { method: "POST", body: {}, callbacks: mid.callbacks });
    await settle();
    assert.deepEqual(mid.origins, ["connection"]);

    // Stream closes without a terminal event → "connection"
    globalThis.fetch = (async () =>
      new Response('event: text\ndata: {"content":"hi"}\n\n', { status: 200 })) as typeof fetch;
    const closed = collectMeta();
    connectSSE("http://test.local/api/x", { method: "POST", body: {}, callbacks: closed.callbacks });
    await settle();
    assert.deepEqual(closed.origins, ["connection"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("HTTP failures expose their status for auth-loss recovery", async () => {
  const seen: Array<{ origin?: string; status?: number }> = [];
  try {
    globalThis.fetch = (async () =>
      new Response('{"error":"Unauthorized"}', { status: 401 })) as typeof fetch;

    connectSSE("http://test.local/api/x", {
      method: "POST",
      body: {},
      callbacks: {
        onText: () => {},
        onDone: () => {},
        onError: (_error, meta) => seen.push({ origin: meta?.origin, status: meta?.status }),
      },
    });
    await settle();

    assert.deepEqual(seen, [{ origin: "http", status: 401 }]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
