<div v-pre>

# Quest Tracker

> Build a quest tracker panel — show completion status for each quest (checkmark or X), display gold rewards in real time. When a player completes a quest, automatically pop an achievement notification and hand out the reward. This recipe teaches you how to wire it up with variables, behaviors, and the Root Component.

---

## What you'll build

A quest tracker panel embedded in the chat interface:

- **Quest list** — each quest shows its name and completion status (done = green checkmark, not done = red X)
- **Gold counter** — real-time display of the player's current gold
- **Auto-detection** — when the player's message contains a keyword (e.g. "herb" or "defeat"), the quest is automatically marked complete
- **Achievement notification** — a gold-colored toast pops up when a quest is completed, telling the player how much they earned
- **Gold rewards** — each quest automatically pays out gold on completion

```
Player sends a message mentioning "found the herbs"
  → Engine detects player keyword "herb"
  → Checks condition: quest_1_complete == false?
    → Yes: set quest_1_complete = true, add 30 gold, pop achievement notification
    → No: do nothing (quest already completed)
  → Quest panel auto-updates: "Find Herbs" changes from ✗ to ✓
```

---

## How it works

This quest system uses three core mechanics:

1. **Boolean variables + keyword triggers** — each quest is tracked by a boolean variable. When the player's message contains a specific keyword, a behavior rule automatically sets the variable to `true`
2. **Condition checks** — behaviors check whether the quest is already complete before firing. Completed quests won't trigger again (no double rewards)
3. **Root Component reads variables** — the panel reads quest status and gold from variables in real time, dynamically rendering checkmarks or X marks

---

## Step by step

### Step 1: Create variables

We need 5 variables — two for quest completion status, one for gold, and two more for quest names (so the Root Component can display them dynamically).

Editor → sidebar → **Variables** tab → click "Add Variable" for each one

#### Variable 1: Quest 1 completion status

| Field | Value | Why |
|-------|-------|-----|
| Name | Quest 1 Complete | A label for your own reference in the variable list |
| ID | `quest_1_complete` | Behaviors and the Root Component use this ID to read/write the value |
| Type | Boolean | Only two states: "done" and "not done" |
| Default Value | `false` | Quest hasn't been completed when a new session starts |
| Category | Flag | This is a status flag, not a numeric stat |
| Behavior Rules | `Set to true when the player completes the Find Herbs quest. Behaviors auto-detect this via keywords, but you may also mark it complete at an appropriate story moment.` | Tells the AI what this variable means and when it should change |

#### Variable 2: Quest 2 completion status

| Field | Value | Why |
|-------|-------|-----|
| Name | Quest 2 Complete | Easy to identify |
| ID | `quest_2_complete` | Used by behaviors and the Root Component |
| Type | Boolean | Same two-state setup |
| Default Value | `false` | Not completed at session start |
| Category | Flag | Status flag |
| Behavior Rules | `Set to true when the player defeats the Forest Wolf. Behaviors auto-detect this via keywords, but you may also mark it complete at an appropriate story moment.` | Tells the AI what this variable means and when it should change |

#### Variable 3: Gold

| Field | Value | Why |
|-------|-------|-----|
| Name | Gold | Easy to identify |
| ID | `gold` | Automatically increases when quests are completed |
| Type | Number | Gold is numeric — needs addition and subtraction |
| Default Value | `0` | No gold at session start — earn it by completing quests |
| Min Value | `0` | Prevents gold from going negative |
| Category | Resource | Gold is a resource variable |
| Behavior Rules | `Gold is automatically awarded on quest completion. You may also add or subtract gold in the story — e.g., combat loot, trading, or theft.` | Tells the AI that gold can change in multiple contexts |

#### Variable 4: Quest 1 name

| Field | Value | Why |
|-------|-------|-----|
| Name | Quest 1 Name | Easy to identify |
| ID | `quest_1_name` | The Root Component uses this ID to display the quest name |
| Type | String | Quest names are text |
| Default Value | `Find Herbs` | The name of the first quest |
| Category | Custom | Just descriptive data |
| Behavior Rules | `Do not modify this variable.` | Quest names shouldn't be changed |

#### Variable 5: Quest 2 name

| Field | Value | Why |
|-------|-------|-----|
| Name | Quest 2 Name | Easy to identify |
| ID | `quest_2_name` | Used by the Root Component |
| Type | String | Quest names are text |
| Default Value | `Defeat the Forest Wolf` | The name of the second quest |
| Category | Custom | Descriptive data |
| Behavior Rules | `Do not modify this variable.` | Quest names shouldn't be changed |

::: info Why write behavior rules for every variable?
Because the AI can "suggest" variable changes when generating replies. If you don't tell it to leave a variable alone, it might mark the quest complete on its own (e.g., the AI decides "the player found herbs" and sets `quest_1_complete` to `true` — but since it bypassed the behavior logic, no gold reward gets paid). The behavior rules field is your instruction to the AI — once written, the AI knows these variables are system-controlled.
:::

---

### Step 2: Create behaviors

This is the heart of the quest system. We need 2 behaviors, each detecting a keyword and marking the corresponding quest complete while handing out rewards.

Editor → **Behaviors** tab → click "Add Behavior" for each one

#### Behavior 1: Complete quest "Find Herbs"

**WHEN (when to check):**

| Field | Value | Why |
|-------|-------|-----|
| Trigger type | Player said keyword (`keyword`) | Fires when the player's message contains specific text |
| Keywords | `herb` or `found herb` | Matches when the player says something like "I found the herbs" |

> **How does keyword matching work?** The engine checks the content of the player's message — if it **contains** the keyword anywhere, it matches. So "I found the herbs in the cave" triggers because it contains "herb". If you also want to detect keywords in the AI's response, create a separate behavior with the trigger type set to "AI said keyword" (`ai-keyword`).

**ONLY IF (conditions):**

| Variable | Operator | Value | Why |
|----------|----------|-------|-----|
| `quest_1_complete` | equals (eq) | `false` | Only triggers when the quest hasn't been completed yet — prevents double rewards |

> **Why do you need a condition?** Without it, every time anyone mentions "herb" the reward fires again. With `quest_1_complete == false`, the first mention of herb → completes the quest, pays the reward, marks `true`. Any mention after that → condition fails (already `true`), nothing happens.

**DO (actions):**

Add these actions in order:

| Action type | Settings | Effect |
|-------------|----------|--------|
| Modify variable | Variable `quest_1_complete`, operation `set`, value `true` | Mark quest as completed |
| Modify variable | Variable `gold`, operation `add`, value `30` | Pay out 30 gold reward |
| Show notification | Message `Quest Complete: Find Herbs! +30 gold`, style `achievement` | Pop a gold-colored achievement toast |
| Tell AI | Content: `The player just completed the quest "Find Herbs" and received 30 gold as a reward. Please acknowledge this in your response.` | Let the AI know what happened so it can write a better narrative transition |

> **Why "Tell AI"?** Modifying variables and showing notifications are silent system operations — the AI itself doesn't know "a quest was just completed." Adding this step lets the AI write a natural follow-up in its next reply (e.g., "You carefully tuck the herbs into your pack, remembering the village elder's request. The trip wasn't for nothing after all").

#### Behavior 2: Complete quest "Defeat the Forest Wolf"

**WHEN (when to check):**

| Field | Value | Why |
|-------|-------|-----|
| Trigger type | Player said keyword (`keyword`) | Same as above — player keyword trigger |
| Keywords | `defeat` and `wolf` | Both words must appear — prevents "I saw a wolf" from triggering |

> **Multiple keyword matching logic.** When you enter multiple keywords, the message must contain **all** of them to trigger. So "I defeated the forest wolf" triggers (contains both "defeat" and "wolf"), but "I spotted a wolf" does not (only "wolf", no "defeat").

**ONLY IF (conditions):**

| Variable | Operator | Value | Why |
|----------|----------|-------|-----|
| `quest_2_complete` | equals (eq) | `false` | Same — prevents repeated triggering |

**DO (actions):**

| Action type | Settings | Effect |
|-------------|----------|--------|
| Modify variable | Variable `quest_2_complete`, operation `set`, value `true` | Mark quest as completed |
| Modify variable | Variable `gold`, operation `add`, value `50` | Pay out 50 gold (defeating the wolf is harder, so the reward is bigger) |
| Show notification | Message `Quest Complete: Defeat the Forest Wolf! +50 gold`, style `achievement` | Pop a gold-colored achievement toast |
| Tell AI | Content: `The player just completed the quest "Defeat the Forest Wolf" and received 50 gold as a reward. Please acknowledge this in your response.` | Let the AI know what happened |

::: info Action execution order
Actions within a single behavior execute **in sequence**. So: mark complete → add gold → pop notification → tell AI. This order matters — marking the variable first ensures all subsequent logic is based on the latest state.
:::

---

### Step 3: Add the quest tracker panel in the Root Component

This is the key step that makes the quest panel appear in the chat interface.

Editor → **Custom UI** section → open `index.tsx` → paste the following code (replacing the default `return <Chat />`):

```tsx
export default function MyWorld() {
  const api = useYumina();
  const msgs = api.messages || [];

  // Read variables
  const quest1Done = api.variables.quest_1_complete === true;
  const quest2Done = api.variables.quest_2_complete === true;
  const quest1Name = String(api.variables.quest_1_name || "Find Herbs");
  const quest2Name = String(api.variables.quest_2_name || "Defeat the Forest Wolf");
  const gold = Number(api.variables.gold ?? 0);

  // Quest list data
  const quests = [
    { name: quest1Name, done: quest1Done, reward: 30 },
    { name: quest2Name, done: quest2Done, reward: 50 },
  ];

  const completedCount = quests.filter(q => q.done).length;

  return (
    <Chat renderBubble={(msg) => {
      const isLastMsg = msg.messageIndex === msgs.length - 1;
      return (
    <div>
      {/* Render message text normally (platform already rendered HTML, use contentHtml directly) */}
      <div
        style={{ color: "#e2e8f0", lineHeight: 1.7 }}
        dangerouslySetInnerHTML={{ __html: msg.contentHtml }}
      />

      {/* Quest tracker panel — only shown on the last message */}
      {isLastMsg && (
        <div style={{
          marginTop: "16px",
          padding: "16px",
          background: "linear-gradient(135deg, rgba(30,41,59,0.8), rgba(15,23,42,0.9))",
          borderRadius: "12px",
          border: "1px solid #334155",
        }}>
          {/* Panel header */}
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "14px",
          }}>
            <div style={{
              fontSize: "15px",
              fontWeight: "bold",
              color: "#e2e8f0",
              letterSpacing: "0.5px",
            }}>
              Quest Tracker
            </div>
            {/* Gold counter */}
            <div style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              padding: "4px 12px",
              background: "rgba(234,179,8,0.15)",
              border: "1px solid rgba(234,179,8,0.3)",
              borderRadius: "20px",
            }}>
              <span style={{ fontSize: "14px" }}>💰</span>
              <span style={{
                fontSize: "14px",
                fontWeight: "bold",
                color: "#fbbf24",
              }}>
                {gold}
              </span>
            </div>
          </div>

          {/* Progress indicator */}
          <div style={{
            fontSize: "12px",
            color: "#64748b",
            marginBottom: "12px",
          }}>
            Completed {completedCount}/{quests.length}
          </div>

          {/* Quest list */}
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {quests.map((quest, idx) => (
              <div
                key={idx}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "10px 14px",
                  background: quest.done
                    ? "rgba(34,197,94,0.08)"
                    : "rgba(30,41,59,0.5)",
                  border: quest.done
                    ? "1px solid rgba(34,197,94,0.2)"
                    : "1px solid #1e293b",
                  borderRadius: "8px",
                }}
              >
                {/* Left side: quest name */}
                <div style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                }}>
                  <span style={{
                    fontSize: "13px",
                    color: quest.done ? "#94a3b8" : "#e2e8f0",
                    textDecoration: quest.done ? "line-through" : "none",
                  }}>
                    {quest.name}
                  </span>
                </div>

                {/* Right side: status badge */}
                <div style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                }}>
                  {/* Reward amount */}
                  <span style={{
                    fontSize: "12px",
                    color: quest.done ? "#4ade80" : "#64748b",
                  }}>
                    {quest.done ? `+${quest.reward} g` : `${quest.reward} g`}
                  </span>

                  {/* Completion status badge */}
                  <span style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: "24px",
                    height: "24px",
                    borderRadius: "6px",
                    fontSize: "13px",
                    fontWeight: "bold",
                    background: quest.done
                      ? "rgba(34,197,94,0.2)"
                      : "rgba(239,68,68,0.15)",
                    color: quest.done ? "#4ade80" : "#f87171",
                    border: quest.done
                      ? "1px solid rgba(34,197,94,0.3)"
                      : "1px solid rgba(239,68,68,0.25)",
                  }}>
                    {quest.done ? "✓" : "✗"}
                  </span>
                </div>
              </div>
            ))}
          </div>

          {/* All quests complete banner */}
          {completedCount === quests.length && (
            <div style={{
              marginTop: "12px",
              padding: "10px",
              background: "rgba(34,197,94,0.1)",
              border: "1px solid rgba(34,197,94,0.25)",
              borderRadius: "8px",
              textAlign: "center",
              fontSize: "13px",
              color: "#4ade80",
              fontWeight: "600",
            }}>
              All quests complete!
            </div>
          )}
        </div>
      )}
    </div>
      );
    }} />
  );
}
```

---

### Code walkthrough

Don't be intimidated by the length — what it does is very straightforward. Let's go section by section:

#### Basic setup

```tsx
const api = useYumina();
const msgs = api.messages || [];
// ...
<Chat renderBubble={(msg) => {
  const isLastMsg = msg.messageIndex === msgs.length - 1;
  // ...
}} />
```

- The Root Component `MyWorld()` is the entry for the world's UI. `<Chat renderBubble={...} />` keeps the platform in charge of the message list, input box, and scrolling — you only take over how each bubble looks
- `useYumina()` — gets the Yumina API so you can read variables
- `msg.messageIndex` — the current bubble's index in the message list. The quest panel only shows below the last message, so you don't get a duplicate panel on every message
- `msg.contentHtml` — the HTML the platform already rendered from Markdown, can be used directly with `dangerouslySetInnerHTML`

#### Reading variables

```tsx
const quest1Done = api.variables.quest_1_complete === true;
const quest2Done = api.variables.quest_2_complete === true;
const quest1Name = String(api.variables.quest_1_name || "Find Herbs");
const quest2Name = String(api.variables.quest_2_name || "Defeat the Forest Wolf");
const gold = Number(api.variables.gold ?? 0);
```

- `=== true` — strict comparison, ensures only boolean `true` counts as done. Prevents `"true"` (string) or `1` (number) from being misinterpreted
- `String(... || "Find Herbs")` — reads the quest name, falls back to a default if the variable doesn't exist
- `Number(... ?? 0)` — converts gold to a number. `?? 0` means "use 0 if the variable doesn't exist"

#### Quest list data

```tsx
const quests = [
  { name: quest1Name, done: quest1Done, reward: 30 },
  { name: quest2Name, done: quest2Done, reward: 50 },
];
const completedCount = quests.filter(q => q.done).length;
```

Collects quest info into an array so you can loop over it with `.map()`. `completedCount` tallies how many are done, used for the progress display.

#### Status badge

```tsx
<span style={{
  background: quest.done
    ? "rgba(34,197,94,0.2)"    // done → green background
    : "rgba(239,68,68,0.15)",  // not done → red background
  color: quest.done ? "#4ade80" : "#f87171",
}}>
  {quest.done ? "✓" : "✗"}
</span>
```

Each quest has a small badge on the right — green checkmark for done, red X for not done. This is the badge component effect.

#### Gold counter

```tsx
<div style={{
  padding: "4px 12px",
  background: "rgba(234,179,8,0.15)",
  borderRadius: "20px",
}}>
  💰 {gold}
</div>
```

A pill-shaped gold display in the top-right corner of the panel. Every time a quest is completed, the gold increases and the panel automatically refreshes to show the new value.

#### All-complete banner

```tsx
{completedCount === quests.length && (
  <div style={{ /* green highlight styles */ }}>
    All quests complete!
  </div>
)}
```

When every quest is done, a green text line appears at the bottom of the panel. `completedCount === quests.length` checks whether the done count equals the total.

::: tip Don't want to write code yourself? Use Studio AI
Editor top bar → click "Enter Studio" → AI Assistant panel → describe what you want in plain language (e.g., "build a quest tracker panel that shows quest completion status and gold"), and the AI will generate the code for you.
:::

---

### Step 4: Save and test

1. Click **Save** at the top of the editor
2. Click **Start Game** or go back to the home page and open a new session
3. You'll see the quest tracker panel below the AI's reply: two red X-marked quests, 0 gold
4. Send a message containing the keyword (e.g., "I found the herbs") — your message contains "herb", the behavior fires immediately, the panel updates: "Find Herbs" switches to a green checkmark, gold becomes 30, an achievement notification pops up
5. Send another message with the keyword (e.g., "I defeated the forest wolf") — your message contains both "defeat" and "wolf", the second quest completes, gold increases to 80
6. Once both quests are done, a green "All quests complete!" banner appears at the bottom of the panel

**If something isn't working:**

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Quest panel doesn't appear | Root Component code wasn't saved or has a syntax error | Check the compile status at the bottom of the Custom UI section — it should show a green "OK" |
| Sent a message with "herb" but quest didn't complete | The behavior keyword doesn't match your actual wording | Make sure your message actually contains "herb". Note: the trigger is a player keyword trigger — it only checks the player's message, not the AI's reply |
| Quest completed but gold didn't change | Missing the "modify variable gold add" action in the behavior | Go back to the behavior editor and confirm there's a "modify variable gold add 30" action after the "modify variable quest_1_complete" action |
| Same quest keeps giving repeat rewards | No condition configured | Make sure the behavior's ONLY IF condition includes `quest_1_complete eq false` — only triggers when not yet completed |
| Panel doesn't update in real time | Normal — the panel refreshes on the next message | The variable has already changed; wait for the AI's reply or send another message and the panel will update automatically |
| Notification didn't pop up | Missing the "show notification" action in the behavior | Confirm there's a show notification action in the action list with style set to `achievement` |
| "Defeat the wolf" quest doesn't trigger | Both keywords must appear in the same message | Make sure your message contains both "defeat" and "wolf". If you wrote "I beat the wolf", you'd need to change the keyword to "beat" or add "beat" as an alternative |

---

## Going further: expanding the quest system

Once you've got the basics down, you can build on top of this foundation.

### Adding more quests

Add a new boolean variable (`quest_3_complete`) and string variable (`quest_3_name`) in the Variables tab, then create a matching keyword-triggered behavior in the Behaviors tab. Finally, add a line to the `quests` array in the Root Component:

```tsx
const quests = [
  { name: quest1Name, done: quest1Done, reward: 30 },
  { name: quest2Name, done: quest2Done, reward: 50 },
  { name: quest3Name, done: quest3Done, reward: 100 },
];
```

### Letting the AI assign quests

You can build a "quest accepted" flow — the AI describes a new quest in dialogue, then a behavior detects a specific keyword and dynamically updates the quest name variable:

| Action type | Settings |
|-------------|----------|
| Modify variable | Variable `quest_3_name`, operation `set`, value `Escort the merchant to safety` |
| Show notification | Message `New Quest: Escort the merchant to safety`, style `achievement` |

### Combining with a shop system

Gold earned from quests can be spent in a shop. See Recipe #3 (Shop & Trading) — use the same `gold` variable. The quest system adds gold, the shop system deducts it. Both systems share a single economy.

### Quest chains

You can use condition combinations in behaviors to create complex quest dependencies. For example, "you can only accept 'Save the Village' after completing 'Find Herbs'":

| Variable | Operator | Value |
|----------|----------|-------|
| `quest_1_complete` | equals (eq) | `true` |
| `quest_3_complete` | equals (eq) | `false` |

Both conditions must be satisfied to trigger — ensures the prerequisite quest is done and the current quest hasn't been completed yet.

---

## Quick reference

| What you want | How to do it |
|---------------|-------------|
| Track quest completion | Create a boolean variable, default `false`, category Flag |
| Detect keyword to complete a quest | Behavior trigger type "Player said keyword" (`keyword`), enter keywords |
| Prevent repeat triggers | Add `quest_complete eq false` in the behavior's conditions |
| Pop an achievement toast on completion | Behavior action: show notification, style `achievement` |
| Award gold on completion | Behavior action: modify variable, `gold` add amount |
| Let the AI know a quest was completed | Behavior action: tell AI, write a sentence explaining what happened |
| Display the quest panel | Read variables in the Root Component, render checkmarks/X marks and gold |
| Only show panel on the last message | Inside `<Chat renderBubble>`, check `msg.messageIndex === msgs.length - 1` |
| Strike through completed quests | Use the `textDecoration: "line-through"` style |
| Show completion progress | Use `quests.filter(q => q.done).length` to count |
| Special banner when all quests are done | Check `completedCount === quests.length` |

---

## Try it yourself — importable demo world

Download this JSON and import it to experience the full quest tracking system:

<a href="/recipe-6-demo.json" download>recipe-6-demo.json</a>

**How to import:**
1. Go to Yumina → **My Worlds** → **Create New World**
2. In the editor, click **More Actions** → **Import Package**
3. Select the downloaded `.json` file
4. A new world is created with all variables, behaviors, and Root Component pre-configured
5. Start a new session and try it out

**What's included:**
- 5 variables (`quest_1_complete` and `quest_2_complete` for quest status, `gold` for currency, `quest_1_name` and `quest_2_name` for quest names)
- 2 behaviors (Find Herbs completion + Defeat the Forest Wolf completion, each with condition checks, variable modifications, notifications, and tell-AI actions)
- A Root Component (quest tracker panel: quest list + status badges + gold counter + completion progress)

---

::: tip This is Recipe #6
Earlier recipes covered scene jumping, combat systems, shop & trading, and character creation. This recipe teaches you how to build a quest tracking system using boolean variables + keyword triggers + condition checks. The same pattern extends to achievement systems, story progress tracking, side-quest trees — anything that needs the loop of "detect event → mark state → pay reward → update UI."
:::

</div>
