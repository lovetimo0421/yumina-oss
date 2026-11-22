import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { transform } from "sucrase";

// A card's "turn on her voice" button: readout only switches on after the player's yes in Yumina's dialog.
const require = createRequire(import.meta.url);
function harness(ttsEnabled: boolean) {
  let profile = { preferences: { ttsEnabled } as Record<string, unknown> };
  const profileStore = {
    getState: () => ({ profile }),
    setState: (next: { profile: typeof profile }) => { profile = next.profile; },
  };
  const deps: Record<string, unknown> = {
    sonner: { toast: { error() {}, info() {} } },
    "@/lib/i18n": { default: { language: "en", t: (_key: string, fallback: string) => fallback } },
    "@/stores/audio": { useAudioStore: { getState: () => ({ voicePlayback: null, stopVoice() {}, setVoicePlayback() {} }) } },
    "@/stores/user-profile": { useUserProfileStore: profileStore },
    "@/stores/chat": { useChatStore: { getState: () => ({ messages: [] }) } },
    "@/lib/tts-stop-signal": { registerTtsHalt() {}, consumeTtsUserStop: () => false },
    "@/lib/tts-card-voice": { resolveCardVoice: () => undefined },
  };
  const module = { exports: {} as typeof import("./tts-playback") };
  const source = readFileSync(new URL("./tts-playback.ts", import.meta.url), "utf8").replaceAll("import.meta.env.VITE_API_URL", '""');
  new Function("require", "module", "exports", transform(source, { transforms: ["typescript", "imports"] }).code)((id: string) => deps[id] ?? require(id), module, module.exports);
  return { ...module.exports, enabled: () => profile.preferences.ttsEnabled === true };
}

test("a card's enable request turns readout on only after the player says yes", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}");
  try {
    const h = harness(false);
    let asked = 0;
    assert.equal(await h.requestTtsEnableFromCard(async () => { asked++; return true; }), true);
    assert.equal(asked, 1);
    assert.equal(h.enabled(), true);
    // already on: no second question
    assert.equal(await h.requestTtsEnableFromCard(async () => { asked++; return true; }), true);
    assert.equal(asked, 1);
  } finally { globalThis.fetch = original; }
});

test("a no leaves readout off and is not asked again right away", async () => {
  const h = harness(false);
  let asked = 0;
  assert.equal(await h.requestTtsEnableFromCard(async () => { asked++; return false; }), false);
  assert.equal(h.enabled(), false);
  assert.equal(await h.requestTtsEnableFromCard(async () => { asked++; return true; }), false);
  assert.equal(asked, 1);
  assert.equal(h.enabled(), false);
});

test("a dialog that fails to open counts as no", async () => {
  const h = harness(false);
  assert.equal(await h.requestTtsEnableFromCard(async () => { throw new Error("no dialog"); }), false);
  assert.equal(h.enabled(), false);
});

test("applyTtsPrefs still never switches readout on by itself", () => {
  const h = harness(false);
  h.applyTtsPrefs({ enabled: true, volume: 50 });
  assert.equal(h.enabled(), false);
});
