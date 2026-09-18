# Variables & Directives

Variables are the world's game state. The AI reads current values each turn and writes bracket directives in its response to update them.

## Variable Schema

```json
{
  "id": "health",
  "name": "Health",
  "type": "number",
  "defaultValue": 100,
  "min": 0,
  "max": 100,
  "description": "Player's physical health",
  "behaviorRules": "0 = death. 1-20 = critical. 20-50 = wounded. 50-80 = bruised. 80-100 = healthy. Decrease on physical damage: punch -5 to -10, slash -15 to -25, fall -20 to -40. Rest +5, healing +10 to +30. Max change per turn: 30."
}
```

## Variable Types

### `number`

Numeric values with optional min/max bounds.

**Directive syntax:**
```
[health: set 50]       → set to 50
[health: +10]          → add 10 (alias: add)
[health: -15]          → subtract 15 (alias: subtract)
[health: *2]           → multiply by 2 (alias: multiply)
[gold: 100]            → implicit set (no operator)
```

### `string`

Text values.

**Directive syntax:**
```
[location: set "dark forest"]
[mood: set "suspicious"]
[notes: append " Found a clue."]
```

### `boolean`

True/false flags.

**Directive syntax:**
```
[has-key: toggle]        → flip true ↔ false
[met-elder: set true]
[quest-active: set false]
```

### `json`

Complex structures — objects and arrays. Supports nested dot-path updates.

**Directive syntax:**
```
[inventory: push {"name": "Iron Sword", "damage": 10}]
[inventory: delete 0]
[inventory: set [{"name": "Potion", "qty": 3}]]

[npcs.aria.affinity: +5]
[npcs.aria.mood: set "happy"]
[npcs: merge {"aria": {"trust": 80}}]
[quest-log: push {"id": "q1", "status": "active"}]
[config: delete "deprecated-key"]
```

**Dot-path operations:**
- `[root.nested.field: op value]` — updates a nested field within a JSON variable
- Auto-creates intermediate objects if they don't exist
- Array index access: `[inventory.0.durability: -1]`

## All Operations

| Operation | Types | Syntax | Behavior |
|-----------|-------|--------|----------|
| `set` | all | `[id: set value]` or `[id: value]` | Replace value |
| `add` / `+` | number | `[id: +10]` or `[id: add 10]` | Increment |
| `subtract` / `-` | number | `[id: -5]` or `[id: subtract 5]` | Decrement |
| `multiply` / `*` | number | `[id: *2]` or `[id: multiply 2]` | Scale |
| `toggle` | boolean | `[id: toggle]` | Flip true/false |
| `append` | string | `[id: append " text"]` | Concatenate |
| `merge` | json (object) | `[id: merge {"key": "val"}]` | Shallow merge |
| `push` | json (array) | `[id: push "item"]` or `[id: push {...}]` | Append to array |
| `delete` | json | `[id: delete "key"]` or `[id: delete 0]` | Remove key/index |

## Audio Directives

Audio is triggered through a separate directive format:

```
[audio: track-id play]
[audio: track-id stop]
[audio: track-id crossfade 2.5]
[audio: track-id volume 0.5]
[audio: track-id play chain:next-track]
```

## Behavior Rules

The `behaviorRules` field is plain English that gets injected into the AI's system prompt as a `<behavior-rules>` block. It teaches the AI when and how to update the variable.

**Effective behavior rules include:**
- What each value range means narratively
- What triggers changes (and in which direction)
- Magnitude guidelines (how much to change)
- Limits (max change per turn, absolute bounds)
- Relationships with other variables

**Example — Complex JSON variable:**
```
"behaviorRules": "Array of party members. Push new object when recruiting: {\"name\": \"...\", \"class\": \"...\", \"trust\": 50}. Update trust via dot-path: [allies.0.trust: +5]. To remove an ally, use a Behavior with an UpdateVariable JSON Patch action, or overwrite the whole array with [allies: set [...]]. Trust below 20 = may betray."
```

## ID Conventions

- IDs must be unique within the world
- IDs that consist of letters, numbers, and underscores are accessible as variable macros — e.g. `player_health` is reachable as <code v-pre>{{player_health}}</code> in entries. IDs containing `-` are **not** matched by the macro resolver, so prefer `snake_case` (or `camelCase`) for any variable you plan to reference via the double-brace macro syntax.
- The variable directive parser (used inside AI replies) does accept `-` in IDs, so `kebab-case` IDs still work in directives like `[player-health: +5]`.
- Avoid reserved words: `audio`, `user`, `char`, `time`, `date`
