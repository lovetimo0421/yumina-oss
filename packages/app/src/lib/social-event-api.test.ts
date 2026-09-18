import assert from "node:assert/strict";
import test from "node:test";
import { submitSocialEntry } from "./social-event-api";

test("initial submission sends the URL, publish time, handle, and evidence", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(JSON.stringify({ data: { phase: "registration_open", entries: [] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    await submitSocialEntry("event-1", {
      platform: "x",
      accountHandle: "yumina",
      postUrl: "https://x.com/yumina/status/123",
      publishedAt: "2026-07-16T08:00:00.000Z",
      evidenceIds: ["proof-1"],
    });

    assert.equal(capturedUrl, "/api/community/events/event-1/social-entries");
    assert.equal(capturedInit?.method, "POST");
    assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
      platform: "x",
      socialHandle: "yumina",
      postUrl: "https://x.com/yumina/status/123",
      postPublishedAt: "2026-07-16T08:00:00.000Z",
      initialEvidenceIds: ["proof-1"],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
