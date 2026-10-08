<div v-pre>

# Custom UI Guide

Interface code is a small React (TSX) app that draws the screen players see. It can restyle the chat, add panels around it, or replace it with something that doesn't look like a chat at all. It lives in **Panels → Front End Code**.

Much of this no longer needs code. The [Player interface](/creator/player-view) editor builds opening pages, status panels, inventories, maps and buttons from templates, and its buttons can change variables, set off behaviors and call AIs. Reach for interface code when the templates and parts can't do what you want. Most creators still don't write it by hand: they describe the screen to the Creation assistant, which writes the code.

For the basics and setup, see [Get Started: Visuals & Audio](/creator/visuals-audio).

---

## Three ways a world can look

### Default chat (no custom UI needed)

Messages appear as text bubbles. There's an input box at the bottom. Everything scrolls naturally. This is what every new world starts with, and for many worlds it's all you need.

**Best for**: Slice-of-life roleplay, simple adventures, character chats, any world where the writing IS the experience.

The Player interface's **Message look** (Platform, Bubbles, Novel, Letter, Terminal) and its fine-tuning options restyle this chat without code.

### Custom message bubbles

You keep the full chat experience (scrolling, streaming, swipes, input box) and change how each message looks.

What people build with it:
- Themed backgrounds and fonts that match the world's mood
- Character portraits next to dialogue
- A stats bar (HP, gold, affinity) visible on every message
- Horror-game styling with dark tones and eerie fonts
- Color-coded speakers in multi-character scenes

### Full app mode

Your code draws the whole screen. The chat becomes one component in your layout, or you skip it and build something else entirely.

What people build with it:
- Visual novel screens with scene backgrounds and character sprites
- Map navigation where clicking a location sends a message
- Turn-based battle screens
- Phone simulators where different "apps" trigger different AI behaviors
- Interactive dashboards, inventory screens, quest journals

Battle Royale uses full app mode for its tactical overview. Still uses it for its puzzle interface.

Start with the default chat. If the world needs visual atmosphere, change the message look or add custom bubbles. If it needs interactive panels, game-like layouts or a non-chat experience, use the Player interface, and go to full app mode when that isn't enough.

---

## Building it with the Creation assistant

### How it works

Click **Creation assistant** in the top right of the canvas and describe the look you want in plain language. It writes the interface code into **Panels → Front End Code**, and the Player interface preview on the canvas shows the result.

### Good prompts

The more specific your description, the better the result. Describe the **layout**, the **mood**, and which **variables** to display.

**Vague** (the AI has to guess everything):
> "Make it look cool"

**Good** (clear layout and mood):
> "I want a dark, horror-themed interface. Red health bar at the top, messages styled like old typewriter text on yellowed paper, dark fog effect around the edges."

**Great** (layout + mood + specific variables + behavior):
> "Build a visual novel layout. Full-screen background image from the `scene_bg` variable. Character portrait on the left from `character_sprite`. Semi-transparent dialogue box at the bottom with the character's name from `speaker_name` in pink. When affinity is above 75, add a subtle heart particle effect."

### Work in rounds

1. **Describe the big picture** -- "I want a visual novel layout with scene backgrounds and character portraits"
2. **Check the preview** -- Does the layout feel right? Is the spacing good?
3. **Refine the details** -- "Make the dialogue box more transparent. Move the character portrait to the right side. Use a serif font for the dialogue."
4. **Add polish** -- "Add a fade-in animation when the scene changes. Make the affinity meter glow when it increases."

Several short rounds get you there faster than one long description.

### What to tell the assistant about your variables

The assistant can read your variables, but it helps to spell out what matters:

> "My variables: health (0-100, show as a red bar), gold (number, show as text with a coin icon), location (string like 'forest' or 'cave', show in the top-right), is_night (boolean, when true darken the background)"

---

## What interface code can do

Your code talks to the game through `useYumina()`. In terms of what you can build with it:

### Read game state

Your UI can read any variable, the full message history, who the current player is, which model is selected, whether the AI is currently generating, and more. Stat bars, inventories and quest trackers work this way: they read variables and display them.

`api.variables.hunger` finds the variable whose **ID** is `hunger`, and failing that, the one whose **display name** is `hunger`. Both spellings work, so a HUD built from the names you see on the canvas reads real values even when the IDs are random UUIDs. Same for writes: `api.setVariable("hunger", 50)` lands on that variable. Full rules: [ID vs display name](./08-api-reference.md#id-vs-display-name).

### Control the chat

Your UI can send messages as the player, edit or delete existing messages, ask the AI to regenerate, stop generation mid-stream, or restart the conversation. A "Drink the potion" button, for example, sends that text as the player's message and the AI responds.

### Set off behaviors

`api.executeActionAndWait("buy", { price: 5 })` runs the behaviors triggered by **The player presses a button** with the **Button** name `buy`, and passes values in. The behavior reads them as `{param.price}`. Shops, crafting and combat rolls can live in behaviors on the canvas, and your code only needs to say which item was clicked. See [Behaviors · Passing a value from a button](/creator/automation#passing-a-value-from-a-button).

### Call the card's AIs

A **UI-based** AI on the canvas waits for your interface to call it. `api.callAi("Fortune Mushroom", input)` runs it and returns `{ text, fields }`: its words, and the values it filled in under **Answer format**. Its model, what it sees, retries, cooldown and backup lines are all set on the canvas, and the answer is checked before it reaches your code. With **Where its words go** set to **An interface channel**, your code can also listen for its output with `api.onAiOutput(channel, cb)`. See [AIs](/creator/ais#answer-format-getting-a-tidy-answer).

### Raw AI calls

When you'd rather write the whole prompt yourself, `ai.complete()` runs a separate AI call that never touches the main chat. The player doesn't see it as a chat message, and it doesn't affect the main conversation's history or state. Uses:

- **NPC phone conversations**: A character has their own chat window inside your UI. The player texts them, the AI replies in that character's voice, and the main story continues separately. Each side character can have their own system prompt and personality.
- **AI-generated item descriptions**: The player hovers over an item in their inventory, and the AI writes a unique description on the fly based on the current story context.
- **Hint systems**: A "think" button that analyzes the player's situation and offers a nudge without the main AI breaking character.
- **Inner monologue panels**: A side panel showing what an NPC is thinking, generated by a different AI prompt than the one driving dialogue.
- **Translation or summary panels**: AI-written summaries or translations of the conversation shown alongside the main chat.

Pass `includeLorebook: "matched"` so the side AI sees the same world lore and character profiles as the main chat. Omit it for tasks that don't need world context (translations, classifications, pure utility).

Side calls have their own rate-limit pool (100 per minute, independent of the main chat) and the same per-token credit billing as the main chat. See the [API Reference](/creator/advanced/08-api-reference#raw-ai-completions) for the full method signature, limits, and `includeLorebook` options.

### Invisible context injection

Your UI can send a message that the main AI sees on its next turn but the player never sees in chat. Call `injectContext()` and the engine slips a one-shot system (or user) message into the next prompt, then discards it automatically.

This is how you make the AI react to things that happen outside the main conversation:

- **Offstage events**: "The NPC whispered to themselves after you left: 'I can't let them find the letter.'" The AI weaves this into its next response.
- **Environmental changes**: "It has started raining. The cave entrance is now partially flooded." The player doesn't see this instruction, but the AI describes the rain.
- **UI-driven consequences**: When the player clicks a button in your custom UI (like stealing from a shop), inject context telling the AI what happened so it can react.
- **Phone messages and notifications**: "You just received a cryptic text: 'Tonight, 9pm, usual place.'" The AI incorporates this into the narrative without the player seeing a system message.

`ai.complete()` runs a separate AI call; `injectContext()` feeds into the *main* AI's next response. Use `ai.complete()` when you want a separate AI voice, and `injectContext()` when you want the main AI to know about something the player didn't say. For something that stays true across turns, like which room the player is in or what's on screen, use `setScene()`: every AI call gets it until you change it.

See the [API Reference](/creator/advanced/08-api-reference#context-injection) for the method signature.

### Play audio

Your UI can play background music, sound effects, fade between tracks, and control volume. Combined with variables, you can have music that changes based on location or mood.

### Save and load

Two kinds of storage. `api.storage` keeps strings in this browser, per world: preferences, a remembered tab, a high score on this device. `api.sessionStorage` keeps small JSON records with the play session on the server, so they follow the player to other devices and into checkpoints.

### Navigate and notify

Toggle immersive mode, show toast notifications, copy text to the clipboard, switch between openings, open the persona manager or the model picker.

::: details Where to find the full API
The complete method-by-method reference with type signatures and examples is in two places:

- **[API Reference](/creator/advanced/08-api-reference)** -- every method and field, with examples
- **[World Spec: Custom UI](/world-spec/custom-ui)** -- The machine-readable spec, written for AIs to read

Give the World Spec to your own AI (Claude, ChatGPT, Cursor) when building complex UI.
:::

---

## The three customization paths

### Path 1: Ask the Creation assistant

You describe what you want, the assistant writes the code, you refine through conversation.

**Strengths**: No code knowledge needed. Fast iteration. The assistant knows the API and handles details like streaming, empty states and mobile layout.

**When to use**: Start here. Switch to another path only if you hit something the assistant can't do.

### Path 2: Use your own AI (Claude, ChatGPT, Cursor)

**Connect your AI** in the top bar lets Claude, ChatGPT / Codex, Cursor, Claude Code or Codex CLI sign in and edit your card directly, including the interface code. See [The Creation assistant and your own AI](/creator/studio-ai#connect-your-own-ai).

If you'd rather paste code in yourself, tell the AI:
- Your code is TSX (React), running in a sandboxed iframe
- Everything is available as globals: React, useYumina, Icons, Chat, MessageList, MessageInput, Tailwind CSS
- The entry file is `index.tsx` with `export default function MyWorld() { ... }`
- Game state comes from `useYumina()` -- variables, messages, streaming state, everything
- Use `React.useState` and friends, not imported hooks

**When to use**: Complex multi-file UIs, when you want a longer conversation, or when you already work in an AI-powered code editor.

### Path 3: Hand-code (for experienced developers)

Open **Panels → Front End Code** and write TSX directly. The compile badge shows **OK** or **Error** as you type.

**When to use**: You're a developer who thinks in React, or you want precise control over every detail.

---

## Ground rules for custom UI code

These apply no matter which path you take. The Creation assistant follows them already; this section is for understanding what's happening under the hood, or for debugging when something goes wrong.

::: details The five rules

**1. Entry file format**

`index.tsx` must export a default function component. This is the root of your UI:

```tsx
export default function MyWorld() {
  return <Chat />;
}
```

**2. Globals -- don't import them**

These are already available everywhere, no import needed: `React`, `useYumina`, `Icons`, `Chat`, `MessageList`, `MessageInput`, `useAssetFont`, the lore controls (`LoreSlot`, `LoreButton`, ...), the model picker components, and all Tailwind CSS classes. The full list is in the [API Reference](./08-api-reference.md#sandbox-globals).

Import statements are stripped when the code compiles, so `import React from "react"` does nothing, and `import { useState } from "react"` leaves `useState` undefined.

**3. Your own files CAN be imported**

Multi-file interface code uses ES module syntax:

```tsx
import StatBar from "./stat-bar"
import DialogueBox from "./dialogue-box"
```

**4. Use `React.useState()`, not `useState()`**

React is in scope as a module, but individual hooks are not destructured. Always prefix with `React.`:

```tsx
var [count, setCount] = React.useState(0)
```

**5. TypeScript types are stripped, not checked**

Type annotations and interfaces are removed when the code compiles, so they don't break anything, but nothing checks them either. Plain JavaScript in JSX is what the Creation assistant writes. `const`, `let`, `var` and arrow functions all work.
:::

---

## Common patterns

These are the building blocks most custom interfaces combine. The code samples are collapsible: they're there for reference, and the Creation assistant writes this kind of code for you.

### Custom message bubbles

Keep the full chat experience and change how messages look. Use `<Chat renderBubble={...} />` to take over bubble rendering while the platform handles everything else (scrolling, streaming, swipes, input).

**When to use**: You want themed messages (dark horror, elegant romance, sci-fi terminal) without rebuilding the whole chat, and the Player interface's **Message look** options don't go far enough.

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

A fixed panel showing health, gold, affinity, location, or any other variable. Usually placed above the chat (using `<Chat>`'s `children` prop) or beside it (flex layout). The Player interface's **Stat panel** and **Adventure HUD** templates build this without code.

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

Full-screen scene background, character sprite, semi-transparent dialogue box at the bottom. Usually reads scene and character data from variables that the AI updates as the story moves. The full build is in [Recipe: Visual Novel Mode](./recipes/visual-novel.md).

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

Chat on the left, a fixed panel on the right showing character info, stats, inventory, or a map. Players keep the full chat and can check the game information while they talk.

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

Buttons that send messages, set variables or set off behaviors when clicked. A common use is the opening: turn it into a character creation screen, a difficulty selector, or a branching story opener.

The Player interface does most of this without code: buttons with **Say a line for the player**, **Change a variable**, **Set off a behavior** and **Call an AI** steps, and opening templates such as **Pick an opening**, **Enter your name** and **Pick a difficulty**. Use code when the buttons have to live inside a chat bubble or depend on logic the steps can't express.

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

**Adding custom UI when you don't need it.** The default chat is clean, fast, and maintained by the platform. If your world's strength is writing quality, the default chat keeps players focused on it.

**Forgetting about streaming.** When the AI is generating, `msg.isStreaming` is true and the content is incomplete. Your bubble should handle partial text gracefully -- don't parse the content assuming it's complete.

**Not testing on mobile.** Many players use phones. If your sidebar is 320px wide, it won't fit on a mobile screen. Use responsive Tailwind classes (`hidden md:block` to hide panels on small screens) or test your layout at narrow widths.

**Blocking the input.** If you go full app mode and forget to include `<MessageInput />` (or your own input that calls `api.sendMessage()`), players can't talk to the AI. Always make sure there's a way to send messages.

**Setting variables before switching openings.** `api.switchGreeting()` resets variables to that opening's starting values. Await it first, then set your own variables.

**Importing globals.** Import statements are stripped, so `import { useState } from "react"` leaves `useState` undefined. React, useYumina, Icons, Chat, MessageList, MessageInput -- these are all globals. Don't import them.

---

## See also

- [API Reference](/creator/advanced/08-api-reference) — the complete method-by-method reference for `useYumina()`, `callAi()`, `ai.complete()`, `injectContext()`, and every other bridge method
- [Player interface](/creator/player-view) — templates and parts, no code
- [Designing Game State](/creator/advanced/variables-deep) — the variables your UI reads and displays
- [3D, Panoramas & Assets](/creator/advanced/3d-and-assets) — what the sandbox can load, and teleporting between 3D places
- [Audio Design](/creator/advanced/audio-deep) — playing audio from your custom UI via the bridge API
- [AI Directives & Macros](/creator/advanced/directives-macros) — how the AI updates the state your UI renders

Machine-readable spec → [World Spec: Custom UI](/world-spec/custom-ui)

</div>
