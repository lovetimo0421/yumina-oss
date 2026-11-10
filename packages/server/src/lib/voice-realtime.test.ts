import test from "node:test";
import assert from "node:assert/strict";
import { createOpenAiVoiceCall, VoiceConnectionError } from "./voice-realtime.js";

const sdp = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const request = { apiKey: "sk-user-private", userId: "account-private", sdp, instructions: "Conduct the fictional inspection." };

test("managed voice turns retain semantic VAD while disabling provider response creation and interruption", async () => {
  await createOpenAiVoiceCall({ ...request, turnControl: "client-v1" }, { fetch: async (_url, init) => {
    const session = JSON.parse(String((init?.body as FormData).get("session")));
    assert.deepEqual(session.audio.input.turn_detection, {
      type: "semantic_vad", eagerness: "medium", create_response: false, interrupt_response: false,
    });
    return new Response(sdp);
  } });
});

test("direct voice rejects invalid turn control before credential access or transport", async () => {
  let keys = 0, calls = 0;
  for (const turnControl of [null, "", "client-v2", "provider", true, 1, {}, ["client-v1"]]) {
    const invalid = { ...request, turnControl, get apiKey() { keys++; return request.apiKey; } };
    await assert.rejects(createOpenAiVoiceCall(invalid as never, {
      fetch: async () => { calls++; return new Response(sdp); },
    }), { code: "INVALID_VOICE_REQUEST" });
  }
  assert.equal(keys, 0);
  assert.equal(calls, 0);
});

test("voice provider initial session honors empty and explicit known tool allowlists", async () => {
  for (const tools of [[], ["request_inspection_focus"]] as const) {
    let session: any;
    await createOpenAiVoiceCall({ ...request, tools: [...tools] } as Parameters<typeof createOpenAiVoiceCall>[0], { fetch: async (_url, init) => {
      session = JSON.parse(String((init?.body as FormData).get("session")));
      return new Response(sdp, { status: 201 });
    } });
    assert.deepEqual(session.tools.map((tool: any) => tool.name), tools);
    assert.equal(session.audio.input.turn_detection.create_response, true);
  }
});

test("voice provider rejects invalid tool allowlists without transport", async () => {
  let calls = 0;
  for (const tools of [null, "request_inspection_focus", {}, [null], ["executeCode"], ["request_inspection_focus", "request_inspection_focus"], Array(100).fill("request_inspection_focus"), [{ name: "request_inspection_focus" }]]) {
    await assert.rejects(createOpenAiVoiceCall({ ...request, tools } as never, { fetch: async () => { calls++; return new Response(sdp); } }), { code: "INVALID_VOICE_REQUEST" });
  }
  assert.equal(calls, 0);
});

test("voice uses GA multipart SDP with BYOK, transcription, semantic VAD, and one bounded tool", async () => {
  const result = await createOpenAiVoiceCall(request, {
    fetch: async (url, init) => {
      assert.equal(url, "https://api.openai.com/v1/realtime/calls");
      assert.equal(init?.method, "POST");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("Authorization"), "Bearer sk-user-private");
      assert.equal(headers.has("OpenAI-Beta"), false);
      assert.equal(headers.has("Content-Type"), false, "fetch supplies the multipart boundary");
      assert.match(headers.get("OpenAI-Safety-Identifier")!, /^[a-f0-9]{64}$/);
      assert.ok(init?.body instanceof FormData);
      assert.equal(init.body.get("sdp"), sdp);
      const session = JSON.parse(String(init.body.get("session")));
      assert.equal(session.type, "realtime");
      assert.equal(session.model, "gpt-realtime-2.1");
      assert.equal(session.instructions, request.instructions);
      assert.deepEqual(session.output_modalities, ["audio"]);
      assert.equal(session.audio.input.transcription.model, "gpt-4o-transcribe");
      assert.deepEqual(session.audio.input.turn_detection, {
        type: "semantic_vad", eagerness: "medium", create_response: true, interrupt_response: true,
      });
      assert.equal(session.audio.output.voice, "marin");
      assert.equal(session.max_output_tokens, 512);
      assert.equal(session.tools.length, 1);
      const tool = session.tools[0];
      assert.equal(tool.name, "request_inspection_focus");
      assert.equal(tool.type, "function");
      assert.deepEqual(tool.parameters.properties.focus.enum, ["desk", "door", "bed"]);
      assert.equal(tool.parameters.properties.reason.maxLength, 240);
      assert.equal(tool.parameters.additionalProperties, false);
      assert.deepEqual(tool.parameters.required, ["focus", "reason"]);
      return new Response(sdp, { status: 201 });
    },
  });
  assert.equal(result, sdp);
});

for (const [status, code] of [[401, "OPENAI_KEY_REJECTED"], [403, "OPENAI_KEY_REJECTED"], [429, "VOICE_PROVIDER_RATE_LIMITED"], [500, "VOICE_PROVIDER_ERROR"]] as const) {
  test(`voice safely maps upstream ${status} without reading its failure body`, async () => {
    let bodyRead = false;
    await assert.rejects(createOpenAiVoiceCall(request, { fetch: async () => {
      const response = new Response("sk-provider-secret private upstream details", { status });
      Object.defineProperty(response, "text", { value: async () => { bodyRead = true; return "sk-provider-secret"; } });
      return response;
    } }), (error: unknown) => {
      assert.ok(error instanceof VoiceConnectionError);
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /sk-|private upstream/);
      return true;
    });
    assert.equal(bodyRead, false);
  });
}

test("voice rejects non-SDP and oversized successful responses", async () => {
  for (const body of ["{\"token\":\"sk-provider-secret\"}", sdp + "x".repeat(65_536)]) {
    await assert.rejects(createOpenAiVoiceCall(request, { fetch: async () => new Response(body) }),
      (error: unknown) => error instanceof VoiceConnectionError && error.code === "VOICE_PROVIDER_ERROR");
  }
});

test("voice deadline aborts a stalled request and returns a safe timeout", async () => {
  let upstreamSignal: AbortSignal | null | undefined;
  await assert.rejects(createOpenAiVoiceCall(request, {
    timeoutMs: 15,
    fetch: async (_url, init) => { upstreamSignal = init?.signal; return new Promise<Response>(() => {}); },
  }), (error: unknown) => error instanceof VoiceConnectionError && error.code === "VOICE_TIMEOUT" && error.status === 504);
  assert.equal(upstreamSignal?.aborted, true);
});

test("voice deadline also bounds a stalled response body", async () => {
  await assert.rejects(createOpenAiVoiceCall(request, {
    timeoutMs: 15,
    fetch: async () => new Response(new ReadableStream({ start() {} })),
  }), (error: unknown) => error instanceof VoiceConnectionError && error.code === "VOICE_TIMEOUT");
});

test("voice cancellation aborts negotiation and never contacts upstream after cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(createOpenAiVoiceCall({ ...request, signal: controller.signal }, {
    fetch: async () => { calls++; return new Response(sdp); },
  }), (error: unknown) => error instanceof VoiceConnectionError && error.code === "VOICE_CANCELLED");
  assert.equal(calls, 0);
});

test("voice strips thrown network messages and refuses blank credentials", async () => {
  await assert.rejects(createOpenAiVoiceCall(request, {
    fetch: async () => { throw new Error("sk-user-private network detail"); },
  }), (error: unknown) => error instanceof VoiceConnectionError && !error.message.includes("sk-user"));
  let calls = 0;
  await assert.rejects(createOpenAiVoiceCall({ ...request, apiKey: " " }, {
    fetch: async () => { calls++; return new Response(sdp); },
  }), (error: unknown) => error instanceof VoiceConnectionError && error.code === "OPENAI_KEY_REQUIRED");
  assert.equal(calls, 0);
});


test("Cedar is forwarded to OpenAI", async () => {
  await createOpenAiVoiceCall({ ...request, voice: "cedar" }, { fetch: async (_url, init) => {
    assert.equal(JSON.parse(String((init!.body as FormData).get("session"))).audio.output.voice, "cedar");
    return new Response(sdp);
  } });
});
test("sponsored negotiation rejects missing and malformed provider call IDs", async () => {
  for (const location of [null, "https://evil.test/v1/realtime/calls/rtc_x", "/v1/realtime/calls/../secret", "/v1/realtime/calls/"]) {
    let created = 0;
    await assert.rejects(createOpenAiVoiceCall({ ...request, onCallId: async () => { created++; } }, {
      fetch: async () => new Response(sdp, { headers: location ? { Location: location } : {} }),
    }), (error: unknown) => error instanceof VoiceConnectionError && error.code === "VOICE_PROVIDER_ERROR");
    assert.equal(created, 0);
  }
});
test("sponsored negotiation retains ID before reading a stalled answer", async () => {
  const ids: string[] = [];
  await assert.rejects(createOpenAiVoiceCall({ ...request, onCallId: async id => { ids.push(id); } }, {
    timeoutMs: 10, fetch: async () => new Response(new ReadableStream({ start() {} }), { headers: { Location: "https://api.openai.com/v1/realtime/calls/rtc_test" } }),
  }), (error: unknown) => error instanceof VoiceConnectionError && error.code === "VOICE_TIMEOUT");
  assert.deepEqual(ids, ["rtc_test"]);
});
