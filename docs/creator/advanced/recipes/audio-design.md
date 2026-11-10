<div v-pre>

# Audio Design Guide

> A set of patterns for sound in a card: background music that starts on its own, music that follows the scene, sound effects on keywords, ambient loops, music the AI picks to fit the story, and a jukebox in your own interface code. Pick the ones you need; they combine.

---

## Overview

There are several places to control sound:

| Control method | Where to set it | What it's like |
|---------------|----------------|-----------------|
| Default playlist | **Audio** page → **BGM Configuration** | Music starts when the player enters and rotates through your tracks |
| Conditional BGM | **Audio** page → **BGM Configuration** → **Conditional BGM** | Switches track when a variable, keyword, turn count or session start says so. No behaviors needed |
| Let the AI pick | A track's **Let the AI play this track** / **Let the AI play this sound** | You write one line saying when it fits; the AI plays it when the story matches |
| Behaviors | **Play music**, **Play sound effect**, **Stop audio** effects | Sound as one step among others (change a variable, open lore, play a sting) |
| Player interface buttons | **Play audio** / **Stop audio** steps | A button that plays or stops a track, no code |
| Interface code | `api.playAudio()` / `api.stopAudio()` | Full control, for things like a jukebox |

The **Audio** page opens from the audio block on the canvas (click **＋ Audio** in the **Add** row if the card doesn't have one yet), or from **Panels → Audio**.

---

## Pattern 1: Background music that starts on its own

### Step 1: Add tracks

On the **Audio** page, click **Add Track** and fill in:

| Field | Value | Why |
|-------|-------|-----|
| Title | Main Theme | For your own reference |
| Audio Source | Upload an `.mp3` or `.ogg`, or **Browse Assets** | |
| Track Type | BGM | Background music |
| Loop Audio | On | BGM usually loops |
| Default Volume | `0.7` | Leaves room for sound effects and ambient |
| Fade In (s) | `2` | Comes in gradually instead of starting abruptly |

Each track gets a **Track ID** that you can't edit; it stays the same when you rename the track. You only need it for interface code (**Copy ID** sits next to it).

For more than one piece, add more tracks: exploration, battle, town.

### Step 2: Set up the default playlist

Click **BGM Configuration** (Playlist + trigger rules):

| Field | Value | Why |
|-------|-------|-----|
| Default Playlist | Pick Main Theme (and any other BGM tracks) | Tracks in the list play one after another |
| Play Mode | **Loop**, **Shuffle** or **Sequential** | Loop repeats the list in order; Shuffle randomises it |
| Auto-play | On | Music starts when the player enters the card |
| Wait for first message | Off (or on) | On: music waits until the player sends their first message |
| Gap between tracks (s) | `0` (or `2`) | `0` runs one track straight into the next |

### Result

The player opens the card → music fades in over 2 seconds → when a track ends, the next one starts → after the last, the list starts again.

::: tip Only one track?
Turn **Loop Audio** on and put it alone in the playlist.
:::

---

## Pattern 2: Music that follows a variable

### What you'll build

When the player moves from the village to the dungeon, the village music fades out and the dungeon music fades in. When Health drops below 20, tense music takes over; when it recovers, the normal music comes back. None of this needs a behavior.

### How it works

A **Conditional BGM** rule with the trigger **Variable condition** is checked after every change. When its conditions hold, it plays its track. When they stop holding, **On end** decides what plays next: **Return to default playlist**, **Return to previous track**, or a specific track.

### Step by step

Make sure you have a Text variable **Location** (starts at `village`) and the tracks Village and Dungeon. Then **BGM Configuration** → **Conditional BGM** → **Add Conditional Rule**:

| Field | Value | Why |
|-------|-------|-----|
| WHEN | **Variable condition** | Decided by a variable's value |
| Condition | Location is `dungeon` | |
| Play | Dungeon | |
| Priority | `10` | When several rules match at once, the higher number wins |
| Fade In (s) | `2` | The new track fades in |
| Fade Out (s) | `2` | The old track fades out |
| Stop previous BGM | On | The village music stops instead of playing underneath |
| On end | **Return to default playlist** | Back to the village music when the player leaves the dungeon |

A second rule for low health:

| Field | Value |
|-------|-------|
| WHEN | **Variable condition** |
| Condition | Health is less than `20` |
| Play | Crisis |
| Priority | `20` (higher than the location rule, so it wins in the dungeon too) |
| Stop previous BGM | On |
| On end | **Return to previous track** |

```
The player is exploring, the playlist is playing
  → Health drops from 30 to 15
  → The crisis rule matches; the playlist fades out and Crisis fades in
The player drinks a potion, Health goes back to 35
  → The rule no longer matches; On end brings back what was playing before
```

::: tip Several conditions
A rule can have more than one condition. Choose **ALL conditions met** for "Health below 20 **and** Location is dungeon", or **ANY condition met** for either.
:::

::: info Who sets Location?
Anything that changes the variable: the AI (through the variable's Behavior Rules), a button in the player interface (**Change a variable**), or a behavior. The music rule doesn't care how it changed. [Map & Scene Navigation](./map-navigation.md) builds the buttons.
:::

---

## Pattern 3: Sound effects on keywords

### What you'll build

An explosion when the AI writes "explosion", a creaking door when the player says "open the door". Set up on the **Audio** page, no behaviors.

### Step 1: Add SFX tracks

| Field | Explosion | Door |
|-------|-----------|------|
| Title | Explosion | Door Open |
| Track Type | SFX | SFX |
| Loop Audio | Off | Off |
| Default Volume | `0.9` | `0.8` |

### Step 2: Add Conditional BGM rules

Despite the name, a Conditional BGM rule can play any track type, including SFX.

**Rule: the AI says "explosion"**

| Field | Value |
|-------|-------|
| WHEN | **AI keyword** |
| Keywords | `explosion`, `blast`, `detonate` (type each one and press Enter; any one of them triggers it) |
| Play | Explosion |
| Stop previous BGM | Off, so the music keeps playing under the effect |

**Rule: the player says "open the door"**

| Field | Value |
|-------|-------|
| WHEN | **Player keyword** |
| Keywords | `open the door`, `push the door` |
| Play | Door Open |
| Stop previous BGM | Off |

**Match whole words only** stops "blast" from matching inside "blasted"; leave it off if you want both.

---

## Pattern 4: Ambient loops

### What you'll build

Rain, wind or tavern chatter playing quietly under the music.

### How it works

**Ambient** is the third track type. It plays alongside BGM, so you can have one BGM track and one ambient track at the same time. Keep it looping and quiet.

### Step 1: Add an ambient track

| Field | Value |
|-------|-------|
| Title | Forest |
| Track Type | Ambient |
| Loop Audio | On |
| Default Volume | `0.3` (quieter than the music) |
| Fade In (s) | `3` |
| Fade Out (s) | `3` |

### Step 2: Play it where it belongs

Use a Conditional BGM rule like Pattern 2: **Variable condition** Location is `forest`, Play Forest, **On end** **Return to default playlist**.

> **Stop previous BGM must be off** for ambient rules. Ambient sits on top of the music; with the switch on, starting the rain would stop the music.

You can also do it in a behavior that already handles a scene change: add **Play sound effect** or **Play music** for the ambient track, and **Stop audio** for the old one.

::: tip Volume levels
BGM around 0.5 to 0.7, ambient 0.2 to 0.4, sound effects 0.7 to 1.0. At different levels the three layers don't drown each other out.
:::

---

## Pattern 5: Let the AI pick the music

### What you'll build

Lively tavern music when the story walks into a tavern, battle music when a fight breaks out, a sword clash when someone draws a blade, without you writing a rule for each case.

### How it works

Open a track and fill in **Let the AI play this track** (on a BGM track) or **Let the AI play this sound** (on an SFX track). Ambient tracks aren't picked this way; drive them with rules (Pattern 4).

| Track | Field | What to write |
|-------|-------|---------------|
| Tavern (BGM) | **When to play** | `lively and cheerful: taverns, markets, festivals` |
| Battle (BGM) | **When to play** | `a fight breaks out or a chase starts` |
| Sword Clash (SFX) | **Play once when this happens** | `someone draws a blade or swords meet` |

Once a track has a cue, it reads **On: the AI plays this when the story matches**. After each reply, the card checks the story against the cues and switches music or plays the sound. This runs as part of **Smart tracking** (in **Card settings**), so it works the same whichever model the player uses. Leave a cue empty and that track only follows the playlist and your rules.

When at least one track has a cue, the **BGM Configuration** area asks you a few questions about how AI picks and your rules get along. Each appears only when it can actually come up:

- **When the AI wants to switch but a conditional rule is playing its own track**: **Rules first** (the rule keeps playing, the AI waits) or **AI first**
- **After an AI-picked track**: keep looping until the AI switches or hands back, or play it once and return to the default playlist
- **Dip the background music while an AI-picked sound plays, then restore it**

### Keeping a track away from the AI

Turn off **Allow AI control** on a track and the AI can't play, stop or change it. Your playlist, rules, behaviors and interface code still can. Use it for a menu theme or a track your code manages.

### Audio directives

The story AI can also write audio directives straight into its reply. The engine gives the AI the list of tracks it's allowed to control (ID, type and title) and the directive format on its own, so you don't need a lore entry listing them. Directives are taken out of the text before the player sees it:

```
You push open the tavern's heavy door, and warm air hits your face. [audio: <tavern track ID> crossfade 2]
```

| Directive | Effect |
|-----------|--------|
| `[audio: trackId play]` | Play (with the track's own **Fade In**) |
| `[audio: trackId stop]` | Stop (with the track's own **Fade Out**) |
| `[audio: trackId crossfade 2]` | Stop the other BGM the AI controls and fade this one in over 2 seconds |
| `[audio: trackId volume 0.5]` | Change the volume |
| `[audio: trackId play chain:nextTrackId]` | When this track ends, start the next one |

`chain` is good for an intro: a war-horn sound that leads into the battle music once it finishes.

The AI doesn't always remember to write directives, especially in long chats. The cues above (**When to play**) and Conditional BGM rules are the reliable routes; directives are an extra.

---

## Pattern 6: Buttons that play sound

### No code: player interface buttons

In **Player interface**, select a **Button** and under **When pressed, do in order** add **Play audio** (pick the track) or **Stop audio** (one track, or **Stop everything**). A behavior's **Play music**, **Play sound effect** and **Stop audio** effects do the same from the canvas, and a button can run that behavior with **Set off a behavior**.

### Custom code route: a jukebox

`useYumina()` gives your interface code these audio calls (all durations in **seconds**):

- `api.playAudio(trackId, opts)`: play a track. `opts` can include `volume` (0 to 1), `fadeDuration`, `chainTo`, `maxDuration`, `duckBgm` and `loop` (overrides the track's own loop setting for this play)
- `api.stopAudio(trackId?, fadeDuration?)`: stop one track, or everything if you leave out the ID. It discards the track's position; use `pauseAudio` if you want to resume
- `api.pauseAudio(trackId)` / `api.resumeAudio(trackId)`: pause and resume in place
- `api.onAudioEnded(cb)`: calls `cb(trackId)` when a non-looping track finishes, and returns an unsubscribe function

`playAudio` doesn't stop other music by itself. To switch between BGM tracks, stop the others first.

Copy each track's **Track ID** from the **Audio** page, then in **Panels → Front End Code** → `index.tsx`, replace the default `return <Chat />`:

```tsx
export default function MyWorld() {
  const api = useYumina();
  const msgs = api.messages || [];

  // Paste the Track IDs from the Audio page
  const tracks = [
    { id: "PASTE-JAZZ-TRACK-ID", label: "Jazz", color: "#7c3aed" },
    { id: "PASTE-ROCK-TRACK-ID", label: "Rock", color: "#dc2626" },
    { id: "PASTE-CLASSICAL-TRACK-ID", label: "Classical", color: "#0891b2" },
  ];
  const [nowPlaying, setNowPlaying] = React.useState("");

  const play = (t) => {
    // Fade out the other jukebox tracks, then fade this one in
    tracks.forEach((other) => {
      if (other.id !== t.id) api.stopAudio(other.id, 1.5);
    });
    api.playAudio(t.id, { fadeDuration: 1.5 });
    setNowPlaying(t.id);
  };

  const stop = () => {
    api.stopAudio();
    setNowPlaying("");
  };

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
                    onClick={() => play(t)}
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
                    {nowPlaying === t.id ? "♪ " + t.label : t.label}
                  </button>
                ))}
                <button
                  onClick={stop}
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

**What the code does:**

- `<Chat renderBubble={...} />` keeps the platform's message list, input box and scrolling; you only draw each bubble
- `play()` fades out the other jukebox tracks over 1.5 seconds and fades the chosen one in
- `api.stopAudio()` with no arguments stops everything that's playing
- `nowPlaying` is local to the interface, so it resets when the page reloads. To remember the choice in the save, store it in a variable with `api.setVariable("Now playing", t.id)` and read it back from `api.variables["Now playing"]`
- The jukebox only shows under the last message

To move through a playlist of your own, listen for the end of each track:

```tsx
React.useEffect(() => api.onAudioEnded((endedId) => {
  if (endedId === nowPlaying) playNext();
}), [nowPlaying]);
```

(This only fires for tracks that don't loop.)

---

## Quick reference

### Track types

| Type | Purpose | Typical settings |
|------|---------|-----------------|
| BGM | Background music | Loop on, volume 0.5 to 0.7 |
| SFX | One-shot sound effects | Loop off, volume 0.7 to 1.0 |
| Ambient | Environmental loops under the music | Loop on, volume 0.2 to 0.4 |

### Which method for what

| What you want | Method | Where |
|--------------------|-------------|-------------------|
| Music when the player enters | Default playlist + **Auto-play** | **Audio** → **BGM Configuration** |
| Switch track on a variable | Conditional BGM, **Variable condition** | **Audio** → **Conditional BGM** |
| SFX when the AI writes a word | Conditional BGM, **AI keyword** | **Audio** → **Conditional BGM** |
| SFX when the player writes a word | Conditional BGM, **Player keyword** | **Audio** → **Conditional BGM** |
| Switch track at a given turn | Conditional BGM, **Turn count** (**At turn** or **Every N turns**) | **Audio** → **Conditional BGM** |
| A fixed track at the start of every game | Conditional BGM, **Session start** | **Audio** → **Conditional BGM** |
| Let the story decide | **When to play** / **Play once when this happens** on the track | Track settings |
| Keep the AI off a track | Turn off **Allow AI control** | Track settings |
| Sound as part of a behavior | **Play music**, **Play sound effect**, **Stop audio** | Behavior effects |
| A button that plays a track | **Play audio** / **Stop audio** step | **Player interface** |
| Full control from code | `api.playAudio()` / `api.stopAudio()` | **Panels → Front End Code** |

### Conditional BGM fields

| Field | What it does |
|-------|-------------|
| WHEN | **Variable condition**, **AI keyword**, **Player keyword**, **Turn count**, **Session start** |
| Play | The track to play |
| Priority | Higher wins when several rules match |
| Fade In (s) / Fade Out (s) | Fades for this rule's switch |
| Stop previous BGM | On for music that replaces music; off for SFX and ambient |
| On end | What plays when the condition stops holding: **Return to default playlist**, **Return to previous track**, or a specific track |

### Interface code audio API

| Method | Description |
|--------|-------------|
| `api.playAudio(trackId, opts)` | Play a track. `opts`: `volume`, `fadeDuration` (seconds), `chainTo`, `maxDuration`, `duckBgm`, `loop` |
| `api.stopAudio(trackId?, fadeDuration?)` | Stop a track, or everything without an ID |
| `api.pauseAudio(trackId)` / `api.resumeAudio(trackId)` | Pause and resume in place |
| `api.onAudioEnded(cb)` | Run `cb(trackId)` when a non-looping track ends; returns an unsubscribe function |
| `api.setAudioVolume("bgm" \| "sfx", v)` / `api.getAudioVolume(...)` | The player's volume for music or sound effects |

---

## Common issues

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| No sound at all | The browser blocks audio until the player interacts with the page | Turn on **Wait for first message**, or let the first click start the music |
| Two pieces of music at once | A rule or behavior started a BGM track without stopping the old one | Turn on **Stop previous BGM** on music rules; in behaviors add **Stop audio** for the old track; in code, stop the others before `playAudio` |
| Sound effects cut the music | **Stop previous BGM** is on for an SFX rule | Turn it off for SFX and ambient rules |
| The AI never picks a track | The track has no cue, or **Smart tracking** is off | Fill in **When to play**, and check **Smart tracking** in **Card settings** |
| The AI plays a track it shouldn't | **Allow AI control** is on | Turn it off for that track |
| Ambient is too loud | Volume too high | Ambient 0.2 to 0.4, music 0.5 to 0.7 |
| A variable rule never triggers | The condition compares the wrong kind of value | Numbers need number comparisons; text must match exactly |
| Rules fight each other | Same priority | Give rules different **Priority** values; higher wins |

---

::: tip This is Recipe #14: Audio Design Guide
Start with a playlist. Add Conditional BGM rules when the music should follow the game, cues when you want the story to choose, and code only for things like a jukebox. For a deeper look at how the audio system decides what plays, see [Advanced: Audio Design](/creator/advanced/audio-deep).
:::

</div>
