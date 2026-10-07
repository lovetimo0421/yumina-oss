import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { createVoiceRoutes, type VoiceRouteServices } from "./voice.js";
import { createOpenAiVoiceCall, VoiceConnectionError } from "../lib/voice-realtime.js";

const sessionId = "63f04103-dcfa-4d41-a802-f2234951d349";
const sdp = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const input = { sdp, instructions: "Run the fictional inspection." };
const responseCode = async (response: Response) => (await response.json() as { code: string }).code;

test("private pilot funding stays in its owned native lifecycle and never overrides BYOK", async () => {
  let pilotCalls = 0;
  const f = setup({ getOpenAiKey: async () => null, getPilotKey: async (user, session) => { assert.equal(user, "owner"); assert.equal(session, sessionId); return "platform-secret"; },
    connectPilot: async request => { pilotCalls++; assert.equal(request.apiKey, "platform-secret"); return sdp; } });
  const config = await (await f.app.request(`/api/voice/${sessionId}/config`)).json();
  assert.equal((config as any).funding, "private-pilot"); assert.equal(JSON.stringify(config).includes("platform-secret"), false);
  assert.equal((await f.post({ ...input, turnControl: "client-v1", tools: [] }, { "content-type": "application/json", "X-Voice-Connection-Id": "pilot" })).status, 200);
  assert.equal(pilotCalls, 1);
  assert.equal((await f.post({ ...input, turnControl: "client-v1", tools: [] })).status, 400);
  assert.equal((await f.post(input, { "content-type": "application/json", "X-Voice-Connection-Id": "pilot" })).status, 400);
  const byok = setup({ getPilotKey: async () => { assert.fail("must not look up platform funding for BYOK"); }, connectPilot: async () => { assert.fail(); } });
  assert.equal((await byok.post(input)).status, 200);
});
test("private-pilot key without lifecycle cannot enable spending; revoked eligibility fails closed", async () => {
  for (const overrides of [{ getPilotKey: async () => "key" }, { getPilotKey: async () => null, connectPilot: async () => { assert.fail(); } }]) {
    const f = setup({ getOpenAiKey: async () => null, ...overrides });
    assert.equal((await (await f.app.request(`/api/voice/${sessionId}/config`)).json() as any).available, false);
    assert.equal((await f.post(input)).status, 412);
  }
});

test("Live BYOK uses owned cleanup while preserving the player's billing key", async () => {
  let managed = false;
  const f = setup({ liveAvailable: () => true, connectSponsored: async request => {
    managed = true; assert.equal(request.apiKey, "sk-owner");
    assert.equal(request.sponsored, false); assert.equal(request.sessionId, sessionId);
    return sdp;
  } });
  assert.equal((await f.post({ ...input, tools: [], turnControl: "live-v1" })).status, 200);
  assert.equal(managed, true);
});
test("pilot cancellation requires a valid actual connection identity before its durable fence", async () => {
  let stops = 0;
  const f = setup({ stopPilot: async () => { stops++; } });
  const url = `/api/voice/${sessionId}/stop`;
  assert.equal((await f.app.request(url, { method: "POST" })).status, 200); assert.equal(stops, 0);
  await f.app.request(url, { method: "POST", headers: { "X-Voice-Connection-Id": "invalid/id" } }); assert.equal(stops, 0);
  await f.app.request(url, { method: "POST", headers: { "X-Voice-Connection-Id": "actual-attempt" } }); assert.equal(stops, 1);
});

test("Live is explicitly enabled by the host and never silently routed to Realtime", async () => {
  const off = setup();
  assert.equal((await off.post({ ...input, tools: [], turnControl: "live-v1" })).status, 400);
  let liveCalls = 0;
  const on = setup({ liveAvailable: () => true, connect: async request => {
    liveCalls++; assert.equal(request.turnControl, "live-v1"); return sdp;
  } });
  const result = await on.post({ ...input, tools: [], turnControl: "live-v1" });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { sdp, turnControl: "live-v1" });
  assert.equal(liveCalls, 1);
});

for (const sponsored of [false, true]) {
  for (const turnControl of [undefined, "client-v1"] as const) {
    test(`${sponsored ? "sponsored" : "BYOK"} voice negotiates ${turnControl ?? "legacy"} turns with exact success response`, async () => {
      let providerCalls = 0;
      const connect: VoiceRouteServices["connect"] = request => {
        assert.equal(request.turnControl, turnControl);
        assert.equal(request.userId, "owner");
        assert.equal(request.apiKey, sponsored ? "sk-testing" : "sk-owner");
        if (sponsored) {
          assert.equal((request as typeof request & { sessionId: string }).sessionId, sessionId);
          assert.equal((request as typeof request & { connectionId: string }).connectionId, "managed-test");
        }
        return createOpenAiVoiceCall(request, { fetch: async (_url, init) => {
          providerCalls++;
          const session = JSON.parse(String((init?.body as FormData).get("session")));
          assert.deepEqual(session.audio.input.turn_detection, {
            type: "semantic_vad", eagerness: "medium", create_response: turnControl === undefined, interrupt_response: turnControl === undefined,
          });
          return new Response(sdp);
        } });
      };
      const f = setup(sponsored ? { getOpenAiKey: async () => null, getTestingKey: () => "sk-testing", connectSponsored: connect } : { connect });
      const response = await f.post({ ...input, ...(turnControl ? { turnControl } : {}) }, { "content-type": "application/json", "X-Voice-Connection-Id": "managed-test" });
      assert.equal(response.status, 200);
      assert.equal(providerCalls, 1);
      assert.deepEqual(await response.json(), turnControl ? { sdp, turnControl } : { sdp });
      assert.equal(f.calls.includes("release"), !sponsored);
    });
  }
  test(`${sponsored ? "sponsored" : "BYOK"} voice rejects invalid turn modes before key or provider work`, async () => {
    for (const turnControl of [null, "", "client-v2", "provider", true, 1, {}, ["client-v1"]]) {
      const f = setup({
        getTestingKey: () => { f.calls.push("testing-key"); return "sk-testing"; },
        ...(sponsored ? { getOpenAiKey: async () => { f.calls.push("key"); return null; }, connectSponsored: async () => { f.calls.push("sponsored"); return sdp; } } : {}),
      });
      const response = await f.post({ ...input, turnControl });
      assert.equal(response.status, 400);
      assert.equal(await responseCode(response), "INVALID_VOICE_REQUEST");
      assert.deepEqual(f.calls, []);
    }
  });
  test(`${sponsored ? "sponsored" : "BYOK"} managed voice does not acknowledge failed negotiation`, async () => {
    const connect = async () => { throw new VoiceConnectionError("VOICE_PROVIDER_ERROR"); };
    const f = setup(sponsored ? { getOpenAiKey: async () => null, getTestingKey: () => "sk-testing", connectSponsored: connect } : { connect });
    const response = await f.post({ ...input, turnControl: "client-v1" });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "OpenAI could not establish the voice connection. Please try again.", code: "VOICE_PROVIDER_ERROR" });
    assert.equal(f.calls.includes("release"), !sponsored);
  });
}

test("voice config advertises managed turn support across funding availability", async () => {
  for (const overrides of [{}, { getOpenAiKey: async () => null }, { getOpenAiKey: async () => null, getTestingKey: () => "sk-testing", connectSponsored: async () => sdp }]) {
    const f = setup(overrides);
    const config = await (await f.app.request(`/api/voice/${sessionId}/config`)).json() as { turnControl?: string };
    assert.equal(config.turnControl, "client-v1");
  }
});

test("HTTP voice route preserves omitted, empty and explicit tools in the initial provider session", async () => {
  for (const sponsored of [false, true]) for (const tools of [undefined, [], ["request_inspection_focus"]]) {
    let session: any; let providerCalls = 0;
    const connect: VoiceRouteServices["connect"] = request => createOpenAiVoiceCall(request, { fetch: async (_url, init) => {
      providerCalls++; session = JSON.parse(String((init?.body as FormData).get("session")));
      return new Response(sdp, { status: 201 });
    } });
    const { post } = setup(sponsored ? { getOpenAiKey: async () => null, getTestingKey: () => "sk-testing", connectSponsored: connect } : { connect });
    const response = await post({ ...input, ...(tools === undefined ? {} : { tools }) });
    assert.equal(response.status, 200); assert.equal(providerCalls, 1);
    assert.deepEqual(session.tools.map((tool: any) => tool.name), tools ?? ["request_inspection_focus"]);
  }
});

test("HTTP voice route rejects invalid tool lists before private lookup or provider calls", async () => {
  for (const tools of [null, "request_inspection_focus", {}, [null], ["executeCode"], ["request_inspection_focus", "request_inspection_focus"], Array(100).fill("request_inspection_focus"), [{ name: "request_inspection_focus" }]]) {
    const { post, calls } = setup(); const response = await post({ ...input, tools });
    assert.equal(response.status, 400); assert.equal(await responseCode(response), "INVALID_VOICE_REQUEST");
    assert.deepEqual(calls, []);
  }
});

function setup(overrides: Partial<VoiceRouteServices> = {}) {
  const calls: string[] = [];
  const services: VoiceRouteServices = {
    authenticate: async () => ({ id: "owner" }),
    ownsSession: async (id, userId) => { calls.push("owner"); return id === sessionId && userId === "owner"; },
    getOpenAiKey: async (userId) => { assert.equal(userId, "owner"); calls.push("key"); return "sk-owner"; },
    checkRateLimit: async () => null,
    acquireConnection: async () => true,
    releaseConnection: async () => { calls.push("release"); },
    connect: async (request) => {
      calls.push("provider");
      assert.equal(request.apiKey, "sk-owner");
      assert.equal(request.userId, "owner");
      return sdp;
    },
    ...overrides,
  };
  const app = new Hono().route("/api/voice", createVoiceRoutes(services));
  const post = (body: unknown = input, headers: Record<string, string> = { "content-type": "application/json" }) =>
    app.request(`/api/voice/${sessionId}/connect`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { app, calls, post };
}

test("voice authenticates an owned session before fetching its key and returns SDP only", async () => {
  const { post, calls } = setup();
  const response = await post();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { sdp });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(calls, ["owner", "key", "provider", "release"]);
});

test("voice rejects unauthenticated or suspended accounts without session or key lookup", async () => {
  for (const account of [null, { id: "owner", isBanned: true }, { id: "owner", isSuspended: true }]) {
    const { post, calls } = setup({ authenticate: async () => account });
    const response = await post();
    assert.equal(response.status, account ? 403 : 401);
    assert.equal(typeof await responseCode(response), "string");
    assert.deepEqual(calls, []);
  }
});

test("voice does not expose existence or access keys for another owner's session", async () => {
  const { post, calls } = setup({ ownsSession: async () => false });
  const response = await post();
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Session not found.", code: "SESSION_NOT_FOUND" });
  assert.deepEqual(calls, []);
});

test("voice fails closed without a stored OpenAI key regardless of platform environment", async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-platform-must-not-be-used";
  try {
    const { post, calls } = setup({ getOpenAiKey: async () => null });
    const response = await post();
    assert.equal(response.status, 412);
    assert.equal(await responseCode(response), "OPENAI_KEY_REQUIRED");
    assert.deepEqual(calls, ["owner"]);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test("voice rejects malformed, unbounded, and unknown request fields before private lookups", async () => {
  for (const body of ["{", null, [], {}, { ...input, sdp: "bad" }, { ...input, instructions: " " },
    { ...input, instructions: "x".repeat(12_001) }, { ...input, sdp: sdp + "x".repeat(65_536) }, { ...input, apiKey: "sk-client" }]) {
    const { post, calls } = setup();
    const response = await post(body);
    assert.equal(response.status, 400);
    assert.equal(await responseCode(response), "INVALID_VOICE_REQUEST");
    assert.deepEqual(calls, []);
  }
  const { app, calls } = setup();
  assert.equal((await app.request("/api/voice/invalid!/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) })).status, 400);
  assert.deepEqual(calls, []);
});

test("voice requires JSON and bounds the entire body, including chunked requests", async () => {
  const { app, post, calls } = setup();
  assert.equal((await post(input, { "content-type": "text/plain" })).status, 415);
  assert.equal((await post("x".repeat(131_073))).status, 413);
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode("x".repeat(131_073))); controller.close();
  } });
  const response = await app.request(`/api/voice/${sessionId}/connect`, { method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half" } as RequestInit);
  assert.equal(response.status, 413);
  assert.equal(await responseCode(response), "VOICE_REQUEST_TOO_LARGE");
  assert.deepEqual(calls, []);
});

test("voice rate bounds prevent provider access and return a retry hint", async () => {
  const { post, calls } = setup({ checkRateLimit: async () => ({ retryAfter: 23 }) });
  const response = await post();
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "23");
  assert.equal(await responseCode(response), "VOICE_RATE_LIMITED");
  assert.equal(calls.includes("provider"), false);
});

test("voice prevents simultaneous negotiations for one account", async () => {
  const { post, calls } = setup({ acquireConnection: async () => false });
  const response = await post();
  assert.equal(response.status, 429);
  assert.equal(await responseCode(response), "VOICE_CONNECTION_PENDING");
  assert.equal(calls.includes("provider"), false);
  assert.equal(calls.includes("release"), false);
});

test("voice exposes safe provider errors and always releases negotiation slots", async () => {
  const { post, calls } = setup({ connect: async () => { throw new VoiceConnectionError("VOICE_TIMEOUT"); } });
  const response = await post();
  assert.equal(response.status, 504);
  assert.equal(await responseCode(response), "VOICE_TIMEOUT");
  assert.equal(calls.at(-1), "release");
});

test("voice strips unexpected service failures instead of returning keys or database details", async () => {
  const { post } = setup({ getOpenAiKey: async () => { throw new Error("sk-private DATABASE_URL"); } });
  const response = await post();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Voice is temporarily unavailable. Please try again.", code: "VOICE_UNAVAILABLE" });
});

test("voice route and provider exchange SDP without returning upstream headers or credentials", async () => {
  const { post } = setup({ connect: (request) => createOpenAiVoiceCall(request, {
    fetch: async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer sk-owner");
      return new Response(sdp, { status: 201, headers: { Location: "/v1/realtime/calls/private-call-id", "X-Private": "sk-secret" } });
    },
  }) });
  const response = await post();
  assert.deepEqual(await response.json(), { sdp });
  assert.equal(response.headers.has("X-Private"), false);
  assert.equal(response.headers.has("Location"), false);
});


test("config authenticates ownership and never spends budget or calls provider", async () => {
  const { app, calls } = setup({ checkRateLimit: async () => { throw new Error("spent"); } });
  const response = await app.request(`/api/voice/${sessionId}/config`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { available: true, funding: "byok", maxDurationSeconds: 300, avatarAvailable: false, turnControl: "client-v1" });
  assert.deepEqual(calls, ["owner", "key"]);
  for (const override of [{ authenticate: async () => null }, { ownsSession: async () => false }]) {
    const f = setup(override);
    assert.ok([401, 404].includes((await f.app.request(`/api/voice/${sessionId}/config`)).status));
  }
});

test("voice accepts Cedar but rejects unknown voices", async () => {
  const f = setup({ connect: async request => { assert.equal(request.voice, "cedar"); return sdp; } });
  assert.equal((await f.post({ ...input, voice: "cedar" })).status, 200);
  assert.equal((await f.post({ ...input, voice: "alloy" })).status, 400);
});
test("config and stop enforce account restrictions and ownership; sponsorship never overrides BYOK", async () => {
  let sponsored = 0, stopped = 0;
  const f = setup({ getTestingKey: () => "testing", connectSponsored: async () => { sponsored++; return sdp; }, stopSponsored: async () => { stopped++; } });
  assert.equal((await f.post()).status, 200); assert.equal(sponsored, 0);
  const noKey = setup({ getOpenAiKey: async () => null, getTestingKey: () => "testing", connectSponsored: async request => { assert.equal(request.apiKey, "testing"); sponsored++; return sdp; } });
  assert.deepEqual(await (await noKey.app.request(`/api/voice/${sessionId}/config`)).json(), { available: true, funding: "testing", maxDurationSeconds: 300, avatarAvailable: false, turnControl: "client-v1" });
  assert.equal(sponsored, 0); assert.equal((await noKey.post()).status, 200); assert.equal(sponsored, 1);
  assert.equal((await f.app.request(`/api/voice/${sessionId}/stop`, { method: "POST" })).status, 200); assert.equal(stopped, 1);
  for (const [override, expected] of [[{ authenticate: async () => null }, 401], [{ authenticate: async () => ({ id: "owner", isSuspended: true }) }, 403], [{ ownsSession: async () => false }, 404]] as const) {
    const bad = setup({ ...override, stopSponsored: async () => { stopped++; } });
    assert.equal((await bad.app.request(`/api/voice/${sessionId}/config`)).status, expected);
    assert.equal((await bad.app.request(`/api/voice/${sessionId}/stop`, { method: "POST" })).status, expected);
  }
  assert.equal(stopped, 1);
});
test("testing credentials cannot bypass the sponsored lifecycle when its handler is absent", async () => {
  const f = setup({ getOpenAiKey: async () => null, getTestingKey: () => "testing" });
  const config = await f.app.request(`/api/voice/${sessionId}/config`);
  assert.deepEqual(await config.json(), { available: false, funding: null, maxDurationSeconds: 300, avatarAvailable: false, turnControl: "client-v1" });
  assert.equal((await f.post()).status, 412);
  assert.equal(f.calls.includes("provider"), false);
});

const avatarConnection = { sessionId: "avatar-session", livekitUrl: "wss://livekit.example", livekitClientToken: "client-token", wsUrl: "wss://avatar.example", maxDurationSeconds: 300 as const };
const avatarHeaders = { "content-type": "application/json", "X-Voice-Connection-Id": "connection-1" };
function avatarServices(): Partial<VoiceRouteServices> {
  return { avatarAvailable: () => true, startAvatar: async request => {
    assert.equal(request.userId, "owner"); assert.equal(request.sessionId, sessionId); assert.equal(request.connectionId, "connection-1");
    assert.ok(request.signal); return avatarConnection;
  }, stopAvatar: async () => {}, heartbeatAvatar: async () => true };
}

test("avatar config is disabled by default and requires a complete installed lifecycle", async () => {
  for (const overrides of [{}, { avatarAvailable: () => true }, avatarServices()]) {
    const f = setup(overrides);
    const config = await (await f.app.request(`/api/voice/${sessionId}/config`)).json() as { avatarAvailable: boolean };
    assert.equal(config.avatarAvailable, "startAvatar" in overrides);
  }
});

test("avatar lifecycle requires authentication and saved-session ownership for every action", async () => {
  for (const action of ["start", "stop", "heartbeat"]) {
    for (const [overrides, expected] of [[{ authenticate: async () => null }, 401], [{ authenticate: async () => ({ id: "owner", isSuspended: true }) }, 403], [{ ownsSession: async () => false }, 404]] as const) {
      const f = setup({ ...avatarServices(), ...overrides });
      const response = await f.app.request(`/api/voice/${sessionId}/avatar/${action}`, { method: "POST", headers: avatarHeaders, body: "{}" });
      assert.equal(response.status, expected, action);
      assert.equal(f.calls.includes("key"), false);
    }
  }
});

test("avatar start exposes only bounded media credentials after checking the shared rate limit", async () => {
  const f = setup(avatarServices());
  const response = await f.app.request(`/api/voice/${sessionId}/avatar/start`, { method: "POST", headers: avatarHeaders, body: "{}" });
  assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), avatarConnection);
  assert.deepEqual(f.calls, ["owner"]);
  const limited = setup({ ...avatarServices(), checkRateLimit: async () => ({ retryAfter: 14 }) });
  const denied = await limited.app.request(`/api/voice/${sessionId}/avatar/start`, { method: "POST", headers: avatarHeaders, body: "{}" });
  assert.equal(denied.status, 429); assert.equal(denied.headers.get("Retry-After"), "14");
});

test("avatar lifecycle requires an exact connection id and refuses client-selected provider settings", async () => {
  const f = setup(avatarServices());
  for (const action of ["start", "stop", "heartbeat"]) {
    for (const connectionId of [undefined, "bad/id", "x".repeat(129)]) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (connectionId !== undefined) headers["X-Voice-Connection-Id"] = connectionId;
      assert.equal((await f.app.request(`/api/voice/${sessionId}/avatar/${action}`, { method: "POST", headers, body: "{}" })).status, 400);
    }
  }
  for (const body of ["{", "null", "[]", '{"avatar_id":"stock"}', '{"maxDurationSeconds":1000}', '{"apiKey":"client-key"}']) {
    assert.equal((await f.app.request(`/api/voice/${sessionId}/avatar/start`, { method: "POST", headers: avatarHeaders, body })).status, 400);
  }
  assert.equal((await f.app.request(`/api/voice/${sessionId}/avatar/start`, { method: "POST", headers: { ...avatarHeaders, "content-type": "text/plain" }, body: "{}" })).status, 415);
});

test("avatar stop and heartbeat pass the owned connection identity without provider ids", async () => {
  const stops: string[][] = [], heartbeats: string[][] = [];
  const f = setup({ ...avatarServices(), stopAvatar: async (...args) => { stops.push(args); }, heartbeatAvatar: async (...args) => { heartbeats.push(args); return false; } });
  const stop = await f.app.request(`/api/voice/${sessionId}/avatar/stop`, { method: "POST", headers: avatarHeaders });
  assert.deepEqual(await stop.json(), { stopped: true });
  const heartbeat = await f.app.request(`/api/voice/${sessionId}/avatar/heartbeat`, { method: "POST", headers: avatarHeaders });
  assert.deepEqual(await heartbeat.json(), { active: false });
  assert.deepEqual(stops, [["owner", sessionId, "connection-1"]]); assert.deepEqual(heartbeats, stops);
});

test("avatar unavailable and unexpected provider errors never disclose secrets", async () => {
  for (const overrides of [{}, { ...avatarServices(), avatarAvailable: () => false }, { ...avatarServices(), startAvatar: async () => { throw new Error("secret-token api-key"); } }]) {
    const f = setup(overrides);
    const response = await f.app.request(`/api/voice/${sessionId}/avatar/start`, { method: "POST", headers: avatarHeaders, body: "{}" });
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /secret-token|api-key/);
  }
});
