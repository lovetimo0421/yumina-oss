# How It Works

Every time a player sends a message in Yumina, the same chain of things happens. Once you understand it, you'll know exactly when each word you write and each rule you configure gets used by the engine.

## The Cycle

```text
Player input (message or UI interaction)
   ↓
① Engine assembles the prompt: entries + variables + conversation history
   ↓
② AI generates a reply: narrative text + [state directives]
   ↓
③ Engine: extract state directives → update variables → evaluate rules → fire rule results (variable changes, audio triggers)
   ↓
Player sees: story + updated UI + audio
   ↓
Next turn
```

As the creator, you decide what goes into this loop — what the AI sees (entries), what it tracks (variables), what happens automatically (behaviors), and how it's presented to the player (the frontend).

## One Turn, Concretely

A player in a survival-horror game types "I drink the potion." Here's what happens on this turn.

### ① The prompt the engine assembles

The engine stitches together what you wrote, your variables, and the conversation history into one prompt and sends it to the AI:

```text
// —— Your world setup ——
[system]
You're the narrator of this survival horror game. Cold and
restrained in tone, heavy on sensory detail, and you never decide the player's actions for them.

[system]
The long-abandoned Matsuzaki Sanatorium, sealed off in the winter of 1987.
The player is a college student searching for a missing friend.

// —— The variables you defined (the engine auto-converts them into a format the AI understands) ——
[system]
<behavior-rules>
[health] the player's health; decreases 10-30 when injured, recovers 5-15 when resting
[sanity] decreases 5-15 on horrific sights, recovers 5-10 when resting
</behavior-rules>

// —— Conversation history ——
[user]
I push the door open

[assistant]
A hand grabs your wrist — the skin unnaturally cold...

[user]
I drink the potion

// —— Current state (updated every turn from the directives the AI emits; the engine keeps a running record of the latest value of each variable) ——
[system]
<game-state>
health: 45
sanity: 30
day: 3
</game-state>
```

### ② The AI's raw output

```text
The potion burns down your throat, but you feel better.

[health: +20]  (the [state directive] the AI emitted)
```

### ③ What the player actually sees

> The potion burns down your throat, but you feel better.
>
> ❤️ &nbsp;health &nbsp;45 → 65

The engine plucks `[health: +20]` off the end of the AI's output, applies it to state, checks the relevant rules (anything that should fire at full health?), strips the directive out of the text, and shows only the clean narrative to the player.

**The AI never edits data — it writes directives, and the engine executes them.**

## What Makes Up a Card

### 1. Entries — What the AI Reads

Entries are what the AI sees when it generates a reply — entirely yours to decide and write. They might be character descriptions, world settings, lore, a writing-style guide — these are all entries.

An entry can be **always on** (like your world's background story), or **keyword-triggered** — switched on by keywords in the conversation. For example, you can give a tavern the keyword "drink": when the player or the AI mentions "drink," your tavern lore entry is pulled in automatically; if nobody does, it's never sent to the AI.

**The leaner your entries, the better the AI follows.** The AI reads every entry every turn — one unnecessary entry makes the truly important one easier to overlook.

→ [Learn more about entries](/creator/entries)

### 2. Variables — The State the AI Tracks

Variables are the game state — health, gold, location, affinity, inventory, and so on. Every turn the AI reads the current values and updates them with simple **directives** in its reply:

```
The bandit's blade catches your arm.
[health: -15]
[location: set "dark forest"]
```

The player sees the narrative. Behind the scenes the engine quietly extracts those bracket directives and updates the game state. As long as your world has variables, the engine teaches the AI the directive format automatically — all you have to do is write what the variable means and how it should change ( •̀ ω •́ )✧. For example: "decrease health by 10-30 on physical damage, never more than 30 in a single turn."

**Keep variables few, too.** Every variable takes a line in the prompt every turn — adding one you won't actually use just wastes the AI's attention.

→ [Learn more about variables](/creator/variables)

### 3. Behaviors — What the Engine Drives Entirely on Its Own

Behaviors handle the things the AI tends to forget or be inconsistent about. No AI involved:

- **When** health drops below 10 → **show** a "You're dying!" warning
- **When** affinity crosses 75 → **inject** a romance directive into the AI's instructions
- **Every** 5 turns → **play** an ambient thunder sound

Every behavior has a "when" trigger, an optional "if" condition, and a "then" action.

Behaviors are optional. But if you want game mechanics with precise thresholds, behaviors are what keep the game consistent.

→ [Learn more about rules & behaviors](/creator/automation)

### 4. Visuals & Audio — The Presentation Layer (Optional)

By default players see a clean chat interface, and for most worlds that's plenty.

But if you want to go further, you can add **custom UI** and **audio** to shape how your world looks and sounds. Custom UI lets you build anything from styled message bubbles to a full game interface (health bars, maps, inventory). Audio adds background music, sound effects, and ambience that the AI triggers naturally in its narration.

**You don't need to know code.** Click into the Studio and the AI assistant inside can generate a custom interface from your description. Just describe what you want ("give me an absolutely epic, AAA-tier frontend that fits my world's theme") and it builds it for you.

→ [Learn more about visuals and audio](/creator/visuals-audio)

## The Order the AI Sees Things

Here's the exact order in which content is assembled into the AI's prompt each turn. The AI pays the most attention to the **beginning and end** — content in the middle gets less focus. Understanding this helps you place content where it works hardest:

| Order | What | Where You Configure It |
|------|------|----------|
| 1 | Your always-on entries (character, world, narrator instructions) | Entries → System Presets section |
| 2 | The player's active persona (name, appearance, backstory) | The player's settings, not yours |
| 3 | Variable behavior rules + current values | Variables tab |
| 4 | Example dialogue | Entries with the "example" role |
| 5 | Conversation history | Automatic |
| 6 | Keyword-triggered entries (injected near the relevant messages) | Entries → Keyword-Triggered section |
| 7 | Post-instructions (final emphasis, style enforcement) | Entries → Post Instructions section |

## Building With AI

### Use Studio AI (Recommended)

Open the Studio editor, describe what you want, and the built-in AI assistant creates entries, variables, and automation for you. It knows the platform inside out — valid syntax, proven patterns, reference integrity.

> "Create a survival horror world with health, sanity, and hunger. The player is trapped in an abandoned hospital. Sanity drops when they see disturbing things. At zero sanity, the AI should describe hallucinations."

Studio AI will generate the entries, the variables with behavior rules, and the rules that fire at zero sanity — all correctly wired together. (Of course, giving the content of those entries one human review-and-polish pass yourself at the end makes the world far more brilliant ╰(*°▽°*)╯)

→ [Learn more about Studio AI](/creator/studio-ai)

### Use Your Own AI + the World Spec

If you'd rather work in Claude Code, Cursor, or ChatGPT, download the **World Spec** — a complete technical reference designed to be fed to AI tools. Your AI reads the spec, you describe what you want, and it generates a valid world schema you can import.

→ [Download the World Spec](/world-spec/)

---

::: tip Ready to start?
Open the [editor](https://yumina.io/app/editor) and create a new world, or keep reading to learn about each building block in detail.
:::
