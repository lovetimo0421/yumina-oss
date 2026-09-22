import assert from "node:assert/strict";
import test from "node:test";
import { clientDom, loadClientModule, settlePromises } from "./feed-beacon.test-helpers";

test("PostHog mirrors the canonical event identity and save/play stay intents", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const requests: RequestInit[] = [];
  const env = clientDom({ fetch: async (_url: string, init: RequestInit) => { requests.push(init); return new Response(null, { status: 204 }); } });
  const captured: Array<{ event: string; props: Record<string, unknown> }> = [];
  try {
    const beacon = loadClientModule<typeof import("./feed-beacon")>(new URL("./feed-beacon.ts", import.meta.url));
    const analytics = loadClientModule<typeof import("./analytics")>(new URL("./analytics.ts", import.meta.url), {
      "./feed-beacon": beacon, "./analytics-enabled": { isAnalyticsEnabled: () => true },
      "./arrival-attribution": {}, "./game-identity": {},
      "posthog-js": { capture: (event: string, props: Record<string, unknown>) => captured.push({ event, props }) },
    });
    const origin = { world_id: "original", creator_id: "creator", surface: "recommended" as const, position: 2, feed_request_id: "page", attribution_token: "signed" };
    analytics.captureHubEvent("hub_click", origin);
    analytics.captureHubEvent("hub_play_start", { ...origin, authenticated: false, in_library: false });
    analytics.captureHubEvent("hub_library_add", origin);
    analytics.captureHubEvent("hub_preview_close", { ...origin, dwell_ms: 1400, reason: "other" });
    t.mock.timers.tick(4000); await settlePromises();
    const events = JSON.parse(String(requests[0]?.body)).events;
    assert.deepEqual(events.map((e: { eventType: string }) => e.eventType), ["click", "play", "save_intent", "preview_dwell"]);
    assert.equal(events[3].durationMs, 1400);
    for (const [i, event] of events.entries()) {
      assert.equal(event.attributionToken, "signed");
      assert.equal(captured[i].props.event_id, event.eventId);
      assert.equal(captured[i].props.$insert_id, event.eventId);
      assert.equal(captured[i].props.occurred_at, event.occurredAt);
      assert.equal(captured[i].props.attribution_token, undefined, "signed token stays first-party");
      assert.equal(captured[i].props.event_source, "feed_beacon");
    }
    assert.equal(new Set(events.map((e: { eventId: string }) => e.eventId)).size, 4);
  } finally { env.restore(); }
});
