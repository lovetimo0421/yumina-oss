import test from "node:test";
import assert from "node:assert/strict";
import { createOpenAiVoiceCall } from "./voice-realtime.js";

const sdp = "v=0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const request = { apiKey: "sk-private-fixture", userId: "owner", sdp, instructions: "You know the registered resident. Watch only public room observations.", tools: [], turnControl: "live-v1", voice: "cedar" } as const;

test("Live uses its own JSON WebRTC endpoint, client delegation and opaque cleanup identity", async () => {
  let id = "";
  const answer = await createOpenAiVoiceCall({ ...request, tools: [], onCallId: async (value: string) => { id = value; } }, {
    fetch: async (url, init) => {
      assert.equal(url, "https://api.openai.com/v1/live/sessions");
      assert.equal(init?.method, "POST");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.session.model, "gpt-live-1");
      assert.equal(body.session.audio.output.voice, "cedar");
      assert.deepEqual(body.session.delegation, { type: "client" });
      assert.deepEqual(body.transport, { type: "webrtc", sdp });
      assert.equal(body.session.store, false);
      assert.equal(body.session.tools, undefined);
      assert.equal(body.session.audio.input?.turn_detection, undefined);
      return Response.json({ session: { id: "live_opaque_123" }, transport: { type: "webrtc", sdp } }, { status: 201 });
    },
  });
  assert.equal(answer, sdp);
  assert.equal(id, "live_opaque_123");
});

test("Live rejects unsupported tools before opening a paid connection", async () => {
  let calls = 0;
  await assert.rejects(createOpenAiVoiceCall({ ...request, tools: ["request_inspection_focus"] } as never, { fetch: async () => { calls++; return Response.json({}); } }), { code: "INVALID_VOICE_REQUEST" });
  assert.equal(calls, 0);
});

test("Live validates the returned identity/answer and keeps provider failures private", async () => {
  for (const payload of [{}, { session: { id: "../../bad" }, transport: { sdp } }, { session: { id: "live_ok" }, transport: { sdp: "secret-provider-error" } }]) {
    await assert.rejects(createOpenAiVoiceCall({ ...request, tools: [] } as never, { fetch: async () => Response.json(payload) }), { code: "VOICE_PROVIDER_ERROR" });
  }
  await assert.rejects(createOpenAiVoiceCall({ ...request, tools: [] } as never, { fetch: async () => new Response("private provider body", { status: 403 }) }), { code: "OPENAI_KEY_REJECTED" });
});

test("Live bounds a stalled response body, not only its headers", async () => {
  await assert.rejects(createOpenAiVoiceCall({ ...request, tools: [] } as never, { timeoutMs: 20, fetch: async () => new Response(new ReadableStream({ start() {} })) }), { code: "VOICE_TIMEOUT" });
});
