import type { AudioEffect, AudioTrack } from "../types/index.js";

/** Missing permission preserves playback in existing worlds. */
export function getAiAudioTracks(tracks: AudioTrack[]): AudioTrack[] {
  return tracks.filter((track) => track.allowAiControl !== false);
}

/** Whether a track is still audible some time after it was started. Mirrors the
 *  player's own default in playTrack: an explicit `loop` wins, otherwise
 *  bgm/ambient loop and sfx does not. So a creator who files looping rain under
 *  sfx with `loop: true` still counts as looping. */
export function isLoopingTrack(track: AudioTrack): boolean {
  return track.loop ?? (track.type === "bgm" || track.type === "ambient");
}

/** `activeAudio` in session metadata is a snapshot of what should still be
 *  audible when the session is reopened — not a log of what the turn fired. A
 *  one-shot SFX is over the moment it finishes, so persisting or resuming one
 *  makes every later load (opening the chat, switching persona, returning from
 *  the library) replay last turn's sound with no message to justify it.
 *  Keep only effects aimed at a track the world still defines and that loops. */
export function filterResumableAudioEffects(tracks: AudioTrack[], effects: AudioEffect[]): AudioEffect[] {
  const byId = new Map(tracks.map((track) => [track.id, track]));
  return effects.filter((effect) => {
    const track = byId.get(effect.trackId);
    return track !== undefined && isLoopingTrack(track);
  });
}

/** Apply only to AI output, before combining it with engine/behavior effects. */
export function filterAiAudioEffects(tracks: AudioTrack[], effects: AudioEffect[]): AudioEffect[] {
  const allowed = getAiAudioTracks(tracks);
  const ids = new Set(allowed.map((track) => track.id));
  return effects.flatMap((effect): AudioEffect[] => {
    if (!ids.has(effect.trackId)) return [];
    if (!["play", "stop", "crossfade", "volume"].includes(effect.action)) return [];

    const safe = { ...effect };
    if (safe.chainTo && !ids.has(safe.chainTo)) delete safe.chainTo;
    if (safe.action !== "crossfade") return [safe];

    // The player's crossfade stops ALL BGM. Expand AI crossfades into scoped
    // stops + a play so an allowed target cannot stop a script-only track.
    const fadeDuration = safe.fadeDuration ?? 1;
    return [
      ...allowed.filter((track) => track.type === "bgm").map((track): AudioEffect => ({
        trackId: track.id, action: "stop", fadeDuration,
      })),
      { ...safe, action: "play", fadeDuration },
    ];
  });
}
