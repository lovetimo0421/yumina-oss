<div v-pre>

# Audio Design Guide

> This isn't a single recipe — it's a collection of techniques for using Yumina's audio system to craft a complete soundscape: BGM that follows scene changes, keyword-triggered sound effects, looping ambient sounds, silky crossfades, and every way to control music from custom UI and AI narration.

---

## Overview

Yumina's audio system has multiple entry points for controlling sound at different levels:

| Control Method | Where to Set It | Characteristics |
|---------------|----------------|-----------------|
| Playlist autoplay | **Audio** tab | Simplest — background music starts as soon as the player enters the world |
| Conditional BGM | **Audio** tab | Automatically switches tracks when variable/keyword/turn-count conditions are met, no behaviors needed |
| Behavior + Play Audio action | **Behaviors** tab | Crossfade on scene transitions, combine with variable changes and entry toggling |
| AI audio directives | AI writes `[audio: ...]` in its reply | AI decides what to play and when — most flexible, also least predictable |
| Root Component audio API | **Custom UI** section | Trigger from custom buttons, great for jukebox-style interactive UI |

This guide covers 7 patterns one by one. Pick what you need, or combine them.

---

## Pattern 1: Basic BGM Setup

### What you'll build

Background music that starts playing the moment a player enters your world — looping, no extra setup required.

### Step by step

#### Step 1: Upload audio tracks

Editor → **Audio** tab → click "Add Track"

| Field | Value | Why |
|-------|-------|-----|
| Display Name | Main Theme | For your own reference |
| ID | `main_theme` | All references use this ID |
| Type | BGM | Background music |
| Audio File | Upload your `.mp3` or `.ogg` file | Common audio formats supported |
| Loop | On | BGM usually needs to loop |
| Volume | `0.7` | Don't go too loud — leave room for SFX and ambient |
| Fade In | `2` seconds | Gradually fades in so it's not jarring |

> Want more than one track? Repeat the steps above to create additional tracks — e.g. `explore_bgm` (exploration), `battle_bgm` (combat), `town_bgm` (town).

#### Step 2: Set up the playlist

Still in the **Audio** tab, find the "BGM Playlist" section:

| Field | Value | Why |
|-------|-------|-----|
| Track List | Select `main_theme` (select all if you have multiple) | Tracks in the list play in order |
| Play Mode | `loop` or `shuffle` | `loop` = play in order, repeat; `shuffle` = randomize |
| Autoplay | On | Music starts when the player enters the world |
| Wait for First Message | Off (or On, depending on your preference) | If On, music waits until the player sends their first message |
| Gap Seconds | `0` (or `2`) | Pause between tracks; `0` = seamless transition |

#### Result

Player enters the world → music starts automatically (with a 2-second fade-in) → when one track ends, the next one starts → after the last track, it loops back to the beginning.

::: tip Only have one BGM track?
If you've only got one song, just turn on `loop` for that track and put it alone in the playlist. You can even skip the playlist entirely and control it via Conditional BGM or AI directives instead.
:::

---

## Pattern 2: Crossfading BGM on Scene Transitions

### What you'll build

When the player moves from "Village" to "Dungeon", the village's gentle music gradually fades out while the dungeon's ominous music fades in — both tracks play simultaneously for a brief overlap, making the transition smooth and cinematic.

### How it works

```
Player clicks "Go to Dungeon" button
  → Behavior fires: sets variable location = "dungeon"
  → Same behavior's Play Audio action: crossfade to dungeon_bgm
  → Old track fades out + new track fades in, transition duration 2 seconds
```

### Step by step

#### Step 1: Prepare audio tracks

In the **Audio** tab, create two (or more) BGM tracks:

- `village_bgm` — village music, type BGM, loop on
- `dungeon_bgm` — dungeon music, type BGM, loop on

Put `village_bgm` in the playlist as the default track, with autoplay on.

#### Step 2: Create a variable

Editor → **Variables** tab → Add Variable

| Field | Value |
|-------|-------|
| Display Name | Current Location |
| ID | `location` |
| Type | String |
| Default Value | `village` |

#### Step 3: Create a behavior

Editor → **Behaviors** tab → Add Behavior

**Behavior name:** Go to Dungeon

**Trigger:** Action → Action ID: `go-dungeon`

**Actions (in order):**

| # | Action Type | Setting | Purpose |
|---|-------------|---------|---------|
| 1 | Set Variable | `location` set to `dungeon` | Record that the player went to the dungeon |
| 2 | Play Audio | Track `dungeon_bgm`, operation: `crossfade`, fade duration `2` seconds | Silky-smooth track switch |
| 3 | Enable Entry | Dungeon Atmosphere | Turn on the dungeon lore |
| 4 | Disable Entry | Village Atmosphere | Turn off the village lore |

Create a matching "Return to Village" behavior with action ID `go-village` that does the reverse (crossfade to `village_bgm`, swap entry toggles).

#### Step 4: Trigger from the Root Component

In the Root Component `index.tsx` (inside the `<Chat renderBubble>` callback or on any custom button), call `executeAction`:

```tsx
<button onClick={() => api.executeAction("go-dungeon")}>
  Go to Dungeon
</button>
```

The behavior executes all its actions in sequence — changes the variable, switches the music, toggles entries — all from one button click.

> **What is crossfade?** Cross-fade — the old track gradually gets quieter while the new track gradually gets louder. Both tracks play simultaneously for a brief period, sounding like a cinematic scene transition instead of an abrupt cut. A fade duration of 2-3 seconds works well.

---

## Pattern 3: Keyword-Triggered Sound Effects

### What you'll build

An explosion sound plays automatically when the AI writes "explosion". A creaky door sound plays when the player says "open the door". No behaviors needed — you configure this directly in the **Audio** tab's Conditional BGM section.

### How it works

Conditional BGM has trigger types called `ai-keyword` (AI keyword) and `keyword` (player keyword). The engine scans each message's text and plays the corresponding track when a keyword matches. Despite the name "Conditional BGM", it can point to any track type — including SFX.

### Step by step

#### Step 1: Create SFX tracks

In the **Audio** tab, create sound effect tracks:

**Explosion SFX:**

| Field | Value |
|-------|-------|
| Display Name | Explosion |
| ID | `explosion_sfx` |
| Type | SFX |
| Loop | Off (sound effects usually play once) |
| Volume | `0.9` |

**Door Open SFX:**

| Field | Value |
|-------|-------|
| Display Name | Door Open |
| ID | `door_open_sfx` |
| Type | SFX |
| Loop | Off |
| Volume | `0.8` |

#### Step 2: Create Conditional BGM rules

Still in the **Audio** tab, find the "Conditional BGM" section → click "Add Rule"

**Rule 1: Play SFX when AI says "explosion"**

| Field | Value | Why |
|-------|-------|-----|
| Name | AI Explosion SFX | For your own reference |
| Trigger Type | AI Keyword (`ai-keyword`) | Fires when the AI's reply contains the specified keyword |
| Keywords | `explosion`, `blast`, `detonate` | You can add multiple synonyms — matching any one triggers it |
| Target Track | `explosion_sfx` | Play the explosion sound |
| Stop Current BGM | Off | SFX layers on top of the BGM — don't stop the music |

**Rule 2: Play SFX when player says "open the door"**

| Field | Value | Why |
|-------|-------|-----|
| Name | Player Door SFX | For your own reference |
| Trigger Type | Player Keyword (`keyword`) | Fires when the player's message contains the specified keyword |
| Keywords | `open the door`, `push the door`, `open door` | Multiple synonyms |
| Target Track | `door_open_sfx` | Play the door sound |
| Stop Current BGM | Off | Same as above |

#### Result

```
AI writes: "BOOM — a deafening explosion rocks the hillside, fire lighting up the entire sky."
  → Engine scans and matches "explosion" → auto-plays explosion_sfx
  → Player hears the explosion sound while BGM keeps playing

Player types: "I walk to the door and open it."
  → Engine scans and matches "open the door" → auto-plays door_open_sfx
```

::: info SFX vs BGM
SFX (sound effects) play once and stop. BGM (background music) loops or continues per the playlist. When a Conditional BGM rule targets an SFX-type track, it plays once and doesn't replace the current background music. But if `stopPreviousBGM` is set to `true`, it stops the current BGM first before playing the track — SFX usually doesn't need this.
:::

---

## Pattern 4: Conditional BGM — Variable-Driven Auto-Switching

### What you'll build

No behaviors needed — configure a rule directly in the **Audio** tab: when `hp` drops below 20, automatically switch to tense crisis music; when `hp` returns above 20, switch back to the default track.

### How it works

Conditional BGM's `variable` trigger type checks automatically after every variable change. Condition met → switch to the target track; condition no longer met → fall back based on the `fallback` setting (return to the playlist's default track, or to the previously playing track).

### Step by step

#### Step 1: Prepare audio tracks

Make sure the **Audio** tab has:

- `explore_bgm` — default exploration music (in the playlist)
- `crisis_bgm` — crisis music (only plays when the condition triggers; doesn't need to be in the playlist)

#### Step 2: Create a Conditional BGM rule

**Audio** tab → Conditional BGM → Add Rule

| Field | Value | Why |
|-------|-------|-----|
| Name | Low HP Crisis Music | For your own reference |
| Trigger Type | Variable (`variable`) | Decides based on variable values |
| Condition | `hp` < `20` | Triggers when HP is below 20 |
| Condition Logic | All (`all`) | Only one condition here, so `all` and `any` work the same |
| Target Track | `crisis_bgm` | Switch to crisis music |
| Priority | `10` | If multiple rules match simultaneously, higher priority wins |
| Fade In Duration | `1` second | New track gradually fades in |
| Fade Out Duration | `1` second | Old track gradually fades out |
| Stop Current BGM | On | Stop the exploration music before playing crisis music |
| Fallback | `default` | When the condition is no longer met (HP goes back above 20), automatically return to the playlist's default track |

#### Result

```
Player is exploring, BGM is explore_bgm
  → AI replies: [hp: -15] (hp drops from 30 to 15)
  → Engine detects hp < 20, condition met
  → explore_bgm fades out over 1 second, crisis_bgm fades in over 1 second
  → Atmosphere instantly gets tense

Player uses a healing potion
  → AI replies: [hp: +20] (hp goes from 15 back to 35)
  → Engine detects hp is no longer < 20, condition not met
  → fallback: "default" → automatically switches back to explore_bgm
```

::: tip Multi-condition combos
You can add multiple conditions to a single rule. For example: `hp < 20` **AND** `location == "dungeon"` → crisis music only plays when you're in the dungeon with low HP. Set the condition logic to `all` (all must match).
:::

---

## Pattern 5: Ambient Sound Loops

### What you'll build

Continuously playing ambient sounds in the scene background — rain, wind, tavern chatter — layered on top of the BGM to deepen immersion.

### How it works

Ambient is the third track type. It plays independently of BGM — you can have a BGM track + an ambient track playing simultaneously. Ambient is usually set to loop at low volume, serving as a constant atmospheric backdrop.

### Step by step

#### Step 1: Create Ambient tracks

**Audio** tab → Add Track

| Field | Value |
|-------|-------|
| Display Name | Rain |
| ID | `rain_ambient` |
| Type | Ambient |
| Loop | On |
| Volume | `0.3` (ambient should be quieter than BGM — it's the backdrop) |
| Fade In | `3` seconds (appears gradually, not jarring) |
| Fade Out | `3` seconds |

Create more as needed: `wind_ambient` (wind), `tavern_ambient` (tavern chatter), `forest_ambient` (birdsong and insects).

#### Step 2: Control ambient via Conditional BGM

Same as Pattern 4 — use a Conditional BGM rule to control when ambient plays.

**Rule: Play forest ambient when in the forest**

| Field | Value |
|-------|-------|
| Name | Forest Ambient |
| Trigger Type | Variable (`variable`) |
| Condition | `location` == `forest` |
| Target Track | `forest_ambient` |
| Stop Current BGM | **Off** |
| Fallback | `default` |

> **Key: `stopPreviousBGM` must be Off.** Ambient layers on top of BGM — it shouldn't stop the background music. If you turn it on, switching ambient tracks will also kill whatever BGM is currently playing.

#### You can also control ambient via behaviors

If you already have scene-switching behaviors (like Pattern 2), just add a "Play Audio" action to the behavior's action list, targeting the ambient track:

| # | Action Type | Setting | Purpose |
|---|-------------|---------|---------|
| 1 | Set Variable | `location` set to `forest` | Record the location |
| 2 | Play Audio | `forest_bgm`, operation: crossfade, fade 2s | Switch the BGM |
| 3 | Play Audio | `forest_ambient`, operation: play, fade in 3s | Layer in the ambient sound |
| 4 | Play Audio | `tavern_ambient`, operation: stop, fade out 3s | Stop the old ambient sound |

This way, a single behavior handles both the BGM switch and the ambient swap.

::: tip Volume recommendations
BGM: typically 0.5-0.7. Ambient: 0.2-0.4. SFX: 0.7-1.0. With these three layers at different levels, they won't fight each other.
:::

---

## Pattern 6: Controlling Audio from the Root Component

### What you'll build

A "jukebox" in the Root Component — a few buttons that each play a different track, plus a "Stop" button. This is pure UI control — no behaviors or conditional rules needed.

### How it works

`useYumina()` provides these audio APIs (all durations in **seconds**):

- `api.playAudio?.(trackId, opts)` — play the specified track. `opts` includes `volume`, `fadeDuration`, `chainTo`, `maxDuration`, `duckBgm`, and `loop` (override the track's loop for this playback)
- `api.stopAudio?.(trackId?)` — stop the specified track (omit the ID to stop everything). Destroys the element — use `pauseAudio` to resume later
- `api.pauseAudio?.(trackId)` / `api.resumeAudio?.(trackId)` — real pause/resume in place
- `api.onAudioEnded?.(cb)` — run `cb(trackId)` when a non-looping track finishes; returns an unsubscribe function. Use it to auto-advance a playlist:

```tsx
React.useEffect(() => api.onAudioEnded?.((endedId) => {
  if (endedId === currentTrackId && mode !== "single") playNext();
}), [currentTrackId, mode]);
```

Both methods can be called directly in the Root Component `index.tsx` (inside `<Chat renderBubble>` callbacks, or on any button you add).

### Step by step

#### Step 1: Prepare audio tracks

Make sure the **Audio** tab has the tracks you want to play (create them as in Pattern 1). Let's say you have:

- `jazz_bgm` — jazz
- `rock_bgm` — rock
- `classical_bgm` — classical

#### Step 2: Write the Root Component code

Editor → **Custom UI** section → open `index.tsx` → paste the following (replace the default `return <Chat />`):

```tsx
export default function MyWorld() {
  const api = useYumina();
  const msgs = api.messages || [];

  const tracks = [
    { id: "jazz_bgm", label: "Jazz", color: "#7c3aed" },
    { id: "rock_bgm", label: "Rock", color: "#dc2626" },
    { id: "classical_bgm", label: "Classical", color: "#0891b2" },
  ];

  return (
    <Chat renderBubble={(msg) => {
      const isLastMsg = msg.messageIndex === msgs.length - 1;
      return (
    <div>
      <div
        style={{ color: "#e2e8f0", lineHeight: 1.7 }}
        dangerouslySetInnerHTML={{ __html: msg.contentHtml }}
      />

      {isLastMsg && (
        <div style={{
          marginTop: "12px",
          padding: "12px",
          background: "rgba(30,41,59,0.5)",
          borderRadius: "8px",
          border: "1px solid #334155",
        }}>
          <div style={{ fontSize: "12px", color: "#94a3b8", marginBottom: "8px" }}>
            Jukebox
          </div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {tracks.map((t) => (
              <button
                key={t.id}
                onClick={() => api.playAudio?.(t.id, { fadeDuration: 1.5 })}
                style={{
                  padding: "8px 16px",
                  background: t.color,
                  border: "none",
                  borderRadius: "6px",
                  color: "#fff",
                  fontSize: "13px",
                  cursor: "pointer",
                }}
              >
                {t.label}
              </button>
            ))}
            <button
              onClick={() => api.stopAudio?.()}
              style={{
                padding: "8px 16px",
                background: "#475569",
                border: "none",
                borderRadius: "6px",
                color: "#e2e8f0",
                fontSize: "13px",
                cursor: "pointer",
              }}
            >
              Stop
            </button>
          </div>
        </div>
      )}
    </div>
      );
    }} />
  );
}
```

**Line-by-line breakdown:**

- `MyWorld()` is the Root Component — the world's UI entry point. `<Chat renderBubble={...} />` keeps the platform in charge of the message list, input, and scrolling; we only customize the per-bubble layout
- `api.playAudio?.(t.id, { fadeDuration: 1.5 })` — plays the specified track with a 1.5-second fade-in. If another track is currently playing, it automatically stops it first
- `api.stopAudio?.()` — called with no arguments = stops all currently playing audio
- `msg.messageIndex === msgs.length - 1` — only shows the jukebox on the last message, so it doesn't repeat on every message

::: tip More advanced usage
You can read variables to control UI state. For example, use a `now_playing` variable to track the current track ID, then show a "Now Playing" indicator on the button:

```tsx
const nowPlaying = String(api.variables.now_playing || "");

// Update the variable alongside playback
onClick={() => {
  api.playAudio?.(t.id, { fadeDuration: 1.5 });
  api.setVariable("now_playing", t.id);
}}

// Show status on the button
{nowPlaying === t.id ? "♪ " + t.label : t.label}
```
:::

---

## Pattern 7: AI-Driven Audio Control

### What you'll build

Let the AI naturally control music during narration — play a lively accordion tune when describing entering a tavern, switch to intense battle BGM when a fight breaks out, play a pain sound effect when a character gets hurt.

### How it works

The AI can embed `[audio: trackId action]` directives in its replies. The engine automatically recognizes and executes these directives while stripping them from the text the player sees — like stage directions in a screenplay that the audience never reads, but the crew follows.

### Step by step

#### Step 1: Register all tracks the AI might use

In the **Audio** tab, create all the tracks you want the AI to control:

- `tavern_bgm` — tavern music
- `battle_bgm` — battle music
- `sword_clash_sfx` — sword clash sound effect
- `pain_sfx` — pain/injury sound effect
- `rain_ambient` — rain ambient

#### Step 2: Tell the AI what tracks are available via the system prompt

The AI won't automatically know which tracks you've registered. You need to create an entry in the **Entries** tab listing the available tracks and usage rules:

**Entry name:** Audio Directive Reference

**Section:** System Presets

**Content:**

```
[Audio Control System]
You can use the following audio directives in your replies to control music and sound effects. Directives are automatically executed and stripped from the text the player sees.

Available directive formats:
- [audio: trackId play] — play
- [audio: trackId play 2.0] — play with a 2-second fade-in
- [audio: trackId stop] — stop
- [audio: trackId stop 1.5] — stop with a 1.5-second fade-out
- [audio: trackId crossfade 2.0] — crossfade transition, 2-second overlap
- [audio: trackId volume 0.5] — adjust volume to 0.5
- [audio: trackId play chain:nextTrackId] — after this track finishes, automatically start the next one

Available tracks:
- tavern_bgm — lively tavern accordion music (good for social scenes, shopping)
- battle_bgm — intense battle music (good for combat, chase scenes)
- sword_clash_sfx — sword clash sound effect (good for melee action descriptions)
- pain_sfx — pain/injury sound effect (good for when a character gets hurt)
- rain_ambient — rain ambient sound (good for rainy scenes)

Usage guidelines:
- Insert audio directives at natural narrative points
- Use crossfade for scene transitions, with a duration of 1.5-2.5 seconds
- Pair sound effects with action descriptions, placing them near the corresponding text
- Don't overdo it — 2-3 audio directives per response at most
```

#### Step 3: Example AI response

After telling the AI these rules, its replies might look like this:

```
You push open the tavern's heavy wooden door, and a rush of warm air hits your face. [audio: tavern_bgm crossfade 2.0]

The tavern is buzzing — someone's playing accordion in the corner, and a dwarf at the bar is shouting over a dice game. You've barely found a seat when a masked figure suddenly draws a blade and lunges at you!

[audio: battle_bgm crossfade 0.5] [audio: sword_clash_sfx play]

You throw yourself sideways on instinct. The table splits in two behind you.
```

The player sees clean narrative text while hearing: tavern music fading in → abrupt switch to battle music + sword clash sound effect.

#### The `chain` directive — special usage

`chain` lets one track automatically start another when it finishes:

```
The sound of war horns echoes through the valley — the battle is about to begin! [audio: war_horn_sfx play chain:battle_bgm]
```

After the `war_horn_sfx` horn blast finishes playing, `battle_bgm` starts automatically — an intro into the main track, more ceremonial than a direct switch.

::: warning The AI might forget to use directives
The AI won't always remember to insert audio directives, especially in long conversations. For critical scene BGM changes (like entering a combat zone), set up Conditional BGM rules (Pattern 4) as a fallback. AI directives are the icing on the cake; Conditional BGM is the safety net.
:::

---

## Comprehensive Quick Reference

### Track types

| Type | Purpose | Typical Settings |
|------|---------|-----------------|
| BGM | Background music | Loop on, volume 0.5-0.7 |
| SFX | One-shot sound effects | Loop off, volume 0.7-1.0 |
| Ambient | Looping ambient sounds | Loop on, volume 0.2-0.4 |

### 5 ways to control audio

| What you want to do | Which method | Where to set it up |
|--------------------|-------------|-------------------|
| Auto-play BGM when entering the world | Playlist + autoplay | **Audio** tab → BGM Playlist |
| Auto-switch track when variable conditions are met | Conditional BGM (variable trigger) | **Audio** tab → Conditional BGM |
| Play SFX when AI reply contains a keyword | Conditional BGM (ai-keyword trigger) | **Audio** tab → Conditional BGM |
| Play SFX when player message contains a keyword | Conditional BGM (keyword trigger) | **Audio** tab → Conditional BGM |
| Switch track at a specific turn number | Conditional BGM (turn-count trigger) | **Audio** tab → Conditional BGM |
| Crossfade on scene transition | Behavior + Play Audio action | **Behaviors** tab |
| Play/stop from a button click | Root Component `api.playAudio?.()` / `api.stopAudio?.()` | **Custom UI** section |
| AI triggers audio during narration | AI audio directives `[audio: trackId action]` | **Entries** tab (tell the AI the rules) |

### AI audio directive reference

| Directive | Effect |
|-----------|--------|
| `[audio: trackId play]` | Play |
| `[audio: trackId play 2.0]` | Play with 2-second fade-in |
| `[audio: trackId stop]` | Stop |
| `[audio: trackId stop 1.5]` | Stop with 1.5-second fade-out |
| `[audio: trackId crossfade 2.0]` | Crossfade transition, 2-second overlap |
| `[audio: trackId volume 0.5]` | Adjust volume |
| `[audio: trackId play chain:nextId]` | After finishing, automatically start next track |

### Conditional BGM trigger types

| Trigger Type | When It Fires | Typical Use |
|-------------|--------------|-------------|
| `variable` | When variable conditions are met | hp < 20 plays crisis music |
| `ai-keyword` | When AI reply contains keyword | AI writes "explosion" plays explosion SFX |
| `keyword` | When player message contains keyword | Player says "perform" plays music |
| `turn-count` | When a specific turn is reached | Turn 10 plays countdown music |
| `session-start` | When the session starts | Fixed opening track |

### Behavior play-audio action parameters

| Parameter | Description |
|-----------|-------------|
| Track ID (`trackId`) | Matches the track ID registered in the Audio tab |
| Operation (`action`) | `play` (play), `stop` (stop), `crossfade` (crossfade switch), `volume` (adjust volume) |
| Volume (`volume`) | 0-1, optional |
| Fade Duration (`fadeDuration`) | Seconds, optional; 1.5-3 seconds recommended for crossfade |

### Root Component audio API

| Method | Description |
|--------|-------------|
| `api.playAudio?.(trackId, opts)` | Play a track. opts can include `fadeDuration` (seconds), `loop`, etc. |
| `api.stopAudio?.(trackId?)` | Stop a track. Omit the ID to stop everything |
| `api.pauseAudio?.(trackId)` / `api.resumeAudio?.(trackId)` | Pause/resume a track in place (keeps position) |
| `api.onAudioEnded?.(cb)` | Subscribe to track-finished events; returns an unsubscribe function. Use to auto-advance a playlist |

---

## Common Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| No sound at all | Browser blocks autoplay | Modern browsers require user interaction (click, type) before allowing audio playback. Have the player send a message first, or turn on "Wait for First Message" in the playlist |
| BGM transition sounds choppy | Not using crossfade | Make sure the behavior's "Play Audio" operation is set to `crossfade` with a fade duration of at least 1.5 seconds |
| SFX and BGM interrupt each other | `stopPreviousBGM` is set to `true` | SFX-type Conditional BGM rules should have "Stop Current BGM" turned off |
| AI doesn't use audio directives | Entry not telling the AI about them | Create a System Presets entry listing all available track IDs and directive formats (see Pattern 7) |
| Ambient too loud | Volume too high | Ambient should be 0.2-0.4, with BGM at 0.5-0.7 to maintain separation |
| Conditional BGM not triggering | Variable value type mismatch | Make sure the condition's value type matches the variable type (e.g. numeric variables need numeric comparisons, not string comparisons) |
| Multiple rules conflicting | Same priority | Give different Conditional BGM rules different priority values — higher numbers take precedence |

---

::: tip This is Recipe #14: Audio Design Guide
The audio system's design philosophy is: simple things just work (playlist + autoplay), and complexity unlocks in layers (Conditional BGM → behavior control → AI directives → custom API). You don't need to learn every pattern at once — start with Pattern 1, and come back for more when you need finer control.
:::

</div>
