---
name: audio
description: Create and manage audio tracks (BGM, SFX, ambient). Use when the user wants background music, sound effects, audio directives, or conditional audio via behaviors.
---

# Skill: Audio

## Track Types

| Type | Behavior | Recommended volume |
|------|----------|-------------------|
| `bgm` | Background music, usually looping | 0.3–0.5 |
| `sfx` | Sound effects, short, non-looping | 0.5–0.8 |
| `ambient` | Environmental sounds, looping | 0.1–0.3 |

## Creating Tracks

Use `write_audio` to create or update a track. Key fields:

| Field | Description |
|-------|-------------|
| id | Unique kebab-case ID |
| name | Display name |
| type | "bgm", "sfx", or "ambient" |
| url | Audio file URL (use `@asset:{id}` for uploaded files) |
| loop | true for BGM and ambient |
| volume | 0.0–1.0 |
| fadeIn | Fade-in duration in seconds |
| fadeOut | Fade-out duration in seconds |
| aiNote | "When to play" cue for AI music pick (below) |
| allowAiControl | false = only behaviors/playlists/scripts may play it |

## AI Music Pick (smart tracking) — the default way to score a card

Give a `bgm` or `sfx` track an `aiNote` and it joins smart tracking's pool (editor: 「什么时候放」 for BGM, 「什么事发生时放一次」 for SFX). After every reply a small decision model reads the turn and:
- **BGM**: picks the track whose note fits the scene now, or keeps the current one. It does not depend on the story model remembering `[audio:]` directives.
- **SFX**: fires each SFX whose note matches what just happened (a door slams, a sword is drawn).

Write the note as a scene, not a genre: "battle or chase, danger right now", "quiet night alone together", "a door is kicked open". Distinct notes = clean picks; two tracks with near-identical notes make the judge flip between them. Skip it for tracks that only a behavior or custom UI should start.

World-level knobs go through `update_settings { continuity: {...} }`:
- `music.overRules` (default false): whether an AI pick may override an active conditional-BGM rule.
- `music.once` (default false): AI-picked track plays once, then the default playlist resumes.
- `music.duck` (default true): dip BGM while an AI-picked SFX plays.
- `bgm: false` / `sfx: false` ignore the notes; `enabled: false` turns smart tracking off entirely.

If a reply already contains an `[audio:]` directive, the judge stays out of audio that turn.

## Voice readout (TTS)

Players can turn on voice readout; lines are read by fish.audio voices. Authors can pin voices:
- A character's voice: `write_entry { id, voice: "<32-hex id>" }` on a `role: "character"` entry. It wins over the player's own pick.
- The narrator: `update_settings { narratorVoice: "<id>" }` — also used for speaking characters with no voice.
- Unset = the AI casts voices from the player's voice pool automatically, which is usually fine. Pin voices only when the creator asks.
Pick ids from the curated catalog in `write_entry.voice`'s description (label says language/gender/tone), or use an id the creator pastes. `voiceInputMode` ("confirm"/"auto") controls hold-to-talk input: fill the box vs. send immediately.

## AI Audio Directives

Once tracks exist, the AI can control them in its responses:
```
[audio: battle-bgm play]
[audio: tavern-ambient stop]
[audio: battle-bgm crossfade]
[audio: ambient-rain volume 0.3]
```

The engine automatically tells the AI about available tracks in the prompt. No manual entry needed.

## Conditional Audio via Behaviors

Use behaviors to change music based on game state. Two approaches:

### Simple: `set` with @ audio paths
```json
{ "type": "set", "path": "@audio.bgm", "value": "battle-bgm" }
{ "type": "set", "path": "@audio.sfx", "value": "achievement-sfx" }
{ "type": "set", "path": "@audio.stop", "value": "tavern-ambient" }
```

### Full control: `emit` audio:play event
```json
{ "type": "emit", "event": { "type": "audio:play", "trackId": "battle-bgm", "action": "crossfade", "fadeDuration": 2 } }
```

**Example**: Switch to combat music when health drops below 50:
- When: `state:changed`, match: variableId eq "health"
- Condition: health lt 50
- Then: `emit` audio:play with trackId "battle-bgm", action "crossfade"

**Example**: Play achievement sound on quest completion:
- When: `state:changed`, match: variableId eq "quest-complete"
- Condition: quest-complete eq true
- Then: `set @audio.sfx` = "achievement-sfx"

## Advanced Audio Features

### Chain-To (SFX → BGM Transitions)
Play a sound effect that automatically starts a BGM track when it ends:
```
[audio: intro-sfx play chainTo=main-bgm]
```
In behaviors, use the `emit` effect:
```json
{ "type": "emit", "event": { "type": "audio:play", "trackId": "intro-sfx", "action": "play", "chainTo": "main-bgm" } }
```

### Per-Type Volume Channels
BGM and SFX have independent volume controls. Custom components can adjust them via:
- `api.setAudioVolume("bgm", 0.5)` — set BGM volume
- `api.setAudioVolume("sfx", 0.8)` — set SFX volume
- `api.getAudioVolume("bgm")` — read current volume

### Duck BGM During SFX
Automatically lower BGM volume while a sound effect plays, then restore:
- Custom components: `api.playAudio("impact-sfx", { duckBgm: true, maxDuration: 3 })`
- `maxDuration` auto-stops the SFX after N seconds

### Audio API in Custom Components
Custom components (full-screen mode) have access to audio controls via `useYumina()`.
**All durations are in SECONDS, not milliseconds** (passing `1000` = a 1000-second fade):
- `api.playAudio(trackId, opts?)` — play a track. `opts`: `volume`, `fadeDuration` (seconds), `chainTo`, `maxDuration` (seconds), `duckBgm`, `loop` (override the track's loop setting for this playback)
- `api.stopAudio(trackId?, fadeDuration?)` — stop a track (or all tracks if no ID). **Destroys** the element — use `pauseAudio` if you want to resume from the same position
- `api.pauseAudio(trackId)` — pause in place, keeping the playback position
- `api.resumeAudio(trackId)` — resume a track paused with `pauseAudio`
- `api.onAudioEnded(cb)` — subscribe to "a non-looping track finished" (`cb(trackId)`); returns an unsubscribe function. Use it to auto-advance a custom playlist
- `api.setAudioVolume(type, volume)` — set bgm/sfx volume
- `api.getAudioVolume(type)` — get bgm/sfx volume

### Building a Custom Music Player
For a hand-rolled player with single/list/shuffle modes:
- Single-loop a track: `api.playAudio(id, { loop: true })`; play-once: `{ loop: false }`
- Real pause/resume (NOT stop): `api.pauseAudio(id)` / `api.resumeAudio(id)` — `stopAudio` re-fetches from the start
- Auto-advance when a track ends: subscribe with `api.onAudioEnded` and call `playAudio(next)`:
```tsx
React.useEffect(() => api.onAudioEnded((endedId) => {
  if (endedId === currentTrackId && mode !== "single") playNext();
}), [currentTrackId, mode]);
```

## Tips

- Set `loop: true` for BGM and ambient
- Use `crossfade` for smooth transitions between scenes
- Use `chainTo` for cinematic SFX → BGM transitions (e.g., title sting → exploration music)
- Use `duckBgm` for impactful SFX that need audio focus (explosions, reveals)
- Keep BGM volume moderate so it doesn't overpower the experience
- Use `fadeIn`/`fadeOut` on tracks for polished transitions
- Pair audio behaviors with variable-crossed or keyword triggers for reactive soundscapes
- **Durations are in seconds** everywhere (track `fadeIn`/`fadeOut`, `playAudio`/`stopAudio` `fadeDuration`, `maxDuration`) — never pass milliseconds
