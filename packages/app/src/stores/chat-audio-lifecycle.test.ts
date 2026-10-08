import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const vite = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  configFile: false, appType: "custom", logLevel: "silent",
  resolve: { alias: { "@": fileURLToPath(new URL("..", import.meta.url)) } },
  server: { middlewareMode: true },
});
const { useChatStore } = await vite.ssrLoadModule("/src/stores/chat.ts") as typeof import("./chat");
const { useAudioStore } = await vite.ssrLoadModule("/src/stores/audio.ts") as typeof import("./audio");
after(() => vite.close());

function sessionResponse() {
  return Response.json({ data: {
    id: "audio-session", worldId: "audio-world", messages: [], state: { variables: {} },
    world: { schema: {
      audioTracks: [{ id: "bgm", name: "BGM", url: "/music.mp3", type: "bgm", preload: false }],
      bgmPlaylist: { tracks: ["bgm"], playMode: "loop", autoPlay: true },
    } },
  } });
}

test("a world response arriving after exit updates data without resurrecting audio", async t => {
  useChatStore.setState({ session: null });
  useAudioStore.getState().cleanup();
  const plays: string[] = [];
  const originalPlay = useAudioStore.getState().playTrack;
  useAudioStore.setState({ playTrack: id => { plays.push(id); } });
  t.after(() => { useAudioStore.getState().cleanup(); useAudioStore.setState({ playTrack: originalPlay }); });
  let finish!: (value: Response) => void;
  t.mock.method(globalThis, "fetch", () => new Promise<Response>(resolve => { finish = resolve; }));
  const pending = useChatStore.getState().loadSession("audio-session");
  useAudioStore.getState().cleanup(); // ChatView left while the request was in flight.
  finish(sessionResponse());
  await pending;
  assert.equal(useChatStore.getState().session?.id, "audio-session");
  assert.deepEqual(plays, []);
  assert.equal(useAudioStore.getState().tracks.length, 0);
  assert.equal(useAudioStore.getState().playlist, null);

  // Returning to the world starts a fresh load in the current audio scope.
  t.mock.method(globalThis, "fetch", async () => sessionResponse());
  await useChatStore.getState().loadSession("audio-session");
  assert.deepEqual(plays, ["bgm"]);
});

test("returning before the first response loads fresh audio and ignores the old response", async t => {
  useChatStore.setState({ session: null });
  useAudioStore.getState().cleanup();
  const plays: string[] = [];
  const originalPlay = useAudioStore.getState().playTrack;
  useAudioStore.setState({ playTrack: id => { plays.push(id); } });
  t.after(() => { useAudioStore.getState().cleanup(); useAudioStore.setState({ playTrack: originalPlay }); });
  const requests: Array<(value: Response) => void> = [];
  t.mock.method(globalThis, "fetch", () => new Promise<Response>(resolve => { requests.push(resolve); }));
  const initial = useChatStore.getState().loadSession("audio-session");
  useAudioStore.getState().cleanup();
  const returned = useChatStore.getState().loadSession("audio-session");
  requests[1]!(sessionResponse());
  await returned;
  requests[0]!(sessionResponse());
  await initial;
  assert.deepEqual(plays, ["bgm"]);
  assert.deepEqual(useAudioStore.getState().tracks.map(track => track.id), ["bgm"]);
});
