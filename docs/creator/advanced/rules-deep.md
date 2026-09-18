<div v-pre>

# Behaviors & Automation

Most worlds on the platform don't use rules at all, and that's fine. Rules are a minority tool — creators reach for them when they have a handful of very specific jobs where the AI can't be trusted to be consistent.

This guide teaches you when rules are worth it, what they're good at, and how to build them. For the basics of triggers, conditions, and actions, see [Get Started: Automation](/creator/automation).

---

## When rules are worth it (and when they're not)

The single most common mistake new creators make with rules is over-engineering. They see the Behaviors section in the editor and think "I should automate everything." Then they build 30 rules that replicate what well-written entries already handle, and the world feels mechanical instead of alive.

**Rules are for precision.** They solve problems where the AI's inconsistency would break the experience:

| Problem | Why rules solve it |
|---------|-------------------|
| "The player should get a notification at exactly affinity 75" | The AI doesn't know the exact number — the engine does |
| "Switch to battle music when entering the arena" | The AI forgets audio directives half the time |
| "Increase hunger every 3 turns" | The AI will sometimes do it on turn 2, sometimes forget entirely |
| "The death screen must appear the instant HP hits 0" | You can't afford the AI getting this wrong even once |

**Entries are for narrative.** They solve problems where flexibility and nuance matter:

| Problem | Why entries solve it |
|---------|---------------------|
| "Change how an NPC talks as trust grows" | Conditional entries give the AI behavioral guidance, not rigid scripts |
| "Reveal lore when the player visits a location" | Keyword-triggered entries flow naturally into the AI's context |
| "Shift the tone when entering a dungeon" | An entry describes atmosphere; a rule can only inject a directive |

**The rule of thumb:** If you're writing a paragraph of narrative text in a rule's `inject-directive` action, you probably should have written an entry instead. Rules are switches and dials. Entries are the actual content.

### How Sakura Season uses both

Sakura Season is the best example of rules and entries working together. It has 9 rules — all doing the same basic job: watching affinity thresholds.

The *entries* describe how each heroine behaves at different affinity levels (guarded, warming up, vulnerable). The *rules* handle the precise moments: a notification at 25 ("It seems you've caught Hina's attention..."), an injected directive at 50 telling the AI to write contradictory push-pull behavior, and an achievement toast at 75 that triggers the confession arc.

The entries do the heavy lifting. The rules just ensure the milestones land at exactly the right moment.

---

## Trigger types in depth

Triggers determine *when* the engine checks this behavior. Think of them as different kinds of alarm clocks.

### The ones you'll actually use

**Variable crosses threshold** (`variable-crossed`) — The most popular trigger, and for good reason. It fires at the *exact moment* a number variable crosses a specific line.

This is different from checking "is health below 20" every turn. The crossed trigger fires *once*, when the value actually transitions across the threshold. If health is already at 10 and stays at 10, it won't fire again.

You set three things: which variable, which threshold, and which direction (`rises-above` or `drops-below`).

Wandering Diary uses three of these to implement region switching: when the `distance` variable crosses 50, the player enters the county; at 150, the mountains; at 200, the provincial capital. Each threshold sets a new `region` variable and shows a notification.

**State changed** (`state-change`) — The broadest trigger. Fires any time *any* variable changes. Pair it with conditions to narrow down what you care about.

Use this when you want to react to a variable having a specific value, not to it crossing a threshold. For example: "whenever any state changes, check if location equals dark_forest, and if so, play spooky music." The rule rechecks every time anything changes, which means it catches the location change no matter what caused it.

**Every N turns** (`turn-count`) — Fires on a schedule. Set `everyNTurns: 3` and it fires on turns 3, 6, 9, 12... Or set `atTurn: 10` for a one-shot at a specific turn.

Good for survival mechanics (hunger ticking up), pacing events (a warning at turn 20 that time is running out), or periodic reminders.

**Every turn** (`every-turn`) — Fires after every player/AI exchange. Use sparingly — a rule that runs every turn and does something visible every turn will annoy players. Best used with conditions that filter most turns out, or for silent background bookkeeping.

**Session start** (`session-start`) — Fires once when a new conversation begins. Good for initialization: setting starting values, showing a welcome message, or playing opening music.

### Less common triggers

**Player keyword** (`keyword`) — Fires when the player's message contains a specific word. Same matching options as lorebook keywords: optional whole-word matching, regex (when the keyword is `/.../flags`), and secondary keyword filtering (AND_ANY, AND_ALL, NOT_ANY, NOT_ALL).

**AI keyword** (`ai-keyword`) — Same as above, but scans the AI's response instead. Useful for reacting to things the AI writes, like "when the AI mentions 'battle begins,' switch music."

**Manual** (`manual`) — Only fires when explicitly called by a custom component via `api.executeAction()`. This is for worlds with custom UI where a button press triggers game logic.

**Action** (`action`) — Fires when a specific custom action button is pressed.

### Scheduling on a cadence

There's no wall-clock timer in the Behaviors section — pacing is measured in turns, not seconds. For anything periodic, reach for the **Every N turns** trigger: it fires on turns N, 2N, 3N… (set it to 5 and it fires on turns 5, 10, 15). That covers survival ticks, upkeep costs, and recurring reminders — the jobs a timer would otherwise do.

---

## Conditions: the ONLY IF check

Rules use the same condition system as entries — the same 7 operators (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`) with the same All/Any combining logic. See [Writing Great Entries: State-driven entries](/creator/advanced/entries-deep#state-driven-entries) for the full operator reference.

If you leave conditions empty, the rule fires every time the trigger matches.

### Comparing one variable against another

By default a condition checks a variable against a fixed number or word — "affinity ≥ 50." But the right-hand side has a **constant / variable** toggle. Flip it to **variable** and the condition compares two live variables instead:

- `affinity > wariness` — fires only while affection currently outweighs guardedness
- `gold >= price` — a "can they afford it?" check without hard-coding the price

Reach for this when the threshold itself isn't fixed — it moves as the game does. Two more touches on the same system:

- The left side accepts a **dotted path** into a JSON variable: `inventory.gold >= 100`.
- `contains` matches **array membership** as well as substrings, so `flags contains "met-king"` is true when `flags` is a list that includes that entry.

---

## Action types: what rules can do

Once conditions pass, the engine executes actions in sequence. A single rule can have multiple actions — and this is where rules get powerful.

### Modify variable

Directly changes a game state variable. Nine operations: `set`, `add`, `subtract`, `multiply`, `toggle`, `append`, `merge`, `push`, `delete`.

The most common: `set` (overwrite a value), `add`/`subtract` (increment/decrement numbers), and `toggle` (flip booleans).

The operand has the same **Constant / Variable** toggle. Switch it to **Variable** to feed another variable's current value into the operation — `health -= strength`, `score += combo`, `wallet += daily_income`. The engine reads the referenced variable the moment the rule fires, so the math always uses live values instead of a number you'd have to keep in sync by hand.

### Inject directive

Adds a temporary instruction to the AI's prompt. This is arguably the most powerful action because it changes what the AI is *told to do*, which changes the entire narrative direction.

You give it a unique ID (so you can remove it later), the instruction text, and where to place it in the prompt (`top`, `before_char`, `after_char`, `bottom`, `depth`, or `auto`).

By default, injected directives persist across turns (`persistent: true`). You can also set a `duration` to auto-expire after N turns.

Sakura Season uses this at affinity 50 for each heroine. When Rin hits 50, the rule injects: *"Rin's affinity has entered a deeper stage. The ice is cracking. She'll say unnecessary things at committee meetings, unconsciously share her thoughts about a book on the rooftop and then suddenly go quiet."* The AI reads this every turn from that point forward, shifting its portrayal naturally.

### Remove directive

Removes a directive previously injected. Reference it by the same `directiveId` you gave it.

### Send context

Sends an invisible message to the AI and triggers a response. The player doesn't see this message, but the AI reads it and responds accordingly. Useful for forcing narrative beats: "A monster appears! Describe a random encounter."

### Toggle entry

Enables or disables a lorebook entry by its ID. A rule that activates `toggle-entry` with `enabled: true` can reveal hidden lore at the right moment.

### Toggle rule

Enables or disables another behavior. This is the key to building chains: Rule A activates when you enter the dungeon and turns on Rule B (monster encounters every turn). Rule C activates when you leave the dungeon and turns Rule B off.

### Toggle variable

Flips a variable's enable gate via the `@vars.enabled.<id>` path (a THEN effect with a boolean value). While a variable is off it leaves the AI's game state and the player UI and rejects AI writes — but it keeps its value, so conditions, behaviors and your custom UI still read it. Pair it with a variable whose Activation is set to Manual: dungeon-only loot, a score that only exists mid-broadcast. See [Variables → AI Access & Activation](/creator/variables).

### Notify player

Pops up a toast notification. Four styles:

| Style | Appearance | Best for |
|-------|-----------|----------|
| `info` | Blue | Neutral updates ("You've entered a new region") |
| `achievement` | Gold | Milestones and unlocks |
| `warning` | Yellow | Caution ("Your supplies are running low") |
| `danger` | Red | Critical alerts ("You have fallen") |

### Play audio

Controls background music and sound effects. Takes a `trackId` (matching a track in your audio setup), an `action` (`play`, `stop`, `crossfade`, `volume`), and optional `volume` and `fadeDuration` settings.

---

## Real patterns from published worlds

### Affinity thresholds (Sakura Season)

The classic use case. Sakura Season has 9 rules across three heroines, each following the same 3-tier pattern:

**At affinity 25** — A subtle info notification. "It seems you've caught Hina's attention..." plus sets `story_phase` to "daily." One-shot (`maxFireCount: 1`).

**At affinity 50** — An achievement notification. "Hina is starting to see you as someone special..." plus injects a directive describing her contradictory push-pull behavior, plus sets `story_phase` to "deepening." One-shot.

**At affinity 75** — The climax trigger. Achievement notification, directive to arrange the confession scene, `story_phase` set to "climax." One-shot.

Notice the pattern: every rule uses `variable-crossed` + `rises-above`, fires exactly once, and combines a player notification with an AI directive and a phase variable update. Three action types working together to create a single meaningful moment.

### Region switching (Wandering Diary)

Wandering Diary tracks a `distance` variable that increases as the player travels. Three `variable-crossed` rules switch the `region` variable at distances 50, 150, and 200, each showing a notification: "You've finally left the wilderness and entered county territory," "Past the county, an endless mountain range stretches before you," "The outline of the provincial capital appears in the distance."

This creates a seamless travel progression without the AI having to track distances or remember region boundaries.

### Death triggers

Both Wandering Diary and survival-kit templates use the same pattern: `variable-crossed` on health dropping below 1, with a danger-style notification. The key details:

- **Priority 100** — death should be evaluated before anything else
- **maxFireCount: 1** — the death notification only fires once (though most worlds don't bother with this since you can't go below zero twice)
- Sometimes paired with an `inject-directive` telling the AI to describe the character's demise

### Dungeon activation chains

A common pattern in RPG worlds: Rule A listens for entering a dungeon (keyword trigger or state-change + condition), then uses `toggle-rule` to activate Rule B (monster encounters on `every-turn` with a cooldown). A third rule listens for leaving and deactivates Rule B.

This keeps monster encounters scoped to specific areas without the AI having to track whether the player is in a dungeon.

---

## How the engine processes rules

After each player message, AI reply, or state change, the engine runs through all behaviors in a single pass: sort by priority (highest first), then check each one in sequence. For each behavior, it asks: is it enabled? Does the trigger type match this event? Do the trigger specifics match (keyword found, threshold crossed, etc.)? Do the conditions pass? Is it still within cooldown? Has it exceeded its max fire count? If everything passes, the actions are collected. After all behaviors are checked, collected actions execute in order. If those actions modify variables, the engine may re-evaluate (with a depth limit to prevent infinite loops).

The entire process is invisible to the player — they only see the results: a notification, a music change, a variable update.

---

## Controlling when rules fire

### Priority

Higher numbers evaluate first. When multiple rules trigger at the same time, priority decides order.

Practical guidance: death checks at 100, story milestones at 50, ambient effects at 10-20. You don't need to be precise — just make sure critical rules run before nice-to-haves.

### Cooldown

After firing, the rule sleeps for this many turns. A hunger warning with `cooldownTurns: 5` won't nag the player every turn — it waits at least 5 turns between warnings.

### Max fire count

The rule can fire at most this many times, ever. `maxFireCount: 1` makes it a one-shot event — perfect for achievements, first-time tutorials, and story milestones.

### Enabled/disabled state

Rules start enabled by default, but you can set `enabled: false` to create dormant rules that only activate when another rule turns them on via `toggle-rule`. This is the foundation of the dungeon activation pattern described above.

---

## Common mistakes

**Over-engineering with rules when entries would suffice.** If you find yourself writing long narrative text inside `inject-directive` actions, you probably want conditional entries instead. Rules inject a sentence or two of guidance. Entries provide paragraphs of context.

**Using `state-change` when you mean `variable-crossed`.** `state-change` fires every time *any* variable changes. If you want "notify me when health drops below 20," use `variable-crossed` — it fires once at the crossing point. `state-change` + a condition checking `health < 20` would fire on *every subsequent state change while health is below 20*, which is probably not what you want.

**Forgetting cooldowns on frequent triggers.** An `every-turn` rule without a cooldown fires every single turn. If it shows a notification, your player gets spammed. Always ask: "How often should the player actually see this?"

**Building 30 rules for a world that needs 3.** Look at Sakura Season: 9 rules, 3 heroines, 3 thresholds each. That's a world with deep mechanics. Most worlds need fewer, and plenty of popular ones ship with zero. Start with entries and variables. Add rules only when you catch the AI being inconsistent about something specific.

**Not testing threshold values.** If your rule fires at `health < 10` but your AI never actually gets health that low (because your entries tell it to "describe the player as injured when health is below 30"), the rule will never trigger. Make sure your thresholds align with how your world actually works.

---

## See also

- [Writing Great Entries](/creator/advanced/entries-deep) — conditional entries are often a better fit than rules for narrative changes
- [Audio Design](/creator/advanced/audio-deep) — the `play-audio` action and when to use rules vs. AI directives for audio
- [Designing Game State](/creator/advanced/variables-deep) — designing the variables your rules react to

Complete rule schema and evaluation pipeline → [World Spec: Rules & Reactions](/world-spec/rules)

</div>
