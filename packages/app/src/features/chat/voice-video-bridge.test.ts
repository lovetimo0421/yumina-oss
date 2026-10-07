import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as voiceSDK from "../../../sandbox/voice-api";
import { wrapMessage, unwrapMessage, type SessionChannelData, type UIChannelData } from "../../../sandbox/protocol";

function bitmap() {
  let closes = 0;
  return { width: 640, height: 360, close() { closes++; }, get closes() { return closes; } };
}

test("voice frame dispatcher delivers synchronously, closes and acknowledges even a failed consumer", () => {
  const dispatch = (voiceSDK as Record<string, unknown>).dispatchVoiceEvent;
  assert.equal(typeof dispatch, "function", "Transferred frames require a dispatcher that owns their lifetime.");
  const send = dispatch as (event: unknown, options: unknown) => void;
  const frame = bitmap(), order: string[] = [];
  send({ type: "video-frame", id: 7, frame }, {
    available: true,
    target: { dispatchEvent(event: CustomEvent) { assert.equal(event.detail.frame.closes, 0); order.push("copy"); throw new Error("consumer failed"); } },
    post(method: string, args: number[]) { assert.equal(frame.closes, 1); assert.equal(method, "realtimeVoice.ackVideoFrame"); assert.deepEqual(args, [7]); order.push("ack"); },
  });
  assert.deepEqual(order, ["copy", "ack"]);
  assert.equal(frame.closes, 1);
  const discarded = bitmap();
  send({ type: "video-frame", id: 8, frame: discarded }, { available: false, target: { dispatchEvent() { assert.fail("Disabled sessions cannot receive video"); } }, post() {} });
  assert.equal(discarded.closes, 1);
  const noListener = bitmap();
  send({ type: "video-frame", id: 9, frame: noListener }, { available: true, target: new EventTarget(), post() {} });
  assert.equal(noListener.closes, 1, "Unsubscribed frames still release their transferable resource.");
});

test("voice SDK passes explicit avatar opt-in, rejects malformed opt-in and suppresses read-only listeners", async () => {
  const calls: unknown[] = [], target = new EventTarget();
  const options = { available: true, target, post() {}, call: async (_method: string, args: unknown[]) => { calls.push(args[0]); return { status: "connected" } as never; } };
  const api = voiceSDK.createVoiceAPI(options);
  await api.start({ instructions: "Character", avatar: true } as never);
  assert.deepEqual(calls, [{ instructions: "Character", avatar: true }]);
  await assert.rejects(api.start({ instructions: "Character", avatar: "true" } as never), /avatar/i);
  let received = false;
  voiceSDK.createVoiceAPI({ ...options, available: false }).onEvent(() => { received = true; });
  target.dispatchEvent(new CustomEvent(voiceSDK.VOICE_EVENT, { detail: { type: "video-status", status: "live" } }));
  assert.equal(received, false);
});

test("parent bridge transfers one bitmap, rejects foreign/stale acks, and closes unavailable frames without queueing or JSON fallback", async () => {
  const dom = new JSDOM('<iframe></iframe>', { url: "https://yumina.test" });
  const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.assign(globalThis, { window: dom.window });
  const { SandboxBridge } = await import("../sandbox/bridge-parent");
  const iframe = dom.window.document.querySelector("iframe")!;
  const sent: { message: unknown; transfer?: Transferable[] }[] = [], acknowledgements: unknown[][] = [];
  let failTransfer = false, transferAttempts = 0;
  iframe.contentWindow!.postMessage = ((message: unknown, _origin: string, transfer?: Transferable[]) => {
    if (transfer) { transferAttempts++; if (failTransfer) throw new DOMException("Cannot transfer", "DataCloneError"); }
    sent.push({ message: unwrapMessage(message), transfer });
  }) as typeof window.postMessage;
  const bridge = new SandboxBridge({ onApiCall(method, args) { if (method === "realtimeVoice.ackVideoFrame") acknowledgements.push(args); } });
  const receive = (data: unknown, source = iframe.contentWindow) => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: wrapMessage(data), source, origin: "null" }));
  const sendFrame = (id: number) => { const frame = bitmap(); bridge.sendVoiceEvent({ type: "video-frame", id, frame } as never); return frame; };
  const ack = (id: unknown, source = iframe.contentWindow) => receive({ type: "api-call", callId: "fire-video", method: "realtimeVoice.ackVideoFrame", args: [id] }, source);
  try {
    bridge.attach(iframe);
    const early = sendFrame(0);
    assert.equal(early.closes, 1, "Frames must never wait in the message queue.");
    receive({ type: "ready", protocolVersion: 2 });
    bridge.pushChannel("session", { sessionId: "one" } as SessionChannelData, 1);
    bridge.pushChannel("ui", { readOnly: false } as UIChannelData, 1);
    bridge.installRoot("root.tsx", {}, undefined, undefined, "session");
    const first = sendFrame(1);
    assert.equal(first.closes, 0, "Transfer hands ownership to the sandbox.");
    assert.deepEqual(sent.at(-1)?.transfer, [first]);
    assert.equal((sent.at(-1)?.message as { sessionId?: string }).sessionId, "one");
    const blocked = sendFrame(2); assert.equal(blocked.closes, 1);
    assert.equal(transferAttempts, 1);
    ack(1, dom.window as unknown as Window); ack(NaN); ack(1.5); ack("1"); ack(99);
    assert.equal(sendFrame(3).closes, 1, "Invalid/foreign acks cannot free the outstanding frame.");
    ack(1); assert.deepEqual(acknowledgements.at(-1), [1]);
    failTransfer = true; const failed = sendFrame(4); assert.equal(failed.closes, 1);
    assert.equal(transferAttempts, 2, "Failed transfers have no JSON retry.");
    failTransfer = false; sendFrame(5);
    bridge.pushChannel("session", { sessionId: "two" } as SessionChannelData, 2);
    const count = acknowledgements.length; ack(5); assert.equal(acknowledgements.length, count, "Old-session acks cannot touch new playback.");
    bridge.pushChannel("ui", { readOnly: true } as UIChannelData, 2);
    assert.equal(sendFrame(6).closes, 1);
    bridge.pushChannel("ui", { readOnly: false, capabilities: { canUseSessionApis: false } } as UIChannelData, 3);
    assert.equal(sendFrame(8).closes, 1, "Session API capability gates frame delivery.");
    bridge.pushChannel("ui", { readOnly: false, mode: "guest-preview" } as UIChannelData, 4);
    assert.equal(sendFrame(9).closes, 1, "Guest previews cannot consume live-session video.");
    bridge.pushChannel("ui", { readOnly: false, mode: "session" } as UIChannelData, 5);
    bridge.setMediaSuspended(true);assert.equal(sendFrame(10).closes, 1);
    bridge.destroy(); assert.equal(sendFrame(7).closes, 1);
  } finally {
    bridge.destroy(); dom.window.close();
    if (saved) Object.defineProperty(globalThis, "window", saved); else Reflect.deleteProperty(globalThis, "window");
  }
});
