import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { mock } from "node:test";
import { transform } from "sucrase";

function harness(opts: { resume?: "reject" | "pending"; context?: boolean; deny?: boolean; permission?: "pending" } = {}) {
  const previous = new Map(["window", "navigator", "MediaRecorder"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let stops = 0, resumes = 0, closes = 0, starts = 0;
  const permissions: Array<(stream: unknown) => void> = [];
  const stream = () => ({ getTracks: () => [{ stop() { stops++; } }] });
  class Context {
    state = "suspended";
    resume() {
      resumes++;
      if (opts.resume === "reject") return Promise.reject(new Error("blocked"));
      if (opts.resume === "pending") return new Promise<void>(() => {});
      this.state = "running"; return Promise.resolve();
    }
    async close() { closes++; this.state = "closed"; }
    createAnalyser() { return { fftSize: 512, getByteTimeDomainData(buf: Uint8Array) { buf.fill(144); }, disconnect() {} }; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  }
  class Recorder {
    static isTypeSupported() { return true; }
    state = "inactive";
    mimeType = "audio/webm";
    onstop?: () => void;
    onerror?: () => void;
    start() { starts++; this.state = "recording"; }
    stop() { this.state = "inactive"; this.onstop?.(); }
  }
  Object.defineProperty(globalThis, "window", { configurable: true, value: { AudioContext: opts.context === false ? undefined : Context } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { async getUserMedia() {
    if (opts.deny) throw new DOMException("Denied", "NotAllowedError");
    if (opts.permission === "pending") return new Promise(resolve => permissions.push(resolve));
    return stream();
  } } } });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: Recorder });
  const modules: Record<string, unknown> = {
    sonner: { toast: { error() {}, info() {} } },
    "@/lib/i18n": { default: { language: "en", t: (_key: string, fallback: string) => fallback } },
    "@/lib/tts-stop-signal": { haltTts() {} },
  };
  const module = { exports: {} as typeof import("./voice-input") };
  const source = readFileSync(new URL("./voice-input.ts", import.meta.url), "utf8").replaceAll("import.meta.env.VITE_API_URL", '""');
  new Function("require", "module", "exports", transform(source, { transforms: ["typescript", "imports"] }).code)((id: string) => {
    assert.ok(modules[id], `Unexpected dependency ${id}`); return modules[id];
  }, module, module.exports);
  return { ...module.exports, grant(index: number) { permissions[index]!(stream()); }, stats: () => ({ stops, resumes, closes, starts }), restore() {
    module.exports.cancelVoiceRecording();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  } };
}
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

test("voice preparation resumes and validates levels then releases the mic without recording", async () => {
  const h = harness();
  try {
    assert.equal(typeof h.prepareVoiceInput, "function");
    assert.deepEqual(await h.prepareVoiceInput({ requireLevels: true }), { ok: true });
    assert.deepEqual(h.stats(), { resumes: 1, closes: 1, stops: 1, starts: 0 });
  } finally { h.restore(); }
});

test("required microphone levels fail explicitly when context resume is blocked", async () => {
  const h = harness({ resume: "reject" });
  try {
    assert.deepEqual(await h.recordVoice(() => {}, { requireLevels: true }), { ok: false, reason: "levels-unavailable" });
    assert.deepEqual(h.stats(), { resumes: 1, closes: 1, stops: 1, starts: 0 });
  } finally { h.restore(); }
});

test("recording delivers actual levels after resume and cancellation releases every resource", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const h = harness();
  const levels: number[] = [];
  try {
    const result = h.recordVoice(level => levels.push(level), { requireLevels: true });
    await flush(); mock.timers.tick(70);
    assert.equal(h.stats().resumes, 1);
    assert.equal(levels.at(-1), 0.5);
    h.cancelVoiceRecording();
    assert.deepEqual(await result, { ok: false, reason: "cancelled" });
    assert.deepEqual(h.stats(), { resumes: 1, closes: 1, stops: 1, starts: 1 });
  } finally { h.restore(); mock.timers.reset(); }
});

test("ordinary hold-to-talk can record when analysis is unavailable", async () => {
  const h = harness({ context: false });
  try {
    const result = h.recordVoice(() => {});
    await flush(); assert.equal(h.stats().starts, 1);
    h.cancelVoiceRecording();
    assert.deepEqual(await result, { ok: false, reason: "cancelled" });
  } finally { h.restore(); }
});

test("ordinary hold-to-talk starts without waiting for a suspended waveform context", async () => {
  const h = harness({ resume: "pending" });
  try {
    const result = h.recordVoice(() => {});
    await flush();
    assert.equal(h.stats().starts, 1);
    h.cancelVoiceRecording();
    assert.deepEqual(await result, { ok: false, reason: "cancelled" });
  } finally { h.restore(); }
});

test("a suspended analyser has a bounded readiness deadline and can be cancelled", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = harness({ resume: "pending" });
  try {
    assert.equal(typeof h.prepareVoiceInput, "function");
    const result = h.prepareVoiceInput({ requireLevels: true });
    await flush(); mock.timers.tick(10_001);
    assert.deepEqual(await result, { ok: false, reason: "levels-unavailable" });
    const cancelled = h.prepareVoiceInput({ requireLevels: true });
    await flush(); h.cancelVoiceRecording();
    assert.deepEqual(await cancelled, { ok: false, reason: "cancelled" });
    assert.deepEqual(h.stats(), { resumes: 2, closes: 2, stops: 2, starts: 0 });
  } finally { h.restore(); mock.timers.reset(); }
});

test("cancelling pending permission settles immediately and a late grant cannot disturb a retry", async () => {
  const h = harness({ permission: "pending" });
  try {
    const first = h.prepareVoiceInput({ requireLevels: true });
    h.cancelVoiceRecording();
    const retry = h.prepareVoiceInput({ requireLevels: true });
    let firstResult: unknown;
    void first.then(result => { firstResult = result; });
    await flush();
    assert.deepEqual(firstResult, { ok: false, reason: "cancelled" });
    h.grant(0);
    await flush();
    assert.equal(h.stats().stops, 1, "release the superseded permission grant");
    assert.equal(h.stats().resumes, 0, "the old request must never open an analyser");
    h.grant(1);
    assert.deepEqual(await retry, { ok: true });
    assert.deepEqual(h.stats(), { stops: 2, resumes: 1, closes: 1, starts: 0 });
  } finally { h.restore(); }
});
