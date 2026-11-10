<div v-pre>

# AI Directives & Macros

The AI writes a story. Embedded in that story are short instructions — `[health: -15]`, `[gold: +50]` — that the engine strips out before the player sees anything. The player reads a clean narrative while the game state changes behind the scenes.

Macros work the other way: placeholders like `{{char}}` and `{{user}}` in your entries that the engine fills in before the AI reads them.

If you haven't read [Variables](/creator/variables) yet, start there. Directives only make sense once you understand what they're changing.

::: tip Which variables use directives
Variables with **Precise tracking** on (new Number and Switch variables start with it on) are changed by the tracking helper after each reply, not by directives. The AI sees them as read-only, and any directive it writes for them is dropped. Directives are how the AI changes everything else it's allowed to write: variables with Precise tracking off, Text without Allowed values, and List / table variables. Variables set to **AI read-only** or **Engine only** under **AI access** ignore directives too.
:::

---

## Why directives exist

In a tabletop RPG, the game master says "the goblin slashes your arm — take 15 damage" and the player erases a number on their sheet. In Yumina, the AI is the game master and the engine is the character sheet.

The AI could just output "the player now has 85 health" — but then you'd need the engine to parse natural language, figure out which variable changed, and calculate the new value. That's fragile and unreliable.

Instead, the AI writes a structured bracket at the end of its narrative:

```
The goblin's claw rakes across your forearm, drawing a hot line of pain.
[health: -15]
```

The engine sees `[health: -15]`, subtracts 15, clamps to the min/max bounds, and removes the directive from the text. The player sees only the story, and the status panel updates.

The AI never has to do the arithmetic or remember the bounds; the engine does both.

---

## Directive syntax

Every directive follows the same pattern:

```
[variable-id: operation value]
```

Three parts inside the brackets: **which variable**, **what to do**, and **with what value**.

### All nine operations

| Operation | Syntax | Example | What happens |
|-----------|--------|---------|--------------|
| **Set** | `[var: set value]` or `[var: value]` | `[location: set "forest"]` | Replaces the variable's value entirely |
| **Add** | `[var: add N]` or `[var: +N]` | `[gold: +50]` | Adds N to a number variable |
| **Subtract** | `[var: subtract N]` or `[var: -N]` | `[health: -15]` | Subtracts N from a number variable |
| **Multiply** | `[var: multiply N]` or `[var: *N]` | `[damage: *2]` | Multiplies a number variable by N |
| **Toggle** | `[var: toggle]` | `[has-key: toggle]` | Flips a boolean (true becomes false, false becomes true) |
| **Append** | `[var: append "text"]` | `[log: append ", found key"]` | Adds text to the end of a string variable |
| **Merge** | `[var: merge {...}]` | `[stats: merge {"level": 2}]` | Shallow-merges an object into a JSON variable |
| **Push** | `[var: push {...}]` | `[inventory: push {"name": "Sword"}]` | Appends an element to a JSON array |
| **Delete** | `[var: delete "key"]` or `[var: delete N]` | `[config: delete "old-field"]`, `[inventory: delete 0]` | Removes a key from a JSON object (quoted string) or an element by index from a JSON array (number). The value after `delete` is required — bare `[var: delete]` silently degrades into an implicit-set. |

**Paths into JSON variables.** `[relations.chars.lin: merge {...}]` writes inside a JSON variable. If the key does not exist yet, the write creates it: `merge` starts the object, `push` starts a one-item list, `add`/`subtract` count from 0. A path that runs through a plain value (`hp.max` while `hp` is a number) is skipped rather than overwritten. Array elements are addressed as `list.0.hp` or `list[0].hp`.

### Value syntax rules

- **Numbers**: bare digits — `10`, `3.5`, `-7`
- **Strings**: double-quoted — `"forest"`, `"magic sword"`
- **Booleans**: bare keywords — `true`, `false`
- **JSON**: inline object or array — `{"level": 2}`, `[1, 2, 3]`

### The shorthand trap

This is the most common source of confusion for new creators:

```
[health: -10]     → subtracts 10 (shorthand for subtract)
[health: +10]     → adds 10 (shorthand for add)
[health: *2]      → multiplies by 2 (shorthand for multiply)
[health: 10]      → SETS health to 10 (implicit set, NOT add)
```

The leading symbol (`-`, `+`, `*`) determines the operation. **No symbol means set.** So `[health: 50]` doesn't add 50 — it replaces the current value with 50.

To explicitly set a negative value (rare, but possible), write `[health: set -10]`.

### Naming: ID or display name

Directives can reference a variable by its **ID** (`player-hp`) or its **display name** (`Player HP`). The engine maintains a name-to-ID map and resolves both. IDs are more reliable, especially when display names contain spaces.

### Nested paths for JSON variables

When you have a JSON variable with nested structure, the AI can target specific fields using dot-notation:

```
[relationships.aria.trust: +10]
[game-state.factions.ember-court.affinity: set 75]
[inventory.0.durability: -1]
```

The engine navigates the path automatically. If intermediate objects don't exist, it creates them. This means the AI can update one field deep inside a complex object without touching anything else.

---

## Audio directives

Audio uses a similar bracket syntax — `[audio: track-id action]` — with actions like `play`, `stop`, `crossfade`, `volume`, and track chaining. For the complete audio directive reference with examples, see [Audio Design](/creator/advanced/audio-deep).

---

## The JSON Patch format

For complex operations — especially removing items from arrays — the engine supports an XML-wrapped JSON Patch format. This is also the format used by worlds migrated from SillyTavern.

```xml
<UpdateVariable target="inventory">
<JSONPatch>
[
  {"op": "remove", "path": "/0"},
  {"op": "replace", "path": "/1/durability", "value": 5}
]
</JSONPatch>
</UpdateVariable>
```

Four patch operations are supported:

| Operation | What it does | Example |
|-----------|-------------|---------|
| `replace` | Set a value at a path | `{"op": "replace", "path": "/health", "value": 80}` |
| `delta` | Add or subtract (positive adds, negative subtracts) | `{"op": "delta", "path": "/gold", "value": -50}` |
| `insert` | Add a new key-value pair | `{"op": "insert", "path": "/inventory/torch", "value": 1}` |
| `remove` | Delete a key or array element | `{"op": "remove", "path": "/0"}` |

Paths use forward slashes (`/health`, `/inventory/0`) which the engine converts to dot-paths internally.

::: details When to use JSON Patch vs bracket directives
Most of the time, bracket directives are simpler and the AI produces them more reliably. JSON Patch is useful for two specific cases:

1. **Removing array elements by index** — `[inventory: delete 0]` works, but JSON Patch's `{"op": "remove", "path": "/0"}` is the format some AI models produce more consistently when dealing with arrays.

2. **Batch operations on a single variable** — when you need to update several fields in one JSON variable at once, a single JSON Patch block is cleaner than five separate bracket directives.

If you're writing behavior rules for the AI, tell it which format to use. Most worlds stick to bracket directives exclusively. Only introduce JSON Patch if you specifically need array removal and bracket syntax isn't working reliably.
:::

---

## How the engine processes AI output

When the AI sends back a response, the engine runs it through a parsing pipeline before the player sees anything. Knowing the order helps you debug directives that aren't being picked up.

**Step 1 — Strip thinking tags.** Some models (like Gemini) output internal reasoning in `<thinking>...</thinking>` tags. The engine removes these first.

**Step 2 — Extract JSON Patch blocks.** The engine scans for `<UpdateVariable>` XML blocks and converts them to internal effect operations. Directives that some models wrap in a fenced `json` code block are picked up at this stage too.

**Step 3 — Extract audio directives.** Anything matching `[audio: ...]` is pulled out and queued for the audio system.

**Step 4 — Extract JSON directives.** Bracket directives with a JSON value (`set`, `merge`, `push`, `delete`) are extracted. These are parsed first because their JSON payloads could contain characters that confuse the simpler regex. `[image: …]` embeds are left alone.

**Step 5 — Extract standard directives.** Everything matching `[var: op value]` — the add, subtract, set, toggle, and other simple operations.

**Step 6 — Clean the text.** All extracted directives are removed. Extra blank lines are collapsed. The result is clean narrative text plus a list of effects.

After that, any [Reply processing](/creator/reply-rules) rules run on the clean text. The engine applies the effects (along with what Precise tracking decided) and checks behaviors. The player sees the clean text.

::: details Why parsing order matters
JSON directives are extracted before standard directives because a directive like `[stats: merge {"health": 50, "mana": 30}]` contains colons and numbers that the standard regex would misinterpret. By handling JSON patterns first, the engine avoids false matches.

If a directive isn't being recognized, the most common cause is malformed JSON — an unmatched brace or a missing quote. The engine silently skips directives it can't parse rather than crashing.

Full reference → [World Spec: Variables](/world-spec/variables)
:::

---

## Macros — dynamic text in your entries

Macros are placeholders you write in entries that the engine replaces with real values before sending to the AI. They look like this: `{{char}}`, `{{user}}`, `{{turnCount}}`.

Write your entries once, and they adapt to context. Change the character's name, and every `{{char}}` updates automatically. The player picks a persona, and `{{user}}` follows.

### Essential macros

| Macro | Expands to | Example output |
|-------|-----------|----------------|
| `{{char}}` | Current character's name | Luna |
| `{{user}}` | Player's name (or active persona name) | Kai |
| `{{turnCount}}` | Current turn number | 42 |

These three cover most use cases. You'll use `{{char}}` and `{{user}}` in almost every entry.

### Randomness macros

| Macro | Behavior | Example |
|-------|----------|---------|
| `{{random::a::b::c}}` | Picks one at random each time | `{{random::sunny::cloudy::rainy}}` might give "cloudy" |
| `{{pick::a::b::c}}` | Stable selection — same result within a turn | `{{pick::red::blue::green}}` always gives the same color on the same turn |
| `{{roll::NdS+M}}` | Dice roll: N dice, S sides, plus modifier M | `{{roll::2d6+3}}` might give 11 |

**The difference between `random` and `pick`**: `random` re-rolls every time the macro is expanded, so the same entry expanded twice might give different results. `pick` uses a stable hash based on the macro's position in the entry and the current turn number — it gives the same result every time within a turn, but may change next turn.

Use `random` for variety (weather, crowd descriptions). Use `pick` when consistency within a turn matters (a character's outfit should be the same if referenced twice). Use `roll` when you want dice-based mechanics the AI can react to.

### Time and date macros

| Macro | Expands to | Example output |
|-------|-----------|----------------|
| `{{time}}` | Current time (HH:MM) | 14:30 |
| `{{date}}` | Current date (local format) | 2026/5/13 |
| `{{weekday}}` | Day of the week | Tuesday |
| `{{isodate}}` | ISO date format | 2026-05-13 |
| `{{isotime}}` | ISO time format | 14:30:00 |
| `{{idle}}` | Time since last player message | 5 minutes |

These are real-world time, not in-game time. Useful for worlds that blend real and fictional time, or for idle-detection mechanics ("if the player hasn't responded in 10 minutes, the character sends a worried message").

### Context macros

| Macro | Expands to |
|-------|-----------|
| `{{lastMessage}}` | Full text of the last message |
| `{{lastUserMessage}}` | The player's last message |
| `{{lastCharMessage}}` | The character's last message |
| `{{model}}` | Name of the AI model being used |

### Player persona macros

Players create personas from the **Profile page → persona carousel** — named identities with appearance, personality, and backstory. When a persona is active, these macros pull from it:

| Macro | Expands to |
|-------|-----------|
| `{{persona_name}}` | Active persona's name |
| `{{persona_appearance}}` | Physical description |
| `{{persona_personality}}` | Character traits |
| `{{persona_backstory}}` | History and origin |
| `{{persona}}` | All four fields combined, plus any extra entries on the persona |

**Tip**: drop `{{persona}}` into a **Character and world** entry called "About the Player" and the AI will always know who the player is roleplaying as. When they switch personas, the AI catches up automatically.

`{{user}}` uses the active persona's name, or the player's username when no persona is active. If neither is known, it falls back to the card's default player name, then to "Player".

### Utility macros

| Macro | What it does |
|-------|-------------|
| `{{// comment text}}` | Comment. Expands to nothing — lets you leave notes in entries without sending anything to the AI |
| `{{trim}}` | Eats surrounding whitespace. For precise formatting control when macros leave awkward gaps |

### Variable fallback

If a macro name doesn't match any built-in macro, the engine checks if it matches a variable ID. If you have a variable with the ID `mood` and a current value of "suspicious", then `{{mood}}` expands to "suspicious". This only works for IDs made of plain letters, digits and underscores: `{{player_hp}}` works, `{{player-hp}}` doesn't. Variables added on the canvas get a random ID with hyphens, so give the variable a plain **ID** under **Advanced** in its settings before using it as a macro.

If it matches neither a built-in macro nor a variable, the engine leaves `{{xxx}}` as-is. No errors, no crashes.

---

## Patterns that work

### Combat with proportional damage

Define `health` (number, 0-100) with behavior rules that specify damage ranges by weapon type. The AI writes narrative, then tags on the directive:

```
The bandit's dagger catches you across the ribs — a shallow
cut, but it burns. You stumble back, keeping your guard up.
[health: -8]

You swing your greatsword in a wide arc. The bandit tries to
dodge but catches the blade across the shoulder. He screams.
[enemy-hp: -22]
```

The player sees a combat scene. The numbers do the bookkeeping.

### Relationship progression with conditional entries

Pair a number variable (`aria-trust`, 0-100) with entries gated on thresholds (Conditional lore on the canvas). The AI updates trust through directives, and the entry system automatically adjusts what the AI knows about the character's behavior at each stage:

- Entry "Aria — Guarded" (condition: `aria-trust < 30`): formal, keeps distance
- Entry "Aria — Warming" (condition: `aria-trust >= 30 AND < 60`): shares opinions, occasional smile
- Entry "Aria — Close" (condition: `aria-trust >= 60`): vulnerable, protective, inside jokes

The AI uses directives to move the number: `[aria-trust: +5]` after a kind interaction. (With Precise tracking on, the tracking helper moves it instead.) The entry system decides which version of Aria the AI sees. Neither system knows about the other — they communicate through the variable.

### Dynamic scene descriptions with macros

An entry that adapts to context:

```
{{char}} looks up as {{user}} enters the room. The current time
is {{time}}, and the weather outside is {{random::clear::overcast::drizzling}}.

{{char}}'s mood seems {{mood}} today.
```

If the character is Luna, the player is Kai, it's 2pm, and the `mood` variable is "tense", the AI receives:

```
Luna looks up as Kai enters the room. The current time is 14:00,
and the weather outside is overcast.

Luna's mood seems tense today.
```

### Dice-based skill checks

Put this in a narrator instruction entry:

```
When {{user}} attempts something risky, use the roll result
to determine success. Roll: {{roll::1d20}}. 15+ = success,
10-14 = partial success, below 10 = failure.
```

The AI receives an actual number and can narrate accordingly, so the outcome comes from the dice instead of the AI's judgment.

---

## Common mistakes

**Directives in the wrong place.** The engine already tells the AI to put directives at the end of its reply. If a model writes them inline anyway, the parsing still works, but it's harder to debug.

**Expecting the AI to do math.** The AI writes `[health: -15]`. The engine does the subtraction. Don't write behavior rules like "calculate the new health value" — the AI just needs to emit the right directive and the engine handles the arithmetic, including min/max clamping.

**JSON syntax errors in directives.** A mismatched brace or missing quote causes the engine to silently skip the directive. If a `merge` or `push` directive isn't being applied, check that the JSON payload is valid. The engine doesn't crash — it just moves on.

**Confusing `{{random}}` with `{{pick}}`.** If a character's eye color changes every time the entry is expanded, you used `random` when you meant `pick`. Use `pick` for stable attributes, `random` for intentional variety.

**Over-engineering with JSON Patch.** Unless you specifically need to remove items from arrays, stick with bracket directives. They're simpler, the AI produces them more consistently, and they're easier to debug.

**Forgetting that `{{user}}` follows personas.** If a player switches personas, `{{user}}` changes to the new persona's name. This is usually what you want, but be aware of it if you're using `{{user}}` in a way that shouldn't change mid-session.

---

## See also

- [Designing Game State](/creator/advanced/variables-deep) — choosing variable types and writing behavior rules
- [Writing Great Entries](/creator/advanced/entries-deep) — using `{{macros}}` inside entries and conditional entry design
- [Audio Design](/creator/advanced/audio-deep) — the complete audio directive reference

Directive syntax and operation specs → [World Spec: Variables](/world-spec/variables)

</div>
