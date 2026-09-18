<div v-pre>

# Scene Jumping & Entry Switching via UI

> Click a button → jump to a different pre-written opening. Type in a text box → change what an entry says to the AI. This recipe shows you both.

---

## Part 1: Switch between openings with a button

### What you'll build

A world with multiple pre-written opening scenes. The player sees the "main" opening first, with clickable buttons. When they click one, the first message in chat **instantly** switches to another pre-written opening — no AI generation, just the text you wrote.

### How it works

In Yumina, you can create multiple greetings in the editor's **First Message** tab. When a player starts a new session, all greetings get packed as **swipes** (left/right to switch) on the first message. Players can already swipe manually — but what we want is: **let the player jump to a specific greeting with a single button click**.

That's what the `switchGreeting(index)` API is for — it lets custom components jump directly to the Nth greeting via code.

```
Player clicks "Enter the Dark Cave"
  → code calls api.switchGreeting(1)
  → First message switches to greeting #2 (index starts at 0, so 1 = the second one)
  → Player instantly sees your pre-written dark cave opening
```

### Step by step

#### Step 1: Create multiple greetings in the First Message tab

Open the editor and click the **First Message** tab in the left sidebar.

This tab is specifically for managing openings. You can create multiple greetings — each one becomes a swipe.

**Create the first greeting (main opening — presents the route choice):**

Click "Create First Message". Write the main opening in the text box. This is what the player sees first when they open the session — describe the scene and guide them toward a choice:

```
*You wake up in a mysterious forest. Morning mist swirls between ancient trees.*

Two paths diverge before you:

**To the left** — a narrow trail into darkness. Cold air and distant echoes.

**To the right** — a sun-dappled path with wildflowers and birdsong.

Which way will you go?
```

> Why only describe the scene instead of asking the AI to respond? Because the greeting is **fixed text you pre-wrote**, not AI-generated. You have precise control over every word the player sees.

**Create the second greeting (dark cave opening):**

Click "Add Greeting" at the bottom. You'll see numbered tabs **1** and **2** appear. Click **2** to switch to the second greeting's edit box. Write the dark cave route opening:

```
*You step onto the left path. The canopy thickens overhead, swallowing the light. Within minutes, the trail narrows to a crack in a rock face — the entrance to a cave.*

*Cold air rushes out, carrying the smell of damp stone and something metallic. Faint blue-green light flickers deep inside — bioluminescent fungi clinging to the walls.*

*You take a breath and step in. Behind you, the last sliver of daylight shrinks to a pale line, then vanishes.*

You are alone in the dark.
```

> This text only shows after the player clicks "Enter the Dark Cave". Before that, the player sees the first greeting (the main opening).

**Create the third greeting (sunlit meadow opening):**

Click "Add Greeting" again. Switch to tab **3** and write the sunlit meadow route opening:

```
*You choose the right path. The trees thin out, and warm sunlight floods through the canopy. Within minutes, the forest opens into a vast meadow stretching to the horizon.*

*Wildflowers in every color sway gently in the breeze. A stream glitters in the distance. Somewhere nearby, a bird sings a melody you've never heard before.*

*You feel the tension in your shoulders melt away. Whatever this place is, it feels safe.*

Welcome to the Everbloom Meadow.
```

::: info Greeting order is the index
The order of numbered tabs at the bottom is the `index` parameter for `switchGreeting()`. Tab 1 = index 0 (shown by default), tab 2 = index 1, tab 3 = index 2. You'll use this index when writing button code later.
:::

Now you have 3 greetings. After saving the world, a new session will default to showing the first one (the main opening). Next we'll make buttons to let the player click through to the second or third.

---

#### Step 2: Create a route-tracking variable

We need a variable to record "which route did the player choose". This variable has two uses:
- **Make the buttons disappear after choosing** (the TSX code checks this variable — if it's not `"none"`, don't show the buttons)
- **Let later conversation know the current route** (behavior rules can switch lore entries based on this variable)

Editor → left sidebar → **Variables** tab → click "Add Variable"

| Field | What to fill in | Why |
|-------|-----------------|-----|
| Display Name | Current Route | For your own reference |
| ID | `current_route` | Code reads/writes the variable using this ID |
| Type | String | Because the value is text (`"none"`, `"dark"`, `"light"`) |
| Default Value | `none` | Means "not yet chosen". Button code checks this value |
| Category | Tag | Just a category label, makes it easier to find in the variable list |
| Behavior Rules | `Do not modify this variable. It is controlled by the player's UI choice.` | Tells the AI not to modify this variable — only the button can |

> The **Behavior Rules** field is an instruction for the AI. If you don't write it, the AI may decide on its own to change this variable's value in its reply (e.g., the AI thinks "the player walked into the cave" and sets `current_route` to `"dark"` itself). Once you write the rule, the AI won't touch it.

---

#### Step 3: (Optional) Create lore entries and behavior rules

If you want the AI's later replies to reference different worldbuilding after the route is chosen, do this step. If you only want to switch the opening text without later world changes, you can skip it.

**Create two lore entries (disabled by default):**

Editor → **Entries** tab → create a new entry

**Dark cave lore entry:**

| Field | What to fill in | Why |
|-------|-----------------|-----|
| Name | Dark Cave Lore | For your own reference |
| Section | System Presets | Entries in the presets section are sent to the AI every time |
| Enabled | **No** (toggle off) | Disabled by default — after the player picks the dark route, a behavior rule will enable it |

Content:

```
[World Setting: Shadowmaw Cave]
The player is exploring Shadowmaw Cave. Key details:
- Ancient dwarven ruins, abandoned for centuries
- Bioluminescent fungi provide faint blue-green light
- Strange creatures lurk in the deeper tunnels
- Temperature drops the further in you go

Maintain a tense horror-survival atmosphere. Describe echoing sounds, flickering shadows, water dripping, and the oppressive weight of stone overhead.
```

**Sunlit meadow lore entry:** Create another entry, also **disabled by default**, with content describing the meadow's setting and atmosphere.

> **Why disabled by default?** Because before the player chooses a route, neither worldbuilding should influence the AI. Only after the player picks does the behavior rule enable the matching one and disable the other.

**Create two behavior rules:**

Editor → **Behaviors** tab → Add Behavior

**Behavior 1: "Choose Dark Route"**

| Field | What to fill in | Why |
|-------|-----------------|-----|
| Name | Choose Dark Route | For your own reference |
| Trigger | Select "Action" → Action ID `choose-dark` | Fires when TSX code calls `executeAction("choose-dark")` |

Then under "Execute Actions", add in order:

| Action type | Settings | Effect |
|-------------|----------|--------|
| Modify variable | `current_route` set to `dark` | Records that the player chose the dark route |
| Enable entry | Dark Cave Lore | Turns on the dark cave setting |
| Disable entry | Sunlit Meadow Lore | Turns off the meadow setting (prevents both being active) |

**Behavior 2: "Choose Light Route"** — create the same way. The action ID is `choose-light`, and the actions are reversed (enable the meadow lore, disable the cave lore).

> **Why not just `setVariable` in the TSX code?** Because `setVariable` can only change variables — it can't toggle entries on/off. The behavior's "Enable Entry" / "Disable Entry" actions are what enable/disable entries at runtime. So when a button is clicked, we do three things at once: `setVariable` (change the variable) + `executeAction` (fire the behavior to toggle entries) + `switchGreeting` (switch the opening).

---

#### Step 4: Add route-selection buttons in the Root Component

This is the key step that makes buttons appear in the chat interface.

Editor → **Custom UI** section → open `index.tsx` → paste the following code (replacing the default):

```tsx
export default function MyWorld() {
  const api = useYumina();
  const hasChosen = api.variables.current_route !== "none";

  return (
    <Chat renderBubble={(msg) => (
      <div>
        {/* Render the message text normally */}
        <div
          style={{ color: "#e2e8f0", lineHeight: 1.7 }}
          dangerouslySetInnerHTML={{ __html: msg.contentHtml }}
        />

        {/* Route selection buttons */}
        {/* msg.messageIndex === 0 means only show on the first message */}
        {/* !hasChosen means hide once a choice has been made */}
        {msg.messageIndex === 0 && !hasChosen && (
          <div style={{
            display: "flex",
            gap: "12px",
            marginTop: "16px",
          }}>
            <button
              onClick={() => {
                api.setVariable("current_route", "dark");   // Record the choice, making the buttons disappear
                api.executeAction("choose-dark");            // Fire the behavior rule to toggle lore entries
                api.switchGreeting?.(1);                     // Switch to the 2nd greeting
              }}
              style={{
                flex: 1,
                padding: "16px",
                background: "linear-gradient(135deg, #1e1b4b, #312e81)",
                border: "1px solid #4338ca",
                borderRadius: "12px",
                color: "#c7d2fe",
                fontSize: "15px",
                fontWeight: "bold",
                cursor: "pointer",
              }}
            >
              Enter the Dark Cave
            </button>

            <button
              onClick={() => {
                api.setVariable("current_route", "light");
                api.executeAction("choose-light");
                api.switchGreeting?.(2);                     // Switch to the 3rd greeting
              }}
              style={{
                flex: 1,
                padding: "16px",
                background: "linear-gradient(135deg, #365314, #4d7c0f)",
                border: "1px solid #65a30d",
                borderRadius: "12px",
                color: "#ecfccb",
                fontSize: "15px",
                fontWeight: "bold",
                cursor: "pointer",
              }}
            >
              Walk to the Sunlit Meadow
            </button>
          </div>
        )}
      </div>
    )} />
  );
}
```

**Line-by-line explanation:**

- `<Chat renderBubble={...} />` — uses the platform's default chat interface (input box, swipe switching, save points are all built in), you only take over how bubbles render
- `const api = useYumina()` — gets Yumina's API, letting you read variables, write variables, fire actions, switch greetings
- `api.variables.current_route` — reads the current route variable's value
- `hasChosen` — if it's not `"none"`, the player has already chosen
- `msg.contentHtml` — the pre-rendered HTML that renderBubble passes in (Markdown is already processed)
- `msg.messageIndex === 0` — only show buttons on the first message (not every message)
- `!hasChosen` — buttons disappear after a choice is made
- `api.setVariable("current_route", "dark")` — sets the variable to `"dark"`, so `hasChosen` becomes `true` and buttons disappear
- `api.executeAction("choose-dark")` — fires the behavior rule we created in Step 3
- `api.switchGreeting?.(1)` — switches the first message to index 1 (the second greeting). `?.` is optional chaining — if the API isn't available, it won't throw

::: tip Don't want to write code yourself? Use Studio AI
Editor top → click "Enter Studio" → AI Assistant panel → describe what you want in plain English and the AI will generate the code for you.
:::

---

#### Step 5: Save and test

1. Click "Save" at the top of the editor
2. Click "Start Game" or go back to the home page and start a new session
3. You'll see the main opening with two buttons below
4. Click "Enter the Dark Cave" — the first message **instantly** becomes your pre-written cave opening and the buttons disappear
5. Send a few messages to the AI — if you did Step 3, the AI's replies will be influenced by the cave lore
6. Want to test the other route? Go back home and start a new session, this time clicking the other button

**Troubleshooting:**

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Don't see buttons | Root Component code isn't saved or has a syntax error | Check the compile status at the bottom of the Custom UI section — it should show a green "OK" |
| Button click does nothing | `switchGreeting` not deployed on the server yet | Make sure you're using the latest version |
| Button clicks but opening doesn't switch | Not enough greetings | Confirm there are 3 greetings in the First Message tab |
| Button clicks but doesn't disappear | Variable not being set correctly | Check the editor — is the variable's default `none`, and does the Root Component code correctly check `current_route`? |
| Lore doesn't switch | Behavior rule misconfigured | Verify the behavior's action ID matches the code (`choose-dark` / `choose-light`) |

---

## Part 2: Player input modifies entry content

### What you'll build

Add a text input in the chat interface. The player types something in it (e.g., a custom rule, a character name, or a story instruction). After they click "Apply", the text is injected into a lore entry — changing what the AI sees next.

### How it works

Yumina entries support **macro syntax**. You can write `{{variableId}}` in an entry's content — that's a placeholder. Every time the engine builds the prompt to send to the AI, it automatically replaces the placeholder with the variable's current value.

For example:

- You write in an entry: `Special rule: {{custom_rule}}`
- Variable `custom_rule` has the value `"All magic is allowed"`
- The prompt the AI receives has that line rewritten as: `Special rule: All magic is allowed`

**Key point: the replacement isn't live.** It happens every time the prompt is built — i.e., when the player sends their next message and the AI is about to reply.

Full timing:

```
1. Entry content says: "Special rule: {{custom_rule}}"
2. Variable custom_rule's current value = "All magic is allowed"
3. Player sends message → engine builds prompt → replaces {{custom_rule}} with variable value
   → AI receives "Special rule: All magic is allowed" → AI replies accordingly

4. Player types "Magic is forbidden" in the input box, clicks "Apply"
5. Code calls setVariable("custom_rule", "Magic is forbidden")
   → variable value updates immediately
6. But the AI doesn't know yet! The prompt hasn't been rebuilt.

7. Player sends another message → engine rebuilds prompt → this time uses the new value
   → AI receives "Special rule: Magic is forbidden" → AI starts obeying the new rule
```

**One-line summary: changing the variable is instant, but the AI sees the change on the next message.**

### Step by step

#### Step 1: Create a string variable

This variable holds what the player types.

Editor → **Variables** tab → "Add Variable"

| Field | What to fill in | Why |
|-------|-----------------|-----|
| Display Name | Custom Rule | For your own reference |
| ID | `custom_rule` | The `{{custom_rule}}` macro in entries looks up this ID |
| Type | String | Because the content is arbitrary text the player types |
| Default Value | *(leave empty, or set a default like `All magic is allowed`)* | Empty = new session has no rule; non-empty = a starting rule |
| Behavior Rules | `Do not modify this variable. It is set by the player via UI.` | Tells the AI not to modify this variable itself |

---

#### Step 2: Use the macro in an entry

Now create an entry that uses `{{custom_rule}}` as a placeholder. The engine will replace it automatically when building the prompt.

Editor → **Entries** tab → create a new entry

| Field | What to fill in | Why |
|-------|-----------------|-----|
| Name | World Rules | For your own reference |
| Section | System Presets | Entries in the presets section are sent to the AI every time |

Content:

```
[World Rules]
The following rule is in effect for this world and must be respected at all times:
{{custom_rule}}
```

> **What's happening?** Every time the engine builds the prompt, it scans all entry content for `{{...}}`. If what's inside the braces matches a variable ID, the current value of that variable replaces it. So `{{custom_rule}}` gets replaced with the value of variable `custom_rule`.
>
> If the variable is empty, the line becomes empty — the AI sees "The following rule is in effect..." with nothing after. If the value is "Magic is forbidden", the AI sees "The following rule is in effect... Magic is forbidden".

---

#### Step 3: Add an input box in the Root Component

We want an input box in the chat interface where the player can type a new rule. This input is written inside the Root Component's `renderBubble` and only shown below the last message (to avoid one input appearing under every message).

In your `index.tsx`, add the following. If you already have the Part 1 code, just add this inside the JSX `renderBubble` returns, below the message text:

```tsx
// Near the top of MyWorld() (outside <Chat>), add these
const api = useYumina();                                    // If you already have it, don't duplicate
const msgs = api.messages || [];
const [ruleInput, setRuleInput] = React.useState("");
const currentRule = String(api.variables.custom_rule || "");

// Inside renderBubble, add a check
const isLastMsg = msg.messageIndex === msgs.length - 1;    // whether this is the last message

// In the JSX renderBubble returns, below the message text
{isLastMsg && (
  <div style={{
    marginTop: "12px",
    padding: "12px",
    background: "rgba(30,41,59,0.5)",
    borderRadius: "8px",
    border: "1px solid #334155",
  }}>
    <div style={{ fontSize: "12px", color: "#94a3b8", marginBottom: "6px" }}>
      World Rule: {currentRule || "(not set)"}
    </div>
    <div style={{ display: "flex", gap: "8px" }}>
      <input
        type="text"
        value={ruleInput}
        onChange={(e) => setRuleInput(e.target.value)}
        placeholder="Type a new rule..."
        style={{
          flex: 1, padding: "6px 10px", background: "#1e293b",
          border: "1px solid #475569", borderRadius: "6px",
          color: "#e2e8f0", fontSize: "13px", outline: "none",
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && ruleInput.trim()) {
            api.setVariable("custom_rule", ruleInput.trim());
            setRuleInput("");
          }
        }}
      />
      <button
        onClick={() => {
          if (ruleInput.trim()) {
            api.setVariable("custom_rule", ruleInput.trim());
            setRuleInput("");
          }
        }}
        style={{
          padding: "6px 14px", background: "#4338ca", borderRadius: "6px",
          color: "#e0e7ff", fontSize: "13px", fontWeight: "600",
          cursor: "pointer", border: "none",
        }}
      >
        Apply
      </button>
    </div>
  </div>
)}
```

**Line-by-line explanation:**

- `isLastMsg` — only show the input on the last message, otherwise every message would have one
- `currentRule` — reads the variable's current value, shown above the input so the player can see the current rule
- `ruleInput` — React state tracking what's being typed
- `onKeyDown` — pressing Enter also submits, not just clicking the button
- `api.setVariable("custom_rule", ...)` — writes the player's text into the variable. Next AI reply, `{{custom_rule}}` in the entry is replaced with this text
- `setRuleInput("")` — clear the input after submit

::: info Why put it inside renderBubble?
Yumina's Root Component is a TSX file — by default returning `<Chat />` gives you the platform's built-in chat UI. To insert interactive elements (buttons, inputs) into the chat, there are two paths: 1) put them inside `<Chat renderBubble={...} />`, like here, so they render alongside message bubbles; 2) put `<Chat />` and your floating component in a shared flex layout (for sidebars). If you want a fully off-chat full-screen UI (e.g., a pure visual novel), skip `<Chat />` entirely — write your own layout, use `<MessageList />` + `<MessageInput />` directly if needed.
:::

---

#### Step 4: Save and test

1. Save the world, start a new session
2. Below the last message, you'll see "World Rule: (not set)" and an input box
3. Type "Magic is forbidden" and click "Apply" (or press Enter)
4. The text above the input changes to "World Rule: Magic is forbidden" — the variable has updated
5. **Now send a message** (e.g., "I try to cast a fireball") — this is when the engine builds the prompt, replacing `{{custom_rule}}` with "Magic is forbidden"
6. The AI's response should reflect this rule (e.g., "You raise your hand to cast, but your mana feels locked away by some unseen force")
7. Change the rule again (e.g., to "Only fire magic is allowed") and send another message — the AI adapts

---

## Combining both patterns

You can combine greeting switching and entry modification. A concrete example:

**Character creation + story opening:**

- **Main greeting (index 0)** isn't the story — it's a character creation form with inputs for name, class, and backstory
- Player fills it in → `setVariable` writes their input to variables → entries with `{{player_name}}`, `{{player_class}}`, `{{player_backstory}}` macros pick up the values
- Player clicks "Start Adventure" → `switchGreeting(1)` jumps to the real story opening
- From the first AI reply onward, the AI already knows the player character's name, class, and backstory

---

## Quick reference

| What you want | How to do it |
|---------------|-------------|
| Jump to a pre-written opening | `switchGreeting(index)` — index matches the greeting order in the First Message tab (0-based) |
| Let player input change AI behavior | String variable + `{{variableId}}` in entry + call `setVariable()` from UI |
| Show buttons only on the first message | Inside `<Chat renderBubble>`, check `msg.messageIndex === 0` |
| Hide buttons after choosing | Track the choice in a variable, check `hasChosen` in TSX |
| Switch lore after route choice | Create a behavior with "Enable Entry" / "Disable Entry" actions |
| Play a sound on switch | Add "Play Music" or "Play Sound Effect" actions in the behavior |
| Show a notification on switch | Add "Show Notification" action in the behavior |

---

## Try it yourself — importable demo world

Download this JSON file and import it to try the full experience:

<a href="/recipe-1-demo.json" download>recipe-1-demo.json</a>

**How to import:**
1. Go to Yumina → My Worlds → Create New World
2. In the editor, click "More Actions" → "Import Package"
3. Select the downloaded `.json` file
4. The world is created with all greetings, variables, behaviors, and Root Component pre-configured
5. Start a new session and try it out

**What's included:**
- 3 greetings (main opening + dark cave + sunlit meadow)
- 2 variables (`current_route` for route tracking, `custom_rule` for player-editable rule)
- 2 action behaviors (toggle lore entries when a route is chosen)
- A Root Component (`<Chat renderBubble>` with the route-selection buttons + rule editor)
- A lore entry using the `{{custom_rule}}` macro

---

::: tip This is Recipe #1
More recipes coming — combat systems, shop interfaces, quest tracking, and more. Each recipe combines variables, entries, behaviors, and UI to build something greater than the sum of its parts.
:::

</div>
