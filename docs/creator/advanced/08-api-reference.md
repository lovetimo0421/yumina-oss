# API Reference

> The complete list of **everything** the sandbox exposes — globals, components, every field and method on `useYumina()`, type definitions, and the replacements for blocked browser APIs.

This is **reference documentation**, not a tutorial. Read the [Custom UI Guide](./custom-ui-deep.md) first to get the big picture; come here to look up specific signatures.

Everything on this page is derived from the actual implementation in `packages/app/sandbox/`, so it matches the sandbox version shipped with the editor.

---

## Sandbox globals

These names are **available everywhere in your root component tree with no import statement**:

| Name | Kind | What it is |
|------|------|------------|
| `React` | module | Full React (`useState`, `useEffect`, `useRef`, `useMemo`, `useCallback`, `useLayoutEffect`, `Fragment`, ...) |
| `useYumina` | hook | Platform SDK — see [`useYumina()` SDK](#useyumina-sdk) |
| `useAssetFont` | hook | Load a custom font from the asset library — see [`useAssetFont()`](#useassetfont) |
| `Icons` | object | 1400+ Lucide icon components: `<Icons.Heart />`, `<Icons.Sword />`. Full catalog: <https://lucide.dev/icons> |
| `Chat` | component | Full chat building block — see [`<Chat>`](#chat) |
| `MessageList` | component | Messages without input — see [`<MessageList>`](#messagelist) |
| `MessageInput` | component | Input bar only — see [`<MessageInput>`](#messageinput) |
| `ChatCanvas` | component | Legacy alias for `<Chat />` — see [`<ChatCanvas>`](#chatcanvas) |
| `exports`, `module` | object | CJS-style export fallback; you typically ignore these |

**Do NOT import React or any of the names above** — they are injected by the sandbox. Writing `import React from "react"` is silently stripped at compile time but is redundant.

**Your own files CAN be imported** — multi-file root components use ES module syntax: `import StatBar from "./stat-bar"`. Extensions `.tsx`, `.ts`, `.jsx`, `.js` can be omitted.

---

## `useYumina()` SDK

Call it inside your component function:

```tsx
function MyWorld() {
  const api = useYumina()
  // api.variables, api.sendMessage(...), ...
}
```

Full surface, grouped by purpose:

### State reads (synchronous)

Read the latest game state. The component re-renders whenever any of these change.

| Field | Type | Meaning |
|-------|------|---------|
| `variables` | `Record<string, unknown>` | Session-scope game variables, keyed by the variable's **ID**. Its **display name** also works as a read key (`api.variables.hunger` finds the variable named `hunger` even when its ID is a UUID). Example: `{ health: 80, gold: 150 }`. See [ID vs display name](#id-vs-display-name) |
| `globalVariables` | `Record<string, unknown>` | Global variables shared across all sessions. Same ID-or-name lookup |
| `worldName` | `string` | Name of the current world |
| `worldCover` | `string \| null` | The world's cover image ("Cover" in Studio) as an absolute URL, `null` when unset. Tracks cover edits automatically — use it for character avatars / headers / splash art instead of re-uploading the cover as an asset |
| `worldId` | `string` | UUID of the current world |
| `sessionId` | `string` | UUID of the current play session |
| `currentUser` | `{ id, name?, image? } \| null` | Raw account: id, display name, account avatar. `null` when logged out. Use for **account-level** UI like "view profile". For **role-play** rendering inside the world, use `user` instead |
| `user` | `{ name: string; avatar: string \| null }` | The role-played player — same persona-vs-account branching as the `{{user}}` macro. When the player has a persona active, `user.name` is the persona name and `user.avatar` is the persona avatar; otherwise it falls back to the account. **This is what you want for in-world chat bubbles, character cards, profile panels** |
| `mode` | `"session" \| "guest-preview"` | `"session"` is a real play session. `"guest-preview"` is a logged-out hub preview — actions that mutate state are no-ops and surface a sign-in prompt to the parent |
| `capabilities` | `{ canSendMessage, canPersistSession, canUseSessionApis, requiresAuth }` | What the current `mode` allows. Read these to disable buttons that would no-op (e.g. the Send button in guest preview), or to render an inline "Sign in to continue" CTA |
| `language` | `string` | Active i18n language code from the host (`"en"`, `"zh"`, ...). Use this to pick translations inside the card without depending on the host's i18next instance |
| `messages` | `Array<Record<string, unknown>>` | Full message history — see [`SandboxMessage`](#sandboxmessage) |
| `isStreaming` | `boolean` | `true` while the AI is generating a reply |
| `streamingContent` | `string` | Live streaming text from the AI (updates frequently) |
| `streamingReasoning` | `string` | Live "thinking" / reasoning text from the AI (only for reasoning models) |
| `pendingChoices` | `string[]` | Choice button labels emitted by rules |
| `error` | `string \| null` | Current error message (API failure, generation error) or `null` |
| `readOnly` | `boolean` | `true` when viewing someone else's session — `<Chat />` hides the input automatically |
| `checkpoints` | `Array<Checkpoint>` | Saved checkpoints — see [`Checkpoint`](#checkpoint) |
| `greetingContent` | `string \| null` | Greeting text computed from world entries (used by `<Chat />` as empty-state content) |
| `canvasMode` | `"chat" \| "custom" \| "fullscreen"` | Current canvas mode |
| `selectedModel` | `string` | Currently selected AI model ID |
| `userPlan` | `string` | User's subscription plan (`"free"`, `"go"`, `"plus"`, `"pro"`, `"ultra"`, `"internal"`) |
| `preferredProvider` | `"official" \| "private"` | Official API vs. user's own key |
| `entries` | `ReadonlyArray<SandboxEntry>` | World lorebook entries — enabled only, sorted by `position`. See [Lorebook lookups](#lorebook-lookups) and [`SandboxEntry`](#sandboxentry) |

### ID vs display name

Every variable has two labels, and the Variables editor shows both:

- **ID** — the key the game state is actually stored under. New variables get a
  random UUID like `a8c5a685-1317-40b2-8f11-baccd39f9042` until you change it.
  The ID field lowercases what you type, so an ID can never be `zombieKills`.
- **Display name** — what you call it (`hunger`, `Love meter`, `zombieKills`).

`api.variables` is keyed by ID, and also resolves a display name:

```jsx
api.variables.hunger        // works whether "hunger" is the ID or the display name
api.variables["Love meter"] // display names with spaces work too
api.setVariable("hunger", 50)  // writes to that variable's ID
```

The ID wins when both exist. If one variable's ID is `hp` and another's display
name is also `hp`, `api.variables.hp` reads the one whose **ID** is `hp`.

`Object.keys(api.variables)` still returns **IDs only** — one entry per variable,
never a duplicate for the name. If you iterate the bag to build a panel, you get
exactly the variables you declared.

### Game actions (fire-and-forget)

These methods return nothing; they just post the intent to the parent app.

| Method | What it does |
|--------|--------------|
| `sendMessage(text)` | Send a message as the player, triggering an AI reply |
| `setVariable(id, value, options?)` | Set a variable. `id` is the variable's ID, or its display name. `options`: `{ scope?: string; targetUserId?: string }`. `scope` picks the variable scope (for global/personal), `targetUserId` lets you write variables for a specific player in multiplayer |
| `executeAction(actionId)` | Fire a named action defined by the rules engine (e.g. `"attackBoss"`) |
| `switchGreeting(index)` | Swap to a different greeting variant by index |
| `clearPendingChoices()` | Dismiss pending choice buttons without picking one |
| `setComposerDraft(text)` | Drop `text` into the chat composer and focus it. **Does not send.** Use when you want the player to review or edit the message before hitting Send (e.g. an NPC interaction button that primes a conversation starter). Sandbox-local — no parent round-trip — so it only works alongside the bundled `<MessageInput>` / `<Chat>` components |

### Chat control

Everything the default chat bar can do, exposed so your custom UI can do it too.

| Method | What it does |
|--------|--------------|
| `editMessage(messageId, content)` | Edit an existing message. Returns `Promise<boolean>`; `true` on success |
| `deleteMessage(messageId)` | Delete a message. Returns `Promise<boolean>` |
| `regenerateMessage(messageId)` | Ask the AI to regenerate the given reply (fire-and-forget) |
| `continueLastMessage()` | Continue generating from the last AI message (fire-and-forget) |
| `stopGeneration()` | Interrupt the current stream (fire-and-forget) |
| `restartChat()` | Clear all messages, reset state, start fresh |
| `swipeMessage(messageId, "left" \| "right")` | Switch between AI alternatives (swipes) for a message. Returns `Promise<Record<string, unknown>>` |

### Sessions & branching

| Method | What it does |
|--------|--------------|
| `revertToMessage(messageId)` | Rewind the conversation to just before `messageId`. Returns `Promise<void>` |
| `branchFromMessage(messageId)` | Fork a new session at the given message (clones messages up to and including it plus the state snapshot). Returns `Promise<string \| null>` — new session ID, or `null` on failure (while streaming, multiplayer rooms, missing messages all fail) |
| `getBranchContext()` | Fetch the current branch slice (self, parent, siblings, children). Returns `Promise<BranchContext>`. Re-fetched every call; no client cache. See [`BranchContext`](#branchcontext) |
| `createSession(worldId)` | Start a new session for a world. Returns `Promise<string>` with the new session ID |
| `deleteSession(sessionId)` | Delete a session. Returns `Promise<void>` |
| `listSessions(worldId)` | List all sessions for a world. Returns `Promise<Array<Record<string, unknown>>>` |

### Checkpoints

A checkpoint is a named snapshot inside the current session you can rewind to.

| Method | What it does |
|--------|--------------|
| `saveCheckpoint()` | Save the current session state as a new checkpoint. Returns `Promise<void>` (the `checkpoints` field is pushed back afterwards) |
| `loadCheckpoints()` | Ask the parent to refresh the `checkpoints` array. Returns `Promise<void>` |
| `restoreCheckpoint(checkpointId)` | Restore the session to a saved checkpoint. Returns `Promise<void>` |
| `deleteCheckpoint(checkpointId)` | Delete a checkpoint. Returns `Promise<void>` |

### Audio

| Method | What it does |
|--------|--------------|
| `playAudio(trackId, opts?)` | Play an audio track defined in entries. `opts`: `{ volume?, fadeDuration?, chainTo?, maxDuration?, duckBgm?, loop? }` — durations are in **seconds**; `chainTo` picks the next trackId to play; `duckBgm` lowers BGM during playback; `loop` overrides the track's loop setting for this playback |
| `stopAudio(trackId?, fadeDuration?)` | Stop a track (omit `trackId` to stop everything). `fadeDuration` in seconds. **Destroys** the element — use `pauseAudio` if you want to resume from the same position |
| `pauseAudio(trackId)` | Pause a track in place, keeping its playback position |
| `resumeAudio(trackId)` | Resume a track paused with `pauseAudio` |
| `onAudioEnded(cb)` | Subscribe to "a non-looping track finished playing" — `cb(trackId)`. Returns an unsubscribe function. Use it to auto-advance a custom playlist |
| `setAudioVolume(type, volume)` | `type` is `"bgm"` or `"sfx"`, `volume` is 0–1 |
| `getAudioVolume(type)` | Synchronously returns the current volume (0–1) |

### UI / navigation

| Method | What it does |
|--------|--------------|
| `toggleImmersive()` | Toggle immersive (full-screen) mode |
| `openPersonaManager()` | Open the player's persona manager — switch / create / edit personas without leaving the world (the same panel the composer "+" menu opens). The active persona is account-global; a switch takes effect on the next message |
| `openSupport()` | Open the "support the creator" dialog (tip in dollars or gift mushies), attributed to the world being played. For fullscreen custom-UI cards, whose own canvas covers the play header's heart button. Returns `Promise<{opened, reason}>` — `reason` is `"self"` (you are the creator), `"signed-out"`, or `"unavailable"` (editor preview). **Await it and show the reason** — the creator testing their own card is the first person to press this button, and a silent no-op reads as broken |
| `fetchAsset(ref)` | Read one of your assets as raw bytes. Takes an asset id (`"@asset:<uuid>"` or the bare uuid), **never a URL**. Returns `Promise<{ok, bytes?, contentType?, error?}>`; `error` is `"bad-ref"`, `"http-404"`, `"too-large"` (32MB cap), `"unavailable"`, or a network message. The sandbox cannot fetch anything itself, and the browser only gives images and media a privileged loading path — there is no `<model>` tag — so this is the only way a `.glb`, a large JSON table or a sprite atlas gets in. Check `ok` before touching `bytes`. |
| `copyToClipboard(text)` | Copy to clipboard (replaces `navigator.clipboard.writeText`) |
| `navigate(path)` | Ask the parent to route to a path like `"/app/hub"` (replaces `window.location = ...`) |
| `showToast(message, type?)` | Show a toast in the parent UI. `type`: `"success"`, `"error"`, `"info"` (default) |

### Persistent storage (per-world)

Replacement for localStorage. Scoped by `worldId`; worlds cannot read each other's keys.

| Method | What it does |
|--------|--------------|
| `storage.get(key)` | Read. Returns `Promise<string \| null>` |
| `storage.set(key, value)` | Write (strings only). Returns `Promise<void>` |
| `storage.remove(key)` | Delete. Returns `Promise<void>` |

Need complex data? `JSON.stringify` / `JSON.parse` on the way in/out.

### Lorebook lookups

Read-only access to the world's lorebook from inside your card. Useful for inspecting or hand-picking entries when assembling a side LLM prompt, building an in-game journal viewer, or wiring a debug panel.

| Field / method | What it does |
|----------------|--------------|
| `entries` | `ReadonlyArray<SandboxEntry>` — every enabled entry, already sorted by `position`. See [`SandboxEntry`](#sandboxentry) |
| `getEntry(name)` | Find one entry by **exact name**. Returns `SandboxEntry \| null`. On `localhost`, a missing lookup logs a one-time warning with the available names — handy when you rename an entry and forget to update the card |

For most cases you don't need to touch these directly: pass `includeLorebook: "matched"` to `ai.complete()` and the server assembles the lore for you (see below). Reach for `entries` / `getEntry` when you need surgical control — e.g. *"this NPC only knows entries tagged `tavern`"*.

### Raw AI completions

Call the LLM **outside** the main chat pipeline. Use for "NPC inner monologue in a side panel", "AI-generated item descriptions", "in-card phone chats", and so on. **Does not** write to message history, does not trigger state updates, does not consume greetings.

```tsx
const api = useYumina()
const text = await api.ai.complete({
  messages: [
    { role: "system", content: "You are a surly merchant." },
    { role: "user", content: "Price me an iron sword." },
  ],
  onDelta: (chunk) => setStreaming((s) => s + chunk),  // optional, per-token
  model: "claude-sonnet-4-6",                           // optional, defaults to selectedModel
  maxTokens: 500,                                       // optional, default 2048, max 8192
  temperature: 0.7,                                     // optional
  includeLorebook: "matched",                           // optional — see below
})
```

Returns `Promise<string>` with the full response. 120-second client-side timeout.

#### Limits and costs

| Limit | Value | Source |
|-------|-------|--------|
| Max messages per call | 50 | Server rejects with HTTP 400 |
| Max total content | 50,000 characters across all messages | Server rejects with HTTP 400 |
| `maxTokens` default | 2048 | Default when omitted |
| `maxTokens` ceiling | 8192 | Larger values are clamped silently |
| `temperature` range | 0–2, default 1.0 | Out-of-range values are clamped |
| Default model | Player's `selectedModel`, falling back to `anthropic/claude-sonnet-4.6` if neither `model` nor `selectedModel` is set | |
| Rate limit | **Dedicated side-call pool** — 100 side calls per minute, independent of the main chat's per-minute budget | Returns HTTP 429 + `RATE_LIMITED` code and a `Retry-After` header on overflow |
| Credits | Same per-token billing as the main chat. **BYOK users skip server credit deduction** but still pay their own provider | Logged with endpoint `"side-completion"` |
| Auth | The session must belong to the current player; otherwise the call fails with HTTP 404 | |

#### `includeLorebook` — auto-inject world lore

Side calls bypass the main chat's prompt assembly, so the model has no idea who your characters are unless you give it the lorebook. Pass `includeLorebook` and the server prepends a system message built from the world's entries:

| Value | Behavior |
|-------|----------|
| omitted / `false` | No injection (default). Use for translations, summaries, classification — anything that doesn't need world context |
| `true` / `"all"` | Inject every enabled non-greeting entry, sorted by `position`. Predictable, larger token cost |
| `"matched"` | Run the same keyword matcher the main chat uses against the **last user message** in `messages`. `alwaysSend` entries are always included; keyword-triggered entries are added only when relevant. **Recommended for in-character side calls** |

Without this, an "in-character" side call has the model fabricating personalities from names alone — the in-card persona drifts away from the main chat. With `"matched"`, a phone chat with an NPC sees the same world lore + character profile the main chat sees.

```tsx
// A phone chat that stays in canon
api.ai.complete({
  messages: [
    { role: "system", content: "Stay strictly in character as Balder. Reply in one or two short lines." },
    ...history,
    { role: "user", content: userText },
  ],
  includeLorebook: "matched",  // server pulls Balder's profile + relevant world lore
})
```

If you need finer control — inject a specific entry by name, or only entries with a specific tag — iterate `api.entries` and assemble the system message yourself instead of using `includeLorebook`:

```tsx
const tavernLore = api.entries
  .filter((e) => e.tags?.includes("tavern"))
  .map((e) => `【${e.name}】\n${e.content}`)
  .join("\n\n")

api.ai.complete({
  messages: [
    { role: "system", content: `You are the tavern keeper.\n\n${tavernLore}` },
    { role: "user", content: userText },
  ],
})
```

**`"matched"` mode caveats**: it only scans the last user message for keywords (not full history), and condition-gated entries that depend on game variables don't fire on side calls (the matcher sees an empty state stub). Use `true` to force-include everything if precision matters more than tokens.

### Context injection

Inject a **one-shot** context message into the **next** main-chat AI turn. Consumed after one use; **no** visible chat message is created. Great for "phone messages", "NPC offstage dialogue", "environment changes" — things the main AI should know about but the player shouldn't see as a chat bubble.

```tsx
api.injectContext("You just received a cryptic text: 'Tonight, 9pm, usual place.'", { role: "system" })
// On the player's next message, the main AI will see this as a system message.
```

`options`: `{ role?: "system" \| "user" }` (defaults to `"system"`).

### Model picker

| Field / method | What it does |
|----------------|--------------|
| `selectedModel` | Current model ID |
| `userPlan` | User's plan tier |
| `preferredProvider` | `"official"` or `"private"` |
| `setModel(modelId)` | Switch models (fire-and-forget) |
| `getModels()` | Returns `Promise<{ models, pinnedModels, recentlyUsed }>` where `models` is `Array<{ id, name, provider, contextLength }>` |
| `pinModel(modelId)` / `unpinModel(modelId)` | Pin / unpin a model |

### Assets

| Method | What it does |
|--------|--------------|
| `resolveAssetUrl(ref)` | Turn an `@asset:xxx` reference into a CDN URL. Pure string transform, no network. HTTP/HTTPS URLs pass through unchanged |

### Markdown

| Method | What it does |
|--------|--------------|
| `renderMarkdown(text)` | Turn markdown into **safe HTML** (HTML entities escaped, dangerous tags stripped, formatting preserved). Feed the result to `dangerouslySetInnerHTML` inside a custom bubble and you're safe — see example below |

```tsx
<div dangerouslySetInnerHTML={{ __html: api.renderMarkdown(msg.rawContent) }} />
```

---

## Components

### `<Chat>`

The platform's full chat experience. **This is the everyday building block — zero props gives you the default chat.**

Includes: message list, auto-scroll, streaming cursor, swipe controls, message actions (edit/delete/regenerate), input bar, choice buttons, model picker, read-only mode, greeting placeholder.

```tsx
<Chat renderBubble={(msg) => <MyBubble {...msg} />} />
```

#### Props

| Prop | Type | Description |
|------|------|-------------|
| `renderBubble?` | `(props: BubbleProps) => ReactNode` | Customize how each message bubble looks. Falls back to default markdown rendering if omitted |
| `className?` | `string` | Extra CSS class on the outer container |
| `children?` | `ReactNode` | Content rendered **above** the message list (e.g. a fixed HUD header) |

#### BubbleProps

The `msg` object your `renderBubble` callback receives:

| Field | Type | Meaning |
|-------|------|---------|
| `contentHtml` | `string` | **Pre-rendered safe HTML** (markdown already converted). Usually piped to `dangerouslySetInnerHTML` |
| `rawContent` | `string` | Raw markdown text before rendering (directive text included) |
| `role` | `"user" \| "assistant" \| "system"` | Message origin |
| `messageIndex` | `number` | Position in the list (0 = first, usually the greeting) |
| `isStreaming` | `boolean` | `true` while this message is being streamed |
| `stateSnapshot` | `Record<string, unknown> \| null` | Game state at the moment this message was generated (useful for "what were HP/location back then") |
| `variables` | `Record<string, unknown>` | Current (latest) game variables |
| `renderMarkdown` | `(text) => string` | Helper: turn any markdown text into safe HTML |

### `<MessageList>`

Just the message stream (with scroll, streaming cursor, swipe controls). **No** input bar.

```tsx
<MessageList />
```

Does not take `renderBubble` — to customize bubbles use `<Chat renderBubble={...} />`, or skip `<MessageList>` entirely and read `api.messages` directly (the visual-novel pattern).

### `<MessageInput>`

Just the input bar (with model picker, choice buttons, continue/restart menu, streaming state).

```tsx
<MessageInput />
```

Auto-hides when `api.readOnly` is `true`.

### `<ChatCanvas>`

**Legacy alias** — identical to `<Chat />`. Old worlds keep working; new code should prefer `<Chat />`.

---

## `useAssetFont()`

Load an uploaded font asset as an `@font-face` and get back a string ready to drop into a CSS `font-family` value.

```tsx
const fontFamily = useAssetFont("@asset:my-font-id", {
  family: "Cinzel",
  fallback: "serif",
})
return <div style={{ fontFamily }}>Ancient runes</div>
```

### Signature

```ts
useAssetFont(
  assetRef: string | null | undefined,
  options?: AssetFontOptions
): string
```

The font loads asynchronously. While loading, the hook returns `options.fallback` (defaulting to `"serif"`); when ready, a re-render fires with the full family string (scoped with a suffix to avoid name clashes).

### `AssetFontOptions`

| Field | Type | Description |
|-------|------|-------------|
| `family?` | `string` | Font family name. Inferred from filename or `assetRef` if omitted |
| `fallback?` | `string` | Fallback font shown during load. Default `"serif"` |
| `filename?` | `string \| null` | Original filename, used to guess format |
| `mimeType?` | `string \| null` | MIME type, used to guess format |
| `format?` | `"opentype" \| "truetype" \| "woff" \| "woff2" \| null` | Explicit format override |
| `weight?` | `string \| number` | `font-weight` |
| `style?` | `string` | `font-style` (e.g. `"italic"`) |
| `stretch?` | `string` | `font-stretch` |
| `display?` | `FontDisplay` | `font-display` (default `"swap"`) |

---

## Types

### `SandboxMessage`

Shape of each entry in `api.messages`:

```ts
interface SandboxMessage {
  id: string
  sessionId: string
  role: "user" | "assistant" | "system"
  content: string
  status?: "complete" | "streaming" | "failed"
  errorMessage?: string | null
  authorUserId?: string | null          // who sent it (multiplayer)
  authorNameSnapshot?: string | null    // their display name at send time
  stateChanges?: Record<string, unknown> | null   // diff of variable updates from this message
  stateSnapshot?: Record<string, unknown> | null  // full state at message generation
  swipes?: Array<{ content, stateSnapshot }>      // alternative AI replies
  activeSwipeIndex?: number
  model?: string | null
  tokenCount?: number | null
  generationTimeMs?: number | null
  compacted?: boolean                   // hidden in the "older messages" section
  attachments?: Array<{ type, mimeType, name, url }> | null
  createdAt: string                     // ISO-8601
}
```

### `Checkpoint`

```ts
interface Checkpoint {
  id: string
  name: string
  messageCount: number
  createdAt: string   // ISO-8601
}
```

### `SandboxEntry`

A single read-only lorebook entry, exposed via `api.entries` and `api.getEntry()`:

```ts
interface SandboxEntry {
  id: string
  name: string
  content: string
  keywords: string[]
  position: number
  section: "system-presets" | "examples" | "chat-history" | "post-history"
  enabled: boolean
  role: string                            // "system" | "character" | "lore" | etc.
  tags?: string[]
}
```

This is a slim view of the engine's internal `WorldEntry` — only the fields a card needs for prompt assembly. The runtime pre-filters disabled entries and pre-sorts by `position`, so cards never need to do either themselves.

### `BranchContext`

```ts
interface BranchNode {
  id: string
  name: string | null
  parentSessionId: string | null
  branchedFromMessageId: string | null
  messageCount: number
  updatedAt: string   // ISO-8601
  createdAt: string   // ISO-8601
}

interface BranchContext {
  current: BranchNode          // the session you're in
  parent: BranchNode | null    // the branch you forked from, or null at the root
  siblings: BranchNode[]       // other branches forked from the same parent, oldest first
  children: BranchNode[]       // branches forked off `current`, oldest first
}
```

---

## Blocked browser APIs

Your code runs inside a cross-origin `sandbox="allow-scripts"` iframe with **no** `allow-same-origin`. That means:

- No access to parent-app cookies / localStorage
- No credentialed network requests
- No direct `window.parent` manipulation

The following APIs are either **fully blocked** or **transparently redirected** through the SDK bridge.

### Redirects (legacy code keeps working)

| What you wrote | What actually happens |
|----------------|----------------------|
| `fetch('/api/...')` | Proxied through the parent's authenticated fetch |
| `fetch('/cdn/...')` | Allowed (CSP permits it) |
| `fetch('any other URL')` | **Rejected** (throws) |
| `localStorage.getItem/setItem/removeItem/clear` | Routed via `api.storage`, scoped by world |
| `sessionStorage.*` | Same |
| `navigator.clipboard.writeText()` | Equivalent to `api.copyToClipboard()` |
| `navigator.clipboard.readText() / read() / write()` | **Rejected** (throws) |
| `window.location.pathname / href / assign / replace` | Synthetic object; `pathname` is always `/app/chat/{sessionId}`; assigning / calling `assign` / `replace` triggers navigation |
| `window.location.reload()` | Bridged to reload the session |
| `window.__yuminaToggleImmersive()` | Equivalent to `api.toggleImmersive()` |

### Preferred usage

When writing new code, **use the SDK directly** — the redirects exist for old worlds, but the SDK is cleaner and more stable:

| Don't write | Write |
|------------|-------|
| `fetch('/api/sessions', { method: 'POST' })` | `api.createSession(worldId)` |
| `fetch('/api/sessions/' + sid, { method: 'DELETE' })` | `api.deleteSession(sid)` |
| `localStorage.getItem("k")` | `await api.storage.get("k")` |
| `window.location = "/app/hub"` | `api.navigate("/app/hub")` |
| `navigator.clipboard.writeText(t)` | `api.copyToClipboard(t)` |

### Browser APIs that ARE available

The sandbox is permissive about anything that doesn't reach the network or shared origin. The following work as in any browser, with no SDK wrapper needed:

| API | Typical use in cards |
|-----|----------------------|
| `<input type="file">` + `FileReader.readAsDataURL` / `readAsText` | Let the player pick an image/audio/text file → store as a data URL or string in a variable. See [Recipe: Player-Uploaded Images](./recipes/player-images.md) |
| `URL.createObjectURL` / `revokeObjectURL` | Generate a temporary in-memory URL for a `Blob` (e.g. preview before save) |
| `<canvas>` + `getContext("2d")` + `toDataURL` / `toBlob` | Resize, crop, or composite images before saving to a variable |
| `<img>`, `<audio>`, `<video>` | Render local-origin URLs, `@asset:...` resolved URLs, `data:`/`blob:` URLs |
| `IntersectionObserver`, `ResizeObserver`, `matchMedia`, `requestAnimationFrame` | Standard layout / animation primitives |
| `crypto.randomUUID`, `crypto.subtle` | Hashing and ID generation for client-side state |
| `WebAudio` (`AudioContext`) | Lightweight audio synthesis or analysis |
| `Notification`, `navigator.vibrate`, `screen.orientation` | Limited by browser-level permissions, not by the sandbox itself |

---

## At-a-glance: the whole API

One table, scan once.

```
useYumina()
├── State reads
│   ├── variables, globalVariables, personalVariables, roomPersonalVariables
│   ├── worldName, worldId, sessionId
│   ├── currentUser (account), user (persona-aware)
│   ├── room, mode, capabilities, language
│   ├── messages, permissions, entries
│   ├── isStreaming, streamingContent, streamingReasoning
│   ├── pendingChoices, error, readOnly, greetingContent, canvasMode
│   ├── checkpoints
│   └── selectedModel, userPlan, preferredProvider
├── Game actions
│   ├── sendMessage(text)
│   ├── setVariable(id, value, options?)
│   ├── executeAction(actionId)
│   ├── switchGreeting(index)
│   ├── clearPendingChoices()
│   └── setComposerDraft(text)              // prefill, no send
├── Chat control
│   ├── editMessage(id, content) → Promise<boolean>
│   ├── deleteMessage(id) → Promise<boolean>
│   ├── regenerateMessage(id)
│   ├── continueLastMessage()
│   ├── stopGeneration()
│   ├── restartChat()
│   └── swipeMessage(id, direction) → Promise
├── Sessions / branching
│   ├── revertToMessage(id) → Promise<void>
│   ├── branchFromMessage(id) → Promise<string | null>
│   ├── getBranchContext() → Promise<BranchContext>
│   ├── createSession(worldId) → Promise<string>
│   ├── deleteSession(id) → Promise<void>
│   └── listSessions(worldId) → Promise<Array>
├── Checkpoints
│   ├── saveCheckpoint() → Promise<void>
│   ├── loadCheckpoints() → Promise<void>
│   ├── restoreCheckpoint(id) → Promise<void>
│   └── deleteCheckpoint(id) → Promise<void>
├── Audio
│   ├── playAudio(trackId, opts?)
│   ├── stopAudio(trackId?, fadeDuration?)
│   ├── pauseAudio(trackId)
│   ├── resumeAudio(trackId)
│   ├── onAudioEnded(cb) → unsubscribe
│   ├── setAudioVolume(type, volume)
│   └── getAudioVolume(type) → number
├── UI / navigation
│   ├── toggleImmersive()
│   ├── openPersonaManager()
│   ├── copyToClipboard(text)
│   ├── navigate(path)
│   └── showToast(message, type?)
├── Storage
│   ├── storage.get(key) → Promise<string | null>
│   ├── storage.set(key, value) → Promise<void>
│   └── storage.remove(key) → Promise<void>
├── Lorebook
│   ├── entries (ReadonlyArray<SandboxEntry>)  // sorted by position, enabled only
│   └── getEntry(name) → SandboxEntry | null
├── AI
│   └── ai.complete({ messages, onDelta?, model?, maxTokens?, temperature?, includeLorebook? }) → Promise<string>
│        // includeLorebook: true | "all" | "matched" — auto-inject world lore
├── Context injection
│   └── injectContext(message, { role? })
├── Model picker
│   ├── setModel(modelId)
│   ├── getModels() → Promise<{ models, pinnedModels, recentlyUsed }>
│   ├── pinModel(id), unpinModel(id)
├── Assets
│   └── resolveAssetUrl(ref) → string
└── Markdown
    └── renderMarkdown(text) → string   // safe HTML

Sandbox globals (no import)
├── React
├── useYumina, useAssetFont
├── Icons  (1400+ Lucide icons)
├── Chat, MessageList, MessageInput, ChatCanvas (legacy alias)
└── Tailwind utility classes (CSS-level)

Blocked / redirected
├── fetch('/api/...') → proxied
├── localStorage / sessionStorage → api.storage
├── window.location → synthetic + navigate
└── navigator.clipboard → copyToClipboard

Browser APIs that work as-is
├── <input type="file"> + FileReader      // player file uploads → data URL
├── <canvas>, URL.createObjectURL          // image processing
├── IntersectionObserver, ResizeObserver, matchMedia, rAF
├── crypto.randomUUID, crypto.subtle
└── WebAudio (AudioContext)
```

---

**Next**: head back to the [Custom UI Guide](./custom-ui-deep.md) for worked examples, or browse the [Recipes](./recipes/scene-jumping.md) for templates closest to what you're building.
