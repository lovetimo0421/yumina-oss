<div v-pre>

# Character Creation Form

> Before the story starts, the player fills in a character sheet: a name, a class, a short backstory. Then they click "Start Adventure" and the story begins, with the AI already knowing who they are. The player interface has templates for exactly this, so the form needs no code.

---

## What you'll build

A short run of pages the player goes through before the first message:

- **A name field**
- **A class picker**: Warrior, Mage or Rogue, each with a line of description
- **A backstory field**, optional
- **A confirm page** that sums up the choices, with a button that starts the story

Everything the player fills in goes into ordinary variables. The AI sees them from its very first reply.

### How it works

```
1. The player starts a new game → the first opening page appears instead of the chat
2. They type a name and a backstory → saved into the variables Player name and Backstory
3. They pick a class → saved into the variable Class
4. They confirm → the chat starts with your opening
5. The player sends their first message
   → The AI's prompt includes the variables, their Behavior Rules,
     and any lore that only goes in for the chosen class
   → The AI calls them by name and writes to their class
```

---

## Step by step

### Step 1: Add the opening pages from templates

Click **Player interface** in the middle of the top bar, then **Templates**. Under **Openings · before the story starts**, add:

| Template | What it gives you |
|----------|-------------------|
| **Character sheet** | Name, gender, age, looks and one secret, with a card that fills in as the player types. Only the name is required |
| **Pick a background** | A card picker with three options. You'll turn it into the class picker |
| **Confirm before starting** | Sums up everything chosen so far. Always comes last |

The player goes through these in order before the story begins. Each template tells you which variables it adds to the card ("Adds these variables to the card"). They're ordinary variables, already given Behavior Rules that tell the AI what they mean, like "The player's name. Everyone in the story calls the player by this name; never make up another."

::: tip Only need a name?
The **Enter your name** template asks for a name and how the player wants to be addressed, and nothing else.
:::

### Step 2: Turn the background picker into a class picker

Select the **Pick a background** page in the page column on the left and change it:

1. Click the heading and change it to "Choose your class"
2. Select the card picker. Rename its three options to **Warrior** ("Melee specialist, high HP"), **Mage** ("Ranged magic, high MP") and **Rogue** ("Agile and stealthy, high crit")
3. Double-click the page in the page column and rename it "Class"

The picker saves the chosen option into the variable **Background**. Go back to the canvas, find Background in the Variables block, rename it to **Class**, and rewrite its **Behavior Rules**:

```
The class the player chose at the start: Warrior, Mage or Rogue. It decides what they can do in a fight and how others see them. Don't change it.
```

Then open **What the AI does with it** and set **AI access** to **AI read-only**, so the AI can't rewrite the player's class.

### Step 3: Trim the character sheet

On the **Character sheet** page, keep the name and turn one field into the backstory:

- Delete the parts you don't want (select them, or find them under **Layers**, and press Delete). You can delete their variables from the canvas afterwards
- Change the "A secret" field's label to "Backstory (optional)" and its placeholder to "A few sentences about your past". Then rename its variable on the canvas from **Player's secret** to **Backstory**, and change its Behavior Rules to `The player's backstory, written by the player. Use it; don't contradict it.` (The template's own rule treats it as a secret nobody in the story knows, which isn't what you want for a backstory)

**Player name** keeps its template rule. If you'd like a fallback for players who skip the name, select the start button and tick Player name under **Only pressable once these are filled**. The button then stays grey until a name is typed.

### Step 4 (optional): Give each class its own lore

Variables tell the AI what the player picked. To give each class more to work with, add a lore entry per class that only reaches the AI for that class:

1. Add a lore entry "Mage lore" with what a Mage knows and can do in this world
2. Drag the **Class** variable onto the entry and click the line. Set the condition to Class **is** `Mage`
3. Repeat for Warrior and Rogue

Now a Mage player's AI gets the Mage entry, and the others stay out. See [Openings and lore](/creator/entries#lore) for conditional lore.

### Step 5: Write the opening

The opening (**Greeting** on the canvas) is the first message after the form. Write it the usual way:

```
*The gate of destiny swings open, and dawn light spills over the Elderlands.*

*The silhouette of a distant city shimmers ahead, and a cobblestone road stretches toward it. The wind smells of grass and far-off hearth-smoke.*

Three paths lie before you: a wide road leading to town, a narrow trail through the woods, and a slope down to the river. Which way do you go?
```

::: warning Don't put the player's choices into the opening text
Openings are written into the game when it's created, before the player has filled in the form. A `{{Player name}}` macro in the opening would show the variable's starting value, not what the player typed. Leave the name and class to the AI: its first reply already knows them.
:::

### Step 6: Playtest

Turn **Edit** off in the player interface to click through the pages without using credits. Then click **Play** in the top bar:

1. The character sheet appears. Type "Elara" and a line of backstory
2. Pick **Mage**
3. The confirm page lists your choices. Click its start button
4. The opening appears. Send "I head toward the town"
5. The AI calls you Elara and writes you as a Mage (staves, spells, people noticing your robe)

**This turn** on the right of the playtest shows the variables and lore the AI got.

**If something goes wrong:**

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| The form doesn't appear | The pages aren't in the opening chain | They must come from **Openings · before the story starts** templates, with the confirm page last |
| A page has a **No way out** warning | No button on it leads anywhere | Give it a button with **Go to page** |
| The AI ignores the class | The Class variable has no Behavior Rules, or the AI doesn't see variables | Write Behavior Rules for it, and check **Variables shown to the AI** under the card's **Context** isn't **None** |
| The class lore never comes in | The condition value doesn't match the picked option exactly | The condition must say `Mage` exactly as the option is titled |
| The AI renames the player | Player name can be written by the AI | Set its **AI access** to **AI read-only** |

---

## Custom code route: a form inside the first message

If you want the form drawn by your own interface code, for example right under the first message, here's the code version. It uses three Text variables named `player_name`, `player_class` and `player_backstory` (all **AI read-only**, `player_name` starting at `Traveler`) and two openings: a short "who are you?" scene as the first, and the real story opening as the second.

Interface code reads and writes variables by their name. **Panels → Front End Code** → open `index.tsx` and replace the default `return <Chat />`:

```tsx
export default function MyWorld() {
  const api = useYumina();

  const [name, setName] = React.useState("");
  const [selectedClass, setSelectedClass] = React.useState("");
  const [backstory, setBackstory] = React.useState("");

  // Once a class is saved, the form is done
  const hasCreated = String(api.variables.player_class || "") !== "";

  const classes = [
    { id: "Warrior", label: "Warrior", icon: "⚔️", desc: "Melee specialist, high HP" },
    { id: "Mage", label: "Mage", icon: "🔮", desc: "Ranged magic, high MP" },
    { id: "Rogue", label: "Rogue", icon: "🗡️", desc: "Agile and stealthy, high crit" },
  ];

  const handleStart = async () => {
    if (!selectedClass) return;
    // Switch to the second opening FIRST: switching resets variables
    // to that opening's starting values
    await api.switchGreeting(1);
    api.setVariable("player_name", name.trim() || "Traveler");
    api.setVariable("player_class", selectedClass);
    api.setVariable("player_backstory", backstory.trim());
  };

  const label = { fontSize: "13px", color: "#a5b4fc", marginBottom: "6px", fontWeight: "600" };
  const field = {
    width: "100%", padding: "10px 14px", background: "#0f172a",
    border: "1px solid #334155", borderRadius: "8px", color: "#e2e8f0",
    fontSize: "14px", outline: "none", boxSizing: "border-box", fontFamily: "inherit",
  };

  return (
    <Chat renderBubble={(msg) => (
      <div>
        <div
          style={{ color: "#e2e8f0", lineHeight: 1.7 }}
          dangerouslySetInnerHTML={{ __html: msg.contentHtml }}
        />

        {msg.messageIndex === 0 && !hasCreated && (
          <div style={{
            marginTop: "20px",
            padding: "24px",
            background: "linear-gradient(135deg, #1e1b4b 0%, #1a1a2e 100%)",
            borderRadius: "16px",
            border: "1px solid #312e81",
          }}>
            <div style={{ fontSize: "18px", fontWeight: "bold", color: "#c4b5fd", marginBottom: "20px", textAlign: "center" }}>
              Create Your Character
            </div>

            <div style={{ marginBottom: "16px" }}>
              <div style={label}>Character Name</div>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Leave blank for 'Traveler'"
                style={field}
              />
            </div>

            <div style={{ marginBottom: "16px" }}>
              <div style={{ ...label, marginBottom: "8px" }}>Choose a Class</div>
              <div style={{ display: "flex", gap: "10px" }}>
                {classes.map((cls) => {
                  const picked = selectedClass === cls.id;
                  return (
                    <button
                      key={cls.id}
                      onClick={() => setSelectedClass(cls.id)}
                      style={{
                        flex: 1,
                        padding: "14px 10px",
                        background: picked ? "linear-gradient(135deg, #4338ca, #6366f1)" : "#1e293b",
                        border: picked ? "2px solid #818cf8" : "1px solid #334155",
                        borderRadius: "10px",
                        color: picked ? "#e0e7ff" : "#94a3b8",
                        cursor: "pointer",
                        textAlign: "center",
                      }}
                    >
                      <div style={{ fontSize: "24px", marginBottom: "4px" }}>{cls.icon}</div>
                      <div style={{ fontSize: "14px", fontWeight: "bold", marginBottom: "2px" }}>{cls.label}</div>
                      <div style={{ fontSize: "11px", opacity: 0.7 }}>{cls.desc}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ marginBottom: "20px" }}>
              <div style={label}>Backstory (optional)</div>
              <textarea
                value={backstory}
                onChange={(e) => setBackstory(e.target.value)}
                placeholder="A few sentences about your character's past..."
                rows={3}
                style={{ ...field, resize: "vertical" }}
              />
            </div>

            <button
              onClick={handleStart}
              disabled={!selectedClass}
              style={{
                width: "100%",
                padding: "14px",
                background: selectedClass ? "linear-gradient(135deg, #7c3aed, #a855f7)" : "#374151",
                border: "none",
                borderRadius: "10px",
                color: selectedClass ? "#f5f3ff" : "#6b7280",
                fontSize: "16px",
                fontWeight: "bold",
                cursor: selectedClass ? "pointer" : "not-allowed",
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

**What the code does:**

- `msg.messageIndex === 0 && !hasCreated` shows the form only on the first message, and only until a class has been saved
- The three `React.useState` values hold what the player is typing until they click **Start Adventure**
- `api.switchGreeting(1)` swaps the first message for the second opening (openings count from 0). **Switching resets variables to that opening's starting values**, so the code waits for the switch and writes the variables after it. Written the other way round, the switch would wipe them
- `api.setVariable("player_class", ...)` writes by the variable's name

The AI reads these variables in its next prompt. For lore that should spell out the profile, you can also write macros in an always-sent entry:

```
[Player character]
Name: {{player_name}}
Class: {{player_class}}
Backstory: {{player_backstory}}
```

Macros in lore are filled in each time the AI's prompt is built, so they always carry the current values. Macros in an opening are not: the opening is written when the game is created, so `{{player_name}}` there shows the starting value ("Traveler").

The status next to the file in **Panels → Front End Code** should read a green **OK**.

### Show the character on later messages

Inside `renderBubble`, above the message text:

```tsx
{hasCreated && (
  <div style={{ display: "flex", gap: "8px", marginBottom: "8px", fontSize: "12px", color: "#a5b4fc" }}>
    <span>{String(api.variables.player_name)}</span>
    <span style={{ opacity: 0.5 }}>|</span>
    <span>{String(api.variables.player_class)}</span>
  </div>
)}
```

::: tip Don't want to write code yourself?
Click **Creation assistant** at the top right of the canvas and describe the form you want.
:::

---

## Going further

### More classes

In the template route, add an option to the card picker and a matching lore entry. In the code route, add an item to the `classes` array.

### Attribute points

The **Spend attribute points** template splits six points across Strength, Agility, Charm and Wits. Put it between the class page and the confirm page.

### Different starts per class

If each class should start somewhere else entirely, write one opening per class and add the **Pick an opening** template (it needs at least two openings). Scenarios tied to an opening only exist in games that started from it. See [Scenarios](/creator/modules).

---

## Quick reference

| What you want | How to do it |
|---------------|-------------|
| A form before the story | **Player interface** → **Templates** → **Openings · before the story starts** |
| Name only | **Enter your name** template |
| Several fields | **Character sheet** template |
| Pick one of several options | **Pick a background** template (a card picker), renamed |
| Sum up before starting | **Confirm before starting** template, always last |
| Require a field | Start button → **Only pressable once these are filled** |
| Keep the AI from changing a choice | **AI access**: **AI read-only** |
| Different lore per choice | Lore entry with a condition on the variable |
| Put choices into lore text | Macros like `{{player_name}}` in a lore entry (not in the opening) |
| Code: switch opening, then save choices | `await api.switchGreeting(1)`, then `api.setVariable(...)` |

---

::: tip This is Recipe #4
[Scene Jumping & Entry Switching via UI](./scene-jumping.md) covers switching openings from buttons and using macros in lore in more detail. Character creation is a common first step before the other recipes: a class can decide starting gold for the [shop](./shop.md) or starting items for the [inventory](./inventory.md).
:::

</div>
