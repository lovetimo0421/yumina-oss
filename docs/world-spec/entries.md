# Entries & Sections

Entries are discrete content blocks the AI reads when generating each response. Every entry specifies **what** it contains, **when** the AI sees it, and **where** it's placed in the prompt.

## Entry Schema

```json
{
  "id": "unique-kebab-case-id",
  "name": "Display Name",
  "content": "The text content the AI reads...",
  "role": "character",
  "apiRole": "system",
  "section": "system-presets",
  "position": 0,
  "enabled": true,
  "alwaysSend": true,
  "keywords": [],
  "conditions": [],
  "conditionLogic": "all",
  "depth": null,
  "matchWholeWords": false,
  "secondaryKeywords": [],
  "secondaryKeywordLogic": "AND_ANY",
  "preventRecursion": false,
  "excludeRecursion": false,
  "tags": [],
  "folderId": null
}
```

## Sections

Entries are categorized into four delivery zones:

### `system-presets` — Always Sent

Included in every AI call. Use for essential world content.

- `alwaysSend`: true (automatic)
- Sorted by `position` (ascending)
- Placed at the top of the AI's context

### `examples` — Dialogue Samples

Parsed into user/assistant message pairs with an `[Example Chat]` marker. Shows the AI how characters should sound.

- `alwaysSend`: true (automatic)
- Content format: `<START>` separator between examples, lines alternating with character names

### `chat-history` — Keyword-Triggered, Depth-Injected

Only included when keywords match recent messages. Injected at a specific depth within the conversation history.

- `alwaysSend`: false (automatic)
- `depth`: number of messages from the end where this entry is inserted (0 = right before the latest message)
- `keywords`: array of trigger words (any match activates)

### `post-history` — Final Emphasis

Placed after all chat messages — the very last content before the AI generates. Gets the most attention.

- `alwaysSend`: true (automatic)
- Common use: output format instructions, style enforcement, CoT bypass

## Entry Roles

| Role | Purpose |
|------|---------|
| `system` | Narrator instructions, game rules, world mechanics |
| `character` | Character descriptions and personalities |
| `personality` | Character personality traits (separate from description) |
| `scenario` | Setting, situation, scene context |
| `lore` | World history, factions, background knowledge |
| `plot` | Story progression, quest hooks, events |
| `style` | Writing style, tone, formatting |
| `example` | Sample dialogue (use with `examples` section) |
| `greeting` | First messages on session start (special handling) |
| `custom` | Anything that doesn't fit above |

## API Roles

The `apiRole` field controls what LLM message role the entry is sent as:

| apiRole | Sent As | When to Use |
|---------|---------|-------------|
| `system` (default) | System message | Most entries |
| `user` | User message | CoT bypass prompts, fake user context |
| `assistant` | Assistant message | Example responses, tone setting |

## Keyword Matching

For `chat-history` entries:

### Primary Keywords
Array of strings. **Any** match triggers the entry.
```json
"keywords": ["tavern", "inn", "bar", "drink"]
```

### Secondary Keywords
Additional filter with logic operators:

| Logic | Meaning |
|-------|---------|
| `AND_ANY` | Primary matches AND at least one secondary matches |
| `AND_ALL` | Primary matches AND all secondaries match |
| `NOT_ANY` | Primary matches AND none of the secondaries match |
| `NOT_ALL` | Primary matches AND not all secondaries match |

### Recursion Control

- `preventRecursion: true` — This entry's content won't trigger other entries
- `excludeRecursion: true` — This entry can't be triggered by other entries' content (only by player/AI messages)

## Conditions

Entries can have state-based conditions that must be true for the entry to be included:

```json
"conditions": [
  {
    "variableId": "story-phase",
    "operator": "eq",
    "value": "act2"
  }
],
"conditionLogic": "all"
```

Operators: `eq`, `neq`, `gt`, `lt`, `gte`, `lte`, `contains`

## Official Presets

Yumina includes 5 optional built-in presets that creators can enable:

| Preset | Section | Position | Purpose |
|--------|---------|----------|---------|
| Fiction Mode | system-presets | 0 | Engage with all content naturally |
| Task | system-presets | 1 | "You are the narrator" instruction |
| Instructions | system-presets | 2 | Show don't tell, end mid-scene |
| Style | system-presets | 3 | Characters have independent voices |
| CoT Bypass | post-history | 0 | Post-history jailbreak (user role) |

## Prompt Assembly Order

The engine collects entries and assembles them in this order:

1. **System Presets** entries (sorted by position, ascending)
2. **Active persona** block (player's name, appearance, backstory)
3. **Static format block** (behavior rules, directive syntax, audio tracks)
4. **Example** entries (parsed into dialogue pairs)
5. *— cache breakpoint —*
6. **Triggered** system-block entries (keyword-matched)
7. `[Start a new Chat]` marker
8. **Story compaction** summary (compressed old messages)
9. **Session memory** block
10. **Chat history** with depth-injected entries
11. **Pending context** effects (from previous turn's rules)
12. **Dynamic format block** (current variable values)
13. **Post-history** entries (sorted by position)

Items closer to the bottom get more AI attention.
