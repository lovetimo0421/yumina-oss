import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadVoiceDesignStatus,
  requestVoiceDesign,
  resetVoiceDesignStatusForTest,
  saveDesignedVoice,
  voiceDesignErrorKey,
  withSavedVoice,
} from "./voice-design-client";

const id = (n: number) => n.toString(16).padStart(32, "0");

test("status: on only when the server says so; a failed ask reads as off and is asked again", async () => {
  resetVoiceDesignStatusForTest();
  let calls = 0;
  const failing = (async () => { calls++; return new Response("", { status: 500 }); }) as typeof fetch;
  assert.equal((await loadVoiceDesignStatus(failing)).enabled, false);
  const on = (async () => {
    calls++;
    return new Response(JSON.stringify({ enabled: true, designCredits: 12, saveCredits: 0, maxDescription: 500 }));
  }) as typeof fetch;
  const status = await loadVoiceDesignStatus(on);
  assert.deepEqual(status, { enabled: true, designCredits: 12, saveCredits: 0, maxDescription: 500 });
  await loadVoiceDesignStatus(on);
  assert.equal(calls, 2, "a good answer is cached for the page");
});

test("error codes map to the strings the author sees", () => {
  assert.equal(voiceDesignErrorKey("INSUFFICIENT_CREDITS", 402), "noCredits");
  assert.equal(voiceDesignErrorKey("", 402), "noCredits");
  assert.equal(voiceDesignErrorKey("CANDIDATE_NOT_FOUND", 404), "expired");
  assert.equal(voiceDesignErrorKey("VOICE_DESIGN_UNAVAILABLE", 503), "unavailable");
  assert.equal(voiceDesignErrorKey("RATE_LIMITED", 429), "busy");
  assert.equal(voiceDesignErrorKey("PROVIDER_ERROR", 502), "failed");
});

test("requestVoiceDesign posts the description and language; failures come back as a key", async () => {
  let body = "";
  const ok = (async (_url: string, init?: RequestInit) => {
    body = String(init?.body);
    return new Response(JSON.stringify({ candidates: [{ token: "t1", url: "/cdn/tts/x", durationMs: 3000 }], credits: 12 }));
  }) as typeof fetch;
  const result = await requestVoiceDesign("low and husky", "zh", ok);
  assert.ok(result.ok);
  assert.equal(result.candidates[0]!.token, "t1");
  assert.deepEqual(JSON.parse(body), { description: "low and husky", lang: "zh" });

  const broke = (async () => new Response(JSON.stringify({ code: "INSUFFICIENT_CREDITS" }), { status: 402 })) as typeof fetch;
  assert.deepEqual(await requestVoiceDesign("x", "en", broke), { ok: false, errorKey: "noCredits" });
  const offline = (async () => { throw new TypeError("network"); }) as typeof fetch;
  assert.deepEqual(await saveDesignedVoice("t1", "", offline), { ok: false, errorKey: "failed" });
});

test("withSavedVoice adds or renames in place, and a full list drops its oldest entry", () => {
  assert.deepEqual(withSavedVoice([{ id: id(1), name: "a" }], { id: id(2), name: "b" }), [
    { id: id(1), name: "a" },
    { id: id(2), name: "b" },
  ]);
  assert.deepEqual(withSavedVoice([{ id: id(1), name: "a" }], { id: id(1), name: "renamed" }), [{ id: id(1), name: "renamed" }]);
  const full = Array.from({ length: 40 }, (_, i) => ({ id: id(100 + i), name: "" }));
  const next = withSavedVoice(full, { id: id(999), name: "new" });
  assert.equal(next.length, 40);
  assert.equal(next[39]!.id, id(999));
  assert.ok(!next.some((v) => v.id === id(100)));
});
