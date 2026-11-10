// Exercise the actual orchestration module. Browser stores/toasts are isolated;
// no provider request, account operation or audio playback is performed.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
interface TestBuild {
  onResolve(
    options: {
      filter: RegExp;
    },
    callback: (args: { path: string }) =>
      | {
          path: string;
          namespace: string;
        }
      | undefined,
  ): void;
  onLoad(
    options: {
      filter: RegExp;
      namespace: string;
    },
    callback: (args: { path: string }) => {
      contents: string;
      loader: string;
    },
  ): void;
}
const { build } = createRequire(require.resolve("vite"))("esbuild") as {
  build: (options: {
    entryPoints: string[];
    bundle: boolean;
    platform: string;
    format: string;
    write: boolean;
    define: Record<string, string>;
    plugins: Array<{
      name: string;
      setup: (build: TestBuild) => void;
    }>;
  }) => Promise<{
    outputFiles: Array<{
      text: string;
    }>;
  }>;
};
const stubs: Record<string, string> = {
  sonner: "export const toast=globalThis.__ttsHarness.toast;",
  "@/lib/i18n": 'export default {language:"en",t:(key,fallback)=>fallback};',
  "@/stores/audio": "export const useAudioStore=globalThis.__ttsHarness.audio;",
  "@/stores/user-profile":
    "export const useUserProfileStore={getState:()=>({profile:{preferences:{ttsEnabled:true}}})};",
  "@/stores/chat":
    "export const useChatStore={getState:()=>({messages:[],session:{world:{schema:{}}}})};",
  "@/lib/tts-card-voice": "export const resolveCardVoice=()=>undefined;",
  "@/lib/tts-stop-signal":
    "export const registerTtsHalt=()=>{};export const consumeTtsUserStop=()=>false;",
  "@/edition/slots.state":
    "export const useCreditStore={getState:()=>({fetchCredits(){}})};",
};
const compiled = await build({
  entryPoints: [fileURLToPath(new URL("./tts-playback.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  define: { "import.meta.env.VITE_API_URL": '""' },
  plugins: [
    {
      name: "isolated-browser-stores",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) =>
          args.path in stubs
            ? { path: args.path, namespace: "test-store" }
            : undefined,
        );
        build.onLoad({ filter: /.*/, namespace: "test-store" }, (args) => ({
          contents: stubs[args.path],
          loader: "js",
        }));
      },
    },
  ],
});
function harness(t: TestContext) {
  const playback: {
    key: string;
    status: string;
  } | null = null;
  const plays: string[] = [],
    toasts: string[] = [],
    requests: Array<{
      signal?: AbortSignal;
      resolve: (response: Response) => void;
    }> = [];
  const state = {
    voicePlayback: playback,
    setVoicePlayback() {},
    stopVoice() {},
    playVoice(key: string) {
      plays.push(key);
    },
  };
  const globals = globalThis as unknown as Record<string, unknown>,
    previous = globals.__ttsHarness;
  globals.__ttsHarness = {
    toast: { error: (message: string) => toasts.push(message), info() {} },
    audio: { getState: () => state, subscribe() {} },
  };
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, opts?: RequestInit) =>
      new Promise<Response>((resolve) =>
        requests.push({ signal: opts?.signal ?? undefined, resolve }),
      ),
  );
  const module = { exports: {} };
  new Function("module", "exports", "require", compiled.outputFiles![0]!.text)(
    module,
    module.exports,
    require,
  );
  const api = module.exports as {
    speakMessage: (
      sid: string,
      opts: {
        text: string;
        key: string;
      },
    ) => Promise<{
      ok: boolean;
      reason?: string;
    }>;
    previewVoice: (
      voice: string,
      lang: string,
    ) => Promise<{
      ok: boolean;
      reason?: string;
    }>;
    stopSpeaking: () => void;
  };
  t.after(() => {
    api.stopSpeaking();
    globals.__ttsHarness = previous;
  });
  return { api, requests, plays, toasts };
}
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
const response = () =>
  new Response(JSON.stringify({ url: "/cdn/tts/test", credits: 0 }), {
    headers: { "Content-Type": "application/json" },
  });
test("stop before the lazy chat-store await prevents the obsolete synth request", async (t) => {
  const h = harness(t),
    reply = h.api.speakMessage("fixture", { text: "Hello.", key: "hat-old" });
  h.api.stopSpeaking();
  await flush();
  assert.equal(h.requests.length, 0);
  assert.equal((await reply).ok, false);
  assert.deepEqual(h.plays, []);
});
test("stop aborts the in-flight synth and a late successful response cannot play", async (t) => {
  const h = harness(t),
    reply = h.api.speakMessage("fixture", { text: "Hello.", key: "hat-old" });
  await flush();
  assert.equal(h.requests.length, 1);
  h.api.stopSpeaking();
  assert.equal(h.requests[0]!.signal?.aborted, true);
  h.requests[0]!.resolve(response());
  assert.equal((await reply).ok, false);
  assert.deepEqual(h.plays, []);
  assert.deepEqual(h.toasts, []);
});
test("replacement aborts the old request and only the newest key may start playback", async (t) => {
  const h = harness(t),
    first = h.api.speakMessage("fixture", { text: "First.", key: "hat-old" });
  await flush();
  const second = h.api.speakMessage("fixture", {
    text: "Second.",
    key: "hat-new",
  });
  await flush();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0]!.signal?.aborted, true);
  h.requests[0]!.resolve(response());
  h.requests[1]!.resolve(response());
  assert.equal((await first).ok, false);
  assert.equal((await second).ok, true);
  assert.deepEqual(h.plays, ["hat-new"]);
});
test("a voice-picker preview is also aborted by stop and cannot replay late", async (t) => {
  const h = harness(t),
    reply = h.api.previewVoice("", "en");
  await flush();
  h.api.stopSpeaking();
  assert.equal(h.requests[0]!.signal?.aborted, true);
  h.requests[0]!.resolve(response());
  assert.equal((await reply).ok, false);
  assert.deepEqual(h.plays, []);
  assert.deepEqual(h.toasts, []);
});
test("manual synthesis replaces an in-flight preview without obsolete audio", async (t) => {
  const h = harness(t),
    preview = h.api.previewVoice("", "en");
  await flush();
  const manual = h.api.speakMessage("fixture", {
    text: "New.",
    key: "hat-new",
  });
  await flush();
  assert.equal(h.requests[0]!.signal?.aborted, true);
  h.requests[0]!.resolve(response());
  h.requests[1]!.resolve(response());
  assert.equal((await preview).ok, false);
  assert.equal((await manual).ok, true);
  assert.deepEqual(h.plays, ["hat-new"]);
});
