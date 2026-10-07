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

## Module membership (worldbookId)

A behavior can belong to a module (worldbook) via `worldbookId` (write_behavior `{ worldbookId }`). A behavior in an INACTIVE module never fires — no WHEN/IF evaluation at all. Membership is re-checked per chain hop, so if an earlier hop's effect activates the module (e.g. sets the variable its activation condition watches), its behaviors join the SAME chain's later hops. Omit = the always-on Core. Group a mechanic's behaviors into the mechanic's module so one activation rule turns the whole system on/off — cheaper and safer than duplicating the same IF conditions onto every behavior.

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

## 自定义 — what cards used to hand-write, as data

Most published cards wrote these in their TSX. Build them with these pieces first; reach for TSX only for presentation (a stage, a minigame view). Stick a canvas sticky note on each custom part saying what it is for, its rules that must not break, its tuning numbers, and how to test it — that note is how the next AI (or you, next session) understands it.

**Custom AI calls** (write_worldbook station, usually `{ kind: "worker", trigger: { on: "ui" } }`, host on the card or a scenario):
- `sees: { variables: [ids], history: N, ownThread: true }` — what it is shown; `ownThread` gives it one memory thread of its own (each phone contact, each character in a multi-character stage).
- `pieces: [{ conditions, text }]` — prompt text added only while true (e.g. language decay at a value, warmer tone at high affection).
- `output: [{ name, type: text|number|choice|list, options?, min?, max?, hint?, to? }]` — the answer as JSON, validated (choices must be in `options`, numbers clamped), each field routed: `{kind:"say"}` (its words), `{kind:"variable", variableId, op: set|add|push}`, `{kind:"event", name?}`.
- `say`: "story" (a chat message), "none", or a channel name — the card hears it with `api.onAiOutput(channel, cb)`.
- `onError: { timeoutSec, retries, fallback: [lines], randomChoice }`, `cooldownSec`, `maxTokens`.
- The card calls it: `const r = await api.callAi("名字", input)` → `{ text, fields, fallback }` (null when not in play / cooling down / busy). A button step 「叫一个 AI」 (`run-ai`) calls it without code.

**Behaviours**:
- A button's 「让一条行为生效」 step can pass values: params `{ 商品: "伞", 价格: "{{price}}" }`. In the behaviour, `{参数.商品}` / `{参数.价格}` read them — in condition values, effect values and notices. A value that is only the token keeps its type (numbers stay numbers).
- `elseMessage`: shown to the player when the event happens but the conditions fail ("金币不够，要 {参数.价格}").
- `when: { eventType: "clock:every", match: { seconds: { operator: "eq", value: 30 } } }` — every 30 s while the game is open.
- `code`: the escape hatch — JS run in the card's sandbox when the behaviour fires: `ctx.vars`, `ctx.get(name)`, `ctx.set(name, v)`, `ctx.add(name, n)`, `ctx.push(name, x)`, `ctx.toast(text)`, `ctx.say(text)`, `await ctx.callAi(ai, input)`, `ctx.random(a, b)`. Only for what conditions/effects cannot say.
- Effect `emit { type: "ui:moment", title, message, image?, collect: "<list variable id>" }` — unlocks a moment once (skipped when the list already holds the title); mark the list `persist: "player"` for once per player, add `chance` for odds.

**Variables**: `formula` (worked out after every change, AI read-only: `min(40, 40 - len({dead-names}))`), `persist: "player"` (kept across playthroughs: clears, endings, CGs), `aiAccess: "none"` (the AI never sees it: hidden hands, UI state).

**Reply rules** (update_settings `replyRules`): catch `<状态>…</状态>` / `【状态】…【/状态】` / a regex in the AI's reply, `hide` it, and route it: `{kind:"fields"}` (each `名字: 值` into that variable), a variable, an event, or a channel. Tell the AI in an entry to write the block. `speakerBubbles: true` splits a reply into a bubble per speaker (`沈霏：…` lines).

**Turn-taking games with AI players** (cards, werewolf, liar's bar): one custom AI per seat; each seat's private hand in a variable with `aiAccess: "none"`, shown only to that seat via `sees.variables`; its move as a `choice` field whose `options` are the legal moves, `onError.randomChoice: true` so it always moves; route the move to an event or variable. Run the round in a code behaviour on the player's action:
```
for (const seat of ["玩家一", "玩家二", "玩家三"]) {
  const r = await ctx.callAi(seat, `轮到你。桌上：${ctx.get("桌面")}`);
  if (r) ctx.push("出牌记录", `${seat}:${r.fields.move}`);
}
```
A narrator AI (`say: "story"`) can then be called with what happened to tell it — the code decides, the AI narrates.

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
