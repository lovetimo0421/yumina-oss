<div v-pre>

# Audio Design

Audio is the fastest way to make a world feel real. A survival thriller with rain sounds and a distant heartbeat SFX feels different from one with just text — even if the writing is identical. The system is lightweight: upload a few tracks, configure how they play, and the engine handles the rest.

For the basics of track types (BGM, SFX, Ambient) and setup, see [Get Started: Visuals & Audio](/creator/visuals-audio).

To find a track's ID, open **Studio → Audio**, select the track, and copy the read-only **Track ID** using the copy button beside it. Use this value for `playAudio(trackId)` and directives such as `[audio: trackId play]`. The **Asset ID** in Assets identifies the uploaded file and is different from the Track ID. Replace example IDs such as `door-slam` below with your track's actual ID.

---

## How audio gets triggered

There are three ways audio plays in your world, from simplest to most flexible.

### 1. Playlists: set it and forget it

The **BGM Playlist** auto-plays a sequence of tracks when the player enters your world. Most worlds only need this.

Configure it in the Audio section of the editor:

| Setting | What it does |
|---------|-------------|
| **tracks** | Which BGM tracks to play, in order |
| **playMode** | `loop` (restart from beginning), `shuffle` (random), or `sequential` (play all, then repeat) |
| **autoPlay** | Start immediately when the world loads |
| **waitForFirstMessage** | Don't start until the player sends their first message — useful for worlds with character creation or an opening cutscene |
| **gapSeconds** (0-30) | Silence between tracks, for a "changing records" feel |

Sakura Season and PRTS Terminal both use the simplest possible setup: one BGM track, loop mode, autoPlay on. That's their entire audio configuration.

::: details The minimal setup
Upload one audio file. Create a BGM track. Add it to the playlist with `autoPlay: true`. Done — players hear music from the moment they start.
:::

### 2. AI directives: let the narrator cue the soundtrack

The AI can embed audio commands in its responses using the same bracket syntax as variable directives. The player never sees these — the engine strips them before displaying the text.

Only tracks with **Allow AI control** enabled can be controlled this way. Turn it off in the Audio editor to reserve a track for custom UI, scripts, behaviors, or playlists. Existing tracks default to enabled. Copy the track's **Track ID** with **Copy ID** when writing directives or custom UI calls.

```
The door flies open with a deafening crash. [audio: door-slam play]
An armored figure steps through the smoke.
```

The player reads clean narrative and hears the door slam at the same time.

**Available directives:**

| Directive | What it does |
|-----------|-------------|
| `[audio: trackId play]` | Play the track |
| `[audio: trackId stop]` | Stop the track |
| `[audio: trackId crossfade 2.0]` | Fade from the current BGM to this one over 2 seconds |
| `[audio: trackId volume 0.5]` | Change volume without stopping |
| `[audio: trackId play chain:nextTrackId]` | Play this track, then automatically play the next one when it finishes |

The `chain` directive is especially useful for transitions: play a war horn SFX, then seamlessly transition to battle BGM when the horn finishes. Smoother than two separate directives.

AI directives can be mixed with state changes in the same response:

```
A rumbling echoes from deep in the dungeon. [audio: earthquake-sfx play]
Debris falls from the ceiling. [health: -5]
The ambient sound grows oppressive. [audio: ambient-cave volume 0.3]
```

**The catch:** The AI sometimes forgets to include directives, especially in long responses or when it's focused on complex narrative. For audio that absolutely must play at the right moment, use conditional BGM or rules instead.

### 3. Conditional BGM: music follows the story

Conditional BGM is the most interesting part of the audio system. You define conditions, and the engine automatically switches tracks when those conditions are met — no AI involvement required.

Think of it as programming a soundtrack that responds to the game state: tavern music when in the tavern, battle music when in combat, exploration music everywhere else.

Each conditional BGM entry has:

| Setting | What it does |
|---------|-------------|
| **triggerType** | What to watch: `variable` (game state), `keyword` / `ai-keyword` (text matching), `turn-count`, or `session-start` |
| **conditions** | Variable checks (when using `variable` trigger) |
| **targetTrackId** | Which track to switch to |
| **priority** | Higher numbers win when multiple conditions match |
| **fadeInDuration / fadeOutDuration** | Transition speed in seconds |
| **stopPreviousBGM** | Usually true — unless you want to layer multiple tracks |
| **fallback** | What plays when the condition stops being true: `"default"` (return to playlist), `"previous"` (return to last track), or a specific trackId |

::: details Example: combat track switch
Two BGM tracks: `explore-bgm` and `battle-bgm`. The playlist plays exploration music by default. A conditional BGM entry watches for `location eq "battle_arena"` — when it becomes true, the engine crossfades to battle music over 0.5 seconds. When the player leaves the arena, `fallback: "default"` returns to exploration.

The player hears a smooth musical transition whenever combat starts and ends, without the AI having to remember anything about audio.
:::

---

## Using rules for audio

The Behaviors system has a `play-audio` action that gives you full control over audio without involving the AI at all. This is the most reliable method for audio that must fire at a precise moment.

Battle Royale uses a `death-sfx` track and a `heartbeat-sfx` track as part of its audio toolkit. While its current version relies on AI directives to trigger them, wiring these to rules would guarantee they play at the right moment — a heartbeat SFX when health drops below 20, a death sound when health hits zero.

The `play-audio` action supports the same operations as AI directives:

| Action | What it does |
|--------|-------------|
| `play` | Start the track |
| `stop` | Stop the track |
| `crossfade` | Fade from current BGM to this track |
| `volume` | Change volume |

Combined with `variable-crossed` triggers, this creates audio cues that are 100% reliable:

```
WHEN:     health drops below 20
THEN:     play-audio crisis-bgm crossfade (fadeDuration: 1.5)
```

No AI involvement. The engine handles it mechanically.

---

## Design advice

### Volume balance

BGM at 0.3-0.5 works for most worlds. Players are reading text — music that's too loud competes with concentration. Ambient tracks can sit even lower (0.1-0.3) as background texture. SFX should be louder (0.7-0.9) because they're brief and meant to punctuate moments.

### Fewer tracks, more impact

Battle Royale has four audio tracks: a character creation BGM, a game playlist BGM, a heartbeat SFX, and a death SFX. That's enough to create tension throughout a multi-hour survival game. You don't need a library of 20 tracks — a few well-chosen ones with good fade transitions do more than a cluttered soundtrack.

### Fade everything

Abrupt audio cuts are jarring. Set `fadeIn: 2` and `fadeOut: 1.5` on BGM tracks so transitions feel smooth. Use `crossfade` instead of stop-then-play when switching between tracks. The default conditional BGM fade (1 second in, 1 second out) is a reasonable starting point.

### When to let the AI handle it vs. when to automate

Let the AI handle audio when the trigger is *narrative* — a door slamming, a character gasping, an explosion. These moments are unpredictable and the AI knows when they happen because it's writing them.

Automate audio when the trigger is *mechanical* — entering a location, health crossing a threshold, a specific turn number. These are precise state changes that the engine tracks better than the AI.

Many worlds use both: a playlist for base music, conditional BGM for location-based switches, and AI directives for dramatic SFX moments.

---

## See also

- [AI Directives & Macros](/creator/advanced/directives-macros) — how audio directives fit into the broader directive system
- [Behaviors & Automation](/creator/advanced/rules-deep) — the `play-audio` rule action for precise audio triggers
- [Custom UI Guide](/creator/advanced/custom-ui-deep) — controlling audio from your custom UI via the bridge API

Complete audio schema and playlist config → [World Spec: Audio](/world-spec/audio)

</div>
