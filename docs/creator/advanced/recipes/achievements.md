<div v-pre>

# Achievement System

> Build a full achievement system — when players hit specific milestones (gold over 100, 5+ combat wins, discovering a hidden area...), a golden achievement notification pops up on screen. Use boolean variables to track which achievements are unlocked, and the Root Component to display an achievement panel.

---

## What you'll build

An achievement system embedded right in the chat:

- **Golden popup notifications** — the instant a player hits a milestone, a golden achievement toast appears on screen (using the `achievement` style), e.g. "Achievement Unlocked: Big Spender"
- **Automatic detection** — the engine monitors variable changes in the background and triggers automatically when conditions are met, no player action required
- **Fire-once guarantee** — each achievement unlocks exactly once and never pops again. `maxFireCount` and boolean variables provide a double safety net
- **Achievement panel** — a mini panel below the last message lists all achievements and their unlock status (unlocked = golden icon, locked = grey lock)

### How it works

The core loop is: **variable changes → engine detects the variable crossing a threshold → behavior fires → notification pops up + boolean variable set to true**.

```
Player accumulates 101 gold during the adventure
  → Engine detects gold crossed above 100
  → "Big Spender" behavior fires
  → Actions execute: achievement_rich set to true, golden notification "Achievement Unlocked: Big Spender"
  → maxFireCount: 1 ensures this behavior never fires again
  → Root Component reads achievement_rich = true, panel shows golden trophy icon
```

There's an important design decision here: **why use `variable-crossed` instead of `state-change`?**

- `state-change` means "check whenever any variable changes" — very broad. If you use `state-change` + condition `gold gt 100`, then every time gold goes from 101 to 102, 102 to 103... the condition gets re-evaluated. While `maxFireCount: 1` prevents re-firing, the engine still does a pointless evaluation each time.
- `variable-crossed` means "fire only at the instant gold goes from <= 100 to > 100" — precise and efficient. Combined with `maxFireCount: 1`, you get a double safety net.

---

## Step by step

### Step 1: Create variables

You need 5 variables — 2 number variables to track progress, and 3 boolean variables to track whether each achievement is unlocked.

Editor → left sidebar → **Variables** tab → click "Add Variable" for each one

#### Variable 1: Gold

| Field | Value | Why |
|-------|-------|-----|
| Display Name | Gold | For your own reference in the variable list |
| ID | `gold` | Behaviors and the Root Component use this ID to read/write |
| Type | Number | Gold is numeric and needs arithmetic |
| Default Value | `0` | New sessions start at 0 gold |
| Category | Stats | Groups it with character attributes |
| Behavior Rules | `Current gold count. The AI can modify this via directives when the narrative calls for it.` | Tells the AI what this is and how to use it |

#### Variable 2: Combat wins

| Field | Value | Why |
|-------|-------|-----|
| Display Name | Combat Wins | Easy to identify |
| ID | `combat_wins` | Referenced by behaviors |
| Type | Number | It's a counter |
| Default Value | `0` | Start from 0 |
| Category | Stats | Character attribute |
| Behavior Rules | `Cumulative number of battles the player has won. The AI can +1 this via directive when the player wins a fight.` | Tells the AI when to increment |

#### Variable 3: Achievement — Big Spender

| Field | Value | Why |
|-------|-------|-----|
| Display Name | Achievement: Big Spender | Easy to identify |
| ID | `achievement_rich` | All achievement variables use the `achievement_` prefix |
| Type | Boolean | Only two states: unlocked or locked |
| Default Value | `false` | Locked at the start |
| Category | Achievements | Group all achievement variables under one category for easy management |
| Behavior Rules | `Do not modify this variable directly — achievements are unlocked automatically by behavior rules when conditions are met, which also triggers a notification. Modifying it manually bypasses the notification system.` | Achievements must fire through behaviors to show the notification correctly |

#### Variable 4: Achievement — First Blood

| Field | Value | Why |
|-------|-------|-----|
| Display Name | Achievement: First Blood | Easy to identify |
| ID | `achievement_warrior` | Same prefix convention |
| Type | Boolean | Same as above |
| Default Value | `false` | Locked at the start |
| Category | Achievements | Same as above |
| Behavior Rules | `Do not modify this variable directly — achievements are unlocked automatically by behavior rules when conditions are met, which also triggers a notification. Modifying it manually bypasses the notification system.` | Same reason |

#### Variable 5: Achievement — Trailblazer

| Field | Value | Why |
|-------|-------|-----|
| Display Name | Achievement: Trailblazer | Easy to identify |
| ID | `achievement_explorer` | Same prefix convention |
| Type | Boolean | Same as above |
| Default Value | `false` | Locked at the start |
| Category | Achievements | Same as above |
| Behavior Rules | `Do not modify this variable directly — achievements are unlocked automatically by behavior rules when conditions are met, which also triggers a notification. Modifying it manually bypasses the notification system.` | Same reason |

::: info Why use separate boolean variables for achievements?
Because the Root Component needs to read each achievement's state to display the panel. If you only relied on `maxFireCount` to prevent re-firing, the component would have no way to know "is this achievement unlocked or not?" — it can't see a behavior's fire count. Boolean variables are the public-facing state that the Root Component and other behaviors can read.
:::

---

### Step 2: Create behaviors

You need 3 behaviors — one for each achievement.

Editor → left sidebar → **Behaviors** tab → click "Add Behavior" for each one

#### Behavior 1: Big Spender (gold > 100)

**Basic info:**

| Field | Value | Why |
|-------|-------|-----|
| Name | Achievement: Big Spender | For your own reference |
| Max Fire Count | `1` | Achievements unlock once — after firing, this behavior never runs again |

**Trigger (WHEN):**

| Field | Value | Why |
|-------|-------|-----|
| Trigger Type | Variable Crossed Threshold (`variable-crossed`) | We want to detect the instant gold crosses 100 |
| Variable ID | `gold` | Monitor the gold variable |
| Direction | Rises Above (`rises-above`) | Fire when gold goes from <= 100 to > 100 |
| Threshold | `100` | The milestone value |

**Actions (DO):**

| Action Type | Setting | Purpose |
|-------------|---------|---------|
| Set Variable | `achievement_rich` set to `true` | Mark the achievement as unlocked, for the Root Component to read |
| Show Notification | Message `Achievement Unlocked: Big Spender`, style `achievement` | Pop up the golden achievement toast |

> **About `maxFireCount: 1`.** This field is set on the behavior itself (not the trigger). It means "this behavior may execute at most 1 time ever." Once it's fired, no matter how gold changes afterward, this behavior will never run again. This is the core safeguard of the achievement system — nobody wants to see the same achievement pop twice.

#### Behavior 2: First Blood (combat wins > 5)

**Basic info:**

| Field | Value | Why |
|-------|-------|-----|
| Name | Achievement: First Blood | For your own reference |
| Max Fire Count | `1` | Same as above |

**Trigger (WHEN):**

| Field | Value | Why |
|-------|-------|-----|
| Trigger Type | Variable Crossed Threshold (`variable-crossed`) | Detect the instant combat_wins crosses 5 |
| Variable ID | `combat_wins` | Monitor combat win count |
| Direction | Rises Above (`rises-above`) | Fire when combat_wins goes from <= 5 to > 5 |
| Threshold | `5` | The milestone value |

**Actions (DO):**

| Action Type | Setting | Purpose |
|-------------|---------|---------|
| Set Variable | `achievement_warrior` set to `true` | Mark the achievement as unlocked |
| Show Notification | Message `Achievement Unlocked: First Blood`, style `achievement` | Pop up the golden achievement toast |

#### Behavior 3: Trailblazer (keyword trigger)

This achievement is different from the first two — instead of monitoring a numeric threshold, it monitors message content. When the player says "explore" or the AI says "discover", and the achievement isn't already unlocked, it fires.

**Basic info:**

| Field | Value | Why |
|-------|-------|-----|
| Name | Achievement: Trailblazer | For your own reference |
| Max Fire Count | `1` | Same as above |

**Trigger (WHEN):**

This achievement needs to monitor two sources — player messages and AI messages. In Yumina, a behavior can only have one trigger, so you need to create **two behaviors** to cover both sources.

The simplest approach is to create two behaviors:

**Behavior 3a: Trailblazer (player keyword)**

| Field | Value | Why |
|-------|-------|-----|
| Trigger Type | Player Said Keyword (`keyword`) | Monitor player messages |
| Keyword | `explore` | Matches when the player says "I want to explore" |
| Max Fire Count | `1` | Fire once only |

Condition (ONLY IF):

| Variable ID | Operator | Value | Why |
|-------------|----------|-------|-----|
| `achievement_explorer` | Equals (`eq`) | `false` | Only fire if the achievement hasn't been unlocked yet |

Actions (DO):

| Action Type | Setting | Purpose |
|-------------|---------|---------|
| Set Variable | `achievement_explorer` set to `true` | Mark the achievement as unlocked |
| Show Notification | Message `Achievement Unlocked: Trailblazer`, style `achievement` | Pop up the golden achievement toast |

**Behavior 3b: Trailblazer (AI keyword)**

| Field | Value | Why |
|-------|-------|-----|
| Trigger Type | AI Said Keyword (`ai-keyword`) | Monitor AI replies |
| Keyword | `discover` | Matches when the AI mentions "discover" |
| Max Fire Count | `1` | Fire once only |

Conditions and actions are identical to Behavior 3a.

> **Why do we need the condition `achievement_explorer eq false`?** Because two behaviors (3a and 3b) can both unlock the same achievement. Suppose Behavior 3a fires first — it sets `achievement_explorer` to `true` and uses up its own `maxFireCount`. But Behavior 3b's `maxFireCount` is still unused! Without the condition, Behavior 3b would still fire the next time it matches a keyword, and the player would see two notifications. With the condition in place, Behavior 3b checks that `achievement_explorer` is already `true`, the condition fails, and it doesn't fire.

---

### Step 3: Add the achievement panel to the Root Component

This is the key step to get the achievement panel showing up in the chat. The panel only appears below the last message.

Editor → **Custom UI** section → open `index.tsx` → paste the following (replace the default `return <Chat />`):

```tsx
export default function MyWorld() {
  const api = useYumina();
  const msgs = api.messages || [];

  // Achievement list definition
  const achievements = [
    {
      id: "achievement_rich",
      name: "Big Spender",
      desc: "Accumulate over 100 gold",
      icon: "💰",
    },
    {
      id: "achievement_warrior",
      name: "First Blood",
      desc: "Win more than 5 battles",
      icon: "⚔️",
    },
    {
      id: "achievement_explorer",
      name: "Trailblazer",
      desc: "Discover a hidden area or secret",
      icon: "🗺️",
    },
  ];

  // Count unlocked achievements
  const unlockedCount = achievements.filter(
    (a) => api.variables[a.id] === true
  ).length;

  return (
    <Chat renderBubble={(msg) => {
      const isLastMsg = msg.messageIndex === msgs.length - 1;
      return (
    <div>
      {/* Render message text normally (platform already produced HTML — just use contentHtml) */}
      <div
        style={{ color: "#e2e8f0", lineHeight: 1.7 }}
        dangerouslySetInnerHTML={{ __html: msg.contentHtml }}
      />

      {/* Achievement panel — only below the last message */}
      {isLastMsg && (
        <div
          style={{
            marginTop: "16px",
            padding: "12px 16px",
            background: "linear-gradient(135deg, #1c1917, #292524)",
            border: "1px solid #44403c",
            borderRadius: "10px",
          }}
        >
          {/* Panel header */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "10px",
            }}
          >
            <span
              style={{
                fontSize: "13px",
                fontWeight: "bold",
                color: "#fbbf24",
                letterSpacing: "0.05em",
              }}
            >
              🏆 Achievements
            </span>
            <span style={{ fontSize: "12px", color: "#a8a29e" }}>
              {unlockedCount} / {achievements.length}
            </span>
          </div>

          {/* Achievement list */}
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {achievements.map((a) => {
              const unlocked = api.variables[a.id] === true;
              return (
                <div
                  key={a.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    padding: "6px 8px",
                    borderRadius: "6px",
                    background: unlocked
                      ? "rgba(251, 191, 36, 0.08)"
                      : "rgba(120, 113, 108, 0.08)",
                  }}
                >
                  {/* Icon */}
                  <span style={{ fontSize: "18px", opacity: unlocked ? 1 : 0.3 }}>
                    {unlocked ? a.icon : "🔒"}
                  </span>

                  {/* Text */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: "13px",
                        fontWeight: "600",
                        color: unlocked ? "#fbbf24" : "#78716c",
                      }}
                    >
                      {a.name}
                    </div>
                    <div
                      style={{
                        fontSize: "11px",
                        color: unlocked ? "#a8a29e" : "#57534e",
                        marginTop: "1px",
                      }}
                    >
                      {a.desc}
                    </div>
                  </div>

                  {/* Status badge */}
                  {unlocked && (
                    <span style={{ fontSize: "11px", color: "#fbbf24" }}>
                      ✓ Unlocked
                    </span>
                  )}
                </div>
              );
            })}
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

- `MyWorld()` is the Root Component — the world's UI entry point. `<Chat renderBubble={...} />` keeps the platform in charge of the message list, input box, and scrolling; we only customize the per-bubble layout
- `const api = useYumina()` — get the Yumina API to read variable state
- `msg.messageIndex === msgs.length - 1` — only show the panel on the last message, so it doesn't repeat on every message
- `msg.contentHtml` — the platform already rendered the Markdown to HTML; drop it straight into `dangerouslySetInnerHTML`
- `achievements` array — defines all achievement metadata (ID, name, description, icon) right in the Root Component. Want to add a new achievement? Just add another entry to this array
- `api.variables[a.id] === true` — reads the boolean variable's value to check if the achievement is unlocked
- `unlockedCount` — tallies how many are unlocked, displayed in the header (e.g. "2 / 3")
- Locked achievements show a grey lock icon, unlocked ones show their golden icon plus a "Unlocked" badge

::: tip Don't want to write code yourself? Use Studio AI
Editor top bar → click "Enter Studio" → AI Assistant panel → describe what you want in plain English, and the AI will generate the code for you.
:::

---

### Step 4: Save and test

1. Click **Save** at the top of the editor
2. Click **Start Game** or go back to the home page and start a new session
3. Below the last message you should see the achievement panel — all 3 achievements greyed out with lock icons
4. **Test the gold achievement**: chat with the AI and have your character earn more than 100 gold. When `gold` goes from <= 100 to > 100, a golden notification pops up: "Achievement Unlocked: Big Spender", and the first achievement on the panel turns golden
5. **Test the combat achievement**: have your character win 6 battles. When `combat_wins` goes from 5 to 6, the notification pops: "Achievement Unlocked: First Blood"
6. **Test the exploration achievement**: send a message containing "explore" (e.g. "I want to explore this cave"). If the keyword matches, the notification pops: "Achievement Unlocked: Trailblazer"

**If something goes wrong:**

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Can't see the achievement panel | Root Component code wasn't saved or has a syntax error | Check the compile status at the bottom of the Custom UI panel — it should show a green "OK" |
| Gold passed 100 but no notification | The variable didn't "cross" from <= 100 to > 100 — it was set directly to 200 | Make sure gold changes incrementally (AI adds/subtracts via directives), not in a single jump to a large number |
| Achievement popped twice | The behavior's `maxFireCount` isn't set to 1 | Go back to the editor and check the behavior settings |
| Exploration achievement popped twice | Both behaviors 3a and 3b fired, and the condition check is missing | Confirm both behaviors have the condition `achievement_explorer eq false` |
| Panel status didn't update | Variable ID is misspelled in the Root Component code | Confirm `api.variables[a.id]`'s `a.id` matches the variable ID exactly |

---

## Deep dive: `variable-crossed` vs `state-change`

This is the most important conceptual distinction in the achievement system — worth expanding on.

### `variable-crossed` (Variable Crossed Threshold)

Detects an **instantaneous event**: "the variable crossed from one side of the threshold to the other."

```
gold: 80 → 95 → 101   ← fires on the 95→101 step (crossed above 100)
gold: 101 → 150 → 200  ← does NOT fire (already above the threshold)
gold: 200 → 50 → 120   ← fires on the 50→120 step (crossed above 100 again)
```

Key characteristics:
- Only fires at the **instant of crossing**, not "fires continuously while above the threshold"
- If the value drops below the threshold and rises back, it fires again (unless `maxFireCount` prevents it)
- Good for: achievement unlocks, milestone notifications, HP-hits-zero death checks

### `state-change` (Variable Changed)

Detects an **ongoing event**: "any variable changed at all."

```
gold: 80 → 95   ← fires (gold changed)
gold: 95 → 101  ← fires (gold changed again)
gold: 101 → 150 ← fires (gold still changing)
hp: 100 → 90    ← also fires (hp changed)
```

Key characteristics:
- Any change to any variable triggers it
- Needs conditions (ONLY IF) to filter
- Good for: general state monitoring, switching world context based on current state

### Why `variable-crossed` is right for achievements

Because achievements are **milestones** — you only care about the instant the line is crossed. If you used `state-change` + condition `gold gt 100`:

1. gold goes from 95 to 101 → triggers → condition met → executes (correct)
2. gold goes from 101 to 102 → triggers → condition met → tries to execute again (wrong! `maxFireCount` blocks it, but the engine still did a pointless evaluation)
3. gold goes from 102 to 103 → triggers again → checks condition again...

With `variable-crossed`:

1. gold goes from 95 to 101 → crossing detected above 100 → fires → executes (correct)
2. gold goes from 101 to 102 → no crossing event → doesn't fire at all (efficient)

Bottom line: **precise triggers = fewer wasted evaluations = better performance and cleaner logic**.

---

## Extension ideas

Once you've built the basic 3 achievements, you can extend with more using the same pattern:

| Achievement Name | Variable ID | Trigger Method | Condition |
|-----------------|-------------|---------------|-----------|
| Chatterbox | `achievement_talkative` | Create a `message_count` variable, +1 each turn, fire when it crosses 50 | `variable-crossed`, `message_count` rises above 50 |
| Hoarder | `achievement_hoarder` | Fire when gold crosses 500 | `variable-crossed`, `gold` rises above 500 |
| Socialite | `achievement_social` | AI says keyword "become friends" or "trusts you" | `ai-keyword`, condition `achievement_social eq false` |
| Back from the Dead | `achievement_survivor` | HP crosses below 10 (near-death), then later crosses above 50 (recovery) | Two linked behaviors |

For each new achievement, you only need to:
1. Add a boolean variable (`achievement_xxx`, default `false`)
2. Add a behavior (trigger + actions + `maxFireCount: 1`)
3. Add an entry to the `achievements` array in the Root Component

---

## Quick reference

| What you want to do | How to do it |
|---------------------|-------------|
| Unlock achievement when a number hits a target | Behavior trigger: "Variable Crossed Threshold" (`variable-crossed`), direction: rises above, set threshold |
| Trigger achievement on a keyword | Behavior trigger: "Player Said Keyword" (`keyword`) or "AI Said Keyword" (`ai-keyword`) |
| Ensure achievement fires only once | Set `maxFireCount: 1` on the behavior; for keyword triggers, also add condition `achievement_xxx eq false` |
| Pop up a golden achievement notification | Behavior action: Show Notification, style `achievement` |
| Show an achievement panel in the chat | Root Component reads boolean variables and renders unlocked/locked states |
| Add a new achievement | Add boolean variable + add behavior + add entry to the Root Component's `achievements` array |

---

## Try it yourself — importable demo world

Download this JSON and import it to see everything in action:

<a href="/recipe-13-demo.json" download>recipe-13-demo.json</a>

**How to import:**
1. Go to Yumina → **My Worlds** → **Create New World**
2. In the editor, click **More Actions** → **Import Package**
3. Select the downloaded `.json` file
4. A new world is created with all variables, behaviors, and the Root Component pre-configured
5. Start a new session and try it out

**What's included:**
- 5 variables (`gold`, `combat_wins`, `achievement_rich`, `achievement_warrior`, `achievement_explorer`)
- 4 behaviors (Big Spender, First Blood, Trailblazer x2)
- A Root Component with the achievement panel

---

::: tip This is Recipe #13
The achievement system combines freely with other recipes — pair it with the combat system to track battle wins, the [shop system](./shop.md) to track gold accumulation, or the [quest tracker](./quest-tracker.md) to track completed quests. Variables are universal, and behaviors don't interfere with each other.
:::

</div>
