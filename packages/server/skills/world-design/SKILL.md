---
name: world-design
description: Compositional patterns for building Yumina worlds — stat systems, relationships, combat loops, choice branching, inventory, time/day cycles. Use as a reference library when the user asks for a game system that spans multiple entities.
---

# Skill: World Design Patterns

This skill is a pattern library. When a user asks for "a combat system" or "relationship tracking", reach for the matching pattern below — don't invent from scratch. A world is a **designed experience** assembled from these recurring compositions, not a loose pile of entries + variables + behaviors.

---

## Pattern 1 — Stat System (HP, mana, stamina, willpower, etc.)

**What it is:** A numeric resource with meaningful thresholds, visible to the player, changed by narrative events.

**Use when:** The user wants tracked numbers that influence the story (health, willpower, corruption, sanity).
**Skip when:** The number is purely cosmetic and never affects behavior — that's flavor, not a system.

**Composition:**
1. A **numeric variable** with `min`, `max`, clear defaults.
2. Precise `behaviorRules` with **ranges** and **threshold meanings**.
3. Optional **threshold behaviors** (`state:crossed`) to trigger narrative beats.
4. Optional **stat-bar component** (or custom TSX) so the player sees the value.

**Worked example — willpower with temptation:**

```
write_variable {
  id: "willpower",
  name: "Willpower",
  type: "number",
  defaultValue: 80, min: 0, max: 100,
  category: "stat",
  behaviorRules: "Player's resistance to temptation.
    80-100 = strong, clear-headed, resists easily.
    40-79 = wavering, internal conflict visible in narration.
    20-39 = weak, craves the forbidden, intrusive thoughts.
    0-19 = broken, describes compulsive behavior.
    Decrease 5-10 when player engages with tempting scenes.
    Decrease 15-25 on major transgressions.
    Increase 5-10 on moments of clarity or refusal.
    Never below 0 or above 100."
}

write_behavior {
  id: "willpower-crisis",
  name: "Willpower crisis trigger",
  when: { eventType: "state:crossed",
          match: { variableId: { operator: "eq", value: "willpower" },
                   direction: { operator: "eq", value: "drops-below" },
                   threshold: { operator: "eq", value: 30 } } },
  then: [{ type: "set", path: "@prompt.directive.willpower-crisis",
           value: { content: "Player is in willpower crisis. Describe intrusive thoughts, shaking hands, involuntary attraction to the forbidden. They are not in full control.",
                    position: "after_char", persistent: true } }],
  maxFireCount: 1,
  description: "One-shot: injects crisis narration when willpower breaks below 30."
}
```

**Pitfalls:**
- **Vague behaviorRules kill the system.** "Goes up and down" → AI never updates it. Write ranges. See the `variables` skill for depth examples.
- **No `maxFireCount` on threshold behaviors** → fires every turn after the crossing. Use `maxFireCount: 1` for one-shot beats.
- **Stat without narrative consequence** → player ignores the number. Tie at least one threshold to a directive or entry.

**Proven variant — critical-state notification** (safe `state:changed` pattern that `validate_world` does NOT flag):
```
write_behavior {
  id: "critical-health-warning",
  when: { eventType: "state:changed",
          match: { variableId: { operator: "eq", value: "health" } } },
  conditions: [{ variableId: "health", operator: "lt", value: 20 }],
  then: [{ type: "set", path: "@ui.notification", value: "Health is critically low!" }],
  priority: 80,
  cooldownTurns: 3
}
```
Safe: the effect targets a `@ui.notification` path (not the triggering variable) so no self-loop, and `cooldownTurns: 3` rate-limits toast spam.

---

## Pattern 2 — Relationship System (NPC affinity, trust, romance)

**What it is:** Per-NPC affinity variables that gate dialogue and unlock story branches.

**Use when:** The world has 1-5 key NPCs whose closeness to the player matters.
**Skip when:** >5 NPCs need tracking — use a JSON variable (see Multi-NPC Variant below).

**Composition:**
1. One numeric variable per NPC, range -100 to 100 (hostile → beloved).
2. Clear threshold semantics in behaviorRules.
3. Threshold behaviors that inject directives or toggle entries.
4. Optional: conditional entries gated on affinity (unlock new lore at high trust).

**Worked example — two NPCs:**

```
write_variable {
  id: "rel-alice",
  name: "Alice trust",
  type: "number", defaultValue: 0, min: -100, max: 100,
  category: "relationship",
  behaviorRules: "Alice's trust in the player.
    -100 to -50 = hostile, refuses to help, may attack.
    -49 to -1 = distrustful, minimal dialogue, no information.
    0 = neutral, polite but distant.
    1 to 49 = friendly, shares small talk.
    50 to 79 = close, shares secrets, offers to accompany player.
    80 to 100 = loyal, will die for the player.
    +5 to +10 for helping or agreeing. +20 for major aid.
    -5 to -15 for rudeness. -30+ for betrayal or harming her allies."
}

# Entry gated on high trust — only surfaces when earned
write_entry {
  id: "alice-secret",
  name: "Alice's secret past",
  content: "Alice was once the prince's lover...",
  section: "chat-history",
  keywords: ["past", "history", "alice"],
  conditions: [{ variableId: "rel-alice", operator: "gte", value: 50 }],
  conditionLogic: "all"
}
```

**Multi-NPC variant (6+ NPCs):** use one JSON variable:
```
write_variable {
  id: "relationships", type: "json", defaultValue: {},
  behaviorRules: "Object keyed by NPC id. Each has: trust (-100 to 100), met (boolean).
    Use dot-path: relationships.alice.trust. Create entries on first meeting."
}
```

**Pitfalls:**
- **Symmetric updates** (+5 for helping, -5 for rudeness) feel mechanical. Vary magnitudes based on severity.
- **Forgetting the gated content.** If no entry or directive depends on the relationship, the number is decorative.
- **Initializing at 50.** Starting at neutral (0) and earning trust is more rewarding than starting high.

---

## Pattern 3 — Combat Loop (turn-based resource management)

**What it is:** Player takes action → damage is computed → HP updates → death or reward triggers.

**Use when:** The world has explicit combat (RPG, battle arena, survival).
**Skip when:** Combat is narrative-only (describe a fight without tracking numbers).

**Composition:**
1. Resource variables: `hp` (player), optionally `enemy-hp`, `stamina`, `mana`.
2. Precise behaviorRules on **damage ranges** and **death semantics**.
3. Death threshold behavior (`state:crossed drops-below 1`) → directive that changes the game mode to "defeated".
4. Optional: `enemy-id` variable for current enemy + enemy lore entries gated on it.
5. Optional: combat HUD (stat-bar component for hp, text-display for enemy name).

**Worked example:**

```
write_variable {
  id: "hp", name: "HP", type: "number",
  defaultValue: 100, min: 0, max: 100, category: "stat",
  behaviorRules: "Player health.
    100 = full, 50 = bloodied (narrate visible wounds), 20 = critical (hands shaking, vision blurs), 0 = defeated.
    Light hit: -5 to -15. Solid blow: -20 to -35. Critical strike: -40 to -60. Lethal: set to 0.
    Resting: +10 to +30. Healing potion: +50. Never below 0 or above 100."
}

write_variable {
  id: "enemy-hp", name: "Enemy HP", type: "number",
  defaultValue: 0, min: 0, max: 999, category: "stat",
  behaviorRules: "Current enemy's health. Default 0 = no enemy. Set to enemy's max on encounter.
    Decrease as player attacks. At 0, enemy is defeated — narrate conclusion, set enemy-id to empty."
}

write_behavior {
  id: "player-defeated",
  name: "Player reaches 0 HP",
  when: { eventType: "state:crossed",
          match: { variableId: { operator: "eq", value: "hp" },
                   direction: { operator: "eq", value: "drops-below" },
                   threshold: { operator: "eq", value: 1 } } },
  then: [{ type: "set", path: "@prompt.directive.defeated",
           value: { content: "Player is defeated. Describe them losing consciousness. The next scene begins after they recover (or at a game-over screen if the world has one).",
                    position: "top", persistent: false, duration: 3 } }],
  maxFireCount: 1
}
```

**Pitfalls:**
- **No `maxFireCount` on death trigger** → fires every turn after HP hits 0. Use `maxFireCount: 1`.
- **Damage ranges overlap with healing ranges** → numbers never change meaningfully. Keep damage > healing for tension.
- **No enemy-hp tracking** → combat is vague ("you fight it for a while"). Track the enemy for pacing.
- **Over-precise damage** (e.g., "subtract exactly 7 on a punch") → mechanical. Give the AI a range.

---

## Pattern 4 — Choice Branching (player picks A/B/C, story diverges)

**What it is:** Key decisions that set a flag or variable, which gates later content.

**Use when:** The user wants meaningful choices (route selection, moral dilemmas, faction alignment).
**Skip when:** The story is fully emergent and the AI should decide consequences freely.

**Composition:**
1. A variable (flag, string enum, or number) capturing the choice.
2. Entries (conditional, chat-history) with different content per outcome.
3. Optional: a directive that shifts overall tone/arc based on the choice.
4. Optional: an app-surface TSX component rendering choice buttons.

**Worked example — moral alignment:**

```
write_variable {
  id: "alignment", name: "Alignment", type: "string",
  defaultValue: "undecided",
  behaviorRules: "Player's moral path. Values: 'undecided' (default), 'light', 'dark', 'neutral'.
    Set when player makes a defining choice:
    - Sparing an enemy → light.
    - Executing a prisoner → dark.
    - Refusing both → neutral.
    Once set, cannot change (the world remembers). Narrate consistent consequences."
}

write_behavior {
  id: "alignment-decided",
  when: { eventType: "state:changed",
          match: { variableId: { operator: "eq", value: "alignment" } } },
  conditions: [{ variableId: "alignment", operator: "neq", value: "undecided" }],
  then: [{ type: "set", path: "@prompt.directive.alignment-tone",
           value: { content: "Player has chosen {{alignment}}. Let NPCs remember this and react accordingly — fear, admiration, or indifference.",
                    position: "after_char", persistent: true } }],
  maxFireCount: 1
}

# Entry that only surfaces on the light path
write_entry {
  id: "light-path-reward",
  content: "The village welcomes {{user}} back, calling them the light-bringer...",
  section: "chat-history",
  keywords: ["village", "return", "welcome"],
  conditions: [{ variableId: "alignment", operator: "eq", value: "light" }]
}
```

**Route variant — pick the branch at the START (openings + worldbooks):** when the branch is chosen up front (which heroine, which scenario, which difficulty), don't make the AI infer it mid-play. Give the card **multiple openings (greetings)**, each seeding a route flag via `initialVariables` (e.g. `{ "route": "mayu" }`) and/or bound to a **worldbook** (knowledge base) that holds only that route's lore. Picking an opening activates its worldbook and seeds its variables — the other routes' books stay off, so contradictory routes never bleed together and you stay within budget. See the **lore** skill ("Worldbooks — one card, many routes"). Use this instead of one big always-on book + conditions when routes are mutually exclusive and chosen at the opening.

**Pitfalls:**
- **Branch without consequence.** If the choice doesn't change any entry or directive, the player feels their choice didn't matter.
- **Reversible alignment.** If the AI can change it back, the branch loses weight. Lock with `maxFireCount: 1` on the setter or enforce in behaviorRules.
- **Too many branches.** 2-4 outcomes is tractable. 10+ becomes unmanageable.
- **Two always-on books that contradict.** Putting mutually-exclusive routes on `always`-mode worldbooks injects both at once (the AI sees "you are a girl" AND "you are a boy"). Gate each by its opening (greeting mode) or a route condition.

---

## Pattern 5 — Inventory (items, gear, consumables)

**What it is:** A collection the player accumulates, spends, or equips.

**Use when:** Items matter for gameplay (quest items, consumables, gear with stats).
**Skip when:** "Inventory" is narrative only — describe items without tracking them.

**Composition:**
1. A JSON variable, typically an array of item objects.
2. `behaviorRules` specifying the object schema and when items are added/removed.
3. Optional: capacity cap enforced in behaviorRules.
4. Optional: an app-surface TSX component (grid or list) reading the JSON.

**Worked example — simple inventory with capacity:**

```
write_variable {
  id: "inventory", name: "Inventory", type: "json",
  defaultValue: [],
  behaviorRules: "Array of item objects. Schema: { id, name, qty, type }.
    type is one of: 'quest', 'weapon', 'consumable', 'misc'.
    Add with push operation: [inventory: push { id: 'sword-01', name: 'Rusted sword', qty: 1, type: 'weapon' }].
    Remove with delete by id: [inventory: delete id='sword-01'].
    Max 10 items total — if full, force the player to drop one before adding.
    Stack consumables by id: if adding 'potion' and it already exists, increment qty instead of duplicating."
}
```

**Alternative — two separate variables for clarity:**
If items have meaningful categories (quest items never get dropped; consumables do), split:
```
write_variable { id: "quest-items", type: "json", defaultValue: [], behaviorRules: "..." }
write_variable { id: "consumables", type: "json", defaultValue: [], behaviorRules: "..." }
```

**Pitfalls:**
- **No schema in behaviorRules** → AI adds inconsistent object shapes, component can't render reliably.
- **No capacity rule** → inventory bloats, clutters prompt.
- **Tracking items the narrative ignores** → pure overhead. Only track items the player can use or lose.

---

## Pattern 6 — Time / Day Cycle (turn count → time-of-day → scheduled events)

**What it is:** World time that advances with turns, gating events to specific times.

**Use when:** The world has time-sensitive content (shops that close at night, characters with schedules, NPC sleep cycles).
**Skip when:** Time is narrative flavor only — say "three days later" without tracking.

**Composition:**
1. A string-enum variable for the current time period.
2. A counter or decay variable + `turn:complete` behavior to advance it.
3. Conditional entries or behaviors gated on the time value.

**Gold-standard worked example — adapted from a shipped world's day/night cycle:**

```
# Time period as a string enum — AI narrates consistently within each period.
write_variable {
  id: "time-period",
  name: "Time of day",
  type: "string",
  defaultValue: "Morning",
  category: "custom",
  behaviorRules: "One of: Morning, Afternoon, Night.
    Advance one period after every 2–4 player actions or one major event.
    Morning → Afternoon → Night → (new day) Morning.
    Use to justify scene tone: shops closed at night, NPCs asleep, different ambience.
    Do not change mid-scene for narrative convenience — the cycle is authoritative."
}

# Day count auto-increments when the cycle rolls over to Morning.
write_variable {
  id: "day-count",
  name: "Day",
  type: "number",
  defaultValue: 0, min: 0, max: 99,
  category: "stat",
  behaviorRules: "0 before the game starts. Begins at 1 once the game begins.
    Increment by 1 at the end of each Night period."
}

# Auto-decay mechanic: a resource drops each turn via turn:complete.
# This pattern is fully safe — turn:complete fires once per exchange; hunger is external to the trigger.
write_variable {
  id: "hunger",
  name: "Hunger",
  type: "number",
  defaultValue: 100, min: 0, max: 100,
  category: "stat",
  behaviorRules: "100 = full, 50 = tired/weaker narration, 0 = starving (movement penalties, confusion).
    Decreases 5 per turn via auto-decay behavior. Restored by eating (+20 to +40). Never below 0 or above 100."
}

write_behavior {
  id: "auto-hunger-decay",
  name: "Per-turn hunger decay",
  when: { eventType: "turn:complete" },
  conditions: [],
  then: [{ type: "set", path: "hunger", value: 5, operation: "subtract" }],
  priority: 50
}

# Time-gated content — entry only surfaces at night.
write_entry {
  id: "shops-closed-at-night",
  content: "The shops are shuttered. Metal grates cover the doorways.",
  section: "chat-history",
  keywords: ["shop", "store", "market", "buy"],
  conditions: [{ variableId: "time-period", operator: "eq", value: "Night" }]
}
```

**Pitfalls:**
- **Self-loop trap:** a `state:changed` behavior whose effect writes back to the same variable will re-fire forever — add `cooldownTurns` or target a different variable (this is what `validate_world` flags as `behavior-self-loop-risk`).
- **Mechanical advancement feels artificial** → consider advancing time only on travel/rest actions or major narrative beats, not raw turn count.
- **No entries or behaviors depend on time** → the variable is decorative.

---

## Pattern 7 — Cast / Roster Selection (player picks which characters are present)

**What it is:** The player chooses a subset of a large cast (idol group, harem, party, class roster) at the start, and ONLY the chosen characters appear in the story. Everyone else stays off-stage.

**Use when:** The world ships many characters (a K-pop group, a class of students, a full party) and the player wants to focus on 1–N of them. "选两个成员，只有这两个出现" is exactly this pattern.
**Skip when:** All characters are always present (an ensemble where the whole cast matters every scene).

**The trap that breaks this every time:** building the selection UI + a variable that stores the picks, but forgetting the **gate entry**. Per-character profile entries are `system-presets` / always-send, so the engine injects ALL of them every turn regardless of the variable. Writing `selected-members` does nothing on its own — nothing reads it. The model sees all 13 full profiles and no instruction restricting the cast, so every character keeps showing up. **The variable + UI are necessary but NOT sufficient. The gate entry is the part that actually does the work.**

**Composition (all FOUR are mandatory):**
1. A `json` variable (e.g. `selected-members`) holding the array of chosen character names. Its `behaviorRules` must say: set by the frontend UI, do not modify during RP, lists the legal names. **It MUST carry `scope: "setup"`** (see the next point — the single most-missed field).
2. **`scope: "setup"` on that variable is NON-NEGOTIABLE for this pattern.** These cards almost always flow `pre-game cast screen → pick an opening (greeting)`. Picking an opening calls `switchGreeting`, and the engine RESETS session state to that opening's snapshot (built from world defaults), which silently wipes the player's cast pick back to the default `[]`/`""`. The engine carries a variable across that reset ONLY when it is `scope: "setup"` (see `preserveSetupScopedVariables` in `state/setup-scope.ts`). Without it, the gate entry below reads an empty roster every turn and the model falls back to "everyone is here." Do NOT try to fix this in the frontend with snapshot-and-rewrite hacks — they race against the engine's own async reset and are unreliable. The one-field data change is the correct fix.
3. The frontend selection UI calls `api.setVariable("selected-members", [...])` with the chosen names. Gate the picker on whether the variable is already set so it doesn't re-ask on re-entry (see front-ui skill).
4. **A gate entry** — `alwaysSend`, `section: "system-presets"`, low `position` so it sorts before the profiles — that names the selection variable and lays down the hard rule.

**Worked example — the scoped variable + the gate entry (both required):**

```
write_variable {
  id: "selected-members",
  name: "登场成员",
  type: "json",
  defaultValue: "[]",
  scope: "setup",                     // ← survives the opening switch; without this it resets to []
  behaviorRules: "由前端选人 UI 写入，列出本场登场成员的艺名。RP 过程中不得修改。空数组 [] = 全员登场。"
}

write_entry {
  id: "active-members-instruction",
  name: "登场成员限制",
  section: "system-presets",
  position: -1,                       // sorts before the per-character profiles
  content:
"【本场登场成员 · 铁律】\n" +
"本次会话的登场成员，以 <game-state> 区块中 `selected-members` 字段列出的名单为准。\n\n" +
"**只有 `selected-members` 名单里的成员，才能出现在这次故事中。没有被列入名单的成员，一律不得登场、不得被描写为在场、不参与任何对话或行动，也不得中途突然加入。所有旁白、对话和行动都只围绕名单内的成员展开。**\n\n" +
"若 `selected-members` 为空数组（[]），则视为全员登场。"
}
```

**Pitfalls:**
- **Forgetting `scope: "setup"` on the selection variable** (the silent #1 failure for any card that has the player pick an opening after the cast screen). Everything looks built — UI, variable, gate entry — but the cast pick is wiped the instant the player taps an opening, so the gate entry sees `[]` and the model plays everyone. Symptom the creator reports: "I selected 2 members but the narrator says `selected-members` is empty." If you ever hear that, check `scope` FIRST, before touching the frontend. Frontend timing patches (snapshot before `switchGreeting`, re-apply after, Promise chains, fallback writes on a later component mount) do NOT reliably fix it — they race the engine's async state reset.
- **Forgetting the gate entry** (the other top failure — see above). The UI works, the variable saves, and the player still sees everyone.
- **Trying to interpolate the picks inline with `{{selected-members}}`.** It stays LITERAL. The `{{...}}` macro only resolves bare word-identifiers (`{{class}}`) — a hyphenated id (`selected-members`) never interpolates, and the `{{var:...}}` / `{{getvar::...}}` forms do not exist. The reliable surface for any variable's live value is the `<game-state>` block, which is injected every turn (`selected-members: ["S.Coups","Mingyu"]`). So the gate entry must **reference the variable by id and point at `<game-state>`**, not embed `{{...}}`.
- **Gating per-character profiles with `conditions` instead of the prose rule.** `alwaysSend` entries bypass `conditions`, so a condition on an always-send profile is ignored. Either keep profiles always-send + rely on the gate entry (simplest, this is how shipped roster cards work), or make profiles non-always-send and toggle them via behaviors — do not mix.
- **Editing an already-built card and only doing the visible half.** When a card already exists with all-character always-send profiles and the user asks to "add member selection," you MUST add the gate entry too — do not report the feature complete after only building the UI and variable.

---

## Composing Patterns

Real worlds combine patterns:

- **A dungeon crawler** = Stat System (hp/mana) + Combat Loop + Inventory + optional Relationship System (for a party NPC).
- **A dating sim** = Relationship System (one var per love interest) + Choice Branching (date path selection) + Time/Day Cycle (scheduling dates).
- **A horror survival** = Stat System (sanity) + Inventory (rare consumables) + Choice Branching (morality) + Time/Day Cycle (night = danger spike).
- **An idol-group / large-cast simulator** = Cast/Roster Selection (player picks who's present) + Relationship System (one affinity var per chosen member) + optional Choice Branching (story routes).

When composing: create variables first, then behaviors, then gated entries last. That order lets you reference IDs that already exist.

## Pre-Flight Checklist (before writing a system)

Before calling write tools, answer:
1. **What experience does this create?** "Tension from willpower breaking" is a design goal; "a willpower variable" is not.
2. **Which pattern(s) apply?** Name them. If none apply, ask whether the user wants something truly novel or a mis-scoped request.
3. **What's the minimum entity set?** List each with its role ("variable X tracks Y, behavior Z triggers at threshold W").
4. **What are the threshold narrative beats?** Each threshold should change what the AI does. If not — drop the threshold.
5. **Does any part of this already exist?** Read the inventory. Extend, don't duplicate.

Skip the checklist only for trivial requests ("add a greeting", "rename this entry"). For any system spanning 3+ entities, run it.
