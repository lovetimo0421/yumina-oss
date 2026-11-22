import { test } from "node:test";
import assert from "node:assert/strict";
import {
  candidateHash,
  cleanDescription,
  designVoices,
  saveDesignedVoice,
  voiceTitle,
  VOICE_DESIGN_CREDITS,
  VOICE_SAVE_CREDITS,
  type VoiceDesignDeps,
} from "./voice-design-service.js";
import { createUnlistedVoice, FishApiError, requestVoiceDesign, voiceDesignLanguage } from "./fish-voice-design.js";

const VOICE_ID = "0123456789abcdef0123456789abcdef";

function fakeDeps(overrides: Partial<VoiceDesignDeps> = {}) {
  const store = new Map<string, Buffer>();
  const log = {
    charges: [] as Array<{ credits: number; ref: string }>,
    refunds: [] as Array<{ credits: number; ref: string }>,
    usage: [] as string[],
    designCalls: [] as Array<{ instruction: string; language: string; n: number; referenceText: string }>,
    registered: [] as Array<{ title: string; text: string; audio: Buffer; signature?: string }>,
    errors: [] as string[],
  };
  let n = 0;
  const deps: VoiceDesignDeps = {
    charge: async (_u, credits, ref) => { log.charges.push({ credits, ref }); },
    refund: async (_u, credits, ref) => { log.refunds.push({ credits, ref }); },
    logUsage: async (row) => { log.usage.push(row.endpoint); },
    design: async (p) => {
      log.designCalls.push(p);
      return [
        { audio: Buffer.from("RIFF-a"), durationMs: 3100, signature: "sig-a" },
        { audio: Buffer.from("RIFF-b"), durationMs: 2900 },
        { audio: Buffer.from("RIFF-c"), durationMs: 3300 },
      ];
    },
    register: async (p) => { log.registered.push(p); return VOICE_ID; },
    put: async (key, body) => { store.set(key, body); },
    get: async (key) => store.get(key) ?? null,
    newToken: () => `tok-${String(++n).padStart(4, "0")}`,
    reportError: (event) => { log.errors.push(event); },
    ...overrides,
  };
  return { deps, store, log };
}

test("design costs provider price × 1.2 (one Fish request, $0.01 → 12 mushies); save is free while Fish doesn't charge", () => {
  assert.equal(VOICE_DESIGN_CREDITS, 12);
  assert.equal(VOICE_SAVE_CREDITS, 0);
});

test("designVoices charges once, asks Fish for 3 candidates in the UI language, stores each and returns CDN urls", async () => {
  const { deps, store, log } = fakeDeps();
  const result = await designVoices({ userId: "u1", description: "  二十多岁的女孩，\n声音低、有点沙哑  ", lang: "zh-Hant" }, deps);
  assert.ok(result.ok);
  assert.equal(result.credits, 12);
  assert.equal(result.candidates.length, 3);
  assert.deepEqual(log.charges.map((c) => c.credits), [12]);
  assert.equal(log.refunds.length, 0);
  assert.equal(log.designCalls[0]!.instruction, "二十多岁的女孩， 声音低、有点沙哑");
  assert.equal(log.designCalls[0]!.language, "zh");
  assert.equal(log.designCalls[0]!.n, 3);
  assert.ok(log.designCalls[0]!.referenceText.length <= 150);
  assert.deepEqual(log.usage, ["voice-design"]);
  for (const c of result.candidates) {
    const hash = candidateHash("u1", c.token);
    assert.equal(c.url, `/cdn/tts/${hash}`);
    assert.ok(store.has(`tts/${hash}.mp3`));
    assert.ok(store.has(`voice-design/${hash}.json`));
  }
});

test("designVoices: not enough mushies → 402 and Fish is never called", async () => {
  const { deps, log } = fakeDeps({
    charge: async () => { throw Object.assign(new Error("INSUFFICIENT_CREDITS"), { balance: 3 }); },
  });
  const result = await designVoices({ userId: "u1", description: "a calm old man", lang: "en" }, deps);
  assert.deepEqual(result, { ok: false, status: 402, code: "INSUFFICIENT_CREDITS", error: "Not enough mushies" });
  assert.equal(log.designCalls.length, 0);
});

test("designVoices: a Fish failure refunds the same reference it charged", async () => {
  const { deps, log } = fakeDeps({
    design: async () => { throw new FishApiError("boom", 500); },
  });
  const result = await designVoices({ userId: "u1", description: "a calm old man", lang: "en" }, deps);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.code, "PROVIDER_ERROR");
  assert.deepEqual(log.refunds, [{ credits: 12, ref: log.charges[0]!.ref }]);
  assert.deepEqual(log.usage, []);
});

test("designVoices: the platform's empty Fish wallet (402) reads as unavailable, not as the author's balance", async () => {
  const { deps, log } = fakeDeps({ design: async () => { throw new FishApiError("no credit", 402); } });
  const result = await designVoices({ userId: "u1", description: "x", lang: "en" }, deps);
  assert.equal(!result.ok && result.code, "VOICE_DESIGN_UNAVAILABLE");
  assert.equal(!result.ok && result.status, 503);
  assert.equal(log.refunds.length, 1);
});

test("designVoices: storage failure after Fish answered still refunds the author", async () => {
  const { deps, log } = fakeDeps({ put: async () => { throw new Error("s3 down"); } });
  const result = await designVoices({ userId: "u1", description: "x", lang: "en" }, deps);
  assert.equal(!result.ok && result.code, "STORAGE_ERROR");
  assert.equal(log.refunds.length, 1);
  assert.deepEqual(log.usage, ["voice-design"]);
});

test("designVoices rejects an empty or too-long description without charging", async () => {
  const { deps, log } = fakeDeps();
  for (const description of ["", "   ", "x".repeat(501), 42]) {
    const result = await designVoices({ userId: "u1", description, lang: "en" }, deps);
    assert.equal(!result.ok && result.status, 400);
  }
  assert.equal(log.charges.length, 0);
});

test("saveDesignedVoice registers the stored clip with its line and signature, and returns the id", async () => {
  const { deps, log } = fakeDeps();
  const designed = await designVoices({ userId: "u1", description: "a husky young woman", lang: "en" }, deps);
  assert.ok(designed.ok);
  const saved = await saveDesignedVoice({ userId: "u1", token: designed.candidates[0]!.token, name: "  Mira  " }, deps);
  assert.deepEqual(saved, { ok: true, id: VOICE_ID, name: "Mira", credits: 0, description: "a husky young woman" });
  assert.equal(log.registered[0]!.audio.toString(), "RIFF-a");
  assert.equal(log.registered[0]!.signature, "sig-a");
  assert.match(log.registered[0]!.text, /night is long/);
  // Save is free today: no second charge.
  assert.equal(log.charges.length, 1);
});

test("saveDesignedVoice registers a candidate once: repeat and simultaneous saves return the same voice", async () => {
  const { deps, log } = fakeDeps();
  const designed = await designVoices({ userId: "u1", description: "a husky young woman", lang: "en" }, deps);
  assert.ok(designed.ok);
  const token = designed.candidates[0]!.token;
  const [a, b] = await Promise.all([
    saveDesignedVoice({ userId: "u1", token, name: "Mira" }, deps),
    saveDesignedVoice({ userId: "u1", token, name: "Mira" }, deps),
  ]);
  const again = await saveDesignedVoice({ userId: "u1", token, name: "Other" }, deps);
  for (const r of [a, b, again]) assert.deepEqual(r, { ok: true, id: VOICE_ID, name: "Mira", credits: 0, description: "a husky young woman" });
  assert.equal(log.registered.length, 1);
});

test("saveDesignedVoice: another author's token resolves to nothing", async () => {
  const { deps, log } = fakeDeps();
  const designed = await designVoices({ userId: "u1", description: "x", lang: "en" }, deps);
  assert.ok(designed.ok);
  const stolen = await saveDesignedVoice({ userId: "u2", token: designed.candidates[0]!.token, name: "" }, deps);
  assert.equal(!stolen.ok && stolen.code, "CANDIDATE_NOT_FOUND");
  assert.equal(log.registered.length, 0);
  const junk = await saveDesignedVoice({ userId: "u1", token: "../etc", name: "" }, deps);
  assert.equal(!junk.ok && junk.code, "INVALID_CANDIDATE");
});

test("saveDesignedVoice: unnamed voices take the description's start as their name", () => {
  assert.equal(voiceTitle("", "short"), "short");
  const long = voiceTitle(undefined, "a".repeat(80));
  assert.equal(long.length, 40);
  assert.ok(long.endsWith("…"));
});

test("cleanDescription collapses whitespace and enforces the cap", () => {
  assert.equal(cleanDescription(" a \n b "), "a b");
  assert.equal(cleanDescription("x".repeat(500))?.length, 500);
  assert.equal(cleanDescription("x".repeat(501)), null);
});

test("voiceDesignLanguage maps UI languages to Fish hints", () => {
  assert.equal(voiceDesignLanguage("zh-Hant"), "zh");
  assert.equal(voiceDesignLanguage("ja"), "ja");
  assert.equal(voiceDesignLanguage("es-MX"), "es");
  assert.equal(voiceDesignLanguage(undefined), "en");
});

test("requestVoiceDesign sends only documented fields with the model header, and orders candidates by index", async () => {
  let sent: { url: string; init?: RequestInit } | null = null;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    sent = { url, init };
    return new Response(JSON.stringify({
      candidates: [
        { id: "b", index: 1, audio_base64: Buffer.from("second").toString("base64"), sample_rate: 44100, duration_ms: 2000 },
        { id: "a", index: 0, audio_base64: Buffer.from("first").toString("base64"), sample_rate: 44100, duration_ms: 1000 },
        { id: "c", index: 2, audio_base64: "", sample_rate: 44100, duration_ms: 0 },
      ],
    }), { status: 200 });
  };
  const out = await requestVoiceDesign("k", { instruction: "i", referenceText: "r", language: "en", n: 3 }, fetchImpl);
  assert.deepEqual(out.map((c) => c.audio.toString()), ["first", "second"]);
  assert.equal(sent!.url, "https://api.fish.audio/v1/voice-design");
  const headers = sent!.init!.headers as Record<string, string>;
  assert.equal(headers.model, "voice-design-1");
  assert.equal(headers.Authorization, "Bearer k");
  assert.deepEqual(Object.keys(JSON.parse(String(sent!.init!.body))).sort(), ["instruction", "language", "n", "reference_text"]);
});

test("requestVoiceDesign surfaces the upstream status; an empty answer is an error", async () => {
  await assert.rejects(
    requestVoiceDesign("k", { instruction: "i", referenceText: "r", language: "en", n: 3 }, async () => new Response("nope", { status: 429 })),
    (err: unknown) => err instanceof FishApiError && err.status === 429,
  );
  await assert.rejects(
    requestVoiceDesign("k", { instruction: "i", referenceText: "r", language: "en", n: 3 }, async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 })),
    (err: unknown) => err instanceof FishApiError && err.status === 502,
  );
});

test("createUnlistedVoice posts an unlisted fast model and returns its id", async () => {
  let form: FormData | null = null;
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    form = init!.body as FormData;
    return new Response(JSON.stringify({ _id: VOICE_ID.toUpperCase(), state: "trained" }), { status: 201 });
  };
  const id = await createUnlistedVoice("k", { title: "Mira", description: "d", audio: Buffer.from("wav"), text: "line", signature: "sig" }, fetchImpl);
  assert.equal(id, VOICE_ID);
  assert.equal(form!.get("visibility"), "unlist");
  assert.equal(form!.get("train_mode"), "fast");
  assert.equal(form!.get("type"), "tts");
  assert.equal(form!.get("texts"), "line");
  assert.equal(form!.get("voice_design_signatures"), "sig");
  assert.ok(form!.get("voices") instanceof Blob);
});

test("createUnlistedVoice rejects a response without a usable id", async () => {
  await assert.rejects(
    createUnlistedVoice("k", { title: "t", description: "d", audio: Buffer.from("w"), text: "x" }, async () => new Response(JSON.stringify({ _id: "short" }), { status: 201 })),
    (err: unknown) => err instanceof FishApiError,
  );
});
