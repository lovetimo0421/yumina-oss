<div v-pre>

# Behaviors & Automation

Most worlds on the platform don't use behaviors at all, and that's fine. Creators reach for them when they have a handful of very specific jobs where the AI can't be trusted to be consistent.

For the basics of triggers, conditions and effects, see [Behaviors](/creator/automation).

---

## When behaviors are worth it (and when they're not)

The most common mistake new creators make with behaviors is over-engineering. They see the **＋ Behavior** button and think "I should automate everything." Then they build 30 behaviors that replicate what well-written entries already handle, and the world feels mechanical.

**Behaviors are for precision.** They solve problems where the AI's inconsistency would break the experience:

| Problem | Why a behavior solves it |
|---------|-------------------|
| "The player should get a notification at exactly affinity 75" | The AI doesn't know the exact number — the engine does |
| "Switch to battle music when entering the arena" | The AI forgets audio directives half the time |
| "Increase hunger every 3 turns" | The AI will sometimes do it on turn 2, sometimes forget entirely |
| "The death screen must appear the instant HP hits 0" | You can't afford the AI getting this wrong even once |

**Entries are for narrative.** They solve problems where flexibility and nuance matter:

| Problem | Why entries solve it |
|---------|---------------------|
| "Change how an NPC talks as trust grows" | Conditional lore gives the AI behavioral guidance, not rigid scripts |
| "Reveal lore when the player visits a location" | Keyword lore flows naturally into the AI's context |
| "Shift the tone when entering a dungeon" | An entry describes atmosphere; a behavior can only pass the AI a line or two |

**Rule of thumb:** if you're writing a paragraph of narrative text into a behavior's **Tell the AI** effect, you probably should have written an entry instead. Behaviors work like switches and dials; entries hold the actual content.

### How Sakura Season uses both

Sakura Season is a good example of behaviors and entries working together. It has 9 behaviors, all doing the same basic job: watching affinity thresholds.

The *entries* describe how each heroine behaves at different affinity levels (guarded, warming up, vulnerable). The *behaviors* handle the precise moments: a notification at 25 ("It seems you've caught Hina's attention..."), new guidance for the AI at 50 telling it to write contradictory push-pull behavior, and an achievement notice at 75 that triggers the confession arc.

The entries do the heavy lifting. The behaviors make sure the milestones land at exactly the right moment.

---

## Trigger types in depth

The trigger (**When it fires**) decides *when* the engine checks a behavior.

### The ones you'll actually use

**Variable crosses threshold** — The most popular trigger. It fires at the *exact moment* a number variable crosses a specific line.

This is different from checking "is health below 20" every turn. The crossing trigger fires *once*, when the value actually moves across the threshold. If health is already at 10 and stays at 10, it won't fire again.

You set three things: which variable, which direction (**Rises above** or **Drops below**), and the value.

Wandering Diary uses three of these to implement region switching: when the `distance` variable crosses 50, the player enters the county; at 150, the mountains; at 200, the provincial capital. Each threshold sets a new `region` variable and shows a notification.

**Variable changes** — Fires when a variable changes. You can pick one variable to watch, or leave it open so any change fires it, and narrow it down with conditions.

Use this when you want to react to a variable having a specific value, not to it crossing a threshold. For example: "whenever location changes, check if location equals dark_forest, and if so, play spooky music." The behavior rechecks every time the value changes, whatever caused it.

**Every N turns** — Fires on a schedule: set it to 3 and it fires on turns 3, 6, 9, 12... For a one-off at a specific turn, set N to that turn and **Max fires** to 1.

Good for survival mechanics (hunger ticking up), pacing events (a warning at turn 20 that time is running out), or periodic reminders.

**Every turn** — Fires after every player/AI exchange. Use sparingly — a behavior that runs every turn and does something visible every turn will annoy players. Best used with conditions that filter most turns out, or for silent background bookkeeping.

**Session starts** — Fires once when a new game begins. Good for initialization: setting starting values, showing a welcome message, or playing opening music.

**The player presses a button** — Fires when a button in the [player interface](/creator/player-view) runs **Set off a behavior**, or when your interface code calls `api.executeAction(id)`. A button can also pass values in; see [Passing a value from a button](/creator/automation#passing-a-value-from-a-button).

### Less common triggers

**Player says keyword** — Fires when the player's message contains one of your words. The same matching options as keyword lore apply: optional whole-word matching, regex (when the keyword is `/.../flags`), and secondary keyword filtering (AND_ANY, AND_ALL, NOT_ANY, NOT_ALL).

**AI says keyword** — Same as above, but scans the AI's response instead. Useful for reacting to things the AI writes, like "when the AI mentions 'battle begins,' switch music."

**Every N seconds** — Fires on a real-time clock, but only while the player has the game open. Good for things that should tick while the player reads or thinks, like a countdown or an NPC who gets impatient. For anything that should follow the story's pace, use **Every N turns** instead.

---

## Conditions: the ONLY IF check

**ONLY IF** uses the same condition system as conditional lore — the same 7 operators (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`; shown as is / is not / > / ≥ / < / ≤ / contains) with the same All/Any combining logic. See [Writing Great Entries: State-driven entries](/creator/advanced/entries-deep#state-driven-entries) for the full operator reference.

If you leave conditions empty, the behavior fires every time the trigger matches.

When the trigger matches but the conditions don't hold, **If the conditions don't hold, say** shows the player a notice. Without it, nothing happens and the player can't tell why their button did nothing.

### Comparing one variable against another

By default a condition checks a variable against a fixed number or word — "affinity ≥ 50." But the right-hand side has a **Constant** / **Variable** toggle. Flip it to **Variable** and the condition compares two live variables instead:

- `affinity > wariness` — fires only while affection currently outweighs guardedness
- `gold >= price` — a "can they afford it?" check without hard-coding the price

Reach for this when the threshold itself isn't fixed — it moves as the game does. Two more touches on the same system:

- The left side accepts a **dotted path** into a JSON variable: `inventory.gold >= 100`.
- `contains` matches **array membership** as well as substrings, so `flags contains "met-king"` is true when `flags` is a list that includes that entry.

### Stop conditions

**STOP WHEN** is the reverse of ONLY IF: while any stop condition holds, the behavior doesn't fire. Use it for "fire until X", like an every-5-turns reminder that should go quiet once affection reaches 100. If the value drops back, the behavior resumes. To stop after a fixed number of firings, use **Max fires** instead.

---

## Effects: what behaviors can do

Once conditions pass, the engine runs the effects in order. A single behavior can have several.

### Change variable

Directly changes a variable. Six operations: **Set**, **Add**, **Subtract**, **Multiply**, **Toggle**, **Append**.

The value has three modes:
- **Constant** — a fixed number or word.
- **Variable** — another variable's current value: `health -= strength`, `score += combo`, `wallet += daily_income`. The engine reads it the moment the behavior fires, so the math always uses live values.
- **Random** — a number in a range, a dice roll, or a pick from a list. A list pick can avoid repeating the last few picks, for things like "today's guest".

### Enable/disable variable

Switches a variable on or off. While a variable is off it leaves the AI's prompt and the player interface and ignores AI writes — but it keeps its value, so conditions, behaviors and your interface code still read it. Pair it with a variable whose **When the AI can see it** is set to **Manual**: dungeon-only loot, a score that only exists mid-broadcast. See [Variables → When the AI can see it](/creator/variables#when-the-ai-can-see-it).

### Enable/disable scenario

Opens or closes a [scenario](/creator/modules). Scenarios set to **Only the Enabled switch** rely on this.

### Tell the AI

Slips the AI a line the player can't see, in its next prompt only. Useful for forcing a narrative beat: "A monster appears! Describe a random encounter."

For guidance that should stay from then on (like Sakura Season's push-pull instructions at affinity 50), write it as a standby lore entry and use **Enable lore entry** instead.

### Enable lore entry / Disable lore entry

Opens or closes a lore entry. A behavior that enables a standby entry can reveal hidden lore at the right moment, and it stays open until something closes it.

### Enable/disable behavior

Turns another behavior on or off. This is how you build chains: Behavior A fires when you enter the dungeon and turns on Behavior B (monster encounters every turn). Behavior C fires when you leave the dungeon and turns B off.

### Show notification

Pops up a notice for the player. Four styles: **Info**, **Success**, **Warning** and **Error**.

### Unlock a moment

Gives the player a small card with a title, a line of text and a picture, collected into a list variable so it only pops up once. See [Moments](/creator/automation#moments).

### Play music / Play sound effect / Stop audio

Plays a background track, plays a one-shot sound, or stops a track. Pick the track from your audio list.

### Code

Under **Advanced**, a behavior can also run a short piece of JavaScript in the card while the game is open. Use it for things effect rows can't express, like shuffling a deck. See [Code behaviors](/creator/automation#code-behaviors).

---

## Real patterns from published worlds

### Affinity thresholds (Sakura Season)

The classic use case. Sakura Season has 9 behaviors across three heroines, each following the same 3-tier pattern:

**At affinity 25** — A subtle info notification. "It seems you've caught Hina's attention..." plus sets `story_phase` to "daily." One-shot (**Max fires** 1).

**At affinity 50** — A notification. "Hina is starting to see you as someone special..." plus new guidance for the AI describing her contradictory push-pull behavior, plus sets `story_phase` to "deepening." One-shot.

**At affinity 75** — The climax trigger. Notification, guidance for the AI to arrange the confession scene, `story_phase` set to "climax." One-shot.

Every behavior uses **Variable crosses threshold** + **Rises above**, fires exactly once, and combines a player notification with guidance for the AI and a phase variable update. To build the same thing today, put each stage's guidance in a standby lore entry and open it with **Enable lore entry**.

### Region switching (Wandering Diary)

Wandering Diary tracks a `distance` variable that increases as the player travels. Three **Variable crosses threshold** behaviors switch the `region` variable at distances 50, 150, and 200, each showing a notification: "You've finally left the wilderness and entered county territory," "Past the county, an endless mountain range stretches before you," "The outline of the provincial capital appears in the distance."

The AI never has to track distances or remember region boundaries.

### Death triggers

Both Wandering Diary and survival-kit templates use the same pattern: **Variable crosses threshold** on health dropping below 1, with an **Error**-style notification. The key details:

- **Priority 100** — death should be evaluated before anything else
- **Max fires 1** — the death notification only fires once (though most worlds don't bother with this since you can't go below zero twice)
- Sometimes paired with **Tell the AI** to describe the character's demise

### Dungeon activation chains

A common pattern in RPG worlds: Behavior A listens for entering a dungeon (a keyword trigger, or **Variable changes** + a condition), then uses **Enable/disable behavior** to turn on Behavior B (monster encounters on **Every turn** with a cooldown). A third behavior listens for leaving and turns B off.

This keeps monster encounters scoped to specific areas without the AI having to track whether the player is in a dungeon. If the dungeon is a [scenario](/creator/modules), you can skip the chain: put Behavior B inside the scenario and it only fires while the scenario is open.

---

## How the engine processes behaviors

When something happens (a turn ends, a message arrives, a variable changes, a button is pressed, the clock ticks), the engine goes through all behaviors in one pass, highest priority first. For each, it asks: is it enabled? Is its scenario open? Does the trigger match this event? Do the ONLY IF conditions pass? Is any stop condition holding? Is it cooling down? Has it reached **Max fires**? If there's a **Chance to fire**, does the roll succeed? If everything passes, its effects run in order. Effects that change variables can set off further behaviors, up to 5 steps deep to prevent infinite loops.

The player only sees the results: a notification, a music change, a variable update. To see why a behavior fired or didn't, [playtest](/creator/playtest) and check **This turn**.

---

## Controlling when behaviors fire

Priority, cooldown, max fires and chance are under **Advanced** in a behavior's settings.

### Priority

Higher numbers evaluate first. When multiple behaviors trigger at the same time, priority decides order.

Practical guidance: death checks at 100, story milestones at 50, ambient effects at 10-20. You don't need to be precise — just make sure critical behaviors run before nice-to-haves.

### Cooldown

After firing, the behavior sleeps for this many turns. A hunger warning with a cooldown of 5 won't nag the player every turn — it waits at least 5 turns between warnings.

### Max fires

The behavior can fire at most this many times, ever. **Max fires** 1 makes it a one-shot event — perfect for achievements, first-time tutorials, and story milestones.

### Chance to fire (%)

The behavior only fires this percentage of the times it otherwise would. Leave it at 100 for always. Good for random events: "a 20% chance each turn that a stranger knocks."

### Enabled

Behaviors start enabled, but you can switch **Enabled** off to create dormant behaviors that only activate when another behavior turns them on with **Enable/disable behavior**. This is the foundation of the dungeon activation pattern described above.

---

## Common mistakes

**Over-engineering with behaviors when entries would suffice.** If you find yourself writing long narrative text inside **Tell the AI**, you probably want conditional lore instead. Behaviors pass a sentence or two of guidance. Entries provide paragraphs of context.

**Using Variable changes when you mean Variable crosses threshold.** **Variable changes** fires every time the variable changes. If you want "notify me when health drops below 20," use **Variable crosses threshold** — it fires once at the crossing point. **Variable changes** + a condition checking `health < 20` would fire on *every subsequent change while health is below 20*, which is probably not what you want.

**Forgetting cooldowns on frequent triggers.** An **Every turn** behavior without a cooldown fires every single turn. If it shows a notification, your player gets spammed. Always ask: "How often should the player actually see this?"

**Building 30 behaviors for a world that needs 3.** Sakura Season has 9 behaviors: 3 heroines, 3 thresholds each. Most worlds need fewer, and plenty of popular ones ship with zero. Start with entries and variables. Add behaviors only when you catch the AI being inconsistent about something specific.

**Not testing threshold values.** If your behavior fires at `health < 10` but health never actually gets that low (because your entries tell the AI to "describe the player as injured when health is below 30"), it will never trigger. Make sure your thresholds align with how your world actually works.

---

## See also

- [Writing Great Entries](/creator/advanced/entries-deep) — conditional lore is often a better fit than behaviors for narrative changes
- [Audio Design](/creator/advanced/audio-deep) — audio effects in behaviors, and when to use them vs. AI directives
- [Designing Game State](/creator/advanced/variables-deep) — designing the variables your behaviors react to

Complete rule schema and evaluation pipeline → [World Spec: Rules & Reactions](/world-spec/rules)

</div>
