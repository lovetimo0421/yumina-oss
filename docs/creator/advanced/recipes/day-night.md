<div v-pre>

# Day-Night Cycle

> Time moves forward on its own: every 3 turns it goes from Morning to Noon to Evening to Night and back to Morning. Each period has its own atmosphere for the AI and its own music, and the player can always see what time it is. Built from behaviors, conditional lore and music rules, no code.

---

## What you'll build

- **Four periods**: Morning → Noon → Evening → Night → Morning
- **Time advances every 3 turns**, without the player doing anything
- **The atmosphere changes**: each period has a lore entry describing light, temperature and what people are doing, and only the current period's entry reaches the AI
- **The music changes**: birdsong in the morning, crickets at night, faded from one to the other
- **The time is on screen** for the player

### How it works

```
Turn 3 ends
  → The behavior "Morning → Noon" fires (Every N turns: 3, ONLY IF Time of day is Morning)
  → It sets Time of day to Noon and tells the AI time has moved on
  → The lore entry "Noon" (condition: Time of day is Noon) now reaches the AI; "Morning" no longer does
  → The music rule for Noon matches, and the Noon track fades in
  → Time of day on the player's screen reads Noon
```

Only one thing changes when time moves: the variable. The lore and the music each watch the variable, so they follow by themselves.

---

## Step by step

### Step 1: Create the variable

In the **Add** row at the bottom of the card, click **＋ Variable**.

| Field | Value |
|-------|-------|
| Name | Time of day |
| Type | Text |
| Starts at | `Morning` |
| Behavior Rules | `The time of day: Morning, Noon, Evening or Night. Describe light, weather and people to match it.` |

Open **What the AI does with it** and set **AI access** to **AI read-only**. Behaviors move the clock; the AI only reads it.

Click **Show on the player screen** so the time appears on the chat page.

A new game always starts from **Starts at**, so the cycle begins at Morning every time; you don't need a behavior to reset it.

---

### Step 2: Write four period entries

Add a lore entry per period. Then drag the **Time of day** variable onto each entry, click the line, and set its condition: Time of day **is** `Morning` (and so on). Each entry moves into the conditional lore block and only reaches the AI while its condition holds.

#### Morning

```
[Time of day: Morning]
It's early morning. Bring this into scene descriptions:
- Soft light from the east; the air is fresh and cool
- Dew on the grass and petals catches the light
- Birds in the branches, a rooster somewhere in the distance
- People are just getting up; shops open one by one
- The mood is calm and hopeful
```

#### Noon

```
[Time of day: Noon]
It's midday. Bring this into scene descriptions:
- The sun is straight overhead; the ground glares white
- The air is close; distant things shimmer in the heat
- Most people rest in the shade; the streets are quieter than in the morning
- Taverns and eating houses are at their busiest, and the smell of food drifts out
- The mood is slow and sweltering
```

#### Evening

```
[Time of day: Evening]
It's dusk. Bring this into scene descriptions:
- The setting sun turns the sky orange and purple, clouds edged with gold
- Long shadows stretch from buildings and trees
- Birds fly home; cooking smoke rises from the rooftops
- People finish work and head home; children chase each other in the street
- The mood is warm, a little wistful
```

#### Night

```
[Time of day: Night]
It's deep night. Bring this into scene descriptions:
- Moon and stars are the only natural light, silvering everything
- Most windows are dark; here and there a candle still burns
- A cool breeze carries the sound of crickets and frogs
- The streets are nearly empty; a night watchman passes with a torch
- Something may be waiting in the dark: animals, thieves, or worse
- The mood is quiet and watchful
```

If all four reached the AI at once, it wouldn't know which to follow. The conditions make sure only the current one does.

---

### Step 3: Create the behaviors that move time

One behavior per step of the cycle. In the **Add** row, click **＋ Behavior**.

#### Morning → Noon

| Part | Setting |
|------|---------|
| When it fires | **Every N turns**: `3` |
| ONLY IF | Time of day is `Morning` |
| Effects | **Change variable**: Time of day to `Noon` |
| | **Tell the AI**: `Time has moved on from morning to noon. Let the change show naturally in your next description.` |

#### Noon → Evening, Evening → Night, Night → Morning

The same, with the next pair of values:

| Behavior | ONLY IF | Change variable | Tell the AI |
|-----------|---------|-----------------|-------------|
| Noon → Evening | Time of day is `Noon` | Time of day to `Evening` | `Time has moved on from noon to evening.` |
| Evening → Night | Time of day is `Evening` | Time of day to `Night` | `Time has moved on from evening to night.` |
| Night → Morning | Time of day is `Night` | Time of day to `Morning` | `Night is over and a new day begins.` |

All four fire on the same turns (3, 6, 9…), but each one's **ONLY IF** names a different period. The engine checks all four against the time as it was before any of them ran, so exactly one of them fires each time.

**Tell the AI** slips the AI one line, for its next reply only. The lore entry does the lasting work; this line just makes the transition read naturally.

---

### Step 4 (optional): Music per period

Add four BGM tracks on the **Audio** page (click **＋ Audio** in the **Add** row if the card has no audio yet): Morning, Noon, Evening, Night, each with **Loop Audio** on and 2 seconds of **Fade In (s)** and **Fade Out (s)**.

Then open **BGM Configuration** → **Conditional BGM** → **Add Conditional Rule**, once per period:

| Field | Value |
|-------|-------|
| WHEN | **Variable condition**: Time of day is `Morning` |
| Play | Morning |
| Fade In (s) / Fade Out (s) | `3` / `3` |
| Stop previous BGM | On |

When the time changes, the old rule stops matching and the new one starts its track: one fades out while the other fades in. See the [Audio Design Guide](./audio-design.md) for more on rules.

---

### Step 5 (optional): A clock on screen

**Show on the player screen** (Step 1) already puts the time on the chat page. For something with more character, use the player interface:

- The **Adventure HUD** template (under **Whole screen**) shows the current location, day and time, and two meters. It adds its own variables for day and time of day; delete those and point its text at your Time of day, or use its variables instead of yours
- Or add a **Text** part to the conversation page and use **Insert a variable's value…** to show `{Time of day}`. Add **Image** parts for a sun and a moon, each with **When to show** → **When a variable matches** (Time of day **is** `Night` for the moon)

---

### Step 6: Playtest

Click **Play** in the top bar.

1. For the first two turns it's Morning
2. After turn 3 it's Noon, and the AI's next reply mentions the heat or the sun overhead
3. Three more turns: Evening. Three more: Night. If you added music, it changes each time
4. Three more: Morning again

**This turn** on the right of the playtest shows which behavior fired and which lore entries the AI got.

**If something goes wrong:**

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Time never changes | The behaviors' **ONLY IF** values don't match **Starts at** | `Morning` in the variable and in the condition must be spelled the same |
| Time jumps two periods at once | Two behaviors share the same **ONLY IF** value | Each behavior checks a different period |
| The atmosphere doesn't change | An entry's condition is wrong, or it's still in the always-sent block | Check each entry's condition and **When the AI sees this** |
| The AI changes the time itself | **AI access** is still **AI can read & write** | Set it to **AI read-only** |
| Two tracks play at once | **Stop previous BGM** is off | Turn it on for each period rule |

---

## Variation: periods of different lengths

**Every N turns** always uses the same interval. For long days and short nights (say 4 turns per daytime period and 2 for the night), count turns yourself:

1. Add a Number variable **Turns this period**, starting at `0`, with **AI access** set to **Engine only (hidden from AI)**
2. Add a behavior: **Every turn**, effect **Change variable** Turns this period plus `1`
3. Change the four time behaviors' **When it fires** to **Variable crosses threshold** on Turns this period, **Rises above**: `3` for Morning → Noon, Noon → Evening and Evening → Night, and `1` for Night → Morning. Keep each one's **ONLY IF** on Time of day
4. Add **Change variable** Turns this period to `0` to each of the four, so the count starts over in the new period

### Real time instead of turns

**Every N seconds** fires on a clock while the player has the game open. With `300` on the four behaviors, a day passes every 20 minutes of play, whether the player is typing or not.

---

## Custom code route: a time badge on the last message

If you write your own interface, read the variable in the interface code. Everything above stays the same.

**Panels → Front End Code** → open `index.tsx` and replace the default `return <Chat />`:

```tsx
export default function MyWorld() {
  const api = useYumina();
  const timeOfDay = String(api.variables["Time of day"] || "Morning");

  const timeConfig = {
    "Morning": { icon: "☀️", color: "#fbbf24", bg: "rgba(251,191,36,0.15)" },
    "Noon":    { icon: "🌤️", color: "#f59e0b", bg: "rgba(245,158,11,0.15)" },
    "Evening": { icon: "🌅", color: "#f97316", bg: "rgba(249,115,22,0.15)" },
    "Night":   { icon: "🌙", color: "#818cf8", bg: "rgba(129,140,248,0.15)" },
  };
  const current = timeConfig[timeOfDay] || timeConfig["Morning"];
  const msgs = api.messages || [];

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
              <span>{timeOfDay}</span>
            </div>
          )}
        </div>
      );
    }} />
  );
}
```

**What the code does:**

- `api.variables["Time of day"]` reads the variable by its name
- `timeConfig` maps each period to an icon and colours
- `isLastMsg` keeps the badge on the last message only. Remove that check to stamp every message with the time

The status next to the file in **Panels → Front End Code** should read a green **OK**.

---

## Quick reference

| What you want | How to do it |
|---------------|-------------|
| Do something every N turns | **When it fires**: **Every N turns** |
| Do something on a real-time clock | **When it fires**: **Every N seconds** |
| Branch on the current value | Several behaviors with the same trigger and different **ONLY IF** conditions |
| Give the AI period-specific atmosphere | One lore entry per period with a condition on Time of day |
| Change music with the period | **Conditional BGM**, **Variable condition**, **Stop previous BGM** on |
| Tell the AI that time moved on | Effect: **Tell the AI** (next reply only) |
| Keep the AI from changing the time | **AI access**: **AI read-only** |
| Show the time | **Show on the player screen**, a Text part, or interface code |

---

::: tip This is Recipe #9
The same setup (a variable that behaviors move on a rhythm, with lore and music that follow it) works for weather, seasons, or an NPC's mood. The **Daily actions** template in the player interface adds a day counter, a time of day and a few actions per day, for life-sim and management cards.
:::

</div>
