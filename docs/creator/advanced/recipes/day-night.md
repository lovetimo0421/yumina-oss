<div v-pre>

# Day-Night Cycle

> Build an auto-advancing time system — every 3 turns, time moves forward (Morning → Noon → Evening → Night → Morning). Different time periods activate different lore entries and background music, shifting the AI's writing atmosphere to match. The player doesn't have to do anything — time just flows.

---

## What you'll build

A day-night cycle system embedded in the chat:

- **Auto-counting** — every dialogue turn, an internal counter increments by 1. On the 3rd turn, time advances one period
- **Four time periods** — Morning → Noon → Evening → Night → Morning (and so on)
- **Atmosphere switching** — each period has its own lore entry describing that period's lighting, temperature, NPC behavior, etc. When the period changes, the old entry is disabled and the new one is enabled
- **BGM switching** — Morning plays birdsong, Night switches to crickets and frogs. Transitions use crossfade so there's no abrupt cut
- **Time badge** — a small icon on the last message in chat (☀️🌤️🌅🌙) so the player always knows what time it is

### How it works

The whole system boils down to: **counter +1 each turn → counter hits 3 → switch period → reset counter → toggle entries and music**.

```
Player sends message → AI replies → turn ends
  → "every turn +1" behavior fires: turn_counter goes from 0 to 1
  → next turn: turn_counter goes from 1 to 2
  → next turn: turn_counter goes from 2 to 3
  → "variable crossed threshold" behavior fires: turn_counter rises above 2
  → actions execute: time_period set to next period, turn_counter reset to 0
  → old period entry disabled, new period entry enabled
  → crossfade to the new period's BGM
  → the Root Component reads the variable and updates the time badge
```

There are two ways to implement this. Same result, different mental models:

| Approach | Triggers used | Number of behaviors | Best for |
|----------|--------------|---------------------|----------|
| Approach A: every-turn +1 + variable crossed | `every-turn` + `variable-crossed` | 2 | People who want to understand the underlying mechanics |
| Approach B: fire directly every N turns | `turn-count` (everyNTurns=3) | 1 | People who just want it done |

**This recipe teaches Approach A** (more versatile, and helps you understand how behaviors chain together). Approach B is briefly covered at the end.

---

## Step by step

### Step 1: Create variables

We need 2 variables — one to track the current time period, one as a counter.

Editor → sidebar → **Variables** tab → click "Add Variable" for each

#### Variable 1: Current time period

| Field | Value | Why |
|-------|-------|-----|
| Name | Current Time Period | For your own reference |
| ID | `time_period` | Behaviors and the Root Component read/write this ID |
| Type | String | Because the values are text (`"Morning"`, `"Noon"`, `"Evening"`, `"Night"`) |
| Default Value | `Morning` | New sessions start in the morning |
| Category | Custom | Dedicated category for the time system |
| Behavior Rules | `Do not modify this variable. It is controlled automatically by the day-night cycle system. Its current value represents the in-game time period.` | Tells the AI not to change the time on its own — only behaviors can |

#### Variable 2: Turn counter

| Field | Value | Why |
|-------|-------|-----|
| Name | Turn Counter | For your own reference |
| ID | `turn_counter` | Increments each turn, resets at 3 |
| Type | Number | Needs arithmetic |
| Default Value | `0` | Starts counting from 0 |
| Category | Custom | Dedicated category for the time system |
| Behavior Rules | `Do not modify this variable. It is controlled automatically by the day-night cycle system.` | Prevents the AI from tampering |

::: info Why use a counter instead of firing every 3 turns directly?
The counter + variable-crossed approach is more flexible. Say you later want "3 turns during the day, 5 turns at night" — you just add a condition check to the behavior. The `turn-count` trigger is simpler but less adaptable. Both approaches have their strengths; pick whichever fits your needs.
:::

---

### Step 2: Create four time-period lore entries

Each period needs a lore entry describing that period's atmosphere. Only "Morning" is enabled by default; the other three start disabled.

Editor → **Lore** tab → create entries one by one

#### Entry 1: Morning atmosphere

| Field | Value | Why |
|-------|-------|-----|
| Name | Morning Atmosphere | For your own reference |
| Section | Presets | Preset entries are sent to the AI every time |
| Enabled | **Yes** (toggle on) | The game starts in the morning, so this one is on by default |

Content:

```
[Current Time Period: Morning]
It is early morning. Reflect the following atmosphere when describing the scene:
- Soft morning light spills in from the east; the air is fresh and cool
- Dewdrops cling to blades of grass and flower petals, refracting tiny glints of light
- Birds sing in the branches; a rooster crows in the distance
- NPCs are just waking up, shops are opening one by one, foot traffic is picking up
- The overall mood is peaceful and full of hope
```

#### Entry 2: Noon atmosphere

| Field | Value | Why |
|-------|-------|-----|
| Name | Noon Atmosphere | For your own reference |
| Section | Presets | Preset section |
| Enabled | **No** (toggle off) | Behaviors will enable it when the time period switches |

Content:

```
[Current Time Period: Noon]
It is midday. Reflect the following atmosphere when describing the scene:
- The sun beats down directly overhead; the light is searing and bright, the ground reflecting a blinding white glare
- The air is stifling; distant scenery shimmers and warps in the heat haze
- Most people have retreated to the shade to rest; the streets are quieter than morning
- Taverns and eateries are at their busiest, the smell of food drifting through the air
- The overall mood is languid and sweltering
```

#### Entry 3: Evening atmosphere

| Field | Value | Why |
|-------|-------|-----|
| Name | Evening Atmosphere | For your own reference |
| Section | Presets | Preset section |
| Enabled | **No** (toggle off) | Behaviors will enable it |

Content:

```
[Current Time Period: Evening]
It is dusk. Reflect the following atmosphere when describing the scene:
- The setting sun paints the sky in shades of orange-red and purple, clouds rimmed with gold
- Long shadows stretch from buildings and trees
- Flocks of birds sweep across the sky heading home; wisps of cooking smoke rise from rooftops
- NPCs are wrapping up for the day, heading home; children chase each other through the streets
- The overall mood is warm, nostalgic, tinged with a gentle melancholy
```

#### Entry 4: Night atmosphere

| Field | Value | Why |
|-------|-------|-----|
| Name | Night Atmosphere | For your own reference |
| Section | Presets | Preset section |
| Enabled | **No** (toggle off) | Behaviors will enable it |

Content:

```
[Current Time Period: Night]
It is deep night. Reflect the following atmosphere when describing the scene:
- Moonlight and starlight are the only natural sources of illumination, casting a silvery glow over everything
- Most buildings have gone dark; the occasional window glows with dim candlelight
- A cool night breeze carries the chorus of crickets and frogs
- The streets are nearly deserted; night-watch guards pace slowly by, torches in hand
- Danger may lurk in the shadows — wild beasts, thieves, or something stranger still
- The overall mood is mysterious, hushed, and laced with hidden peril
```

> **Why is only "Morning" enabled by default?** Because the game starts in the morning. If all four entries were enabled at once, the AI would receive morning, noon, evening, and night descriptions simultaneously and not know which one to follow. Enabling only one at a time keeps the AI locked onto the right atmosphere.

---

### Step 3: (Optional) Upload time-period BGM

If you want each period to have its own background music, upload audio files first.

Editor → **Audio** tab → add tracks

| Track ID | Name | Type | Loop | Fade In | Fade Out |
|----------|------|------|------|---------|----------|
| `bgm_morning` | Morning Theme | BGM | Yes | 2s | 2s |
| `bgm_noon` | Afternoon Theme | BGM | Yes | 2s | 2s |
| `bgm_evening` | Dusk Theme | BGM | Yes | 2s | 2s |
| `bgm_night` | Night Theme | BGM | Yes | 2s | 2s |

> **Don't have audio files?** Skip this step. The core of the day-night cycle is lore-entry switching — BGM is a nice bonus. You can always add it later.

In the BGM playlist, set `autoPlay` to `true` and default to `bgm_morning`. When the period switches later, behaviors will use the `crossfade` action to smoothly transition tracks.

---

### Step 4: Create behaviors

This is the heart of the system. We need 2 behaviors — well, actually 6. Read on.

Editor → **Behaviors** tab → add behaviors one by one

#### Behavior 1: Count each turn

This one is dead simple — after each dialogue turn, the counter goes up by 1.

**WHEN (when to check):**

| Field | Value | Why |
|-------|-------|-----|
| Trigger type | Every turn | Fires automatically after each player-AI exchange |

**DO (what to do):**

| Action type | Settings | Effect |
|-------------|----------|--------|
| Modify variable | `turn_counter` add `1` | Counter +1 |

That's the only action. No conditions, no extra config. It faithfully adds 1 every turn.

> **Why not check "is it 3 yet?" right here?** Because the behavior system's design philosophy is one behavior, one job. Incrementing the counter is one behavior's job; checking whether it hit 3 is another's. The engine automatically chains them — after the counter increments, if the value crosses the threshold, the other behavior fires.

---

#### Behavior 2: Advance the time period

This behavior fires when the counter reaches 3 and executes all the switching logic.

**WHEN (when to check):**

| Field | Value | Why |
|-------|-------|-----|
| Trigger type | Variable crossed threshold | Fires when `turn_counter` rises above the threshold |
| Variable | `turn_counter` | The variable we're watching |
| Direction | Rises above | Fires when the value goes from below the threshold to above it |
| Threshold | `2` | Fires when turn_counter goes from 2 to 3 (rises above 2) |

> **Why is the threshold 2, not 3?** The "rises above" direction in `variable-crossed` detects the moment a value goes from <= threshold to > threshold. When turn_counter goes from 2 to 3, it "rises above 2" — i.e., it goes from <=2 to >2. If you set the threshold to 3, you'd need turn_counter to go from 3 to 4 before it fires, and that's not what we want.

**DO (what to do):**

This behavior needs to do a lot. Add these actions in order:

| # | Action type | Settings | Effect |
|---|-------------|----------|--------|
| 1 | Modify variable | `turn_counter` set to `0` | Reset the counter for the next 3-turn countdown |
| 2 | Disable lore entry | Morning Atmosphere | Turn off all period entries |
| 3 | Disable lore entry | Noon Atmosphere | Turn off all |
| 4 | Disable lore entry | Evening Atmosphere | Turn off all |
| 5 | Disable lore entry | Night Atmosphere | Turn off all |

**Wait — that turns off all four. How does it know which one to enable?**

Good question. This is where **ONLY IF conditions** come in for branching. But a single behavior can only have one set of actions. So we split "advance the time period" into **5 behaviors**: 1 to reset the counter and disable all entries, and 4 to enable the corresponding period.

Let me reorganize:

---

**Full behavior list (6 total):**

#### Behavior 1: Count each turn

(Same as above — not repeated.)

#### Behavior 2: Advance — Morning → Noon

**WHEN:**

| Field | Value |
|-------|-------|
| Trigger type | Variable crossed threshold |
| Variable | `turn_counter` |
| Direction | Rises above |
| Threshold | `2` |

**ONLY IF:**

| Variable | Operator | Value |
|----------|----------|-------|
| `time_period` | equals (eq) | `Morning` |

**DO:**

| # | Action type | Settings | Effect |
|---|-------------|----------|--------|
| 1 | Modify variable | `turn_counter` set to `0` | Reset counter |
| 2 | Modify variable | `time_period` set to `Noon` | Advance to next period |
| 3 | Disable lore entry | Morning Atmosphere | Turn off old period entry |
| 4 | Enable lore entry | Noon Atmosphere | Turn on new period entry |
| 5 | Play music | `bgm_noon`, action: crossfade, duration 3s | Crossfade to Noon BGM |
| 6 | Tell AI | Content: `Time has advanced from Morning to Noon. Naturally reflect this time change in your upcoming descriptions.` | Lets the AI smoothly transition |

#### Behavior 3: Advance — Noon → Evening

**WHEN:** Same as Behavior 2 (variable crossed threshold, turn_counter rises above 2)

**ONLY IF:**

| Variable | Operator | Value |
|----------|----------|-------|
| `time_period` | equals (eq) | `Noon` |

**DO:**

| # | Action type | Settings | Effect |
|---|-------------|----------|--------|
| 1 | Modify variable | `turn_counter` set to `0` | Reset counter |
| 2 | Modify variable | `time_period` set to `Evening` | Advance to Evening |
| 3 | Disable lore entry | Noon Atmosphere | Turn off Noon entry |
| 4 | Enable lore entry | Evening Atmosphere | Turn on Evening entry |
| 5 | Play music | `bgm_evening`, action: crossfade, duration 3s | Crossfade BGM |
| 6 | Tell AI | Content: `Time has advanced from Noon to Evening. Naturally reflect this time change in your upcoming descriptions.` | AI transition |

#### Behavior 4: Advance — Evening → Night

**WHEN:** Same as above

**ONLY IF:**

| Variable | Operator | Value |
|----------|----------|-------|
| `time_period` | equals (eq) | `Evening` |

**DO:**

| # | Action type | Settings | Effect |
|---|-------------|----------|--------|
| 1 | Modify variable | `turn_counter` set to `0` | Reset counter |
| 2 | Modify variable | `time_period` set to `Night` | Advance to Night |
| 3 | Disable lore entry | Evening Atmosphere | Turn off Evening entry |
| 4 | Enable lore entry | Night Atmosphere | Turn on Night entry |
| 5 | Play music | `bgm_night`, action: crossfade, duration 3s | Crossfade BGM |
| 6 | Tell AI | Content: `Time has advanced from Evening to Night. Naturally reflect this time change in your upcoming descriptions.` | AI transition |

#### Behavior 5: Advance — Night → Morning

**WHEN:** Same as above

**ONLY IF:**

| Variable | Operator | Value |
|----------|----------|-------|
| `time_period` | equals (eq) | `Night` |

**DO:**

| # | Action type | Settings | Effect |
|---|-------------|----------|--------|
| 1 | Modify variable | `turn_counter` set to `0` | Reset counter |
| 2 | Modify variable | `time_period` set to `Morning` | Cycle back to Morning |
| 3 | Disable lore entry | Night Atmosphere | Turn off Night entry |
| 4 | Enable lore entry | Morning Atmosphere | Turn on Morning entry |
| 5 | Play music | `bgm_morning`, action: crossfade, duration 3s | Crossfade BGM |
| 6 | Tell AI | Content: `Time has advanced from Night to Morning — a new day begins. Naturally reflect this time change in your upcoming descriptions.` | AI transition |

> **Why split into 4 behaviors?** Because each period transition needs to enable a different entry and play a different BGM. A single behavior can only have one set of conditions and one set of actions — it doesn't support if-else branching. So we use 4 behaviors with different ONLY IF conditions to simulate branching: when the same trigger fires (counter rises above 2), the engine checks all of them, but only the one whose `time_period` matches will execute.

#### Behavior 6: Session initialization

This behavior sets the initial state when a session begins, ensuring variables are at the correct starting values for new sessions or re-entries.

**WHEN:**

| Field | Value | Why |
|-------|-------|-----|
| Trigger type | Session start (`session-start`) | Fires once automatically when a new session begins |

**DO:**

| # | Action type | Settings | Effect |
|---|-------------|----------|--------|
| 1 | Modify variable | `time_period` set to `Morning` | Ensure it starts at Morning |
| 2 | Modify variable | `turn_counter` set to `0` | Reset the turn counter |

> **Why do we need a session initialization behavior?** Variable default values only take effect when they're first created. If a player quits mid-session and starts a new one, the variables might retain their previous values (e.g., `time_period` stuck on "Night", `turn_counter` stuck at 2). The session initialization behavior ensures every new session starts from Morning with the counter at 0.

::: tip Behavior priority
All 4 advance behaviors can keep the default priority (0). Their ONLY IF conditions are mutually exclusive — the current time period can only match one of them, so there's no conflict.
:::

---

### Step 5: Add the time badge to the Root Component

Show the current period's icon on the last message in chat, so the player always knows what time it is at a glance.

Editor → **Custom UI** section → open `index.tsx` → paste the following (replace the default `return <Chat />`):

```tsx
export default function MyWorld() {
  const api = useYumina();

  // ---- Read variable ----
  const timePeriod = String(api.variables.time_period || "Morning");

  // ---- Period icon and color map ----
  const timeConfig = {
    "Morning": { icon: "☀️", label: "Morning", color: "#fbbf24", bg: "rgba(251,191,36,0.15)" },
    "Noon": { icon: "🌤️", label: "Noon", color: "#f59e0b", bg: "rgba(245,158,11,0.15)" },
    "Evening": { icon: "🌅", label: "Evening", color: "#f97316", bg: "rgba(249,115,22,0.15)" },
    "Night": { icon: "🌙", label: "Night", color: "#818cf8", bg: "rgba(129,140,248,0.15)" },
  };

  const current = timeConfig[timePeriod] || timeConfig["Morning"];
  const msgs = api.messages || [];

  return (
    <Chat renderBubble={(msg) => {
      const isLastMsg = msg.messageIndex === msgs.length - 1;

      return (
        <div>
          {/* Render message text normally — contentHtml is already rendered HTML */}
          <div
            style={{ color: "#e2e8f0", lineHeight: 1.7 }}
            dangerouslySetInnerHTML={{ __html: msg.contentHtml }}
          />

          {/* Time badge — only on the last message */}
          {isLastMsg && (
            <div style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              marginTop: "12px",
              padding: "4px 12px",
              background: current.bg,
              border: `1px solid ${current.color}33`,
              borderRadius: "999px",
              fontSize: "13px",
              color: current.color,
              fontWeight: "600",
            }}>
              <span style={{ fontSize: "16px" }}>{current.icon}</span>
              <span>{current.label}</span>
            </div>
          )}
        </div>
      );
    }} />
  );
}
```

**Line-by-line breakdown:**

- `api.variables.time_period` — reads the current time period variable
- `timeConfig` — a lookup table mapping each period to an icon, text label, and color. Feel free to change the colors to match your world's style
- `isLastMsg` — only shows the badge on the last message, not every message
- The badge uses `inline-flex` + `border-radius: 999px` for a pill shape — subtle but immediately visible

::: tip Want to show the time on every message?
Remove the `{isLastMsg && ...}` check and put the badge directly in the `return`. Every message will then carry a time stamp, like timestamps in a chat log.
:::

---

### Step 6: Save and test

1. Click **Save** at the top of the editor
2. Click **Start Game** or go back to the home page and open a new session
3. Chat normally with the AI. For the first 2 turns, the time badge shows "☀️ Morning" and nothing changes
4. After turn 3 — time advances to "🌤️ Noon", and the AI's next reply naturally reflects the time change
5. 3 more turns — advances to "🌅 Evening"
6. 3 more turns — advances to "🌙 Night". If you set up BGM, you should hear the crossfade
7. 3 more turns — cycles back to "☀️ Morning", a new day begins

**If something goes wrong:**

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Time never changes | "Count each turn" behavior isn't firing | Check that Behavior 1's trigger is set to "Every turn" and the behavior is enabled |
| No switch on turn 3 | Threshold is wrong | Confirm the "variable crossed threshold" threshold is `2` (not 3), direction is "rises above" |
| Entries don't change after switching | Entry names don't match | Check that the "Enable lore entry" / "Disable lore entry" actions in your behaviors reference the correct entry names |
| All 4 behaviors fire at once | ONLY IF conditions are missing | Each advance behavior must have an ONLY IF condition restricting the current `time_period` value |
| Time badge not visible | Syntax error in the Root Component | Check the compilation status at the bottom of the Custom UI panel — it should show a green "OK" |
| BGM doesn't switch | Track ID mismatch or no audio uploaded | Confirm the `trackId` in the behavior matches the track ID in the Audio tab |

---

## Approach B comparison: using the `turn-count` trigger

If Approach A feels like too many behaviors, you can use the simpler Approach B.

**Differences:**

| | Approach A (this recipe) | Approach B |
|---|---|---|
| Triggers | `every-turn` + `variable-crossed` | `turn-count` (everyNTurns=3) |
| Needs `turn_counter` variable | Yes | No |
| Number of behaviors | 6 (1 counting + 4 advancing + 1 optional initialization) | 4 (4 advancing) |
| Flexibility | High (interval can be adjusted dynamically) | Low (interval fixed at N) |
| Best for | Worlds that need dynamic time-flow speed | Worlds with a fixed rhythm |

**How to do Approach B:**

Remove the `turn_counter` variable and the "Count each turn" behavior. Change the trigger on all 4 advance behaviors to:

| Field | Value |
|-------|-------|
| Trigger type | Every N turns |
| everyNTurns | `3` |

Everything else (ONLY IF conditions, DO actions) stays exactly the same as Approach A. The `turn-count` trigger automatically fires every 3 turns — no manual counting needed.

> **How the `turn-count` trigger works:** The engine maintains an internal global turn count. When you set `everyNTurns: 3`, the engine automatically fires the behavior on turns 3, 6, 9, 12, and so on. You don't need to manage a counter variable yourself.

---

## Quick reference

| What you want | How to do it |
|---------------|-------------|
| Do something every turn | Behavior trigger: "Every turn" (`every-turn`) |
| Do something every N turns | Behavior trigger: "Every N turns" (`turn-count`), set `everyNTurns` |
| Detect a variable crossing a value | Behavior trigger: "Variable crossed threshold" (`variable-crossed`), set variable, direction, and threshold |
| Switch lore entries | Actions: "Enable lore entry" / "Disable lore entry" |
| Crossfade music | Action: "Play music", operation: `crossfade`, set fade duration |
| Let the AI know something happened | Action: "Tell AI", write a temporary system instruction |
| Show a status badge on a message | Read a variable inside the Root Component's `<Chat renderBubble>` and render with JSX |
| Simulate if-else branching | Multiple behaviors sharing the same trigger + different ONLY IF conditions |

---

## Try it yourself — importable demo world

Download this JSON and import it as a new world to see everything in action:

<a href="/recipe-9-demo.json" download>recipe-9-demo.json</a>

**How to import:**
1. Go to Yumina → **My Worlds** → **Create New World**
2. In the editor, click **More Actions** → **Import Package**
3. Select the downloaded `.json` file
4. A new world is created with all variables, entries, behaviors, and the Root Component pre-configured
5. Start a new session and try it out

**What's included:**
- 2 variables (`time_period` tracks the current period, `turn_counter` as the turn counter)
- 4 lore entries (Morning / Noon / Evening / Night atmosphere, only Morning enabled by default)
- 6 behaviors (1 per-turn counting + 4 period advancing + 1 session initialization)
- A Root Component (time-period icon badge in `<Chat renderBubble>`)
- 4 BGM tracks (you'll need to upload your own audio files to replace the URLs)

---

::: tip This is Recipe #9
This recipe shows the chaining power of the behavior system — with a simple counter + threshold trigger + conditional branching, you can build a fully automatic time system. The same pattern works for weather changes, seasonal cycles, NPC mood swings, or anything else that "changes automatically on a rhythm".
:::

</div>
