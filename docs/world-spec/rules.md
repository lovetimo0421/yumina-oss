# Rules & Reactions

Rules fire automatically between turns based on events. They handle precise mechanics without AI involvement.

For new cards, prefer `reactions` with `when`, `conditions`, and `then` (see the Reaction schema below). `rules` with `trigger` and `actions` is the older, supported format. The Behaviors editor shows both; editing behaviors converts legacy rules while preserving their trigger settings. Do not store the same behavior in both arrays, as it would execute twice.

## Rule Schema

```json
{
  "id": "low-health-warning",
  "name": "Low Health Warning",
  "description": "Warn the player when health is critical",
  "trigger": {
    "type": "variable-crossed",
    "variableId": "health",
    "direction": "drops-below",
    "threshold": 20
  },
  "conditions": [],
  "conditionLogic": "all",
  "actions": [
    {
      "type": "notify-player",
      "style": "warning",
      "message": "Your vision blurs. You're barely standing."
    },
    {
      "type": "inject-directive",
      "directiveId": "critical-health",
      "content": "The player is near death. Describe their physical deterioration — stumbling, blurred vision, trembling hands.",
      "position": "after_char",
      "persistent": true
    }
  ],
  "priority": 50,
  "enabled": true,
  "cooldownTurns": null,
  "maxFireCount": null
}
```

## Trigger Types

| Type | Fields | Fires When |
|------|--------|-----------|
| `variable-crossed` | `variableId`, `direction` (`rises-above` \| `drops-below`), `threshold` | Variable crosses a threshold |
| `state-change` | `variableId` (optional) | Any variable changes (or a specific one) |
| `turn-count` | `atTurn` (number), `everyNTurns` (number) | At a specific turn number, or every N turns |
| `session-start` | — | First message of a new session |
| `keyword` | `keywords[]` | Player message contains any keyword |
| `ai-keyword` | `keywords[]` | AI response contains any keyword |
| `every-turn` | — | After every single turn |
| `action` | `actionId` (string) | A specific action is executed (e.g., from a custom UI button) |
| `manual` | — | Only fires when triggered by another rule |

## Conditions

Optional state checks that must pass for the rule to fire:

```json
"conditions": [
  {
    "variableId": "story-phase",
    "operator": "eq",
    "value": "act2"
  },
  {
    "variableId": "health",
    "operator": "gt",
    "value": 0
  }
]
```

Operators: `eq`, `neq`, `gt`, `lt`, `gte`, `lte`, `contains`

`conditionLogic`: `"all"` (AND) or `"any"` (OR)

## Action Types

### `modify-variable`
Change a variable value.
```json
{
  "type": "modify-variable",
  "variableId": "hunger",
  "operation": "subtract",
  "value": 5
}
```
Operations: `set`, `add`, `subtract`, `multiply`, `toggle`, `append`, `merge`, `push`, `delete`

### `inject-directive`
Add instructions to the AI's prompt for future turns.
```json
{
  "type": "inject-directive",
  "directiveId": "romance-mode",
  "content": "The character has developed feelings. Write romantic tension naturally.",
  "position": "after_char",
  "persistent": true
}
```
Positions: `top`, `before_char`, `after_char`, `auto`, `depth`, `bottom`

`persistent: true` keeps the directive active until explicitly removed. `persistent: false` (default) = one-shot, removed after one turn.

`duration`: optional number. When set, the directive auto-removes after N turns.

### `remove-directive`
Remove a previously injected directive.
```json
{
  "type": "remove-directive",
  "directiveId": "romance-mode"
}
```

### `notify-player`
Show a toast notification.
```json
{
  "type": "notify-player",
  "style": "warning",
  "message": "You're running low on supplies."
}
```
Styles: `info`, `achievement`, `warning`, `danger`

### `play-audio`
Trigger an audio track.
```json
{
  "type": "play-audio",
  "trackId": "bgm-battle",
  "action": "play"
}
```

### `toggle-entry`
Enable or disable a lorebook entry.
```json
{
  "type": "toggle-entry",
  "entryId": "secret-lore",
  "enabled": true
}
```

### `toggle-rule`
Enable or disable another rule (chain reactions).
```json
{
  "type": "toggle-rule",
  "ruleId": "phase-2-triggers",
  "enabled": true
}
```

### `send-context`
Send a one-shot context message to the AI on the next turn.
```json
{
  "type": "send-context",
  "message": "The player just triggered a hidden event. React accordingly.",
  "role": "system"
}
```
`role`: `"system"` (default) or `"user"` — determines how the context is injected into the conversation.

## Rule Options

| Field | Type | Description |
|-------|------|-------------|
| `priority` | number | Higher = fires first when multiple rules trigger (default: 0) |
| `cooldownTurns` | number \| null | Minimum turns between fires |
| `maxFireCount` | number \| null | Total times this rule can ever fire (null = unlimited) |
| `enabled` | boolean | Can be toggled by other rules |

## Reactions (Event Pattern System)

Reactions are a newer, more flexible rule system based on generic event patterns:

```json
{
  "id": "zone-enter-forest",
  "name": "Enter Forest",
  "when": {
    "eventType": "spatial:zone-enter",
    "zone": "forest"
  },
  "conditions": [],
  "conditionLogic": "all",
  "then": [
    {
      "type": "set",
      "path": "weather",
      "value": "foggy"
    },
    {
      "type": "set",
      "path": "@audio.ambient",
      "value": "forest-ambient",
      "operation": "set"
    },
    {
      "type": "emit",
      "event": { "type": "spatial:ambience-changed" }
    }
  ]
}
```

### System Effect Paths

Reactions can target system features via `@` paths:

| Path | Effect |
|------|--------|
| `@audio.bgm` | Play BGM track |
| `@audio.sfx` | Play SFX |
| `@audio.ambient` | Play ambient track |
| `@audio.stop` | Stop a track |
| `@prompt.directive.<id>` | Inject/remove directive |
| `@prompt.entry.<id>` | Toggle entry visibility |
| `@prompt.context` | One-shot context message |
| `@rules.disabled.<id>` | Toggle rule enabled/disabled |
| `@ui.notification` | Show toast notification |
| `@ai.request` | Trigger AI generation |
| `@ai.context` | Add context for next AI message |

## Events Generated Each Turn

After the AI responds, these events are emitted and checked against all rules/reactions:

1. `message:user` — Player's message (with content for keyword matching)
2. `message:ai` — AI's response (with content for keyword matching)
3. `turn:complete` — Turn finished (with turn count)
4. `state:changed` — One per variable that changed (with variableId, oldValue, newValue)
