# Yumina Skills & Templates — Contributor Guide

## Directory Structure

```
skills/
├── GUIDELINES.md              ← This file
├── _catalog.json              ← Template index (agent reads on startup)
│
├── <skill-name>/
│   ├── SKILL.md               ← Domain knowledge (loaded into agent prompt)
│   └── templates/             ← Optional: reusable code/config patterns
│       ├── <template-id>/
│       │   ├── meta.json      ← Template metadata
│       │   ├── renderer.tsx   ← Message renderer code (if applicable)
│       │   ├── component.tsx  ← Custom component code (if applicable)
│       │   ├── template.json  ← World template (entries/vars/rules/components)
│       │   └── preview.png    ← Screenshot (optional, for hub display)
│       └── ...
│
├── entries/SKILL.md
├── variables/SKILL.md
├── rules/SKILL.md
├── lore/SKILL.md
├── audio/SKILL.md
├── tsx/SKILL.md
└── front-ui/SKILL.md
```

## Adding a New Template

### 1. Create the template folder

```
skills/<skill-name>/templates/<template-id>/
```

Use kebab-case for `<template-id>` (e.g., `game-hud-renderer`, `rpg-combat-world`).

### 2. Create meta.json

```json
{
  "name": "Game HUD Renderer",
  "description": "Appends HP/gold/location/level status bar below every AI message",
  "tags": ["rpg", "hud", "stats"],
  "surface": "message-renderer",
  "requires": {
    "variables": ["hp", "maxHp", "gold", "location", "level"],
    "notes": "Create number variables for hp, maxHp, gold, level and a string for location"
  },
  "author": "yumina-official",
  "version": "1.0.0"
}
```

**Fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Human-readable display name |
| `description` | Yes | One-line description of what this template does |
| `tags` | Yes | Array of searchable tags |
| `surface` | Yes | Target surface: `"message-renderer"`, `"custom-component"`, `"world"`, `"pattern"` |
| `requires.variables` | No | Variable IDs the template expects to exist |
| `requires.notes` | No | Free text explaining prerequisites |
| `author` | Yes | Author identifier |
| `version` | Yes | Semver version |

### 3. Create the artifact

Name the main file based on the surface type:

| Surface | Filename | Content |
|---------|----------|---------|
| `message-renderer` | `renderer.tsx` | TSX code for `export default function RendererName(...)` |
| `custom-component` | `component.tsx` | TSX code for `export default function ComponentName(...)` |
| `world` | `template.json` | Partial WorldDefinition (entries, variables, rules, components) |
| `pattern` | `renderer.tsx` or `component.tsx` | Reusable UI pattern (greeting flow, form, etc.) |

### 4. Register in _catalog.json

Add an entry to `skills/_catalog.json`:

```json
{
  "id": "game-hud-renderer",
  "path": "tsx/templates/game-hud-renderer",
  "type": "renderer",
  "name": "Game HUD Renderer",
  "description": "Appends HP/gold/location/level status bar below every AI message",
  "tags": ["rpg", "hud", "stats"]
}
```

The `path` is relative to the `skills/` directory.

## TSX Code Rules

All TSX templates must follow these rules:

1. **Must export default**: `export default function ComponentName`
2. **No import statements**: `React`, `useYumina`, `Icons` (Lucide), and Tailwind CSS are pre-injected
3. **Use `React.useState`**, not bare `useState`
4. **Use `var`** for variable declarations (more reliable in the compiler)
5. **No TypeScript syntax**: No generics, interfaces, `as` casts, or type annotations
6. **Single file**: Define helper functions inside the file
7. **No direct browser APIs**: Never use `fetch()`, `localStorage`, `window.location`, `navigator.clipboard`. Use `useYumina()` SDK methods instead (components run in a sandboxed iframe)

### Message Renderer Props

```tsx
export default function MyRenderer({ content, role, messageIndex, variables, renderMarkdown }) {
  // content: string — clean text (directives stripped)
  // role: "user" | "assistant"
  // messageIndex: number — 0 = first message (greeting)
  // variables: object — live game state
  // renderMarkdown: function — converts markdown to safe HTML
}
```

### Custom Component Props (Full-Screen Mode)

```tsx
export default function MyComponent({ variables, metadata, worldName }) {
  var api = useYumina();
  // api.sendMessage(text), api.setVariable(id, value), api.executeAction(actionId)
  // api.variables, api.worldName, api.worldId, api.sessionId
  // api.messages, api.isStreaming, api.streamingContent, api.currentUser
  // api.playAudio(trackId, opts), api.stopAudio(), api.resolveAssetUrl(ref)
  // api.toggleImmersive(), api.copyToClipboard(text), api.navigate(path)
  // api.storage.get(key), api.storage.set(key, val), api.storage.remove(key)
  // api.revertToMessage(msgId), api.createSession(wid), api.deleteSession(sid), api.listSessions(wid)
}
```

## Editing SKILL.md Files

SKILL.md files contain domain knowledge injected into the agent's system prompt. They should:

- Be concise (the agent has limited context)
- Focus on decision-making guidance, not exhaustive reference
- Use tables for quick lookup
- Include "when to use" and "when NOT to use" guidance
- Reference templates by ID when relevant: "See template: `game-hud-renderer`"
- Stay current with the actual codebase (update when architecture changes)

## Future: Community Templates

Community-contributed templates will be stored in the database (not on disk) and follow the same meta.json format. The `_catalog.json` only indexes official built-in templates. Community templates are discoverable via API search.
