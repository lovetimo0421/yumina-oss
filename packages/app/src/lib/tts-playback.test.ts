import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test, { mock } from "node:test";
import { transform } from "sucrase";

const require = createRequire(import.meta.url);
type Result = { ok: boolean; reason?: string };
function harness() {
  let finish: ((result: Result) => void) | undefined;
  let state: unknown = null;
  const played: Array<{ key: string; url: string; opts: unknown }> = [];
  const store = { getState: () => ({
    get voicePlayback() { return state; },
    setVoicePlayback(value: unknown) { state = value; },
    stopVoice() { state = null; finish?.({ ok: false, reason: "cancelled" }); finish = undefined; },
    playVoice(key: string, url: string, opts?: unknown) {
      played.push({ key, url, opts });
      return new Promise<Result>((resolve) => { finish = resolve; });
    },
  }) };
  const deps: Record<string, unknown> = {
    sonner: { toast: { error() {}, info() {} } },
    "@/lib/i18n": { default: { language: "en", t: (_key: string, fallback: string) => fallback } },
    "@/stores/audio": { useAudioStore: store },
    "@/stores/user-profile": { useUserProfileStore: { getState: () => ({ profile: { preferences: { ttsEnabled: true } } }) } },
    "@/stores/chat": { useChatStore: { getState: () => ({ messages: [] }) } },
    "@/lib/tts-stop-signal": { registerTtsHalt() {}, consumeTtsUserStop: () => false },
    "@/lib/tts-card-voice": { resolveCardVoice: () => undefined },
  };
  const module = { exports: {} as typeof import("./tts-playback") };
  const source = readFileSync(new URL("./tts-playback.ts", import.meta.url), "utf8").replaceAll("import.meta.env.VITE_API_URL", '""');
  new Function("require", "module", "exports", transform(source, { transforms: ["typescript", "imports"] }).code)((id: string) => deps[id] ?? require(id), module, module.exports);
  return { ...module.exports, played, finish(result: Result) { finish?.(result); }, state: () => state };
}
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

test("opt-in speak waits for actual clip completion; ordinary speak returns once queued", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ url: "/clip.mp3" }));
  const h = harness();
  try {
    let settled = false;
    const receipt = h.speakMessage("session", { text: "Test", waitForEnd: true }).then(result => { settled = true; return result; });
    await flush();
    assert.equal(h.played.length, 1);
    assert.equal((h.played[0]!.opts as { measureLevel?: boolean }).measureLevel, true);
    assert.equal(settled, false);
    h.finish({ ok: true });
    assert.deepEqual(await receipt, { ok: true });
    assert.deepEqual(await h.speakMessage("session", { text: "Ordinary" }), { ok: true });
  } finally { h.stopSpeaking(); globalThis.fetch = original; }
});

test("opt-in speak stops a clip sequence on playback rejection", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ segments: [{ url: "/first.mp3" }, { url: "/second.mp3" }] }));
  const h = harness();
  try {
    const receipt = h.speakMessage("session", { text: "Test", waitForEnd: true });
    await flush();
    h.finish({ ok: false, reason: "playback-blocked" });
    assert.deepEqual(await receipt, { ok: false, reason: "playback-blocked" });
    assert.equal(h.played.length, 1);
  } finally { h.stopSpeaking(); globalThis.fetch = original; }
});

test("stop cancels synthesis immediately and ignores a late response", async () => {
  const original = globalThis.fetch;
  let release!: (res: Response) => void;
  globalThis.fetch = () => new Promise(resolve => { release = resolve; });
  const h = harness();
  try {
    const receipt = h.speakMessage("session", { text: "Test", waitForEnd: true });
    await flush();
    h.stopSpeaking();
    assert.deepEqual(await receipt, { ok: false, reason: "cancelled" });
    release(new Response(JSON.stringify({ url: "/late.mp3" })));
    await flush();
    assert.equal(h.played.length, 0);
  } finally { h.stopSpeaking(); globalThis.fetch = original; }
});

test("opt-in synthesis has a host deadline and releases its loading state", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const original = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => {});
  const h = harness();
  try {
    const receipt = h.speakMessage("session", { text: "Test", waitForEnd: true });
    await flush();
    mock.timers.tick(150_001);
    assert.deepEqual(await receipt, { ok: false, reason: "timeout" });
    assert.equal(h.state(), null);
  } finally { h.stopSpeaking(); globalThis.fetch = original; mock.timers.reset(); }
});

test("a cancelled response body cannot clear the replacement line's loading state", async () => {
  const original = globalThis.fetch;
  let releaseBody!: (body: unknown) => void;
  let calls = 0;
  globalThis.fetch = async () => {
    if (calls++ === 0) return { ok: true, status: 200, json: () => new Promise(resolve => { releaseBody = resolve; }) } as Response;
    return new Promise<Response>(() => {});
  };
  const h = harness();
  try {
    const first = h.speakMessage("session", { text: "Old", key: "old", waitForEnd: true });
    await flush();
    const second = h.speakMessage("session", { text: "New", key: "new", waitForEnd: true });
    await flush();
    assert.deepEqual(await first, { ok: false, reason: "cancelled" });
    releaseBody({});
    await flush();
    assert.deepEqual(h.state(), { key: "new", status: "loading" });
    h.stopSpeaking();
    assert.deepEqual(await second, { ok: false, reason: "cancelled" });
  } finally { h.stopSpeaking(); globalThis.fetch = original; }
});
