import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { filterAiAudioEffects } from "@yumina/engine";

// ── Browser globals the audio store touches at runtime ──
// Minimal HTMLAudioElement stand-in: enough surface for playTrack/stopTrack.
const created: FakeAudio[] = [];
const playOutcomes: Array<"resolve" | "reject" | "pending" | "error"> = [];
const documentListeners: Record<string, Array<() => void>> = {};
const preloadHints: unknown[] = [];
class FakeAudio {
  src: string;
  volume = 1;
  loop = false;
  preload = "";
  paused = true;
  resolvePlay?: () => void;
  captureStream?: () => MediaStream;
  private listeners: Record<string, Array<() => void>> = {};
  constructor(src = "") {
    this.src = src;
    created.push(this);
  }
  play() {
    const outcome = playOutcomes.shift() ?? "resolve";
    if (outcome === "reject") {
      this.paused = true;
      return Promise.reject(new DOMException("Playback requires a gesture", "NotAllowedError"));
    }
    if (outcome === "error") return Promise.reject(new DOMException("Unsupported media", "NotSupportedError"));
    if (outcome === "pending") return new Promise<void>((resolve) => {
      this.resolvePlay = () => { this.paused = false; resolve(); };
    });
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
    this.fire("ended");
  }
  fire(event: string) { (this.listeners[event] || []).forEach((f) => f()); }
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
  useAudioStore.setState({ activeTracks: new Map(), tracks: [], playlist: null, conditionalRules: [], activeConditionalId: null, judgeHoldsMusic: null });
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

// ── Continuity judge: the lowest-priority music source ──
// Rules keep the channel while active; the judge only displaces BGM the AI
// may control; a hand-back stop resumes the default playlist where it stood.
test("the judge's crossfade is ignored while a conditional-BGM rule owns the music", async () => {
  resetStore();
  const state = useAudioStore.getState();
  state.setTracks([bgmTrack("rule"), bgmTrack("judge")]);
  state.playTrack("rule", { fadeDuration: 0 });
  await flush();
  useAudioStore.setState({ activeConditionalId: "rule-1" });
  state.processAudioEffects([{ trackId: "judge", action: "crossfade", fadeDuration: 0, source: "continuity" }]);
  await flush();
  assert.equal(useAudioStore.getState().activeTracks.get("rule")!.audio.paused, false, "rule music keeps playing");
  assert.equal(useAudioStore.getState().activeTracks.has("judge"), false, "judge pick never started");
  resetStore();
});

test("the judge's crossfade displaces AI-controllable BGM only, never a script-only track", async () => {
  resetStore();
  const state = useAudioStore.getState();
  state.setTracks([{ ...bgmTrack("script"), allowAiControl: false }, bgmTrack("playlist"), bgmTrack("judge")]);
  state.playTrack("script", { fadeDuration: 0 });
  state.playTrack("playlist", { fadeDuration: 0 });
  await flush();
  state.processAudioEffects([{ trackId: "judge", action: "crossfade", fadeDuration: 0, source: "continuity" }]);
  await flush();
  const s = useAudioStore.getState();
  assert.equal(s.activeTracks.get("script")!.audio.paused, false, "script-only music untouched");
  assert.equal(s.activeTracks.has("playlist"), false, "the playlist's track stepped aside");
  assert.equal(s.activeTracks.get("judge")!.audio.paused, false, "judge pick is sounding");
  resetStore();
});

test("'AI over rules': the judge's pick takes the channel and rules stay out until it ends", async () => {
  resetStore();
  const state = useAudioStore.getState();
  state.setTracks([bgmTrack("rule"), bgmTrack("judge")]);
  state.setConditionalRules([{ id: "r1", name: "tense", triggerType: "keyword", keywords: ["fight"], conditions: [], conditionLogic: "all", targetTrackId: "rule", priority: 0, fadeInDuration: 0, fadeOutDuration: 0, stopPreviousBGM: true, fallback: "default" }]);
  state.playTrack("rule", { fadeDuration: 0 });
  await flush();
  useAudioStore.setState({ activeConditionalId: "r1" });
  state.processAudioEffects([{ trackId: "judge", action: "crossfade", fadeDuration: 0, source: "continuity", overRules: true }]);
  await flush();
  let s = useAudioStore.getState();
  assert.equal(s.activeTracks.has("rule"), false, "the rule's track stepped aside");
  assert.equal(s.activeTracks.get("judge")!.audio.paused, false);
  // The rule still matches on the next turn — but the judge holds the channel.
  s.evaluateConditionalBGM({ worldId: "w", variables: {}, turnCount: 2, metadata: {}, playerMessage: "fight", aiMessage: "" });
  await flush();
  s = useAudioStore.getState();
  assert.equal(s.activeTracks.has("rule"), false, "rule did not retake the channel");
  assert.equal(s.activeTracks.get("judge")!.audio.paused, false);
  // Hand-back releases the hold; the rule may retake on the next evaluation.
  s.processAudioEffects([{ trackId: "judge", action: "stop", fadeDuration: 0, source: "continuity" }]);
  await flush();
  useAudioStore.getState().evaluateConditionalBGM({ worldId: "w", variables: {}, turnCount: 3, metadata: {}, playerMessage: "fight", aiMessage: "" });
  await flush();
  assert.equal(useAudioStore.getState().activeTracks.get("rule")!.audio.paused, false, "rule retook the channel after hand-back");
  resetStore();
});

test("a judge hand-back stops its pick and resumes the playlist where it stood", async () => {
  resetStore();
  const state = useAudioStore.getState();
  state.setTracks([bgmTrack("a"), bgmTrack("b"), bgmTrack("judge")]);
  state.setPlaylist({ tracks: ["a", "b"], playMode: "sequential", autoPlay: true, waitForFirstMessage: false, gapSeconds: 0 });
  state.startPlaylist();
  await flush();
  state.processAudioEffects([{ trackId: "judge", action: "crossfade", fadeDuration: 0, source: "continuity" }]);
  await flush();
  assert.equal(useAudioStore.getState().activeTracks.has("a"), false);
  state.processAudioEffects([{ trackId: "judge", action: "stop", fadeDuration: 0, source: "continuity" }]);
  await flush();
  const s = useAudioStore.getState();
  assert.equal(s.activeTracks.has("judge"), false, "judge pick stopped");
  assert.equal(s.activeTracks.get("a")!.audio.paused, false, "playlist resumed at its current index");
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

test("voice stays loading until play resolves and its receipt waits for ended", async () => {
  resetStore();
  playOutcomes.push("pending");
  let completed = false;
  const receipt = useAudioStore.getState().playVoice("line", "/voice.mp3", { failIfBlocked: true });
  Promise.resolve(receipt).then(() => { completed = true; });
  try {
    await flush();
    assert.equal(useAudioStore.getState().voicePlayback?.status, "loading");
    assert.equal(completed, false);
    created.at(-1)!.resolvePlay!();
    await flush();
    assert.equal(useAudioStore.getState().voicePlayback?.status, "playing");
    assert.equal(completed, false, "play acceptance is not completion");
    created.at(-1)!.fireEnded();
    assert.deepEqual(await receipt, { ok: true });
    assert.equal(useAudioStore.getState().voicePlayback, null);
  } finally { resetStore(); }
});

test("completion mode rejects blocked playback and never retries it on a later gesture", async () => {
  resetStore();
  playOutcomes.push("reject");
  try {
    const receipt = useAudioStore.getState().playVoice("blocked", "/voice.mp3", { failIfBlocked: true });
    assert.deepEqual(await receipt, { ok: false, reason: "playback-blocked" });
    const audio = created.at(-1)!;
    fireDocumentEvent("click");
    await flush();
    assert.equal(audio.paused, true);
    assert.equal(audio.src, "");
    assert.equal(useAudioStore.getState().voicePlayback, null);
  } finally { resetStore(); }
});

test("ordinary voice readout stays blocked until a successful gesture retry", async () => {
  resetStore();
  playOutcomes.push("reject", "resolve");
  try {
    const receipt = useAudioStore.getState().playVoice("readout", "/voice.mp3");
    await flush();
    assert.equal(useAudioStore.getState().voicePlayback?.status, "blocked");
    fireDocumentEvent("click");
    await flush();
    assert.equal(useAudioStore.getState().voicePlayback?.status, "playing");
    created.at(-1)!.fireEnded();
    assert.deepEqual(await receipt, { ok: true });
  } finally { resetStore(); }
});

test("voice media errors and stop resolve distinct unsuccessful receipts", async () => {
  resetStore();
  try {
    let receipt = useAudioStore.getState().playVoice("error", "/voice.mp3");
    await flush();
    created.at(-1)!.fire("error");
    assert.deepEqual(await receipt, { ok: false, reason: "playback-error" });
    receipt = useAudioStore.getState().playVoice("cancel", "/voice.mp3");
    useAudioStore.getState().stopVoice();
    assert.deepEqual(await receipt, { ok: false, reason: "cancelled" });
    playOutcomes.push("error");
    receipt = useAudioStore.getState().playVoice("unsupported", "/voice.mp3");
    assert.deepEqual(await receipt, { ok: false, reason: "playback-error" });
  } finally { resetStore(); }
});

test("superseding pending playback cancels its receipt and ignores late play acceptance", async () => {
  resetStore();
  playOutcomes.push("pending");
  try {
    const first = useAudioStore.getState().playVoice("old", "/old.mp3");
    const old = created.at(-1)!;
    const second = useAudioStore.getState().playVoice("new", "/new.mp3");
    assert.deepEqual(await first, { ok: false, reason: "cancelled" });
    old.resolvePlay!();
    await flush();
    assert.equal(useAudioStore.getState().voicePlayback?.key, "new");
    created.at(-1)!.fireEnded();
    assert.deepEqual(await second, { ok: true });
  } finally { resetStore(); }
});

test("bounded playback times out and releases the media element", async () => {
  resetStore();
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    playOutcomes.push("pending");
    const receipt = useAudioStore.getState().playVoice("stuck", "/voice.mp3", { timeoutMs: 1000 });
    mock.timers.tick(1001);
    assert.deepEqual(await receipt, { ok: false, reason: "timeout" });
    assert.equal(created.at(-1)!.src, "");
    assert.equal(useAudioStore.getState().voicePlayback, null);
  } finally { resetStore(); mock.timers.reset(); }
});

test("voice exposes measured output without rerouting the element and closes capture on stop", async () => {
  resetStore();
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let resumes = 0, closed = 0, stopped = 0, disconnected = 0;
  const analyser = { fftSize: 512, getByteTimeDomainData(buf: Uint8Array) { buf.fill(144); }, disconnect() { disconnected++; } };
  class Context {
    state = "suspended";
    async resume() { resumes++; this.state = "running"; }
    async close() { closed++; this.state = "closed"; }
    createAnalyser() { return analyser; }
    createMediaStreamSource() { return { connect(node: unknown) { assert.equal(node, analyser); }, disconnect() { disconnected++; } }; }
  }
  Object.defineProperty(globalThis, "window", { configurable: true, value: { AudioContext: Context } });
  try {
    playOutcomes.push("pending");
    const receipt = useAudioStore.getState().playVoice("measured", "/voice.mp3", { measureLevel: true });
    const audio = created.at(-1)!;
    audio.captureStream = () => ({ getTracks: () => [{ stop() { stopped++; } }] }) as unknown as MediaStream;
    audio.resolvePlay!();
    await flush();
    mock.timers.tick(100);
    assert.equal(resumes, 1);
    assert.equal(useAudioStore.getState().voicePlayback?.level, 0.5);
    useAudioStore.getState().stopVoice();
    assert.deepEqual(await receipt, { ok: false, reason: "cancelled" });
    assert.equal(closed, 1);
    assert.equal(stopped, 1);
    assert.equal(disconnected, 2);
  } finally {
    resetStore(); mock.timers.reset();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("ordinary voice readouts do not allocate output analysis or publish at conversation frequency", async () => {
  resetStore();
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let contexts = 0, captures = 0;
  class Context {
    constructor() { contexts++; }
    state = "running";
    async resume() {}
    async close() {}
  }
  Object.defineProperty(globalThis, "window", { configurable: true, value: { AudioContext: Context } });
  try {
    playOutcomes.push("pending");
    const receipt = useAudioStore.getState().playVoice("ordinary", "/voice.mp3");
    const audio = created.at(-1)!;
    audio.captureStream = () => { captures++; return { getTracks: () => [] } as unknown as MediaStream; };
    Object.assign(audio, { duration: 10, currentTime: 1 });
    audio.resolvePlay!();
    await flush(); mock.timers.tick(100);
    assert.equal(contexts, 0);
    assert.equal(captures, 0);
    assert.equal(useAudioStore.getState().voicePlayback?.progress, undefined);
    mock.timers.tick(400);
    assert.equal(useAudioStore.getState().voicePlayback?.progress, 0.1);
    useAudioStore.getState().stopVoice();
    assert.deepEqual(await receipt, { ok: false, reason: "cancelled" });
  } finally {
    resetStore(); mock.timers.reset();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("pausing blocked audio cancels gesture retries until explicitly resumed", async () => {
  resetStore();
  const s = useAudioStore.getState();
  s.setTracks([bgmTrack("paused")]);
  playOutcomes.push("reject");
  s.playTrack("paused");
  await flush();
  const audio = useAudioStore.getState().activeTracks.get("paused")!.audio;
  s.pauseTrack("paused");
  fireDocumentEvent("click");
  await flush();
  assert.equal(audio.paused, true);
  s.resumeTrack("paused");
  await flush();
  assert.equal(audio.paused, false);
});
