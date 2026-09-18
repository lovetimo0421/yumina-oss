# World Schema

A Yumina world is stored as a JSON object called `WorldDefinition`. This is the complete schema.

## Top-Level Structure

```json
{
  "id": "uuid",
  "version": "21.0.0",
  "name": "World Name",
  "description": "Short description",
  "author": "Creator Name",
  "language": "en",

  "entries": [],
  "variables": [],
  "rules": [],
  "reactions": [],

  "rootComponent": null,
  "components": [],
  "audioTracks": [],
  "bgmPlaylist": null,
  "conditionalBGM": [],
  "customUI": [],

  "entryFolders": [],
  "customTags": [],
  "customTagColors": {},
  "editorMode": "advanced",

  "settings": {
    "maxTokens": 12000,
    "maxContext": 200000,
    "temperature": 1.0,
    "topP": 1,
    "frequencyPenalty": 0,
    "presencePenalty": 0,
    "playerName": "Player",
    "lorebookScanDepth": 2,
    "lorebookRecursionDepth": 0
  }
}
```

## Field Reference

### Identity

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | UUID, auto-generated |
| `version` | string | Schema version, currently `"21.0.0"` |
| `name` | string | World name (1-200 chars) |
| `description` | string | Short description (0-10,000 chars) |
| `author` | string | Creator's display name |
| `language` | string (optional) | BCP 47 language code (`"en"`, `"zh"`, `"ja"`, etc.). Present in TypeScript interface but optional in Zod schema. |

### Content

| Field | Type | Description |
|-------|------|-------------|
| `entries` | WorldEntry[] | All content the AI reads — characters, lore, rules, greetings |
| `variables` | Variable[] | Game state definitions with behavior rules |
| `rules` | Rule[] | WHEN/IF/THEN automation triggers |
| `reactions` | Reaction[] (optional) | Event-pattern-based rules (newer system). Can be undefined. |

### Presentation

| Field | Type | Description |
|-------|------|-------------|
| `rootComponent` | RootComponent \| null | Custom UI virtual filesystem (React/TSX) |
| `components` | GameComponent[] | Built-in UI components (stat bars, etc.) |
| `audioTracks` | AudioTrack[] | BGM, SFX, and ambient tracks |
| `bgmPlaylist` | BGMPlaylist \| null | Auto-play music configuration |
| `conditionalBGM` | ConditionalBGM[] | State-triggered music |
| `customUI` | CustomUIComponent[] | Legacy UI system (use rootComponent instead) |

### Organization

| Field | Type | Description |
|-------|------|-------------|
| `entryFolders` | EntryFolder[] | Folder structure for organizing entries |
| `customTags` | string[] | Creator-defined tags for entries |
| `customTagColors` | Record\<string, string\> | Tailwind color classes for custom tags |
| `editorMode` | `"simple"` \| `"advanced"` | Editor complexity level |

### Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxTokens` | number | 12000 | Max tokens per AI response |
| `maxContext` | number | 200000 | Max context window size |
| `temperature` | number | 1.0 | AI creativity (0.0-2.0) |
| `topP` | number | 1 | Nucleus sampling threshold |
| `frequencyPenalty` | number | 0 | Penalty for repeated tokens |
| `presencePenalty` | number | 0 | Penalty for already-used tokens |
| `playerName` | string | "Player" | Default <code v-pre>{{user}}</code> replacement |
| `lorebookScanDepth` | number | 2 | How many recent turns to scan for keywords |
| `lorebookRecursionDepth` | number | 0 | How many levels of triggered-entries-triggering-entries |
| `topK` | integer (optional) | — | Limits candidate token count (min: 0) |
| `minP` | float (optional) | — | Minimum probability threshold (0-1) |
| `structuredOutput` | boolean (optional) | false | Forces JSON output format |
| ~~`lorebookBudgetPercent`~~ | ~~number~~ | — | **Deprecated** — token budgets were removed; all triggered entries are now included |
| ~~`lorebookBudgetCap`~~ | ~~integer~~ | — | **Deprecated** — see above |
| ~~`layoutMode`~~ | ~~string~~ | — | **Deprecated** — layout is automatic; field ignored |
| ~~`uiMode`~~ | ~~string~~ | — | **Deprecated** — layout is automatic; field ignored |
