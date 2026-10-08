---
name: lore
description: Design layered worldbuilding AND multi-route cards — worldbooks (knowledge bases), per-opening routes/scenarios, activation gating, factions, timelines, discoverable lore, frontend lore toggles. Use when the user wants worldbuilding/canon/factions/locations/history, OR multiple knowledge bases / worldbooks / routes / scenarios / branching openings, worldbook activation conditions, or player-controlled lore (LoreButton/LoreSlot).
---

# Skill: Lore Design

Plan lore as a layered world system, not a pile of unrelated entries.

## Workflow

1. Identify the lore job: foundation canon, factions, timeline, character lore, discoverable entries
2. Read what already exists before replacing it.
3. Decide the edit surface: entries only, entries + variables, entries + rules
4. Explain what you will create before calling write tools.

## Where to Put Lore

| Lore type | Section | Why |
|-----------|---------|-----|
| Core canon, character identity, scenario | system-presets | Always available to the AI, token-efficient (sent once, cached) |
| Discoverable knowledge (factions, locations, items, history) | chat-history + keywords | Only sent when relevant — saves tokens, surfaces contextually |
| Format enforcement, critical reminders | post-history | Strongest AI attention, use sparingly |

**Token strategy**: system-presets entries are always sent but cached — a 2000-token character description costs little after the first turn. chat-history entries only appear when triggered — ideal for large lore libraries where most entries aren't relevant every turn.

## Modules (Worldbooks / Knowledge Bases) — one card, many worlds

A card can hold MULTIPLE worldbooks — full MODULES, not just entry groups. A module is a named, independently-activatable container for **entries + variables + behaviors + openings**: while a module is inactive, its entries leave the prompt, its variables leave `<game-state>` (values kept), and its behaviors never fire. One activation rule gates a whole mechanic/country/route/chapter. On the Studio Blueprint canvas each module is a container node and everything you write appears live as nodes and wires.

- Membership is by `worldbookId` on the member: write_entry / write_variable / write_behavior all take `{ worldbookId }`; a greeting entry's `worldbookId` files that opening under the module. Members with no `worldbookId` live in the always-on **Core**.
- A worldbook's `activation` mode decides when it's online:
  - **always** — always online (like Core).
  - **conditions** — online only while variable conditions pass (e.g. `route == "mayu"`). Same condition shape as entry `conditions`.
  - **greeting** — online only when the player started on one of its bound openings (`greetingIds`).

### Two-layer gating (read this before designing routes)

Worldbook activation is the **OUTER** gate, evaluated FIRST. Then each surviving entry's own trigger (`alwaysSend` / `keywords` / `conditions`) runs **WITHIN** the active set:

- `alwaysSend` on an entry means "always send **while its worldbook is active**" — NOT globally. An alwaysSend entry in an *inactive* worldbook is dropped.
- A keyword/condition entry in an active worldbook still needs its keyword/condition to fire.

Mental model: **pick the active modules first → then run the usual matching inside them.** This is why putting two contradictory route books on `always` injects both — gate them by opening or condition instead. The same outer gate applies to member variables and behaviors (their own activation/conditions run WITHIN an active module).

### Building routes (the headline use)

"One card, multiple routes" is built two complementary ways — usually together:

1. **Greeting-bound worldbook** — bind a worldbook to opening(s): set its activation to `greeting` with the opening's greeting `id`(s). Picking that opening turns the book on; the other routes' books stay off.
2. **Opening seeds variables** — a greeting carries `initialVariables` (a map of `variableId` → starting value) seeded into session state when that opening is chosen. Use it to set a route flag (e.g. `route = "mayu"`) that `conditions`-mode worldbooks, conditional entries, and the frontend key off.

The chosen opening is a first-class session fact (engine `activeGreetingId`), so greeting-mode activation is revert/branch safe — never store "current route" in a throwaway field; use a declared variable (via `initialVariables`) or the greeting binding.

Per-opening starting values are edited in the editor under **Variables → Per-opening values** (a matrix; the First Message panel mirrors it read-only).

### 模块总控 (station) — a module that is its own AI

A module is a folder by default: its entries and variables join whichever AI is narrating, and that is what almost every module should stay. Give it a `station` and it becomes one of the AIs on the card.

```
write_worldbook { id: "wb-dungeon-1", station: {
  kind: "narrator",            // its AI answers the player while this module is active
  model: "…",                  // optional; falls back to the player's own model
  onClose: "archive",          // DEFAULT — see below
  archivePrompt: "务必记录死因、拿到的道具、欠下的人情",
  inputs: [ … ]                // what context flows in
}}
```

**A module IS a run.** A narrator station's activation span is one attempt. The moment it deactivates (its conditions stop matching — `active-dungeon-id` changes), that span leaves the AI's context forever and is replaced by ONE auto-generated summary (【副本记忆 · 模块名 · 第N次】…), while the player's visible transcript keeps every word. Re-activation starts attempt #2 clean. This is the infinite-flow wipe (无限流), and it is the DEFAULT for a narrator — `onClose: "keep"` opts out. There is no separate 副本模式 switch any more.

**Several AIs, one game.** Two dungeons with a narrator station each means dungeon 1's AI never sees dungeon 2's context, because activation already gates that and now the model and the context recipe are per-module too. At most one narrator is active at a time (ties break by `order`), so a player never receives two replies to one message.

**Memory pools.** By default every narrator remembers the whole conversation (the card's own pool). `memoryPool: "<name>"` narrows a narrator to the runs of every module naming the same pool: `{ memoryPool: "pool-ab" }` on A and on B means inside A the AI has A's and B's runs and nothing from C or D; `"pool-cd"` on C and D is the other group. A name used by one module alone is the tower — an AI that has never heard of the town. A pool is a VIEW: messages never leave the transcript, the player's scrollback keeps every word, and a narrator with no pool (the town) still sees everything. Cross-pool one-way reading is what `inputs` is for.

**Workers are the background AIs.** `kind: "worker"` never speaks to the player. It runs when triggered, and what it writes becomes context other modules can drink:

```
write_worldbook { id: "wb-chronicler", station: {
  kind: "worker",
  trigger: { on: "module-closed", from: "wb-dungeon-1" },
  task: "把刚打完的这一轮压成三行，只留因果和人情，写给下一个副本的叙述者看。",
  inputs: [{ kind: "memory", from: "wb-dungeon-1" }]
}}
```

The worker's own ENTRIES are who it is (史官 / 情报员 / 心理医生); `task` is the job. **A worker with no task or no trigger never runs** — the snapshot says so in those words, so check it before assuming a briefing is late. Other triggers: `{ on: "turns", every: N }` and `{ on: "conditions", conditions: […] }` (rising edge only, so a condition that stays true does not bill every turn).

**`inputs` is the wiring** — the lines a creator sees between gates on the blueprint board. A worker on `{ on: "ui" }` (a button calls it) or `{ on: "quiet" }` never reads them: the first sees what its `sees` gives it, the second reads the story. Each is `{ kind, from, as?, limit? }`:

| kind | what flows | cost |
|---|---|---|
| `memory` | the source module's archived past runs | cheap — start here |
| `worker` | a worker module's written outputs | cheap |
| `variables` | a snapshot of the source's variables by name (`from: "core"` for the card's own) | free |
| `transcript` | the source module's raw messages, last N (max 40) | expensive — a long dungeon will not fit |

`as: "history"` (default) reads as the protagonist's lived past — carrying your own memories out of dungeon 1 into dungeon 2. `as: "lore"` reads as an archive or hearsay ABOUT it — a rumour board, an investigator's case files, a chronicler briefing a stranger. Pick by whether the receiving AI was THERE.

Design rules that still hold:

- One dungeon = one `conditions`-mode module keyed on a router variable (`active-dungeon-id == "happy-home"`). The frontend or a behavior writes the router variable to enter and leave.
- Variables are NOT auto-reset when a span closes. Keep the run/account double ledger: run counters (`run-points`) settled into persistent ones (`account-points`) by behaviors on the gate flip.
- The wipe is prompt-side and conservative: switching `onClose` to `keep` stops folding instantly, and reverting back INTO a closed span un-folds it automatically.
- A "总结模块" is not a new object type. It is a worker with entries that give it a voice.

### Audience

An entry's `audience` controls who receives its content: `"ai"` (prompt only — hidden director notes), `"player"` (UI-facing only — the AI is NOT told it verbatim), `"both"` (default). Use `"player"` for codex/setting text the UI surfaces but the model shouldn't recite.

### Tools

- `write_worldbook` — create/update a knowledge base (`id`, `name`, `activation`, `enabled`, `order`). Activation is one of three modes only: `always`, `conditions` (variable-gated), `greeting` (active for listed opening IDs).
- `write_entry` with `worldbookId` — assign an entry to a book (omit / `""` = Core).
- `write_entry` on a `role:"greeting"` entry with `initialVariables` — seed a route's variables.
- `write_entry` with `audience` — set who sees an entry.
- `write_lore_binding` — wire a frontend slot to an entry (`slotId`, `entryId`, optional extra `conditions`) for `<LoreButton>`/`<LoreSlot>` player-controlled lore. Delete via `delete_entities` on the `slotId`.

Frontend-controlled lore (a player button toggles a book/entry on) uses `<LoreButton>` / `<LoreSlot>` in the rootComponent TSX (wired with `write_lore_binding`) — see the front-ui skill.

## Keyword Trigger Strategy

- Prefer a few strong keywords over many vague ones.
- Use `matchWholeWords` when names collide with common language ("rose" the character vs "rose" the flower).
- Use `secondaryKeywords` + `secondaryKeywordLogic` for multi-part reveals (primary: "ember court", secondary: "secret" with AND_ANY).
- Use `conditions` when lore depends on game state, not text matches.
- Use `preventRecursion` or `excludeRecursion` when chained lore would cause prompt bloat.

## When to Add Variables or Behaviors

- Add variables when lore depends on tracked state: reputation, faction membership, discovered locations, route flags
- **To gate lore on game state, put `conditions` directly on the entry** (or condition-mode worldbook). This is the modern path — do NOT route visibility through a behavior that toggles `@prompt.entry.<id>` (legacy/indirect; entries carry their own conditions now).
- If the user only asked for writing, don't invent mechanics unless the lore needs them to function

## Editing Guardrails

- Preserve existing canon unless the user explicitly asks for a rewrite.
- Reuse existing faction/place/character IDs when updating related lore.
- If replacing a lore system, read current entries first and summarize the replacement scope.
- For large worldbuilding: multiple focused entries > one monolith.

## Codeification Mode

When the user wants AI-optimized lore, produce compact structured blocks:

```text
[CODEIFIED_LORE::faction.ember-court]
entity_type: faction
essence: Imperial fire court built on ritual hierarchy.
public_truths:
- Rules eastern capitals through ceremony and debt.
- Treats oathbreaking as spiritual contamination.
relationships:
  ally: ash-cloister
  rival: river-league
ai_rules:
- Never describe the court as democratic.
- Mention ritual status before personal emotion.
```

- Keep prose entries for atmosphere. Codeified entries are companion references, not replacements.
- Put always-needed canon in system-presets. Put domain-specific codex in chat-history with keywords.
- Use stable kebab-case identifiers and explicit facts over paragraphs.

## Multiplayer Lore

When designing for multiplayer worlds:

- **DM-style system prompt**: Write a system-presets entry instructing the AI to manage multiple players as a narrator/DM
- **Per-player state**: Use a JSON variable (e.g., `players`) with dot-path addressing. No need for per-player entries.
- **Character-linked lore**: Use chat-history entries with character name keywords so lore surfaces when that character is discussed
- **Shared world state**: Use JSON variables for faction standings, world events, and locations that all players interact with
- The engine automatically includes a player roster in multiplayer prompts — no manual entry needed

## Response Pattern

Before write tools, name the exact surfaces:
- lore entries (which section, which keywords)
- supporting variables/rules (if needed)
- greeting or system prompt changes (if needed)

After changes, summarize: what each entry does, whether prose or codeified, and any variables/rules created.

## Anti-Patterns (avoid these)

- **One mega-entry** — stuffing all the world lore into a single 10K-token entry in system-presets burns context every turn. Split into focused entries; put always-needed canon in system-presets, discoverable lore in chat-history.
- **Keyword spam** — adding every synonym and related concept to `keywords`. Each keyword is a trigger; too many = noisy matches. Prefer 2-4 tight keywords per entry.
- **Contradictory canon** — two entries that make incompatible claims about the same entity. The gameplay AI will pick one inconsistently. Pick one version and delete/merge the other.
- **Codeified lore for atmosphere** — codeified format is compact but mechanical. Use prose for atmosphere (mood, tone, sensory detail), codeified for factual reference (faction tables, timelines).
- **Recursion without guardrails** — an entry that mentions a keyword triggering another entry that mentions yet another keyword can cascade and bloat the prompt. On a self-referencing lorebook this fires most of the pool every turn. Keep `lorebookRecursionDepth` at 0 unless chained reveals are essential; use `preventRecursion: true` on hub entries whose content would over-trigger. For a large keyword-lore library also set a `lorebookBudgetCap` (e.g. 20000–30000 tokens) as a ceiling, and tighten keywords (`matchWholeWords`, `secondaryKeywords`). The editor's per-turn estimate hides keyword-matched lore, so run `analyze_token_cost()` (it reports the keyword pool's worst-case per-turn injection and flags flood risk) to see the real cost. See the entries skill's "Lorebook Cost & Recursion" for the full fix hierarchy.
- **Hard constraints buried in lore** — "the character never does X" should be in a system-presets entry or post-history, not buried in a mid-tier lore entry that may not trigger.

## Validation Checklist

- [ ] Each entry has a clear, unique purpose (not duplicating another entry's scope)
- [ ] system-presets entries are only those needed EVERY turn (character identity, core scenario, hard constraints)
- [ ] chat-history entries have keywords OR conditions to trigger
- [ ] No contradictions between entries (especially character descriptions)
- [ ] Codeified lore uses stable kebab-case IDs and is paired with prose entries when atmosphere matters
- [ ] Any referenced variables (for conditional entries or macros) exist
