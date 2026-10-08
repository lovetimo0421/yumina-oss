<div v-pre>

# Inventory & Equipment

> An inventory the player can open and use: items the story hands out appear in a bag, potions can be drunk (health goes up, the count goes down), and a weapon can be equipped so the AI knows what the player is holding. The bag, the potion and the weapon can all be built without code; a full item grid with per-item buttons is the custom code route at the end.

---

## What you'll build

- **A bag** the player opens from the chat: everything they've picked up, each with a line of description, and a popup when the story hands them something new
- **A potion button**: Health +20, one potion fewer, and "No potions left!" when there are none
- **An equip button**: the weapon slot reads "Iron Sword", and the AI writes the player holding it
- **The AI keeps the bag up to date** as the story goes: loot, rewards, things lost or broken

### How the pieces split

| What | Who handles it | Why |
|------|----------------|-----|
| The list of items picked up in the story | The AI, through the bag variable's Behavior Rules | Only the AI knows when the story hands something over |
| Counting potions and healing | A behavior | Arithmetic should be exact |
| The equipped weapon | A button or a behavior | One value, set when the player chooses |
| Showing all of it | The player interface | Templates and parts, no code |

---

## Step by step

### Step 1: Add the Inventory template

Click **Player interface** in the middle of the top bar, then **Templates**, and add **Inventory** (under **While playing · opened from the chat page's Menu**): "Tap an item to use it; a popup when the story hands you something."

It adds a bag page, a popup on the chat page, and two variables:

| Variable | What it is |
|----------|-----------|
| **Inventory** (List / table) | One row per item, each with a name and a one-line note |
| **Just received** (Text) | What the player just got; the popup shows it and clears it when closed |

Both come with Behavior Rules that tell the AI how to use them. Inventory's reads, in part:

> When the player gets something, push one, and in the same turn set new_item to "item — one line". When used up or lost, delete its index (from 0). Don't hand out items every turn.

The AI follows them in the story, so loot, gifts and rewards land in the bag without you doing anything.

Tapping an item on the bag page sends a line for the player ("(I take out the Old pocket watch)") and goes back to the chat, so the AI plays out using it.

Starting items go into the Inventory variable's **Starts at**, for example:

```json
[{"name": "Iron Sword", "note": "Plain, but well balanced."}]
```

### Step 2: Potions that count

The bag is a list the AI writes. For things that need exact numbers, like how many potions are left, use a Number variable and a behavior.

**Variables** (in the **Add** row, **＋ Variable**):

| Name | Type | Starts at | Range | Notes |
|------|------|-----------|-------|-------|
| Health | Number | `80` | `0` to `100` | Behavior Rules: `Drops when the player is hurt; recovers slowly with rest.` |
| Potions | Number | `2` | `0` to (empty) | Behavior Rules: `How many healing potions the player carries. Add when they find or buy one.` |

Starting Health below the maximum gives the player a reason to try a potion.

**Behavior** (**＋ Behavior**): "Drink a potion"

| Part | Setting |
|------|---------|
| When it fires | **The player presses a button**, Button `drink-potion` |
| ONLY IF | Potions is more than `0` |
| Effects | **Change variable**: Potions minus `1` |
| | **Change variable**: Health plus `20` |
| | **Show notification**: `You drink a potion. Health +20`, style **Success** |
| | **Tell the AI**: `The player just drank a healing potion.` |
| If the conditions don't hold, say | `No potions left!` |

Health can't go over 100: the variable's range caps it.

**Button**: in **Player interface**, on the conversation page or the bag page, add a **Button** labelled "Drink a potion ({Potions} left)" (use **Insert a variable's value…** for the count). Under **When pressed, do in order**, add **Set off a behavior** → Drink a potion.

### Step 3: Equip a weapon

**Variable**: Equipped weapon, Text, starting empty. Behavior Rules:

```
The weapon the player is holding; empty means bare hands. Describe fights with it. If it breaks or is taken in the story, set it back to empty.
```

**Button**: "Equip Iron Sword", with two steps:

1. **Change a variable**: Equipped weapon, **Set to**, `Iron Sword`
2. **Show a notice**: `Equipped Iron Sword`

Give it **When to show** → **When a variable matches**: Equipped weapon **is not** `Iron Sword`, so the button disappears once it's equipped. Next to it, a **Text** part reading `Weapon: {Equipped weapon}` shows the slot.

The AI sees Equipped weapon in its prompt every turn, so its next reply has the player holding the sword. If you want it acknowledged straight away, make the button **Set off a behavior** that changes the variable and adds **Tell the AI** `The player just equipped the Iron Sword.`

### Step 4: Playtest

Click **Play** in the top bar.

1. Health reads 80, Potions 2, weapon slot empty
2. Tap **Drink a potion**: Health 100, Potions 1, a notice appears
3. Tap it twice more: the second time "No potions left!" appears and nothing changes
4. Tap **Equip Iron Sword**: the slot reads Iron Sword and the button disappears. Start a fight; the AI writes the sword into it
5. Play until the story hands you something: the popup shows it, and it's in the bag (**Menu** → Bag)

**If something goes wrong:**

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| The potion button does nothing | The button's behavior and the behavior's Button name don't match | **Set off a behavior** must point at Drink a potion |
| Potions go negative | The **ONLY IF** condition is missing | Add Potions is more than `0` |
| Health goes over 100 | No maximum on Health | Set its **Range** to `0` to `100` |
| Items never show up in the bag | The AI isn't writing to Inventory | Check the Inventory variable still has its Behavior Rules and **AI access** is **AI can read & write** |
| The popup never shows | The AI updates Inventory but not Just received | Keep Just received's Behavior Rules; they ask for both in the same turn |

---

## Why behaviors can't do everything here

Behavior effects change numbers and text (set, add, subtract, multiply, toggle, append text). They can't add a row to a list, find "the potion" inside one, or remove it. Conditions can check whether a list **contains** a plain value, but not look inside rows. That's why this recipe keeps the item list with the AI and counts things that need exact numbers in their own Number variables.

A behavior's **Code** effect can add to a list if you write a line of JavaScript, for example `ctx.push("Inventory", { name: "Potion", note: "Heals a little." })`. See [Behaviors · Code behaviors](/creator/automation#code-behaviors).

When you want both in one place (a real item grid where every item has a count and its own Use or Equip button), write it in the interface code.

---

## Custom code route: an item grid with use and equip

This version keeps the whole inventory in one List / table variable named `inventory`, with a count per item, and handles using and equipping in the interface code. It also uses Number variable `hp` (0 to 100, starting at 80) and Text variable `equipped_weapon`.

`inventory` starts as:

```json
[{"name":"Potion","icon":"🧪","count":2},{"name":"Iron Sword","icon":"⚔️","count":1}]
```

Its Behavior Rules:

```
The player's items. Each is {"name", "icon", "count"}. When the player finds something, push a new item. Leave counts to the inventory buttons.
```

**Panels → Front End Code** → open `index.tsx` and replace the default `return <Chat />`:

```tsx
export default function MyWorld() {
  const api = useYumina();
  const msgs = api.messages || [];

  const hp = Number(api.variables.hp ?? 80);
  const equippedWeapon = String(api.variables.equipped_weapon || "");
  const inventory = Array.isArray(api.variables.inventory) ? api.variables.inventory : [];

  // Use one of an item: count down, remove at zero, apply its effect
  function useItem(itemName) {
    const inv = Array.isArray(api.variables.inventory) ? api.variables.inventory : [];
    const idx = inv.findIndex((it) => it && it.name === itemName);
    if (idx === -1) {
      api.showToast("No " + itemName + " left!", "error");
      return;
    }
    const item = inv[idx];
    const next = inv.slice();
    if (Number(item.count) <= 1) next.splice(idx, 1);
    else next[idx] = { ...item, count: Number(item.count) - 1 };
    api.setVariable("inventory", next);

    if (itemName === "Potion") {
      api.setVariable("hp", Math.min(Number(api.variables.hp ?? 0) + 20, 100));
      api.showToast("Used a potion! HP +20", "success");
      api.injectContext("The player just drank a healing potion.");
    }
  }

  function equipItem(itemName) {
    if (equippedWeapon === itemName) {
      api.showToast(itemName + " is already equipped!", "info");
      return;
    }
    api.setVariable("equipped_weapon", itemName);
    api.showToast("Equipped " + itemName + "!", "success");
    api.injectContext("The player just equipped the " + itemName + ".");
  }

  // Which button each item gets
  const itemActions = {
    "Potion": { type: "consumable", label: "Use", run: () => useItem("Potion") },
    "Iron Sword": { type: "equipment", label: "Equip", run: () => equipItem("Iron Sword") },
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

          {isLastMsg && (
            <div style={{
              marginTop: "16px",
              padding: "16px",
              background: "rgba(15, 23, 42, 0.6)",
              borderRadius: "12px",
              border: "1px solid #334155",
            }}>
              {/* HP bar */}
              <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "14px" }}>
                <span style={{ fontSize: "16px" }}>❤️</span>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                    <span style={{ color: "#94a3b8", fontSize: "12px" }}>HP</span>
                    <span style={{ color: "#e2e8f0", fontSize: "12px", fontWeight: "bold" }}>{hp} / 100</span>
                  </div>
                  <div style={{ height: "8px", background: "#1e293b", borderRadius: "4px", overflow: "hidden" }}>
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

              {/* Weapon slot */}
              <div style={{
                display: "flex", alignItems: "center", gap: "8px", marginBottom: "14px",
                padding: "10px 14px", background: "rgba(30, 41, 59, 0.8)",
                borderRadius: "8px", border: "1px solid #475569",
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

              {/* Item grid */}
              {inventory.length === 0 ? (
                <div style={{
                  padding: "24px", textAlign: "center", color: "#475569", fontSize: "13px",
                  background: "rgba(30, 41, 59, 0.4)", borderRadius: "8px", border: "1px dashed #334155",
                }}>
                  Inventory is empty
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: "8px" }}>
                  {inventory.map((item, idx) => {
                    const name = String(item?.name || item);
                    const action = itemActions[name];
                    const isEquipped = equippedWeapon === name;
                    return (
                      <div key={idx} style={{
                        display: "flex", flexDirection: "column", alignItems: "center", gap: "6px",
                        padding: "12px 8px 8px", background: "rgba(30, 41, 59, 0.8)", borderRadius: "8px",
                        border: isEquipped ? "1px solid #22d3ee" : "1px solid #475569",
                      }}>
                        <span style={{ fontSize: "28px" }}>{String(item?.icon || "📦")}</span>
                        <span style={{ color: "#e2e8f0", fontSize: "12px", fontWeight: "600", textAlign: "center" }}>{name}</span>
                        <span style={{ color: "#64748b", fontSize: "11px" }}>x{Number(item?.count ?? 1)}</span>
                        {action && (
                          <button
                            onClick={action.run}
                            style={{
                              marginTop: "4px", padding: "4px 14px", width: "100%",
                              borderRadius: "6px", fontSize: "12px", fontWeight: "600", cursor: "pointer",
                              background: action.type === "consumable" ? "#047857" : isEquipped ? "#4b5563" : "#1e40af",
                              border: "1px solid " + (action.type === "consumable" ? "#10b981" : isEquipped ? "#6b7280" : "#3b82f6"),
                              color: action.type === "consumable" ? "#a7f3d0" : isEquipped ? "#9ca3af" : "#bfdbfe",
                            }}
                          >
                            {isEquipped ? "Equipped" : action.label}
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

**What the code does:**

- `<Chat renderBubble={...} />` keeps the platform's message list, input box and scrolling; you draw each bubble, and the panel goes under the last one
- `api.variables.inventory`, `.hp` and `.equipped_weapon` read the variables by name
- `useItem` finds the item by name, counts it down (or removes it at zero) and writes the whole list back with `api.setVariable("inventory", next)`. A potion also raises `hp`
- `equipItem` sets `equipped_weapon` and tells the player
- `api.injectContext(text)` slips the AI a line for its next reply, like a behavior's **Tell the AI**
- `api.showToast(text, type)` shows a notice; the type is `"success"`, `"error"` or `"info"`
- `itemActions` decides which items get a button. Add a line for each new usable item

The status next to the file in **Panels → Front End Code** should read a green **OK**.

::: tip Don't want to write code yourself?
Click **Creation assistant** at the top right of the canvas and describe it, for example "an item grid with an HP bar, a weapon slot, and Use/Equip buttons".
:::

### How the AI can change the list

The AI writes list changes as directives at the end of its reply; the engine teaches it the format. Adding works well:

```
You search the goblin and find a small vial. [inventory: push {"name":"Potion","icon":"🧪","count":1}]
```

The AI can also remove by position (`[inventory: delete 0]` removes the first item), but it can't look up "the potion" by name or change one item's count reliably. Keep counting in the buttons, and tell the AI in the Behavior Rules to only add items.

---

## Quick reference

| What you want | How to do it |
|---------------|-------------|
| A bag the AI fills during the story | **Player interface** → **Inventory** template |
| Starting items | The Inventory variable's **Starts at** |
| Exact counts (potions, arrows) | A Number variable per item |
| Use an item with a check | A behavior: **The player presses a button**, **ONLY IF** count is more than 0, **If the conditions don't hold, say** … |
| A button that runs it | Button step **Set off a behavior** |
| Equip something | Button step **Change a variable** on a Text variable |
| Hide a button once it's done | **When to show** → **When a variable matches** |
| Tell the AI about it right away | **Tell the AI** in a behavior, or `api.injectContext()` in code |
| A grid with per-item buttons and counts | Interface code (custom code route above) |

---

::: tip This is Recipe #7
The inventory pairs with the [shop](./shop.md) (gold in, items out) and the [quest tracker](./quest-tracker.md) (items as rewards). The same split works for other lists: let the AI keep the story's list, and give anything that needs exact numbers its own variable.
:::

</div>
