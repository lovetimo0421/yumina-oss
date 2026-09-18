import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { filterAiAudioEffects } from "@yumina/engine";

// ── Browser globals the audio store touches at runtime ──
// Minimal HTMLAudioElement stand-in: enough surface for playTrack/stopTrack.
const created: FakeAudio[] = [];
const playOutcomes: Array<"resolve" | "reject"> = [];
const documentListeners: Record<string, Array<() => void>> = {};
const preloadHints: unknown[] = [];
class FakeAudio {
  src: string;
  volume = 1;
  loop = false;
  preload = "";
  paused = true;
  private listeners: Record<string, Array<() => void>> = {};
  constructor(src = "") {
    this.src = src;
    created.push(this);
  }
  play() {
    const outcome = playOutcomes.shift() ?? "resolve";
    if (outcome === "reject") {
      this.paused = true;
      return Promise.reject(new Error("NotAllowedError"));
    }
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  addEventListener(ev: string, fn: () => void) {
    (this.listeners[ev] ||= []).push(fn);
  }
  removeEventListener(ev: string, fn: () => void) {
    this.listeners[ev] = (this.listeners[ev] || []).filter((f) => f !== fn);
  }
  /** Test helper: simulate the media element reaching its end. */
  fireEnded() {
    this.paused = true;
    (this.listeners["ended"] || []).forEach((f) => f());
  }
}
(globalThis as unknown as { Audio: typeof FakeAudio }).Audio = FakeAudio;
(globalThis as unknown as { document: unknown }).document = {
  addEventListener(ev: string, fn: () => void) {
    (documentListeners[ev] ||= []).push(fn);
  },
  createElement() {
    return {};
  },
  head: { appendChild(link: unknown) { preloadHints.push(link); } },
};

const { useAudioStore, onAudioTrackEnded } = await import("./audio");

/** Flush queued microtasks (the `await resolveAssetUrl(...)` hop in playTrack). */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function resetStore() {
  useAudioStore.getState().stopAll();
  useAudioStore.setState({ activeTracks: new Map(), tracks: [], playlist: null, conditionalRules: [], activeConditionalId: null });
  created.length = 0;
  playOutcomes.length = 0;
  preloadHints.length = 0;
}

function fireDocumentEvent(event: string) {
  for (const listener of documentListeners[event] ?? []) listener();
}

const bgmTrack = (id: string) => ({
  id,
  url: `@asset:${id}-asset`,
  name: id,
  type: "bgm" as const,
  loop: true,
  volume: 1,
});

test("AI effects cannot interrupt protected music but scripts and playlists can still play it", async () => {
  resetStore();
  const state = useAudioStore.getState();
  const tracks = [{ ...bgmTrack("script"), allowAiControl: false }, bgmTrack("ai")];
  state.setTracks(tracks);
  state.setPlaylist({ tracks: ["script"], playMode: "loop", autoPlay: true, waitForFirstMessage: false, gapSeconds: 0 });
  state.startPlaylist();
  await flush();
  const protectedAudio = useAudioStore.getState().activeTracks.get("script")!.audio;
  assert.equal(protectedAudio.paused, false);

  state.processAudioEffects(filterAiAudioEffects(tracks, [
    { trackId: "script", action: "stop" },
    { trackId: "script", action: "volume", volume: 0 },
    { trackId: "ai", action: "crossfade", fadeDuration: 0 },
  ]));
  await flush();
  assert.equal(protectedAudio.paused, false, "AI crossfade must leave script music running");
  assert.equal(useAudioStore.getState().activeTracks.get("script")!.volume, 1);
  assert.equal(useAudioStore.getState().activeTracks.get("ai")!.audio.paused, false);
  state.stopTrack("script", 0);
  state.processAudioEffects([{ trackId: "script", action: "play", fadeDuration: 0 }]);
  await flush();
  assert.equal(useAudioStore.getState().activeTracks.get("script")!.audio.paused, false, "behavior/script effects remain permitted");
  resetStore();
});

// Regression for the playTrack stale-snapshot race: playTrack snapshots
// `activeTracks` BEFORE `await resolveAssetUrl`, so a concurrent play that
// resolves in between used to be clobbered when the first call wrote back its
// stale map. Both tracks must survive.
test("concurrent playTrack of two @asset tracks keeps both tracked", async () => {
  resetStore();
  const s = useAudioStore.getState();
  s.setTracks([bgmTrack("a"), bgmTrack("b")]);

  s.playTrack("a", { fadeDuration: 0 });
  s.playTrack("b", { fadeDuration: 0 });
  await flush();

  const active = useAudioStore.getState().activeTracks;
  assert.equal(active.size, 2, "both tracks must remain in activeTracks");
  assert.ok(active.get("a"), "track a tracked");
  assert.ok(active.get("b"), "track b tracked");
});

// pauseTrack/resumeTrack: real pause (keep element + position), unlike
// stopTrack which destroys the element. Lets a player's pause button work
// without re-fetching the asset.
test("pauseTrack pauses in place; resumeTrack continues the same element", async () => {
  resetStore();
  const s = useAudioStore.getState();
  s.setTracks([bgmTrack("x")]);
  s.playTrack("x", { fadeDuration: 0 });
  await flush();

  const el = useAudioStore.getState().activeTracks.get("x")?.audio;
  assert.ok(el && el.paused === false, "playing after play");
  const createdBefore = created.length;

  s.pauseTrack("x");
  assert.equal(el.paused, true, "paused in place");
  assert.equal(useAudioStore.getState().activeTracks.get("x")?.audio, el, "same element kept in slot");

  s.resumeTrack("x");
  assert.equal(el.paused, false, "resumed");
  assert.equal(created.length, createdBefore, "resume reuses the element, no new Audio created");
});

// track-ended observer: non-looping tracks notify subscribers (forwarded to the
// sandbox as api.onAudioEnded so hand-rolled players can auto-advance).
test("onAudioTrackEnded fires and retires the slot when a non-looping track ends", async () => {
  resetStore();
  const s = useAudioStore.getState();
  s.setTracks([{ id: "s1", url: "@asset:s1-asset", name: "s1", type: "sfx", loop: false, volume: 1 }]);

  const got: string[] = [];
  const off = onAudioTrackEnded((tid) => got.push(tid));
  try {
    s.playTrack("s1", { fadeDuration: 0 });
    await flush();
    const el = useAudioStore.getState().activeTracks.get("s1")?.audio as unknown as FakeAudio;
    assert.ok(el, "element active");

    el.fireEnded();
    await flush();

    assert.deepEqual(got, ["s1"], "subscriber received the ended trackId");
    assert.equal(useAudioStore.getState().activeTracks.has("s1"), false, "ended element retired from slot");
  } finally {
    off();
  }
});

// Regression for the concurrent same-id orphan: two playTrack calls for the
// same id whose `await resolveAssetUrl` hops interleave both snapshot an empty
// slot, so the second used to overwrite the first's element WITHOUT pausing it
// — leaving the first looping forever, unreachable (browser-refresh-only bug).
test("two concurrent plays of the same id leave exactly one live element (no orphan)", async () => {
  resetStore();
  const s = useAudioStore.getState();
  s.setTracks([bgmTrack("x")]);

  // Fire both without awaiting in between — they interleave on the async hop.
  s.playTrack("x", { fadeDuration: 0 });
  s.playTrack("x", { fadeDuration: 0 });
  await flush();

  assert.equal(useAudioStore.getState().activeTracks.size, 1, "exactly one slot for id x");
  const live = created.filter((a) => !a.paused);
  assert.equal(live.length, 1, "only one element still playing; the other retired, not orphaned");

  // Stopping the slot must silence everything — proving nothing escaped tracking.
  s.stopTrack("x", 0);
  await flush();
  assert.equal(created.filter((a) => !a.paused).length, 0, "no element left playing after stop");
});

// Regression for the ignored `loop` option: playAudio used to drop opts.loop
// entirely (only track.loop was honored), so a player's single-loop vs
// play-once mode toggle had no effect.
test("playAudio loop option overrides the track default", async () => {
  const s = useAudioStore.getState();

  // BGM track defaults to loop:true → opts.loop:false must win.
  resetStore();
  s.setTracks([bgmTrack("x")]);
  s.playTrack("x", { fadeDuration: 0, loop: false });
  await flush();
  assert.equal(
    useAudioStore.getState().activeTracks.get("x")?.audio.loop,
    false,
    "opts.loop:false overrides track.loop:true",
  );

  // SFX defaults to no loop → opts.loop:true must win.
  resetStore();
  s.setTracks([{ id: "y", url: "@asset:y-asset", name: "y", type: "sfx", loop: false, volume: 1 }]);
  s.playTrack("y", { fadeDuration: 0, loop: true });
  await flush();
  assert.equal(
    useAudioStore.getState().activeTracks.get("y")?.audio.loop,
    true,
    "opts.loop:true overrides the type default",
  );
});

// Regression for the stopTrack orphan: a fade-out started on the OLD element
// completes ~fade seconds later and used to delete the slot by id — but by then
// a freshly played element may own that id. Deleting it orphaned a live,
// looping <audio> reachable by nothing (the "needs browser refresh to stop" /
// "close has a 2-3s delay & fade does nothing" bug).
test("re-playing the same id while an old fade is running does not orphan the new element", async () => {
  resetStore();
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    const s = useAudioStore.getState();
    s.setTracks([bgmTrack("x")]);

    s.playTrack("x", { fadeDuration: 0 });
    await flush();
    const A = useAudioStore.getState().activeTracks.get("x")?.audio;
    assert.ok(A, "first element A is active");

    // Race: stop with a 0.5s fade, then immediately re-play the same id.
    s.stopTrack("x", 0.5); // starts a fade interval bound to A
    s.playTrack("x", { fadeDuration: 0 }); // pauses A, awaits, then installs B
    await flush();
    const B = useAudioStore.getState().activeTracks.get("x")?.audio;
    assert.ok(B && B !== A, "second element B replaced A in the slot");
    assert.equal(B.paused, false, "B is playing");

    // Let A's fade run to completion (0.5s) so its cleanup fires.
    mock.timers.tick(700);
    await flush();

    const stillThere = useAudioStore.getState().activeTracks.get("x")?.audio;
    assert.equal(stillThere, B, "B must stay tracked after A's stale fade completes (no orphan)");

    // And B must be stoppable — proving it isn't a runaway element.
    s.stopTrack("x", 0);
    await flush();
    assert.equal(B.paused, true, "B stops on explicit stopTrack");
    assert.equal(useAudioStore.getState().activeTracks.size, 0, "slot cleared");
  } finally {
    mock.timers.reset();
  }
});

test("stopping a track while its asset URL resolves cancels the pending play", async () => {
  resetStore();
  const s = useAudioStore.getState();
  s.setTracks([bgmTrack("pending")]);

  s.playTrack("pending", { fadeDuration: 0 });
  s.stopTrack("pending", 0);
  await flush();

  assert.equal(useAudioStore.getState().activeTracks.size, 0, "the cancelled track never becomes active");
  assert.equal(created.filter((a) => !a.paused).length, 0, "no late audio element starts playing");
});

test("stopAll cancels every track still waiting for asset URL resolution", async () => {
  resetStore();
  const s = useAudioStore.getState();
  s.setTracks([bgmTrack("pending-a"), bgmTrack("pending-b")]);

  s.playTrack("pending-a", { fadeDuration: 0 });
  s.playTrack("pending-b", { fadeDuration: 0 });
  s.stopAll();
  await flush();

  assert.equal(useAudioStore.getState().activeTracks.size, 0, "cleanup leaves no resurrected slots");
  assert.equal(created.filter((a) => !a.paused).length, 0, "cleanup leaves no late audio elements");
});

test("starting a deferred playlist while conditional BGM is active does not revive the default track", async () => {
  resetStore();
  const s = useAudioStore.getState();
  s.setTracks([bgmTrack("day-1"), bgmTrack("day-61")]);
  s.setPlaylist({
    tracks: ["day-1"],
    playMode: "loop",
    autoPlay: true,
    waitForFirstMessage: true,
    gapSeconds: 0,
  });
  s.setConditionalRules([
    {
      id: "day-1-rule",
      name: "Day 1",
      triggerType: "variable",
      conditions: [{ variableId: "day", operator: "lt", value: 61 }],
      conditionLogic: "all",
      targetTrackId: "day-1",
      priority: 1,
      fadeInDuration: 0,
      fadeOutDuration: 0,
      stopPreviousBGM: true,
      fallback: "default",
    },
    {
      id: "day-61-rule",
      name: "Day 61",
      triggerType: "variable",
      conditions: [{ variableId: "day", operator: "gte", value: 61 }],
      conditionLogic: "all",
      targetTrackId: "day-61",
      priority: 2,
      fadeInDuration: 0,
      fadeOutDuration: 0,
      stopPreviousBGM: true,
      fallback: "default",
    },
  ]);

  s.evaluateConditionalBGM({ worldId: "vestige", variables: { day: 1 }, turnCount: 1, metadata: {} });
  await flush();
  s.evaluateConditionalBGM({ worldId: "vestige", variables: { day: 61 }, turnCount: 2, metadata: {} });
  s.startPlaylist();
  await flush();

  assert.equal(useAudioStore.getState().playlistState.isPlaying, true, "the deferred playlist is armed");
  assert.deepEqual([...useAudioStore.getState().activeTracks.keys()], ["day-61"]);
  assert.equal(created.filter((a) => !a.paused).length, 1, "only the conditional track is audible");

  s.playNextInPlaylist();
  await flush();
  assert.deepEqual([...useAudioStore.getState().activeTracks.keys()], ["day-61"], "playlist advancement stays suppressed");
});

test("a rejected touchstart retry stays queued for the succeeding touchend gesture", async () => {
  resetStore();
  const s = useAudioStore.getState();
  s.setTracks([bgmTrack("mobile")]);
  playOutcomes.push("reject", "reject", "resolve");

  s.playTrack("mobile", { fadeDuration: 0 });
  await flush();
  const audio = useAudioStore.getState().activeTracks.get("mobile")?.audio as unknown as FakeAudio;
  assert.ok(audio?.paused, "initial autoplay is blocked");

  fireDocumentEvent("touchstart");
  await flush();
  assert.equal(audio.paused, true, "touchstart can still be too early for the browser policy");

  fireDocumentEvent("touchend");
  await flush();
  assert.equal(audio.paused, false, "the later valid gesture resumes the queued track");
});

// Regression for @binksss 2026-09-08: every loadSession — opening the chat,
// switching persona, coming back from the library — replayed whatever sat in
// metadata.activeAudio. Sessions saved before the write-side filter still carry
// a one-shot SFX there, so the guard has to live here too, or thousands of
// existing sessions keep firing last turn's sound with no trigger word behind it.
test("resumeFromState restores looping music but never replays a one-shot SFX", async () => {
  resetStore();
  const s = useAudioStore.getState();
  const sfxTrack = { id: "fk-sfx", url: "@asset:fk", name: "FK SFX", type: "sfx" as const, loop: false, volume: 1 };
  const stinger = { id: "stinger", url: "@asset:stinger", name: "Stinger", type: "bgm" as const, loop: false, volume: 1 };
  s.setTracks([bgmTrack("onsen"), sfxTrack, stinger]);

  // The shape production actually stored for the reported session: the SFX the
  // AI fired several turns ago, pinned next to the room's BGM.
  s.resumeFromState([
    { trackId: "onsen", action: "play" },
    { trackId: "fk-sfx", action: "play" },
    { trackId: "stinger", action: "play" },
  ]);
  await flush();

  const active = useAudioStore.getState().activeTracks;
  assert.ok(active.get("onsen"), "looping BGM resumes — that is what the snapshot is for");
  assert.equal(active.get("fk-sfx"), undefined, "one-shot SFX must not fire on session load");
  assert.equal(active.get("stinger"), undefined, "a bgm-typed one-shot is over too");
  assert.equal(created.length, 1, "only one media element created");
});

test("resumeFromState ignores tracks the world no longer defines", async () => {
  resetStore();
  const s = useAudioStore.getState();
  s.setTracks([bgmTrack("kept")]);
  s.resumeFromState([{ trackId: "deleted", action: "play" }]);
  await flush();
  assert.equal(useAudioStore.getState().activeTracks.size, 0, "unknown track ids resume nothing");
});

test("large tracks opt out of startup preloading but still play on demand", async () => {
  resetStore();
  const store=useAudioStore.getState();
  store.setTracks([{...bgmTrack("large-on-demand"),preload:false}]);
  await flush();
  assert.equal(preloadHints.length,0);
  store.playTrack("large-on-demand",{fadeDuration:0});
  await flush();
  assert.equal(created[0]?.preload,"metadata");
  assert.equal(created[0]?.paused,false);
});
