import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { act, createElement, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";
import { VoiceController, dispatchVoiceCall } from "./voice-controller";
import type { VoiceDependencies } from "./voice-controller";
import type { VoiceEvent } from "../../../sandbox/voice-types";
import type { useWorldVoice as Hook } from "./use-world-voice";

for (const direct of [false, true]) test(`host ${direct ? "direct intent" : "consent"} lifecycle cancels on hide, session change, capability loss and unmount`, async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  let mediaCalls = 0, audioCreated = 0, audioClosed = 0, stopped = 0;
  let resolveMedia!: (stream: MediaStream) => void;
  const stream = { getTracks: () => [{ stop() { stopped++; } }] } as unknown as MediaStream;
  const globals = { window: dom.window, document: dom.window.document,
    navigator: { userActivation: { isActive: true }, mediaDevices: { getUserMedia: () => { mediaCalls++; return new Promise<MediaStream>(resolve => { resolveMedia = resolve; }); } } },
    fetch: async () => Response.json({ turnControl: "client-v1", available: true, funding: "testing", maxDurationSeconds: 300 }),
    IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const require = createRequire(import.meta.url), module = { exports: {} as { useWorldVoice: typeof Hook } };
  const source = readFileSync(new URL("./use-world-voice.ts", import.meta.url), "utf8").replace("import.meta.env?.VITE_API_URL", '""');
  const emitters: ((event: VoiceEvent) => void)[] = [];
  class ObservedController extends VoiceController {
    constructor(emit: (event: VoiceEvent) => void, deps: VoiceDependencies) { super(emit, deps); emitters.push(emit); }
  }
  const mocks: Record<string, unknown> = {
    "./avatar-voice-audio": { createAvatarVoiceAudio: () => { throw Error("Avatar was not requested"); } },
    "./voice-controller": { VoiceController: ObservedController, dispatchVoiceCall },
    "./voice-audio": { createVoiceAudio: () => { audioCreated++; return { attachInput() {}, attach() {}, setMuted() {}, setSpatial() {}, close() { audioClosed++; } }; } },
  };
  new Function("require", "module", "exports", transform(source, { transforms: ["typescript", "imports"] }).code)((id: string) => mocks[id] ?? require(id), module, module.exports);
  let voice!: ReturnType<typeof Hook>;
  const delivered: { session: string; event: VoiceEvent }[] = [];
  function Harness(props: { sessionId: string; enabled: boolean }) {
    voice = module.exports.useWorldVoice({ ...props, onEvent(event) { delivered.push({ session: props.sessionId, event }); } });
    useLayoutEffect(() => {
      if (props.sessionId === "B") emitters[0]?.({ type: "transcript", role: "user", id: "user:old:0", text: "From session A", final: true });
      if (!props.enabled) emitters.at(-1)?.({ type: "transcript", role: "user", id: "user:revoked:0", text: "After capability loss", final: true });
    }, [props.sessionId, props.enabled]);
    return null;
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  let mounted = true;
  const render = (sessionId = "A", enabled = true) => root.render(createElement(Harness, { sessionId, enabled }));
  try {
    await act(async () => render());
    let pending!: Promise<unknown>, rejection!: Promise<void>;
    const start = async () => act(async () => {
      const prepared = direct ? await voice.call("realtimeVoice.prepare", [{}]) as { intent: string } : {};
      pending = voice.call("realtimeVoice.start", [{ instructions: "Ask a question.", ...prepared }]) as Promise<unknown>;
      rejection = assert.rejects(pending, /stopped/i);
    });
    if (direct) {
      // No start yet: session changes while the card is saving/resolving context.
      for (const transition of ["stop", "hide", "session", "capability"] as const) {
        await act(async () => render("A", true));
        const staleCall = voice.call;
        let prepared!: { intent: string };
        await act(async () => { prepared = await voice.call("realtimeVoice.prepare", [{}]) as { intent: string }; });
        assert.equal(mediaCalls, 0); assert.equal(voice.consent, null);
        await act(async () => {
          if (transition === "stop") voice.stop();
          if (transition === "session") render("B", true);
          if (transition === "capability") render("A", false);
          if (transition === "hide") {
            Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, value: "hidden" });
            dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
          }
        });
        Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, value: "visible" });
        await act(async () => { await assert.rejects(staleCall("realtimeVoice.start", [{ instructions: "late context", ...prepared }]) as Promise<unknown>, /expired|unavailable/i); });
        assert.equal(mediaCalls, 0); assert.equal(audioClosed, audioCreated);
      }
      delivered.length = 0;
      await act(async () => render("A", true));
    }
    await start(); assert.equal(!!voice.consent, !direct); assert.equal(mediaCalls, direct ? 1 : 0);
    await act(async () => {
      Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, value: "hidden" });
      dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    });
    await rejection; assert.equal(voice.consent, null);
    if (direct) await act(async () => resolveMedia(stream));
    Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, value: "visible" });
    for (const transition of ["capability", "session", "unmount"] as const) {
      await act(async () => render("A", true));
      await start();
      if (!direct) await act(async () => voice.consent!.accept());
      assert.equal(voice.consent, null);
      await act(async () => {
        if (transition === "capability") render("A", false);
        if (transition === "session") render("B", true);
        if (transition === "unmount") { root.unmount(); mounted = false; }
      });
      await rejection;
      assert.equal(delivered.some(item => item.session === "B"), false, "old transcripts and cleanup status never reach the new session before passive cleanup");
      assert.equal(delivered.some(item => item.event.type === "transcript" && item.event.id === "user:revoked:0"), false, "capability revocation fences payloads before passive cleanup");
      await act(async () => resolveMedia(stream));
      assert.equal(stopped, mediaCalls, "late browser permission is released");
      assert.equal(audioClosed, audioCreated);
    }
  } finally {
    if (mounted) await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
