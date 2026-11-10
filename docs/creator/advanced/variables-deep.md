<div v-pre>

# Designing Game State

Every interesting world tracks something. Battle Royale tracks 40 students and who's still alive. Sakura Season tracks three separate relationship arcs. Wandering Diary tracks companion attitudes, inventory, and location state all at once.

For the basics of variable types, Behavior Rules and Precise tracking, see [Variables](/creator/variables).

---

## The creative decision: what should you track?

Before you add anything, ask yourself: **what does a player need to feel is real?**

In a survival game, the answer is resources — health, hunger, ammunition. The player needs to feel scarcity. In a romance, it's relationship depth — the player needs to feel that their choices are building toward something. In a mystery, it's knowledge flags — the player needs to feel the investigation narrowing.

You don't need a variable for everything. The AI handles narrative details perfectly well on its own — you don't need a `current_weather` variable unless weather mechanically matters. Track the things that **drive decisions and consequences**.

A good rule of thumb: if the value should affect what the AI writes next, make it a variable. If it's just flavor, let the AI improvise.

---

## How variables live and die

You **define** a variable on the canvas (type, starting value, range). It's **initialized** to its starting value when a player starts a new session. During play it changes in a few ways: the **Precise tracking** helper after each reply, the AI's bracket **directives** (for variables without Precise tracking), **behaviors**, buttons in the player interface, and **formulas** that recalculate from other variables. The entire game state is **persisted** at the end of each turn.

If you add a new variable to a world that players are already playing, existing saves automatically get the starting value on next load. If you remove a variable, it's silently filtered out. You can safely iterate on variable design without breaking anyone's save.

---

## Choosing the right type

The four variable types are covered in [Variables](/creator/variables). On the canvas they're called Number, Text, Switch and List / table (`number`, `string`, `boolean` and `json` in the card's data). The design decision is *which one to use when*, because the choice affects how the AI interacts with your world.

**Number** when the value changes gradually, you need thresholds for events, or the magnitude of change matters. Numbers get min/max bounds enforced by the engine, so you don't need to waste prompt space telling the AI "don't let health go below zero."

**Text** when the value is a label, not a quantity — locations, moods, story phases. Give it **Allowed values** when there's a fixed set (phases, moods): Precise tracking then picks only from that list. Don't use Text for two-state values (locked/unlocked); use a Switch instead.

**Switch** when something has either happened or hasn't. The simplest type, the easiest for the AI to manage, and the ideal gate for conditional lore and behaviors.

**List / table** when a single variable needs structured data: inventories with item properties, faction maps with multiple relationships, quest logs with nested progress. Don't use it for simple values — `[health: -10]` is more reliable than `[stats.health: -10]`. Precise tracking doesn't work on this type, so the AI changes it with directives.

---

## Writing behavior rules — the four-question formula

The same Behavior Rules are read by the story AI, or by the Precise tracking helper when that's on. Either way, great behavior rules answer four questions:

**1. What do the values mean?**
Give the AI a legend. For numbers, describe what each range represents narratively. For text, list the valid states. For switches, explain what on and off mean in the story.

**2. What triggers a change?**
Be specific about the situations. "Kind interactions increase affinity" is fine for a relationship variable. "Physical damage decreases health" works for HP. The more examples you give, the more consistent the AI will be.

**3. How much should it change?**
This is where most creators under-invest. Give magnitude ranges. Small moments should produce small changes, big events should produce big changes. Without this guidance, the AI tends to either over-react (every interaction is +20 affinity) or under-react (a near-death experience changes health by 2).

**4. What are the limits?**
Cap the maximum change per turn. This prevents wild swings that break immersion. With Precise tracking on, set **Most it can rise per turn** and **Most it can fall per turn** and the engine enforces them. Without it, write the cap into the Behavior Rules: "Never change by more than 15 in one turn."

::: tip
Two to four sentences is usually enough. If your behavior rules are longer than a short paragraph, simplify. Give the AI the concept and the boundaries, not a rulebook.
:::

---

## A few things worth knowing

**The `delete` operation** removes a key from a JSON object or an element from a JSON array. It works through normal bracket syntax — `[npcs: delete "aria"]` (quoted string for an object key) or `[inventory: delete 0]` (number for an array index). The one trap: `delete` needs a JSON-shaped value after it; the bare form `[var: delete]` falls through to an implicit-set and writes the literal string `"delete"` into the variable, which is almost never what you want. For batch removals or array-by-id deletes, a `<UpdateVariable>` JSON Patch block (see [AI Directives & Macros](/creator/advanced/directives-macros)) also works.

---

## Real patterns from published worlds

### Relationship tracking

Sakura Season uses separate number variables per heroine with behavior rules specifying magnitude ranges. That's the simplest approach and works well for 2-5 characters.

The alternative: a single JSON object holding all relationships.

```json
{
  "aria": { "trust": 50, "romance": 0, "met": true },
  "kael": { "trust": 30, "romance": 0, "met": false }
}
```

This is cleaner when you have many characters, because the AI can update any character with a dot-path (`[relationships.aria.trust: +10]`) and you can add new characters by merging in a new key. The trade-off: individual number variables are simpler for the AI to understand, harder to mess up, and can use Precise tracking.

**Choose separate variables** when you have 2-5 characters and want maximum reliability. **Choose a JSON object** when you have many characters or need to dynamically add new ones.

### Inventory systems

The simplest inventory is a Text variable the AI adds to with `append` — Battle Royale keeps its death roster this way. For a proper inventory with item properties, use a JSON array:

```json
[
  {"id": "torch", "name": "Torch", "qty": 1},
  {"id": "bread", "name": "Bread", "qty": 2}
]
```

Adding items uses `push`. Removing items uses `delete` with an index. The behavior rules should tell the AI which approach to use:

> Use push with a full item object to add items. To remove an item, use delete with the array index. Inventory limit: 10 items. When limit reached, the character must drop something first.

### Location and scene state

A Text variable called `location` (starting value: "starting village") is often all you need. The player's location changes as they travel (the AI writes `[location: set "dark forest"]`, or Precise tracking picks from the Allowed values), and [conditional lore](/creator/advanced/entries-deep#state-driven-entries) on `location` sends the right scene description.

For more complex worlds with multiple tracked aspects of a scene, use a JSON object:

```json
{
  "area": "castle",
  "room": "throne-room",
  "time": "night",
  "alert-level": "high"
}
```

The AI can update individual aspects: `[scene.alert-level: set "low"]` after sneaking past the guards.

---

For the complete directive syntax including all 9 operations, the shorthand trap, and dot-path notation for JSON variables, see [AI Directives & Macros](/creator/advanced/directives-macros).

---

## Common mistakes

**Over-tracking.** You don't need a variable for everything. If the AI can handle something narratively without a number behind it, skip the variable. Every variable you add is more state the AI has to read and keep consistent. Most good worlds track 5-15 things; very few need 50.

**Vague behavior rules.** "Track health" tells the AI nothing. "Decrease 5-15 on minor hits, 15-25 on major hits, 0 = death scene" tells the AI everything it needs. Behavior rules are the difference between a variable that works and one that gets ignored.

**Using JSON when a simple type would do.** If you just need a number, use a number. `[health: -10]` is simpler and more reliable than `[stats.health: -10]`. Save JSON for genuinely structured data.

**Forgetting min/max on numbers.** Without bounds, the AI might push health to -47 or gold to 999,999. Set a **Range** on every number variable. The engine clamps automatically.

**Not testing magnitude.** Play your world for 10 turns and check if the numbers feel right. If affinity jumps from 15 to 80 in three interactions, your magnitude ranges are too generous. If it barely moves after 20 turns, they're too tight. **This turn → Each value** in a [playtest](/creator/playtest) shows why each value moved or didn't.

**Making IDs hard for the AI.** Use simple, readable IDs like `health`, `player-gold`, `aria-trust` (a variable's **ID** is under **Advanced** in its settings). Avoid spaces, special characters, or names that could collide with built-in macros (`user`, `char`, `time`, `date`). If you want to write the value into lore as a `{{macro}}`, use underscores instead of hyphens (`player_gold`): hyphenated IDs, including the random ones new variables get, don't work as macros.

---

## See also

- [AI Directives & Macros](/creator/advanced/directives-macros) — directive syntax, all 9 operations, dot-paths, and the shorthand trap
- [Writing Great Entries](/creator/advanced/entries-deep) — conditional lore that reacts to your variables
- [Behaviors & Automation](/creator/advanced/rules-deep) — behaviors that fire when variables cross thresholds

Complete variable schema → [World Spec: Variables](/world-spec/variables)

</div>
