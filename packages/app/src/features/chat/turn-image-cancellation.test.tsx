import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import type { SandboxMessage } from "../../../sandbox/chat/types";
import type { SandboxedYuminaAPI } from "../../../sandbox/sandbox-context";
import { makeChatT } from "../../../sandbox/chat/i18n";
import { TurnImageState } from "../../../sandbox/chat/turn-image-state";

type Message = SandboxMessage;
const store = {
  messages: [] as Message[],
  updateMessage(id: string, update: Partial<Message>) { this.messages = this.messages.map(m => m.id === id ? { ...m, ...update } : m); },
};
const balances: number[] = [];
Object.assign(globalThis, { React, __cancelTestStore: store, __cancelTestBalances: balances });
const vite = await createServer({
  configFile: false, root: fileURLToPath(new URL("../../..", import.meta.url)), appType: "custom", logLevel: "silent",
  resolve: { alias: [
    { find: "@/stores/chat", replacement: "virtual:cancel-store" },
    { find: "@/edition/slots.state", replacement: "virtual:cancel-wallet" },
  ] },
  plugins: [{ name: "cancel-fixtures", resolveId(id) { if (id.startsWith("virtual:cancel-")) return `\0${id}`; }, load(id) {
    if (id === "\0virtual:cancel-store") return "export const useChatStore = { getState: () => globalThis.__cancelTestStore };";
    if (id === "\0virtual:cancel-wallet") return "export const syncCreditsFromMessageResponse = d => globalThis.__cancelTestBalances.push(d.balance); export const handleStreamCreditError = () => {};";
  } }],
  server: { middlewareMode: true, watch: null },
});
const { drawTurnImage, cancelTurnImage } = await vite.ssrLoadModule("/src/features/chat/turn-image-drawing.ts") as typeof import("./turn-image-drawing");
after(async () => { await vite.close(); });
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const response = (data: unknown) => new Response(JSON.stringify({ data }), { headers: { "Content-Type": "application/json" } });
let drawResponse = deferred<Response>(), cancelResponse = deferred<Response>();
let requests: { url: string; body: Record<string, unknown> }[] = [];
beforeEach(() => {
  store.messages = [{ id: "m", sessionId: "s", role: "assistant", content: "Original image", createdAt: "2026-10-19" }];
  balances.length = 0;
  drawResponse = deferred(); cancelResponse = deferred(); requests = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    return url.endsWith("/cancel") ? cancelResponse.promise : drawResponse.promise;
  }) as typeof fetch;
});
const tick = () => new Promise<void>(r => setImmediate(r));
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { assert.ok(Date.now() < deadline, "request did not start"); await tick(); }
}

test("cancel shares one request, keeps the old image, and ignores a late draw balance/content", async () => {
  const drawing = drawTurnImage("m", false);
  await until(() => requests.length === 1);
  const first = cancelTurnImage("m"), second = cancelTurnImage("m");
  await until(() => requests.length === 2);
  assert.equal(requests.filter(r => r.url.endsWith("/cancel")).length, 1);
  assert.equal(requests[0]!.body.drawId, requests[1]!.body.drawId);
  assert.deepEqual(store.messages[0]!.turnImage, { status: "drawing", cancelling: true });
  cancelResponse.resolve(response({ ok: true, status: "cancelled", balance: 100 }));
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  drawResponse.resolve(response({ ok: true, content: "Late picture", balance: 88 }));
  await drawing;
  assert.equal(store.messages[0]!.content, "Original image");
  assert.deepEqual(store.messages[0]!.turnImage, { status: "cancelled" });
  assert.deepEqual(balances, [100]);
});

test("an unconfirmed cancel offers retry while the original request can still complete", async () => {
  const drawing = drawTurnImage("m", false);
  await until(() => requests.length === 1);
  const cancelling = cancelTurnImage("m");
  await until(() => requests.length === 2);
  cancelResponse.resolve(new Response("temporary failure", { status: 503 }));
  assert.equal(await cancelling, false);
  assert.deepEqual(store.messages[0]!.turnImage, { status: "drawing", cancelFailed: true });
  drawResponse.resolve(response({ ok: true, content: "Completed picture" }));
  await drawing;
  assert.equal(store.messages[0]!.content, "Completed picture");
  assert.equal(store.messages[0]!.turnImage, undefined);
});

test("delivery winning the race shows the saved picture and makes no refund claim", async () => {
  const drawing = drawTurnImage("m", false);
  await until(() => requests.length === 1);
  const cancelling = cancelTurnImage("m");
  await until(() => requests.length === 2);
  cancelResponse.resolve(response({ ok: false, status: "completed", content: "Saved picture", balance: 88 }));
  assert.equal(await cancelling, false);
  drawResponse.resolve(response({ ok: true, content: "Saved picture", balance: 88 }));
  await drawing;
  assert.equal(store.messages[0]!.content, "Saved picture");
  assert.equal(store.messages[0]!.turnImage, undefined);
});

test("drawing, cancelling, failed cancellation and cancelled states render the approved controls", () => {
  const api = { cancelTurnImage: async () => true } as unknown as SandboxedYuminaAPI;
  const t = makeChatT("zh");
  const render = (state: Message["turnImage"]) => renderToStaticMarkup(<TurnImageState message={{ ...store.messages[0]!, turnImage: state }} api={api} t={t} />);
  assert.match(render({ status: "drawing" }), /取消生成/);
  assert.match(render({ status: "drawing", cancelling: true }), /disabled=""/);
  assert.match(render({ status: "drawing", cancelFailed: true }), /未确认取消成功/);
  const cancelled = render({ status: "cancelled" });
  assert.match(cancelled, /本次预扣已退回/);
  assert.doesNotMatch(cancelled, /aspect-\[832\/1216\]/);
});
