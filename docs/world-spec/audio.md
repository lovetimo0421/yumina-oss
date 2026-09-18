# Audio

Audio tracks provide background music, sound effects, and ambient sounds. They can be triggered by AI directives, rules, or automatic playlists.

## AudioTrack Schema

```json
{
  "id": "bgm-tavern",
  "name": "Tavern Theme",
  "type": "bgm",
  "url": "@asset:uuid-here",
  "allowAiControl": true,
  "loop": true,
  "volume": 0.4,
  "fadeIn": 2,
  "fadeOut": 1.5,
  "maxDuration": null
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique kebab-case ID |
| `name` | string | Display name |
| `type` | `"bgm"` \| `"sfx"` \| `"ambient"` | Track type |
| `url` | string | Audio source — `@asset:{id}` or direct URL |
| `preload` | boolean (optional) | Set `false` for large tracks to skip eager asset download; playback uses the browser's `metadata` preload hint. Omitted or `true` keeps eager preloading. |
| `allowAiControl` | boolean (optional) | Whether AI directives can control this track. Defaults to enabled when omitted; `false` reserves control for custom UI, scripts, behaviors, and playlists. |
| `loop` | boolean | Whether to loop (typical: true for BGM/ambient, false for SFX) |
| `volume` | number | 0.0 to 1.0 |
| `fadeIn` | number \| null | Fade-in duration in seconds |
| `fadeOut` | number \| null | Fade-out duration in seconds |
| `maxDuration` | number \| null | Auto-stop after N seconds |

## AI Audio Directives

The AI triggers audio through bracket directives for tracks with `allowAiControl` enabled or omitted. Tracks with `allowAiControl: false` are excluded from the model's audio track list, and directives targeting them are ignored on send, regenerate, and continue. AI playback chains cannot target them, and AI crossfades leave them playing. This setting does not block custom UI, scripts, behaviors, or playlists.

```
[audio: bgm-tavern play]
[audio: sfx-sword play]
[audio: bgm-tavern stop]
[audio: bgm-battle crossfade 2.5]
[audio: ambient-rain volume 0.3]
[audio: sfx-magic play chain:bgm-ambient]
```

| Action | Description |
|--------|-------------|
| `play` | Start playing the track |
| `stop` | Stop the track |
| `crossfade <seconds>` | Crossfade from current BGM to this track |
| `volume <0-1>` | Change track volume |
| `play chain:<trackId>` | Play this track, then auto-play the next |

## BGM Playlist

Auto-play a sequence of BGM tracks:

```json
{
  "bgmPlaylist": {
    "tracks": ["bgm-explore-1", "bgm-explore-2", "bgm-explore-3"],
    "playMode": "shuffle",
    "gapSeconds": 0,
    "autoPlay": true,
    "waitForFirstMessage": true
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `tracks` | string[] | Array of track IDs to cycle through |
| `playMode` | `"loop"` \| `"shuffle"` \| `"sequential"` | Playback order mode |
| `gapSeconds` | number | Silence between tracks (default: 0, max: 30) |
| `autoPlay` | boolean | Start playing automatically (default: true) |
| `waitForFirstMessage` | boolean | Don't start until the player sends their first message |

## Conditional BGM

Play specific tracks when conditions are met. Supports variable checks, keyword matching, turn count, and session start triggers.

```json
{
  "conditionalBGM": [
    {
      "id": "combat-music",
      "name": "Combat Music",
      "targetTrackId": "bgm-battle",
      "triggerType": "variable",
      "conditions": [
        { "variableId": "in-combat", "operator": "eq", "value": true }
      ],
      "conditionLogic": "all",
      "priority": 10,
      "fadeInDuration": 1,
      "fadeOutDuration": 2,
      "stopPreviousBGM": true,
      "fallback": "default"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier |
| `name` | string | Display name |
| `targetTrackId` | string | Track to play when triggered |
| `triggerType` | `"variable"` \| `"ai-keyword"` \| `"keyword"` \| `"turn-count"` \| `"session-start"` | What triggers the conditional BGM |
| `conditions` | Condition[] | Variable conditions to check |
| `conditionLogic` | `"all"` \| `"any"` | How multiple conditions combine (default: `"all"`) |
| `keywords` | string[] | Keywords to match (for `keyword` / `ai-keyword` triggers) |
| `matchWholeWords` | boolean | Match whole words only (for keyword triggers) |
| `atTurn` | number | Fire at specific turn (for `turn-count` trigger) |
| `everyNTurns` | number | Fire every N turns (for `turn-count` trigger) |
| `priority` | number | Higher priority wins when multiple triggers match |
| `fadeInDuration` | number | Fade-in duration in seconds |
| `fadeOutDuration` | number | Fade-out duration in seconds |
| `stopPreviousBGM` | boolean | Stop the currently playing BGM first |
| `fallback` | `"default"` \| `"previous"` \| trackId string | What to play when the condition becomes false |

Condition operators use short form: `eq`, `neq`, `gt`, `lt`, `gte`, `lte`, `contains`.

When the condition becomes true, the track starts. When false, it stops (with fade-out if configured) and falls back according to the `fallback` setting.
