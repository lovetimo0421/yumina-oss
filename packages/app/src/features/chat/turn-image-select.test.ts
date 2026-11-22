import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import type { SandboxMessage } from "../../../sandbox/chat/types";

// Stepping between a reply's pictures shows at once and is saved through
// POST /messages/:id/illustrate/select; a refused save puts the reply back.

const store = {
  messages: [] as SandboxMessage[],
  updateMessage(id: string, update: Partial<SandboxMessage>) { this.messages = this.messages.map((m) => (m.id === id ? { ...m, ...update } : m)); },
};
Object.assign(globalThis, { __selectTestStore: store });
const vite = await createServer({
  configFile: false, root: fileURLToPath(new URL("../../..", import.meta.url)), appType: "custom", logLevel: "silent",
  resolve: { alias: [
    { find: "@/stores/chat", replacement: "virtual:select-store" },
    { find: "@/edition/slots.state", replacement: "virtual:select-wallet" },
  ] },
  plugins: [{ name: "select-fixtures", resolveId(id) { if (id.startsWith("virtual:select-")) return `\0${id}`; }, load(id) {
    if (id === "\0virtual:select-store") return "export const useChatStore = { getState: () => globalThis.__selectTestStore };";
    if (id === "\0virtual:select-wallet") return "export const syncCreditsFromMessageResponse = () => {}; export const handleStreamCreditError = () => {};";
  } }],
  server: { middlewareMode: true, watch: null },
});
const { selectTurnImage } = await vite.ssrLoadModule("/src/features/chat/turn-image-drawing.ts") as typeof import("./turn-image-drawing");
after(async () => { await vite.close(); });
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

const k = (name: string) => Buffer.from(`users/u1/turn-images/${name}.jpg`).toString("base64url");
const list = `versions=${k("a")},${k("b")},${k("c")}`;
const showing = (name: string) => `她笑了。\n\n[image:/cdn/key/${k(name)}|alt=scene|${list}]`;
let requests: { url: string; body: Record<string, unknown> }[] = [];
let answer: () => Response;

beforeEach(() => {
  store.messages = [{
    id: "m", sessionId: "s", role: "assistant", content: showing("c"), createdAt: "2026-11-08",
    swipes: [{ content: "older variant" }, { content: showing("c") }], activeSwipeIndex: 1,
  } as SandboxMessage];
  requests = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    return answer();
  }) as typeof fetch;
});

test("picking an older picture shows it at once and saves it for the reload", async () => {
  answer = () => new Response(JSON.stringify({ data: { content: showing("a") } }), { headers: { "Content-Type": "application/json" } });
  const pending = selectTurnImage("m", k("a"), 1);
  assert.equal(await pending, true);
  assert.equal(store.messages[0]!.content, showing("a"));
  assert.equal(store.messages[0]!.swipes?.[1]?.content, showing("a"), "the active variant carries the pick");
  assert.equal(store.messages[0]!.swipes?.[0]?.content, "older variant");
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.url, /\/api\/messages\/m\/illustrate\/select$/);
  assert.deepEqual(requests[0]!.body, { key: k("a"), expectedSwipeIndex: 1 });
});

test("a refused save puts the picture back", async () => {
  answer = () => new Response(JSON.stringify({ error: "changed", code: "TURN_IMAGE_CHANGED" }), { status: 409 });
  assert.equal(await selectTurnImage("m", k("b"), 1), false);
  assert.equal(store.messages[0]!.content, showing("c"));
  assert.equal(store.messages[0]!.swipes?.[1]?.content, showing("c"));
});

test("a picture that isn't the reply's, or a reply still drawing, sends nothing", async () => {
  answer = () => { throw new Error("no request expected"); };
  assert.equal(await selectTurnImage("m", k("elsewhere"), 1), false);
  store.updateMessage("m", { turnImage: { status: "drawing" } });
  assert.equal(await selectTurnImage("m", k("a"), 1), false);
  assert.equal(requests.length, 0);
  assert.equal(store.messages[0]!.content, showing("c"));
});
