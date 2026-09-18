---
name: tsx
description: Write React TSX for a world's custom visual layer — the rootComponent. One React root per world, multi-file virtual filesystem. Use when the user wants custom UI, visual design, interactive elements, or code.
---

# Skill: Custom TSX — rootComponent

Every world has exactly **one** rootComponent — a virtual filesystem of `.tsx` files that renders the entire visual experience. No surfaces. No message/app distinction. One root React component; compose what you need inside it using the building blocks (`<Chat>`, `<MessageList>`, `<MessageInput>`) the platform provides.

Two tools for modifying TSX:
- **`edit_custom_ui`** — Search-replace for modifications. Sends only the changed section. **PREFER this for edits** — avoids output truncation on large files.
- **`write_custom_ui`** — Full file replacement. Use for new files or complete rewrites.

## File System

The inventory lists each file in the rootComponent:

```
ROOT COMPONENT:
  {uuid}: "World Component" entry=index.tsx
    file: "index.tsx" (entry)
    file: "homepage.tsx"
    file: "bubble.tsx"
```

**Use filenames as IDs** to read and write individual files:

| Action | How |
|---|---|
| Read a file | `read_entities(["homepage.tsx"])` |
| Edit part of a file | `edit_custom_ui({ id: "homepage.tsx", old_code: "exact code to find", new_code: "replacement" })` |
| Rewrite a whole file | `write_custom_ui({ id: "homepage.tsx", tsxCode: "..." })` |
| Update the entry file | `write_custom_ui({ id: "index.tsx", tsxCode: "..." })` (non-filename IDs also resolve to the entry file) |
| Create a new file | `write_custom_ui({ id: "helpers.tsx", tsxCode: "..." })` |
| Delete a sub-file | `delete_entities(["homepage.tsx"])` (entry file cannot be deleted, only reset) |

## Keep files small — author across multiple files, and split monsters

A rootComponent is a multi-file project. Treat it like one.

- **Author new complex UIs as several small files from the start.** One component or screen per file (`index.tsx` mounts + routes; `phone.tsx`, `inventory.tsx`, `bubble.tsx`, `theme.ts`, etc.). Do NOT grow one giant `index.tsx`. Files over ~600-800 lines are a smell.
- **Why it matters:** a single broken bracket re-fails EVERY edit to a file until fixed, and a huge file you can't see in full is where edits go wrong. Small files keep each edit cheap and safe, and the whole world keeps compiling.
- **When a file is already a monster (1,000+ lines):** split it. Move a self-contained chunk into its own file:
  1. `write_custom_ui({ id: "phone.tsx", tsxCode: "...the extracted component, with its own imports + an `export`..." })`
  2. `edit_custom_ui` the source: remove the moved code and add the relative import (`import { Phone } from "./phone";`).
  3. Call `validate_world` to confirm BOTH files still compile.
- **The one hazard — shared state.** A nested function that reads its parent's `useState`/variables via closure will BREAK if you move it to another file (it loses access). Before extracting such a component, **lift the state it needs into explicit props** (`<Phone messages={messages} onSend={handleSend} />`) so the new file is self-contained. If a chunk is too entangled to make prop-driven cleanly, leave it in the entry file rather than splitting it into a broken module. (This is the exact bug behind "nested page functions defined outside MyWorld can't see state.")

## Patterns by Intent

Every visual intent maps to a pattern inside the rootComponent — there's no "message surface" or "app surface" picker anymore, just different ways to compose the entry file:

| User wants... | Pattern |
|---|---|
| Default chat with platform rendering | Entry file: `export default function App() { return <Chat />; }` |
| Custom message styling | Entry file: `<Chat renderBubble={Bubble} />`; `bubble.tsx` contains the Bubble component |
| Full-screen custom UI (no chat) | Entry file: `export default function App() { return <YourApp />; }` — `<Chat>` not imported |
| Chat + persistent widgets alongside | Entry file: `<><Sidebar /><Chat /></>` — compose children around `<Chat>` |
| Custom messages + floating widgets | Entry file: `<><HUD /><Chat renderBubble={Bubble} /></>` — combine both |

The `renderBubble` callback receives per-message props — see the **Customizing Message Bubbles** table below (note `content` is an alias for `contentHtml`).

## TSX Compile Rules

1. `export default function ComponentName` -- REQUIRED
2. Never import platform globals (React, useYumina, Chat, MessageList, Icons, Tailwind) -- they are pre-injected; use them directly. (Relative imports between a rootComponent's OWN files, e.g. `import Bubble from "./bubble"`, ARE supported.)
3. `React.useState()` not `useState()` -- React is in scope, not individual hooks
4. `const`/`let`/`var` all work — no scoping issues in the sandbox runtime
5. No TypeScript syntax -- no generics, interfaces, `as` casts, type annotations
6. No external/npm imports -- define helpers inline. A rootComponent may span multiple files; relative-import siblings as in rule 2.

> TSX is compiled server-side before approval. If your code has a syntax error the write tool returns a compile error — read it, fix the code, and call the write tool again.

## Styling Architecture — CSS Classes vs Inline Styles

**Use CSS classes (via `<style>` tag) for visual design. Use inline `style={{}}` for dynamic values that change with React state.** This is the most important styling decision — it determines whether the UI looks polished or flat.

### Why: inline styles CANNOT do

- `::before` / `::after` pseudo-elements (noise textures, decorative overlays, filmstrip patterns)
- `:hover` / `:focus` state transitions
- `@media` responsive breakpoints
- `@keyframes` animations
- Complex `clip-path` on pseudo-elements
- Descendant/sibling selectors

### How: inject a `<style>` tag

Define a CSS string constant and render it as a `<style>` element. Then use `className` on your JSX:

```tsx
var STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&display=swap');

  .my-card {
    background: #d4c9a8;
    clip-path: polygon(0% 1%, 2% 0%, 4% 1.2%, ...);
    position: relative;
  }
  .my-card::before {
    content: "";
    position: absolute;
    inset: 0;
    background: radial-gradient(ellipse at 15% 80%, rgba(100,70,30,0.12) 0%, transparent 50%);
    pointer-events: none;
  }
  .my-card:hover {
    transform: scale(1.02);
    box-shadow: 0 8px 30px rgba(0,0,0,0.3);
  }
  @media (max-width: 640px) {
    .my-card { padding: 12px; }
  }
`;

export default function MyComponent() {
  var api = useYumina();
  return (
    <div>
      <style>{STYLES}</style>
      <div className="my-card">...</div>
    </div>
  );
}
```

### When to use each

| Use case | Approach |
|---|---|
| Decorative effects (textures, overlays, torn edges) | CSS class + `::before`/`::after` |
| Hover/focus interactions | CSS class + `:hover`/`:focus` |
| Responsive layout changes | CSS class + `@media` |
| Animations | CSS `@keyframes` in `<style>` |
| Google Fonts | `@import url(...)` in `<style>` |
| Value depends on React state (e.g., HP bar width) | Inline `style={{ width: hp + "%" }}` |
| Toggle visibility based on state | Inline `style={{ display: isOpen ? "flex" : "none" }}` |
| One-off positioning/sizing | Inline `style={{ marginTop: 8 }}` |

### Prefix CSS classes to avoid conflicts

Always prefix custom CSS classes with a short namespace (e.g., `myt-`, `rpg-`, `vn-`) to prevent collisions with platform styles:

```css
.myt-paper { ... }
.myt-paper::before { ... }
.myt-char-card:hover { ... }
```

### Common decorative CSS patterns

**Noise texture overlay:**
```css
.my-root::before {
  content: "";
  position: fixed; inset: 0;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='400'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='4' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='400' height='400' filter='url(%23n)' opacity='0.08'/%3E%3C/svg%3E");
  pointer-events: none; opacity: 0.6; z-index: 0;
}
```

**Torn paper edges:**
```css
.my-paper {
  clip-path: polygon(0% 1.2%, 1.5% 0%, 3% 1%, 4.5% 0.2%, ... 0% 100%);
}
```

**Filmstrip border:**
```css
.my-frame::before, .my-frame::after {
  content: ""; position: absolute; width: 20px; height: 100%; top: 0;
  background: repeating-linear-gradient(to bottom, transparent 0px, transparent 8px, #fff 8px, #fff 18px, transparent 18px, transparent 30px);
}
.my-frame::before { left: 5px; }
.my-frame::after { right: 5px; }
```

**NEVER use only inline styles for a visual-heavy component** — define a `<style>` block for the visual design system.

### When the creator provides HTML/CSS or wants rich visual design

If the creator shares HTML/CSS code, a SillyTavern card, a design mockup, or asks for polished visual design (vintage paper, filmstrip frames, glassmorphism, etc.):

1. **Port the CSS into a `<style>` tag** — do NOT convert CSS classes to inline styles. Preserve `::before`/`::after`, `:hover`, `@media`, `clip-path`, and all decorative patterns exactly.
2. **Prefix all classes** with a short namespace (e.g., `myt-`, `rpg-`) to avoid collisions.
3. **Convert HTML to JSX** — `class` → `className`, self-close tags, `onclick` → `onClick`, etc.
4. **Keep React logic separate** — use `className` for the visual layer, `style={{}}` only for values that depend on React state.
5. **Import Google Fonts** via `@import url(...)` inside the `<style>` tag.

The result should look visually identical to the original HTML/CSS. Never downgrade rich CSS to flat inline styles.

## Forbidden APIs — NEVER Use These

Custom components run inside a **sandboxed iframe**. Direct browser APIs are blocked or unreliable. Use the `useYumina()` SDK instead:

| Instead of... | Use this SDK method |
|---|---|
| `fetch('/api/sessions/...')` | `useYumina().listSessions(worldId)`, `.createSession()`, `.deleteSession()`, `.revertToMessage()` |
| `window.location.pathname` | `useYumina().sessionId` and `.worldId` |
| `window.location.href = ...` | `useYumina().navigate(path)` |
| `localStorage.getItem(key)` | `useYumina().storage.get(key)` |
| `localStorage.setItem(key, val)` | `useYumina().storage.set(key, val)` |
| `navigator.clipboard.writeText(text)` | `useYumina().copyToClipboard(text)` |
| `window.__yuminaToggleImmersive()` | `useYumina().toggleImmersive()` |

The SDK handles auth, scoping, and security; direct browser APIs fail in the sandbox.

## Customizing Message Bubbles

To control how every chat message looks, pass a `renderBubble` callback to `<Chat>`. The callback receives the following props for each message:

| Prop | Type | Description |
|---|---|---|
| `contentHtml` | string | Pre-rendered HTML (markdown already converted). Use with `dangerouslySetInnerHTML`. |
| `content` | string | Displayed message text before markdown rendering; `contentHtml` is its rendered HTML. |
| `rawContent` | string | Original plain-text message content before markdown rendering. Use for text parsing (e.g. extracting XML tags). |
| `role` | `"user"` or `"assistant"` | Who sent this message |
| `messageIndex` | number | 0 = first message (greeting), 1+ = game messages |
| `variables` | object | For an already-saved message this equals THAT message's snapshot (NOT live global state); it falls back to live state only for the greeting, a streaming message, or a message with no snapshot. For current live global state call `useYumina().variables`. |
| `stateSnapshot` | object \| null | Full saved game state for this message; variable values are under `.variables`. |
| `renderMarkdown` | function | Render raw markdown to safe HTML. |
| `isStreaming` | boolean | `true` while this message is actively streaming |

**Typical entry file with custom bubbles** (two files — entry + bubble):

```tsx
// index.tsx (entry)
import Bubble from "./bubble";
export default function App() {
  return React.createElement(Chat, { renderBubble: Bubble });
}

// bubble.tsx
export default function Bubble({ contentHtml, role }) {
  return React.createElement("div", {
    className: role === "user" ? "bubble-user" : "bubble-ai",
    dangerouslySetInnerHTML: { __html: contentHtml },
  });
}
```

## Full-Screen UI (no Chat)

To take over the entire viewport and handle all chat display yourself, the entry file simply doesn't import `<Chat>`:

```tsx
// index.tsx
export default function App() {
  const api = useYumina();
  return React.createElement("div", null,
    api.messages.map(m => React.createElement("div", { key: m.id }, m.content)),
    // ... custom input, widgets, whatever
  );
}
```

Use `useYumina().sendMessage(text)`, `useYumina().messages`, `useYumina().variables` for chat state. To embed the platform chat inside a custom shell, use `<Chat />` (see Available Scope for what it handles).

## useYumina() SDK Reference

Call inside any component body. Same API everywhere — no per-surface restrictions.

**History viewers:** About the latest 50 snapshot-bearing messages per session retain saved state. Show "unavailable" for missing historical values; never substitute zero or live variables. Use message-level snapshots; swipe-level snapshots are not exposed to custom UI.

| Method / Property | Description |
|---|---|
| **Core** | |
| `sendMessage(text)` | Send a player message to the AI |
| `setVariable(id, value, options?)` | Update a game variable. options: `{ scope?, targetUserId? }` for multiplayer scoping. |
| `executeAction(actionId)` | Trigger a named action |
| `variables` | Current variable values, keyed by variable ID (not display name). |
| `worldName` | Current world name |
| `worldCover` | The world's cover image ("Cover" in Studio) as an absolute URL, or `null` when unset. Tracks cover edits automatically — prefer this over re-uploading the cover as an @asset when the creator wants the cover as a character avatar / header / splash image. Example: `worldCover ? <img src={worldCover} /> : <FallbackAvatar />` |
| **Messages & Streaming** | |
| `messages` | Loaded messages: `[{id, role, content, status, stateSnapshot, ...}]`. Find by message ID; read past values via `message.stateSnapshot?.variables?.[variableId]`. |
| `loadEarlierMessages()` | Load and prepend an older page (async). Use `hasEarlierMessages` / `isLoadingEarlier`; read after `messages` updates. |
| `isStreaming` | `true` while the LLM is generating |
| `streamingContent` | Accumulated streaming text (directives already stripped) |
| **Chat Actions** | |
| `editMessage(id, content)` | Edit a message's content (async, triggers auto-regen if applicable) |
| `deleteMessage(id)` | Delete a message (async) |
| `regenerateMessage(id)` | Regenerate the last assistant message |
| `continueLastMessage()` | Continue generating from the last message |
| `stopGeneration()` | Stop the current generation |
| `restartChat()` | Clear all messages and restart |
| `clearPendingChoices()` | Dismiss pending choice buttons |
| `swipeMessage(id, direction)` | Navigate to a different response variant (async) |
| **Checkpoints** | |
| `saveCheckpoint()` | Save a checkpoint at the current point (async) |
| `loadCheckpoints()` | Load saved checkpoints (async, results in `checkpoints`) |
| `restoreCheckpoint(id)` | Restore a saved checkpoint (async) |
| `deleteCheckpoint(id)` | Delete a checkpoint (async) |
| `checkpoints` | Metadata only: `[{id, name, messageCount, createdAt}]`. No SDK method reads a checkpoint's full state; restoring changes game progress. |
| **User & Multiplayer** | |
| `user` | **Use this for role-play rendering.** `{ name: string, avatar: string \| null }`. Persona-aware — follows the same branching as the `{{user}}` macro: if the player has an active persona, returns persona name + persona.avatarUrl; otherwise returns the Yumina account name + account image. Example: `<img src={user.avatar} alt={user.name} />`. |
| `currentUser` | `{id, name?, image?}` or null. **Raw Yumina account** — NOT persona-aware. Use only for account-level UI (profile link, logout, identifying the logged-in human regardless of role-play). For anything inside the world/chat/card rendering, use `user` instead, otherwise a player with an active persona "Alice" will still see their account name/avatar in your component while the chat says "Alice." |
| `room` | Multiplayer room object or null |
| `globalVariables` | Alias for `variables` (multiplayer compat) |
| `personalVariables` | Per-player variables (multiplayer) |
| `roomPersonalVariables` | Per-player variables scoped to the room (multiplayer) |
| `permissions` | User permissions object or null |
| **Audio** (see audio skill) | |
| `playAudio(trackId, opts?)` | Play a track. opts: volume, fadeDuration, chainTo, maxDuration, duckBgm |
| `stopAudio(trackId?, fadeDuration?)` | Stop one or all tracks |
| `setAudioVolume(type, vol)` / `getAudioVolume(type)` | BGM/SFX volume control |
| **Session & Navigation** | |
| `sessionId` | Current play session ID |
| `worldId` | Current world ID |
| `revertToMessage(messageId)` | Revert conversation to a checkpoint (async) |
| `createSession(worldId)` | Start a new session, returns session ID (async) |
| `deleteSession(sessionId)` | Delete a session (async) |
| `listSessions(worldId)` | List all sessions for a world (async) |
| `navigate(path)` | Navigate to a different page (e.g., `/app/chat/...`) |
| **UI Controls** | |
| `toggleImmersive()` | Toggle browser fullscreen + hide sidebar |
| `openPersonaManager()` | Open the player's persona manager (switch / create / edit personas) without leaving the world — the same panel the built-in composer "+" menu opens. In play, selection changes the current session's saved Persona. If the card saved a separate imported profile, offer an explicit re-import to change that copy. |
| `getPersonaProfile()` | Explicitly import the current session's selected Persona: returns a Promise of `{name, appearance, personality, backstory}` or `null` when none is selected; failures reject. Reads the same saved selection displayed by the Persona manager, including an explicit No Persona; never substitutes account defaults. Private notes are excluded. Call when the player chooses import, allow review/editing, and save a copy per run if identity must stay fixed. Older hosts may not expose this method; offer manual entry as a fallback. |
| `openSupport()` | Open the "support the creator" dialog (dollar tip / mushie gift) for the world being played — the play header's heart button is unreachable under a fullscreen card, so offer your own entry. **Returns a promise**: `{opened:true}`, or `{opened:false, reason}` where reason is `"self"` (the viewer IS the creator), `"signed-out"`, or `"unavailable"` (editor preview). Always `await` it and surface the reason — the creator testing their own card presses this first, and a silent no-op looks broken. |
| `fetchAsset(ref)` | Read one of this world's assets as raw bytes — the ONLY way binary data enters the sandbox. Takes an asset id (`"@asset:<uuid>"` or bare uuid), **never a URL**. `Promise<{ok, bytes?, contentType?, error?}>`; check `ok` first. Use for `.glb` models, large JSON tables, sprite atlases. Images do NOT need this — use `<img src={api.resolveAssetUrl(ref)}>`, and for a WebGL texture set `crossOrigin="anonymous"` on the Image. |
| `switchGreeting(index)` | Switch to a different greeting (multiple greetings are a built-in feature — create multiple `role: "greeting"` entries) |
| `copyToClipboard(text)` | Copy text to user's clipboard |
| `showToast(message, type?)` | Show a notification. type: "success", "error", or "info" |
| **Canvas State** | |
| `pendingChoices` | Array of pending choice button texts |
| `error` | Current error message or null |
| `streamingReasoning` | Accumulated reasoning/thinking text during streaming |
| `readOnly` | Whether the session is read-only |
| `canvasMode` | Current rendering mode: `"chat"`, `"custom"`, or `"fullscreen"` |
| `greetingContent` | Greeting text extracted from world entries |
| **Storage** (per-world, persists across sessions) | |
| `storage.get(key)` | Read a value (async) |
| `storage.set(key, value)` | Write a value (async) |
| `storage.remove(key)` | Delete a value (async) |
| **Model Picker** | |
| `selectedModel` | Currently selected model ID |
| `userPlan` | User's plan tier (e.g., `"free"`) |
| `preferredProvider` | `"official"` or `"private"` |
| `setModel(modelId)` | Switch the active model |
| `getModels()` | Fetch available models (async). Returns `{ models, pinnedModels, recentlyUsed }` |
| `pinModel(modelId)` | Pin a model to favorites (async). Returns `{ pinnedModels, accepted }` — `accepted: false` means the list is full (max 8). Render the returned list, never an optimistic guess |
| `unpinModel(modelId)` | Unpin a model (async). Returns `{ pinnedModels, accepted }` |
| **Session Memory & Story Summary** (the "会话记忆与剧情摘要 / Session Context" extension) | |
| `memorySummaryEnabled` | boolean — `true` when the player has the **Session Memory & Story Summary** extension installed. Gate the session-memory button on this; render nothing when `false`. This is the ONLY hook you need — the modal owns all the rest. |
| `injectContext(text, opts?)` | One-shot hidden context for the NEXT AI turn. **This is NOT session memory** — do not build a session-memory panel out of it. Keep them separate. |
| **Assets** | |
| `resolveAssetUrl(ref)` | Convert `@asset:id` to CDN URL |
| **Markdown** | |
| `renderMarkdown(text)` | Convert markdown string to safe HTML string. |
| **AI Completions** (raw LLM calls, no chat pipeline) | |
| `ai.complete({ messages, onDelta?, model?, maxTokens?, temperature?, includeLorebook? })` | Make a side LLM call. Returns full text (Promise). `messages`: array of `{role, content}`. `onDelta`: callback for streaming chunks. `model` defaults to the player's currently selected chat model (so phones/NPCs honor the player's model + BYOK choice) — only pass `model` to override. `includeLorebook` (see below) auto-injects world lore as a system message. Does NOT create a chat message or trigger state effects. Use for NPC dialogue, translations, descriptions, etc. |
| `ai.complete({ ..., includeLorebook: true \| "matched" })` | **Recommended for in-character side calls (phones, NPCs, support characters).** `true` / `"all"` injects every enabled non-greeting entry as a system message before your `messages`. `"matched"` runs the same keyword matcher the main chat uses against the LAST user message in `messages` and injects only triggered entries (lower token cost). Without this flag, side calls bypass the lorebook entirely — the AI plays roles "from the name alone" and drifts away from main-chat persona. |
| **Lorebook** (read-only, for cards that need to inspect or hand-pick entries) | |
| `entries` | Array of enabled lorebook entries (sorted by position). Shape: `{ id, name, content, keywords, position, section, enabled, role, tags? }`. Use this when you want surgical control — pick specific entries to inline. For most cases prefer `ai.complete({ includeLorebook: ... })` instead. |
| `getEntry(name)` | Find a single entry by exact name. Returns `null` if missing. In dev (localhost) misses log a warning with available names — handy when an author renames an entry and forgets to update the card. |

`SandboxEntry.section` is one of: `"system-presets"`, `"examples"`, `"chat-history"`, `"post-history"`.
| **Context Injection** (cross-channel awareness) | |
| `injectContext(message, options?)` | Inject a one-shot context message into the next main chat AI turn. Consumed after one use. `options.role`: "system" (default) or "user". Use to tell the main AI about phone conversations, NPC dialogue, etc. without creating a visible chat message. |

## Available Scope

- **React** -- `React.useState`, `React.useEffect`, `React.useMemo`, `React.useRef`, `React.useCallback`
- **useYumina()** -- hook for game interaction (see table above)
- **useAssetFont(assetRef, options?)** -- loads an uploaded font asset; returns a ready-to-use `fontFamily` string for inline styles. Example: `var font = useAssetFont("@asset:abc123", { family: "Medieval", fallback: "serif" })`
- **Icons** -- all Lucide icons (~1400) via `Icons.Heart`, `Icons.Sword`, `Icons.Shield`, etc. Browse: https://lucide.dev/icons
- **Tailwind CSS** -- full utility classes
- `Chat` — The chat building block. `<Chat />` gives the full platform chat experience (messages, input, streaming, editing, swipes, checkpoints, auto-scroll, read-only). Optional `renderBubble` customizes each bubble (props: see **Customizing Message Bubbles**). Also supports `className` and `children` (rendered above the message list, e.g. a header).
- `MessageList` — Granular building block: just the scrolling message list (no input box). Use when you need complete control over the input area.
- `MessageInput` — Granular building block: just the text input with send button. Pair with `MessageList` for full control.
- `ModelPickerModal` — The official platform model selector. Props: `{ open: boolean, onClose: () => void }`. Pair with `ModelTrigger` to open it. Prefer it over a hand-rolled dropdown — see **Pattern: Official Model Picker** below for why and how.
- `ModelTrigger` — Pill-shaped button that displays the current model name + tier dot. Props: `{ onClick: () => void }`. Drops in next to a chat composer or anywhere in a card; pair its `onClick` with state that opens `<ModelPickerModal>`.
- `SessionMemoryModal` — The official **Session Memory & Story Summary** panel (the "会话记忆与剧情摘要 / Session Context" extension: Systems / Memory / Story Summary / Summaryception tabs). Props: `{ open: boolean, onClose: () => void }`. This is the SAME modal the built-in chat composer opens from its "Context" button. **When a card ships a custom composer (its own `<input>`/`<textarea>` instead of the built-in one), that Context button is gone — you MUST re-add this modal yourself, or the player loses session memory entirely.** Gate it on `api.memorySummaryEnabled` (see **Pattern: Session Memory Button** below). Do NOT hand-roll a memory/summary panel and do NOT substitute `api.injectContext` — that is a different feature.

## Asset Handling — NEVER Inline Base64

Binary assets (images, audio, fonts) must go through the asset system, never be embedded directly as data URIs. Inline base64 inflates files by 33% over the raw binary, ships on every page load, and bloats the world JSON so reads can't see the full file without pagination.

**Canonical pattern:**
```tsx
var api = useYumina();
// Images
React.createElement('img', { src: api.resolveAssetUrl('@asset:abc123') })
// Fonts
var font = useAssetFont('@asset:abc123', { family: 'Serif', fallback: 'serif' })
// Audio via useYumina().playAudio({ trackId })  (tracks use @asset: urls too)
```

**Anti-pattern (do NOT produce this):**
```tsx
// ❌ 400KB of base64 in the source. Breaks context, slows page load, agent can't read back.
React.createElement('img', { src: 'data:image/png;base64,iVBORw0KGgoAAAANSU...' })
```

If a creator asks you to "use this image inline," upload is still the right answer. Reply: "I'll insert an `@asset:placeholder-1` reference. After you upload the real image to Assets and get its ID, I'll swap the ref. Keeps the file light and cacheable." Do NOT inline the bytes.

If `read_entities` or `grep_world` surfaces existing data URIs in a component, flag them to the creator, call `validate_world`, and offer to migrate (replace each data URI with a placeholder `@asset:` ref the creator fills in after upload).

## Theme-Safe Colors

Use these Tailwind classes to match the app theme:

| Purpose | Class |
|---|---|
| Card background | `bg-card` |
| Page background | `bg-background` |
| Muted background | `bg-muted` |
| Primary text | `text-foreground` |
| Secondary text | `text-muted-foreground` |
| Borders | `border-border` |
| Accent/brand | `text-primary`, `bg-primary` |

## Layout Width — Critical

In the play view, content width is **capped** by the platform — it is NOT full-viewport. Typical max widths by screen size:

| Viewport | Max content width |
|---|---|
| < 768px (mobile) | 100% |
| 1180–1439px | ~1024px |
| 1440–1679px | ~1280px |
| 1680px+ | ~1504px |

The studio canvas preview matches these constraints. **Never assume more than ~1200px of horizontal space.** Layouts that look fine at unlimited width will be cut off or squeezed in the actual play view.

**Rules:**
- Use percentage widths or `max-w-full`, not fixed pixel widths above 900px
- For multi-column layouts, always use Tailwind responsive grid: `grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3`
- Horizontal scrolling is a bug — if content overflows, the layout is wrong
- Test with the tablet (768px) and mobile (375px) previews in the studio canvas

## Mobile-First Design

Most players use phones. Design for mobile first, then adapt for larger screens.

**Layout:**
- Default to single-column, stack vertically. Add columns on wider screens (`grid-cols-1 md:grid-cols-2`)
- Use `flex-col` as the base direction. Sidebars and multi-pane layouts should collapse or hide on mobile
- Avoid fixed-position panels that consume too much screen space on small viewports — use toggleable drawers/overlays instead
- Font size minimum 14px for body text, 12px for secondary text. Anything smaller is unreadable on phones

**Touch targets:**
- Buttons and interactive elements: minimum 44px height, adequate spacing between tap targets
- Don't rely on hover states for essential information — phones don't have hover. Use hover as enhancement only (`hover:bg-...` is fine for desktop polish, but the default state must be clear without it)

**Scrolling:**
- Tall content should scroll naturally inside `overflow-y: auto` containers. Don't fight the browser's scroll behavior
- Avoid nested scroll containers where possible — they create confusing UX on touch devices
- The `<Chat />` building block already handles scroll correctly. Don't wrap it in another scrolling container

**Quick checklist for every component:**
1. Does it fit in 375px width without horizontal overflow?
2. Can all buttons be tapped with a thumb?
3. Is text readable without zooming?
4. Do overlays/modals have a clear close target?

## Pattern: Interactive Greeting (messageIndex === 0)

```tsx
export default function GameRenderer({ content, role, messageIndex, variables }) {
  var api = useYumina();

  if (messageIndex === 0 && role === "assistant") {
    return (
      <div className="space-y-4">
        <div dangerouslySetInnerHTML={{ __html: content }} />
        <div className="flex gap-3 mt-4">
          <button
            onClick={function() { api.setVariable("class", "Warrior"); api.sendMessage("I choose Warrior"); }}
            className="flex items-center gap-2 px-4 py-3 rounded-lg border border-border hover:bg-muted transition-colors"
          >
            <Icons.Sword size={20} />
            <span className="font-medium">Warrior</span>
          </button>
        </div>
      </div>
    );
  }

  return <div dangerouslySetInnerHTML={{ __html: content }} />;
}
```

When creating an interactive greeting, also:
1. Add the relevant variables (e.g., "class" with type "string")
2. Update the greeting entry with narrative that sets up the choice
3. Update system prompt so AI knows about the player's selection

## Pattern: Official Model Picker in a Custom UI

When the creator wants an in-card model switcher (so players can change model without leaving the card), use the official building blocks — do NOT hand-roll a dropdown.

```tsx
export default function App() {
  var open = React.useState(false);
  var isOpen = open[0];
  var setOpen = open[1];

  return (
    <div className="relative h-full">
      {/* Floating switcher in a corner */}
      <div className="absolute top-3 right-3 z-20">
        <ModelTrigger onClick={function() { setOpen(true); }} />
      </div>

      <Chat />

      <ModelPickerModal open={isOpen} onClose={function() { setOpen(false); }} />
    </div>
  );
}
```

`<ModelTrigger>` needs only `onClick`; the modal handles everything else (official/BYOK toggle, pinning, search, plan warnings, i18n). Any custom button/icon works as the trigger — just flip the state that drives `<ModelPickerModal>`'s `open`.

## Pattern: Session Memory Button (会话记忆与剧情摘要 / Session Context)

When a creator asks for the **Session Memory & Story Summary** plugin (aka "会话记忆与剧情摘要（Beta）" / "Session Context") in a custom UI, the answer is ALWAYS this: a button gated on `api.memorySummaryEnabled` that opens the official `<SessionMemoryModal>`. Do NOT invent your own memory/summary panel, and do NOT wire it to `api.injectContext` (that is a separate one-shot feature). The modal already contains all four tabs (Systems / Memory / Story Summary / Summaryception), edit/regenerate, thresholds, and model selection — you only supply the button and open/close state.

**Why this is needed:** the platform's built-in chat composer already shows a "Context" button that opens this exact modal. But the moment a card replaces the built-in composer with its own `<input>`/`<textarea>` (or renders `<MessageList>` without the built-in `<MessageInput>`), that button disappears. Re-adding `<SessionMemoryModal>` is the only way to give those players session memory back.

```tsx
export default function ChatShell() {
  var api = useYumina();
  var memOpen = React.useState(false);
  var isOpen = memOpen[0];
  var setOpen = memOpen[1];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-end gap-2 p-2">
        {/* Only render when the player has the extension installed */}
        {api.memorySummaryEnabled && (
          <button onClick={function() { setOpen(true); }} title="Session Context">
            <Icons.Brain size={16} />
          </button>
        )}
      </div>

      <MessageList />
      {/* ...your custom composer / textarea calling api.sendMessage()... */}

      {/* The real plugin. Renders nothing unless open; safe to always mount. */}
      <SessionMemoryModal open={isOpen} onClose={function() { setOpen(false); }} />
    </div>
  );
}
```

If `api.memorySummaryEnabled` is `false`, the player has not installed the extension — hide the button (the modal would have nothing to show). The modal handles its own i18n (zh/en), so no translated strings are needed.

## Pattern: HUD Below Messages

```tsx
export default function HudRenderer({ content, role, variables }) {
  if (role === "user") return <div className="text-foreground" dangerouslySetInnerHTML={{ __html: content }} />;
  return (
    <div>
      <div dangerouslySetInnerHTML={{ __html: content }} />
      <div className="flex gap-4 mt-3 px-3 py-2 rounded bg-muted text-sm text-muted-foreground">
        <span><Icons.Heart size={14} className="inline mr-1" />{variables.hp}/{variables.maxHp}</span>
        <span><Icons.Coins size={14} className="inline mr-1" />{variables.gold}</span>
      </div>
    </div>
  );
}
```

## Pattern: Full-Screen Chat Shell (Manual)

> **Prefer `<Chat />`** unless you need complete control over every aspect of the chat UI. `<Chat />` gives you messages, input, streaming, editing, swipes, checkpoints, and auto-scroll out of the box — see the Chat + Overlay pattern below.

This manual pattern is for when you need to control every detail of how messages render and interact. You must handle messages, streaming, and input yourself:

```tsx
export default function GameShell({ variables, worldName }) {
  var api = useYumina();
  var scrollRef = React.useRef(null);
  var inputState = React.useState("");
  var input = inputState[0];
  var setInput = inputState[1];

  var msgs = api.messages || [];

  React.useEffect(function() {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [msgs.length, api.streamingContent]);

  function handleSend() {
    var text = input.trim();
    if (!text || api.isStreaming) return;
    api.sendMessage(text);
    setInput("");
  }

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {msgs.map(function(m, i) {
          return (
            <div key={m.id || i} className={m.role === "user" ? "text-right" : ""}>
              <div className={"inline-block max-w-[80%] px-3 py-2 rounded-lg whitespace-pre-wrap " +
                (m.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted")}>
                {m.content}
              </div>
            </div>
          );
        })}
        {api.isStreaming && api.streamingContent && (
          <div className="inline-block max-w-[80%] px-3 py-2 rounded-lg bg-muted animate-pulse whitespace-pre-wrap">
            {api.streamingContent}
          </div>
        )}
      </div>
      <div className="border-t border-border p-3 flex gap-2">
        <input
          value={input}
          onChange={function(e) { setInput(e.target.value); }}
          onKeyDown={function(e) { if (e.key === "Enter" && !e.shiftKey) handleSend(); }}
          placeholder="Type a message..."
          disabled={api.isStreaming}
          className="flex-1 bg-muted rounded-lg px-3 py-2 text-sm text-foreground outline-none"
        />
        <button onClick={handleSend} disabled={api.isStreaming}
          className="bg-primary text-primary-foreground rounded-lg px-4 py-2 disabled:opacity-50">
          <Icons.Send size={16} />
        </button>
      </div>
    </div>
  );
}
```

When building on this pattern:
- Add game-specific UI around the chat (sidebars, HUD panels, status bars)
- Style messages based on `m.role` or game state
- Render the first assistant message (`i === 0 && m.role === "assistant"`) as a special greeting/intro
- Disable input while `api.isStreaming` to prevent double-sends

## Pattern: Responsive Full-Screen App

For rootComponent files that need different layouts on mobile vs desktop:

```tsx
// ✅ Use window.innerWidth — stable, not affected by your own layout changes
var isMobileState = React.useState(function () {
  return window.innerWidth < 480;
});
var isMobile = isMobileState[0];
var setIsMobile = isMobileState[1];

React.useEffect(function () {
  function onResize() { setIsMobile(window.innerWidth < 480); }
  onResize();
  window.addEventListener("resize", onResize);
  return function () { window.removeEventListener("resize", onResize); };
}, []);
```

The `480` threshold is an example — adjust to your design. Tailwind breakpoints: `sm` = 640, `md` = 768, `lg` = 1024. If mixing JS detection with Tailwind responsive classes, use the same breakpoint value to avoid mismatches.

For CSS-only responsive styling, Tailwind classes work directly: `<div className="grid grid-cols-2 md:grid-cols-4">`

**Antipattern — causes infinite flicker:**

```tsx
// ❌ ResizeObserver on own container + layout switching = feedback loop
var ro = new ResizeObserver(function (entries) {
  setWidth(entries[0].contentRect.width);  // triggers re-render
});
ro.observe(containerRef.current);  // observes element whose size depends on width
var isMobile = width < 480;  // changes layout → changes container width → loop forever
```

Never derive layout-switching state from a ResizeObserver on an element whose size depends on that state.

### Pattern: Chat + Overlay (Chat Building Block)

Use when the creator wants styled messages AND floating widgets (e.g., SillyTavern migration with regex status bars + phone widget).

```tsx
export default function MyWorld() {
  var api = useYumina();
  var [showStatus, setShowStatus] = React.useState(true);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", position: "relative" }}>
      <Chat renderBubble={function(msg) {
        // msg has: contentHtml, rawContent, role, messageIndex, isStreaming, stateSnapshot, variables, renderMarkdown
        var cleanHtml = msg.contentHtml.replace(/<状态栏>[\s\S]*?<\/状态栏>/g, "");
        return (
          <div style={{
            background: msg.role === "user" ? "#1e293b" : "#0f172a",
            borderRadius: 12,
            padding: "12px 16px",
            color: "#e2e8f0",
          }}>
            <div dangerouslySetInnerHTML={{ __html: cleanHtml }} />
          </div>
        );
      }} />

      {/* Floating status panel */}
      {showStatus && (
        <div style={{
          position: "absolute", bottom: 80, right: 16,
          background: "#1e293b", border: "1px solid #334155",
          borderRadius: 12, padding: 16, zIndex: 10,
        }}>
          <div style={{ fontSize: 12, color: "#94a3b8" }}>
            HP: {api.variables.hp || 100} / {api.variables.hp_max || 100}
          </div>
        </div>
      )}
    </div>
  );
}
```

**`renderBubble` props**: identical to the table under "Customizing Message Bubbles" above — `contentHtml`/`content`/`rawContent`/`role`/`messageIndex`/`variables`/`stateSnapshot`/`isStreaming`/`renderMarkdown` (see there for the `variables` vs `stateSnapshot` distinction).

## Pattern: Separate AI Conversation (Phone, NPC Dialogue)

Use `api.ai.complete()` for any AI conversation that should NOT appear in the main chat. The component manages its own message history in React state.

**Always pass `includeLorebook: "matched"` when the side call is in-character** — without it the AI plays the role from the name alone and drifts away from the canon persona stored in the world's lorebook.

```tsx
export default function PhoneApp() {
  var api = useYumina();
  var historyState = React.useState([
    { role: "system", content: "You are a grumpy shopkeeper. The player has " + (api.variables.gold || 0) + " gold." }
  ]);
  var history = historyState[0];
  var setHistory = historyState[1];
  var replyState = React.useState("");
  var reply = replyState[0];
  var setReply = replyState[1];

  function askNPC(text) {
    var updated = history.concat([{ role: "user", content: text }]);
    setReply("");
    api.ai.complete({
      messages: updated,
      includeLorebook: "matched",  // ← pulls relevant world lore for this turn
      onDelta: function(chunk) { setReply(function(r) { return r + chunk; }); },
    }).then(function(fullText) {
      setHistory(updated.concat([{ role: "assistant", content: fullText }]));
      // Optionally tell the main AI what happened
      api.injectContext("Player just bought a sword from the shopkeeper for 50 gold.");
    });
  }

  return (
    <div>
      <Chat />
      <div className="npc-panel">
        <p>{reply}</p>
        <button onClick={function() { askNPC("What do you sell?"); }}>Talk</button>
      </div>
    </div>
  );
}
```

**Key points:**
- `ai.complete()` — separate LLM call, no chat pipeline, no visible message
- `includeLorebook: "matched"` — pulls relevant lore for this turn (modes: see the `ai.complete` SDK entry)
- `injectContext()` — optional, tells main AI about what happened (consumed on next turn)
- `setVariable()` — for persistent cross-channel state (e.g., gold changed after purchase)
- History in React state is session-ephemeral. Use `api.storage` for persistence across page reloads.

### Loading lorebook context into a side call

Side LLM calls bypass the main PromptBuilder, so the model has zero knowledge of the world unless you include it. **For 90% of cases, just pass `includeLorebook: "matched"`** — the server does the same keyword-driven assembly the main chat uses, against the last user message in your payload:

```tsx
function askCharacter(charName, userText) {
  api.ai.complete({
    messages: [
      { role: "system", content: "Stay strictly in character as " + charName + ". Reply in one or two short lines." },
      { role: "user", content: userText },
    ],
    includeLorebook: "matched",  // ← pulls character + world lore relevant to userText
  }).then(function(reply) {
    // …append reply to local history…
  });
}
```

If you need surgical control (e.g. "this NPC only knows the tavern subset"), iterate `api.entries` yourself and assemble the system message manually:

```tsx
var tavernLore = api.entries
  .filter(function(e) { return (e.tags || []).indexOf("tavern") !== -1; })
  .map(function(e) { return "【" + e.name + "】\n" + e.content; })
  .join("\n\n");
api.ai.complete({
  messages: [
    { role: "system", content: "You are the tavern keeper.\n\n" + tavernLore },
    { role: "user", content: userText },
  ],
});
```

## Persistent social simulators

For an X-style simulator with public posts, DMs and channels, use `api.social`.
Do not route public posts and every DM through the same `api.messages` array,
or treat React state / browser storage as a cloud save.

Configure a JSON variable with **id** `social-config`, `aiAccess: "none"`, and
`defaultValue: { profiles: [{ id, name, handle, avatar, loreEntryId }], replyCounts: { publicPost: 10, privateMessage: "all", channel: "all", timeline: 3 } }`.
Use existing member lore entry IDs and `@asset:` avatar references. The roster
supports 1–50 unique members. This API requires an owned play session.
Each optional count accepts a positive safe integer or `"all"`, capped by the
eligible members. Omitted post/DM/channel counts default to six, timeline to
three; directed replies to a character request one reply. Configuration comes
from the card's JSON default value, not mutable session variables. New actions
read current configuration; existing jobs retain their assigned members.

- `await api.social.get()` → `{ state, profiles, replyCounts }`. Show the effective
  count before sending and explain that more members usually take longer and
  increase model cost. `"all"` means all selected or conversation members.
- `await api.social.action({ id: crypto.randomUUID(), type, ...payload })` →
  `{ state }` after the transaction commits. Reuse the same action ID on retry.
- Actions: `setup(members)`, `post(text, parentId?)`,
  `like(postId, value)`, `repost(postId, value)`, `follow(profileId, value)`,
  `conversation(name, members, channel)`, `members(conversationId, members)`,
  `message(conversationId, text)`, `read`, and `refresh`.
- Posts have `authorId`, `parentId`, `likes`, `reposts` and `createdAt`.
  Conversations have `members`, `channel` and their own `messages` array.
  Notifications reference a post or conversation; render actual events.
- A post, message or refresh queues a job in `state.jobs`. Generate it with
  `await api.social.generate({ jobId, attempt: crypto.randomUUID(), model: api.selectedModel })`.
  It returns `{ state }` after at most six members. Display
  `(job.completedCount ?? 0) / job.members.length` progress. If the returned job
  is `queued` with increased progress, continue after that request settles using
  the **same** attempt until done. Polling can also resume queued jobs. Avoid
  overlapping requests for the same job or retry loops on unchanged state.
  Recover a transport interruption with the **same** attempt. Explicitly retry
  an error or a running job older than four minutes
  with a new attempt; this may incur a new model charge. `{ ...request, cancel: true }`
  cancels the job. Successful batches remain saved after errors/cancellation;
  retries generate only remaining members. Do not automatically retry errors.
  Show errors and stop/continue-remaining controls, and poll `get()` to recover.
- Generation uses the existing billed model pipeline and only the target
  conversation plus permitted character lore. The engine validates structured
  replies and persists them. Never execute model output as code.

Within the same `state.epoch`, keep only the highest `state.revision` when parallel responses arrive. The latest authoritative `get()` may introduce a new epoch after restart/restore; clear view/job refs then, and discard late mutation responses from previous epochs. Key
drafts by session and conversation; allow typing during generation and clear a
draft only after its action is saved. Honor `api.readOnly`, guard IME composition,
and distinguish local drafts from persisted records. This is a single-player
fictional app, without real X accounts or multiplayer messaging.

Before declaring a social UI complete, check post → timeline/profile → member
reply → notification → independent DM → channel, then reload and switch
sessions. Verify likes persist and private text never appears in public context.
Schema/TSX validation alone does not prove these behaviors.

## Common Errors

| Error | Fix |
|---|---|
| `useState is not defined` | Use `React.useState()` |
| `import` of React/useYumina/Chat/Icons | Remove — they're injected globals (relative imports between a rootComponent's own files are fine) |
| `message.content` | Use `content` directly (destructured prop) |
| Component not showing | Ensure `export default function` |
| TS syntax errors | Remove generics `<T>`, interfaces, `as` casts |
| `const`/`let` issues | Rare — try `var` if you hit scoping errors |
| Full-screen shows blank / no messages | Read `api.messages` and render them — they are NOT auto-displayed |
| Full-screen has no text input | Add your own `<input>` and call `api.sendMessage(text)` on submit |
| Greeting not visible in full-screen | Greeting is `api.messages[0]` — display it yourself |
| Streaming text not visible | Check `api.isStreaming` and render `api.streamingContent` |
| `renderMarkdown is not defined` | Use `useYumina().renderMarkdown`. The prop version is a no-op pass-through — the SDK version does actual markdown→HTML conversion. |
| Reading `metadata.messages` returns empty | `metadata` prop doesn't exist. Use `useYumina().messages` — that's the ONLY message source |
| UI flickers / infinite re-render | Never derive `isMobile` from ResizeObserver on own container — use `window.innerWidth` + resize listener, or Tailwind responsive classes (`md:`, `lg:`) |
| Layout cut off / overflows in play view | Play view caps width at ~1024–1280px. Never use fixed widths above 900px — use `w-full`, `max-w-full`, or percentage-based layouts |
| `Chat is not defined` / `ChatCanvas is not defined` | The identifier is injected at render time. If a file references it from inside a deep function that the TSX compiler didn't detect, import it explicitly at the top of the file: `const { Chat } = globalThis;`. |
| `<Chat />` renders but no messages appear | The app component must be used in a play session. In editor preview, Chat renders as empty (no-op fallback). |
| Using `<Chat />` inside a `renderBubble` callback | `<Chat>` is the whole chat; you can't recursively put it inside a single bubble. The bubble receives one message's content/role/meta as props — render just that. |

