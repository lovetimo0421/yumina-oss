---
title: "Glossary"
description: "The words Yumina uses for the parts of a card, in one place: card, entry, lore, variable, directive, behavior, scenario, AI, precise tracking, smart tracking, moment, bundle, and more."
---

<div v-pre>

# Glossary

The words Yumina uses, in alphabetical order. The schema names in the card's data are in brackets where they differ.

**AI.** A model call that does a job in your card. Every card has one, the Narrator. Extra AIs come in four kinds: turn-based, UI-based, event-based and custom. See [AIs](/creator/ais).

**Audio directive.** A bracket the AI writes in a reply to control sound, like `[audio: trackId play]`. Also stop, crossfade, volume and chain. The player never sees it.

**Behavior** (`reactions`, and `rules` in older cards). An if-this-then-that the engine runs without the AI: a trigger, optional conditions, and effects. See [Behaviors](/creator/automation).

**Bundle.** A package of chosen parts of a card, with entries, variables, behaviors, audio and optionally the interface, saved with ⋮ → Save as template or pack. Others install it into their own cards from the Resource market.

**Card.** A world: the whole package of characters, story, variables, behaviors, interface and audio. The two words mean the same thing.

**Conditional BGM.** Music that switches by itself when a variable, keyword or turn count matches a rule, set under BGM Configuration in Panels → Audio.

**Context.** The block at the bottom of the card and of every scenario that lists what the AI there reads each turn, with its history, pinned note and budget settings.

**Cooldown.** The number of turns a behavior waits after firing before it can fire again.

**Directive.** The AI's way of changing a variable inside a reply, like `[health: -10]`. The engine applies it and strips it from the text. Variables with Precise tracking ignore directives and let the helper decide instead.

**Entry.** One piece of lore: a character, a place, a rule, a style note, example dialogue. On the canvas, entries are the lore rows, sorted by when they are sent to the AI.

**Keyword lore.** An entry sent only when one of its keywords shows up in recent messages. Secondary keywords narrow it further, with AND or NOT logic.

**Language version** (variant). A separate copy of a card in another language, linked to the original so players see the one in their language.

**Lorebook.** All of a card's entries together. Panels → Lorebook lists every one on a page.

**Macro.** A `{{name}}` placeholder in lore or an opening, swapped for the real thing before the AI reads it: `{{user}}`, `{{char}}`, `{{turnCount}}`, or a variable's value.

**Moment.** A small card with a title, a line and a picture that a behavior hands the player, like an achievement. Collected into a list variable so it never pops twice.

**Opening** (greeting). The first thing a player reads. A card can have several, and the player picks one.

**Pinned note.** A line placed near the end of the conversation every turn, where the AI listens best. Set in Context, or by the player in the Memory panel.

**Player interface.** The screen players see, built from templates and parts, or written as interface code in Panels → Interface code. See [Player interface](/creator/player-view).

**Playlist.** The background music tracks that play by themselves, in loop, shuffle or sequence, with autoplay and a gap between tracks.

**Precise tracking.** A per-variable switch. When it is on, the story AI leaves the variable alone and a separate helper decides after each reply whether it should change, and by how much. New number and switch variables start with it on.

**Priority.** A number on behaviors and conditional BGM rules. Higher runs first when several fire at once.

**Recap.** Older scenes folded into short chapters so the AI keeps the events after the exact words fall out of story memory.

**Reply processing.** Rules in Card settings that catch a tagged block in the AI's reply, write it into variables or an event, and can hide it from the player. See [Reply processing](/creator/reply-rules).

**Root component.** The entry point of a card's interface code, `index.tsx` in Panels → Interface code. The default is a plain chat. See the [Custom UI guide](/creator/advanced/custom-ui-deep).

**Scenario** (worldbook). A part of the card with its own lore, variables, behaviors, AIs and memory, open only at certain times: a dungeon, a chapter, a side story. See [Scenarios](/creator/modules).

**Session.** One playthrough, with its own chat history and its own variable values. Players call it a save.

**Smart tracking.** A card-wide switch in Card settings, on by default. After each reply a small helper sets the variables with Precise tracking, plays tracks whose cue fits, and places scene images whose condition holds.

**Standby lore.** An entry never sent on its own. A behavior opens it with Enable lore entry, which is how hidden storylines appear at the right moment.

**Story memory.** The amount of the conversation the AI reads word for word each turn, set by the player. The world's lore never counts against it.

**Trigger.** The first part of a behavior, when it fires: every turn, every N turns, a keyword, a variable crossing a line, a button press.

**Turn.** One exchange: the player sends a message and the AI replies.

**Variable.** A value the story remembers: a number, text, a switch, or a list or table (`number`, `string`, `boolean`, `json` in the data). Directives and behaviors read and write them.

</div>
