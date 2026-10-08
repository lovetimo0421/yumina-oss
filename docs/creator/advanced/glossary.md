<div v-pre>

# Glossary

Yumina creator terms, sorted alphabetically.

---

**AI** — a model call that does a job in your card. Every card has one, the **Narrator**. Extra AIs come in four types: turn-based, UI-based, code-based and custom. Added with **Add → An AI call** on the canvas. See [AIs](/creator/ais).

**Audio Directive** — a special directive the AI embeds in replies using `[audio: trackId action]` syntax to control audio playback. Supports play, stop, crossfade, volume, and chain operations.

**Behavior** — an automation with three parts: **When it fires**, **ONLY IF** and **Effects**. The engine runs it without the AI. Added with **＋ Behavior** in the canvas Add row; **Panels → Behaviors** lists them all on one page. See [Behaviors](/creator/automation).

**Bundle** — a package of selected card content (entries, variables, behaviors, audio tracks, and optionally the interface code) saved to your bundle library with **⋮ → Export Bundle**. Others can install it into their own cards from **Panels → Marketplace** or from a downloaded file.

**Conditional BGM** — a mechanism for automatically switching background music based on variable state, keywords, or turn count. E.g., auto-switching to battle music when entering a combat zone. Set under **BGM Configuration** in **Panels → Audio**.

**Context** — the block at the bottom of the card and of every scenario that lists what the AI there reads each turn, with settings for conversation history, a pinned note and the context budget.

**Cooldown** — the number of turns a behavior must wait after firing before it can fire again. Prevents the same behavior from triggering too frequently.

**Custom Component** (legacy concept) — the pre-v18 model stored independent UI panels in `customUI[]`; `surface: "app"` took over the full screen, `surface: "message"` replaced message bubbles. New worlds use the **Root Component** instead — sidebars, full-screen UIs, and custom bubbles all live in `index.tsx` and its sibling files.

**Depth Injection** — a technique for inserting entry content at a specific position within chat history. The **Depth (messages from end)** setting indicates how many messages from the end to insert at, making the AI more naturally "aware" of context information.

**Directive** — the AI's way of changing game state, using `[variableName: operation value]` syntax in replies. Automatically parsed and executed by the engine; players only see clean narrative text. Variables with **Precise tracking** on are changed by the tracking helper instead, and directives for them are ignored.

**Effect** — the third part of a behavior: what the engine does when it fires. Includes changing a variable, enabling or disabling a variable, scenario, lore entry or behavior, telling the AI something, playing or stopping audio, showing a notification, and unlocking a moment.

**Entry** — a content fragment in a world. Character profiles, scene descriptions, writing style instructions, example dialogue, world lore — all are entries. Each has a `role` tag telling the engine what kind of content it is. On the canvas, entries are the lore rows, sorted into four blocks by when they're sent to the AI.

**Full-Screen Component** (legacy concept) — in the pre-v18 model, a `surface: "app"` component that took over the entire screen. In the new model, you write a full-screen layout directly in the Root Component (`index.tsx`): skip `<Chat />` and drop in `<MessageInput />` wherever you want the text box to sit.

**Language Variant** — a different language version of the same card. Variants are linked in **Panels → Languages & variants** (also at the top of **Card settings**), and players see the version in their language.

**Lorebook** — all of a card's entries. Keyword-triggered entries only go to the AI when matching keywords appear in chat, which saves token budget. **Panels → Lorebook** lists every entry on one page. The Lorebook is the container; individual items inside it are called **Entries**.

**Macro** — a `{{name}}` placeholder in entry text, automatically replaced with real content (like a variable value or system info) before being sent to the AI. E.g. `{{char}}`, `{{user}}`, `{{turnCount}}`.

**Message Renderer** (legacy concept) — pre-v18 worlds used a `customUI[] + surface: "message"` component to replace the default bubble. New worlds do the same thing inside the Root Component via `<Chat renderBubble={...} />`. When you import an old bundle, the engine auto-migrates the `messageRenderer` field into the root component; the editor shows a **Legacy** badge.

**Moment** — a small card with a title, a line of text and a picture, given to the player by the **Unlock a moment** effect. Moments collected into a list variable don't pop up twice.

**Player interface** — the screen players see while they play. Built from templates and parts in the **Player interface** editor, or written by hand as interface code in **Panels → Front End Code**. See [Player interface](/creator/player-view).

**Playlist** — a BGM playlist configuration that chains multiple background music tracks and controls whether to loop, shuffle, or play sequentially, plus autoplay behavior and gap between tracks.

**Post-History** — one of the four prompt sections, placed after all chat messages and before the AI starts generating. Shown as **At the end** in an entry's **Inject into** setting. Good for "last emphasis" instructions since the AI pays closest attention to what it just read.

**Precise tracking** — a per-variable switch. When it's on, the story AI stops changing the variable and a separate helper decides after each reply whether it should change, and by how much. New Number and Switch variables start with it on. See [Variables](/creator/variables#precise-tracking).

**Priority** — a numeric weight on behaviors or conditional BGM. Higher numbers get evaluated and executed first when several trigger at the same time.

**Recursive Triggering** — after entry A is triggered, its content is scanned again as "new text" to check if it can trigger entry B — a chain activation. Depth is set with **Cascading triggers** (0–10) under **Advanced** in the Context settings.

**Renderer** — the mechanism of using TSX code to fully take over how messages or interfaces are displayed. In the current model this lives in the **Root Component**; see also **`<Chat />`**.

**Reply processing** — rules in **Card settings** that catch a tagged block in the AI's reply (like `<status>…</status>`), write its contents into variables, a story event or an interface channel, and can hide it from the player. See [Reply processing](/creator/reply-rules).

**Root Component** — the entry point for a world's UI. A virtual filesystem of TSX files whose default export is `MyWorld()`. The default root is just `return <Chat />` (standard chat behavior); you customize it by passing `renderBubble` to `<Chat />`, composing `<Chat />` with sidebars and overlays, or building a fully custom layout from `<MessageList />` and `<MessageInput />`. Lives in **Panels → Front End Code**, entry file is `index.tsx`.

**`<Chat />`** — the platform-provided chat building block you drop into your Root Component. Handles the message list, input box, streaming, scrolling, editing, swipes, and checkpoints. Accepts `renderBubble` (customize a single bubble), `className`, and `children` (overlays on top of the chat). `<ChatCanvas />` is the legacy alias — still works, but new code should use `<Chat />`.

**Rule** — the name the World Spec and older cards' data use for a behavior (the `rules` array). The engine runs both. See Behavior.

**Scenario** — a part of the card with its own lore, variables, behaviors, AIs and memory, which only applies at certain times (a dungeon, a chapter, a side story). Added with **Add → A scenario**. See [Scenarios](/creator/modules).

**Secondary Keywords** — a keyword list for additional filtering after a primary keyword matches. Supports four combination logics: AND_ANY, AND_ALL, NOT_ANY, NOT_ALL.

**Session** — an instance of a game conversation. Each session independently maintains its own chat history and game state.

**SFX** — a short one-shot sound effect like a door opening, explosion, or item pickup chime. Can be triggered by AI audio directives, smart tracking, or behaviors.

**Smart tracking** — a card-wide switch in **Card settings**, on by default. After each reply a small helper sets variables that have Precise tracking, plays tracks whose "When to play" cue fits, and places scene images whose condition holds.

**Structured Output** — a world setting (`settings.structuredOutput`) that forces the AI to reply in JSON format via `response_format: { type: "json_object" }`. For mechanic-heavy worlds that need strict output parsing. The editor has no switch for it.

**System Preset** — one of the four prompt sections, located at the very top. Shown as **Always sent to the AI** in an entry's **Inject into** setting. The AI sees this first. Best for core character descriptions, world lore, and writing style — content that needs to be in effect at all times.

**Temperature** — the core parameter controlling AI reply randomness. Range 0–2: lower values make output more stable and predictable; higher values make it more creative but potentially off-topic.

**Trigger** — the first part of a behavior (**When it fires**); determines when the engine checks whether to act. Examples: "every turn," "every N turns," "every N seconds," "when a keyword appears," "when a variable crosses a threshold," "when the player presses a button."

**Turn** — one complete exchange: the player sends a message and the AI generates a reply.

**Variable** — a named container storing game state data. Four types, shown on the canvas as Number, Text, Switch and List / table (`number`, `string`, `boolean` and `json` in the data). The core object that directives and behaviors read from and write to.

**World** — a complete, self-contained interactive experience in Yumina, also called a card. The top-level container that packages characters, story, behaviors, interface, audio, and everything else together.

</div>
