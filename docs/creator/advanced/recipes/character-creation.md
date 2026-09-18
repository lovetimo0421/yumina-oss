<div v-pre>

# Character Creation Form

> The player opens a session and sees a character creation screen — type a name, pick a class, write a backstory, click "Start Adventure", and the chat jumps to the real story opening. From the very first AI reply onward, the AI knows everything about the player's character.

---

## What you'll build

The first message isn't a story — it's a **character creation form**. The form is rendered by the Root Component and includes:

- A text input — for the player to type their character's name
- Three class selection buttons — Warrior / Mage / Rogue
- A text area — for the player to write a backstory
- A "Start Adventure" button — clicking it saves all the information into variables, then jumps to the real story opening

After the jump, the `{{player_name}}`, `{{player_class}}`, and `{{player_backstory}}` macros in your lore entries get replaced by the engine automatically with whatever the player filled in. By the time the AI writes its first reply, it already has the complete character profile.

### Prerequisites

This recipe builds directly on two core techniques from **Recipe #1**:

| Technique | Source | How this recipe uses it |
|-----------|--------|------------------------|
| `switchGreeting(index)` to jump between openings | Recipe #1 Part 1 | After the player fills out the form, jump from the "creation screen" to the "story opening" |
| `{{variableId}}` macro replacement in entry content | Recipe #1 Part 2 | Macros like `{{player_name}}` in entries get replaced with the player's input at prompt-build time |

If you haven't read Recipe #1 yet, start there first: [Scene Jumping & Entry Switching via UI](./scene-jumping.md).

### How it works

Full sequence:

```
1. Player starts a new session → sees greeting #1 (the character creation form)
2. Root Component's `<Chat renderBubble>` detects `msg.messageIndex === 0`, renders the form UI
3. Player types a name, picks a class, writes a backstory
4. Player clicks "Start Adventure"
   → code calls api.setVariable("player_name", "Elara")
   → code calls api.setVariable("player_class", "Mage")
   → code calls api.setVariable("player_backstory", "Grew up in a wizard's tower...")
   → code calls api.switchGreeting(1)
   → first message instantly switches to greeting #2 (the real story opening)
5. Player sends their first message
   → engine builds prompt → scans entries for {{...}} macros
   → {{player_name}} replaced with "Elara"
   → {{player_class}} replaced with "Mage"
   → {{player_backstory}} replaced with "Grew up in a wizard's tower..."
   → AI receives the complete character profile → writes its first reply
```

**Key point:** `setVariable` takes effect immediately, but the AI only sees the change the next time the prompt is built. So the order is: `setVariable` to store values first → then `switchGreeting` to jump → player sends a message → the AI can use the character info in its reply.

---

## Step by step

### Step 1: Create the variables

You need three string variables to store the player's character info.

Editor → sidebar → **Variables** tab → click "Add Variable", and create these three:

**Variable 1: Character Name**

| Field | Value | Why |
|-------|-------|-----|
| Display Name | Character Name | For your own reference in the editor |
| ID | `player_name` | The `{{player_name}}` macro in entries looks up this ID |
| Type | String | Because a name is text |
| Default Value | `Traveler` | If the player starts without filling in a name, the AI calls them "Traveler" |
| Category | Custom | Organizational label, purely for management |
| Behavior Rules | `Do not modify this variable. It is set by the player via the character creation form.` | Tells the AI not to change the character's name on its own |

**Variable 2: Character Class**

| Field | Value | Why |
|-------|-------|-----|
| Display Name | Character Class | For your own reference |
| ID | `player_class` | The `{{player_class}}` macro in entries looks up this ID |
| Type | String | Because the class is text ("Warrior", "Mage", "Rogue") |
| Default Value | *leave empty* | Empty means not yet chosen. The Root Component checks this value to decide which button to highlight |
| Category | Custom | Organizational label |
| Behavior Rules | `Do not modify this variable. It is set by the player via the character creation form.` | Tells the AI not to change the class on its own |

**Variable 3: Character Backstory**

| Field | Value | Why |
|-------|-------|-----|
| Display Name | Character Backstory | For your own reference |
| ID | `player_backstory` | The `{{player_backstory}}` macro in entries looks up this ID |
| Type | String | Because a backstory is text |
| Default Value | *leave empty* | Empty = the player didn't write a backstory. The corresponding spot in the entry will be an empty string |
| Category | Custom | Organizational label |
| Behavior Rules | `Do not modify this variable. It is set by the player via the character creation form.` | Tells the AI not to change the backstory on its own |

> **Why does `player_name` have a default value but the other two don't?** Because a name is needed in almost every scenario — the AI has to call the character *something*. A fallback value of "Traveler" prevents the AI from writing an awkward blank or "unnamed character" in its replies. Class and backstory can be empty — the AI can reasonably ignore them or improvise.

---

### Step 2: Create two greetings in "First Message"

Open the editor and click the **First Message** tab in the sidebar.

**Create the first greeting (character creation screen):**

Click the "Create First Message" button. In the text box, write:

```
*A warm glow envelops you. You feel yourself taking shape — but your identity is not yet defined.*

*An ancient voice echoes through the void:*

"Welcome, traveler. Before you step into this world, tell me — who are you?"
```

> This text is atmospheric decoration — the actual form UI is rendered by the Root Component below this text. What the player sees is: a mood-setting passage up top, and an interactive character creation form underneath.

**Create the second greeting (the real story opening):**

Click the "Add Greeting" button at the bottom. Switch to tab **2** and write the actual story opening:

```
*{{player_name}} pushes open the gate of destiny.*

*You are a {{player_class}}, and this is your first time setting foot in the Elderlands. The silhouette of a distant city shimmers in the dawn light, and a cobblestone road stretches toward the unknown.*

*A breeze brushes your face, carrying the scent of grass and distant hearth-smoke. You take a deep breath — the adventure begins now.*

Three paths lie before you: a wide road leading to town, a narrow trail through the woods, and a slope descending to the river. Which way do you go?
```

::: info Macros work in greetings too
Notice the `{{player_name}}` and `{{player_class}}` in the second greeting. These macros are replaced with the variable's current value **at display time**. So after the player fills out the form and the variables are updated by `setVariable`, when `switchGreeting(1)` switches to this greeting, the player sees their own character name and class in the story opening.
:::

::: warning Greeting order = index
Tab 1 = index 0 (the character creation screen, shown by default), Tab 2 = index 1 (the story opening). The `switchGreeting(1)` call in the Root Component jumps to the second one.
:::

---

### Step 3: Create a lore entry that uses macros

Now create an entry that injects the character info into every prompt sent to the AI.

Editor → **Entries** tab → create a new entry

| Field | Value | Why |
|-------|-------|-----|
| Name | Player Character Profile | For your own reference |
| Section | System Presets | Entries in the presets section are always sent to the AI |
| Enabled | **Yes** (toggle on) | Always active — character info is something the AI needs at all times |

Content:

```
[Player Character Profile]
Name: {{player_name}}
Class: {{player_class}}
Backstory: {{player_backstory}}

Always address the player by their character's name. Adjust interactions, available skills, and encounters based on their class and backstory.
```

**What happens?**

When the engine builds the prompt, it scans this text:
- `{{player_name}}` → replaced with the current value of variable `player_name` (e.g., "Elara")
- `{{player_class}}` → replaced with the current value of variable `player_class` (e.g., "Mage")
- `{{player_backstory}}` → replaced with the current value of variable `player_backstory` (e.g., "Grew up in a wizard's tower")

If a variable is an empty string, the corresponding spot is blank. For example, if the player didn't write a backstory, the AI sees "Backstory:" followed by nothing — the AI will typically ignore the empty field or improvise.

---

### Step 4: Build the character creation form in the Root Component

This is the core step — rendering an interactive character creation form inside the chat.

Editor → **Custom UI** section → open `index.tsx` → paste this code (replacing the default `return <Chat />`):

```tsx
export default function MyWorld() {
  const api = useYumina();

  // ---- Form state ----
  const [name, setName] = React.useState(
    String(api.variables.player_name || "")
  );
  const [selectedClass, setSelectedClass] = React.useState(
    String(api.variables.player_class || "")
  );
  const [backstory, setBackstory] = React.useState(
    String(api.variables.player_backstory || "")
  );

  // Check whether character creation is already done (class is set = form was submitted)
  const hasCreated = String(api.variables.player_class || "") !== "";

  // Class list
  const classes = [
    { id: "Warrior", label: "Warrior", icon: "⚔️", desc: "Melee specialist, high HP" },
    { id: "Mage", label: "Mage", icon: "🔮", desc: "Ranged magic, high MP" },
    { id: "Rogue", label: "Rogue", icon: "🗡️", desc: "Agile and stealthy, high crit" },
  ];

  // Handle "Start Adventure"
  const handleStart = () => {
    if (!selectedClass) return; // Must pick a class first
    api.setVariable("player_name", name.trim() || "Traveler");
    api.setVariable("player_class", selectedClass);
    api.setVariable("player_backstory", backstory.trim());
    api.switchGreeting?.(1); // Jump to greeting #2 (story opening)
  };

  return (
    <Chat renderBubble={(msg) => (
    <div>
      {/* Render message text (platform already rendered HTML, use msg.contentHtml directly) */}
      <div
        style={{ color: "#e2e8f0", lineHeight: 1.7 }}
        dangerouslySetInnerHTML={{ __html: msg.contentHtml }}
      />

      {/* Character creation form — only on first message & not yet created */}
      {msg.messageIndex === 0 && !hasCreated && (
        <div
          style={{
            marginTop: "20px",
            padding: "24px",
            background: "linear-gradient(135deg, #1e1b4b 0%, #1a1a2e 100%)",
            borderRadius: "16px",
            border: "1px solid #312e81",
          }}
        >
          {/* Title */}
          <div
            style={{
              fontSize: "18px",
              fontWeight: "bold",
              color: "#c4b5fd",
              marginBottom: "20px",
              textAlign: "center",
            }}
          >
            Create Your Character
          </div>

          {/* Name input */}
          <div style={{ marginBottom: "16px" }}>
            <div
              style={{
                fontSize: "13px",
                color: "#a5b4fc",
                marginBottom: "6px",
                fontWeight: "600",
              }}
            >
              Character Name
            </div>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter your name (leave blank for 'Traveler')"
              style={{
                width: "100%",
                padding: "10px 14px",
                background: "#0f172a",
                border: "1px solid #334155",
                borderRadius: "8px",
                color: "#e2e8f0",
                fontSize: "14px",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>

          {/* Class selection */}
          <div style={{ marginBottom: "16px" }}>
            <div
              style={{
                fontSize: "13px",
                color: "#a5b4fc",
                marginBottom: "8px",
                fontWeight: "600",
              }}
            >
              Choose a Class
            </div>
            <div style={{ display: "flex", gap: "10px" }}>
              {classes.map((cls) => (
                <button
                  key={cls.id}
                  onClick={() => setSelectedClass(cls.id)}
                  style={{
                    flex: 1,
                    padding: "14px 10px",
                    background:
                      selectedClass === cls.id
                        ? "linear-gradient(135deg, #4338ca, #6366f1)"
                        : "#1e293b",
                    border:
                      selectedClass === cls.id
                        ? "2px solid #818cf8"
                        : "1px solid #334155",
                    borderRadius: "10px",
                    color:
                      selectedClass === cls.id ? "#e0e7ff" : "#94a3b8",
                    cursor: "pointer",
                    textAlign: "center",
                    transition: "all 0.2s",
                  }}
                >
                  <div style={{ fontSize: "24px", marginBottom: "4px" }}>
                    {cls.icon}
                  </div>
                  <div
                    style={{
                      fontSize: "14px",
                      fontWeight: "bold",
                      marginBottom: "2px",
                    }}
                  >
                    {cls.label}
                  </div>
                  <div style={{ fontSize: "11px", opacity: 0.7 }}>
                    {cls.desc}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Backstory */}
          <div style={{ marginBottom: "20px" }}>
            <div
              style={{
                fontSize: "13px",
                color: "#a5b4fc",
                marginBottom: "6px",
                fontWeight: "600",
              }}
            >
              Backstory (optional)
            </div>
            <textarea
              value={backstory}
              onChange={(e) => setBackstory(e.target.value)}
              placeholder="A few sentences about your character's history..."
              rows={3}
              style={{
                width: "100%",
                padding: "10px 14px",
                background: "#0f172a",
                border: "1px solid #334155",
                borderRadius: "8px",
                color: "#e2e8f0",
                fontSize: "14px",
                outline: "none",
                resize: "vertical",
                boxSizing: "border-box",
                fontFamily: "inherit",
              }}
            />
          </div>

          {/* Start Adventure button */}
          <button
            onClick={handleStart}
            disabled={!selectedClass}
            style={{
              width: "100%",
              padding: "14px",
              background: selectedClass
                ? "linear-gradient(135deg, #7c3aed, #a855f7)"
                : "#374151",
              border: "none",
              borderRadius: "10px",
              color: selectedClass ? "#f5f3ff" : "#6b7280",
              fontSize: "16px",
              fontWeight: "bold",
              cursor: selectedClass ? "pointer" : "not-allowed",
              transition: "all 0.2s",
            }}
          >
            {selectedClass ? "Start Adventure" : "Pick a class first"}
          </button>
        </div>
      )}
    </div>
    )} />
  );
}
```

---

### Code walkthrough

**State management:**

- `const api = useYumina()` — get the Yumina API for reading/writing variables and switching greetings
- `name` / `selectedClass` / `backstory` — three React states tracking the input field, class buttons, and text area
- `React.useState(String(api.variables.player_name || ""))` — initial values are read from variables. In a new session, these are the defaults; in an existing session, they restore from saved variables
- `hasCreated` — checks whether `player_class` is an empty string. Empty = character not yet created; non-empty = already created, hide the form

**Form UI:**

- `msg.messageIndex === 0 && !hasCreated` — only show the form on the first message and only before the character is created (`msg` is passed in by `<Chat renderBubble>`)
- `classes.map(...)` — iterates over the class list, rendering a button for each. The selected class gets a highlighted border and gradient background
- `selectedClass === cls.id` — checks if this is the currently selected class, used for highlighting
- `disabled={!selectedClass}` — the button is grayed out and unclickable until a class is selected

**Submit logic (`handleStart`):**

- `api.setVariable("player_name", name.trim() || "Traveler")` — stores the name. If the player left it blank, falls back to "Traveler"
- `api.setVariable("player_class", selectedClass)` — stores the class
- `api.setVariable("player_backstory", backstory.trim())` — stores the backstory
- `api.switchGreeting?.(1)` — jumps to greeting #2. The `?.` optional chain prevents errors if the API is unavailable

**Why this call order?**

```
setVariable x 3  →  switchGreeting(1)
    ↑                    ↑
  store data first    then jump
```

You must call `setVariable` before `switchGreeting`. The greeting's `{{player_name}}` and `{{player_class}}` macros are replaced immediately on display — if you jump first and store later, the macros will still hold the old values (empty string or default).

---

### Step 5: Save and test

1. Click **Save** at the top of the editor
2. Click **Start Game** or go back to the home page and start a new session
3. You see the first greeting's atmospheric text with the character creation form below it
4. Type "Elara" in the name field
5. Click the **Mage** button — it highlights, and the bottom button changes to "Start Adventure"
6. Type "Grew up in a wizard's tower and stumbled upon a portal to another world" in the backstory box
7. Click **Start Adventure**
8. The first message **instantly** switches to: "*Elara pushes open the gate of destiny. You are a Mage...*" — the form disappears
9. Send a message (e.g., "I head toward the town") — the AI's reply addresses you as "Elara" and writes interactions based on the Mage class

**Verify that the AI actually got the character info:**

After sending a message, check whether the AI's reply:
- Uses your character name ("Elara" instead of "you" or "Traveler")
- Mentions class-relevant details (Mage = magic, staves, spells, etc.)
- If you wrote a backstory, the AI may reference it ("You recall your days in the wizard's tower...")

If the AI isn't using this information, check the troubleshooting table below.

---

### Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Can't see the character creation form | Root Component code wasn't saved or has a syntax error | Check the compile status at the bottom of the Custom UI section — it should show a green "OK" |
| Clicking "Start Adventure" does nothing | No class was selected | The button is grayed out (`disabled`) when no class is picked — click a class first |
| Clicked the button but greeting didn't switch | Only one greeting exists | Confirm the **First Message** tab has 2 greetings (tab 1 and tab 2) |
| Greeting switched but you see `{{player_name}}` as raw text | Macros aren't being replaced | Check that the variable ID is spelled correctly (`player_name`, not `playerName`) |
| AI reply doesn't use the character name | Entry isn't active | Check that the lore entry is enabled and its content includes `{{player_name}}` |
| AI reply uses the default "Traveler" | `setVariable` was called after `switchGreeting` | Confirm the code calls `setVariable` before `switchGreeting` |
| Form still shows after character was created | `hasCreated` check is wrong | Confirm `player_class` has an empty string as its default value (not some non-empty value) |

---

## Going further: extending character creation

### Adding more classes

Just add new elements to the `classes` array:

```tsx
const classes = [
  { id: "Warrior", label: "Warrior", icon: "⚔️", desc: "Melee specialist, high HP" },
  { id: "Mage", label: "Mage", icon: "🔮", desc: "Ranged magic, high MP" },
  { id: "Rogue", label: "Rogue", icon: "🗡️", desc: "Agile and stealthy, high crit" },
  { id: "Cleric", label: "Cleric", icon: "✨", desc: "Healing and blessings, great support" },
  { id: "Ranger", label: "Ranger", icon: "🏹", desc: "Ranged attacks, expert tracker" },
];
```

No other code changes needed — the buttons appear automatically, and `selectedClass` will be the new class's `id` when selected.

### Combining with behavior rules

Just like in Recipe #1, you can automatically enable/disable different lore entries based on class. For example:

1. Create "Warrior Lore", "Mage Lore", and "Rogue Lore" entries in the knowledge base, **disabled by default**
2. In the Behaviors tab, create three behaviors that enable the corresponding entry when `player_class` matches
3. Add a call like `api.executeAction("choose-class-warrior")` inside `handleStart`

This way each class doesn't just get a different label — it gets entirely different world-building and AI behavior.

### Showing character info in subsequent messages

You can add a "character info bar" to the Root Component's `<Chat renderBubble>` that displays the character name and class at the top of every message:

```tsx
{/* In the return, above the message content */}
{hasCreated && (
  <div style={{
    display: "flex",
    gap: "8px",
    marginBottom: "8px",
    fontSize: "12px",
    color: "#a5b4fc",
  }}>
    <span>{String(api.variables.player_name)}</span>
    <span style={{ opacity: 0.5 }}>|</span>
    <span>{String(api.variables.player_class)}</span>
  </div>
)}
```

---

## Quick reference

| What you want | How to do it |
|---------------|-------------|
| Store player-entered text | Create a string variable + `api.setVariable("id", value)` |
| Build selection buttons | Track selection in React state + `setSelectedClass(id)` on click |
| Jump to a different opening after form submit | Call `setVariable` for all values first, then `switchGreeting(index)` |
| Let the AI know the character info | Use `{{variableId}}` macros in entry content — the engine replaces them at prompt-build time |
| Show the form only once | Check a variable for `hasCreated` — form disappears after creation |
| Disable a button until a condition is met | `disabled={!condition}` + matching grayed-out styles |
| Show character info in greetings too | Write `{{player_name}}` and other macros directly in greeting text |

---

## Try it yourself — importable demo world

Download this JSON and import it as a new world to see everything in action:

<a href="/recipe-4-demo.json" download>recipe-4-demo.json</a>

**How to import:**
1. Go to Yumina → **My Worlds** → **Create New World**
2. In the editor, click **More Actions** → **Import Package**
3. Select the downloaded `.json` file
4. A new world is created with all greetings, variables, and Root Component pre-configured
5. Start a new session and try it out

**What's included:**
- 2 greetings (character creation form + story opening)
- 3 variables (`player_name` for name, `player_class` for class, `player_backstory` for backstory)
- 1 lore entry (character profile using `{{player_name}}`, `{{player_class}}`, `{{player_backstory}}` macros)
- A complete Root Component (character creation form UI)

---

::: tip This is Recipe #4
Recipe #1 taught button-based greeting switching and macro replacement. This recipe combines them into a full character creation flow. Future recipes will keep building on this foundation — attribute point allocation, equipment selection, multi-step onboarding, and more.
:::

</div>
