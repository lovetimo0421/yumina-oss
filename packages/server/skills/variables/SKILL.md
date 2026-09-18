---
name: variables
description: Create and manage game state variables (stats, inventory, flags, relationships). Use when working with HP, gold, scores, tracking, behaviorRules, or any numeric/boolean/string/JSON game state.
---

# Skill: Variables

## Categories

| Category | Purpose | Typical type | Example |
|----------|---------|-------------|---------|
| stat | Core character attributes | number | HP, mana, stamina, XP |
| inventory | Item collections | json (array) | Equipment, quest items |
| resource | Consumable numbers, min 0 | number | Gold, food, ammo |
| flag | Boolean toggles | boolean | Quest complete, NPC met |
| relationship | NPC affinity/reputation | number (-100–100) | Trust, fear, romance |
| custom | Anything else | string/number | Location, scene ID, phase |

## behaviorRules — CRITICAL

behaviorRules tell the gameplay AI when and how to change the variable. Without them, the AI won't update variables. Write them as specific instructions.

**Do NOT write directive syntax** (e.g., `[health: subtract X]`) in behaviorRules — the engine automatically teaches the AI directive format. Focus on **semantics**: what triggers changes, how much, and what thresholds mean narratively.

**Also note:** the engine does NOT pass variable `type`, `min`, `max`, or `description` to the AI — only the behaviorRules text. So write boundary values explicitly (e.g., "never below 0", "max 100", "0 = death").

**Bad vs Good**:

| Bad | Good |
|-----|------|
| "Changes during combat. Use [hp: subtract X]." | "Decrease 5-15 on minor injuries, 20-40 on major wounds. Increase 10-25 on rest/healing. 0 = death (narrate dramatically). Never below 0 or above 100." |
| "Goes up sometimes" | "Increase 5-10 when player helps NPC. Decrease 10-20 on betrayal. At 80+ they confide secrets. At -50 they become hostile." |
| "Track items" | "Add items as JSON objects with name and qty. Remove by filtering. Max 10 — force drop choice if full." |

Always include: **specific ranges**, **what triggers changes**, **edge cases** (min/max), **narrative consequences** at thresholds.

More examples:
- "0 = death. 1-20 = barely alive. 20-40 = wounded. 60-80 = minor scratches. 80-100 = healthy."
- "Set to true when player completes Chapter 1 quest. Never set back to false."
- "Below 20 = NPCs hostile. 20-50 = neutral. 50+ = trusted, special dialogue."

## AI access & activation — variable gating

Two orthogonal per-variable controls decide what the gameplay AI sees and when a variable is "in play". Use them instead of behaviorRules prose like "don't touch this" — the engine enforces them.

### aiAccess — what the AI may do

| Value | In `<game-state>` | AI can write | Use for |
|-------|------------------|--------------|---------|
| `write` (default) | yes | yes | State only the AI can judge: affinity, mood, narrative outcomes |
| `read` | yes, marked `(read-only)` | no — its directives are dropped | Engine-owned state the AI narrates but never changes: phase, rating, settlement results. Drive it from behaviors or the custom UI |
| `none` | no | no | Ledgers, counters, bookkeeping. Still fully usable in conditions, behaviors and the custom UI |

Design rule: **the AI should only write what only the AI can judge.** Everything mechanical (phase machines, settlement math, reward ledgers) belongs to behaviors + `read`/`none` variables. Cards with many `none` variables also pay far fewer prompt tokens — every `write`/`read` variable is echoed into the prompt EVERY turn.

`read`/`none` variables usually need no behaviorRules (nothing to teach the AI about updating); a `read` variable's behaviorRules, if present, should explain how to NARRATE it, not how to change it.

### activation — when the variable is in play

Same shape as a worldbook's activation. Omit = always active.

- `{ "mode": "manual" }` — gated by the variable's `enabled` default (set `enabled: false` to start off) plus runtime toggles: a behavior THEN effect on path `@vars.enabled.<id>` with a boolean value flips it.
- `{ "mode": "conditions", "conditions": [...], "conditionLogic": "all" }` — active while conditions match. `valueRef` works, and self-gating is legal ("show rage only while > 0" — conditions read raw values, so no circularity).
- `{ "mode": "greeting", "greetingIds": [...] }` — active only in sessions started from those openings. The first-class way to give each route its own variable set.

An **inactive** variable leaves `<game-state>` and the player UI and rejects AI writes, but **keeps its value** — conditions, behaviors and the custom UI still read it. To also reset it, have a behavior `set` it explicitly.

Example — dungeon flow: `阶段` is `aiAccess: "read"` (behaviors advance it, the AI narrates it); `直播积分` is `{ mode: "conditions" }` on `阶段` so it only appears mid-broadcast; the reward ledger is `aiAccess: "none"` with the settlement math in behaviors; a curated `当前可用道具` summary stays `write` if the AI must reference items in prose.

## Variable Types

### Number
Most common. Set `min`/`max` to prevent impossible states. Always add behaviorRules.

### Boolean
For flags and toggles. behaviorRules should specify exactly what event sets/clears them.

### String
For constrained text values. Specify allowed values in behaviorRules:
> "One of: tavern, forest, castle, dungeon. Changes when the player moves to a new location."

### JSON (objects and arrays)
For complex structured data — inventories, factions, companion rosters, nested state.

```json
{ "id": "factions", "type": "json", "defaultValue": {} }
{ "id": "inventory", "type": "json", "defaultValue": [] }
```

**JSON supports these operations:**
- merge — merge into object
- push — append to array
- delete — remove key
- dot-path addressing — `factions.ember_court.affinity` for nested fields

**When to use JSON vs separate variables:**
- JSON: naturally nested data (faction tree, inventory with metadata, player roster)
- Separate variables: each value needs its own behaviorRules, min/max, or UI component binding

JSON variables still need behaviorRules — explain the **structure** and **when to change**:
> "Object keyed by faction ID. Each faction has: affinity (number, -100 to 100), discovered (boolean), rank (string). Increase affinity 5-10 on cooperation, decrease 10-20 on betrayal. At affinity 50+ the faction offers trade deals."

## Per-opening starting values (routes)

`defaultValue` is the baseline starting value. When a card has multiple openings (greetings), each opening can OVERRIDE a variable's starting value for that route — e.g. opening "Mayu route" starts `route = "mayu"`, opening "Misa route" starts `route = "misa"`. This is the clean way to make openings behave as scenario/route presets (a condition-mode worldbook or conditional entry then keys off the seeded value).

- Stored on the greeting as `initialVariables`; seeded into session state when that opening is chosen (tracked as engine `activeGreetingId`, revert/branch safe).
- The single edit surface is the editor's **Variables → Per-opening values** matrix (the First Message panel mirrors it read-only). As the build AI, set them with `write_entry` on the greeting (`initialVariables`).
- See the **lore** skill ("Worldbooks — one card, many routes") for the full route model.

> ⚠ **Choosing an opening RESETS session state to that opening's snapshot.** Any variable a pre-game UI screen already wrote (e.g. the cast the player picked before choosing the opening) is wiped back to its default the moment the opening is selected — UNLESS the variable carries `scope: "setup"`. Setup-scoped variables are the only ones the engine preserves across an opening switch (and across revert/branch). So: a variable written by the frontend at session start and meant to persist for the whole session MUST be `{ ..., "scope": "setup" }`. This is the #1 cause of "I picked X on the start screen but the AI acts like I picked nothing." See world-design Pattern 7.

## Multiplayer Variables

In multiplayer, all players share one game state. Use a JSON variable for per-player data:

```json
{ "id": "players", "type": "json", "defaultValue": {} }
```

The AI addresses individual players with dot-paths (e.g., `players.alice.hp`).

behaviorRules example:
> "Each key is a player name. Each player has: hp (0-100, 0 = knocked out), gold (min 0), class (string), inventory (array). Decrease hp 5-15 on minor hits, 20-40 on major. Increase gold on quest completion."

Use separate top-level variables for shared state (world events, time, quest progress).

## Anti-Patterns (avoid these)

- **AI-writable variable with no behaviorRules** — the gameplay AI will not touch it. The variable becomes dead state. Write rules for every `aiAccess: "write"` variable. (Variables mutated only by behaviors/UI should be `read` or `none` instead — those need no update rules.)
- **behaviorRules prose as access control** — "the AI must never change this" is a hope, not a gate. Use `aiAccess: "read"` or `"none"`; the engine drops the writes.
- **behaviorRules that describe the tool syntax** — e.g. "Use `[hp: subtract X]` to decrease." The engine already teaches directive format automatically. Describe semantics (ranges, thresholds, narrative meaning), not syntax.
- **Creating a variable that duplicates existing state** — before writing, check the inventory. If `hp` exists and the user says "add a health stat", extend the existing one, don't create `health-points`.
- **Stats with no narrative consequence** — if no entry, behavior, or component reacts to the variable, the number is decorative. Either tie it to a threshold behavior or skip the variable entirely.
- **Symmetric +5/-5 updates for all events** — feels mechanical. Vary magnitudes by severity (minor event: +/-5; major event: +/-20+).
- **JSON variables without a schema in behaviorRules** — the AI will add inconsistent shapes. Always describe the object keys and allowed values.
- **String enums without the enum in behaviorRules** — "time-of-day changes" is useless. Say "One of: morning, noon, afternoon, evening, night."

## Validation Checklist (before writing)

- [ ] ID is kebab-case, no spaces, no special chars except `-` and `_`
- [ ] Type is appropriate (number for stats, boolean for flags, json for collections, string for enums)
- [ ] Min/max set for numbers (unless explicitly unbounded)
- [ ] defaultValue matches the type (100 not "100" for number; [] not {} for an array)
- [ ] behaviorRules exists for `aiAccess: "write"` variables (specific ranges + triggers + edge cases — see the rule above)
- [ ] aiAccess matches the owner: AI-judged → `write`; engine-owned but narrated → `read`; pure bookkeeping → `none`
- [ ] At least ONE place in the world reacts to the variable (else dead state)
- [ ] ID not already in use (check inventory)
