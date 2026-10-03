import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const memory = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key), clear: () => memory.clear(), key: () => null, length: 0,
};
const vite = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)), configFile: false, appType: "custom", logLevel: "silent",
  resolve: { alias: { "@": fileURLToPath(new URL("..", import.meta.url)) } }, server: { middlewareMode: true },
});
const { useChatStore: chat } = await vite.ssrLoadModule("/src/stores/chat.ts") as typeof import("./chat");
const originalFetch = globalThis.fetch;
after(async () => { globalThis.fetch = originalFetch; await vite.close(); });

test("both rewind actions preserve older-history paging when the server returns a small window", async () => {
  for (const targeted of [false, true]) {
    chat.getState().setSession({ id: "s1", worldId: "w1", state: { variables: {} }, createdAt: "2026-01-01", updatedAt: "2026-01-01" });
    chat.setState({ messages: [], isStreaming: false, readOnly: false, messageTotal: 99,
      hasEarlierMessages: false, isLoadingEarlier: true });
    const state = { variables: { hp: 7 } };
    const messages = [{ id: "m1", role: "assistant", content: "surviving turn", createdAt: "2026-01-01T00:00:00.123456Z" }];
    globalThis.fetch = (async (input, init) => {
      assert.equal(String(input), "/api/sessions/s1/revert");
      assert.equal(init?.method, "POST");
      return Response.json({ data: { state, messages, messageTotal: 21 } });
    }) as typeof fetch;
    if (targeted) await chat.getState().revertToMessage("m1");
    else await chat.getState().revertLastExchange();
    assert.equal(chat.getState().messageTotal, 21);
    assert.equal(chat.getState().hasEarlierMessages, true);
    assert.equal(chat.getState().isLoadingEarlier, false);
    assert.deepEqual(chat.getState().messages, messages);
    assert.deepEqual(chat.getState().gameState, state.variables);
    globalThis.fetch = (async () => Response.json({ data: { state, messages: [], messageTotal: 0 } })) as typeof fetch;
    if (targeted) await chat.getState().revertToMessage("m1");
    else await chat.getState().revertLastExchange();
    assert.equal(chat.getState().messageTotal, 0);
    assert.equal(chat.getState().hasEarlierMessages, false);
  }
});
