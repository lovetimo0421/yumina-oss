<div v-pre>

# Writing Great Entries

Every world on the platform uses entries (lore), and a lot of popular ones run on entries alone, with no behaviors at all. For the basics of openings, lore and the four lore blocks, see [Openings and Lore](/creator/entries).

---

## Writing characters that feel alive

The best worlds on the platform invest more in character entries than anything else.

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

The most immersive worlds change how characters behave based on how well the player knows them. Sakura Season does this: each of its three heroines has behavioral descriptions at four affinity levels (0-25, 26-50, 51-75, 76-100).

You can do this with one entry per relationship stage, each sent only while a variable is in that stage's range:

- **Early stage** (affinity 0-25): Formal, guarded, surface-level conversation
- **Growing trust** (affinity 26-50): Starts sharing opinions, occasional vulnerability
- **Close** (affinity 51-75): Inside jokes, comfortable silence, asks for help
- **Deep bond** (affinity 76+): Full vulnerability, unique speech patterns, protective

As the relationship variable changes, the AI's guidance shifts automatically.

::: details How to set this up
On the canvas, this is **Conditional lore**:

1. Write one entry per stage ("Rin — Early Stage", "Rin — Growing Trust", etc.).
2. Drag the `rin_affinity` variable onto an entry. A line connects them and the entry moves into the **Conditional lore** block. Click the line and set the condition, e.g. `≥ 26`.
3. For a range, drag the variable onto the same entry again and set the second condition (`< 51`). With two or more conditions, the entry's **When the AI sees this** lets you choose whether all of them or any one must hold. For a stage range, use all.

The engine checks the conditions every turn, and only the matching stage's content reaches the AI.

The other way is **Standby lore** plus behaviors: turn **Always Send** off on the stage entries and give them no keywords or conditions, then add behaviors that use **Enable lore entry** / **Disable lore entry** as affinity crosses each threshold. That's more work, and it's mostly useful when something other than a variable's value should open the entry (a button, a keyword, a one-off event). See [Behaviors](/creator/advanced/rules-deep).

In the card's data, the conditions are stored as `conditions: [...]` on the entry. Full schema reference → [World Spec: Entries](/world-spec/entries)
:::

### The character sheet formula

A pattern that shows up across many successful worlds:

1. **Identity** (1-2 sentences): Name, role, core trait
2. **Appearance** (2-3 sentences): What the player sees. Specific details, not generic descriptions
3. **Behavioral patterns** (the bulk): How they talk, what they do when nervous/angry/happy, their habits, contradictions
4. **Relationship to the player**: How they see the player initially, what changes their opinion
5. **Secrets**: Things the AI knows but the character doesn't reveal easily

The behavioral patterns section is where most creators under-invest.

---

## The lorebook: context on demand

Keyword lore lets a world hold 50,000 words of lore while the AI only reads the few entries that matter this turn.

### Designing good keyword lists

The engine scans the last few messages for your keywords. Any single keyword match triggers the entry (OR logic). Think about all the ways a player might reference something:

For an entry about a tavern:
- `tavern`, `inn`, `bar`, `drink`, `bartender`, `pub`

For an entry about a character named Sakurai Kimika:
- `Kimika`, `Sakurai`, `class rep`, `class representative`

**Whole Word**: Turn this on when short keywords would cause false triggers. Without it, the keyword "art" would match "start", "heart", and "apart."

### Secondary keywords for precision

Sometimes one keyword isn't enough to know if an entry is relevant. **Secondary Keywords** let you add a second filter:

| Mode | Meaning | Example use case |
|------|---------|-----------------|
| **AND_ANY** | Primary matches AND at least one secondary | "forest" + any of ["elf", "danger", "ruins"] |
| **AND_ALL** | Primary matches AND all secondaries match | "forest" + both "night" AND "danger" |
| **NOT_ANY** | Primary matches AND none of the secondaries | "forest" but NOT "safe" or "peaceful" |
| **NOT_ALL** | Primary matches AND not all secondaries | "forest" but not both "safe" AND "day" together |

**The most common use**: `AND_ANY` for topic intersection. You want the "dark forest lore" entry to trigger when the player mentions both forests AND something ominous, not just any mention of trees.

Whole Word, Secondary Keywords and the settings below are under **When the AI sees this** → **Advanced** in an opened entry.

### Depth injection: where the entry appears in chat

Entries whose **Inject into** is set to **Sent when mentioned** don't go at the top of the prompt with the always-sent entries. They're injected into the chat history at a specific position. The **Depth (messages from end)** setting controls where.

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

depth 0 places the entry at the very end (similar to **At the end** entries).

Full reference → [World Spec: Entries](/world-spec/entries)
:::

---

## State-driven entries

Some entries shouldn't wait for keywords. They should go to the AI based on the actual state of the world. On the canvas, these are the **Conditional lore** block: drag a variable onto an entry, then click the line to set the condition. Setting it up is shown under [Relationship stages](#relationship-stages) above.

The entry then switches on the **actual value of a variable**, not on whether the player happened to type a keyword.

### Real-world example: companion attitudes

Wandering Diary uses this pattern to change how companions behave toward the player. Each companion has three entries — one for low affinity (cautious and distant), one for mid (warming up), one for high (deep loyalty) — and the right one goes to the AI as the affinity variable crosses each threshold.

The player never sees this machinery. They just experience a companion who gradually opens up.

### Conditions + keywords together

An entry can have both keywords **and** conditions. It's then sent only when a keyword comes up **and** its conditions hold:

- Keywords: `Kimika`, `class rep`
- Condition: `day_count > 3`
- Effect: NPC backstory only appears after Day 3, and only when the player mentions her

This keeps information from showing up too early in the story.

### Seven comparison operators

| Operator | On the canvas | Meaning | Best for |
|----------|---------------|---------|----------|
| `eq` | is | Equals | Exact state checks ("location equals cave") |
| `neq` | is not | Not equal | Exclusions ("not in the tutorial zone") |
| `gt` | > | Greater than | Thresholds ("affinity above 50") |
| `gte` | ≥ | Greater or equal | Inclusive thresholds |
| `lt` | < | Less than | Low-state triggers ("health below 20") |
| `lte` | ≤ | Less or equal | Inclusive low-state |
| `contains` | contains | String contains | Partial text matching |

Multiple conditions combine with **All** (every condition must pass) or **Any** (one is enough).

---

## Advanced techniques

### Recursion: chained context

When entry A triggers and its content mentions a keyword from entry B, should B also trigger? That's recursion. It's off by default (**Cascading triggers** = 0, under **Context** → **Advanced**) but can be turned on for worlds with interconnected lore.

**Use carefully.** Deep recursion chains can consume a lot of context. Most worlds keep it at 0 or 1.

Two safety controls on each entry:
- **Prevent Recursion**: This entry can trigger, but its content won't scan for other entries. "I can be woken up, but I won't wake anyone else."
- **Exclude from Recursion**: Only the player's actual words can trigger this entry. Invisible to recursive scans entirely.

### API role override

By default, all entries are sent as system messages. **Send as** changes how the AI interprets them:

- **Instruction** (system): The default. The AI treats it as a rule to follow.
- **User**: The AI thinks a player said this. Some models weigh user messages more heavily.
- **AI** (assistant): The AI thinks it said this itself. Useful for "pre-filling" a response style.

### Example dialogue

Entries whose **Inject into** is **Example dialogue** get special treatment. The engine parses them into user/assistant message pairs, so the AI sees actual conversation samples rather than a block of text.

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

The engine doesn't scan all of chat history for keywords. **Keyword scan depth** (default 2, up to 50) controls how many recent messages to check. On the canvas it's under **Context** → **Advanced**; **Panels → Lorebook** has the same setting under **Entry Settings**. Higher values catch more references but cost more processing.

There's also a token budget for triggered entries: the world settings `lorebookBudgetPercent` (default 100%) and `lorebookBudgetCap` (default 0, meaning no cap). The editor has no control for these; they're set in the card's data. When triggered entries exceed the budget, they're kept in **position** order (match score only breaks ties) and the rest are dropped.

### Folder organization

When your world has dozens or hundreds of entries, use folders: **Panels → Lorebook** has **Add Folder**, and you can drag entries into logical groupings (all NPCs in one folder, all location lore in another). Folders are purely organizational; they have no effect on runtime behavior, matching, or injection order.

### Position ordering

Within each section, entries are ordered by their **Position** number (lower = earlier), set in **Panels → Lorebook**. Supports decimals, so you can slot an entry between positions 2 and 3 by giving it position 2.5.

Earlier always-sent entries get cached more efficiently, so put your most stable content (character descriptions, world rules) at lower positions, and content that might change (dynamic instructions) at higher positions.

---

## Common mistakes

**Entries that never go out.** An entry with **Always Send** off and no keywords or conditions is never sent on its own. That's **Standby lore**, which is what you want when a behavior opens it. If you didn't mean that, give it keywords or a condition, or tick Always Send.

**Overlapping stage ranges.** If "Rin — Early Stage" is sent when affinity < 30 and "Rin — Growing Trust" when affinity > 25, both reach the AI between 26-29. Use non-overlapping ranges: `< 26` and `≥ 26` with `< 51`. The same goes for behaviors that enable and disable stage entries.

**Too-specific keywords that never match.** If your entry about the "Crystalline Sanctum" only triggers on `crystalline sanctum`, players who type "crystal place" or "that temple" will never see it. Think about how players actually refer to things, not just the canonical name.

**Depth injection too deep for important context.** An entry with depth 8 gets buried so far back in chat history that the AI barely weighs it. Keep important context at depth 2-4. Reserve higher depths for background flavor.

---

## See also

- [Designing Game State](/creator/advanced/variables-deep) — choosing and structuring the variables your entries react to
- [AI Directives & Macros](/creator/advanced/directives-macros) — the `{{macro}}` syntax and directive format used inside entries
- [Behaviors & Automation](/creator/advanced/rules-deep) — using **Enable lore entry** / **Disable lore entry** to open and close entries from behaviors

Full schema reference → [World Spec: Entries & Sections](/world-spec/entries)

</div>
