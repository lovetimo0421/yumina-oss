import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { saveTranscriptPosition, loadTranscriptPosition } from "../../lib/transcript-position-storage";
import { wrapMessage, unwrapMessage } from "../../../sandbox/protocol";

test("bridge restores only this account/session and rejects foreign checkpoint senders", async () => {
  const dom = new JSDOM('<iframe></iframe>', { url: "https://yumina.test" });
  const keys = ["window", "sessionStorage"] as const;
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, sessionStorage: dom.window.sessionStorage });
  const { SandboxBridge } = await import("../sandbox/bridge-parent");
  const iframe = dom.window.document.querySelector("iframe")!;
  const sent: unknown[] = [];
  iframe.contentWindow!.postMessage = ((message: unknown) => { sent.push(message); }) as typeof window.postMessage;
  const position = { version: 1 as const, sessionId: "s1", mode: "reading" as const,
    anchorId: "m100", offset: -20, top: 1000, expanded: true, loadedCount: 400 };
  saveTranscriptPosition("account", position);
  const bridge = new SandboxBridge({ onApiCall: () => undefined });
  const receive = (data: unknown, source = iframe.contentWindow, origin = "null") => {
    dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: wrapMessage(data), source, origin }));
  };
  try {
    bridge.attach(iframe);
    bridge.restoreTranscriptPosition("account", "s1");
    receive({ type: "ready", protocolVersion: 2 });
    assert.ok(sent.some((message) => JSON.stringify(unwrapMessage(message)) === JSON.stringify({ type: "restore-transcript-position", position })));
    const moved = { ...position, top: 1300 };
    receive({ type: "transcript-position", position: moved }, dom.window as unknown as Window);
    receive({ type: "transcript-position", position: moved }, iframe.contentWindow, "https://evil.test");
    receive({ type: "transcript-position", position: { ...moved, sessionId: "stale" } });
    assert.equal(loadTranscriptPosition("account", "s1")?.top, 1000);
    receive({ type: "transcript-position", position: moved });
    assert.equal(loadTranscriptPosition("account", "s1")?.top, 1300);
    assert.equal(loadTranscriptPosition("another-account", "s1"), null);
  } finally {
    bridge.destroy(); dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
