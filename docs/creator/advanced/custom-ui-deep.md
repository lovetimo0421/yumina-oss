<div v-pre>

# Custom UI Guide

Custom UI is how creators give their worlds a distinctive look. Battle Royale has a complete tactical interface with health bars, a kill feed, and a dynamic map. The romance world Sakura Season uses a visual novel layout with character portraits and scene backgrounds. The sleeper hit Still runs an entire puzzle game inside its UI.

None of these creators wrote the code themselves. They described what they wanted, and Studio AI built it.

This guide teaches the craft of making your world look amazing. For the basics and setup, see [Get Started: Visuals & Audio](/creator/visuals-audio).

---

## Three ways a world can look

Every world on Yumina falls into one of three visual styles. The decision you make here shapes everything else.

### Default chat (no custom UI needed)

Messages appear as text bubbles. There's an input box at the bottom. Everything scrolls naturally. This is what every new world starts with, and for many worlds it's all you need.

**Best for**: Slice-of-life roleplay, simple adventures, character chats, any world where the writing IS the experience.

If the AI's writing is what makes your world special, the default chat keeps players focused on it. Don't add custom UI just because you can.

### Custom message bubbles

The most popular customization on the platform. You keep the full chat experience (scrolling, streaming, swipes, input box) but change how each message looks.

**What this unlocks**:
- Themed backgrounds and fonts that match your world's mood
- Character portraits next to dialogue
- A stats bar (HP, gold, affinity) visible on every message
- Horror-game styling with dark tones and eerie fonts
- Color-coded speakers in multi-character scenes

You're not replacing the chat. You're decorating it.

### Full app mode

The most powerful option. You control every pixel. The chat becomes just one component in your larger design, or you can skip it entirely and build something completely different.

**What this unlocks**:
- Visual novel engines with scene backgrounds and character sprites
- Map navigation where clicking a location sends a message
- Turn-based battle screens
- Phone simulators where different "apps" trigger different AI behaviors
- Interactive dashboards, inventory screens, quest journals

Battle Royale uses full app mode for its tactical overview. Still uses it for its puzzle interface. These worlds don't look like chat apps at all.

**The decision**: Start with the default chat. If your world needs visual atmosphere, add custom bubbles. If your world needs interactive panels, game-like layouts, or a non-chat experience, go full app mode.

---

## Studio AI is your builder

You don't need to write code. You need to know what you want and describe it clearly.

### How it works

Open the editor, click **Enter Studio**, and talk to the AI assistant. Describe the look you want in plain language. Studio AI generates the code, and you see a live preview in the Canvas panel.

### Good prompts

The more specific your description, the better the result. Here's the pattern: describe the **layout**, the **mood**, and which **variables** to display.

**Vague** (the AI has to guess everything):
> "Make it look cool"

**Good** (clear layout and mood):
> "I want a dark, horror-themed interface. Red health bar at the top, messages styled like old typewriter text on yellowed paper, dark fog effect around the edges."

**Great** (layout + mood + specific variables + behavior):
> "Build a visual novel layout. Full-screen background image from the `scene_bg` variable. Character portrait on the left from `character_sprite`. Semi-transparent dialogue box at the bottom with the character's name from `speaker_name` in pink. When affinity is above 75, add a subtle heart particle effect."

### The iterative process

Nobody gets it perfect on the first try. The best worlds are built through refinement:

1. **Describe the big picture** -- "I want a visual novel layout with scene backgrounds and character portraits"
2. **Review the Canvas preview** -- Does the layout feel right? Is the spacing good?
3. **Refine the details** -- "Make the dialogue box more transparent. Move the character portrait to the right side. Use a serif font for the dialogue."
4. **Add polish** -- "Add a fade-in animation when the scene changes. Make the affinity meter glow when it increases."

Each round takes seconds. Five rounds of iteration beats one hour of trying to describe everything upfront.

### What to tell Studio AI about your variables

Studio AI can read your world's variable definitions, but it helps to spell out what matters:

> "My variables: health (0-100, show as a red bar), gold (number, show as text with a coin icon), location (string like 'forest' or 'cave', show in the top-right), is_night (boolean, when true darken the background)"

---

## What's possible: the bridge API

Your custom UI can do far more than display variables. Here's what the bridge gives you, explained in terms of what you can BUILD, not what functions to call.

### Read game state

Your UI can read any variable, the full message history, who the current player is, which model is selected, whether the AI is currently generating, and more. This is how stat bars, inventories, and quest trackers work -- they read variables and display them visually.

`api.variables.hunger` finds the variable whose **ID** is `hunger`, and failing that, the one whose **display name** is `hunger`. Both spellings work, so a HUD built from the names you see in the Variables editor reads real values even when the IDs are the random UUIDs the editor generated. Same for writes: `api.setVariable("hunger", 50)` lands on that variable. Full rules: [ID vs display name](./08-api-reference.md#id-vs-display-name).

### Control the chat

Your UI can send messages as the player, edit or delete existing messages, ask the AI to regenerate, stop generation mid-stream, or restart the conversation. This is how interactive buttons work -- a "Drink the potion" button sends that text as the player's message, triggering the AI to respond.

### Play audio

Your UI can play background music, sound effects, fade between tracks, and control volume. Combined with variables, you can have music that changes based on location or mood automatically.

### Side completions — multiple AI "voices" in one world

This is one of the most powerful capabilities in the entire platform. Your UI can call `ai.complete()` to run a separate AI conversation that never touches the main chat. The AI responds only to your UI — the player doesn't see it as a chat message, and it doesn't affect the main conversation's history or state.

Think about what this unlocks:

- **NPC phone conversations**: A character has their own chat window inside your UI. The player texts them, the AI replies in that character's voice, and the main story continues separately. Each side character can have their own system prompt and personality.
- **AI-generated item descriptions**: The player hovers over an item in their inventory, and the AI writes a unique description on the fly based on the current story context.
- **Hint systems**: A "think" button that analyzes the player's situation and offers a nudge without the main AI breaking character.
- **Inner monologue panels**: A side panel showing what an NPC is thinking, generated by a different AI prompt than the one driving dialogue.
- **Translation or summary panels**: Real-time AI-powered summaries or translations of the conversation happening alongside the main chat.

You can pass `includeLorebook: "matched"` so the side AI sees the same world lore and character profiles as the main chat — keeping side conversations in canon instead of drifting. Or omit it for tasks that don't need world context (translations, classifications, pure utility).

Side calls have their own rate-limit pool (100 per minute, independent of the main chat) and the same per-token credit billing as the main chat. See the [API Reference](/creator/advanced/08-api-reference#raw-ai-completions) for the full method signature, limits, and `includeLorebook` options.

### Invisible context injection

Your UI can send a message that the main AI sees on its next turn but the player never sees in chat. Call `injectContext()` and the engine slips a one-shot system (or user) message into the next prompt, then discards it automatically.

This is how you make the AI react to things that happen outside the main conversation:

- **Offstage events**: "The NPC whispered to themselves after you left: 'I can't let them find the letter.'" The AI weaves this into its next response naturally.
- **Environmental changes**: "It has started raining. The cave entrance is now partially flooded." The player doesn't see this instruction, but the AI describes the rain.
- **UI-driven consequences**: When the player clicks a button in your custom UI (like stealing from a shop), inject context telling the AI what happened so it can react.
- **Phone messages and notifications**: "You just received a cryptic text: 'Tonight, 9pm, usual place.'" The AI incorporates this into the narrative without the player seeing a system message.

Unlike `ai.complete()`, which runs a separate AI call, `injectContext()` feeds into the *main* AI's next response. The two complement each other: use `ai.complete()` when you want a separate AI voice, use `injectContext()` when you want the main AI to know about something the player didn't say.

See the [API Reference](/creator/advanced/08-api-reference#context-injection) for the method signature.

### Save and load

Persistent storage that survives across sessions. High scores, unlocked achievements, player preferences, custom settings -- anything you want to remember between play sessions.

### Navigate and notify

Toggle immersive mode, show toast notifications, copy text to the clipboard, switch between greeting variants. Your UI has the same controls the platform's built-in interface has.

::: details Where to find the full API
The complete method-by-method reference with type signatures and examples is in two places:

- **[API Reference](/creator/advanced/08-api-reference)** -- The guided tour with worked examples
- **[World Spec: Custom UI](/world-spec/custom-ui)** -- The machine-readable spec, designed for AI consumption

Give the World Spec to Studio AI, Claude, or Cursor when building complex UI. They'll handle the technical details.
:::

---

## The three customization paths

### Path 1: Ask Studio AI (recommended for most creators)

This is the path most successful worlds take. You describe what you want, Studio AI writes the code, you refine through conversation.

**Strengths**: No code knowledge needed. Fast iteration. Studio AI knows the full API and handles edge cases (streaming, empty states, mobile layout) automatically.

**When to use**: Always start here. Switch to another path only if you hit something Studio AI can't do.

### Path 2: Use an external AI (Claude, Cursor, ChatGPT)

If you prefer a different AI tool, or if you're building something complex that benefits from a longer conversation, you can use any AI that writes code. The key is giving it Yumina's technical context.

Tell the external AI:
- Your code is TSX (React), running in a sandboxed iframe
- Everything is available as globals: React, useYumina, Icons, Chat, MessageList, MessageInput, Tailwind CSS
- The entry file is `index.tsx` with `export default function MyWorld() { ... }`
- Game state comes from `useYumina()` -- variables, messages, streaming state, everything
- Use `var` and `function()` instead of `const`/`let`/arrow functions
- No TypeScript syntax (no generics, no `as` assertions, no interfaces)

**When to use**: Complex multi-file UIs, when you want more control over the conversation, or when you're already working in an AI-powered code editor.

### Path 3: Hand-code (for experienced developers)

Open the editor, go to Custom UI, and write TSX directly. The live preview updates as you type.

**When to use**: You're a developer who thinks in React, or you want precise control over every detail.

---

## Ground rules for custom UI code

These apply no matter which path you take. If you're using Studio AI, it handles these automatically -- this section is for understanding what's happening under the hood, or for debugging when something goes wrong.

::: details The six rules

**1. Entry file format**

`index.tsx` must export a default function component. This is the root of your UI:

```tsx
export default function MyWorld() {
  return <Chat />;
}
```

**2. Globals -- don't import them**

These are already available everywhere, no import needed: `React`, `useYumina`, `Icons`, `Chat`, `MessageList`, `MessageInput`, `useAssetFont`, and all Tailwind CSS classes.

Writing `import React from "react"` won't break anything (it's silently stripped), but it's unnecessary.

**3. Your own files CAN be imported**

Multi-file root components use ES module syntax:

```tsx
import StatBar from "./stat-bar"
import DialogueBox from "./dialogue-box"
```

**4. Use `React.useState()`, not `useState()`**

React is in scope as a module, but individual hooks are not destructured. Always prefix with `React.`:

```tsx
var [count, setCount] = React.useState(0)
```

**5. Use `var` and `function()`, not `const`/`let`/arrows**

The sandbox occasionally has scope issues with `const`/`let` and arrow functions. `var` and `function()` are more robust:

```tsx
// Prefer this
var api = useYumina()
var items = api.variables.inventory || []

// Instead of this
const api = useYumina()
const items = api.variables.inventory ?? []
```

**6. No TypeScript syntax**

No generics (`<T>`), no interfaces, no `as` type assertions, no `satisfies`. The sandbox compiles TSX but not full TypeScript.
:::

---

## Common patterns

These are the building blocks that top worlds combine. Each description tells you what the pattern does and when to use it. The code samples are collapsible -- they're there for reference, but Studio AI generates these for you.

### Custom message bubbles

The most common pattern. Keep the full chat experience, just change how messages look. Use `<Chat renderBubble={...} />` to take over bubble rendering while the platform handles everything else (scrolling, streaming, swipes, input).

**When to use**: You want themed messages (dark horror, elegant romance, sci-fi terminal) without rebuilding the whole chat.

::: details Code example: themed bubbles with stats
```tsx
export default function MyWorld() {
  var api = useYumina()

  return (
    <Chat renderBubble={function(msg) {
      if (msg.role === "user") {
        return (
          <div className="ml-auto max-w-[80%] rounded-xl bg-blue-500/20 px-4 py-3 text-blue-100">
            {msg.rawContent}
          </div>
        )
      }

      return (
        <div className="mr-auto max-w-[85%] rounded-xl border border-zinc-700 bg-zinc-900 p-4">
          <div dangerouslySetInnerHTML={{ __html: msg.contentHtml }} />
          <div className="mt-3 flex gap-4 text-xs text-zinc-400">
            <span>HP {api.variables.health}/100</span>
            <span>Gold {api.variables.gold}</span>
          </div>
        </div>
      )
    }} />
  )
}
```
:::

### Stat displays and HUDs

A fixed panel showing health, gold, affinity, location, or any other variable. Usually placed above the chat (using `<Chat>`'s `children` prop) or beside it (flex layout).

**When to use**: Your world tracks stats that players need to see at all times -- RPGs, survival games, dating sims with affinity meters.

::: details Code example: top HUD bar
```tsx
export default function MyWorld() {
  var api = useYumina()

  return (
    <Chat>
      <div className="shrink-0 px-4 py-2 bg-black/60 backdrop-blur flex gap-4 text-xs text-zinc-300">
        <div className="flex items-center gap-1">
          <Icons.Heart className="w-3 h-3 text-red-400" />
          <span>{api.variables.health || 100}/100</span>
        </div>
        <div className="flex items-center gap-1">
          <Icons.Coins className="w-3 h-3 text-amber-400" />
          <span>{api.variables.gold || 0}</span>
        </div>
        <div className="ml-auto text-zinc-500">
          {api.variables.location || "Unknown"}
        </div>
      </div>
    </Chat>
  )
}
```
:::

### Visual novel layout

Full-screen scene background, character sprite, semi-transparent dialogue box at the bottom. The most cinematic option. Usually reads scene and character data from variables that the AI updates through directives.

**When to use**: Romance, drama, slice-of-life stories where visual atmosphere matters more than a traditional chat interface.

::: details Code example: VN shell with scene backgrounds
```tsx
export default function MyWorld() {
  var api = useYumina()
  var bg = api.variables.scene_bg
  var sprite = api.variables.character_sprite
  var speaker = api.variables.speaker_name
  var lastMsg = (api.messages || []).slice(-1)[0]

  return (
    <div
      className="relative w-full h-full bg-cover bg-center"
      style={{
        backgroundImage: bg
          ? "url(" + bg + ")"
          : "linear-gradient(135deg, #1e293b, #0f172a)"
      }}
    >
      {sprite && (
        <img
          src={sprite}
          className="absolute bottom-0 left-1/2 -translate-x-1/2 max-h-[80%] pointer-events-none"
        />
      )}

      <div className="absolute inset-x-4 bottom-4">
        <div className="rounded-xl border border-white/10 bg-black/70 p-4 backdrop-blur-sm">
          {speaker && (
            <div className="mb-1 text-sm font-bold text-pink-300">{speaker}</div>
          )}
          <div className="leading-relaxed text-zinc-100">
            {lastMsg ? lastMsg.content : ""}
          </div>
        </div>

        <div className="mt-2">
          <MessageInput />
        </div>
      </div>
    </div>
  )
}
```
:::

### Sidebar game panel

Chat on the left, a fixed panel on the right showing character info, stats, inventory, or a map. The best of both worlds: players get the full chat experience AND persistent game information.

**When to use**: RPGs, adventure games, any world where players need to reference stats or inventory while chatting.

::: details Code example: chat + sidebar
```tsx
export default function MyWorld() {
  var api = useYumina()

  return (
    <div className="flex h-full">
      <div className="flex-1 min-w-0">
        <Chat />
      </div>
      <aside className="w-72 shrink-0 border-l border-border bg-card p-4 overflow-y-auto">
        <div className="text-sm font-bold mb-3">{api.variables.player_name || "Adventurer"}</div>

        <div className="space-y-2 text-xs">
          <div className="flex justify-between">
            <span className="text-muted-foreground">HP</span>
            <span>{api.variables.health || 100}/{api.variables.max_health || 100}</span>
          </div>
          <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
            <div
              className="h-full bg-red-500 transition-all duration-300"
              style={{ width: ((api.variables.health || 100) / (api.variables.max_health || 100) * 100) + "%" }}
            />
          </div>
        </div>

        <div className="mt-4 text-xs text-muted-foreground">
          <div className="font-medium mb-2">Inventory</div>
          <div className="grid grid-cols-3 gap-1">
            {(api.variables.inventory || []).map(function(item, i) {
              return (
                <div key={i} className="aspect-square rounded border border-border bg-muted flex items-center justify-center text-[10px]">
                  {item.name || "?"}
                </div>
              )
            })}
          </div>
        </div>
      </aside>
    </div>
  )
}
```
:::

### Interactive buttons and choices

Buttons that send messages or set variables when clicked. The simplest form of interactivity beyond typing. Especially powerful for the opening greeting -- turn it into a character creation screen, a difficulty selector, or a branching story opener.

**When to use**: Any world where you want the player to choose from options instead of (or in addition to) typing.

::: details Code example: greeting as character creation
```tsx
export default function MyWorld() {
  var api = useYumina()

  return (
    <Chat renderBubble={function(msg) {
      if (msg.messageIndex === 0 && msg.role === "assistant") {
        return (
          <div className="space-y-4">
            <div dangerouslySetInnerHTML={{ __html: msg.contentHtml }} />
            <div className="flex gap-3">
              <button
                onClick={function() {
                  api.setVariable("class", "Warrior")
                  api.sendMessage("I choose Warrior")
                }}
                className="px-4 py-3 rounded-lg border border-zinc-600 hover:bg-zinc-800 transition"
              >
                Warrior
              </button>
              <button
                onClick={function() {
                  api.setVariable("class", "Mage")
                  api.sendMessage("I choose Mage")
                }}
                className="px-4 py-3 rounded-lg border border-zinc-600 hover:bg-zinc-800 transition"
              >
                Mage
              </button>
            </div>
          </div>
        )
      }

      return <div dangerouslySetInnerHTML={{ __html: msg.contentHtml }} />
    }} />
  )
}
```
:::

---

## Common mistakes

**Adding custom UI when you don't need it.** The default chat is clean, fast, and maintained by the platform. If your world's strength is writing quality, the default chat keeps players focused on it. Don't add UI complexity for its own sake.

**Forgetting about streaming.** When the AI is generating, `msg.isStreaming` is true and the content is incomplete. Your bubble should handle partial text gracefully -- don't parse the content assuming it's complete.

**Not testing on mobile.** Many players use phones. If your sidebar is 320px wide, it won't fit on a mobile screen. Use responsive Tailwind classes (`hidden md:block` to hide panels on small screens) or test your layout at narrow widths.

**Blocking the input.** If you go full app mode and forget to include `<MessageInput />` (or your own input that calls `api.sendMessage()`), players can't talk to the AI. Always make sure there's a way to send messages.

**Using `const` and arrow functions.** The sandbox sometimes has scope issues with these. Use `var` and `function()` instead. Studio AI does this automatically, but if you're hand-coding or pasting from an external AI, watch for this.

**Importing globals.** Writing `import React from "react"` or `import { useState } from "react"` can cause errors. React, useYumina, Icons, Chat, MessageList, MessageInput -- these are all globals. Don't import them.

---

## See also

- [API Reference](/creator/advanced/08-api-reference) — the complete method-by-method reference for `useYumina()`, `ai.complete()`, `injectContext()`, and every other bridge method
- [Designing Game State](/creator/advanced/variables-deep) — the variables your UI reads and displays
- [3D, Panoramas & Assets](/creator/advanced/3d-and-assets) — what the sandbox can load, and teleporting between 3D places
- [Audio Design](/creator/advanced/audio-deep) — playing audio from your custom UI via the bridge API
- [AI Directives & Macros](/creator/advanced/directives-macros) — how the AI updates the state your UI renders

Machine-readable spec → [World Spec: Custom UI](/world-spec/custom-ui)

</div>
