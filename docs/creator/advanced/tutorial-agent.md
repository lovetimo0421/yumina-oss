# Lazy Tutorial: Let AI Build Your Whole World

> The previous tutorial had you fill in every field by hand. This one shows you that you don't actually have to — just let Yumina's AI assistant handle it (￣▽￣)ノ

We're building the same game: **"The Imposters"** — post-apocalyptic horror survival, judging whether the person at the door is human or monster, surviving 14 nights. But this time, we're doing it entirely through Studio's AI Agent.

---

## What is the Studio AI Agent?

The AI Assistant in Studio isn't just a chatbot — it's an AI assistant that can **directly modify your world**. Tell it "add a health variable for me" in plain language, and it actually creates it.

Here's how it works:
1. You describe what you need
2. The AI analyzes and proposes changes (it tells you what it's about to do)
3. You click **Approve** → changes take effect
4. Not happy? Click **Reject** and the AI adjusts its approach

Every modification is snapshot-backed, so you can roll back at any time — no fear of breaking anything ∠( ᐛ 」∠)＿

---

## Step 1: Create world + enter Studio

This part you still do yourself:

1. Click the **Create** button in the left navigation
2. Select **Blank Project**
3. Type a name in the top left: `The Imposters`
4. Click **Enter Studio** at the top of the editor

Once in Studio, you'll see the **AI Assistant** panel on the left. That's your main workspace from here on.

---

## Step 2: Tell the AI what you want

In the AI Assistant's input box, give it your full game concept in one go. The more detail you provide, the better the output.

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

## Step 3: Review the AI's plan

The AI gets to work. You'll watch it think through the changes, then propose a plan. Every time it wants to modify your world, it shows an **approval card** listing what it's about to do.

For example:
- `create_variable` — create the health variable
- `create_entry` — create the system setup entry
- `write_root_component` — write the root component code (`index.tsx`)

Scan the list of operations, and if everything looks right, click **Approve**. The AI continues to the next step.

::: tip You won't finish in one round
The AI may need several approval rounds to complete everything. Each round it does a batch of changes; you approve and it continues. The whole process might have 3–5 rounds — be patient and let it finish (•̀ᴗ•́)و
:::

::: tip What if you're not happy?
If something looks off (like a variable's default value is wrong), click **Reject**, then tell the AI what to fix: "health's default should be 100 not 50." It'll adjust and resubmit.
:::

---

## Step 4: Review and tweak

Once the AI is done, exit Studio and go back to the editor to see what it built. Check each section:

- **Lorebook** — is the system setup right? Are there enough lorebook entries?
- **Variables** — are the types, default values, and behavior rules reasonable?
- **First Message** — does the opening message have the right atmosphere?
- **Custom UI** — does the `index.tsx` preview look the way you wanted?

If anything needs adjusting, you have two options:
1. **Go back to Studio and keep chatting** — tell the AI "make the opening message shorter" or "change the health bar color to dark red"
2. **Edit directly** — change fields in the editor yourself, just like in the manual tutorial

Don't forget to go to **Overview** and fill in the publish info: cover image, description, tags, and language.

---

## Step 5: Test and publish

Click **Save**, then open a new session to test. Same checklist as the manual tutorial:

| Check item | How to verify |
|-----------|---------------|
| Opening message appears | First message shows automatically on entry |
| Status panel | Health bar, energy bar, and day count visible above messages |
| Directives working | Variables change after interactions |
| Lorebook triggers | Mentioning "peephole" makes AI follow the rules |

Found an issue during testing? Go back to Studio and tell the AI: "During testing I noticed the AI isn't deducting health — can you check the health variable's behavior rules?" The AI will diagnose and fix it.

Once testing passes, click **Publish** in the editor's top bar (next to **Save**), set the content mode (**Limited** or **Limitless**) and visibility in the dialog, and publish!

---

## Tips for chatting with the Agent

### 1. Make your first message as detailed as possible

The more context the AI has, the fewer revisions you'll need. Try to include in your first message:
- Game type and core mechanics
- Which variables you need and what each one means
- Style and atmosphere description
- What kind of UI you want

### 2. Iterating step by step beats trying to nail it in one shot

If your world is complex, don't try to cram everything into one message. Break it up:

```
Round 1: "Build me a horror survival game — start with the system setup, variables, and opening message"
→ Review, approve

Round 2: "Now add lorebook entries: knocking event, peephole observation, and room search"
→ Review, approve

Round 3: "Finally, rewrite the root component with a dark horror-style UI showing health and day count"
→ Review, approve
```

### 3. Give specific feedback

❌ "The UI doesn't look good" — the AI doesn't know what's wrong
✅ "The health bar is too thin, double the height. The background is too bright, change it to pure black #000" — the AI knows exactly what to fix

### 4. Use the Canvas preview

The Canvas panel on the right side of Studio gives a live preview of your root component. After the AI modifies `index.tsx`, check Canvas to see the effect. If it's not right, keep talking.

---

## Manual vs. Agent: the comparison

| | Manual tutorial | Agent tutorial |
|--|-----------------|---------------|
| Time required | 30–60 minutes | 5–15 minutes |
| What you learn | What every field means and how to use it | How to collaborate effectively with AI |
| Best for | People who want deep engine understanding | People who want to ship fast |
| Control | Full control over every detail | AI does most of it, you fine-tune |
| Recommendation | Do manual first, the first time | Use Agent for speed once you're comfortable |

::: tip Best practice
Do the manual tutorial once first to understand the engine's core concepts. Then use the Agent — knowing "what it's doing" lets you give better instructions and catch mistakes more easily.
:::

---

## Next steps

You now know two ways to build a world. From here:

- Want to go deep on a specific feature? Check the [Feature Reference](./#feature-reference) section
- Want to see how recipes combine features? Browse the [recipe pages](./recipes/scene-jumping.md) for worked examples
- Want to make your world look better? See the [Custom UI Guide](./custom-ui-deep.md)

Now go build something of your own ᕕ( ᐛ )ᕗ
