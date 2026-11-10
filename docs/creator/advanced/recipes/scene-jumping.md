<div v-pre>

# Scene Jumping & Entry Switching via UI

> Click a button → jump to a different pre-written opening. Type in a text box → change what an entry says to the AI. This recipe shows both, first without code and then in interface code.

---

## Part 1: Switch between openings with a button

### What you'll build

A world with multiple pre-written opening scenes. The player sees the "main" opening first, with clickable buttons. When they click one, the first message in chat switches to another pre-written opening at once — no AI generation, just the text you wrote.

### How it works

A card can have several openings. When a player starts a new session, all of them are packed as **swipes** on the first message (left/right to switch). Each opening also carries its own starting values for the variables.

`api.switchGreeting(index)` jumps straight to the opening with that number; the Player interface's **Switch opening** button step does the same without code.

```
Player clicks "Enter the Dark Cave"
  → the button switches to opening #2 (index starts at 0, so 1 = the second one)
  → variables reset to that opening's starting values
  → Player sees your pre-written dark cave opening
```

### Without code

1. Write the openings (Step 1 below)
2. In the [Player interface](/creator/player-view), click **Templates** and add **Pick an opening**: one card per opening, and the story starts from whichever the player taps. Or put buttons on a page yourself and give each one a **Switch opening** step
3. To give each route its own lore, follow Steps 2 and 3 below; they don't need code either

If something else should happen when the route is picked (music, a notice), add a **Set off a behavior** step **after** the **Switch opening** step. Switching resets variables to that opening's starting values, so any change made before it is lost.

### Step by step

#### Step 1: Write the openings

On the canvas, click the opening's row and write the first one. To add another, click the **＋** in the top right of the opening block.

**The first opening (main opening — presents the route choice):**

This is what the player sees first when they open the session — describe the scene and guide them toward a choice:

```
*You wake up in a mysterious forest. Morning mist swirls between ancient trees.*

Two paths diverge before you:

**To the left** — a narrow trail into darkness. Cold air and distant echoes.

**To the right** — a sun-dappled path with wildflowers and birdsong.

Which way will you go?
```

> The opening is **fixed text you wrote**, not AI-generated, so you control every word the player sees.

**The second opening (dark cave):**

```
*You step onto the left path. The canopy thickens overhead, swallowing the light. Within minutes, the trail narrows to a crack in a rock face — the entrance to a cave.*

*Cold air rushes out, carrying the smell of damp stone and something metallic. Faint blue-green light flickers deep inside — bioluminescent fungi clinging to the walls.*

*You take a breath and step in. Behind you, the last sliver of daylight shrinks to a pale line, then vanishes.*

You are alone in the dark.
```

> This text only shows after the player clicks "Enter the Dark Cave". Before that, the player sees the first opening.

**The third opening (sunlit meadow):**

```
*You choose the right path. The trees thin out, and warm sunlight floods through the canopy. Within minutes, the forest opens into a vast meadow stretching to the horizon.*

*Wildflowers in every color sway gently in the breeze. A stream glitters in the distance. Somewhere nearby, a bird sings a melody you've never heard before.*

*You feel the tension in your shoulders melt away. Whatever this place is, it feels safe.*

Welcome to the Everbloom Meadow.
```

::: info Opening order is the index
The openings' order is the `index` for `switchGreeting()`, counting from 0: the first opening is index 0 (shown by default), the second is index 1, the third is index 2. The Player interface's **Switch opening** step lists them as Opening 1, 2, 3.
:::

---

#### Step 2: Create a route variable with a value per opening

A variable records which route the player is on. It has two uses:
- **Hide the buttons once a route is picked** (the code checks whether it's still `"none"`)
- **Send each route's lore** (Step 3 makes lore conditional on it)

On the canvas, click **＋ Variable** in the **Add** row:

| Field | What to fill in | Why |
|-------|-----------------|-----|
| Variable name | `current_route` | Code and conditions find the variable by this name |
| Type | Text | The value is text (`"none"`, `"dark"`, `"light"`) |
| Starts at | `none` | Means "not yet chosen" |
| AI access (under **What the AI does with it**) | AI read-only | Only the openings set it; the AI can see it but can't change it |

Now give each route its own starting value: drag the second opening onto `current_route` and set it to `dark`, then drag the third opening onto it and set it to `light`. When the player switches to an opening, `current_route` takes that opening's value.

---

#### Step 3: (Optional) Give each route its own lore

If you want the AI's later replies to use different worldbuilding after the route is chosen, do this step. If you only want to switch the opening text, skip it.

Add two lore entries and make each one **Conditional lore**: drag `current_route` onto the entry, then click the line and set the condition (`current_route` is `dark` for the cave entry, `light` for the meadow entry). Conditional lore is only sent while its condition holds.

**Dark cave lore entry** (condition: `current_route` is `dark`):

```
[World Setting: Shadowmaw Cave]
The player is exploring Shadowmaw Cave. Key details:
- Ancient dwarven ruins, abandoned for centuries
- Bioluminescent fungi provide faint blue-green light
- Strange creatures lurk in the deeper tunnels
- Temperature drops the further in you go

Maintain a tense horror-survival atmosphere. Describe echoing sounds, flickering shadows, water dripping, and the oppressive weight of stone overhead.
```

**Sunlit meadow lore entry** (condition: `current_route` is `light`): describe the meadow's setting and atmosphere.

Before the player picks, `current_route` is `none`, so neither entry is sent.

For a route with a lot of its own lore, variables and AIs, put it in a [scenario](/creator/modules) instead and drag the opening onto the scenario: that scenario then only exists in games that start from that opening.

---

#### Step 4: Add route buttons in interface code

To put the buttons inside the first chat bubble, write them in interface code. Open **Panels → Front End Code** → `index.tsx` and replace its contents with:

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
              onClick={() => api.switchGreeting(1)}   // Switch to the 2nd opening
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
              onClick={() => api.switchGreeting(2)}   // Switch to the 3rd opening
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
- `const api = useYumina()` — gets Yumina's API, letting you read variables, write variables, set off behaviors, switch openings
- `api.variables.current_route` — reads the current route variable's value
- `hasChosen` — if it's not `"none"`, the player has already chosen
- `msg.contentHtml` — the pre-rendered HTML that renderBubble passes in (Markdown is already processed)
- `msg.messageIndex === 0` — only show buttons on the first message (not every message)
- `api.switchGreeting(1)` — switches the first message to index 1 (the second opening). The variables reset to that opening's starting values, so `current_route` becomes `"dark"`, the buttons disappear and the cave lore starts being sent

**Doing more on click.** If the button should also run a behavior (play music, show a notice, change other values), switch first and run the behavior after the switch has finished:

```tsx
onClick={async () => {
  await api.switchGreeting(1);                 // resets variables to opening 2's values
  await api.executeActionAndWait("choose-dark"); // a behavior triggered by The player presses a button → Button "choose-dark"
}}
```

Calling `setVariable` or a behavior **before** the switch doesn't stick: the switch puts back that opening's starting values.

::: tip Don't want to write code yourself?
Click **Creation assistant** in the top right of the canvas and describe the buttons you want. It writes the code for you.
:::

---

#### Step 5: Save and test

1. Click **Save** in the top bar
2. Click **Play** to start a playtest
3. You'll see the main opening with two buttons below
4. Click "Enter the Dark Cave" — the first message becomes your cave opening and the buttons disappear
5. Send a few messages to the AI — if you did Step 3, the AI's replies follow the cave lore
6. To test the other route, start a new playtest and click the other button

**Troubleshooting:**

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Don't see buttons | The interface code isn't saved or has a syntax error | **Panels → Front End Code** should show **OK**, not **Error** |
| Button clicks but opening doesn't switch | Not enough openings | Confirm the card has 3 openings |
| Opening switches but the buttons stay | The opening has no starting value for `current_route` | Drag that opening onto `current_route` and set its value |
| Lore doesn't switch | The entry's condition doesn't match | Click the line between `current_route` and the entry and check the value (`dark` / `light`) |
| A value set on click is gone | It was set before the switch | Await `switchGreeting` first, then change values |

---

## Part 2: Player input modifies entry content

### What you'll build

A text input where the player types something (a custom rule, a character name, a story instruction). The text goes into a variable, and a lore entry includes that variable, so it changes what the AI reads next.

### How it works

Lore entries support **macros**. Write `{{variable_name}}` in an entry's content and every time the engine builds the prompt for the AI, it replaces the placeholder with the variable's current value.

For example:

- You write in an entry: `Special rule: {{custom_rule}}`
- Variable `custom_rule` has the value `"All magic is allowed"`
- The prompt the AI receives has that line rewritten as: `Special rule: All magic is allowed`

The replacement happens each time the prompt is built, that is, when the player sends their next message and the AI is about to reply.

Full timing:

```
1. Entry content says: "Special rule: {{custom_rule}}"
2. Variable custom_rule's current value = "All magic is allowed"
3. Player sends message → engine builds prompt → replaces {{custom_rule}} with variable value
   → AI receives "Special rule: All magic is allowed" → AI replies accordingly

4. Player types "Magic is forbidden" in the input box, clicks "Apply"
5. The variable custom_rule is set to "Magic is forbidden"
   → variable value updates immediately
6. The AI doesn't see it yet: the prompt hasn't been rebuilt.

7. Player sends another message → engine rebuilds prompt → this time uses the new value
   → AI receives "Special rule: Magic is forbidden" → AI starts obeying the new rule
```

The variable changes at once; the AI sees the change on the next message.

### Without code

In the [Player interface](/creator/player-view), add a **Form field** part (**Short text** or **Paragraph**) and set **Save the answer to** to `custom_rule`. The variable updates as the player types. A **Text** part can show the current rule with **Insert a variable's value…**. Then do Steps 1 and 2 below; Step 3 is only for an input box inside the chat.

### Step by step

#### Step 1: Create a text variable

This variable holds what the player types. On the canvas, click **＋ Variable** in the **Add** row:

| Field | What to fill in | Why |
|-------|-----------------|-----|
| Variable name | `custom_rule` | The `{{custom_rule}}` macro in the entry looks up this name |
| Type | Text | The content is whatever the player types |
| Starts at | *(leave empty, or a default like `All magic is allowed`)* | Empty = a new session has no rule; non-empty = a starting rule |
| AI access (under **What the AI does with it**) | AI read-only | The player sets it; the AI reads it but can't change it |

---

#### Step 2: Use the macro in an entry

Create an entry that uses `{{custom_rule}}` as a placeholder. In the **Character and world** block on the canvas (sent every turn), click the **＋** in the block's top right:

| Field | What to fill in | Why |
|-------|-----------------|-----|
| Name | World Rules | For your own reference |
| When the AI sees this | Character and world (every turn) | The rule applies to every reply |

Content:

```
[World Rules]
The following rule is in effect for this world and must be respected at all times:
{{custom_rule}}
```

> Every time the engine builds the prompt, it looks for `{{...}}` in the entries. If the name inside the braces matches a variable, the variable's current value replaces it.
>
> If the variable is empty, the line becomes empty — the AI sees "The following rule is in effect..." with nothing after. If the value is "Magic is forbidden", the AI sees "The following rule is in effect... Magic is forbidden".

---

#### Step 3: Add an input box in interface code

This puts an input box under the last message in the chat, written inside `renderBubble` (only below the last message, so there's one input, not one per message).

In your `index.tsx`, add the following. If you already have the Part 1 code, add this inside the JSX `renderBubble` returns, below the message text:

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
Returning `<Chat />` from `index.tsx` gives you the platform's chat. To put interactive elements (buttons, inputs) into the chat, there are two ways: 1) put them inside `<Chat renderBubble={...} />`, like here, so they render alongside message bubbles; 2) put `<Chat />` and your own component side by side in a flex layout (for sidebars). For a full-screen UI with no chat (e.g., a visual novel), skip `<Chat />` and write your own layout, using `<MessageList />` + `<MessageInput />` if needed.
:::

---

#### Step 4: Save and test

1. Save the card and start a playtest with **Play**
2. Below the last message, you'll see "World Rule: (not set)" and an input box
3. Type "Magic is forbidden" and click "Apply" (or press Enter)
4. The text above the input changes to "World Rule: Magic is forbidden" — the variable has updated
5. **Now send a message** (e.g., "I try to cast a fireball") — this is when the engine builds the prompt, replacing `{{custom_rule}}` with "Magic is forbidden"
6. The AI's response should reflect this rule (e.g., "You raise your hand to cast, but your mana feels locked away by some unseen force")
7. Change the rule again (e.g., to "Only fire magic is allowed") and send another message — the AI adapts

---

## Combining both patterns

You can combine opening switching and entry modification. A concrete example:

**Character creation + story opening:**

- **The first opening (index 0)** isn't the story — it's a character creation screen with inputs for name, class, and backstory
- Player fills it in → the inputs write to variables → entries with `{{player_name}}`, `{{player_class}}`, `{{player_backstory}}` macros pick up the values
- Player clicks "Start Adventure" → `switchGreeting(1)` jumps to the real story opening. Switching resets variables to that opening's starting values, so save the answers **after** the switch (await `switchGreeting`, then `setVariable` or `patchVariables`)
- From the first AI reply onward, the AI already knows the player character's name, class, and backstory

The Player interface's opening templates (**Enter your name**, **Character sheet**, **Pick a background**, **Spend attribute points**) build this kind of screen without code, before the story starts.

---

## Quick reference

| What you want | How to do it |
|---------------|-------------|
| Jump to a pre-written opening | Player interface: **Switch opening** step or **Pick an opening** template. Code: `await api.switchGreeting(index)` (0-based, in opening order) |
| Different values per opening | Drag the opening onto the variable on the canvas and set its starting value |
| Let player input change AI behavior | Text variable + `{{variable_name}}` in an entry + a **Form field** (or `setVariable()` from code) |
| Show buttons only on the first message | Inside `<Chat renderBubble>`, check `msg.messageIndex === 0` |
| Hide buttons after choosing | Track the choice in a variable, check `hasChosen` in TSX |
| Switch lore after route choice | **Conditional lore** on the route variable, or a scenario tied to the opening |
| Play a sound or show a notice on switch | A behavior with **Play music** / **Play sound effect** / **Show notification**, set off after the switch |

---

## Try it yourself — importable demo world

Download this JSON file and import it:

<a href="/recipe-1-demo.json" download>recipe-1-demo.json</a>

**How to import:**
1. Click **Create** on the left and choose **Blank Project**
2. Open **Panels → Card settings**, then **Import File** → **Choose File**
3. Select the downloaded `.json` file. Importing replaces everything in that card
4. Click **Save**, then **Play** to try it

**What's included:**
- 3 openings (main opening + dark cave + sunlit meadow)
- 2 variables (`current_route` for route tracking, `custom_rule` for the player-editable rule)
- 2 behaviors triggered by **The player presses a button** (`choose-dark` / `choose-light`) that set the route and switch the route lore on and off
- A message renderer (interface code that draws each message) with the route buttons and the rule editor
- A lore entry using the `{{custom_rule}}` macro

The demo's buttons set the route, run the behavior and then switch the opening, all in one click. The switch resets variables to the opening's starting values, so the route may not stick; Steps 2–4 above avoid this.

</div>
