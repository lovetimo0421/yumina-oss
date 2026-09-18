<div v-pre>

# Inventory & Equipment

> Build an inventory grid — show every item the player has collected, with icons and quantities. Consumables can be used (disappear when depleted), equipment can be worn. This recipe shows you how to combine a JSON variable, Root Component logic, and behaviors to build a full inventory system.

---

## What you'll build

An inventory panel embedded in the chat interface. The player sees all their items, each displaying an icon, name, and quantity. Below each item is an action button:

- **Consumables** (e.g. potions) — click "Use" → HP restores by 20 → potion count decreases by 1 → removed from inventory when count hits 0 → popup says "Used a potion! HP +20"
- **Equipment** (e.g. iron sword) — click "Equip" → weapon slot shows "Iron Sword" → AI knows the player is wielding an iron sword → popup says "Equipped Iron Sword!"

```
Player clicks the "Use" button on a potion
  → renderer checks: does inventory contain a potion?
    → yes: update inventory array, hp +20, success toast
    → no: warning toast "No potions left!"

Player clicks the "Equip" button on Iron Sword
  → renderer checks: already equipped?
    → no: triggers "equip-sword" behavior
    → behavior sets equipped_weapon, tells AI, shows notification
    → yes: info toast "Already equipped!"
```

---

## How it works

The inventory is stored as a **JSON variable** — a single variable holding an entire array of item objects. The Root Component reads this array to display the grid, and directly manipulates it using `api.setVariable()` when the player uses or acquires items.

**Why handle logic in the Root Component?** The behavior system's condition operators (`eq`, `neq`, `gt`, `lt`, `contains`, etc.) work on simple values — numbers, strings, booleans. They can't search inside JSON arrays (e.g., "does the array contain an object with name = Potion?"). For complex data structures like inventories, the Root Component is the right place to handle logic using JavaScript.

Behaviors are still used for things they're good at: setting simple variables (`equipped_weapon`), injecting AI instructions ("Tell AI"), and showing notifications.

**The split:**

| What | Where | Why |
|------|-------|-----|
| Display inventory grid | Root Component | Reads the JSON array and renders UI |
| Use a consumable | Root Component | Needs to find, update, and remove array elements |
| Equip a weapon | Behavior | Sets a string variable + tells the AI |
| Tell AI about changes | Behavior | Only behaviors can inject AI instructions |

---

## Step by step

### Step 1: Create the variables

We need 3 variables — inventory (JSON array), hit points (number), and currently equipped weapon (string).

Editor → left sidebar → **Variables** tab → click "Add Variable" for each

#### Variable 1: Inventory

| Field | Value | Why |
|-------|-------|-----|
| Display Name | Inventory | Human-readable label for you |
| ID | `inventory` | The ID used in code and behaviors to read/write this variable |
| Type | JSON | The inventory is an array — needs the JSON type to store it |
| Default Value | `[{"name":"Potion","icon":"🧪","count":2},{"name":"Iron Sword","icon":"⚔️","count":1}]` | New sessions start with 2 potions and 1 iron sword |
| Category | Inventory | Groups it under the Inventory category |
| Behavior Rules | `Inventory buttons handle use and equip actions automatically. You may also add items during the story (player finds loot, receives a reward) or remove items (broken, lost, stolen).` | Tells the AI the inventory can change during the narrative too |

> **The default value of a JSON variable must be valid JSON.** Use double quotes around field names and string values. Each item object has three fields: `name` (for matching and display), `icon` (for the UI), `count` (to track quantity for consumables).

#### Variable 2: Hit Points

| Field | Value | Why |
|-------|-------|-----|
| Display Name | Hit Points | Human-readable label |
| ID | `hp` | Used when potions restore HP |
| Type | Number | HP is numeric — needs add/subtract |
| Default Value | `80` | Starting below max gives the player a reason to use a potion |
| Min Value | `0` | Prevents HP from going negative |
| Max Value | `100` | HP cap of 100, prevents infinite stacking |
| Category | Stats | Character stat variable |
| Behavior Rules | `Current value represents the player's remaining hit points (0-100). Decrease in combat or dangerous situations, increase when using potions or resting.` | Tells the AI when to change HP |

#### Variable 3: Equipped Weapon

| Field | Value | Why |
|-------|-------|-----|
| Display Name | Equipped Weapon | Human-readable label |
| ID | `equipped_weapon` | Records the name of the player's equipped weapon |
| Type | String | Stores the weapon name as text |
| Default Value | *(leave empty)* | Empty string = no weapon equipped |
| Category | Custom | Equipment state variable |
| Behavior Rules | `Current value is the name of the player's equipped weapon. Empty string means nothing equipped. The equip button sets this automatically, but you may also change it during the story — e.g. weapon breaks, gets stolen, or player finds a new one.` | Tells the AI that equipment state can change narratively too |

> **Why use a string for equipped_weapon instead of JSON?** Because the player can only wield one weapon at a time. A simple string is enough — empty means unequipped, `"Iron Sword"` means equipped. If you want a multi-slot equipment system (weapon + armor + accessory), you could use a JSON object instead.

---

### Step 2: Create the behaviors

We need 2 behaviors — equip iron sword (success and already equipped). Potion usage is handled entirely in the Root Component.

Editor → **Behaviors** tab → click "Add Behavior"

#### Behavior 1: Equip Iron Sword (success)

**WHEN (trigger):**

| Field | Value | Why |
|-------|-------|-----|
| Trigger Type | Action button pressed | Fires when the Root Component calls `executeAction("equip-sword")` |
| Action ID | `equip-sword` | Matches the `executeAction("equip-sword")` call in the Root Component |

**ONLY IF (conditions):**

| Variable | Operator | Value | Why |
|----------|----------|-------|-----|
| `equipped_weapon` | neq | `Iron Sword` | Not already equipped — prevents overlap with Behavior 2 |

**DO (effects):**

Add these effects in order:

| Effect Type | Settings | What it does |
|-------------|----------|-------------|
| Modify Variable | Variable `equipped_weapon`, operation `set`, value `Iron Sword` | Set current weapon to Iron Sword |
| Tell AI | Content: `The player equipped an Iron Sword. From now on, the player is wielding an iron longsword. Reflect the weapon's presence in combat descriptions and interactions.` | Injects an instruction so the AI knows about the weapon |
| Show Notification | Message `Equipped Iron Sword!`, style `achievement` | Gold success popup |

> **What does "Tell AI" do?** It injects a temporary instruction into the AI's context. This way, when the AI writes its next response, it knows the player just equipped a sword and can reflect it in the narrative (e.g., "You tighten your grip on the iron sword. Its cold edge glints in the firelight.").

#### Behavior 2: Equip Iron Sword (already equipped)

**WHEN:**

| Field | Value |
|-------|-------|
| Trigger Type | Action button pressed |
| Action ID | `equip-sword` |

**ONLY IF:**

| Variable | Operator | Value | Why |
|----------|----------|-------|-----|
| `equipped_weapon` | eq | `Iron Sword` | Already equipped — no need to equip again |

**DO:**

| Effect Type | Settings | What it does |
|-------------|----------|-------------|
| Show Notification | Message `Iron Sword is already equipped!`, style `info` | Blue info popup |

> **Why split this into two behaviors?** Same pattern as the shop recipe — a single behavior can only have one set of conditions. If the conditions pass, it executes; if they don't, nothing happens. So we use two behaviors to cover both cases. They listen on the same action ID, but their conditions are mutually exclusive — only one ever fires.

> **Why no "use-potion" behavior?** Because checking whether a JSON array contains a specific item requires JavaScript — the behavior system's `contains` operator only works on strings, not arrays. So potion logic lives in the Root Component where we have full JavaScript access. The Root Component updates the `inventory` and `hp` variables directly via `api.setVariable()`.

---

### Step 3: Add the inventory panel in the Root Component

This is the step that makes the inventory UI appear in the chat. We'll display three sections below the latest message: an HP bar, an equipment slot, and an inventory grid (each item with an action button).

Editor → **Custom UI** section → open `index.tsx` → paste the following (replacing the default `return <Chat />`):

```tsx
export default function MyWorld() {
  var api = useYumina();
  var msgs = api.messages || [];

  // Read variables
  var hp = Number(api.variables.hp ?? 80);
  var equippedWeapon = String(api.variables.equipped_weapon || "");
  var inventory = Array.isArray(api.variables.inventory)
    ? api.variables.inventory
    : [];

  // ── Inventory logic (runs in the Root Component) ──

  function useItem(itemName) {
    var inv = Array.isArray(api.variables.inventory)
      ? api.variables.inventory
      : [];
    var idx = -1;
    for (var i = 0; i < inv.length; i++) {
      if (inv[i] && inv[i].name === itemName) { idx = i; break; }
    }
    if (idx === -1) {
      api.showToast("No " + itemName + " left!", "error");
      return;
    }
    var item = inv[idx];
    var newInv = inv.slice(); // copy the array
    if (Number(item.count) <= 1) {
      newInv.splice(idx, 1); // remove entirely
    } else {
      newInv[idx] = { name: item.name, icon: item.icon, count: Number(item.count) - 1 };
    }
    api.setVariable("inventory", newInv);

    // Potion-specific: restore HP
    if (itemName === "Potion") {
      var currentHp = Number(api.variables.hp ?? 0);
      api.setVariable("hp", Math.min(currentHp + 20, 100));
      api.showToast("Used a potion! HP +20", "success");
    }
  }

  function equipItem(itemName, actionId) {
    if (equippedWeapon === itemName) {
      api.showToast(itemName + " is already equipped!", "info");
      return;
    }
    api.executeAction(actionId); // triggers the behavior for set + Tell AI
  }

  // Item type map: decides what action each item gets
  var itemActions = {
    "Potion": { type: "consumable", handler: function() { useItem("Potion"); }, label: "Use" },
    "Iron Sword": { type: "equipment", handler: function() { equipItem("Iron Sword", "equip-sword"); }, label: "Equip" },
  };

  return (
    <Chat renderBubble={(msg) => {
      var isLastMsg = msg.messageIndex === msgs.length - 1;
      return (
    <div>
      {/* Render message text normally (platform already rendered HTML, use contentHtml directly) */}
      <div
        style={{ color: "#e2e8f0", lineHeight: 1.7 }}
        dangerouslySetInnerHTML={{ __html: msg.contentHtml }}
      />

      {/* Show inventory panel only below the last message */}
      {isLastMsg && (
        <div style={{
          marginTop: "16px",
          padding: "16px",
          background: "rgba(15, 23, 42, 0.6)",
          borderRadius: "12px",
          border: "1px solid #334155",
        }}>

          {/* ====== HP Bar ====== */}
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            marginBottom: "14px",
          }}>
            <span style={{ fontSize: "16px" }}>❤️</span>
            <div style={{ flex: 1 }}>
              <div style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: "4px",
              }}>
                <span style={{ color: "#94a3b8", fontSize: "12px" }}>HP</span>
                <span style={{ color: "#e2e8f0", fontSize: "12px", fontWeight: "bold" }}>
                  {hp} / 100
                </span>
              </div>
              <div style={{
                height: "8px",
                background: "#1e293b",
                borderRadius: "4px",
                overflow: "hidden",
              }}>
                <div style={{
                  height: "100%",
                  width: Math.min(hp, 100) + "%",
                  background: hp > 50
                    ? "linear-gradient(90deg, #22c55e, #4ade80)"
                    : hp > 20
                      ? "linear-gradient(90deg, #eab308, #facc15)"
                      : "linear-gradient(90deg, #ef4444, #f87171)",
                  borderRadius: "4px",
                  transition: "width 0.3s ease",
                }} />
              </div>
            </div>
          </div>

          {/* ====== Equipment Slot ====== */}
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            marginBottom: "14px",
            padding: "10px 14px",
            background: "rgba(30, 41, 59, 0.8)",
            borderRadius: "8px",
            border: "1px solid #475569",
          }}>
            <span style={{ fontSize: "16px" }}>⚔️</span>
            <span style={{ color: "#94a3b8", fontSize: "13px" }}>Weapon:</span>
            <span style={{
              color: equippedWeapon ? "#e2e8f0" : "#475569",
              fontSize: "13px",
              fontWeight: equippedWeapon ? "600" : "normal",
              fontStyle: equippedWeapon ? "normal" : "italic",
            }}>
              {equippedWeapon || "None"}
            </span>
          </div>

          {/* ====== Inventory Header ====== */}
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

          {/* ====== Inventory Grid ====== */}
          {inventory.length === 0 ? (
            <div style={{
              padding: "24px",
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
              gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
              gap: "8px",
            }}>
              {inventory.map(function(item, idx) {
                var name = String(item?.name || item);
                var icon = String(item?.icon || "📦");
                var count = Number(item?.count ?? 1);
                var action = itemActions[name];

                return (
                  <div
                    key={idx}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      padding: "12px 8px 8px",
                      background: "rgba(30, 41, 59, 0.8)",
                      borderRadius: "8px",
                      border: equippedWeapon === name
                        ? "1px solid #22d3ee"
                        : "1px solid #475569",
                      gap: "6px",
                    }}
                  >
                    <span style={{ fontSize: "28px" }}>{icon}</span>
                    <span style={{
                      color: "#e2e8f0",
                      fontSize: "12px",
                      fontWeight: "600",
                      textAlign: "center",
                    }}>
                      {name}
                    </span>
                    <span style={{
                      color: "#64748b",
                      fontSize: "11px",
                    }}>
                      x{count}
                    </span>

                    {/* Action button */}
                    {action && (
                      <button
                        onClick={action.handler}
                        style={{
                          marginTop: "4px",
                          padding: "4px 14px",
                          background: action.type === "consumable"
                            ? "linear-gradient(135deg, #065f46, #047857)"
                            : equippedWeapon === name
                              ? "linear-gradient(135deg, #374151, #4b5563)"
                              : "linear-gradient(135deg, #1e3a5f, #1e40af)",
                          border: action.type === "consumable"
                            ? "1px solid #10b981"
                            : equippedWeapon === name
                              ? "1px solid #6b7280"
                              : "1px solid #3b82f6",
                          borderRadius: "6px",
                          color: action.type === "consumable"
                            ? "#a7f3d0"
                            : equippedWeapon === name
                              ? "#9ca3af"
                              : "#bfdbfe",
                          fontSize: "12px",
                          fontWeight: "600",
                          cursor: "pointer",
                          width: "100%",
                        }}
                      >
                        {equippedWeapon === name ? "Equipped" : action.label}
                      </button>
                    )}
                  </div>
                );
              })}
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
var api = useYumina();
var msgs = api.messages || [];
// ...
<Chat renderBubble={(msg) => {
  var isLastMsg = msg.messageIndex === msgs.length - 1;
  // ...
}} />
```

- The Root Component `MyWorld()` is the entry for the world's UI. `<Chat renderBubble={...} />` lets the platform handle the message list, input box, and scrolling — you only take over the look of each bubble
- `useYumina()` — grabs the Yumina API so you can read variables and trigger actions
- `msg.messageIndex` — the current bubble's index in the message list. The inventory panel only renders below the last message, so it doesn't repeat on every single one
- `msg.contentHtml` — the HTML the platform already rendered from Markdown, can be passed directly to `dangerouslySetInnerHTML`

#### Reading variables

```tsx
var hp = Number(api.variables.hp ?? 80);
var equippedWeapon = String(api.variables.equipped_weapon || "");
var inventory = Array.isArray(api.variables.inventory)
  ? api.variables.inventory
  : [];
```

- `api.variables.hp` — reads the hit points. `?? 80` is a fallback in case the variable hasn't loaded yet
- `api.variables.equipped_weapon` — reads the current weapon. Empty string means nothing equipped
- `api.variables.inventory` — reads the inventory. `Array.isArray()` guards against unexpected types

#### Inventory logic functions

```tsx
function useItem(itemName) {
  var inv = Array.isArray(api.variables.inventory)
    ? api.variables.inventory : [];
  var idx = -1;
  for (var i = 0; i < inv.length; i++) {
    if (inv[i] && inv[i].name === itemName) { idx = i; break; }
  }
  if (idx === -1) {
    api.showToast("No " + itemName + " left!", "error");
    return;
  }
  // ... update array and call api.setVariable()
}
```

This is the key pattern. Since the behavior system's condition operators can't search inside JSON arrays, we handle the logic right here in the Root Component:

1. **Find the item** — loop through the array and match by `name`
2. **Check if it exists** — if not found, show an error toast
3. **Update the array** — decrease count or remove entirely
4. **Write it back** — call `api.setVariable("inventory", newInv)` to persist the change

For equipment, `equipItem()` delegates to `api.executeAction()` because the behavior handles setting the variable and injecting an AI instruction:

```tsx
function equipItem(itemName, actionId) {
  if (equippedWeapon === itemName) {
    api.showToast(itemName + " is already equipped!", "info");
    return;
  }
  api.executeAction(actionId);
}
```

#### Item type map

```tsx
var itemActions = {
  "Potion": { type: "consumable", handler: function() { useItem("Potion"); }, label: "Use" },
  "Iron Sword": { type: "equipment", handler: function() { equipItem("Iron Sword", "equip-sword"); }, label: "Equip" },
};
```

A lookup table. Given an item's name, it tells you the button label and the handler function to call. The `type` field controls button color — consumables get green, equipment gets blue. Want to add a new item? Add a line here. For consumables, add logic to `useItem`. For equipment, create a matching behavior in the editor.

#### Action button

```tsx
<button onClick={action.handler}>
  {equippedWeapon === name ? "Equipped" : action.label}
</button>
```

Clicking the button calls the handler function directly. For consumables, the handler manages the array in JavaScript. For equipment, the handler calls `api.executeAction()` which triggers the corresponding behavior.

::: tip Don't want to write code yourself? Use Studio AI
Editor top bar → click "Enter Studio" → AI Assistant panel → describe what you want in plain language, e.g. "Build an inventory grid with an HP bar, equipment slot, and items that can be used or equipped" — the AI will generate the code for you.
:::

---

### Step 4: Save and test

1. Click **Save** at the top of the editor
2. Click **Start Game** or go back to the home page and start a new session
3. You'll see the inventory panel below the AI's response: HP 80/100, weapon slot empty, 2 potions and 1 iron sword
4. Click "Use" on a potion — HP goes from 80 to 100, the potion disappears, toast says "Used a potion! HP +20"
5. Click "Equip" on Iron Sword — weapon slot shows "Iron Sword", button turns gray and says "Equipped", popup says "Equipped Iron Sword!"
6. Click the "Equipped" button on Iron Sword again — toast says "Iron Sword is already equipped!"
7. Keep chatting with the AI — if you added the "Tell AI" effect, the AI's response will reflect the player wielding an iron sword

**If something isn't working:**

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Inventory panel doesn't appear | Root Component code wasn't saved or has a syntax error | Check the compile status at the bottom of the Custom UI section — it should show a green "OK" |
| Inventory shows no items | JSON variable default value has bad formatting | Make sure the default is a valid JSON array with double-quoted field names |
| Button does nothing when clicked | Behavior action ID doesn't match the code | Confirm the behavior's action ID is exactly `equip-sword`, matching the `executeAction()` argument in the code |
| Potion was used but didn't disappear | `useItem` function can't find the item name | Make sure the item's `name` field in the JSON matches exactly what `useItem()` looks for, including capitalization |
| HP didn't change | `api.setVariable` call isn't reaching the right variable | Check the variable ID is exactly `hp` — must match the variable definition |
| Equipped but AI doesn't know | Missing "Tell AI" effect | Add a "Tell AI" effect inside the equip behavior's DO section |

---

## How the AI can modify inventory

The AI can also add or remove items during the story using directives. Since the inventory is a JSON variable, the AI can use the `push` directive to add items:

```
You defeated the goblin and found a health potion among its belongings.
[inventory: push {"name":"Potion","icon":"🧪","count":1}]
```

::: warning Limitations of AI directives on arrays
The `push` directive works well for adding items. However, `delete` on arrays only works with a numeric index (e.g., `[inventory: delete 0]` removes the first element), and `merge` only works on plain objects, not arrays. For complex inventory operations (removing a specific item by name, updating item counts), use the Root Component's JavaScript logic or design your system so the AI communicates intent through other variables that behaviors can act on.
:::

---

## Quick reference

| What you want | How to do it |
|---------------|-------------|
| Store a list of items | Create a JSON variable with a default value of `[{...}, ...]` |
| Display an inventory grid | In the Root Component, use CSS Grid + `inventory.map()` |
| Use a consumable | Root Component: find item → update array → `api.setVariable()` → show toast |
| Equip an item | Root Component: call `api.executeAction()` → Behavior: set variable + Tell AI |
| Check if player owns an item | Root Component: `inventory.find(i => i.name === "ItemName")` |
| Add an item (AI) | AI directive: `[inventory: push {"name":"Item","icon":"📦","count":1}]` |
| Track current equipment | Create a string variable — empty string = nothing equipped |
| Button triggers use/equip | In the Root Component, call handler functions or `api.executeAction("actionId")` |
| Let the AI know about changes | Add a "Tell AI" effect in the behavior |

---

## Try it yourself — importable demo world

Download this JSON and import it as a new world to see everything in action:

<a href="/recipe-7-demo.json" download>recipe-7-demo.json</a>

**How to import:**
1. Go to Yumina → **My Worlds** → **Create New World**
2. In the editor, click **More Actions** → **Import Package**
3. Select the downloaded `.json` file
4. The world is created with all variables, behaviors, and Root Component pre-configured
5. Start a new session and try it out

**What's included:**
- 3 variables (`inventory` + `hp` hit points + `equipped_weapon` current weapon)
- 2 behaviors (equip iron sword success + already equipped)
- A Root Component (HP bar + equipment slot + inventory grid + action buttons + use/equip logic)

---

::: tip This is Recipe #7
Earlier recipes covered scene jumping, combat systems, shop interfaces, and character creation. This recipe teaches you how to manage a JSON array inventory using Root Component JavaScript logic combined with behaviors for simple state changes. The same pattern works for quest logs, skill trees, crafting recipes — anything that needs "manage a list, perform operations on its elements."
:::

</div>
