# Lazy Tutorial: Let AI Build Your Whole World

> The previous tutorial had you fill in every field by hand. This one hands the same work to the Creation assistant.

We're building the same game: **"The Imposters"** — post-apocalyptic horror survival, judging whether the person at the door is human or monster, surviving 14 nights. This time, the Creation assistant does the building.

---

## What is the Creation assistant?

The **Creation assistant** is the AI built into the canvas. It **edits your card directly**: tell it "add a health variable for me" in plain language, and the variable appears on the canvas.

Here's how it works:
1. You describe what you need
2. The assistant makes the changes, and they show up live on the canvas
3. After each round, a strip called **The assistant's last turn** appears at the bottom of the canvas, saying how many things were added, changed and removed
4. Not happy? Click **Undo this turn** to take back the whole round, or just tell it what to fix

It also saves a checkpoint before it changes your card, so you can roll back from **⋮ → Change History** ∠( ᐛ 」∠)＿

---

## Step 1: Create world + open the assistant

This part you still do yourself:

1. Click **Create** on the left
2. Select **Blank Project** and pick **Canvas**
3. Type a name in the name field at the top left: `The Imposters`
4. Click **Creation assistant** on the right of the second row of the top bar

The assistant's chat opens on the right. That's your main workspace from here on.

---

## Step 2: Tell the AI what you want

New conversations start in **Plan**, where you can discuss the idea without changing the card. Review the proposed scope and choose **Start building** to execute it, or **Keep brainstorming** to continue discussing. For this tutorial, you can also switch to **Build** under the input box to edit the card straight away.

Give it your full game concept in one go. The more detail you provide, the better the output.

Copy and paste this to get started:

```
Build me a post-apocalyptic horror survival game similar to "No, I'm not a Human".

Setting: The apocalypse has begun. The city is overrun with "Visitors" — entities that look
exactly like humans. The player is alone at home, and every night someone comes knocking.
The player must judge whether the visitor is human or monster and decide whether to open the door.

Game rules:
- Game lasts 14 days (14 nights)
- Night: 2–3 visitors per night, player judges through peephole observation and door conversation
- Day: freely explore rooms and use items
- Visitor traits: unnaturally uniform teeth, abnormal pupils, strange skin texture
- Human traits: normal imperfections — cavities, dark circles, scars

I need these variables:
- player_hp (health, 0–5, default 3): take -1 when attacked by a Visitor; drop to 0 if Pale Stranger enters
- energy_current (energy, 0–8, default 3): body checks and shooting cost 1 point; peephole and talking are free; restores to max during the day
- game_day (day count, 1–14): increase by 1 after each complete night-day cycle
- game_phase (phase): "Night" or "Day"
- player_has_gun (has gun, default true): shooting costs 1 energy

Write me a system setup entry, an opening message, and keyword-triggered lorebook entries
(knocking event, peephole observation, room search).

Also build me a CRT monitor-style root component (`index.tsx`) that keeps the outer
`<Chat renderBubble={(msg) => ...} />` shell and customizes the bubbles:
- Night/day phase title (extract "🌑 **NIGHT X**" or "☀️ **DAY X**" from AI replies, render as CRT
  green glow / amber title with scanline effect)
- Knocking animation (extract ***triple-asterisk text***, render as red shaking large text)
- Clickable choice buttons (extract A/B/C/D/E options after "Suggested Choices:", click to auto-send)
- Bottom HUD status bar (monospace font, show energy/HP/armed status)
- Overall black-green end-of-world aesthetic
```

---

## Step 3: Watch it work

The assistant gets to work. You'll see what it's doing in the chat, and the lore, variables and behaviors it writes appear on the canvas as it goes.

For a big job, it first tells you roughly how long it will take and how much it will cost, and waits for you to start it. Using the assistant costs credits.

::: tip It keeps working in the background
Once you've sent the request, you can leave the editor or work on another card. When it's done, needs a decision from you, or stops, a notice pops up in the app. Click it to jump back.
:::

::: tip What if you're not happy?
If something looks off (like a variable's default value is wrong), tell the assistant what to fix: "health's default should be 100 not 50." To throw away a whole round, click **Undo this turn**.
:::

---

## Step 4: Review and tweak

Once the assistant is done, look over what it built on the canvas:

- **Character and world** and **Keyword lore** — is the setup right? Are there enough keyword entries?
- **Variables** — are the types, starting values, ranges and Behavior Rules reasonable?
- **Opening** — does the opening message have the right atmosphere?
- **Player interface** (middle of the top bar) — does the interface look the way you wanted?

**Panels → Full-page lists** shows lore, variables and behaviors as tables on one page, which is quicker for checking a lot at once.

If anything needs adjusting, you have two options:
1. **Keep chatting** — tell the assistant "make the opening message shorter" or "change the health bar color to dark red"
2. **Edit directly** — click a row on the canvas and change it yourself, just like in the manual tutorial

To change only certain parts, select them on the canvas first (Ctrl + click to pick several), then talk to the assistant. It focuses on what you selected.

Then click **Cover & blurb** on the right of the canvas and fill in the cover, description and language in **Card settings**.

---

## Step 5: Test and publish

Click **Play** on the right of the top bar. Same checklist as the manual tutorial:

| Check item | How to verify |
|-----------|---------------|
| Opening message appears | First message shows automatically on entry |
| Status panel | HUD with energy, HP and armed status visible |
| Values change | Variables change after interactions; **This turn → Each value** says why |
| Keyword lore triggers | Mentioning "peephole" makes AI follow the rules |

Found an issue during testing? Tell the assistant: "During testing I noticed health never drops — can you check the health variable's behavior rules?" It can also run playtests itself and read what happened.

Once testing passes, click **Not live** in the top right, go through the checklist, and click **Publish**. In the dialog, add tags, set the content mode (**Limited** or **Limitless**) and visibility, and publish.

---

## Tips for working with the assistant

### 1. Make your first message as detailed as possible

The more context the assistant has, the fewer revisions you'll need. Try to include in your first message:
- Game type and core mechanics
- Which variables you need and what each one means
- Style and atmosphere description
- What kind of UI you want

### 2. Iterate step by step instead of trying to nail it in one shot

If your world is complex, don't try to cram everything into one message. Break it up:

```
Round 1: "Build me a horror survival game — start with the system setup, variables, and opening message"
→ Review

Round 2: "Now add lorebook entries: knocking event, peephole observation, and room search"
→ Review

Round 3: "Finally, rewrite the root component with a dark horror-style UI showing health and day count"
→ Review
```

### 3. Give specific feedback

❌ "The UI doesn't look good" — the AI doesn't know what's wrong
✅ "The health bar is too thin, double the height. The background is too bright, change it to pure black #000" — the AI knows exactly what to fix

### 4. Check the interface as you go

After the assistant changes `index.tsx`, click **Player interface** in the middle of the top bar to see the result. If it's not right, keep talking.

### 5. Leave sticky notes

If you have too many ideas to explain at once, stick them on the canvas as sticky notes, then tell the assistant "go through the sticky notes and do all of these". It reads every note and knows what each one is stuck to.

---

## Manual vs. assistant: the comparison

| | Manual tutorial | Assistant tutorial |
|--|-----------------|---------------|
| Time required | 30–60 minutes | 5–15 minutes |
| What you learn | What every field means and how to use it | How to work with the AI effectively |
| Best for | People who want deep engine understanding | People who want to ship fast |
| Control | Full control over every detail | AI does most of it, you fine-tune |

::: tip Best practice
Do the manual tutorial once first to understand the engine's core concepts. Then use the assistant — knowing what it's doing lets you give better instructions and catch mistakes more easily.
:::

---

## Next steps

- Want to go deep on a specific feature? Start with [Writing Great Entries](./entries-deep.md), [Designing Game State](./variables-deep.md) or [Behaviors](./rules-deep.md)
- Want to see how features combine? Browse the [recipe pages](./recipes/scene-jumping.md) for worked examples
- Want to make your world look better? See the [Custom UI Guide](./custom-ui-deep.md)
- Prefer your own Claude, ChatGPT or Cursor? See [Connect your own AI](/creator/studio-ai#connect-your-own-ai)
