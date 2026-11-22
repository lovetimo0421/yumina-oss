---
title: "World file format"
description: "The reference for Yumina's world file: entries, variables, directives, rules, macros, custom UI and audio. For the open-source engine, for mods, and for AI tools without a connector."
---

# World file format

A Yumina world is one JSON file. This is the reference for every part of it, written for people and for AI tools.

Most creators never read it. Studio writes the file for you, and your own AI can edit a card directly through [Connect your AI](/creator/connect-your-ai). This reference is for three cases:

- You run the [open-source engine](https://github.com/lovetimo0421/yumina-oss) yourself, or put a card inside a game as a [character](/creator/games).
- Your AI tool has no connector. Give it the [single-file spec](/world-spec/download) and it can write a valid world for you to import.
- You want to look up exactly how a section, a variable type, a directive or a rule works.

## Spec Sections

| Section | What It Covers |
|---------|---------------|
| [World Schema](/world-spec/schema) | Top-level WorldDefinition structure, all fields |
| [Entries & Sections](/world-spec/entries) | Entry types, sections, keywords, matching, official presets |
| [Variables & Directives](/world-spec/variables) | Types, operations, directive syntax, dot-path updates, behavior rules |
| [Rules & Reactions](/world-spec/rules) | Triggers, conditions, actions, system effects, event patterns |
| [Macros](/world-spec/macros) | All macro placeholders and their replacements |
| [Custom UI](/world-spec/custom-ui) | rootComponent, useYumina() API, sandboxing, built-in components |
| [Audio](/world-spec/audio) | Track types, AI directives, playlists, conditional BGM |
| [Full Download](/world-spec/download) | Single-file spec for AI agents |
