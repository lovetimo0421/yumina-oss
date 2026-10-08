import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => memory.set(key, value),
  removeItem: (key: string) => memory.delete(key),
} });
const vite = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)), configFile: false,
  appType: "custom", logLevel: "silent", server: { middlewareMode: true },
  resolve: { alias: { "@": fileURLToPath(new URL("..", import.meta.url)) } },
});
const { useChatStore: chat } = await vite.ssrLoadModule("/src/stores/chat.ts") as typeof import("./chat");
const { useAudioStore: audio } = await vite.ssrLoadModule("/src/stores/audio.ts") as typeof import("./audio");
const originalFetch = globalThis.fetch;
after(async () => { globalThis.fetch = originalFetch; await vite.close(); });

test("a newly visible session already has its opening audio registered", async () => {
  chat.setState({ session: null }); audio.setState({ tracks: [] });
  const track = { id: "onepiece-opening-theme", type: "bgm", url: "https://example.test/opening.mp3", preload: false };
  globalThis.fetch = async () => Response.json({ data: {
    id: "new-voyage", worldId: "onepiece", state: { variables: {} }, messages: [],
    world: { schema: { audioTracks: [track] } },
  } });
  const seen: string[][] = [];
  const unsubscribe = chat.subscribe(state => {
    if (state.session?.id === "new-voyage") seen.push(audio.getState().tracks.map(item => item.id));
  });
  try { await chat.getState().loadSession("new-voyage"); }
  finally { unsubscribe(); }
  assert.ok(seen.length > 0, "session was exposed to renderers");
  assert.deepEqual(seen[0], [track.id], "mount-time playAudio must not be dropped on a cold load");
});

test("a world without tracks does not inherit the previous world's registry", async () => {
  globalThis.fetch = async () => Response.json({ data: {
    id: "quiet-voyage", worldId: "quiet", state: { variables: {} }, messages: [], world: { schema: {} },
  } });
  let seen: string[] | undefined;
  const unsubscribe = chat.subscribe(state => {
    if (state.session?.id === "quiet-voyage") seen = audio.getState().tracks.map(item => item.id);
  });
  try { await chat.getState().loadSession("quiet-voyage"); }
  finally { unsubscribe(); }
  assert.deepEqual(seen, []);
});
