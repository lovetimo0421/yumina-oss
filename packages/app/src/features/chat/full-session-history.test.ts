import test from "node:test";
import assert from "node:assert/strict";
import { fetchFullSessionMessages } from "./full-session-history";

interface Row {
  id: string;
  createdAt: string;
  content: string;
}

function row(n: number): Row {
  return {
    id: `m${String(n).padStart(4, "0")}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
    content: `msg ${n}`,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("pages older history until hasMore=false and preserves order", async () => {
  // History: rows 1..841; the session endpoint returned only the newest 200
  // (rows 642..841) — the truncation that produced the a872281748 export bug.
  const history = Array.from({ length: 841 }, (_, i) => row(i + 1));
  const newestWindow = history.slice(-200);

  const requested: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "https://yumina.test");
    requested.push(url.search);
    assert.equal(url.pathname, "/api/sessions/s1/messages");
    const beforeId = url.searchParams.get("beforeId")!;
    const limit = Number(url.searchParams.get("limit"));
    const beforeIndex = history.findIndex((m) => m.id === beforeId);
    assert.ok(beforeIndex >= 0, "cursor must point at a real row");
    const older = history.slice(Math.max(0, beforeIndex - limit), beforeIndex);
    return jsonResponse({ data: older, meta: { hasMore: beforeIndex - limit > 0 } });
  }) as typeof fetch;

  try {
    const all = await fetchFullSessionMessages("s1", newestWindow, { messageTotal: 841 });
    assert.equal(all.length, 841);
    assert.deepEqual(
      all.map((m) => m.id),
      history.map((m) => m.id),
      "full history in ascending order with no gaps",
    );
    // 641 older rows at limit 500 → exactly two pages.
    assert.equal(requested.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("short-circuits without fetching when the window already covers the total", async () => {
  const newestWindow = Array.from({ length: 118 }, (_, i) => row(i + 1));
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return jsonResponse({ data: [], meta: { hasMore: false } });
  }) as typeof fetch;
  try {
    const all = await fetchFullSessionMessages("s1", newestWindow, { messageTotal: 118 });
    assert.equal(all.length, 118);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("skips __pending_ placeholders when choosing the cursor", async () => {
  const pending: Row = { id: "__pending_1", createdAt: new Date().toISOString(), content: "…" };
  const newestWindow = [pending, row(10), row(11)];
  const originalFetch = globalThis.fetch;
  let seenBeforeId: string | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "https://yumina.test");
    seenBeforeId = url.searchParams.get("beforeId");
    return jsonResponse({ data: [row(9)], meta: { hasMore: false } });
  }) as typeof fetch;
  try {
    const all = await fetchFullSessionMessages("s1", newestWindow);
    assert.equal(seenBeforeId, "m0010");
    assert.equal(all[0]!.id, "m0009");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("throws the caller-supplied message on a failed page fetch", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
  try {
    await assert.rejects(
      () => fetchFullSessionMessages("s1", [row(1)], { messageTotal: 5, errorMessage: "加载失败" }),
      /加载失败/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stops when a page yields no new rows (no infinite loop on a stuck cursor)", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    // Server (mis)reports hasMore but returns only rows we already hold.
    return jsonResponse({ data: [row(5)], meta: { hasMore: true } });
  }) as typeof fetch;
  try {
    const all = await fetchFullSessionMessages("s1", [row(5), row(6)]);
    assert.equal(all.length, 2);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
