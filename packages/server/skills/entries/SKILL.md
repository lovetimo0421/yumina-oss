---
name: entries
description: Create and manage world entries (characters, lore, system prompts, greetings). Use when working with lorebook, characters, NPCs, personas, scenarios, or example dialogue.
---

# Skill: Entries

## Sections

Every entry belongs to one of 4 sections. The section determines WHEN and WHERE it's sent to the AI:

| Section | Behavior | Use for |
|---------|----------|---------|
| `system-presets` | Always sent every turn | Character descriptions, system prompts, scenarios, style guides |
| `examples` | Always sent, formatted as dialogue turns | Example dialogue (few-shot prompting) |
| `chat-history` | Keyword-triggered, injected at a depth in chat history | Discoverable lore, pacing reminders, mid-conversation nudges |
| `post-history` | Always sent, placed after all chat (strongest AI attention) | Format enforcement, critical reminders |

Always set `section` when creating entries. The engine auto-derives `alwaysSend` and `depth`:
- system-presets → always sent
- chat-history → only sent when keywords match, depth defaults to 4
- post-history → always sent

**Positions 0–3 in system-presets are reserved** by official presets (fiction-mode, task, instructions, style). Omit `position` — see "Fields to NOT set" below.

## Send As (apiRole)

| Value | Effect |
|-------|--------|
| `"system"` (default) | AI treats it as instructions |
| `"user"` | AI sees it as a human message (for few-shot examples) |
| `"assistant"` | AI thinks it said this (for prefill, CoT bypass) |

## Entry Creation by Intent

| User says | Section | Tags | Extra fields |
|-----------|---------|------|-------------|
| "character", "NPC" | system-presets | ["Characters"] | |
| "system prompt" | system-presets | | |
| "scenario", "setting" | system-presets | ["Plot"] | |
| "lore", "world info" | chat-history | | Add keywords |
| "style guide" | system-presets | ["Style"] | |
| "example dialogue" | system-presets | | role: "example" |
| "format enforcement" | post-history | | |
| "pacing reminder" | chat-history | | depth: 4 |

## Fields to NOT set

- **position** — auto-assigned. Only set explicitly to reorder or insert between entries (floats allowed).
- **alwaysSend** — auto-derived from section. Never set.
- **role** — auto-derived from tags. Only set for "example" (special parsing) and "greeting" (first message).

## Tags

Tags are organizational labels for the editor UI. They do NOT affect prompt behavior.
- Default tags: **"Characters"**, **"Plot"**, **"Style"**
- First tag auto-sets the `role` field: Characters → "character", Plot → "plot", Style → "style"

## Keywords & Matching (chat-history entries)

Chat-history entries use keywords to decide when to inject. The engine scans the last N messages (default 2, configurable via `lorebook_scan_depth` setting).

| Feature | Field | When to use |
|---------|-------|-------------|
| Primary keywords | `keywords` | Always — any match triggers the entry |
| Whole word matching | `matchWholeWords` | When "cat" shouldn't match "category" |
| Fuzzy matching | `useFuzzyMatch` | When players might misspell keywords |
| Secondary keywords | `secondaryKeywords` | Require additional context beyond primary match |
| Secondary logic | `secondaryKeywordLogic` | AND_ANY (≥1), AND_ALL (all), NOT_ANY (none match), NOT_ALL (not all match) |
| State conditions | `conditions` | When lore depends on game state, not just text |
| Recursion control | `preventRecursion` | Stop this entry's content from triggering more entries |
| Recursion exclusion | `excludeRecursion` | Don't trigger this entry during recursive scans |

Regex keywords: wrap in slashes like `/dragon|wyrm/i`.

## Depth (chat-history entries)

`depth: N` = inject this entry N messages from the end of chat.
- depth 4 = placed 4 messages before the latest (default)
- The AI sees depth entries near the conversation that triggered them, not at the top of the prompt
- Good for contextual lore ("remember this NPC's secret") and nudges ("maintain tension")

## Worldbook membership, audience & gating

- `worldbookId` — which **knowledge base (worldbook)** this entry belongs to. Omit (or `""`) = the always-on **Core** book. An entry in a non-Core worldbook is gated by that book's activation (always / variable conditions / chosen opening) **before** its own `alwaysSend`/keyword/`conditions` trigger runs. So `alwaysSend` means "always **while this book is active**", not globally — an alwaysSend entry in an inactive book is dropped. Assign with `write_worldbook` (define the book) + `write_entry { worldbookId }`. See the **lore** skill ("Worldbooks — one card, many routes") for the route model.
- `audience` — who receives this entry's content: `"ai"` (prompt only — hidden director notes), `"player"` (UI-facing only; the model is NOT told it verbatim), `"both"` (default).

## Lorebook Cost & Recursion (diagnosing high per-turn token use)

Keyword-triggered (chat-history) lore is the #1 hidden driver of per-turn token cost on lore-heavy cards. Understand the mechanics before "optimizing":

- **The editor's "per-turn" estimate is misleading.** It counts only always-send entries + variable rules. It does NOT include keyword-matched lore. So a card showing "~10k per turn" can actually send 100k+ once its keyword entries fire. If a user reports "I trimmed the prompt but cost is still high," this blind spot is almost always why — they trimmed always-send content that was never the driver.
- **One keyword match injects the WHOLE entry.** An entry triggers if ANY one of its keywords appears as a substring of the recent messages. A 4,000-token entry with 20 keywords is 20 chances to inject all 4,000 tokens.
- **Recursion makes lore entries trigger each other.** `lorebookRecursionDepth` > 0 re-scans the *content of already-triggered entries* for more keywords. Because world lore cross-references itself (faction names, character names, place names), turning recursion on often cascades into firing most of the lorebook every turn — entries fire on words that appear only in *other entries*, not in the player's message. **Default and recommended: 0.** Only raise it when chained reveals are genuinely needed, and pair it with `preventRecursion` on hub entries.
- **No budget cap = no ceiling.** `lorebookBudgetCap` defaults to 0 (unlimited): every matched entry injects. `lorebookBudgetPercent` defaults to 100% of `maxContext`. Effective ceiling = min(cap, percent% of maxContext).

`analyze_token_cost()` reports the keyword-lore pool's worst-case per-turn injection and flags flood risk when the pool is large with no cap and/or recursion on — call it when a creator reports high per-turn cost (not as a routine self-check), and act on what it returns.

**Fix priority** when per-turn cost is too high (do in this order, not just the last one):
1. **Recursion → 0** (`update_settings lorebookRecursionDepth: 0`) — biggest single lever, no quality loss for well-scoped entries.
2. **Tighten keywords** — fewer and more specific; `matchWholeWords: true` for names that collide with common language; `secondaryKeywords` + `secondaryKeywordLogic: AND_ANY` so a broad word only fires alongside a co-occurring term. This fixes the root cause.
3. **Budget cap** (`update_settings lorebookBudgetCap: 20000`–`30000`) — a safety ceiling so one turn can never inject the whole pool. It's a backstop, not a substitute for tight keywords: when the cap is hit the engine drops the lowest-priority matches arbitrarily, which can silently omit relevant lore.

## Example Dialogue

Use `role: "example"` with this format:

```
<START>
{{user}}: Do you know about the dungeon?
{{char}}: *nods slowly* The dungeon beneath the tower has been sealed for centuries...
```

- `<START>` separates dialogue blocks
- `{{user}}:` and `{{char}}:` mark speaker turns
- Gets converted to alternating user/assistant messages

## Macros

Use in entry content — resolved at runtime:

| Macro | Result |
|-------|--------|
| `{{char}}` | Character name |
| `{{user}}` | **Persona-aware player name.** Resolution: active persona name → Yumina account nickname → world's `playerName` → `"User"`. No `{{user_avatar}}` macro — for avatars in TSX use `useYumina().user.avatar`. |
| `{{persona_name}}` / `{{persona_appearance}}` / `{{persona_personality}}` / `{{persona_backstory}}` | Individual persona fields. Empty strings when no persona is active. |
| `{{persona}}` | Full persona block assembled as `Name: X\nAppearance: ...\nPersonality: ...\nBackstory: ...` (only non-empty fields included). Useful in system prompts to brief the AI on who the player is role-playing as. |
| `{{variableId}}` | Variable's current value (use kebab-case ID) |
| `{{turnCount}}` | Current turn number |
| `{{random::a::b::c}}` | Random pick (changes each eval) |
| `{{pick::a::b::c}}` | Stable pick (same result for same turn) |
| `{{roll::2d6+3}}` | Dice roll sum |
| `{{time}}`, `{{date}}`, `{{weekday}}` | Current time/date |
| `{{isodate}}`, `{{isotime}}` | ISO format (YYYY-MM-DD, HH:MM:SS) |
| `{{idle}}` | Time since last user message ("2 hours") |
| `{{lastMessage}}` | Last message content (any role) |
| `{{lastUserMessage}}`, `{{lastCharMessage}}` | Last user/assistant message |
| `{{model}}` | Current LLM model ID |
| `{{trim}}` | Collapse surrounding whitespace |
| `{{// comment}}` | Removed from output |

## Folders

Set `folderId` on an entry to group it in the editor. Folders are UI-only — no prompt effect.

## Greetings (First Messages)

Greetings use `role: "greeting"` and appear in the **First Message** panel, not the lorebook.

Multiple greetings: create several entries with `role: "greeting"` — each becomes a swipeable first message (the platform adds swipe nav automatically). Set different `position` values to order them (lower = first); greetings are the ONE exception to the "omit position" rule above — ordinary entries still omit it.

**Per-opening routes:** a greeting can carry `initialVariables` — a map of `variableId` → starting value seeded into session state when a player picks that opening (e.g. `{ "route": "mayu" }`). This is how an opening becomes a route/scenario preset: the seeded variable drives condition-mode worldbooks, conditional entries, and the frontend. A worldbook can also bind directly to an opening (activation mode `greeting`). The chosen opening is tracked as engine `activeGreetingId` (revert/branch safe) — don't reinvent it. Edited in the editor under **Variables → Per-opening values**; see the **lore** skill.

For custom app components, use `api.switchGreeting(index)` from the `useYumina()` SDK to switch greetings.

## UI Naming

The editor labels entries **"Lorebook"** — when users say "lorebook" they mean entries.

## Anti-Patterns (avoid these)

- **chat-history entry with no keywords** — never triggers unless there are `conditions` that match state. Add keywords OR set `alwaysSend: true` if it must appear regardless.
- **Overly broad keywords** — keywords like "the", "a", "it", or generic genre words ("设定", "阶段", "技能", "神") match nearly every message and inject the whole entry every turn. Use specific nouns and names; multi-word keywords beat single words; add `secondaryKeywords` to gate broad words. See "Lorebook Cost & Recursion" above — broad keywords + recursion are the usual cause of runaway per-turn cost.
- **Recursion left on for a self-referencing lorebook** — `lorebookRecursionDepth` > 0 lets triggered entries' own text fire more entries; on a card whose lore cross-references itself this cascades into injecting most of the lorebook every turn. Keep it at 0 unless chained reveals are essential.
- **Conflicting entries in system-presets** — two entries that describe the same character differently (one says "friendly", another says "hostile") confuse the gameplay AI. Merge or disable one.
- **Macros that reference non-existent variables** — `{{char-health}}` when the variable is `hp` renders as the literal string. Check variable IDs before using macros.
- **Misspelled core macros** — `{{character}}` is NOT a macro; `{{char}}` is. `{{player}}` is NOT; `{{user}}` is. These typos render literally.
- **post-history for general lore** — post-history is the AI's strongest attention. Reserve it for format enforcement and critical last-turn reminders. Generic lore belongs in system-presets or chat-history.
- **Greeting entry in system-presets** — greeting text belongs in a `role: "greeting"` entry (see Greetings above), not a system-presets entry.
- **Duplicate IDs** — creating an entry with an existing ID is UPSERT (overwrites). If unintended, pick a different ID.

## Validation Checklist

- [ ] Section is set (not default-guessed). For character/lore/scenario: system-presets. For discoverable lore: chat-history with keywords.
- [ ] If `role: "greeting"`, content is a first message (not a lore dump)
- [ ] If the entry is a `role: "example"`, content uses `<START>` blocks with `{{user}}:` / `{{char}}:` turns
- [ ] `conditions` reference variables that exist, with operators valid for their types (e.g., `contains` only on strings)
