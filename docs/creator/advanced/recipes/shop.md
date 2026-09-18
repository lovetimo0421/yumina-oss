<div v-pre>

# Shop & Trading

> Build a shop UI — players browse items, click to buy, gold is deducted automatically, and items go straight into their inventory. This recipe shows you how to combine variables, behaviors, and a Root Component into a complete trading system.

---

## What you'll build

A shop panel embedded in the chat interface. The player can see how much gold they have, what's for sale, and the price of each item. When they click a "Buy" button:

- Gold is automatically reduced by the item's price
- The item is added to the inventory (a JSON array)
- A "Purchase successful!" notification pops up
- If gold is insufficient, a "Not enough gold!" warning appears — no gold is deducted and no item is added

There's also an inventory grid at the bottom that shows all items in the player's bag in real time.

```
Player clicks "Buy Potion (20 gold)"
  → Behavior checks: gold >= 20?
    → Yes: gold minus 20, inventory push "Potion", show success notification
    → No: show "Not enough gold!" warning
```

---

## How it works

This shop system combines three core mechanisms:

1. **Number variable + condition check** — Gold is a number variable. The behavior checks whether it's enough before executing.
2. **JSON variable + push operation** — The inventory is a JSON array. Each purchase uses `push` to add an item to it.
3. **Action trigger** — Each buy button corresponds to an action ID. Buttons in the Root Component call `executeAction()` to trigger behaviors.

The full flow:

```
Root Component button UI
  → Player clicks "Buy Potion"
  → Calls api.executeAction("buy-potion")
  → Engine finds the behavior with action ID "buy-potion"
  → Checks condition: gold >= 20?
    → Pass → Execute actions: modify variable (gold -20), modify variable (inventory push "Potion"), show notification
    → Fail → Do nothing (the "not enough gold" message is handled by a separate behavior)
```

---

## Step by step

### Step 1: Create variables

We need two variables — one to track gold, one to track what's in the inventory.

Editor → sidebar → **Variables** tab → click **Add Variable**

#### Variable 1: Gold

| Field | Value | Why |
|-------|-------|-----|
| Name | Gold | For your own reference in the editor |
| ID | `gold` | Used in code and behaviors to read/write this variable |
| Type | Number | Gold is numeric — we need arithmetic operations |
| Default Value | `100` | Player starts with 100 gold in a new session |
| Min Value | `0` | Prevents gold from going negative — the engine will clamp it |
| Category | Resources | Gold is a resource-type variable |
| Behavior Rules | `Gold is automatically deducted when the player buys items from the shop. You may also increase or decrease gold in the story — e.g., quest rewards, getting robbed by thieves, or finding a treasure chest.` | Tells the AI that gold can change during the story, not just in the shop |

> **Why set a min value of 0?** We already check "can the player afford this?" in the behavior's condition, but adding engine-level protection is safer. If something slips through, gold still won't go negative.

#### Variable 2: Inventory

| Field | Value | Why |
|-------|-------|-----|
| Name | Inventory | For your own reference |
| ID | `inventory` | Used in code and behaviors |
| Type | JSON | The inventory is an array — needs the JSON type to store it |
| Default Value | `[]` | Empty array — inventory starts empty in a new session |
| Category | Inventory | This is an inventory-type variable |
| Behavior Rules | `Items are automatically added when bought from the shop. You may also add or remove items in the story — e.g., the player picks something up, an item breaks, gets stolen, or is received as a quest reward.` | Tells the AI that inventory can change during the story, not just in the shop |

> **JSON variables can store any JSON data structure.** Here we use an array (`[]`) to hold a list of item names. Each purchase uses `push` to append a string to the end of the array. For example, after buying a potion the value goes from `[]` to `["Potion"]`, and buying an iron sword after that makes it `["Potion", "Iron Sword"]`.

---

### Step 2: Create shop behaviors

We need multiple behaviors — a "purchase successful" and a "not enough gold" behavior for each item. Here we'll use Potion and Iron Sword as examples.

Editor → **Behaviors** tab → click **Add Behavior**

#### Behavior 1: Buy Potion (success)

**WHEN (trigger):**

| Field | Value | Why |
|-------|-------|-----|
| Trigger Type | Action button pressed | Fires when the Root Component calls `executeAction("buy-potion")` |
| Action ID | `buy-potion` | Must match the `executeAction("buy-potion")` call in the Root Component code |

**ONLY IF (conditions):**

| Variable | Operator | Value | Why |
|----------|----------|-------|-----|
| `gold` | Greater than or equal (gte) | `20` | Potion costs 20 gold — can only buy if you have enough |

**DO (actions):**

Add the following actions in order:

| Action Type | Settings | Effect |
|-------------|----------|--------|
| Modify Variable | Variable `gold`, operation `subtract`, value `20` | Deducts 20 gold |
| Modify Variable | Variable `inventory`, operation `push`, value `"Potion"` | Adds "Potion" to the inventory array |
| Show Notification | Message `Purchase successful! You got a Potion.`, style `achievement` | Shows a gold-colored success notification |

> **The push operation is specifically for JSON arrays.** It appends an element to the end of the array without overwriting existing contents. So each time you buy a potion, another `"Potion"` string is added to the inventory.

#### Behavior 2: Buy Potion (not enough gold)

This behavior listens for the same action ID, but the condition is "gold is **not** enough".

**WHEN:**

| Field | Value |
|-------|-------|
| Trigger Type | Action button pressed |
| Action ID | `buy-potion` |

**ONLY IF:**

| Variable | Operator | Value | Why |
|----------|----------|-------|-----|
| `gold` | Less than (lt) | `20` | Gold is less than 20 — can't afford it |

**DO:**

| Action Type | Settings | Effect |
|-------------|----------|--------|
| Show Notification | Message `Not enough gold! The potion costs 20 gold.`, style `warning` | Shows a yellow warning notification |

> **Why two separate behaviors?** Because a single behavior can only have one set of conditions. If the condition passes, the actions execute; if it fails, nothing happens. So we use two behaviors to cover both cases: enough gold → purchase succeeds; not enough gold → show warning. They listen to the same action ID but have mutually exclusive conditions, so only one ever fires.

#### Behavior 3: Buy Iron Sword (success)

**WHEN:**

| Field | Value |
|-------|-------|
| Trigger Type | Action button pressed |
| Action ID | `buy-sword` |

**ONLY IF:**

| Variable | Operator | Value |
|----------|----------|-------|
| `gold` | Greater than or equal (gte) | `50` |

**DO:**

| Action Type | Settings | Effect |
|-------------|----------|--------|
| Modify Variable | Variable `gold`, operation `subtract`, value `50` | Deducts 50 gold |
| Modify Variable | Variable `inventory`, operation `push`, value `"Iron Sword"` | Adds "Iron Sword" to the inventory array |
| Show Notification | Message `Purchase successful! You got an Iron Sword.`, style `achievement` | Shows a gold-colored success notification |

#### Behavior 4: Buy Iron Sword (not enough gold)

**WHEN:**

| Field | Value |
|-------|-------|
| Trigger Type | Action button pressed |
| Action ID | `buy-sword` |

**ONLY IF:**

| Variable | Operator | Value |
|----------|----------|-------|
| `gold` | Less than (lt) | `50` |

**DO:**

| Action Type | Settings | Effect |
|-------------|----------|--------|
| Show Notification | Message `Not enough gold! The iron sword costs 50 gold.`, style `warning` | Shows a yellow warning notification |

::: tip Want to add more items?
Just repeat the pattern — two behaviors per item (success + insufficient), changing the action ID, price, and item name. For example, to add a 30-gold "Shield": action ID `buy-shield`, condition `gold gte 30`, actions `subtract 30` + `push "Shield"`.
:::

---

### Step 3: Add the shop panel in the Root Component

This is the key step that makes the shop UI appear in the chat. We'll show three areas below each message: gold balance, item list (with buy buttons), and an inventory grid.

Editor → **Custom UI** section → open `index.tsx` → paste the following code (replacing the default `return <Chat />`):

```tsx
export default function MyWorld() {
  const api = useYumina();
  const msgs = api.messages || [];

  // Read variables
  const gold = Number(api.variables.gold ?? 100);
  const inventory = Array.isArray(api.variables.inventory)
    ? api.variables.inventory
    : [];

  // Shop item definitions
  const shopItems = [
    { name: "Potion",     price: 20, actionId: "buy-potion", icon: "\u{1F9EA}", desc: "Restores a small amount of health" },
    { name: "Iron Sword", price: 50, actionId: "buy-sword",  icon: "\u2694\uFE0F", desc: "A plain iron sword" },
  ];

  return (
    <Chat renderBubble={(msg) => {
      const isLastMsg = msg.messageIndex === msgs.length - 1;
      return (
    <div>
      {/* Render message text normally (the platform already rendered HTML, use contentHtml directly) */}
      <div
        style={{ color: "#e2e8f0", lineHeight: 1.7 }}
        dangerouslySetInnerHTML={{ __html: msg.contentHtml }}
      />

      {/* Only show the shop below the last message */}
      {isLastMsg && (
        <div style={{
          marginTop: "16px",
          padding: "16px",
          background: "rgba(15, 23, 42, 0.6)",
          borderRadius: "12px",
          border: "1px solid #334155",
        }}>

          {/* ====== Gold display ====== */}
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            marginBottom: "16px",
            padding: "10px 14px",
            background: "linear-gradient(135deg, #78350f, #92400e)",
            borderRadius: "8px",
            border: "1px solid #b45309",
          }}>
            <span style={{ fontSize: "20px" }}>{"\uD83D\uDCB0"}</span>
            <span style={{ color: "#fde68a", fontSize: "16px", fontWeight: "bold" }}>
              {gold} Gold
            </span>
          </div>

          {/* ====== Shop heading ====== */}
          <div style={{
            fontSize: "14px",
            fontWeight: "bold",
            color: "#94a3b8",
            marginBottom: "10px",
            textTransform: "uppercase",
            letterSpacing: "1px",
          }}>
            Shop
          </div>

          {/* ====== Item list ====== */}
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "16px" }}>
            {shopItems.map((item) => (
              <div
                key={item.actionId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 14px",
                  background: "rgba(30, 41, 59, 0.8)",
                  borderRadius: "8px",
                  border: "1px solid #475569",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <span style={{ fontSize: "22px" }}>{item.icon}</span>
                  <div>
                    <div style={{ color: "#e2e8f0", fontSize: "14px", fontWeight: "600" }}>
                      {item.name}
                    </div>
                    <div style={{ color: "#64748b", fontSize: "12px" }}>
                      {item.desc}
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => api.executeAction(item.actionId)}
                  style={{
                    padding: "6px 16px",
                    background: gold >= item.price
                      ? "linear-gradient(135deg, #065f46, #047857)"
                      : "linear-gradient(135deg, #374151, #4b5563)",
                    border: gold >= item.price
                      ? "1px solid #10b981"
                      : "1px solid #6b7280",
                    borderRadius: "6px",
                    color: gold >= item.price ? "#a7f3d0" : "#9ca3af",
                    fontSize: "13px",
                    fontWeight: "600",
                    cursor: gold >= item.price ? "pointer" : "not-allowed",
                    opacity: gold >= item.price ? 1 : 0.6,
                    whiteSpace: "nowrap",
                  }}
                >
                  {item.price} Gold
                </button>
              </div>
            ))}
          </div>

          {/* ====== Inventory heading ====== */}
          <div style={{
            fontSize: "14px",
            fontWeight: "bold",
            color: "#94a3b8",
            marginBottom: "10px",
            textTransform: "uppercase",
            letterSpacing: "1px",
          }}>
            Inventory
          </div>

          {/* ====== Inventory grid ====== */}
          {inventory.length === 0 ? (
            <div style={{
              padding: "20px",
              textAlign: "center",
              color: "#475569",
              fontSize: "13px",
              background: "rgba(30, 41, 59, 0.4)",
              borderRadius: "8px",
              border: "1px dashed #334155",
            }}>
              Inventory is empty
            </div>
          ) : (
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(80px, 1fr))",
              gap: "8px",
            }}>
              {inventory.map((item, idx) => (
                <div
                  key={idx}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "10px 6px",
                    background: "rgba(30, 41, 59, 0.8)",
                    borderRadius: "8px",
                    border: "1px solid #475569",
                    gap: "4px",
                  }}
                >
                  <span style={{ fontSize: "24px" }}>
                    {item === "Potion" ? "\u{1F9EA}" : item === "Iron Sword" ? "\u2694\uFE0F" : "\uD83D\uDCE6"}
                  </span>
                  <span style={{ color: "#cbd5e1", fontSize: "11px", textAlign: "center" }}>
                    {String(item)}
                  </span>
                </div>
              ))}
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

Don't let the code length intimidate you — what it does is very straightforward. Let's go through it section by section:

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

- The Root Component `MyWorld()` is the entry for the world's UI. `<Chat renderBubble={...} />` lets the platform handle the message list, input box, and scrolling — we only take over how an individual bubble looks
- `useYumina()` — Gets the Yumina API so you can read variables and trigger actions
- `msg.messageIndex` — The current bubble's index in the message list, used to check whether it's the last. The shop panel only shows below the last message so it doesn't repeat under every message in the chat
- `msg.contentHtml` — The HTML the platform already rendered from Markdown, can be used directly in `dangerouslySetInnerHTML`

#### Reading variables

```tsx
const gold = Number(api.variables.gold ?? 100);
const inventory = Array.isArray(api.variables.inventory)
  ? api.variables.inventory
  : [];
```

- `api.variables.gold` — Reads the gold variable. `?? 100` is a fallback in case the variable hasn't loaded yet
- `api.variables.inventory` — Reads the inventory variable. We use `Array.isArray()` to confirm it's actually an array, guarding against unexpected data

#### Shop item definitions

```tsx
const shopItems = [
  { name: "Potion",     price: 20, actionId: "buy-potion", icon: "\u{1F9EA}", desc: "Restores a small amount of health" },
  { name: "Iron Sword", price: 50, actionId: "buy-sword",  icon: "\u2694\uFE0F", desc: "A plain iron sword" },
];
```

All item info is defined in a single array, then rendered with `.map()`. Want to add a new item? Just add a line to the array — and of course, create the corresponding behaviors in the editor too.

#### The buy button

```tsx
<button onClick={() => api.executeAction(item.actionId)}>
  {item.price} Gold
</button>
```

This is the most important line. Clicking the button calls `api.executeAction("buy-potion")`, and the engine finds the behavior with action ID `"buy-potion"`, checks conditions, and executes actions. **All the logic (checking gold, deducting it, adding the item, showing the notification) is defined in the behaviors** — the button just triggers them.

#### Button visual feedback

```tsx
background: gold >= item.price
  ? "linear-gradient(135deg, #065f46, #047857)"   // affordable → green
  : "linear-gradient(135deg, #374151, #4b5563)",   // can't afford → gray
cursor: gold >= item.price ? "pointer" : "not-allowed",
opacity: gold >= item.price ? 1 : 0.6,
```

The button's color, cursor style, and opacity change dynamically based on whether the player can afford the item. Affordable items get green buttons; unaffordable ones are grayed out. This is purely visual feedback — the actual purchase logic lives in the behavior conditions.

#### Inventory grid

```tsx
<div style={{
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(80px, 1fr))",
  gap: "8px",
}}>
  {inventory.map((item, idx) => (
    <div key={idx} style={{ /* cell styles */ }}>
      <span>{item === "Potion" ? "\u{1F9EA}" : item === "Iron Sword" ? "\u2694\uFE0F" : "\uD83D\uDCE6"}</span>
      <span>{String(item)}</span>
    </div>
  ))}
</div>
```

Uses CSS Grid to lay out inventory items. `auto-fill` + `minmax(80px, 1fr)` makes the cells adapt to the available width — wider windows show more items per row, narrower windows show fewer. Each cell displays the item's icon and name.

::: tip Don't want to write code? Use Studio AI
At the top of the editor, click **Enter Studio** → AI Assistant panel → describe what you want, e.g., "Build a shop UI with gold display, item list, and inventory grid" — the AI will generate the code for you.
:::

---

### Step 4: Save and test

1. Click **Save** at the top of the editor
2. Click **Start Game** or go back to the home page and open a new session
3. You'll see a shop panel below the AI's reply: 100 gold, two items, empty inventory
4. Click **20 Gold** to buy a potion — gold drops to 80, a potion icon appears in the inventory, and a gold notification says "Purchase successful! You got a Potion."
5. Click it again — gold drops to 60, now there are two potions in the inventory
6. Click **50 Gold** to buy an iron sword — gold drops to 10, the inventory gains a sword
7. Now try buying anything — a yellow warning pops up saying "Not enough gold!", and gold and inventory stay unchanged
8. Continue chatting with the AI — the shop panel stays at the bottom of the latest message, updating in real time

**If something goes wrong:**

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Shop panel doesn't appear | Root Component code wasn't saved or has a syntax error | Check the compile status at the bottom of the Custom UI section — it should show a green "OK" |
| Buttons don't respond to clicks | Action IDs in behaviors don't match the code | Confirm the behavior action IDs are `buy-potion` / `buy-sword`, exactly matching the `executeAction()` arguments in the code |
| Gold is deducted but inventory doesn't change | The push action in the behavior isn't set up correctly | Check the modify variable action: variable should be `inventory`, operation should be `push`, value should be `"Potion"` (with quotes) |
| Not enough gold but no warning appears | The "not enough gold" behavior condition is inverted | Confirm the condition is `gold lt 20` (less than), not `gold gte 20` |
| Inventory items don't show icons | Item names don't match the icon mapping in the code | Confirm the behavior's push value matches the code's icon mapping (`"Potion"` maps to the test tube emoji, etc.) |
| Gold display doesn't update after purchase | Normal — it refreshes with the next message | Send a message and check again, or check whether the notification appeared (if it did, the purchase succeeded) |

---

## Going further: expanding the shop system

Once you've got the basics down, you can use the same patterns to build more complex systems.

### Adding more items

Add a line to the `shopItems` array in the Root Component:

```tsx
const shopItems = [
  { name: "Potion",       price: 20, actionId: "buy-potion", icon: "\u{1F9EA}", desc: "Restores a small amount of health" },
  { name: "Iron Sword",   price: 50, actionId: "buy-sword",  icon: "\u2694\uFE0F", desc: "A plain iron sword" },
  { name: "Shield",       price: 30, actionId: "buy-shield",  icon: "\uD83D\uDEE1\uFE0F", desc: "Provides basic protection" },
  { name: "Magic Scroll", price: 80, actionId: "buy-scroll", icon: "\uD83D\uDCDC", desc: "Unleashes a fireball spell" },
];
```

Then in the editor's Behaviors tab, create two behaviors for each new item (success + insufficient), following the exact same pattern as Potion and Iron Sword.

### Letting the AI know what the player bought

If you want the AI's story to react to purchases (e.g., after buying an iron sword the AI knows the player is armed), add a "Tell AI" action to the purchase-success behavior:

| Action Type | Settings |
|-------------|----------|
| Tell AI | Content: `The player just bought an Iron Sword at the shop. Please reference this weapon in subsequent replies where appropriate.` |

This injects a temporary instruction into the AI's context, letting it know what happened.

### Earning gold

Right now the player can only spend gold, not earn it. You can use behaviors to give the player gold:

- **Per-turn reward**: Create a behavior with the trigger "Every N turns" (e.g., every 3 turns), with the action `Modify Variable gold add 10`. The player automatically earns 10 gold every 3 conversation rounds.
- **Keyword reward**: Use the trigger "AI said keyword" with a keyword like "battle won" or "quest complete". When the AI mentions these words in a reply, gold is automatically added.
- **Manual earn button**: Add a "Work for Gold" button in the Root Component using `executeAction("earn-gold")` to trigger a behavior with the action `gold add 15`.

---

## Quick reference

| What you want | How to do it |
|---------------|-------------|
| Track gold | Create a number variable, category: Resources |
| Track inventory | Create a JSON variable, default `[]`, category: Inventory |
| Deduct gold on purchase | Behavior action: Modify Variable, operation `subtract` |
| Add item on purchase | Behavior action: Modify Variable, operation `push` |
| Check if player can afford it | Behavior condition: `gold gte price` |
| Show "not enough gold" warning | Separate behavior, condition `gold lt price`, action: Show Notification (warning) |
| Show "purchase successful" alert | Behavior action: Show Notification (achievement style) |
| Button triggers purchase | In the Root Component, call `api.executeAction("actionId")` |
| Display inventory grid | In the Root Component, use CSS Grid + `inventory.map()` to render |
| Add more items | Add a line to the shopItems array + create two behaviors in the editor |

---

## Try it yourself — importable demo world

Download this JSON file and import it to experience the complete shop system:

<a href="/recipe-3-demo.json" download>recipe-3-demo.json</a>

**How to import:**
1. Go to Yumina → **My Worlds** → **Create New World**
2. In the editor, click **More Actions** → **Import Package**
3. Select the downloaded `.json` file
4. A new world is created with all variables, behaviors, and Root Component pre-configured
5. Start a new session and try it out

**What's included:**
- 2 variables (`gold` + `inventory`)
- 4 behaviors (potion buy success/insufficient + iron sword buy success/insufficient)
- A Root Component (gold display + item list + inventory grid)

---

::: tip This is Recipe #3
The earlier recipes covered scene jumping and entry modification. This recipe shows you how to combine variable condition checks + JSON arrays + behavior actions into an interactive system. The same pattern works for quest systems, combat systems, crafting systems — anything that needs "check condition → deduct resource → add item → give feedback".
:::

</div>
