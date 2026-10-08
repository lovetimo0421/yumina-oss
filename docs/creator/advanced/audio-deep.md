<div v-pre>

# Audio Design

A survival thriller with rain sounds and a distant heartbeat SFX feels different from one with just text, even if the writing is identical. Setting it up is light: upload a few tracks, configure how they play, and the engine handles the rest.

For the basics of track types (BGM, SFX, Ambient) and setup, see [Visuals & Audio](/creator/visuals-audio).

To find a track's ID, open **Panels → Audio**, select the track, and copy the read-only **Track ID** with **Copy ID** beside it. Use this value for `playAudio(trackId)` and directives such as `[audio: trackId play]`. The **Asset ID** in Assets identifies the uploaded file and is different from the Track ID. Replace example IDs such as `door-slam` below with your track's actual ID.

---

## How audio gets triggered

There are four ways audio plays in your world, from simplest to most flexible.

### 1. Playlists: set it and forget it

The **Default Playlist** auto-plays a sequence of tracks when the player enters your world. Most worlds only need this.

Configure it under **BGM Configuration** in **Panels → Audio**:

| Setting | What it does |
|---------|-------------|
| **Tracks** | Which BGM tracks to play, in order |
| **Play Mode** | **Loop** (restart from beginning), **Shuffle** (random), or **Sequential** (play all, then repeat) |
| **Auto-play** | Attempt playback when the world loads |
| **Wait for first message** | Don't start until the player sends their first message — useful for worlds with character creation or an opening cutscene |
| **Gap between tracks (s)** (0-30) | Silence between tracks, for a "changing records" feel |

Sakura Season and PRTS Terminal both use the simplest possible setup: one BGM track, loop mode, auto-play on. That's their entire audio configuration.

::: details The minimal setup
Upload one audio file. Create a BGM track. Add it to the playlist with **Auto-play** on. If the browser blocks automatic playback, it retries on a later user gesture. Leaving the world stops its audio.
:::

### 2. Smart tracking: the AI picks from your cues

In **Panels → Audio**, each track has **Let the AI play this track** (for SFX, **Let the AI play this sound**). Write one line in **When to play**, like "lively and cheerful — festivals, markets, chasing around", or for a sound, "someone draws a blade". After each reply, smart tracking checks the scene against these cues: it switches the music when the story matches a track, and plays a sound once when its moment arrives. Leave the line empty and the track only follows the playlist and conditional rules.

This works whatever model the player uses, because the story AI doesn't have to remember to write anything. A few settings decide how it gets along with your other music:

- **When the AI wants to switch but a conditional rule is playing its own track**: **Rules first** (the rule's track keeps playing) or **AI first** (switch to the AI's pick until it ends or the AI hands back)
- **After an AI-picked track**: keep looping until the AI switches, or play it once and return to the default playlist
- **Dip the background music while an AI-picked sound plays**, then restore it

Smart tracking is on by default; it's the switch of the same name in **Card settings**.

### 3. AI directives: let the narrator cue the soundtrack

The AI can embed audio commands in its responses using the same bracket syntax as variable directives. The player never sees these — the engine strips them before displaying the text.

Only tracks with **Allow AI control** enabled can be controlled this way. It's on by default; turn it off (click the track on the canvas, or in **Panels → Audio**) to reserve a track for custom UI, scripts, behaviors, or playlists. Copy the track's **Track ID** with **Copy ID** when writing directives or custom UI calls.

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

The `chain` directive is useful for transitions: play a war horn SFX, then move to battle BGM when the horn finishes, without a second directive.

AI directives can be mixed with state changes in the same response:

```
A rumbling echoes from deep in the dungeon. [audio: earthquake-sfx play]
Debris falls from the ceiling. [health: -5]
The ambient sound grows oppressive. [audio: ambient-cave volume 0.3]
```

**The catch:** The AI sometimes forgets to include directives, especially in long responses or when it's focused on complex narrative. For audio that absolutely must play at the right moment, use conditional BGM or behaviors instead.

### 4. Conditional BGM: music follows the story

You define conditions, and the engine switches tracks when they're met, with no AI involved. Click **Add Conditional Rule** under **Conditional BGM** in **Panels → Audio**.

The result is a soundtrack that follows the game state: tavern music when in the tavern, battle music when in combat, exploration music everywhere else.

Each conditional BGM rule has:

| Setting | What it does |
|---------|-------------|
| **WHEN** | What to watch: **Variable condition**, **Player keyword** / **AI keyword** (text matching), **Turn count**, or **Session start** |
| **Conditions** | Variable checks (for **Variable condition**), combined with **ALL conditions met** or **ANY condition met** |
| **Play** | Which track to switch to |
| **Priority** | Higher numbers win when multiple conditions match |
| **Fade In (s) / Fade Out (s)** | Transition speed in seconds |
| **Stop previous BGM** | Usually on — unless you want to layer multiple tracks |
| **On end** | What plays when the condition stops being true: **Return to default playlist**, **Return to previous track**, or a specific track |

::: details Example: combat track switch
Two BGM tracks: `explore-bgm` and `battle-bgm`. The playlist plays exploration music by default. A conditional BGM rule watches for `location` is `battle_arena` — when it becomes true, the engine fades to battle music over 0.5 seconds. When the player leaves the arena, **Return to default playlist** brings back exploration.

The player hears a smooth musical transition whenever combat starts and ends, without the AI having to remember anything about audio.
:::

---

## Using behaviors for audio

Behaviors have three audio effects, **Play music**, **Play sound effect** and **Stop audio**, which control audio without involving the AI at all. This is the most reliable method for audio that must fire at a precise moment.

Battle Royale uses a `death-sfx` track and a `heartbeat-sfx` track as part of its audio toolkit. While its current version relies on AI directives to trigger them, wiring these to behaviors would guarantee they play at the right moment — a heartbeat SFX when health drops below 20, a death sound when health hits zero.

| Effect | What it does |
|--------|-------------|
| **Play music** | Play a background track |
| **Play sound effect** | Play a one-shot sound |
| **Stop audio** | Stop the track |

Combined with a **Variable crosses threshold** trigger, this gives you audio cues that always fire:

```
WHEN:     health drops below 20
EFFECT:   Play music → crisis-bgm
```

Fades and volume changes aren't behavior effects. For those, use conditional BGM, AI directives, or `api.playAudio(trackId, { fadeDuration, volume })` from interface code.

---

## Design advice

### Volume balance

BGM at 0.3-0.5 works for most worlds. Players are reading text — music that's too loud competes with concentration. Ambient tracks can sit even lower (0.1-0.3) as background texture. SFX should be louder (0.7-0.9) because they're brief and meant to punctuate moments.

### Fewer tracks, more impact

Battle Royale has four audio tracks: a character creation BGM, a game playlist BGM, a heartbeat SFX, and a death SFX. That's enough to create tension throughout a multi-hour survival game. You don't need a library of 20 tracks — a few well-chosen ones with good fade transitions do more than a cluttered soundtrack.

### Fade everything

Abrupt audio cuts are jarring. Set **Fade In (s)** to 2 and **Fade Out (s)** to 1.5 on BGM tracks so transitions feel smooth. Use `crossfade` instead of stop-then-play when switching between tracks. The default conditional BGM fade (1 second in, 1 second out) is a reasonable starting point.

### When to let the AI handle it vs. when to automate

Let the AI handle audio when the trigger is *narrative* — a door slamming, a character gasping, an explosion. These moments are unpredictable and the AI knows when they happen because it's writing them.

Automate audio when the trigger is *mechanical* — entering a location, health crossing a threshold, a specific turn number. These are precise state changes that the engine tracks better than the AI.

Many worlds mix them: a playlist for base music, conditional BGM for location-based switches, and "When to play" cues or AI directives for dramatic SFX moments.

---

## See also

- [AI Directives & Macros](/creator/advanced/directives-macros) — how audio directives fit into the broader directive system
- [Behaviors & Automation](/creator/advanced/rules-deep) — audio effects in behaviors for precise audio triggers
- [Custom UI Guide](/creator/advanced/custom-ui-deep) — controlling audio from your custom UI via the bridge API

Complete audio schema and playlist config → [World Spec: Audio](/world-spec/audio)

</div>
