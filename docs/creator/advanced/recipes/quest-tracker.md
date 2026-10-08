<div v-pre>

# Quest Tracker

> A quest log: each quest shows whether it's done, the player's gold is on screen, and finishing a quest pays its reward and pops up a notice. The AI decides when a quest is done; behaviors pay out exactly once; a player interface page shows the log. No code needed.

---

## What you'll build

- **A quest log page**: "Find Herbs" and "Defeat the Forest Wolf", each shown as done or not yet
- **Gold on screen**, updated as rewards come in
- **The AI marks quests done** when they happen in the story, however the player words it
- **Rewards paid once**: +30 gold for the herbs, +50 for the wolf, with a notice
- **A progress count**: "1 / 2 done"

### How it works

```
The player hands the herbs to the village elder
  → The AI, following the Quests done variable's Behavior Rules, adds "Find Herbs" to the list
  → The behavior "Reward: Find Herbs" is watching Quests done (Variable changes)
  → Its condition holds (Quests done contains "Find Herbs"), and it hasn't fired before (Max fires 1)
  → Gold +30, a notice "Quest complete: Find Herbs (+30 gold)", and the AI is told
  → The quest log shows Find Herbs as done
```

The AI is good at judging whether something happened in the story; the engine is good at paying exactly once.

---

## Step by step

### Step 1: Create the variables

In the **Add** row at the bottom of the card, click **＋ Variable** for each.

#### Quests done

| Field | Value |
|-------|-------|
| Name | Quests done |
| Type | List / table |
| Starts at | `[]` |
| Behavior Rules | see below |

```
The quests the player has finished, by name. The quests are: "Find Herbs" (bring healing herbs to the village elder) and "Defeat the Forest Wolf" (kill the wolf that's been taking sheep). When the player really completes one in the story, add its exact name to this list. Never add a quest that isn't finished, and never add one twice.
```

#### Gold

| Field | Value |
|-------|-------|
| Name | Gold |
| Type | Number |
| Starts at | `0` |
| Range | `0` to (empty) |
| Behavior Rules | `The player's gold. Quest rewards are added automatically; you may also change it for loot, trade or theft.` |

Click **Show on the player screen** to keep Gold visible in chat.

#### Quests completed (optional)

| Field | Value |
|-------|-------|
| Name | Quests completed |
| Type | Number |
| Formula (worked out automatically) | `len({Quests done})` |

It counts the list by itself. The AI can read it but not change it.

---

### Step 2: Create a reward behavior per quest

In the **Add** row, click **＋ Behavior**.

#### Reward: Find Herbs

| Part | Setting |
|------|---------|
| When it fires | **Variable changes**: Quests done |
| ONLY IF | Quests done **contains** `Find Herbs` |
| Effects | **Change variable**: Gold plus `30` |
| | **Show notification**: `Quest complete: Find Herbs (+30 gold)`, style **Success** |
| | **Tell the AI**: `The player just completed "Find Herbs" and received 30 gold. Acknowledge it in your reply.` |
| Max fires | `1` |

**Max fires** `1` is what keeps the reward from paying twice: the list changes again when the next quest is added, and "contains Find Herbs" is still true then, but the behavior has already fired once.

**Tell the AI** slips the AI one line for its next reply, so it can write the elder counting out the coins.

#### Reward: Defeat the Forest Wolf

The same, with `Defeat the Forest Wolf` in the condition, Gold plus `50`, and the matching notice and line for the AI.

::: info Keyword triggers instead
You can also complete a quest from words in the conversation: **When it fires**: **AI says keyword** `the elder takes the herbs`. Keywords are separated by commas and **any one** of them fires the behavior, so a list like `defeat, wolf` would fire on "I spotted a wolf". Use a phrase specific to the moment, and add a Switch variable per quest (set to true in the effects, checked in **ONLY IF**) so it can't fire twice. Letting the AI mark the quest, as above, copes better with the many ways a player can phrase things.
:::

---

### Step 3: Build the quest log page

Click **Player interface** in the middle of the top bar. Add a page with **New page** (a **Blank page**) and call it "Quests".

1. Add a **Text** part for the title, and one reading `{Quests completed} / 2 done` (use **Insert a variable's value…**)
2. Add a **List** part. Under **Rows come from**, pick **Rows I write**, and add two rows: title `Find Herbs`, text `Bring healing herbs to the village elder. Reward: 30 gold`; title `Defeat the Forest Wolf`, text `Kill the wolf that's been taking sheep. Reward: 50 gold`
3. Turn on **Draw each row as a card**
4. Under **Locked until**, turn on **Show locked rows as locked**, set **Watch this variable** to Quests done, and leave **Match this row field** as `title`. In **Shown while locked**, write `Not done yet`. A row lights up when Quests done contains its title
5. Add a button with **Go to page** back to the conversation, and on the conversation page a "Quests" button with **Go to page** → Quests

Turn **Edit** off to click through it without using credits.

::: tip A whole-screen layout
The **Stat panel** template (under **Whole screen**) gives a ready-made layout with four meters, gold and a day counter, if you want gold and other numbers always on screen rather than on a page.
:::

---

### Step 4: Playtest

Click **Play** in the top bar.

1. Open **Quests**: both quests read "Not done yet", 0 / 2 done, Gold 0
2. Play through finding the herbs and bringing them back. When the AI marks the quest, the notice pops up and Gold becomes 30
3. Open **Quests**: Find Herbs is done, 1 / 2
4. Hunt down the wolf. Gold becomes 80, 2 / 2

**This turn** on the right of the playtest shows when Quests done changed and whether each reward behavior fired.

**If something goes wrong:**

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| The quest was done in the story but never marked | The AI didn't add it to the list | Make the Behavior Rules name each quest exactly and say when it counts as done |
| Marked, but no reward | The name the AI added doesn't match the condition | The list entry, the condition and the row title must all be the same text |
| The reward paid twice | **Max fires** isn't `1` | Set it on each reward behavior |
| The log row stays locked | **Match this row field** or **Watch this variable** is wrong | `title`, and Quests done |
| The AI marks quests too early | Its rules are too loose | Say what has to happen: "only when the elder has the herbs in hand" |

---

## Custom code route: a quest panel under the chat

If you write your own interface, read the same variables in the interface code. Everything above stays as it is.

**Panels → Front End Code** → open `index.tsx` and replace the default `return <Chat />`:

```tsx
export default function MyWorld() {
  const api = useYumina();
  const msgs = api.messages || [];

  const done = Array.isArray(api.variables["Quests done"])
    ? api.variables["Quests done"].map(String)
    : [];
  const gold = Number(api.variables["Gold"] ?? 0);

  const quests = [
    { name: "Find Herbs", reward: 30 },
    { name: "Defeat the Forest Wolf", reward: 50 },
  ].map((q) => ({ ...q, done: done.includes(q.name) }));

  const completedCount = quests.filter((q) => q.done).length;

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
              marginTop: "16px",
              padding: "16px",
              background: "linear-gradient(135deg, rgba(30,41,59,0.8), rgba(15,23,42,0.9))",
              borderRadius: "12px",
              border: "1px solid #334155",
            }}>
              {/* Header with gold */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
                <div style={{ fontSize: "15px", fontWeight: "bold", color: "#e2e8f0" }}>Quest Tracker</div>
                <div style={{
                  display: "flex", alignItems: "center", gap: "6px", padding: "4px 12px",
                  background: "rgba(234,179,8,0.15)", border: "1px solid rgba(234,179,8,0.3)", borderRadius: "20px",
                }}>
                  <span style={{ fontSize: "14px" }}>💰</span>
                  <span style={{ fontSize: "14px", fontWeight: "bold", color: "#fbbf24" }}>{gold}</span>
                </div>
              </div>

              <div style={{ fontSize: "12px", color: "#64748b", marginBottom: "12px" }}>
                Completed {completedCount}/{quests.length}
              </div>

              {/* Quest list */}
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {quests.map((quest) => (
                  <div key={quest.name} style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "10px 14px", borderRadius: "8px",
                    background: quest.done ? "rgba(34,197,94,0.08)" : "rgba(30,41,59,0.5)",
                    border: quest.done ? "1px solid rgba(34,197,94,0.2)" : "1px solid #1e293b",
                  }}>
                    <span style={{
                      fontSize: "13px",
                      color: quest.done ? "#94a3b8" : "#e2e8f0",
                      textDecoration: quest.done ? "line-through" : "none",
                    }}>
                      {quest.name}
                    </span>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span style={{ fontSize: "12px", color: quest.done ? "#4ade80" : "#64748b" }}>
                        {quest.done ? `+${quest.reward} g` : `${quest.reward} g`}
                      </span>
                      <span style={{
                        display: "inline-flex", alignItems: "center", justifyContent: "center",
                        width: "24px", height: "24px", borderRadius: "6px", fontSize: "13px", fontWeight: "bold",
                        background: quest.done ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.15)",
                        color: quest.done ? "#4ade80" : "#f87171",
                        border: quest.done ? "1px solid rgba(34,197,94,0.3)" : "1px solid rgba(239,68,68,0.25)",
                      }}>
                        {quest.done ? "✓" : "✗"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {completedCount === quests.length && (
                <div style={{
                  marginTop: "12px", padding: "10px", textAlign: "center", fontSize: "13px", fontWeight: "600",
                  background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.25)",
                  borderRadius: "8px", color: "#4ade80",
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

**What the code does:**

- `api.variables["Quests done"]` reads the list by the variable's name; a quest is done when its name is in it
- `api.variables["Gold"]` reads the gold
- `completedCount` counts finished quests for the progress line and the "all complete" banner
- The panel only shows under the last message, and updates as soon as a variable changes

The status next to the file in **Panels → Front End Code** should read a green **OK**.

::: tip Don't want to write code yourself?
Click **Creation assistant** at the top right of the canvas and describe the panel you want.
:::

---

## Going further

### More quests

Add the quest's name and what counts as done to the Behavior Rules of Quests done, add a reward behavior, and add a row to the quest log (or a line to the `quests` array in code). If you used the formula, change `/ 2` on the log page to the new total.

### Quests the AI hands out

Add a second list, **Quests open**, and tell the AI in its Behavior Rules to add a quest when a character asks the player for help. Show it on the log page with a second List part reading from **A variable** (Quests open) instead of rows you write.

### Quest chains

To offer "Save the Village" only after the herbs, write the new quest as a standby lore entry (it waits for a behavior before the AI sees it). Then add a behavior: **Variable changes** on Quests done, **ONLY IF** Quests done **contains** `Find Herbs`, effect **Enable lore entry** for that entry, **Max fires** `1`. From then on the AI knows the elder has a new request. **ONLY IF** can hold several conditions, with **All must hold** or **Any may hold**, for longer chains. See [Openings and lore](/creator/entries#lore) for standby lore.

### Spending the gold

The [shop](./shop.md) uses the same Gold variable: quests add to it, the shop takes from it.

---

## Quick reference

| What you want | How to do it |
|---------------|-------------|
| Let the AI judge when a quest is done | A List / table variable with Behavior Rules naming each quest |
| Pay a reward once | Behavior: **Variable changes**, **ONLY IF** list **contains** the quest, **Max fires** `1` |
| Tell the player | Effect: **Show notification**, style **Success** |
| Tell the AI | Effect: **Tell the AI** (next reply only) |
| Count finished quests | A Number variable with the formula `len({Quests done})` |
| Show the quest log | A List part with **Rows I write** and **Locked until** watching Quests done |
| Gold always on screen | **Show on the player screen** on Gold |
| Complete a quest from exact words | **Player says keyword** / **AI says keyword** (any one keyword fires it) |
| A custom panel | Interface code reading the same variables |

---

::: tip This is Recipe #6
The same loop (the AI notices something happened, a behavior pays out once, the interface shows it) works for story milestones, side-quest trees, and [achievements](./achievements.md).
:::

</div>
