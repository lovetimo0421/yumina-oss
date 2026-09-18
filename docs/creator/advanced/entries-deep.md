<div v-pre>

# Writing Great Entries

Entries are the single most important thing you'll create. Every world on the platform uses them, and a lot of popular ones run entirely on well-crafted entries with no rules at all.

This guide teaches the craft of writing entries that make worlds come alive. For the basics of entries and sections, see [Get Started: Entries](/creator/entries).

---

## Writing characters that feel alive

The best worlds on the platform invest more in character entries than anything else. Here's what works.

### Personality as behavior, not labels

Don't just list traits. Describe how those traits show up in action.

**Instead of this:**

> Kasu is shy, introverted, and desperate to be accepted.

**Write this** — from the *Poison in the Jar (壺中の毒 · 大逃杀)* card, the actual entry for Kasu:

> Kasu is so introverted he barely registers as a presence, and what he wants most is to be accepted. In three years of school, he hardly ever spoke to anyone unprompted — not out of coldness, but out of fear. He's afraid that if he opens his mouth he'll be rejected, mocked, or ignored. So he stays silent and turns himself into background.
>
> In the cave group, Kasu quietly does the most physical work — fetching water from the stream, sorting out the bedding, gathering shellfish at low tide. He never complains, because "having something to do" is what makes him feel needed.

The AI can't act out "shy" in a consistent way. But it can keep acting out "fetches the water, never complains, turns himself into background."

### Relationship stages

The most immersive worlds change how characters behave based on how well the player knows them. Sakura Season does this brilliantly: each of its three heroines has behavioral descriptions at four affinity levels (0-25, 26-50, 51-75, 76-100).

You can achieve this with one entry per relationship stage that only activates when a variable reaches a threshold:

- **Early stage** (affinity 0-25): Formal, guarded, surface-level conversation
- **Growing trust** (affinity 26-50): Starts sharing opinions, occasional vulnerability
- **Close** (affinity 51-75): Inside jokes, comfortable silence, asks for help
- **Deep bond** (affinity 76+): Full vulnerability, unique speech patterns, protective

As the relationship variable changes, the AI's guidance shifts automatically.

::: details How to set this up
The entry editor itself only exposes **keywords** as a trigger — it does *not* have a UI for variable-based conditions. To gate entries by a variable like affinity, you use the [**Behaviors**](/creator/advanced/rules-deep) (Rules) system with the `toggle-entry` action:

1. Create one entry per stage in **Chat History** ("Rin — Early Stage", "Rin — Growing Trust", etc.). Mark them all **disabled** by default.
2. For each stage, add a Behavior:
   - **When**: variable changes (or every turn)
   - **If**: e.g. `rin_affinity >= 26 AND rin_affinity < 51`
   - **Then**: `toggle-entry` enable "Rin — Growing Trust", `toggle-entry` disable the others

The engine flips entries on/off every turn based on your conditions, and only the matching stage's content reaches the AI.

> Advanced creators driving worlds from JSON (Studio AI, Claude Code, etc. via the World Spec) can also set `conditions: [...]` directly on a `WorldEntry` — the engine evaluates them in the lorebook matcher. The editor UI just doesn't surface that field today, so the Behaviors route is the in-product path.

Full schema reference → [World Spec: Entries](/world-spec/entries)
:::

### The character sheet formula

After studying dozens of successful worlds, here's the pattern that works:

1. **Identity** (1-2 sentences): Name, role, core trait
2. **Appearance** (2-3 sentences): What the player sees. Specific details, not generic descriptions
3. **Behavioral patterns** (the bulk): How they talk, what they do when nervous/angry/happy, their habits, contradictions
4. **Relationship to the player**: How they see the player initially, what changes their opinion
5. **Secrets**: Things the AI knows but the character doesn't reveal easily

The behavioral patterns section is where most creators under-invest. It's also where the magic happens.

---

## The lorebook: context on demand

The lorebook is the keyword-triggered entry system. It's the reason you can build a world with 50,000 words of lore and still have a fast, focused AI.

### Designing good keyword lists

The engine scans the last few messages for your keywords. Any single keyword match triggers the entry (OR logic). Think about all the ways a player might reference something:

For an entry about a tavern:
- `tavern`, `inn`, `bar`, `drink`, `bartender`, `pub`

For an entry about a character named Sakurai Kimika:
- `Kimika`, `Sakurai`, `class rep`, `class representative`

**Whole word matching**: Turn this on when short keywords would cause false triggers. Without it, the keyword "art" would match "start", "heart", and "apart."

### Secondary keywords for precision

Sometimes one keyword isn't enough to know if an entry is relevant. Secondary keywords let you add a second filter:

| Mode | Meaning | Example use case |
|------|---------|-----------------|
| **AND_ANY** | Primary matches AND at least one secondary | "forest" + any of ["elf", "danger", "ruins"] |
| **AND_ALL** | Primary matches AND all secondaries match | "forest" + both "night" AND "danger" |
| **NOT_ANY** | Primary matches AND none of the secondaries | "forest" but NOT "safe" or "peaceful" |
| **NOT_ALL** | Primary matches AND not all secondaries | "forest" but not both "safe" AND "day" together |

**The most common use**: `AND_ANY` for topic intersection. You want the "dark forest lore" entry to trigger when the player mentions both forests AND something ominous, not just any mention of trees.

### Depth injection: where the entry appears in chat

Keyword-triggered entries don't go at the top of the prompt with System Presets. They're injected into the chat history at a specific position. The **depth** setting controls where.

**depth: 4** means the entry appears 4 messages from the end of chat. This makes it feel like a natural part of the recent conversation rather than a system instruction from above.

Lower depth numbers (closer to the end) get more AI attention. Higher numbers (further back) feel more like background context.

::: details Technical detail: how depth works
If the chat history is:

```
[1] User: Hello
[2] AI:   Hi there
[3] User: Where's the forest?
[4] AI:   Head north
[5] User: Alright, let's go
```

An entry with depth 2 inserts before message [4]:

```
[1] User: Hello
[2] AI:   Hi there
[3] User: Where's the forest?
--- [Entry content inserted here] ---
[4] AI:   Head north
[5] User: Alright, let's go
```

depth 0 places the entry at the very end (similar to Post Instructions).

Full reference → [World Spec: Entries](/world-spec/entries)
:::

---

## State-driven entries

The most powerful entries don't wait for keywords. They activate based on the actual state of the world.

One thing to clear up first: **the entry editor doesn't expose a built-in "switch on variable value" feature**. "State-driven" is a *pattern*, not a button. You build it by combining ordinary entries with the [Behaviors system](/creator/advanced/rules-deep) — using the `toggle-entry` action to enable/disable entries as variables cross thresholds, exactly as shown in the `::: details How to set this up` block under [Relationship stages](#relationship-stages) above. If you're driving the world from JSON (Studio AI, the World Spec), you can also set `conditions: [...]` directly on a `WorldEntry` and the engine will evaluate them during lorebook matching — but that field isn't surfaced in the editor UI.

The payoff is the same either way: the entry switches on the **actual value of a variable**, not on whether the player happened to type a keyword.

### Real-world example: companion attitudes

Wandering Diary uses this pattern to change how companions behave toward the player. Each companion has three entries — one for low affinity (cautious and distant), one for mid (warming up), one for high (deep loyalty) — plus a small set of Behaviors that toggle the right one on as the affinity variable crosses each threshold.

The player never sees this machinery. They just experience a companion who gradually opens up.

### Conditions + keywords together

The same combination works for narrower context. Give an entry both a keyword **and** a behavior-driven enable/disable, and it only fires when both are true:

- Keyword: `Kimika`, `class rep`
- Behavior gate: enabled when `day_count > 3`, disabled otherwise
- Effect: NPC backstory only appears after Day 3, and only when the player mentions her

This keeps information from showing up too early in the story.

### Seven comparison operators

| Operator | Meaning | Best for |
|----------|---------|----------|
| `eq` | Equals | Exact state checks ("location equals cave") |
| `neq` | Not equal | Exclusions ("not in the tutorial zone") |
| `gt` | Greater than | Thresholds ("affinity above 50") |
| `gte` | Greater or equal | Inclusive thresholds |
| `lt` | Less than | Low-state triggers ("health below 20") |
| `lte` | Less or equal | Inclusive low-state |
| `contains` | String contains | Partial text matching |

Multiple conditions combine with **All** (every condition must pass) or **Any** (one is enough).

---

## Advanced techniques

### Recursion: chained context

When entry A triggers and its content mentions a keyword from entry B, should B also trigger? That's recursion. It's off by default (recursion depth = 0 in settings) but can be turned on for worlds with interconnected lore.

**Use carefully.** Deep recursion chains can consume a lot of context. Most worlds keep it at 0 or 1.

Two safety controls:
- **Prevent Recursion**: This entry can trigger, but its content won't scan for other entries. "I can be woken up, but I won't wake anyone else."
- **Exclude Recursion**: Only the player's actual words can trigger this entry. Invisible to recursive scans entirely.

### API role override

By default, all entries are sent as system messages. But you can change how the AI interprets them:

- **Instruction** (system): The default. The AI treats it as a rule to follow.
- **User**: The AI thinks a player said this. Some models weigh user messages more heavily.
- **Assistant**: The AI thinks it said this itself. Useful for "pre-filling" a response style.

### Example dialogue

Entries tagged as examples get special treatment. The engine parses them into user/assistant message pairs, so the AI sees actual conversation samples rather than a block of text.

Format:

```
<START>
{{user}}: Can you heal this wound?
{{char}}: *examines the wound, frowning* This isn't a normal knife wound.
There's a curse residue. I need moonflower pollen... but it's daytime.
<START>
{{user}}: So what do we do?
{{char}}: *shrugs* Either wait for nightfall, or you endure it.
I recommend the latter — pain is the best teacher.
```

Use `<START>` to separate different conversation examples. `{{user}}` and `{{char}}` are macros that get replaced with the actual player and character names.

**A few good examples beat many.** 2-3 dialogue samples that capture the character's voice are more effective than 10 that make the AI mimic them rigidly.

### Regex keywords

Keywords also support regular expressions. Write your keyword in `/pattern/flags` format (e.g. `/dark\s*forest/i`) and the engine treats it as a regex instead of a literal string. Useful when you need to match flexible phrasing that simple keywords can't cover.

### Scan depth and token budget

The engine doesn't scan all of chat history for keywords — that would be wasteful. The world setting `lorebookScanDepth` (default 2) controls how many recent messages to check. You can change this in the editor under **Entry Settings** in the Lorebook section. Higher values catch more references but cost more processing.

There's also a token budget: `lorebookBudgetPercent` (default 100%) and `lorebookBudgetCap` (default unlimited) limit how many total tokens triggered entries can consume. When the budget is exceeded, entries with higher match scores take priority.

### Folder organization

When your world has dozens or hundreds of entries, the sidebar list gets unwieldy. The editor supports folders — drag entries into logical groupings (all NPCs in one folder, all location lore in another). Folders are purely organizational; they have no effect on runtime behavior, matching, or injection order.

### Position ordering

Within each section, entries are ordered by their **position** number (lower = earlier). Supports decimals, so you can slot an entry between positions 2 and 3 by giving it position 2.5.

Earlier entries in System Presets get cached more efficiently, so put your most stable content (character descriptions, world rules) at lower positions, and content that might change (dynamic instructions) at higher positions.

---

## Common mistakes

**Keyword entries with no keywords.** If you put an entry in Chat History but forget to add keywords (and aren't toggling it from a Behavior), it will never trigger. Always-on entries belong in System Presets.

**Overlapping stage ranges in your Behaviors.** If your "Rin — Early Stage" toggle fires when affinity < 30 and "Rin — Growing Trust" fires when affinity > 25, both entries end up enabled between 26-29. Use non-overlapping ranges: `< 26` and `>= 26 AND < 51`.

**Too-specific keywords that never match.** If your entry about the "Crystalline Sanctum" only triggers on `crystalline sanctum`, players who type "crystal place" or "that temple" will never see it. Think about how players actually refer to things, not just the canonical name.

**Depth injection too deep for important context.** An entry with depth 8 gets buried so far back in chat history that the AI barely weighs it. Keep important context at depth 2-4. Reserve higher depths for background flavor.

---

## See also

- [Designing Game State](/creator/advanced/variables-deep) — choosing and structuring the variables your entries react to
- [AI Directives & Macros](/creator/advanced/directives-macros) — the `{{macro}}` syntax and directive format used inside entries
- [Behaviors & Automation](/creator/advanced/rules-deep) — how to use `toggle-entry` actions to enable/disable entries based on game state

Full schema reference → [World Spec: Entries & Sections](/world-spec/entries)

</div>
