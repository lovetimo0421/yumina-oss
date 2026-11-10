<div v-pre>

# Achievement System

> When the player hits a milestone (more than 100 gold, more than 5 battles won, finding a hidden area), a card pops up with the achievement's name and a line of text. Each achievement unlocks once, goes into a list, and a page in the player interface shows which ones are found and which are still locked. All of it can be built without code.

---

## What you'll build

- **A popup the moment a milestone is hit**: a little card with a title, a line of text and an optional picture
- **Automatic detection**: behaviors watch the numbers and the conversation, so the player doesn't have to do anything
- **Each achievement unlocks once**: a moment that's already in its list never pops up again
- **An achievements page**: every achievement is listed; unlocked ones show their text, locked ones show a hint
- **Optional**: achievements that stay unlocked across new games

### How it works

```
The player's gold goes from 95 to 101
  → The behavior "Big Spender" is watching Gold (Variable crosses threshold, Rises above 100)
  → Its effect "Unlock a moment" pops up the card "Big Spender"
  → The title "Big Spender" is added to the list variable Achievements
  → The achievements page shows Big Spender as unlocked
```

The AI moves the numbers as the story goes, but whether an achievement unlocks is decided by the engine, so an achievement can't be forgotten or handed out twice.

---

## Step by step

### Step 1: Create the variables

In the **Add** row at the bottom of the card, click **＋ Variable** for each of these.

#### Gold

| Field | Value |
|-------|-------|
| Name | Gold |
| Type | Number |
| Starts at | `0` |
| Range | `0` to (leave empty) |
| Behavior Rules | `The player's gold. Goes up when they're paid, loot something or sell something; goes down when they spend.` |

#### Battles won

| Field | Value |
|-------|-------|
| Name | Battles won |
| Type | Number |
| Starts at | `0` |
| Behavior Rules | `How many fights the player has won. Add 1 each time the player clearly wins a fight.` |

#### Achievements

| Field | Value |
|-------|-------|
| Name | Achievements |
| Type | List / table |
| Starts at | `[]` |

Open **What the AI does with it** and set **AI access** to **Engine only (hidden from AI)**. Only behaviors write to this list, and the AI has no use for reading it.

::: tip Achievements that survive a new game
In the same section, tick **Kept across playthroughs (for this player)**. Now when a player starts over, the list starts from what they already unlocked, and those achievements won't pop up again. This is how CG galleries and "endings found" collections work.
:::

---

### Step 2: Create a behavior per achievement

In the **Add** row, click **＋ Behavior**.

#### Behavior 1: Big Spender

| Part | Setting |
|------|---------|
| When it fires | **Variable crosses threshold**: Gold, **Rises above**, `100` |
| Effects | **Unlock a moment** |

Fill in the moment:

| Field | Value |
|-------|-------|
| Title | `Big Spender` |
| Message | `You've saved more than 100 gold.` |
| Picture (link) | optional: an `https://` link or an asset from **Panels → Assets** |
| Collected into (a list) | Achievements |

"Variable crosses threshold" fires only at the moment the number goes from 100 or less to more than 100. When gold keeps climbing from 101 to 150, nothing fires. If gold drops back under 100 and rises again it would fire again, but the moment is already in Achievements, so nothing pops up.

#### Behavior 2: Seasoned Fighter

| Part | Setting |
|------|---------|
| When it fires | **Variable crosses threshold**: Battles won, **Rises above**, `5` |
| Effects | **Unlock a moment**: Title `Seasoned Fighter`, Message `You've won more than 5 battles.`, Collected into Achievements |

#### Behavior 3: Trailblazer (keyword)

This one watches the conversation instead of a number. A behavior has one trigger, so to catch both what the player says and what the AI says, make two behaviors.

**3a**

| Part | Setting |
|------|---------|
| When it fires | **Player says keyword**: `explore, search the cave` |
| Effects | **Unlock a moment**: Title `Trailblazer`, Message `You went looking for what's hidden.`, Collected into Achievements |

**3b**

| Part | Setting |
|------|---------|
| When it fires | **AI says keyword**: `hidden passage, secret room` |
| Effects | the same **Unlock a moment** as 3a, with the same title |

Commas separate keywords, and any one of them is enough. Both behaviors collect into the same list under the same title, so whichever fires first unlocks the achievement and the other one finds it already there and stays quiet. You don't need extra conditions for this.

::: info Moments or a notification?
**Show notification** (with the **Success** style) also works for a one-line "Achievement unlocked" message, but it doesn't remember anything: you'd need a Switch variable per achievement, a condition so it doesn't fire twice, and **Max fires** set to 1. **Unlock a moment** does the remembering for you.
:::

---

### Step 3: Build the achievements page

Click **Player interface** in the middle of the top bar. Add a page with **New page** (a **Blank page** is fine), give it a title, and add a **List** part from **Add a part**:

1. Under **Rows come from**, pick **Rows I write** and add one row per achievement: `Big Spender`, `Seasoned Fighter`, `Trailblazer`, each with a line of text
2. Turn on **Draw each row as a card**
3. Under **Locked until**, turn on **Show locked rows as locked**. Set **Watch this variable** to Achievements and leave **Match this row field** as `title`. A row unlocks when the list contains its title, which is exactly what **Unlock a moment** puts there
4. In **Shown while locked**, write the hint the player sees before unlocking, like "Save up a little"
5. Add a **Button** with **Go to page** back to the conversation, so the page isn't a dead end (the page column warns **No way out** otherwise)
6. On the conversation page, add a **Button** labelled "Achievements" whose step is **Go to page** → your new page

If your collectibles are handed out by the AI in the story rather than by behaviors, start from the **Collection** template instead: "Things to find start greyed out and light up as the story hands them over." It comes with its own list variable, a popup, and Behavior Rules telling the AI when to add to it.

Turn **Edit** off at the top to click through the page like a player would.

::: tip Count them
Add a Number variable called "Achievements unlocked" and give it the **Formula (worked out automatically)** `len(Achievements)`. Put `{Achievements unlocked} / 3` in a Text part on the page and the count keeps itself up to date.
:::

---

### Step 4: Playtest

Click **Play** in the top bar.

1. Click **Achievements**: all three are locked and show their hints
2. Play until your gold passes 100. The "Big Spender" card pops up, and the page shows it unlocked
3. Win six fights. "Seasoned Fighter" pops up when Battles won goes from 5 to 6
4. Send "I want to explore this cave". "Trailblazer" pops up. Later the AI mentions a hidden passage, and nothing pops up again

**This turn** on the right of the playtest shows which behaviors fired, and why one didn't.

**If something goes wrong:**

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Gold is over 100 but nothing popped up | Gold never crossed the line: it started above 100 | The threshold only fires on the crossing. Check **Starts at** is at or below the threshold |
| The moment popped up but the page didn't change | **Collected into (a list)** is empty, or the page watches a different variable | Pick Achievements in both places |
| The page shows it locked even though it popped up | The row's title doesn't match the moment's title exactly | Make them identical, including capitals |
| An achievement popped up twice | The two behaviors use different titles or different lists | Same title, same list |

---

## Custom code route: an achievements panel under the chat

If you'd rather draw the panel yourself, for example under the last message instead of on a separate page, write it in the interface code. The behaviors above stay exactly as they are; the code only reads the Achievements list.

**Panels → Front End Code** → open `index.tsx` and replace the default `return <Chat />`:

```tsx
export default function MyWorld() {
  const api = useYumina();
  const msgs = api.messages || [];

  // Titles must match the moment titles in your behaviors
  const achievements = [
    { title: "Big Spender", desc: "Save more than 100 gold", icon: "💰" },
    { title: "Seasoned Fighter", desc: "Win more than 5 battles", icon: "⚔️" },
    { title: "Trailblazer", desc: "Find a hidden area or secret", icon: "🗺️" },
  ];

  // The list the moments are collected into, read by its name
  const unlockedList = Array.isArray(api.variables["Achievements"])
    ? api.variables["Achievements"].map(String)
    : [];
  const isUnlocked = (a) => unlockedList.includes(a.title);
  const unlockedCount = achievements.filter(isUnlocked).length;

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
              padding: "12px 16px",
              background: "linear-gradient(135deg, #1c1917, #292524)",
              border: "1px solid #44403c",
              borderRadius: "10px",
            }}>
              <div style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "10px",
              }}>
                <span style={{ fontSize: "13px", fontWeight: "bold", color: "#fbbf24" }}>
                  🏆 Achievements
                </span>
                <span style={{ fontSize: "12px", color: "#a8a29e" }}>
                  {unlockedCount} / {achievements.length}
                </span>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                {achievements.map((a) => {
                  const unlocked = isUnlocked(a);
                  return (
                    <div
                      key={a.title}
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
                      <span style={{ fontSize: "18px", opacity: unlocked ? 1 : 0.3 }}>
                        {unlocked ? a.icon : "🔒"}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontSize: "13px",
                          fontWeight: "600",
                          color: unlocked ? "#fbbf24" : "#78716c",
                        }}>
                          {a.title}
                        </div>
                        <div style={{
                          fontSize: "11px",
                          color: unlocked ? "#a8a29e" : "#57534e",
                          marginTop: "1px",
                        }}>
                          {a.desc}
                        </div>
                      </div>
                      {unlocked && (
                        <span style={{ fontSize: "11px", color: "#fbbf24" }}>✓ Unlocked</span>
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

**What the code does:**

- `<Chat renderBubble={...} />` keeps the platform's message list, input box and scrolling; you only draw each bubble
- `msg.messageIndex === msgs.length - 1` puts the panel under the last message only
- `msg.contentHtml` is the message already rendered to HTML
- `api.variables["Achievements"]` reads the list by the variable's name. Names with spaces or capitals work with the bracket form
- An achievement counts as unlocked when its title is in the list, the same rule the moment uses

The status next to the file in **Panels → Front End Code** should read a green **OK**. If it says **Error**, the message under it tells you which line.

::: tip Don't want to write code yourself?
Click **Creation assistant** at the top right of the canvas and describe the panel you want. It writes the interface code for you.
:::

---

## `Variable crosses threshold` vs `Variable changes`

Both triggers watch variables, but they fire at different times.

**Variable crosses threshold** fires at the moment a number crosses a line:

```
gold: 80 → 95 → 101   ← fires on 95→101 (crossed above 100)
gold: 101 → 150 → 200  ← doesn't fire (already above)
gold: 200 → 50 → 120   ← fires on 50→120 (crossed above 100 again)
```

Use it for milestones, warnings ("health dropped below 20") and death checks.

**Variable changes** fires whenever the variable you pick changes, whatever its value:

```
gold: 80 → 95   ← fires
gold: 95 → 101  ← fires
gold: 101 → 150 ← fires
```

It needs an **ONLY IF** condition to be useful ("only if Gold ≥ 100"), and it keeps re-checking on every change. For an achievement, the crossing is the event you care about, so **Variable crosses threshold** is the natural fit.

---

## More achievements

Each new one is a behavior plus a row on the achievements page:

| Achievement | When it fires |
|-------------|---------------|
| Chatterbox | **Every N turns**: `50`, with **Max fires** `1` |
| Hoarder | **Variable crosses threshold**: Gold rises above `500` |
| Socialite | **AI says keyword**: `trusts you, become friends` |
| Back from the Brink | **Variable crosses threshold**: Health drops below `10` sets a Switch "Was nearly dead"; a second behavior on Health rises above `50`, **ONLY IF** Was nearly dead is true, unlocks the moment |

---

## Quick reference

| What you want | How to do it |
|---------------|-------------|
| Unlock when a number hits a target | **When it fires**: **Variable crosses threshold**, **Rises above** |
| Unlock on something said | **Player says keyword** or **AI says keyword** |
| Pop up a card and remember it | Effect: **Unlock a moment**, with **Collected into (a list)** |
| Make sure it only unlocks once | Same title, same list. The moment won't fire for a title already in the list |
| Keep achievements across new games | Tick **Kept across playthroughs (for this player)** on the list variable |
| Show found and locked achievements | **Player interface** → **Collection** template, or a List part with **Locked until** |
| Count them | A Number variable with the formula `len(Achievements)` |
| A custom panel | Interface code that reads the list (custom code route above) |

---

::: tip This is Recipe #13
Achievements combine with the other recipes: count battle wins from a combat system, watch the gold from the [shop](./shop.md), or unlock one when a [quest](./quest-tracker.md) is done. Behaviors don't interfere with each other, so adding achievements doesn't change how the rest of the card works.
:::

</div>
