<div v-pre>

# Map & Scene Navigation

> A map the player can tap: choose the Forest and the scene moves there. The AI gets the Forest's atmosphere, the music fades over to the forest track, and the AI's next reply describes arriving. Built from one variable, conditional lore, music rules and player interface buttons, no code.

---

## What you'll build

- **A map page** with four places: Village, Forest, Cave, Market
- **The current place is marked**, and its button can't be tapped again
- **Tapping a place moves the scene**: the location changes, that place's lore reaches the AI, and the player's line "(I head to the Forest)" goes into the chat so the AI describes the arrival
- **Each place has its own music**, faded from one to the next

### How it works

```
The player taps "Forest" on the map
  → The button sets Location to Forest, goes back to the chat,
    and says "(I head to the Forest)" for the player
  → The lore entry "Forest" (condition: Location is Forest) now reaches the AI; "Village" no longer does
  → The music rule for Forest matches: the village track fades out, the forest track fades in
  → The AI replies to "(I head to the Forest)" with the forest atmosphere in hand
```

Only the variable changes. Lore and music watch it and follow.

---

## Step by step

### Step 1: Create the variable

In the **Add** row at the bottom of the card, click **＋ Variable**.

| Field | Value |
|-------|-------|
| Name | Location |
| Type | Text |
| Starts at | `Village` |
| Behavior Rules | `Where the player is: Village, Forest, Cave or Market. Change it when the player clearly travels to one of these.` |

Leave **AI access** on **AI can read & write** if the AI should be able to move the player in the story too ("you follow the stream into the forest"). Set it to **AI read-only** if only the map should move them.

---

### Step 2: Write one lore entry per place

Add a lore entry for each place. Then drag **Location** onto each entry, click the line, and set the condition: Location **is** `Village` (and so on). The entries move into the conditional lore block, and only the current place's entry reaches the AI.

#### Village

```
[Location: Village]
The player is in the village. Bring this into scene descriptions:
- A quiet little village; cobbled lanes wind between wooden houses
- Smoke rises from chimneys; the air smells of fresh bread and stew
- Villagers talk by the well; a hammer rings from the smithy
- Wheat fields stretch away, moving in the wind
- The mood is warm and everyday
```

#### Forest

```
[Location: Forest]
The player is in the forest. Bring this into scene descriptions:
- Old trees shut out most of the sky; light comes down in patches onto the moss
- The air is damp and smells of earth, resin and wildflowers
- Birdsong from every side, and now and then the crack of a branch
- The undergrowth could hide a rabbit, a deer, or something worse
- The deeper you go, the closer the trees and the dimmer the light
- The mood is old, wild and uncertain
```

#### Cave

```
[Location: Cave]
The player is in the cave. Bring this into scene descriptions:
- Glowing fungi on the rock walls give off a faint blue-green light
- Water drips from the stalactites, each drop echoing
- The air is cold and wet and smells of minerals
- The floor is slick and uneven; the tunnels further in are pitch black
- Sometimes a low growl, or the crack of shifting rock, comes up from below
- The mood is dark and close
```

#### Market

```
[Location: Market]
The player is at the market. Bring this into scene descriptions:
- Rows of bright stalls and tents, piled with every kind of goods
- Traders call out their wares; haggling rises and falls all around
- Spices, roasting meat, leather and flowers all at once
- A magic shop's window flickers with odd light; an alchemist mixes something in a corner
- Travellers of every kind push through the crowd
- The mood is loud and busy
```

---

### Step 3 (optional): Music per place

Add four BGM tracks on the **Audio** page (click **＋ Audio** in the **Add** row if the card has no audio yet): Village, Forest, Cave, Market, each with **Loop Audio** on and 2 seconds of **Fade In (s)** and **Fade Out (s)**. Put Village in the **Default Playlist** with **Auto-play** on.

Then **BGM Configuration** → **Conditional BGM** → **Add Conditional Rule**, once for each of Forest, Cave and Market:

| Field | Value |
|-------|-------|
| WHEN | **Variable condition**: Location is `Forest` |
| Play | Forest |
| Fade In (s) / Fade Out (s) | `3` / `3` |
| Stop previous BGM | On |
| On end | **Return to default playlist** |

When the player goes back to the Village, no rule matches, and **On end** brings the playlist's village music back.

With 3-second fades, the old track and the new one overlap for a moment, one getting quieter while the other gets louder, so the music never cuts out between places. More in the [Audio Design Guide](./audio-design.md).

---

### Step 4: Build the map page

Click **Player interface** in the middle of the top bar. Add a page with **New page** (a **Blank page**), call it "Map", and give it a title and a short line like "Where to?".

Add one **Button** per place (**Add a part** → **Button**). For the Forest button, under **When pressed, do in order**:

1. **Change a variable**: Location, **Set to**, `Forest`
2. **Go to page**: the conversation page
3. **Say a line for the player**: `(I head to the Forest)`

The last step is what makes the AI describe the arrival straight away: it's as if the player had typed it.

To keep the player from travelling to where they already are, give each button **When to show** → **When a variable matches**: Location **is not** `Forest`. Add a **Text** part at the top reading `You are in: {Location}` (use **Insert a variable's value…**).

Add a **Button** to the page that just goes back (**Go to page** → the conversation) so the player can close the map without moving. And on the conversation page, add a "Map" button with **Go to page** → Map.

Turn **Edit** off to click through it without using credits.

::: tip The Map template
**Templates** → **Map** ("Tap a place to go there; places not unlocked yet can't be tapped") builds a ready-made map page with five example places. It adds **Location** and **Places open**, a list the AI adds places to when the story gives the player a way to reach them, so places start locked and open up as the story goes. Use it if you want places unlocked by the story rather than all open from the start.
:::

::: info Places as scenarios
When a place grows into its own part of the game (its own NPCs, rules and variables, maybe its own AI), make it a [scenario](/creator/modules) instead of a single lore entry. Set the scenario's **When it's used** to **When a variable meets a condition**, `Location = Cave`, and everything inside it only applies while the player is there. You can drag the Location variable onto the scenario to set this.
:::

---

### Step 5: Playtest

Click **Play** in the top bar.

1. The village music plays. Open **Map**: "You are in: Village", and there's no Village button
2. Tap **Forest**. You're back in the chat, "(I head to the Forest)" is sent, and the AI describes the forest
3. If you added music, the village track fades into the forest one
4. Go to the Cave, then back to the Village: the playlist's village music returns
5. Chat normally between trips; the map is always one tap away

**This turn** on the right of the playtest shows which place entry the AI got.

**If something goes wrong:**

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Tapping a place does nothing | The button has no steps | Check **When pressed, do in order** |
| The location changes but the AI doesn't reply | No **Say a line for the player** step | Add it as the last step |
| The AI describes the wrong place | An entry's condition doesn't match the value the button sets | `Forest` in the button and in the condition must be spelled the same |
| Two places' atmospheres mix | One entry is in the always-sent block | Check **When the AI sees this** on each entry |
| Two tracks play at once | **Stop previous BGM** is off | Turn it on for each place rule |
| The music jumps instead of fading | Fades are 0 | Set **Fade In (s)** and **Fade Out (s)** on the rule to 2 or 3 |

---

## Custom code route: a map panel with travel routes

If you write your own interface, here's a map panel under the last message that also limits where the player can go from where they are. It sets the same Location variable and sends the same line, so the lore and music from Steps 2 and 3 work unchanged.

**Panels → Front End Code** → open `index.tsx` and replace the default `return <Chat />`:

```tsx
export default function MyWorld() {
  const api = useYumina();
  const current = String(api.variables["Location"] || "Village");
  const msgs = api.messages || [];

  const locations = [
    { id: "Village", icon: "🏘️", color: "#92400e", bg: "#fef3c7", border: "#f59e0b", activeBg: "#f59e0b" },
    { id: "Forest",  icon: "🌲", color: "#166534", bg: "#dcfce7", border: "#22c55e", activeBg: "#22c55e" },
    { id: "Cave",    icon: "🕳️", color: "#3b0764", bg: "#f3e8ff", border: "#a855f7", activeBg: "#a855f7" },
    { id: "Market",  icon: "🏪", color: "#9a3412", bg: "#ffedd5", border: "#f97316", activeBg: "#f97316" },
  ];

  // Where you can go from each place
  const routes = {
    Village: ["Forest", "Market"],
    Forest:  ["Village", "Cave"],
    Cave:    ["Forest"],
    Market:  ["Village"],
  };
  const reachable = routes[current] || [];

  const travel = (loc) => {
    api.setVariable("Location", loc.id);
    api.sendMessage("(I head to the " + loc.id + ")");
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

          {isLastMsg && !msg.isStreaming && (
            <div style={{
              marginTop: "16px",
              padding: "16px",
              background: "rgba(15,23,42,0.6)",
              borderRadius: "12px",
              border: "1px solid #334155",
            }}>
              <div style={{ fontSize: "13px", color: "#94a3b8", marginBottom: "12px", fontWeight: "600", letterSpacing: "0.05em" }}>
                WORLD MAP
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                {locations.map((loc) => {
                  const isHere = current === loc.id;
                  const canGo = reachable.includes(loc.id);
                  return (
                    <button
                      key={loc.id}
                      onClick={() => { if (!isHere && canGo) travel(loc); }}
                      style={{
                        padding: "14px 10px",
                        background: isHere ? loc.activeBg : loc.bg,
                        border: `2px solid ${isHere ? loc.activeBg : loc.border}`,
                        borderRadius: "10px",
                        color: isHere ? "#ffffff" : loc.color,
                        fontSize: "14px",
                        fontWeight: "700",
                        cursor: isHere ? "default" : canGo ? "pointer" : "not-allowed",
                        opacity: isHere ? 1 : canGo ? 0.85 : 0.3,
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        gap: "6px",
                      }}
                    >
                      <span style={{ fontSize: "28px" }}>{loc.icon}</span>
                      <span>{loc.id}</span>
                      {isHere && <span style={{ fontSize: "11px", fontWeight: "500" }}>You are here</span>}
                    </button>
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

- `api.variables["Location"]` reads the variable by its name
- `routes` lists where each place leads. Places you can't reach from here are faded and can't be tapped
- `travel()` sets Location, then `api.sendMessage(...)` sends the travel line as the player, so the AI replies with the new place's lore already in its prompt
- `!msg.isStreaming` hides the map while the AI is still writing, so the player can't travel mid-reply
- `gridTemplateColumns: "1fr 1fr"` lays the four places out two by two; use `"1fr 1fr 1fr"` for three columns

The status next to the file in **Panels → Front End Code** should read a green **OK**.

::: tip Don't want to write code yourself?
Click **Creation assistant** at the top right of the canvas and describe the map you want.
:::

---

## Adding a place

1. Add a lore entry "Harbor" with the condition Location is `Harbor`
2. Optionally add a Harbor track and a **Conditional BGM** rule for it
3. Add a Harbor button on the map page (or a line in the `locations` array and `routes`)
4. Add Harbor to Location's Behavior Rules so the AI knows it exists

Nothing that's already there needs to change.

---

## Quick reference

| What you want | How to do it |
|---------------|-------------|
| Track where the player is | A Text variable, Location |
| Give the AI the current place's atmosphere | One lore entry per place, with a condition on Location |
| Move the player from a button | Steps: **Change a variable**, **Go to page**, **Say a line for the player** |
| Have the AI describe the arrival straight away | **Say a line for the player** (or `api.sendMessage()` in code) |
| Hide the button for where they are | **When to show** → **When a variable matches**, Location **is not** … |
| Music per place | **Conditional BGM** rule per place, **Stop previous BGM** on |
| Places that open up during the story | **Map** template with **Places open** |
| A big place with its own content | A [scenario](/creator/modules) used **When a variable meets a condition** |
| Limit routes between places | Interface code (custom code route above) |

---

::: tip This is Recipe #12
The same setup (one variable, plus lore and music that follow it) works for floors of a tower, rooms in a house, or worlds behind portals. [Day-Night Cycle](./day-night.md) uses it with time instead of place, and the two combine: a forest at night can have its own entry with both conditions.
:::

</div>
