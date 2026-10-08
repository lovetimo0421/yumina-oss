<div v-pre>

# Dynamic AI Personality Switching

> A few buttons that change how the AI narrates: normal, comedy, horror. The player taps one and the AI's next reply is written in that style. The style text lives in lore entries that only reach the AI while a variable says so, so no code is needed.

---

## What you'll build

- **Three modes**: Normal, Comedy, Horror
- **One tap to switch**: the next reply uses the new style; the conversation carries on
- **The current mode is visible**: the player can see which mode is on
- **Switching back is clean**: the old style stops reaching the AI the moment the mode changes

### How it works

```
Player taps "Comedy"
  → The button sets the variable Mode to "comedy"
  → The lore entry "Comedy style" only goes to the AI while Mode = comedy, so it's in
  → The lore entry "Horror style" only goes while Mode = horror, so it's out
  → The AI's next reply is written in the comedy style
```

Each style is an ordinary lore entry with a condition on it. Nothing has to be switched off by hand, because only one condition can be true at a time.

---

## Step by step

### Step 1: Create the variable

In the **Add** row at the bottom of the card, click **＋ Variable**.

| Field | Value |
|-------|-------|
| Name | Mode |
| Type | Text |
| Starts at | `normal` |

Open **What the AI does with it** and set **AI access** to **AI read-only**. The player's buttons change the mode; the AI should only follow it. With the engine enforcing this, you don't need "don't touch this" in the Behavior Rules.

To show the mode in chat, click **Show on the player screen**.

---

### Step 2: Write one lore entry per style

Add two lore entries (the **＋** in the top right of **Character and world**, or **Add** in the toolbar).

#### Entry: Comedy style

```
[Narration style: Comedy]
Narrate everything in a humorous, comedic tone. You may:
- Use exaggerated metaphors and absurd comparisons
- Now and then break the fourth wall with an aside to the reader
- Give NPCs badly timed lines
- Describe serious scenes in a light voice for contrast
Keep the story moving. Humour goes into the narration; it doesn't replace it.
```

#### Entry: Horror style

```
[Narration style: Horror]
Narrate everything with a dark, unsettling atmosphere. You should:
- Slow the pacing down in scene descriptions and dwell on sounds, smells and textures
- Hint that something is watching from the shadows, without ever showing it
- Make the surroundings feel wrong: doors that close by themselves, shadows that move the wrong way, a reflection half a beat late
- Give NPCs lines that are slightly off, as if they know something they shouldn't
- Sometimes describe the character's body in second person: the hair on the neck rising, the heartbeat speeding up
Keep the tension building, but don't put a monster in every paragraph. Leave the worst of it unknown.
```

Normal mode needs no entry. When neither style entry is in, the AI writes the way your character and world entries already tell it to.

#### Put a condition on each entry

Drag the **Mode** variable onto the "Comedy style" entry. A line appears between them; click it and set the condition to Mode **is** `comedy`. Do the same for "Horror style" with `horror`.

The entries move into the conditional lore block: they're sent only while their condition holds. (You can also set this by opening the entry and clicking **When the AI sees this** at the bottom.)

::: tip Where the style text goes
Entries are placed in the AI's prompt with the rest of your lore. If the AI keeps slipping back to its old voice, open the entry and set **Inject into** to **At the end**: that text comes after the whole conversation, right before the AI replies, which is where the AI pays the most attention.
:::

---

### Step 3: Add the buttons

Click **Player interface** in the middle of the top bar. On the conversation page, add three **Button** parts (**Add a part** → **Button**), labelled Normal, Comedy and Horror. Under **When pressed, do in order**, give each one:

1. **Change a variable**: Mode, **Set to**, `normal` / `comedy` / `horror`
2. **Show a notice**: `Switched to Comedy mode` (or the matching mode)

To highlight the active one, duplicate a button, give the copy a different look, and use **When to show** → **When a variable matches** so it only shows while Mode is that value. Put the plain version on top of it with the opposite condition (Mode **is not** that value).

Turn **Edit** off and tap the buttons. This preview doesn't call the AI, but you can watch Mode change.

::: info Doing it with a behavior instead
If you'd rather keep the switching logic on the canvas, make one behavior per mode: **When it fires**: **The player presses a button**, Button `mode-comedy`; **Effects**: **Change variable** Mode to `comedy`, **Show notification** `Switched to Comedy mode`. Then each button only needs one step: **Set off a behavior**. Interface code can fire the same behavior with `api.executeAction("mode-comedy")`.
:::

---

### Step 4: Playtest

Click **Play** in the top bar.

1. Chat for a couple of turns in Normal mode
2. Tap **Comedy**. The notice appears and Mode reads comedy
3. Send a message. The reply turns humorous, and may break the fourth wall
4. Tap **Horror** and send another message. The reply turns dark and tense
5. Tap **Normal** and send one more. The narration goes back to your card's own style

**This turn** on the right of the playtest lists the lore entries the AI got, so you can check that only one style entry is in.

**If something goes wrong:**

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Tapping a button does nothing | The button has no **Change a variable** step | Select the button and check **When pressed, do in order** |
| Mode changes but the style doesn't | The entry's condition doesn't match the value | The button sets `comedy`; the condition must check for `comedy` exactly |
| Both styles reach the AI | One entry is in the always-sent block | Check **When the AI sees this** on both entries |
| The style fades after a few turns | The style text sits far from the end of the prompt | Set **Inject into** to **At the end** |

---

## Custom code route: mode buttons under the last message

If you write your own interface, draw the buttons yourself and set the same variable. The lore entries from Step 2 don't change.

**Panels → Front End Code** → open `index.tsx` and replace the default `return <Chat />`:

```tsx
export default function MyWorld() {
  const api = useYumina();
  const currentMode = String(api.variables["Mode"] || "normal");
  const msgs = api.messages || [];

  const modes = [
    { id: "normal", label: "Normal", color: "#94a3b8", activeColor: "#e2e8f0",
      activeBg: "rgba(148,163,184,0.2)", border: "#475569", activeBorder: "#94a3b8" },
    { id: "comedy", label: "Comedy", color: "#fbbf24", activeColor: "#fef3c7",
      activeBg: "rgba(251,191,36,0.2)", border: "#a16207", activeBorder: "#fbbf24" },
    { id: "horror", label: "Horror", color: "#f87171", activeColor: "#fecaca",
      activeBg: "rgba(248,113,113,0.2)", border: "#991b1b", activeBorder: "#f87171" },
  ];

  const switchTo = (mode) => {
    api.setVariable("Mode", mode.id);
    api.showToast("Switched to " + mode.label + " mode", "info");
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
            <div style={{ display: "flex", gap: "8px", marginTop: "16px", flexWrap: "wrap" }}>
              {modes.map((mode) => {
                const isActive = currentMode === mode.id;
                return (
                  <button
                    key={mode.id}
                    onClick={() => { if (!isActive) switchTo(mode); }}
                    style={{
                      padding: "8px 16px",
                      background: isActive ? mode.activeBg : "transparent",
                      border: `2px solid ${isActive ? mode.activeBorder : mode.border}`,
                      borderRadius: "8px",
                      color: isActive ? mode.activeColor : mode.color,
                      fontSize: "13px",
                      fontWeight: isActive ? "700" : "500",
                      cursor: isActive ? "default" : "pointer",
                      opacity: isActive ? 1 : 0.7,
                      transition: "all 0.2s ease",
                    }}
                  >
                    {isActive ? "● " : ""}{mode.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      );
    }} />
  );
}
```

**What the code does:**

- `api.variables["Mode"]` reads the variable by its name
- `api.setVariable("Mode", mode.id)` writes it. The conditional entries pick up the new value on the AI's next reply
- `api.showToast(text, "info")` shows a notice (`"success"`, `"error"` and `"info"` are the three types)
- The active button gets a dot and a highlight, and tapping it again does nothing
- To run a behavior instead of setting the variable directly, call `api.executeAction("mode-comedy")`

The status next to the file in **Panels → Front End Code** should read a green **OK**.

::: tip Don't want to write code yourself?
Click **Creation assistant** at the top right of the canvas and describe the buttons you want.
:::

---

## More ideas

### More modes

Add another lore entry (say "Poetic style") with the condition Mode is `poetic`, and another button that sets Mode to `poetic`.

### A one-turn burst

For something that should only last one reply, like "the character hiccups through this answer", use a behavior with the effect **Tell the AI**. It slips the AI one line the player can't see, for the next reply only. For something that should last a few turns, use a Number variable as a countdown: a button sets it to `3`, an **Every turn** behavior subtracts 1, and the lore entry's condition is "Countdown is more than 0".

### Language switching

The same setup switches reply language: an entry "Reply only in Japanese" with the condition Language is `ja`, and so on for each language.

### Letting the AI change its own mode

Leave **AI access** on **AI can read & write** and say in the Behavior Rules when the mode should change ("switch to horror when the party enters the crypt"). The AI then sets Mode itself, and the same entries follow it.

---

## Quick reference

| What you want | How to do it |
|---------------|-------------|
| Change how the AI writes, for as long as a mode is on | A lore entry with a condition on a variable (conditional lore) |
| Switch modes from a button | Player interface button: **Change a variable** |
| Keep the AI from changing the mode | **AI access**: **AI read-only** |
| Put style text where the AI listens most | On the entry, **Inject into**: **At the end** |
| A hint for the next reply only | Behavior effect: **Tell the AI** |
| Highlight the active mode | Two versions of the button, each with **When to show** → **When a variable matches** |
| Switch from interface code | `api.setVariable("Mode", "comedy")` or `api.executeAction("mode-comedy")` |

---

::: tip This is Recipe #11
The same setup (a variable, plus lore entries that only go to the AI under a condition) also works for difficulty levels, first-person vs third-person narration, or a character whose mood shifts over the story.
:::

</div>
