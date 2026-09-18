---
name: rules
description: Create WHEN/IF/THEN behaviors (reactions) that respond to game events and modify state. Use when the user wants automation, triggers, event handlers, game mechanics, spatial events, or conditional logic.
---

# Skill: Behaviors

Behaviors are WHEN/IF/THEN event handlers — world scripts that fire automatically during gameplay.
Use `write_behavior` to create or update behaviors. If the ID already exists it updates only the provided fields.

## Event Types (WHEN)

The `when.eventType` field determines what triggers the behavior. Use `when.match` to filter on event data.

| eventType | When it fires | Match fields |
|---|---|---|
| `turn:complete` | After every player-AI exchange | `turnCount` |
| `message:user` | Player sends a message | `content` (keyword match) |
| `message:ai` | AI responds | `content` (keyword match) |
| `session:start` | New session begins | — |
| `state:changed` | Any variable changes value | `variableId`, `oldValue`, `newValue` |
| `state:crossed` | Variable crosses a threshold | `variableId`, `direction` ("rises-above"/"drops-below"), `threshold` |
| `action:fired` | Custom action button pressed | `actionId` |
| `spatial:zone-enter` | Player enters a zone | `zoneName` |
| `spatial:zone-leave` | Player leaves a zone | `zoneName` |
| `spatial:proximity-enter` | Player approaches entity | `entityName` |
| `spatial:interact` | Player interacts with entity | `entityName` |
| `spatial:proximity-leave` | Player moves away from entity | `entityName` |
| `spatial:scene-change` | Scene changes | `sceneId`, `previousSceneId` |
| `spatial:exit-overlap` | Player exits overlap zone | `zoneName` |
| `audio:track-ended` | Audio track finishes playing | `trackId` |

### Match syntax

```json
{
  "eventType": "state:crossed",
  "match": {
    "variableId": { "operator": "eq", "value": "health" },
    "direction": { "operator": "eq", "value": "drops-below" },
    "threshold": { "operator": "eq", "value": 20 }
  }
}
```

Operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `every`

**Every-N-turns**: a `turn:complete` pattern with the `every` operator on `turnCount` fires every Nth turn (turnCount % N === 0 — so 5, 10, 15...). Plain `turn:complete` with no match fires every turn.

```json
{ "eventType": "turn:complete", "match": { "turnCount": { "operator": "every", "value": 5 } } }
```

## Conditions (IF)

`{ variableId, operator, value }` with `conditionLogic`: `"all"` (AND) or `"any"` (OR).
Operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`.

- **`variableId` resolves dot-paths** — compare a nested value directly: `{ variableId: "背包.金币", operator: "gte", value: 100 }`.
- **`contains` matches array membership** — for a `json` array variable, `{ variableId: "旗标", operator: "contains", value: "见过国王" }` is true when the array includes that element (still matches substring-in-string too).
- **Variable-vs-variable (`valueRef`)** — set `valueRef` to compare against another variable's current value instead of the literal `value` (which is then ignored). The RHS also resolves dot-paths.

```json
{ "variableId": "好感", "operator": "gt", "valueRef": "戒心" }
```

Fires while 好感 > 戒心 — use when the threshold itself moves with the game. Omit `valueRef` for a literal comparison.

## Effects (THEN)

Two effect primitives — `set` (modify state) and `emit` (trigger events):

### `set` — modify state

```json
{ "type": "set", "path": "health", "value": 10, "operation": "subtract" }
```

Operations: `set`, `add`, `subtract`, `multiply`, `toggle`, `append`, `merge`, `push`, `delete`

**Variable operand (`valueRef`)** — make the operand another variable's current value instead of the literal `value`. The engine reads the referenced variable (by id or dot-path) at fire time, before the operation runs:

```json
{ "type": "set", "path": "生命", "operation": "subtract", "valueRef": "力量" }
```

Applies 生命 -= 力量 with live values, so the math never goes stale. Works with any numeric operation (`add`/`subtract`/`multiply`/`set`).

**Random operand (`valueRandom`)** — make the value a random draw resolved at fire time. This is how you randomize ANYTHING: it composes with every operation, so the same primitive covers random HP loss, gold drops, stat rolls, and picking a random character/event. Three kinds:

```json
{ "type": "set", "path": "生命", "operation": "subtract", "valueRandom": { "kind": "range", "min": 5, "max": 15 } }
{ "type": "set", "path": "力量", "operation": "set",      "valueRandom": { "kind": "dice", "count": 3, "sides": 6, "modifier": 2 } }
{ "type": "set", "path": "今日拷问官", "operation": "set", "valueRandom": { "kind": "list", "candidates": ["霜月","锦织","白医生"], "cooldown": 3, "historyVar": "登场历史" } }
```

- `range` → a number in `[min, max]` (integer unless `"integer": false`). Keep the `operation` you want (subtract for damage, add for loot, set for a fresh roll).
- `dice` → `count`d`sides` + `modifier` (e.g. 3d6+2). Range is `[count+modifier, count*sides+modifier]`.
- `list` → pick ONE candidate. **Use `operation: "set"`.** Optional `weights` (parallel to `candidates`, higher = more likely; must be the SAME count as candidates or it's ignored and treated as equal). Optional no-repeat window: `cooldown: N` excludes the last N picks, backed by a `historyVar`. **Declare that historyVar as a `json` variable with `defaultValue: []` AND `internal: true`** — internal so it persists but never shows to the player/AI (`<game-state>`) or clutters the creator's variable list. `onExhausted`: `"full"` (default, fall back to all) or `"keep"` (change nothing).
- Candidates can instead come from an array variable: `"candidatesVar": "角色池"` (omit `candidates`).
- The engine does the draw — never ask the AI narration to "pick randomly"; LLMs are biased samplers. Trigger a list draw on `state:changed` of a day counter (once per day), not `turn:complete` (re-rolls every message).

`@`-prefixed paths (`@prompt.*`, `@audio.*`, `@ui.*`, `@rules.*`, `@ai.*`) control engine subsystems — see the **@ System Paths** table below.

### `emit` — trigger events

```json
{ "type": "emit", "event": { "type": "ui:notification", "message": "Quest complete!", "style": "achievement" } }
```

Emit target event types are listed in the **Emit Targets** table below.

## Limits

| Field | Effect | Example |
|---|---|---|
| `cooldownTurns` | Min turns between firings | 3 = can't fire for 3 turns |
| `maxFireCount` | Lifetime fire limit | 1 = one-shot story beat |
| `chance` | Probability 0-100 that it fires when it otherwise would | 30 = a 30%-chance random event; omit/100 = always |
| `enabled` | Runtime toggle via other behaviors | Start disabled, enable via `@rules.disabled.X` set effect |

`chance` is how you make an event *sometimes* happen (random ambush, random weather flip). It rolls AFTER the WHEN/IF gates pass, and a skipped roll doesn't consume the cooldown — so a 30%-per-turn event keeps rolling each turn.

## The Game Loop

Firing order: AI response → parse directives → apply variable changes → behaviors evaluate (event pattern + conditions) → behaviors fire effects (set/emit), chained behaviors resolve → next turn.

## @ System Paths — Controlling Engine Subsystems

### Prompt System
| Path | Value | Effect |
|---|---|---|
| `@prompt.directive.<id>` | `"instruction text"` | Inject persistent directive (auto position, persistent) |
| `@prompt.directive.<id>` | `{ "content": "...", "position": "auto", "persistent": true, "duration": 5 }` | Full control: position (auto/top/before_char/after_char/bottom/depth), persistence, auto-expire after N turns |
| `@prompt.directive.<id>` | `false` | Remove the directive |
| `@prompt.entry.<id>` | `true` / `false` | Enable/disable a lorebook entry |
| `@prompt.context` | `"context text"` | One-shot context message for next AI call (alias: `@ai.context`) |

### Audio System
| Path | Value | Effect |
|---|---|---|
| `@audio.bgm` | `"track-id"` | Play a BGM track |
| `@audio.sfx` | `"track-id"` | Play a one-shot sound effect |
| `@audio.stop` | `"track-id"` | Stop a playing track |

### UI System
| Path | Value | Effect |
|---|---|---|
| `@ui.notification` | `"message text"` | Show a toast notification (info style) |

### Rules System
| Path | Value | Effect |
|---|---|---|
| `@rules.disabled.<id>` | `true` | Disable another behavior |
| `@rules.disabled.<id>` | `false` | Re-enable a behavior |

### State System
| Path | Value | Effect |
|---|---|---|
| `@vars.enabled.<variableId>` | `true` / `false` | Override a variable's enable gate. While off, the variable leaves `<game-state>` and the player UI and rejects AI writes — but KEEPS its value (conditions/behaviors/UI still read it). Pairs with `activation: { mode: "manual" }` on the variable (see the variables skill). |

### Spatial System (requires `systems: ["spatial"]` in world)
| Path | Value | Effect |
|---|---|---|
| `@scene.current` | `"scene-id"` | Change the active scene |
| `@scene.player.x` | number | Set player X position |
| `@scene.player.y` | number | Set player Y position |
| `@scene.player.facing` | `"up"/"down"/"left"/"right"` | Set player facing |

### Emit Targets

Well-known event types for the `emit` effect:

| Event Type | Fields | What it does |
|---|---|---|
| `ui:notification` | `message`, `style` ("info"/"achievement"/"warning"/"danger") | Show toast to player |
| `audio:play` | `trackId`, `action` ("play"/"stop"/"crossfade"/"volume"), `volume?`, `fadeDuration?`, `chainTo?`, `maxDuration?` | Full audio control |
| `ai:context` | `message`, `role` ("system"/"user") | Inject one-shot AI context |

**When to use `set @audio.bgm` vs `emit audio:play`**: The `set` shorthand is simpler for basic play/stop. The `emit` version gives full control (volume, fade, chain, maxDuration).

## Best Practices

- **One-time milestones**: `state:changed` + conditions + `maxFireCount: 1`
- **Plot shifts**: set `@prompt.directive.quest-mood` to inject persistent AI instructions
- **Behavior sequencing**: set `@rules.disabled.X` to enable/disable behaviors in chains
- **Phase-scoped variables**: set `@vars.enabled.X` to bring variables in and out of play as the story enters/leaves a phase (dungeon loot, mid-broadcast score)
- **Interactive mechanics**: `message:user` with match on content for "search", "rest", "examine"
- **Passive systems**: `turn:complete` + conditions for regen, decay, upkeep
- **Spatial gameplay**: `spatial:zone-enter` to trigger location-based events
- **Notifications**: emit `ui:notification` for player-facing toasts, set `@ai.context` for AI-facing nudges
- **Audio transitions**: set `@audio.bgm` for simple play, emit `audio:play` with chainTo for SFX→BGM

## Anti-Patterns (avoid these)

- **No `maxFireCount` on one-shot beats** — a threshold behavior that should fire once (like "player defeated" or "first alignment chosen") will re-fire every turn after the trigger. Always cap one-shots with `maxFireCount: 1`.
- **No `cooldownTurns` on repeating ticks** — a `turn:complete` behavior that advances a timer or applies drain needs a cooldown if you don't want it firing literally every turn. Example: day/night advancement needs `cooldownTurns: 5`.
- **Referencing a variable that doesn't exist** — conditions and `state:crossed` match fields that target a missing variableId silently evaluate to false; the behavior never fires. Always check the inventory for the variable first.
- **Circular behavior chains** — Behavior A fires → sets variable X → Behavior B fires (triggered by X) → sets variable Y → Behavior A re-triggers via Y. Cap loops with `maxFireCount` or disable chains via `@rules.disabled.<id>`.
- **Directives that repeat entry content** — a directive that just rephrases what a character entry already says is noise. Directives should inject NEW runtime-specific instructions the entry can't anticipate.
- **Stacking directives with the same ID** — `set @prompt.directive.mood` overwrites, but different IDs accumulate. Review active directives periodically; use `set @prompt.directive.X: false` to remove.
- **Using `every-turn` trigger without conditions** — fires every turn unconditionally. Either use `turn:complete` with conditions, or keep the always-fire semantic but confine via cooldown.
- **Missing `direction` in `state:crossed`** — the engine needs `direction: "rises-above"` or `"drops-below"`. Without it, the behavior doesn't match.

## Validation Checklist

- [ ] `when.eventType` is a valid type from the table above
- [ ] `when.match` fields use the correct operators and value types
- [ ] For `action:fired`: the referenced `actionId` is wired to a button somewhere (entry content, custom UI)
- [ ] Every referenced `variableId` exists — in `when.match`, conditions, and any `valueRef` (dot-paths resolve into existing vars)
- [ ] Every effect's `path` is a real variable ID or a valid `@system.path`
