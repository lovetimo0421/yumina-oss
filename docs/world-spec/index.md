# World Spec

The World Spec is a complete technical reference for Yumina's world schema. It's designed for two audiences:

1. **AI coding agents** (Claude Code, Cursor, ChatGPT) — feed them this spec so they can generate valid world schemas
2. **Advanced creators** who want to understand the full system

## How to Use This

### With an AI coding tool

Head to the [full spec download page](/world-spec/download) and add the single-file spec to your AI's context:

- **Claude Code**: Place it in your project directory, or paste it into the conversation
- **Cursor**: Add it as a reference file
- **ChatGPT**: Paste the relevant sections into your prompt

Then describe what you want:

> "Using the Yumina world spec, create a survival horror world with health, sanity, and hunger tracking. Include a character named Dr. Chen who is secretly antagonistic. Add a custom UI with a dark medical theme."

The AI will generate a valid world schema JSON you can import into Yumina.

### As a reference

Browse the sections in the sidebar to look up specific features — entry sections, variable types, directive syntax, rule triggers, or the custom UI API.

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
