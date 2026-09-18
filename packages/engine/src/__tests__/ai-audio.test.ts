import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { filterAiAudioEffects, filterResumableAudioEffects, isLoopingTrack } from "../audio/ai-audio.js";
import { PromptBuilder } from "../prompts/prompt-builder.js";
import { ResponseParser } from "../parser/response-parser.js";
import { StructuredResponseParser } from "../parser/structured-response-parser.js";
import { audioTrackSchema } from "../world/schema.js";
import { createMockWorld } from "./test-utils.js";
import type { AudioEffect, AudioTrack } from "../types/index.js";

const tracks: AudioTrack[] = [
  { id: "script", name: "Script only", type: "bgm", url: "script.mp3", allowAiControl: false },
  { id: "allowed", name: "Allowed", type: "bgm", url: "allowed.mp3", allowAiControl: true },
  { id: "legacy", name: "Legacy", type: "sfx", url: "legacy.mp3" },
];

describe("AI audio permissions", () => {
  it("retains explicit permissions in the schema and keeps legacy tracks enabled", () => {
    expect(audioTrackSchema.parse(tracks[0]).allowAiControl).toBe(false);
    expect(filterAiAudioEffects(tracks, [{ trackId: "legacy", action: "play" }])).toEqual([{ trackId: "legacy", action: "play" }]);
  });

  it.each(["play", "stop", "volume", "crossfade"] as const)("blocks AI %s of a script-only track", action => {
    expect(filterAiAudioEffects(tracks, [{ trackId: "script", action, volume: 0.1 }])).toEqual([]);
  });

  it("does not advertise script-only tracks in the prompt", () => {
    const builder = new PromptBuilder();
    const prompt = builder.buildStaticFormatBlock(createMockWorld({ audioTracks: tracks }));
    expect(prompt).toContain("allowed (bgm)");
    expect(prompt).toContain("legacy (sfx)");
    expect(prompt).not.toContain("Script only");
    expect(prompt).not.toContain("script (bgm)");
    expect(builder.buildStaticFormatBlock(createMockWorld({ variables: [], audioTracks: [tracks[0]!] }))).not.toContain("<audio>");
  });

  it("blocks old/guessed IDs from regex and structured responses even if the model ignores instructions", () => {
    const regex = new ResponseParser().parse("Story. [audio: script play] [audio: allowed play]");
    const json = new StructuredResponseParser().parse(JSON.stringify({ narrative: "Story.", audioEffects: [
      { trackId: "script", action: "play" }, { trackId: "allowed", action: "play" },
    ] }));
    for (const result of [regex, json]) {
      expect(filterAiAudioEffects(tracks, result.audioEffects)).toEqual([{ trackId: "allowed", action: "play" }]);
    }
  });

  it("blocks chained playback of protected/unknown tracks without mutating parsed effects", () => {
    const effect: AudioEffect = { trackId: "legacy", action: "play", chainTo: "script" };
    expect(filterAiAudioEffects(tracks, [effect])).toEqual([{ trackId: "legacy", action: "play" }]);
    expect(effect.chainTo).toBe("script");
    expect(filterAiAudioEffects(tracks, [{ ...effect, chainTo: "allowed" }])[0]?.chainTo).toBe("allowed");
    expect(filterAiAudioEffects(tracks, [{ ...effect, chainTo: "unknown" }])[0]?.chainTo).toBeUndefined();
    expect(filterAiAudioEffects(tracks, [{ trackId: "unknown", action: "crossfade" }])).toEqual([]);
  });

  it("expands AI crossfade without stopping protected BGM", () => {
    expect(filterAiAudioEffects(tracks, [{ trackId: "allowed", action: "crossfade", volume: 0.5 }])).toEqual([
      { trackId: "allowed", action: "stop", fadeDuration: 1 },
      { trackId: "allowed", action: "play", fadeDuration: 1, volume: 0.5 },
    ]);
  });

  it("applies the boundary before engine effects in send, regenerate and continue", () => {
    const source = readFileSync(new URL("../../../server/src/routes/messages.ts", import.meta.url), "utf8");
    for (const parsed of ["parseResult", "regenParseResult", "contParseResult"]) {
      expect(source).toContain(`filterAiAudioEffects(worldDef.audioTracks ?? [], ${parsed}.audioEffects)`);
    }
    // Behaviors and scripts still use the unfiltered player entry point.
    const engineEffect: AudioEffect = { trackId: "script", action: "play" };
    const allEffects = [...filterAiAudioEffects(tracks, [engineEffect]), engineEffect];
    expect(allEffects).toEqual([engineEffect]);
  });
});

// Regression: session metadata.activeAudio is a resume snapshot, not a turn log.
// A one-shot SFX persisted there replayed on every later session load — reported
// by @binksss 2026-09-08: "opening the chat or switching personas causes the last
// triggered SFX to play again" even with no trigger word in the latest message.
describe("resumable audio snapshot", () => {
  const resumeTracks: AudioTrack[] = [
    { id: "bgm", name: "Onsen", type: "bgm", url: "bgm.mp3", loop: true },
    { id: "sfx", name: "FK SFX", type: "sfx", url: "sfx.mp3", loop: false },
    { id: "stinger", name: "Stinger", type: "bgm", url: "stinger.mp3", loop: false },
    { id: "rain", name: "Rain", type: "sfx", url: "rain.mp3", loop: true },
    { id: "ambient", name: "Wind", type: "ambient", url: "wind.mp3" },
  ];

  it("classifies a track by explicit loop first, then by type", () => {
    expect(isLoopingTrack(resumeTracks[0]!)).toBe(true);
    expect(isLoopingTrack(resumeTracks[1]!)).toBe(false);
    // type bgm but loop:false — a one-shot stinger is over too.
    expect(isLoopingTrack(resumeTracks[2]!)).toBe(false);
    // type sfx but loop:true — a creator filing looping rain under sfx.
    expect(isLoopingTrack(resumeTracks[3]!)).toBe(true);
    // no loop field: bgm/ambient default to looping, matching playTrack.
    expect(isLoopingTrack(resumeTracks[4]!)).toBe(true);
  });

  it("drops one-shot SFX from the snapshot and keeps looping music", () => {
    expect(filterResumableAudioEffects(resumeTracks, [
      { trackId: "bgm", action: "play" },
      { trackId: "sfx", action: "play" },
      { trackId: "stinger", action: "play" },
      { trackId: "rain", action: "play" },
      { trackId: "ambient", action: "play" },
    ])).toEqual([
      { trackId: "bgm", action: "play" },
      { trackId: "rain", action: "play" },
      { trackId: "ambient", action: "play" },
    ]);
  });

  it("keeps a stop aimed at looping music so a silenced BGM stays silent on reload", () => {
    expect(filterResumableAudioEffects(resumeTracks, [{ trackId: "bgm", action: "stop" }]))
      .toEqual([{ trackId: "bgm", action: "stop" }]);
  });

  it("drops effects for tracks the world no longer defines", () => {
    expect(filterResumableAudioEffects(resumeTracks, [{ trackId: "deleted", action: "play" }])).toEqual([]);
  });

  it("leaves an SFX-only turn with nothing to persist, so BGM stays sticky", () => {
    // The write sites only call setMetadata when the filtered list is non-empty:
    // an SFX-only turn must not blank out the BGM the session is still playing.
    expect(filterResumableAudioEffects(resumeTracks, [{ trackId: "sfx", action: "play" }])).toEqual([]);
  });

  it("filters at every activeAudio write site in send, regenerate and continue", () => {
    const source = readFileSync(new URL("../../../server/src/routes/messages.ts", import.meta.url), "utf8");
    const writes = [...source.matchAll(/setMetadata\("activeAudio", (\w+)\)/g)].map(m => m[1]!);
    expect(writes).toHaveLength(3);
    for (const persisted of writes) {
      expect(source).toContain(`const ${persisted} = filterResumableAudioEffects(worldDef.audioTracks ?? [], `);
    }
  });
});
