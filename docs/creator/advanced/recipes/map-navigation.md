<div v-pre>

# Map & Scene Navigation

> Build a clickable map interface — player clicks a location → scene switches, lore entries swap, BGM crossfades, and the AI describes the new area's atmosphere. This recipe shows you how to wire it all up with variables, behaviors, lore entries, and the Root Component.

---

## What you'll build

A visual map navigation system embedded in the chat:

- **Map UI** — a grid-layout map panel below the last message, with each location as an emoji-icon button
- **Current location highlight** — the player's current location button uses a different color so it's instantly recognizable
- **Scene switching** — click a location → behavior fires → lore entries swap (old location disabled, new one enabled) → AI describes arriving at the new area
- **BGM crossfade** — each location has its own background music; switching uses crossfade (cross-dissolve) for a smooth transition instead of an abrupt cut
- **Four locations** — Village, Forest, Cave, Market, each with unique atmosphere descriptions and BGM

### How it works

The whole system's core is: **button triggers behavior → behavior updates variable + toggles entries + crossfades music + requests AI reply → AI describes the new scene**.

```
Player clicks the "Forest" button on the map
  → Code calls api.executeAction("go-forest")
  → Behavior fires:
    1. current_location set to "forest"
    2. Disable "Village Atmosphere" entry, enable "Forest Atmosphere" entry
    3. Crossfade to forest BGM
    4. Request AI reply with context: "The player travels from the village to the forest"
  → AI receives the new lore entry + context → describes the forest scene
  → Root Component detects current_location changed → "Forest" button becomes highlighted on the map
```

**What is crossfade?** Crossfade is an audio transition technique — the old track gradually fades out while the new track gradually fades in, with both playing simultaneously for a brief overlap. The effect is like a movie scene transition: the music never cuts out and restarts abruptly, but instead flows smoothly from one piece to the next. In Yumina, the "Play Music" behavior action supports a `crossfade` operation — you just specify the new track ID and the fade duration.

---

## Step by step

### Step 1: Create a variable

We need 1 variable to track the player's current location.

Editor → sidebar → **Variables** tab → click "Add Variable"

| Field | Value | Why |
|-------|-------|-----|
| Display Name | Current Location | For your own reference |
| ID | `current_location` | Behaviors and the Root Component read/write using this ID |
| Type | String | Because the values are text (`"village"`, `"forest"`, `"cave"`, `"market"`) |
| Default Value | `village` | New sessions start in the Village |
| Category | Custom | Dedicated category for the map system |
| Behavior Rules | `Do not modify this variable. It is controlled by the player's map UI. The current value represents the player's location.` | Tells the AI not to change the location on its own — only player map clicks can |

---

### Step 2: Create four location lore entries

Each location needs a lore entry describing its atmosphere. Only "Village" is enabled by default; the other three are disabled.

Editor → **Lore** tab → create entries one by one

#### Entry 1: Village Atmosphere

| Field | Value | Why |
|-------|-------|-----|
| Name | Village Atmosphere | For your own reference |
| Section | System Presets | Preset section entries are sent to the AI every time |
| Enabled | **Yes** (toggle on) | The game starts in the Village, so it's enabled by default |

Content:

```
[Current Location: Village]
The player is in the Village. When describing the scene, convey the following atmosphere:
- A peaceful little village with cobblestone paths winding between wooden houses
- Wisps of smoke rise from rooftops; the air carries the scent of fresh bread and stew
- Villagers chat by the well; rhythmic hammer strikes ring out from the blacksmith's shop
- Golden wheat fields stretch into the distance, swaying gently in the breeze
- The overall mood is warm, tranquil, and full of everyday life
```

#### Entry 2: Forest Atmosphere

| Field | Value | Why |
|-------|-------|-----|
| Name | Forest Atmosphere | For your own reference |
| Section | System Presets | Preset section |
| Enabled | **No** (toggle off) | Will be enabled by a behavior when the player travels here |

Content:

```
[Current Location: Forest]
The player is in the Forest. When describing the scene, convey the following atmosphere:
- Towering ancient trees block most of the sunlight; only dappled light filters through onto the moss below
- The air is damp and fresh, a mix of earth, tree resin, and wildflower scents
- Birdsong comes from every direction, punctuated by the occasional sharp crack of a snapping branch
- Bushes along the trail might conceal rabbits, deer, or something more dangerous
- The deeper you go, the denser the trees and the dimmer the light
- The overall mood is mysterious, primal, and full of the unknown
```

#### Entry 3: Cave Atmosphere

| Field | Value | Why |
|-------|-------|-----|
| Name | Cave Atmosphere | For your own reference |
| Section | System Presets | Preset section |
| Enabled | **No** (toggle off) | Will be enabled by a behavior |

Content:

```
[Current Location: Cave]
The player is in the Cave. When describing the scene, convey the following atmosphere:
- Bioluminescent fungi cling to the rock walls, casting a faint blue-green glow
- Water drips from stalactites, each drop echoing through the cavern
- The air is cold and damp, carrying a metallic scent of minerals and underground streams
- The ground underfoot is slippery and uneven; tunnels deeper in are pitch black
- Occasionally, an unidentifiable low growl or the crack of shifting rock reverberates from the depths — it may not be safe down here
- The overall mood is dark, oppressive, and laced with hidden danger
```

#### Entry 4: Market Atmosphere

| Field | Value | Why |
|-------|-------|-----|
| Name | Market Atmosphere | For your own reference |
| Section | System Presets | Preset section |
| Enabled | **No** (toggle off) | Will be enabled by a behavior |

Content:

```
[Current Location: Market]
The player is in the Market. When describing the scene, convey the following atmosphere:
- Colorful tents and stalls line up in rows, brimming with every kind of goods
- Merchants shout their wares; the sounds of haggling rise and fall on all sides
- The air is a blend of spices, roasting meat, leather, and flowers
- A magic-item shop's display window flickers with strange light; an alchemist mixes potions in a corner
- Crowds bustle through — travelers of every race and profession converge here
- The overall mood is lively, bustling, and full of commercial energy
```

> **Why is only "Village" enabled by default?** Because the game starts in the Village. If all four entries were enabled at once, the AI would receive atmosphere descriptions for the Village, Forest, Cave, and Market simultaneously and wouldn't know which scene to describe. Enabling only one at a time keeps the AI focused on the current location.

---

### Step 3: (Optional) Upload location BGM

If you want each location to have its own background music, you need to upload audio files first.

Editor → **Audio** tab → add tracks

| Track ID | Name | Type | Loop | Fade In | Fade Out |
|----------|------|------|------|---------|----------|
| `bgm_village` | Village | BGM | Yes | 2s | 2s |
| `bgm_forest` | Forest | BGM | Yes | 2s | 2s |
| `bgm_cave` | Cave | BGM | Yes | 2s | 2s |
| `bgm_market` | Market | BGM | Yes | 2s | 2s |

> **Don't have audio files?** Skip this step. The core of map navigation is lore entry switching — BGM is the cherry on top. You can always add it later.

In the BGM playlist, set `autoPlay` to `true` and default to `bgm_village`. When the player switches locations, behaviors will use the `crossfade` action to smoothly transition between tracks.

::: info How crossfade works
A plain "stop old track → play new track" leaves a jarring gap — the music cuts out, then a different piece suddenly kicks in. Crossfade works differently: the old and new tracks **overlap** for a time window. Say you set a 3-second fade duration:
- Second 0: Old track at 100% volume, new track starts playing at 0%
- Second 1.5: Old track at 50%, new track at 50%
- Second 3: Old track at 0% (stops), new track at 100%

The effect is like two colors on a palette slowly blending then separating — the transition is silky smooth, and the player barely notices the track changed; the atmosphere just naturally shifts.
:::

---

### Step 4: Create behaviors

Each location needs one behavior — when the player clicks a map button, the corresponding behavior fires and handles everything for the location switch.

Editor → **Behaviors** tab → add behaviors one by one

#### Behavior 1: Go to Village

**WHEN (trigger):**

| Field | Value | Why |
|-------|-------|-----|
| Trigger Type | Action | Fires when the Root Component code calls `executeAction("go-village")` |
| Action ID | `go-village` | Corresponds to the map button's click event |

**DO (actions):**

| # | Action Type | Settings | Purpose |
|---|-------------|----------|---------|
| 1 | Modify Variable | `current_location` set to `village` | Update the current location |
| 2 | Disable Lore Entry | Forest Atmosphere | Turn off other location entries |
| 3 | Disable Lore Entry | Cave Atmosphere | Turn off other location entries |
| 4 | Disable Lore Entry | Market Atmosphere | Turn off other location entries |
| 5 | Enable Lore Entry | Village Atmosphere | Turn on the target location's entry |
| 6 | Play Music | `bgm_village`, operation: crossfade, fade duration 3s | Crossfade to Village BGM |
| 7 | Request AI Reply | Context: `The player has returned to the Village. Describe the scene the player sees upon arriving.` | Have the AI generate an arrival description |

> **Why disable the other three first, then enable the target?** Because the player could be coming from any location. If they're going to the Village from the Forest, the Forest entry needs to be turned off; if they're coming from the Cave, the Cave entry needs to be turned off. The simplest approach is to **always turn off all other locations, then turn on the target** — this produces the correct result no matter where the player is coming from.

#### Behavior 2: Go to Forest

**WHEN:**

| Field | Value |
|-------|-------|
| Trigger Type | Action |
| Action ID | `go-forest` |

**DO:**

| # | Action Type | Settings | Purpose |
|---|-------------|----------|---------|
| 1 | Modify Variable | `current_location` set to `forest` | Update the current location |
| 2 | Disable Lore Entry | Village Atmosphere | Turn off other locations |
| 3 | Disable Lore Entry | Cave Atmosphere | Turn off other locations |
| 4 | Disable Lore Entry | Market Atmosphere | Turn off other locations |
| 5 | Enable Lore Entry | Forest Atmosphere | Turn on the target location |
| 6 | Play Music | `bgm_forest`, operation: crossfade, fade duration 3s | Crossfade BGM |
| 7 | Request AI Reply | Context: `The player has entered the Forest. Describe the scene the player sees as they step into the forest.` | AI describes the arrival scene |

#### Behavior 3: Go to Cave

**WHEN:**

| Field | Value |
|-------|-------|
| Trigger Type | Action |
| Action ID | `go-cave` |

**DO:**

| # | Action Type | Settings | Purpose |
|---|-------------|----------|---------|
| 1 | Modify Variable | `current_location` set to `cave` | Update the current location |
| 2 | Disable Lore Entry | Village Atmosphere | Turn off other locations |
| 3 | Disable Lore Entry | Forest Atmosphere | Turn off other locations |
| 4 | Disable Lore Entry | Market Atmosphere | Turn off other locations |
| 5 | Enable Lore Entry | Cave Atmosphere | Turn on the target location |
| 6 | Play Music | `bgm_cave`, operation: crossfade, fade duration 3s | Crossfade BGM |
| 7 | Request AI Reply | Context: `The player has entered the Cave. Describe the scene the player sees as they step inside.` | AI describes the arrival scene |

#### Behavior 4: Go to Market

**WHEN:**

| Field | Value |
|-------|-------|
| Trigger Type | Action |
| Action ID | `go-market` |

**DO:**

| # | Action Type | Settings | Purpose |
|---|-------------|----------|---------|
| 1 | Modify Variable | `current_location` set to `market` | Update the current location |
| 2 | Disable Lore Entry | Village Atmosphere | Turn off other locations |
| 3 | Disable Lore Entry | Forest Atmosphere | Turn off other locations |
| 4 | Disable Lore Entry | Cave Atmosphere | Turn off other locations |
| 5 | Enable Lore Entry | Market Atmosphere | Turn on the target location |
| 6 | Play Music | `bgm_market`, operation: crossfade, fade duration 3s | Crossfade BGM |
| 7 | Request AI Reply | Context: `The player has arrived at the Market. Describe the scene the player sees as they walk in.` | AI describes the arrival scene |

> **All four behaviors follow the exact same structure — only the target location differs.** Each behavior does three things: (1) update the variable → (2) swap entries + crossfade music → (3) have the AI describe the new scene. The pattern is uniform, so adding a new location later is just a matter of copying one behavior and tweaking the parameters.

::: tip Why "Request AI Reply" instead of "Tell AI"?
"Tell AI" only injects hidden text into the context — the AI won't respond immediately. It waits until the player sends the next message. "Request AI Reply" **triggers an AI reply right away**, with your text as background context for that reply. For map navigation, we want the player to see the AI describe the new scene the instant they click a button, not have to send another message first. That's why "Request AI Reply" is the better fit here.
:::

---

### Step 5: Add the map panel to the Root Component

This is the step that makes the map UI appear in the chat interface. We use styled div buttons with emoji icons to create a simple "map" — no image assets needed.

Editor → **Custom UI** section → open `index.tsx` → paste the following (replace the default `return <Chat />`):

```tsx
export default function MyWorld() {
  const api = useYumina();

  // ---- Read variable ----
  const currentLocation = String(api.variables.current_location || "village");

  // ---- Location configs ----
  const locations = [
    { id: "village", label: "Village", icon: "🏘️", action: "go-village",
      color: "#92400e", bg: "#fef3c7", border: "#f59e0b",
      activeBg: "#f59e0b", activeColor: "#ffffff" },
    { id: "forest",  label: "Forest", icon: "🌲", action: "go-forest",
      color: "#166534", bg: "#dcfce7", border: "#22c55e",
      activeBg: "#22c55e", activeColor: "#ffffff" },
    { id: "cave",    label: "Cave", icon: "🕳️", action: "go-cave",
      color: "#3b0764", bg: "#f3e8ff", border: "#a855f7",
      activeBg: "#a855f7", activeColor: "#ffffff" },
    { id: "market",  label: "Market", icon: "🏪", action: "go-market",
      color: "#9a3412", bg: "#ffedd5", border: "#f97316",
      activeBg: "#f97316", activeColor: "#ffffff" },
  ];

  // ---- Message list, used to find the last one ----
  const msgs = api.messages || [];

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

      {/* Map panel — only on the last message */}
      {isLastMsg && (
        <div style={{
          marginTop: "16px",
          padding: "16px",
          background: "rgba(15,23,42,0.6)",
          borderRadius: "12px",
          border: "1px solid #334155",
        }}>
          {/* Title */}
          <div style={{
            fontSize: "13px",
            color: "#94a3b8",
            marginBottom: "12px",
            fontWeight: "600",
            letterSpacing: "0.05em",
          }}>
            WORLD MAP
          </div>

          {/* 2x2 grid layout */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "10px",
          }}>
            {locations.map((loc) => {
              const isActive = currentLocation === loc.id;
              return (
                <button
                  key={loc.id}
                  onClick={() => {
                    if (!isActive) {
                      api.executeAction(loc.action);
                    }
                  }}
                  style={{
                    padding: "14px 10px",
                    background: isActive
                      ? loc.activeBg
                      : loc.bg,
                    border: `2px solid ${isActive ? loc.activeBg : loc.border}`,
                    borderRadius: "10px",
                    color: isActive ? loc.activeColor : loc.color,
                    fontSize: "14px",
                    fontWeight: "700",
                    cursor: isActive ? "default" : "pointer",
                    opacity: isActive ? 1 : 0.85,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: "6px",
                    transition: "all 0.2s ease",
                  }}
                >
                  <span style={{ fontSize: "28px" }}>{loc.icon}</span>
                  <span>{loc.label}</span>
                  {isActive && (
                    <span style={{
                      fontSize: "11px",
                      opacity: 0.9,
                      fontWeight: "500",
                    }}>
                      You are here
                    </span>
                  )}
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

**Line-by-line breakdown:**

- `api.variables.current_location` — reads the current location variable's value
- `locations` — a config array defining each location's ID, English label, emoji icon, behavior action ID, and colors for normal and highlighted states. To add a new location, just append an entry to the array
- `isLastMsg` — the map only shows on the last message, not on every single one
- `isActive` — checks whether this button matches the current location. If so, the button uses the highlighted color and shows "You are here"
- `!isActive` is checked before calling `executeAction` — prevents the player from repeatedly clicking the current location. You're already in the Village; clicking Village again does nothing
- `gridTemplateColumns: "1fr 1fr"` — a two-column equal-width grid layout, four buttons arranged in a 2x2 grid
- `transition: "all 0.2s ease"` — subtle animation on hover

::: tip Want a different layout?
Change `gridTemplateColumns` to `"1fr 1fr 1fr"` for three columns, or `"1fr"` for a single-column vertical stack. `gap` controls spacing between buttons. Layout is entirely controlled by CSS Grid — tweak it however you like.
:::

---

### Step 6: Save and test

1. Click **Save** at the top of the editor
2. Click **Start Game** or go back to the home page and start a new session
3. You'll see a map panel below the AI's message with four location buttons. The "Village" button is highlighted, showing "You are here"
4. Click **Forest** — the AI immediately responds with a passage describing the forest scene, and the "Forest" button becomes highlighted on the map
5. If you configured BGM, you should hear the music crossfade from the village track to the forest track
6. Click **Cave** — the scene switches again, the AI describes the cave, BGM crossfades
7. Try clicking the currently highlighted location — nothing happens (you're already there)
8. Chat normally with the AI, then switch locations — everything works; the map stays at the bottom of the last message

**If something goes wrong:**

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Can't see the map panel | Root Component code wasn't saved or has a syntax error | Check the compile status at the bottom of the Custom UI panel — it should show green "OK" |
| Clicking a button does nothing | Behavior action ID doesn't match | Confirm the behavior action IDs (`go-village`, etc.) exactly match the `action` field in the `locations` array in the code |
| AI doesn't reply with a new scene | Behavior is missing the "Request AI Reply" action | Check that the last action in each behavior is "Request AI Reply" |
| Map highlight doesn't change | Variable isn't being updated | Check that the first action in each behavior is "Modify Variable" targeting `current_location` |
| BGM doesn't switch | Track ID mismatch or audio not uploaded | Confirm the track IDs in the behavior match the track IDs in the Audio tab |
| BGM transition sounds jarring | Not using crossfade | Confirm the "Play Music" action's operation is set to `crossfade` with a fade duration of at least 2-3 seconds |
| All four entries are enabled at once | Behavior forgot to disable other entries | Each behavior must disable the other three location entries before enabling the target location's entry |

---

## Expansion ideas

### Adding more locations

Want to add a fifth location (say, "Harbor")? Four things to do:

1. **Lore** tab → create a "Harbor Atmosphere" entry (disabled by default)
2. **Audio** tab → create a `bgm_harbor` track (optional)
3. **Behaviors** tab → create a "Go to Harbor" behavior with action ID `go-harbor`, same action pattern as the other four. Also go back to each of the existing four behaviors and add a "Disable Lore Entry: Harbor Atmosphere" action
4. **Root Component** → add an entry to the `locations` array:

```tsx
{ id: "harbor", label: "Harbor", icon: "⚓", action: "go-harbor",
  color: "#1e40af", bg: "#dbeafe", border: "#3b82f6",
  activeBg: "#3b82f6", activeColor: "#ffffff" },
```

The grid layout adapts automatically — 5 buttons will arrange as 2 in the first row, 2 in the second, 1 in the third.

### Restricting travel routes

If you don't want the player to jump freely between any two locations (e.g., "you must pass through the Forest to reach the Cave"), add route logic to the Root Component:

```tsx
// Define reachable routes
const routes = {
  village: ["forest", "market"],       // Village can reach Forest and Market
  forest:  ["village", "cave"],        // Forest can reach Village and Cave
  cave:    ["forest"],                 // Cave can only go back to Forest
  market:  ["village"],                // Market can only go back to Village
};

const reachable = routes[currentLocation] || [];

// Add checks to the button's onClick and style
const canGo = reachable.includes(loc.id);
// ...
onClick={() => {
  if (!isActive && canGo) {
    api.executeAction(loc.action);
  }
}}
style={{
  // ...
  opacity: isActive ? 1 : canGo ? 0.85 : 0.3,
  cursor: isActive ? "default" : canGo ? "pointer" : "not-allowed",
}}
```

Unreachable locations appear faded and unclickable — the player can tell at a glance that "I can't go there right now."

---

## Quick reference

| What you want | How to do it |
|---------------|-------------|
| Track the player's current location | String variable `current_location` with location IDs as values |
| Switch scenes on button click | Behavior trigger set to "Action", action ID matches `executeAction()` in the Root Component |
| Swap location atmosphere | Behavior actions: "Disable Lore Entry" to turn off the old location, "Enable Lore Entry" to turn on the new one |
| Smooth BGM transition | Behavior action "Play Music" with operation set to `crossfade`, fade duration 2-3 seconds |
| AI describes the new scene immediately on click | Behavior action "Request AI Reply" with arrival context |
| Highlight the current location | Compare `current_location` to button ID inside the Root Component; matching button gets highlighted style |
| Prevent re-clicking the current location | `if (!isActive)` check before calling `executeAction` |
| Show the map only on the last message | Check `msg.messageIndex === msgs.length - 1` inside `<Chat renderBubble>` |

---

## Try it yourself — importable demo world

Download this JSON and import it as a new world to see everything in action:

<a href="/recipe-12-demo.json" download>recipe-12-demo.json</a>

**How to import:**
1. Go to Yumina → **My Worlds** → **Create New World**
2. In the editor, click **More Actions** → **Import Package**
3. Select the downloaded `.json` file
4. A new world is created with all variables, entries, behaviors, and the Root Component pre-configured
5. Start a new session and try it out

**What's included:**
- 1 variable (`current_location` tracking the current location)
- 4 lore entries (Village / Forest / Cave / Market atmosphere — only Village enabled by default)
- 4 behaviors (Go to Village / Go to Forest / Go to Cave / Go to Market — each swaps entries + crossfades music + requests AI description)
- A Root Component (2x2 grid map panel with current-location highlighting)
- 4 BGM tracks (you'll need to upload your own audio files to replace the placeholder URLs)

---

::: tip This is Recipe #12
This recipe showcases the classic behaviors + Root Component combo — buttons trigger behaviors, and each behavior simultaneously updates a variable, swaps lore entries, crossfades BGM, and requests an AI reply. The same pattern works for floor navigation, room exploration, world portals, or anything else that involves "moving between multiple scenes."
:::

</div>
