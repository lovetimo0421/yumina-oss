<div v-pre>

# Shop & Trading

> A shop the player can buy from: they see their gold and what's for sale, tap "Buy", the gold comes off, and they're told what they got. Not enough gold, and they're told that instead. One behavior runs the whole shop; each button just tells it which item and what price.

---

## What you'll build

- **Gold on screen**
- **A shop page** with a Buy button per item: Potion (20 gold), Iron Sword (50 gold)
- **A purchase**: gold goes down by the price, a notice says what was bought, and the AI is told
- **Not enough gold**: "Not enough gold — Iron Sword costs 50." Nothing is taken
- **Purchases end up in the player's inventory**

### How it works

```
The player taps "Buy Iron Sword"
  → The button sets off the behavior "Buy", passing item = Iron Sword, price = 50
  → The behavior checks: Gold ≥ {param.price}?
    → Yes: Gold minus {param.price}, notice "You bought an Iron Sword", the AI is told
    → No: the notice from "If the conditions don't hold, say", and nothing else happens
```

`{param.price}` and `{param.item}` stand for whatever the button passed in. That's why one behavior is enough for any number of items.

---

## Step by step

### Step 1: Create the variables

In the **Add** row at the bottom of the card, click **＋ Variable**.

#### Gold

| Field | Value |
|-------|-------|
| Name | Gold |
| Type | Number |
| Starts at | `100` |
| Range | `0` to (empty) |
| Behavior Rules | `The player's gold. The shop takes its prices off automatically. You may also change it in the story: quest rewards, robbery, a treasure chest.` |

The minimum of `0` is a safety net: the behavior already checks the player can afford it, but with the range set, gold can never show a negative number.

Click **Show on the player screen** so Gold is always visible in chat.

#### Inventory

The easiest inventory comes from **Player interface** → **Templates** → **Inventory**: a bag page, a popup when something new arrives, and an **Inventory** list variable whose Behavior Rules tell the AI to add items as the story hands them over. See the [Inventory & Equipment](./inventory.md) recipe.

---

### Step 2: Create one "Buy" behavior

In the **Add** row, click **＋ Behavior**.

| Part | Setting |
|------|---------|
| When it fires | **The player presses a button**, Button `buy` |
| ONLY IF | Gold **≥** `{param.price}` |
| Effects | **Change variable**: Gold minus `{param.price}` |
| | **Show notification**: `You bought: {param.item}`, style **Success** |
| | **Tell the AI**: `The player just bought {param.item} for {param.price} gold. Add it to their Inventory.` |
| If the conditions don't hold, say | `Not enough gold — {param.item} costs {param.price}.` |

Without the last line, a player who can't afford something would tap the button and see nothing happen.

**Tell the AI** slips the AI one line for its next reply. With the Inventory template's Behavior Rules, the AI adds the item to the bag and pops up the "You got" notice.

::: info Getting the item into the inventory reliably
Behavior effects can change numbers and text, but they can't add a row to a list. Here the AI adds the item, prompted by **Tell the AI**. If you need it to be exact:

- **Counted items as numbers**: give potions their own Number variable and make a separate "Buy potion" behavior that also does **Change variable** Potions plus `1`
- **A Code effect**: add **Code** to the behavior's effects with a line like `ctx.push("Inventory", { name: "Potion", note: "Heals a little." })`. See [Behaviors · Code behaviors](/creator/automation#code-behaviors)
- **Interface code**: the custom code route below writes the list itself
:::

---

### Step 3: Build the shop page

Click **Player interface** in the middle of the top bar. Add a page with **New page** (a **Blank page**) and call it "Shop".

1. Add a **Text** part reading `Gold: {Gold}` (use **Insert a variable's value…**)
2. For each item, add a **Text** part with its name and description, and a **Button** labelled `Buy · 20 gold`
3. Under the button's **When pressed, do in order**, add **Set off a behavior** → Buy, then **+ Pass something in** twice: `item` = `Potion` and `price` = `20`. For the sword: `Iron Sword` and `50`
4. Add a button with **Go to page** back to the conversation, and a "Shop" button on the conversation page that goes to this one

To show which items the player can't afford, duplicate a Buy button, make the copy look greyed out, and use **When to show** → **When a variable matches**: Gold **is less than** `20` on the grey one and Gold **is at least** `20` on the normal one. The grey one can still set off the behavior, so tapping it gives the "Not enough gold" notice.

Turn **Edit** off to click through the page. The preview doesn't call the AI, but you'll see the gold change.

::: tip Prices that change
A price can come from a variable: in **+ Pass something in**, write `{{Potion price}}` instead of `20`. Change the variable (a behavior during a festival, say) and every button follows.
:::

---

### Step 4: Playtest

Click **Play** in the top bar.

1. Gold reads 100. Open the **Shop**
2. Buy a potion: Gold 80, "You bought: Potion". Send a message; the AI acknowledges it and the potion appears in the bag
3. Buy another: Gold 60
4. Buy the sword: Gold 10
5. Try to buy anything: "Not enough gold — Potion costs 20." Gold stays at 10

**This turn** on the right of the playtest shows whether the Buy behavior fired, and why not if it didn't.

**If something goes wrong:**

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Tapping Buy does nothing | The button's **Set off a behavior** points elsewhere, or the behavior isn't **Enabled** | Check both |
| Gold doesn't change | The passed value is named differently from the behavior's `{param.…}` | `price` on the button, `{param.price}` in the behavior, spelled the same |
| No message when gold is short | **If the conditions don't hold, say** is empty | Write the line |
| Gold goes negative | The condition is missing, or Gold has no minimum | Keep the **ONLY IF**, and set **Range** to start at `0` |
| The item never shows in the bag | The AI didn't add it | Keep **Tell the AI** in the behavior and the Inventory variable's Behavior Rules, or use one of the exact routes above |

---

## Custom code route: a shop panel under the chat

This version draws the shop in the interface code. It still uses the **Buy** behavior for the gold check, so prices and the "not enough gold" message stay on the canvas, and it adds the item to an `inventory` list itself once the purchase goes through. It assumes a List / table variable named `inventory` starting at `[]`.

**Panels → Front End Code** → open `index.tsx` and replace the default `return <Chat />`:

```tsx
export default function MyWorld() {
  const api = useYumina();
  const msgs = api.messages || [];

  const gold = Number(api.variables["Gold"] ?? 0);
  const inventory = Array.isArray(api.variables.inventory) ? api.variables.inventory : [];

  const shopItems = [
    { name: "Potion",     price: 20, icon: "🧪", desc: "Restores a little health" },
    { name: "Iron Sword", price: 50, icon: "⚔️", desc: "A plain iron sword" },
  ];

  const buy = async (item) => {
    // Run the "buy" behavior and wait for it; firedIds is empty if its
    // condition failed (it shows its own "not enough gold" notice)
    const result = await api.executeActionAndWait("buy", { item: item.name, price: item.price });
    if (result.firedIds.length > 0) {
      const current = Array.isArray(api.variables.inventory) ? api.variables.inventory : [];
      api.setVariable("inventory", [...current, item.name]);
    }
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
              {/* Gold */}
              <div style={{
                display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px",
                padding: "10px 14px", background: "linear-gradient(135deg, #78350f, #92400e)",
                borderRadius: "8px", border: "1px solid #b45309",
              }}>
                <span style={{ fontSize: "20px" }}>💰</span>
                <span style={{ color: "#fde68a", fontSize: "16px", fontWeight: "bold" }}>{gold} Gold</span>
              </div>

              {/* Items for sale */}
              <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "16px" }}>
                {shopItems.map((item) => {
                  const affordable = gold >= item.price;
                  return (
                    <div key={item.name} style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      padding: "10px 14px", background: "rgba(30, 41, 59, 0.8)",
                      borderRadius: "8px", border: "1px solid #475569",
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                        <span style={{ fontSize: "22px" }}>{item.icon}</span>
                        <div>
                          <div style={{ color: "#e2e8f0", fontSize: "14px", fontWeight: "600" }}>{item.name}</div>
                          <div style={{ color: "#64748b", fontSize: "12px" }}>{item.desc}</div>
                        </div>
                      </div>
                      <button
                        onClick={() => buy(item)}
                        style={{
                          padding: "6px 16px", borderRadius: "6px", fontSize: "13px", fontWeight: "600", whiteSpace: "nowrap",
                          background: affordable ? "#047857" : "#4b5563",
                          border: "1px solid " + (affordable ? "#10b981" : "#6b7280"),
                          color: affordable ? "#a7f3d0" : "#9ca3af",
                          cursor: "pointer",
                          opacity: affordable ? 1 : 0.6,
                        }}
                      >
                        {item.price} Gold
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* Inventory */}
              {inventory.length === 0 ? (
                <div style={{
                  padding: "20px", textAlign: "center", color: "#475569", fontSize: "13px",
                  background: "rgba(30, 41, 59, 0.4)", borderRadius: "8px", border: "1px dashed #334155",
                }}>
                  Inventory is empty
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(80px, 1fr))", gap: "8px" }}>
                  {inventory.map((name, idx) => {
                    const def = shopItems.find((s) => s.name === String(name));
                    return (
                      <div key={idx} style={{
                        display: "flex", flexDirection: "column", alignItems: "center", gap: "4px",
                        padding: "10px 6px", background: "rgba(30, 41, 59, 0.8)",
                        borderRadius: "8px", border: "1px solid #475569",
                      }}>
                        <span style={{ fontSize: "24px" }}>{def ? def.icon : "📦"}</span>
                        <span style={{ color: "#cbd5e1", fontSize: "11px", textAlign: "center" }}>{String(name)}</span>
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

- `api.executeActionAndWait("buy", { item, price })` sets off the Buy behavior with the same values a player interface button would pass, and waits for it to finish
- `result.firedIds` lists the behaviors that ran. Empty means the condition failed: the behavior has already shown its "not enough gold" notice, and nothing is added
- `api.setVariable("inventory", [...current, item.name])` adds the item to the list
- Unaffordable items are greyed out but still tappable, so the player gets the notice
- `repeat(auto-fill, minmax(80px, 1fr))` fits as many inventory cells per row as the width allows

If you use this route, change the behavior's **Tell the AI** line to `The player just bought {param.item} for {param.price} gold.` so the AI doesn't also add the item.

The status next to the file in **Panels → Front End Code** should read a green **OK**.

::: tip Don't want to write code yourself?
Click **Creation assistant** at the top right of the canvas and describe the shop you want.
:::

---

## Going further

### More items

Add a button (or a line in `shopItems`) with its own item and price. The behavior doesn't change.

### Selling

A second behavior "Sell", Button `sell`, with Gold plus `{param.price}` and **Tell the AI** `The player sold {param.item}. Remove it from their Inventory.`

### Earning gold

- **Every N turns** (say `3`): **Change variable** Gold plus `10`
- **AI says keyword** `you win the fight, the reward is yours`: Gold plus `25` (any one keyword fires it)
- The AI itself, through Gold's Behavior Rules, for loot and rewards in the story
- Quest rewards from the [quest tracker](./quest-tracker.md)

### A shopkeeper who haggles

For a merchant who answers in character and sometimes gives a discount, add a UI-based [AI](/creator/ais) with an **Answer format** field for the price, and call it from a button with **Call an AI**.

---

## Quick reference

| What you want | How to do it |
|---------------|-------------|
| Track gold | A Number variable with a minimum of `0` |
| One behavior for the whole shop | **The player presses a button**, values read as `{param.item}` / `{param.price}` |
| Pass the item and price | Button step **Set off a behavior** → **+ Pass something in** |
| Check the player can afford it | **ONLY IF** Gold **≥** `{param.price}` |
| Tell them when they can't | **If the conditions don't hold, say** |
| Confirm the purchase | **Show notification**, style **Success** |
| Get the item into the inventory | **Tell the AI** + the Inventory template, a Number variable per item, a **Code** effect, or interface code |
| Grey out what they can't afford | Two versions of the button with **When to show** |
| Run the same behavior from code | `api.executeActionAndWait("buy", { item, price })` |

---

::: tip This is Recipe #3
A button passing values to one behavior works for anything priced or chosen from a menu: crafting, training, hiring. See [Behaviors · Passing a value from a button](/creator/automation#passing-a-value-from-a-button).
:::

</div>
